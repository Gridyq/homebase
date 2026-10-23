//! Container updates: keeps the Quadlet containers marked `AutoUpdate=registry` on their image's
//! latest build, and says what changed. Took over from `podman-auto-update.timer` on 2026-10-23,
//! whose `podman image prune` threw the old image away, so an update that broke something
//! couldn't be undone.
//!
//! - Every night after 4:00 each container's image is pulled; one that changed is restarted on
//!   the new build. The image it was on is kept as `localhost/homebase-previous/<name>:previous`,
//!   so it survives the prune and can be gone back to from the app.
//! - A restart that fails (the units wait for the container to report healthy) goes back to the
//!   previous image by itself, and holds the container so the bad build isn't tried every night.
//! - Containers can be held, which the nightly run skips; going back holds the container, so the
//!   next night doesn't update it again.
//! - Jellyfin isn't restarted while someone's watching; it's tried again every 10 minutes.
//! - Game mode puts the run off until it ends, since it stops most of these containers.
//! - Every 6 hours the registries are asked, without pulling, which images have a newer build.
//!
//! What happened is kept in `container-updates.json`, and updates, failures and automatic rollbacks
//! are sent through ntfy.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use axum::Json;
use axum::body::Bytes;
use axum::extract::State as AxumState;
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::args;
use crate::command::{output, run};
use crate::events::{Notice, notify};
use crate::http::{HttpError, State};
use crate::localtime;
use crate::machine::json_body;
use crate::services::{Quadlet, quadlets};
use crate::usage::now_ms;

const TICK: Duration = Duration::from_secs(10 * 60);
const RUN_HOUR: i32 = 4;
const CHECK_EVERY_MS: i64 = 6 * 3600 * 1000;
const PULL_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// The units give a container 300 s to report healthy, after up to 90 s to stop.
const RESTART_TIMEOUT: Duration = Duration::from_secs(400);
const QUICK: Duration = Duration::from_secs(60);
const HISTORY_KEPT: usize = 200;
const PREVIOUS_REPO: &str = "localhost/homebase-previous";
/// Release notes, for images whose own source label points at their packaging rather than the app.
const CHANGELOGS: &[(&str, &str)] = &[
    ("sonarr", "https://github.com/Sonarr/Sonarr/releases"),
    ("radarr", "https://github.com/Radarr/Radarr/releases"),
    ("prowlarr", "https://github.com/Prowlarr/Prowlarr/releases"),
    ("qbittorrent", "https://www.qbittorrent.org/news"),
    ("jellyfin", "https://github.com/jellyfin/jellyfin/releases"),
];

/// One build of an image.
#[derive(Serialize, Deserialize, Clone, Default, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Build {
    pub id: String,
    /// From the image's version label, when it has a real one (not "latest").
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub version: Option<String>,
    /// When the image was built, in ms.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub created: Option<i64>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Change {
    at: i64,
    name: String,
    from: Build,
    to: Build,
    /// "updated", "rolledBack" (the restart failed, so it went back by itself) or "reverted" (gone
    /// back to from the app).
    outcome: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    detail: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
struct Hold {
    at: i64,
    reason: String,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Saved {
    /// When the nightly run last finished.
    last_run: Option<i64>,
    checked_at: Option<i64>,
    /// Containers with a newer build in the registry, as of `checked_at`.
    available: Vec<String>,
    held: BTreeMap<String, Hold>,
    /// What went wrong in the last run.
    errors: Vec<String>,
    history: Vec<Change>,
}

#[derive(Clone)]
struct Running {
    what: String,
    step: String,
    since: i64,
}

pub struct ContainerUpdates {
    file: crate::files::JsonFile,
    saved: Mutex<Saved>,
    running: Mutex<Option<Running>>,
    /// Pulled but not restarted, because someone was watching.
    waiting: Mutex<Vec<String>>,
    /// One run at a time.
    busy: tokio::sync::Mutex<()>,
}

impl ContainerUpdates {
    pub fn new(dir: &Path) -> Self {
        let file = crate::files::JsonFile::new(dir.join("container-updates.json"), "container updates");
        // Started for the first time, the first run is the next night's rather than straight away.
        let saved = file.load().unwrap_or_else(|| Saved { last_run: Some(now_ms()), ..Saved::default() });
        Self {
            file,
            saved: Mutex::new(saved),
            running: Mutex::default(),
            waiting: Mutex::default(),
            busy: Default::default(),
        }
    }

    fn save(&self, saved: &Saved) {
        self.file.save(saved);
    }

    fn step(&self, step: String) {
        if let Some(r) = self.running.lock().unwrap().as_mut() {
            r.step = step;
        }
    }
}

fn previous_tag(name: &str) -> String {
    format!("{PREVIOUS_REPO}/{name}:previous")
}

async fn podman(args: &[String], limit: Duration) -> Result<String, String> {
    run("podman", args, limit).await.map(|out| out.trim().to_owned())
}

/// The image the container runs now, or for one that isn't there (stopped on demand), the one
/// its tag points to.
async fn current_image(q: &Quadlet, image: &str) -> Result<String, String> {
    let running = podman(&args!["container", "inspect", "--format", "{{.Image}}", &q.name], QUICK).await;
    match running {
        Ok(id) if !id.is_empty() => Ok(id),
        _ => podman(&args!["image", "inspect", "--format", "{{.Id}}", image], QUICK).await,
    }
}

/// A build as the app shows it, from `podman images` or `podman image inspect`.
fn build_of(id: &str, labels: &Value, created_secs: Option<i64>) -> Build {
    let version = labels["org.opencontainers.image.version"]
        .as_str()
        .map(str::trim)
        .filter(|v| !v.is_empty() && *v != "latest")
        .map(str::to_owned);
    Build { id: id.to_owned(), version, created: created_secs.map(|s| s * 1000) }
}

/// Every local image by id, as `podman images` lists them.
async fn images() -> Result<Vec<Value>, String> {
    let out = podman(&args!["images", "--format", "json"], QUICK).await?;
    serde_json::from_str(&out).map_err(|e| format!("Couldn't read podman's image list: {e}"))
}

fn find_build(images: &[Value], id: &str) -> Build {
    images
        .iter()
        .find(|i| i["Id"].as_str() == Some(id))
        .map(|i| build_of(id, &i["Labels"], i["Created"].as_i64()))
        .unwrap_or_else(|| Build { id: id.to_owned(), ..Build::default() })
}

async fn build(id: &str) -> Build {
    images().await.map(|list| find_build(&list, id)).unwrap_or_else(|_| Build { id: id.to_owned(), ..Build::default() })
}

/// "active", "inactive", "failed" and so on; `is-active` exits non-zero for all but the first.
async fn unit_state(unit: &str) -> String {
    output("systemctl", &args!["--user", "is-active", unit], QUICK)
        .await
        .map(|out| out.stdout.trim().to_owned())
        .unwrap_or_default()
}

/// Restarts the unit, putting the events it causes down to the update.
async fn restart(state: &State, q: &Quadlet) -> Result<(), String> {
    state
        .recorder
        .events
        .lock()
        .unwrap()
        .note_cause(&format!("container:{}", q.name), "update", now_ms());
    let result = run("systemctl", &args!["--user", "restart", &q.unit], RESTART_TIMEOUT).await;
    state.services.expire(&state.usage);
    // systemd follows its reason with where to read more.
    result.map(|_| ()).map_err(|e| e.lines().next().unwrap_or_default().to_owned())
}

/// Moves the image's tag to `id` and restarts the container on it, if it's running or failed
/// (or always, with `start`).
async fn switch_to(state: &State, q: &Quadlet, image: &str, id: &str, start: bool) -> Result<(), String> {
    podman(&args!["tag", id, image], QUICK).await?;
    if start || unit_state(&q.unit).await != "inactive" {
        restart(state, q).await?;
    }
    Ok(())
}

enum Pulled {
    Same,
    /// Someone's watching, so it'll restart later.
    Waiting,
    Changed(Change),
}

/// Pulls the container's image and restarts it on a new build, going back if that fails.
async fn update_one(state: &State, q: &Quadlet, image: &str) -> Result<Pulled, String> {
    let cu = &state.container_updates;
    let old = current_image(q, image).await?;
    cu.step(format!("Pulling {}", q.name));
    let pulled = podman(&args!["pull", "--quiet", image], PULL_TIMEOUT).await?;
    let new = pulled.lines().last().unwrap_or_default().trim().to_owned();
    if new.is_empty() || new == old {
        return Ok(Pulled::Same);
    }
    // Keeps the old build out of the prune, so it can be gone back to.
    podman(&args!["tag", &old, &previous_tag(&q.name)], QUICK).await?;
    let (from, to) = (build(&old).await, build(&new).await);
    let change = |outcome: &str, detail: Option<String>| Change {
        at: now_ms(),
        name: q.name.clone(),
        from: from.clone(),
        to: to.clone(),
        outcome: outcome.into(),
        detail,
    };
    if unit_state(&q.unit).await != "active" {
        return Ok(Pulled::Changed(change("updated", Some("Takes effect when it next starts".into()))));
    }
    if q.name == "jellyfin" && !state.jellyfin.sessions().is_empty() {
        return Ok(Pulled::Waiting);
    }
    cu.step(format!("Restarting {}", q.name));
    let Err(why) = restart(state, q).await else {
        return Ok(Pulled::Changed(change("updated", None)));
    };
    eprintln!("{} didn't come back on the new image ({why}); going back", q.name);
    cu.step(format!("Going back on {}", q.name));
    let detail = match switch_to(state, q, image, &old, true).await {
        Ok(()) => format!("Didn't start on the new build, so it went back: {why}"),
        Err(e) => format!("Didn't start on the new build ({why}), and going back failed too: {e}"),
    };
    Ok(Pulled::Changed(change("rolledBack", Some(detail))))
}

/// The containers kept up to date, with their images.
async fn managed() -> Vec<(Quadlet, String)> {
    let mut list: Vec<_> = quadlets()
        .await
        .into_iter()
        .filter(|q| q.auto_update)
        .filter_map(|q| q.image.clone().map(|i| (q, i)))
        .collect();
    list.sort_by(|a, b| a.0.name.cmp(&b.0.name));
    list
}

fn version_text(b: &Build) -> String {
    b.version.clone().unwrap_or_else(|| b.id.chars().take(12).collect())
}

fn change_line(c: &Change) -> String {
    let what = format!("{} {} → {}", c.name, version_text(&c.from), version_text(&c.to));
    match c.outcome.as_str() {
        "rolledBack" => format!("{what} failed and went back"),
        _ => what,
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Run {
    Nightly,
    /// Jellyfin restarts put off because someone was watching.
    Retry,
    /// Asked for from the app.
    ByHand,
}

/// Updates the containers named, or all but the held ones. Only an update asked for by hand
/// touches a held container.
async fn update(state: &State, only: Option<Vec<String>>, run: Run) {
    let cu = &state.container_updates;
    let _busy = cu.busy.lock().await;
    let what = match &only {
        Some(names) if names.len() == 1 => format!("Updating {}", names[0]),
        _ => "Updating containers".to_owned(),
    };
    *cu.running.lock().unwrap() = Some(Running { what, step: "Starting".into(), since: now_ms() });
    let held: Vec<String> = cu.saved.lock().unwrap().held.keys().cloned().collect();
    let mut changes = Vec::new();
    let mut errors = Vec::new();
    for (q, image) in managed().await {
        let wanted = match &only {
            Some(names) if run == Run::ByHand => names.contains(&q.name),
            Some(names) => names.contains(&q.name) && !held.contains(&q.name),
            None => !held.contains(&q.name),
        };
        if !wanted {
            if held.contains(&q.name) {
                cu.waiting.lock().unwrap().retain(|n| n != &q.name);
            }
            continue;
        }
        match update_one(state, &q, &image).await {
            Ok(Pulled::Same) => {
                cu.waiting.lock().unwrap().retain(|n| n != &q.name);
            }
            Ok(Pulled::Waiting) => {
                let mut waiting = cu.waiting.lock().unwrap();
                if !waiting.contains(&q.name) {
                    waiting.push(q.name.clone());
                }
            }
            Ok(Pulled::Changed(c)) => {
                cu.waiting.lock().unwrap().retain(|n| n != &q.name);
                changes.push(c);
            }
            Err(e) => {
                eprintln!("Updating {} failed: {e}", q.name);
                errors.push(format!("{}: {e}", q.name));
            }
        }
    }
    cu.step("Clearing out old images".into());
    if let Err(e) = podman(&args!["image", "prune", "--force"], QUICK).await {
        eprintln!("Pruning images failed: {e}");
    }
    {
        let mut saved = cu.saved.lock().unwrap();
        if run == Run::Nightly {
            saved.last_run = Some(now_ms());
        }
        let updated: Vec<&str> = changes.iter().filter(|c| c.outcome == "updated").map(|c| c.name.as_str()).collect();
        saved.available.retain(|n| !updated.contains(&n.as_str()));
        // A container updated by hand isn't held any more.
        if let (Run::ByHand, Some(names)) = (run, &only) {
            saved.held.retain(|n, _| !names.contains(n));
        }
        // The bad build would otherwise be pulled and tried again every night.
        for c in changes.iter().filter(|c| c.outcome == "rolledBack") {
            saved.held.insert(c.name.clone(), Hold { at: now_ms(), reason: "The new build didn't start, so it went back".into() });
        }
        saved.errors = errors.clone();
        saved.history.extend(changes.iter().cloned());
        let excess = saved.history.len().saturating_sub(HISTORY_KEPT);
        saved.history.drain(..excess);
        cu.save(&saved);
    }
    *cu.running.lock().unwrap() = None;
    println!("Container updates: {} changed, {} failed", changes.len(), errors.len());
    if changes.is_empty() && errors.is_empty() {
        return;
    }
    let trouble = !errors.is_empty() || changes.iter().any(|c| c.outcome != "updated");
    let mut lines: Vec<String> = changes.iter().map(change_line).collect();
    lines.extend(errors.iter().map(|e| format!("Couldn't update {e}")));
    let title = if trouble { "Container updates need a look" } else { "Containers updated" };
    notify(
        &state.upstream,
        Notice {
            title: title.into(),
            message: lines.join("\n"),
            tags: if trouble { "warning" } else { "package" },
            click: Some("homebase://server/updates".into()),
        },
    )
    .await;
}

/// Asks the registries which images have a newer build, without pulling them.
async fn check(state: &State) -> Result<(), String> {
    let out = podman(&args!["auto-update", "--dry-run", "--format", "json"], Duration::from_secs(300)).await?;
    let list: Vec<Value> = serde_json::from_str(&out).map_err(|e| format!("Couldn't read podman's answer: {e}"))?;
    let available = list
        .iter()
        .filter(|e| e["Updated"] == "pending")
        .filter_map(|e| e["ContainerName"].as_str().map(str::to_owned))
        .collect();
    let mut saved = state.container_updates.saved.lock().unwrap();
    saved.available = available;
    saved.checked_at = Some(now_ms());
    state.container_updates.save(&saved);
    Ok(())
}

async fn check_now(state: &State) {
    let cu = &state.container_updates;
    let _busy = cu.busy.lock().await;
    *cu.running.lock().unwrap() = Some(Running { what: "Checking for updates".into(), step: "Asking the registries".into(), since: now_ms() });
    if let Err(e) = check(state).await {
        eprintln!("Checking for container updates failed: {e}");
        cu.saved.lock().unwrap().errors = vec![format!("Checking failed: {e}")];
    }
    *cu.running.lock().unwrap() = None;
}

/// Whether the nightly run is due: past 4:00 and not yet run today.
fn due(last_run: Option<i64>, now: i64) -> bool {
    let day = |ms: i64| localtime::tool_time(ms)[..10].to_owned();
    localtime::hour(now) >= RUN_HOUR && last_run.is_none_or(|last| day(last) != day(now))
}

pub fn start(state: State) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(TICK);
        loop {
            tick.tick().await;
            if state.game_mode.active() {
                continue;
            }
            let now = now_ms();
            let (last_run, checked_at) = {
                let saved = state.container_updates.saved.lock().unwrap();
                (saved.last_run, saved.checked_at)
            };
            let waiting = state.container_updates.waiting.lock().unwrap().clone();
            if due(last_run, now) {
                update(&state, None, Run::Nightly).await;
                check_now(&state).await;
            } else if !waiting.is_empty() {
                update(&state, Some(waiting), Run::Retry).await;
            } else if checked_at.is_none_or(|t| now - t >= CHECK_EVERY_MS) {
                check_now(&state).await;
            }
        }
    });
}

fn changelog(name: &str, labels: &Value) -> Option<String> {
    if let Some((_, url)) = CHANGELOGS.iter().find(|(n, _)| *n == name) {
        return Some((*url).into());
    }
    let source = labels["org.opencontainers.image.source"].as_str()?.trim_end_matches('/');
    source.starts_with("https://github.com/").then(|| format!("{source}/releases"))
}

/// Each container with the build it's on and the one it could go back to, and what happened.
async fn summary(state: &State) -> Result<Value, HttpError> {
    let ps = args!["ps", "--all", "--format", "json"];
    let (images, containers) = tokio::join!(images(), podman(&ps, QUICK));
    let images = images.map_err(HttpError::internal)?;
    let containers: Vec<Value> = containers
        .ok()
        .and_then(|out| serde_json::from_str(&out).ok())
        .unwrap_or_default();
    let cu = &state.container_updates;
    let waiting = cu.waiting.lock().unwrap().clone();
    let mut list = Vec::new();
    for (q, image) in managed().await {
        let container = containers
            .iter()
            .find(|c| c["Names"].as_array().is_some_and(|n| n.iter().any(|n| n.as_str() == Some(&q.name))));
        let tagged = |tag: &str| {
            images
                .iter()
                .find(|i| i["Names"].as_array().is_some_and(|n| n.iter().any(|n| n.as_str() == Some(tag))))
        };
        let current_id = container
            .and_then(|c| c["ImageID"].as_str())
            .or_else(|| tagged(&image).and_then(|i| i["Id"].as_str()));
        let Some(current_id) = current_id else { continue };
        let current = find_build(&images, current_id);
        let previous = tagged(&previous_tag(&q.name))
            .and_then(|i| i["Id"].as_str())
            .filter(|id| *id != current_id)
            .map(|id| find_build(&images, id));
        let labels = images.iter().find(|i| i["Id"].as_str() == Some(current_id)).map(|i| i["Labels"].clone());
        let saved = cu.saved.lock().unwrap();
        list.push(json!({
            "id": format!("container:{}", q.name),
            "name": q.name,
            "image": image,
            "running": container.is_some_and(|c| c["State"] == "running"),
            "current": current,
            "previous": previous,
            "available": saved.available.contains(&q.name),
            "held": saved.held.get(&q.name),
            "waiting": waiting.contains(&q.name),
            "changelog": changelog(&q.name, &labels.unwrap_or_default()),
        }));
    }
    let running = cu.running.lock().unwrap().clone();
    let saved = cu.saved.lock().unwrap();
    Ok(json!({
        "running": running.map(|r| json!({ "what": r.what, "step": r.step, "since": r.since })),
        "lastRun": saved.last_run,
        "checkedAt": saved.checked_at,
        "runHour": RUN_HOUR,
        "gameMode": state.game_mode.active(),
        "errors": saved.errors,
        "containers": list,
        "history": saved.history.iter().rev().collect::<Vec<_>>(),
    }))
}

pub async fn get(AxumState(state): AxumState<State>) -> Result<Json<Value>, HttpError> {
    summary(&state).await.map(Json)
}

fn bad_request(message: impl Into<String>) -> HttpError {
    HttpError(StatusCode::BAD_REQUEST, message.into())
}

/// Goes back to the build the container was on before its last update, and holds it there.
async fn revert(state: &State, name: String) {
    let cu = &state.container_updates;
    let _busy = cu.busy.lock().await;
    *cu.running.lock().unwrap() = Some(Running { what: format!("Going back on {name}"), step: "Restarting".into(), since: now_ms() });
    let result = async {
        let (q, image) = managed()
            .await
            .into_iter()
            .find(|(q, _)| q.name == name)
            .ok_or_else(|| format!("{name} isn't kept up to date"))?;
        let previous = podman(&args!["image", "inspect", "--format", "{{.Id}}", &previous_tag(&name)], QUICK)
            .await
            .map_err(|_| format!("There's no earlier build of {name} to go back to"))?;
        let current = current_image(&q, &image).await?;
        let (from, to) = (build(&current).await, build(&previous).await);
        switch_to(state, &q, &image, &previous, false).await?;
        Ok::<_, String>(Change { at: now_ms(), name: name.clone(), from, to, outcome: "reverted".into(), detail: None })
    }
    .await;
    {
        let mut saved = cu.saved.lock().unwrap();
        match &result {
            Ok(change) => {
                cu.waiting.lock().unwrap().retain(|w| w != &name);
                saved.history.push(change.clone());
                saved.held.insert(name.clone(), Hold { at: now_ms(), reason: "Gone back to the earlier build".into() });
                // The build it came back from is still the newest.
                if !saved.available.contains(&name) {
                    saved.available.push(name.clone());
                }
                saved.errors.clear();
            }
            Err(e) => saved.errors = vec![format!("Going back on {name} failed: {e}")],
        }
        cu.save(&saved);
    }
    *cu.running.lock().unwrap() = None;
    match result {
        Ok(_) => println!("Went back to the previous build of {name}"),
        Err(e) => eprintln!("Going back on {name} failed: {e}"),
    }
}

/// `{ check: true }` asks the registries now; `{ update: true, name? }` updates one container, or
/// all but the held ones; `{ revert: name }` goes back to the build before the last update;
/// `{ hold: name, held }` holds or releases one. Updates and going back run in the background;
/// the answer is the summary as they start.
pub async fn set(AxumState(state): AxumState<State>, body: Bytes) -> Result<Json<Value>, HttpError> {
    let body = json_body(&body)?;
    let cu = &state.container_updates;
    let name = |key: &str| body.get(key).and_then(Value::as_str).map(str::to_owned);
    let busy = || {
        cu.running
            .lock()
            .unwrap()
            .as_ref()
            .map(|r| HttpError(StatusCode::CONFLICT, format!("{} already; try again when it's done.", r.what)))
    };
    if let Some(n) = name("hold") {
        let held = body.get("held").and_then(Value::as_bool).unwrap_or(true);
        println!("container updates: hold {n} {held}");
        let mut saved = cu.saved.lock().unwrap();
        if held {
            // Nor restarted on a build already pulled.
            cu.waiting.lock().unwrap().retain(|w| w != &n);
            saved.held.insert(n, Hold { at: now_ms(), reason: "Held from the app".into() });
        } else {
            saved.held.remove(&n);
        }
        cu.save(&saved);
    } else if body.get("check") == Some(&Value::Bool(true)) {
        if let Some(e) = busy() {
            return Err(e);
        }
        println!("container updates: check");
        let s = state.clone();
        tokio::spawn(async move { check_now(&s).await });
    } else if body.get("update") == Some(&Value::Bool(true)) || name("revert").is_some() {
        if let Some(e) = busy() {
            return Err(e);
        }
        if state.game_mode.active() {
            return Err(HttpError(
                StatusCode::SERVICE_UNAVAILABLE,
                "Game mode is on, so most containers are stopped. Turn it off to update them.".into(),
            ));
        }
        let s = state.clone();
        if let Some(n) = name("revert") {
            println!("container updates: revert {n}");
            *cu.running.lock().unwrap() = Some(Running { what: format!("Going back on {n}"), step: "Starting".into(), since: now_ms() });
            tokio::spawn(async move { revert(&s, n).await });
        } else {
            let only = name("name").map(|n| vec![n]);
            println!("container updates: update {}", only.as_ref().map_or("all", |n| n[0].as_str()));
            *cu.running.lock().unwrap() = Some(Running { what: "Updating".into(), step: "Starting".into(), since: now_ms() });
            tokio::spawn(async move { update(&s, only, Run::ByHand).await });
        }
    } else {
        return Err(bad_request(
            "Expected { check: true }, { update: true, name? }, { revert: name } or { hold: name, held }",
        ));
    }
    summary(&state).await.map(Json)
}

#[cfg(test)]
mod tests {
    use super::{Build, build_of, changelog, due};
    use serde_json::json;

    #[test]
    fn builds() {
        let b = build_of("abc", &json!({ "org.opencontainers.image.version": "4.0.20.3014-ls1" }), Some(10));
        assert_eq!(b, Build { id: "abc".into(), version: Some("4.0.20.3014-ls1".into()), created: Some(10_000) });
        assert_eq!(build_of("abc", &json!({ "org.opencontainers.image.version": "latest" }), None).version, None);
        assert_eq!(build_of("abc", &json!({}), None).version, None);
    }

    #[test]
    fn changelogs() {
        let gh = json!({ "org.opencontainers.image.source": "https://github.com/binwiederhier/ntfy" });
        assert_eq!(changelog("ntfy", &gh).as_deref(), Some("https://github.com/binwiederhier/ntfy/releases"));
        let lsio = json!({ "org.opencontainers.image.source": "https://github.com/linuxserver/docker-sonarr" });
        assert_eq!(changelog("sonarr", &lsio).as_deref(), Some("https://github.com/Sonarr/Sonarr/releases"));
        assert_eq!(changelog("other", &json!({})), None);
    }

    #[test]
    fn nightly() {
        // Local times, so build them from the local clock.
        let at = |h: u32| {
            let now = crate::usage::now_ms();
            let start = now - (crate::localtime::hour(now) as i64) * 3_600_000 - now % 3_600_000;
            start + h as i64 * 3_600_000
        };
        assert!(!due(None, at(3)));
        assert!(due(None, at(5)));
        assert!(!due(Some(at(4)), at(6)));
        assert!(due(Some(at(4) - 24 * 3_600_000), at(5)));
    }
}

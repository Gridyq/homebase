//! Media: the Requests mini-app talks to Seerr, Sonarr and Radarr through here, so their API keys
//! stay on this machine. Keys are read from each app's own config on every call, so a rotated key
//! just works. Only the calls the app makes are let through. Seerr only runs while it's used.
//! qBittorrent's speed limit and seeding, and Tdarr's conversions, each have a small client of
//! their own, since they log in rather than take a key.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Request, State as AxumState};
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use regex::Regex;
use serde_json::{Map, Value, json};

use crate::args;
use crate::cache::Refreshed;
use crate::client::Upstream;
use crate::client::{Reply, call, form};
use crate::command::run;
use crate::history::num;
use crate::http::{HttpError, State};
use crate::machine::json_body;

/// A release search asks every indexer, some through FlareSolverr, so it can take a while.
const ARR_TIMEOUT: Duration = Duration::from_secs(180);
const MAX_BODY: usize = 64 * 1024;
const SEERR_UNIT: &str = "seerr.service";
const SEERR_IDLE: Duration = Duration::from_secs(30 * 60);
const SEERR_START_TIMEOUT: Duration = Duration::from_secs(90);
const GIB: f64 = 1024.0 * 1024.0 * 1024.0;

fn arr_dir() -> PathBuf {
    std::env::var("ARR_DIR").map_or_else(
        |_| PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".local/share/arr"),
        PathBuf::from,
    )
}

/// A value from the shared credentials file, as `key=value` lines.
fn credential(key: &str) -> Option<String> {
    let text = std::fs::read_to_string(arr_dir().join("credentials")).ok()?;
    text.lines()
        .find_map(|l| l.strip_prefix(&format!("{key}=")))
        .map(|v| v.trim().to_owned())
}

fn status(code: u16, message: impl Into<String>) -> HttpError {
    HttpError(StatusCode::from_u16(code).unwrap_or(StatusCode::BAD_GATEWAY), message.into())
}

fn didnt_answer(who: &str, e: &str) -> HttpError {
    status(502, format!("{who} didn't answer ({e})"))
}

/// The text of a reply as JSON when it says it is, and as a string otherwise.
fn reply_value(r: &Reply) -> Value {
    let text = r.text();
    if !text.is_empty() && r.is_json() {
        serde_json::from_str(&text).unwrap_or(Value::String(text))
    } else {
        Value::String(text)
    }
}

// ---------------------------------------------------------------------------------------------
// Seerr, Sonarr and Radarr

struct App {
    label: &'static str,
    base: &'static str,
    routes: &'static [(&'static str, &'static str)],
}

const SEERR: App = App {
    label: "Seerr",
    base: "http://localhost:5055/api/v1",
    routes: &[
        ("GET", r"^(search|movie/\d+|tv/\d+|request)$"),
        ("POST", r"^request$"),
        ("DELETE", r"^media/\d+$"),
    ],
};
const SONARR: App = App {
    label: "Sonarr",
    base: "http://localhost:8989/api/v3",
    routes: &[
        (
            "GET",
            r"^(queue|calendar|release|series|series/\d+|episodefile|qualityprofile|diskspace|manualimport)$",
        ),
        ("POST", r"^(release|command)$"),
        ("PUT", r"^series/\d+$"),
        ("DELETE", r"^(queue/\d+|series/\d+|episodefile/bulk)$"),
    ],
};
const RADARR: App = App {
    label: "Radarr",
    base: "http://localhost:7878/api/v3",
    routes: &[
        ("GET", r"^(queue|calendar|release|movie|movie/\d+|qualityprofile|manualimport)$"),
        ("POST", r"^(release|command)$"),
        ("DELETE", r"^(queue/\d+|movie/\d+)$"),
    ],
};

/// The only Sonarr/Radarr commands the phone may start: fixing downloads stuck on import.
const ARR_COMMANDS: &[&str] = &["ManualImport", "RefreshMonitoredDownloads"];

static ROUTES: LazyLock<HashMap<(&'static str, &'static str), Regex>> = LazyLock::new(|| {
    let mut m = HashMap::new();
    for (name, app) in [("seerr", &SEERR), ("sonarr", &SONARR), ("radarr", &RADARR)] {
        for (method, pattern) in app.routes {
            m.insert((name, *method), Regex::new(pattern).unwrap());
        }
    }
    m
});

fn app(name: &str) -> Option<(&'static str, &'static App)> {
    match name {
        "seerr" => Some(("seerr", &SEERR)),
        "sonarr" => Some(("sonarr", &SONARR)),
        "radarr" => Some(("radarr", &RADARR)),
        _ => None,
    }
}

fn api_key(name: &str) -> Option<String> {
    let dir = arr_dir().join(name);
    if name == "seerr" {
        let settings: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("settings.json")).ok()?).ok()?;
        return settings["main"]["apiKey"].as_str().map(str::to_owned);
    }
    let xml = std::fs::read_to_string(dir.join("config.xml")).ok()?;
    let start = xml.find("<ApiKey>")? + "<ApiKey>".len();
    let end = start + xml[start..].find('<')?;
    Some(xml[start..end].to_owned()).filter(|k| !k.is_empty())
}

pub struct Media {
    seerr_last_used: Mutex<Instant>,
    seerr_starting: tokio::sync::Mutex<()>,
    qbit_cookie: Mutex<Option<String>>,
    tdarr: Arc<Tdarr>,
    /// Tdarr's file list carries every file's full probe and takes ~180 ms, so it's fetched at most
    /// every 15 s, in the background while the last one is under 5 minutes old.
    tdarr_files: Arc<TdarrFiles>,
}

/// What's kept of each file Tdarr knows; the rest of its entry is the file's full probe.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TdarrFile {
    // Read as they come, so an odd entry doesn't spoil the list.
    #[serde(default)]
    file: Value,
    #[serde(rename = "TranscodeDecisionMaker", default)]
    decision: Value,
    #[serde(default)]
    old_size: Value,
    #[serde(default)]
    new_size: Value,
    #[serde(default)]
    last_transcode_date: Value,
}

type TakeFiles = Box<dyn Fn() -> std::pin::Pin<Box<dyn Future<Output = Result<Vec<TdarrFile>, String>> + Send>> + Send + Sync>;
type TdarrFiles = Refreshed<Vec<TdarrFile>, TakeFiles>;

impl Media {
    pub fn new(upstream: Upstream) -> Self {
        let tdarr = Arc::new(Tdarr {
            upstream,
            token: Mutex::new(None),
        });
        let for_files = Arc::clone(&tdarr);
        let take: TakeFiles = Box::new(move || {
            let t = Arc::clone(&for_files);
            Box::pin(async move {
                let reply = t
                    .call_raw("cruddb", Some(json!({ "data": { "collection": "FileJSONDB", "mode": "getAll" } })))
                    .await
                    .map_err(|e| e.1)?;
                // Read straight into what's kept: the whole list as JSON values is ~100 MB.
                let files = serde_json::from_slice(&reply.body).map_err(|e| e.to_string());
                drop(reply);
                // SAFETY: malloc_trim only hands free memory back to the system.
                unsafe { libc::malloc_trim(0) };
                files
            })
        });
        Self {
            seerr_last_used: Mutex::new(Instant::now()),
            seerr_starting: Default::default(),
            qbit_cookie: Mutex::new(None),
            tdarr,
            tdarr_files: Refreshed::new("Listing Tdarr's files", Duration::from_secs(15), Duration::from_secs(5 * 60), take),
        }
    }
}

async fn seerr_answers(upstream: &Upstream) -> bool {
    call(
        upstream,
        Method::GET,
        &format!("{}/status", SEERR.base),
        &[],
        None,
        Duration::from_secs(2),
    )
    .await
    .is_ok_and(|r| r.status.is_success())
}

/// Starts Seerr if it isn't running, and waits until it answers.
async fn wake_seerr(state: &State) -> Result<(), HttpError> {
    *state.media.seerr_last_used.lock().unwrap() = Instant::now();
    if seerr_answers(&state.upstream).await {
        return Ok(());
    }
    // Whoever comes second waits for the first start rather than starting it again.
    let _starting = state.media.seerr_starting.lock().await;
    if seerr_answers(&state.upstream).await {
        return Ok(());
    }
    println!("Starting Seerr for the Requests app");
    run("systemctl", &args!["--user", "start", SEERR_UNIT], Duration::from_secs(120))
        .await
        .map_err(HttpError::internal)?;
    let deadline = Instant::now() + SEERR_START_TIMEOUT;
    while !seerr_answers(&state.upstream).await {
        if Instant::now() > deadline {
            return Err(status(504, "Seerr is taking too long to start. Try again in a minute."));
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Ok(())
}

/// Seerr stops after half an hour without calls; its unit isn't started at boot.
async fn stop_idle_seerr(state: &State) {
    let Ok(_starting) = state.media.seerr_starting.try_lock() else {
        return;
    };
    if state.media.seerr_last_used.lock().unwrap().elapsed() < SEERR_IDLE {
        return;
    }
    let active = crate::command::output("systemctl", &args!["--user", "is-active", SEERR_UNIT], Duration::from_secs(30)).await;
    if !active.is_ok_and(|o| o.stdout.trim() == "active") {
        return;
    }
    println!("Stopping Seerr, unused for half an hour");
    if let Err(e) = run("systemctl", &args!["--user", "stop", SEERR_UNIT], Duration::from_secs(120)).await {
        eprintln!("Couldn't stop Seerr: {e}");
    }
}

fn json_reply(body: Bytes) -> Response {
    let mut res = (StatusCode::OK, body).into_response();
    res.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

/// `/api/arr/{app}/{path}`: passes an allowed call on with the app's key.
pub async fn arr(AxumState(state): AxumState<State>, req: Request) -> Result<Response, HttpError> {
    let (parts, body) = req.into_parts();
    let rest = parts.uri.path().strip_prefix("/api/arr/").unwrap_or_default();
    let (name, api_path) = rest.split_once('/').unwrap_or((rest, ""));
    let not_found = || status(404, "Not found");
    if api_path.is_empty() || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
        return Err(not_found());
    }
    let (name, app) = app(name).ok_or_else(not_found)?;
    let method = parts.method.as_str();
    if !ROUTES.get(&(name, method)).is_some_and(|r| r.is_match(api_path)) {
        return Err(not_found());
    }
    state.game_mode.error(app.label)?;
    if name == "seerr" {
        wake_seerr(&state).await?;
    }
    let key = api_key(name).ok_or_else(|| status(503, format!("{name} isn't set up on the server")))?;
    if method != "GET" {
        println!("{method} {name}/{api_path}");
    }
    let body = if method == "GET" {
        None
    } else {
        let bytes = axum::body::to_bytes(body, MAX_BODY)
            .await
            .map_err(|_| status(413, "Request body too large"))?;
        (!bytes.is_empty()).then_some(bytes)
    };
    if api_path == "command" {
        let command = body
            .as_ref()
            .and_then(|b| serde_json::from_slice::<Value>(b).ok())
            .and_then(|v| v["name"].as_str().map(str::to_owned));
        if !command.as_deref().is_some_and(|c| ARR_COMMANDS.contains(&c)) {
            return Err(status(
                403,
                format!("The {} command isn't allowed", command.as_deref().unwrap_or("unnamed")),
            ));
        }
    }
    let search = parts.uri.query().map(|q| format!("?{q}")).unwrap_or_default();
    let headers = [("X-Api-Key", key), ("Content-Type", "application/json".to_owned())];
    let reply = call(
        &state.upstream,
        parts.method.clone(),
        &format!("{}/{api_path}{search}", app.base),
        &headers,
        body,
        ARR_TIMEOUT,
    )
    .await
    .map_err(|e| didnt_answer(name, &e))?;
    if !reply.status.is_success() {
        // Seerr and the *arrs put the reason in `message`, or in a list of validation failures.
        let message = serde_json::from_slice::<Value>(&reply.body).ok().and_then(|v| match &v {
            Value::Array(failures) => Some(
                failures
                    .iter()
                    .filter_map(|f| f["errorMessage"].as_str())
                    .filter(|m| !m.is_empty())
                    .collect::<Vec<_>>()
                    .join(" "),
            ),
            _ => v["message"].as_str().map(str::to_owned),
        });
        let message = message
            .filter(|m| !m.is_empty())
            .unwrap_or_else(|| format!("{name} answered {}", reply.status.as_u16()));
        return Err(HttpError(reply.status, message));
    }
    Ok(json_reply(if reply.body.is_empty() {
        Bytes::from_static(b"null")
    } else {
        reply.body
    }))
}

// ---------------------------------------------------------------------------------------------
// qBittorrent: a login cookie rather than a key, and form bodies.

fn qbit_url() -> String {
    std::env::var("QBIT_URL").unwrap_or_else(|_| "http://localhost:8090".into())
}

async fn qbit_login(state: &State) -> Result<String, HttpError> {
    // The shared password from the credentials file; qBittorrent's user is always "admin".
    let password = credential("password").ok_or_else(|| status(503, "qBittorrent's login isn't set up on the server"))?;
    let url = qbit_url();
    let body = form(&[("username", "admin"), ("password", &password)]);
    let headers = [
        ("Referer", url.clone()),
        ("Content-Type", "application/x-www-form-urlencoded".to_owned()),
    ];
    let reply = call(
        &state.upstream,
        Method::POST,
        &format!("{url}/api/v2/auth/login"),
        &headers,
        Some(body.into()),
        Duration::from_secs(10),
    )
    .await
    .map_err(|e| didnt_answer("qBittorrent", &e))?;
    // Older versions answer a wrong password with 200 "Fails." and no cookie.
    let cookie = reply
        .headers
        .get(header::SET_COOKIE)
        .and_then(|c| c.to_str().ok())
        .and_then(|c| c.split(';').next())
        .map(str::to_owned);
    match cookie {
        Some(c) if reply.status.is_success() => {
            *state.media.qbit_cookie.lock().unwrap() = Some(c.clone());
            Ok(c)
        }
        _ => Err(status(502, "qBittorrent didn't accept the login")),
    }
}

async fn qbit(state: &State, api_path: &str, form_body: Option<&[(&str, &str)]>) -> Result<Value, HttpError> {
    state.game_mode.error("qBittorrent")?;
    let url = qbit_url();
    for attempt in 0..2 {
        let saved = state.media.qbit_cookie.lock().unwrap().clone();
        let cookie = match saved {
            Some(c) => c,
            None => qbit_login(state).await?,
        };
        let mut headers = vec![("Cookie", cookie), ("Referer", url.clone())];
        if form_body.is_some() {
            headers.push(("Content-Type", "application/x-www-form-urlencoded".to_owned()));
        }
        let method = if form_body.is_some() { Method::POST } else { Method::GET };
        let reply = call(
            &state.upstream,
            method,
            &format!("{url}/api/v2/{api_path}"),
            &headers,
            form_body.map(|f| form(f).into()),
            Duration::from_secs(10),
        )
        .await
        .map_err(|e| didnt_answer("qBittorrent", &e))?;
        // The session expired or qBittorrent restarted: log in again once.
        if matches!(reply.status.as_u16(), 401 | 403) && attempt == 0 {
            *state.media.qbit_cookie.lock().unwrap() = None;
            continue;
        }
        if !reply.status.is_success() {
            return Err(status(502, format!("qBittorrent answered {}", reply.status.as_u16())));
        }
        return Ok(reply_value(&reply));
    }
    unreachable!()
}

/// Current download speed and the global limit, both in bytes per second; a limit of 0 is none.
async fn speed_limit_state(state: &State) -> Result<Value, HttpError> {
    let info = qbit(state, "transfer/info", None).await?;
    Ok(json!({ "speed": info["dl_info_speed"], "limit": info["dl_rate_limit"] }))
}

pub async fn speed_limit(AxumState(state): AxumState<State>) -> Result<Json<Value>, HttpError> {
    Ok(Json(speed_limit_state(&state).await?))
}

pub async fn set_speed_limit(AxumState(state): AxumState<State>, body: Bytes) -> Result<Json<Value>, HttpError> {
    let limit = json_body(&body)?.get("limit").cloned().unwrap_or(Value::Null);
    println!("download limit {limit}");
    let limit = limit.as_f64().filter(|l| l.fract() == 0.0 && *l >= 0.0);
    let Some(limit) = limit else {
        return Err(status(400, "The limit must be a whole number of bytes per second"));
    };
    // The alternative ("turtle") limits replace the global ones while they're on, so turn them off
    // or the new limit wouldn't apply.
    if qbit(&state, "transfer/speedLimitsMode", None).await? == json!("1") {
        qbit(&state, "transfer/toggleSpeedLimitsMode", Some(&[])).await?;
    }
    qbit(&state, "transfer/setDownloadLimit", Some(&[("limit", &(limit as u64).to_string())])).await?;
    Ok(Json(speed_limit_state(&state).await?))
}

// States of finished torrents that are uploading or waiting to, and of ones stopped after
// finishing. qBittorrent 5 renamed "paused" to "stopped".
const SEEDING_STATES: &[&str] = &["uploading", "stalledUP", "forcedUP", "queuedUP", "checkingUP"];
const STOPPED_STATES: &[&str] = &["stoppedUP", "pausedUP"];

fn in_states<'a>(torrents: &'a Value, states: &[&str]) -> impl Iterator<Item = &'a Value> {
    torrents
        .as_array()
        .into_iter()
        .flatten()
        .filter(move |t| t["state"].as_str().is_some_and(|s| states.contains(&s)))
}

/// How many finished torrents are seeding and how many are stopped, the upload speed, and whether
/// torrents stop by themselves as soon as they finish.
async fn seeding_state(state: &State) -> Result<Value, HttpError> {
    let (torrents, info, prefs) = tokio::join!(
        qbit(state, "torrents/info", None),
        qbit(state, "transfer/info", None),
        qbit(state, "app/preferences", None)
    );
    let (torrents, info, prefs) = (torrents?, info?, prefs?);
    let stop_when_done =
        prefs["max_ratio_enabled"] == true && prefs["max_ratio"].as_f64() == Some(0.0) && prefs["max_ratio_act"].as_f64() == Some(0.0);
    Ok(json!({
        "seeding": in_states(&torrents, SEEDING_STATES).count(),
        "stopped": in_states(&torrents, STOPPED_STATES).count(),
        "speed": info["up_info_speed"],
        "stopWhenDone": stop_when_done,
    }))
}

pub async fn seeding(AxumState(state): AxumState<State>) -> Result<Json<Value>, HttpError> {
    Ok(Json(seeding_state(&state).await?))
}

pub async fn set_seeding(AxumState(state): AxumState<State>, body: Bytes) -> Result<Json<Value>, HttpError> {
    let body = json_body(&body)?;
    println!("seeding {body}");
    if let Some(stop) = body.get("stopWhenDone").and_then(Value::as_bool) {
        // A share ratio limit of 0 is reached the moment a torrent finishes, and action 0 stops it.
        // Turning it off goes back to seeding with no limit.
        let prefs = if stop {
            json!({ "max_ratio_enabled": true, "max_ratio": 0, "max_ratio_act": 0 })
        } else {
            json!({ "max_ratio_enabled": false })
        };
        qbit(&state, "app/setPreferences", Some(&[("json", &prefs.to_string())])).await?;
    }
    if let Some(seed) = body.get("seed").and_then(Value::as_bool) {
        // Only finished torrents: stopping everything would also stop downloads.
        let torrents = qbit(&state, "torrents/info", None).await?;
        let hashes: Vec<&str> = in_states(&torrents, if seed { STOPPED_STATES } else { SEEDING_STATES })
            .filter_map(|t| t["hash"].as_str())
            .collect();
        if !hashes.is_empty() {
            qbit(
                &state,
                if seed { "torrents/start" } else { "torrents/stop" },
                Some(&[("hashes", &hashes.join("|"))]),
            )
            .await?;
        }
    }
    Ok(Json(seeding_state(&state).await?))
}

/// "Show.Name.S01E02.1080p" → ("showname", 1, 2), as `/^(.*?)[ ._-]*S(\d{1,2})(?:E(\d{1,3}))?(?!\d)/i`
/// matches it: the shortest name before an S and season (and maybe E and episode) that isn't
/// followed by another digit.
fn episode_of(name: &str) -> Option<(String, u32, u32)> {
    let b = name.as_bytes();
    let digits_at = |i: usize, max: usize| {
        (1..=max)
            .rev()
            .filter(move |n| i + n <= b.len() && b[i..i + n].iter().all(u8::is_ascii_digit))
    };
    let not_digit_at = |i: usize| b.get(i).is_none_or(|c| !c.is_ascii_digit());
    for k in 0..=b.len() {
        if !name.is_char_boundary(k) {
            continue;
        }
        let mut i = k;
        while i < b.len() && matches!(b[i], b' ' | b'.' | b'_' | b'-') {
            i += 1;
        }
        if !matches!(b.get(i), Some(b'S' | b's')) {
            continue;
        }
        for s in digits_at(i + 1, 2) {
            let season: u32 = name[i + 1..i + 1 + s].parse().ok()?;
            let after = i + 1 + s;
            if matches!(b.get(after), Some(b'E' | b'e')) {
                for e in digits_at(after + 1, 3) {
                    if not_digit_at(after + 1 + e) {
                        let show = name[..k].to_lowercase().chars().filter(char::is_ascii_alphanumeric).collect();
                        return Some((show, season, name[after + 1..after + 1 + e].parse().ok()?));
                    }
                }
            }
            if not_digit_at(after) {
                return Some((
                    name[..k].to_lowercase().chars().filter(char::is_ascii_alphanumeric).collect(),
                    season,
                    0,
                ));
            }
        }
    }
    None
}

/// Keeps queued TV torrents in episode order, so a show grabbed one episode at a time comes in from
/// the first episode on. Shows go in the order they were first added; movies keep their places.
/// Sonarr also asks for sequential download, which does the same for the files in a season pack.
async fn sort_tv_queue(state: &State) -> Result<(), HttpError> {
    if state.game_mode.active() {
        return Ok(());
    }
    // Queue positions start at 1; finished torrents have none.
    let all = qbit(state, "torrents/info?sort=priority", None).await?;
    let queue: Vec<&Value> = all
        .as_array()
        .into_iter()
        .flatten()
        .filter(|t| t["priority"].as_f64().is_some_and(|p| p > 0.0))
        .collect();
    let mut tv = Vec::new();
    for t in queue.iter().filter(|t| t["category"] == "tv") {
        let Some(e) = episode_of(t["name"].as_str().unwrap_or_default()) else {
            return Ok(());
        };
        tv.push((*t, e));
    }
    let mut first_added: HashMap<String, f64> = HashMap::new();
    for (t, (show, ..)) in &tv {
        let added = t["added_on"].as_f64().unwrap_or(f64::INFINITY);
        let was = first_added.entry(show.clone()).or_insert(added);
        *was = was.min(added);
    }
    let mut sorted = tv.clone();
    sorted.sort_by(|(_, a), (_, b)| {
        first_added[&a.0]
            .total_cmp(&first_added[&b.0])
            .then_with(|| a.0.cmp(&b.0))
            .then(a.1.cmp(&b.1))
            .then(a.2.cmp(&b.2))
    });
    let mut next = sorted.iter().map(|(t, _)| *t);
    let wanted: Vec<&Value> = queue
        .iter()
        .map(|t| if t["category"] == "tv" { next.next().unwrap_or(t) } else { t })
        .collect();
    let hash = |t: &Value| t["hash"].as_str().unwrap_or_default().to_owned();
    if wanted.iter().zip(&queue).all(|(a, b)| hash(a) == hash(b)) {
        return Ok(());
    }
    // Moving each to the top, last first, leaves them in the wanted order.
    for t in wanted.iter().rev() {
        qbit(state, "torrents/topPrio", Some(&[("hashes", &hash(t))])).await?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Tdarr converts the library to HEVC MP4s. It has its own login (the shared credentials) that
// hands out a bearer token. The phone sees what's converting, what's done and what was saved,
// and can pause the node; everything else stays in Tdarr's web UI.

struct Tdarr {
    upstream: Upstream,
    token: Mutex<Option<String>>,
}

fn tdarr_url() -> String {
    std::env::var("TDARR_URL").unwrap_or_else(|_| "http://localhost:8265".into())
}

impl Tdarr {
    async fn login(&self) -> Result<String, HttpError> {
        let (Some(username), Some(password)) = (credential("username"), credential("password")) else {
            return Err(status(503, "Tdarr's login isn't set up on the server"));
        };
        let body = json!({ "username": username, "password": password }).to_string();
        let reply = call(
            &self.upstream,
            Method::POST,
            &format!("{}/api/v2/public/auth/login", tdarr_url()),
            &[("Content-Type", "application/json".to_owned())],
            Some(body.into()),
            Duration::from_secs(10),
        )
        .await
        .map_err(|e| didnt_answer("Tdarr", &e))?;
        let token = reply
            .status
            .is_success()
            .then(|| serde_json::from_slice::<Value>(&reply.body).ok())
            .flatten();
        let token = token.and_then(|v| v["token"].as_str().map(str::to_owned)).filter(|t| !t.is_empty());
        *self.token.lock().unwrap() = token.clone();
        token.ok_or_else(|| status(502, "Tdarr didn't accept the login"))
    }

    async fn call(&self, api_path: &str, body: Option<Value>) -> Result<Value, HttpError> {
        // Updates answer a plain "OK".
        Ok(reply_value(&self.call_raw(api_path, body).await?))
    }

    async fn call_raw(&self, api_path: &str, body: Option<Value>) -> Result<Reply, HttpError> {
        for attempt in 0..2 {
            let saved = self.token.lock().unwrap().clone();
            let token = match saved {
                Some(t) => t,
                None => self.login().await?,
            };
            let headers = [
                ("Authorization", format!("Bearer {token}")),
                ("Content-Type", "application/json".to_owned()),
            ];
            let method = if body.is_some() { Method::POST } else { Method::GET };
            let reply = call(
                &self.upstream,
                method,
                &format!("{}/api/v2/{api_path}", tdarr_url()),
                &headers,
                body.as_ref().map(|b| b.to_string().into()),
                Duration::from_secs(30),
            )
            .await
            .map_err(|e| didnt_answer("Tdarr", &e))?;
            if matches!(reply.status.as_u16(), 401 | 403) && attempt == 0 {
                *self.token.lock().unwrap() = None;
                continue;
            }
            if !reply.status.is_success() {
                return Err(status(502, format!("Tdarr answered {}", reply.status.as_u16())));
            }
            return Ok(reply);
        }
        unreachable!()
    }
}

async fn tdarr(state: &State, api_path: &str, body: Option<Value>) -> Result<Value, HttpError> {
    state.game_mode.error("Tdarr")?;
    state.media.tdarr.call(api_path, body).await
}

/// "/data/Shows/X/Y.mkv" → its name without the extension, and whether it's a show.
fn tdarr_file(file: &Value) -> Map<String, Value> {
    let path = file.as_str().unwrap_or_default();
    let base = path.rsplit('/').next().unwrap_or(path);
    let stem = match base.rfind('.') {
        Some(i) if i > 0 => &base[..i],
        _ => base,
    };
    let mut m = Map::new();
    m.insert("file".into(), json!(stem));
    m.insert("show".into(), json!(path.starts_with("/data/Shows/")));
    m
}

fn put(m: &mut Map<String, Value>, key: &str, v: &Value) {
    if !v.is_null() {
        m.insert(key.into(), v.clone());
    }
}

/// The nodes, as a list.
async fn tdarr_nodes(state: &State) -> Result<Vec<Value>, HttpError> {
    let nodes = tdarr(state, "get-nodes", None).await?;
    Ok(nodes.as_object().map(|o| o.values().cloned().collect()).unwrap_or_default())
}

/// Files Tdarr is converting right now.
pub async fn converting(state: &State) -> Option<f64> {
    let nodes = tdarr_nodes(state).await.ok()?;
    Some(nodes.iter().map(|n| n["workers"].as_object().map_or(0, Map::len)).sum::<usize>() as f64)
}

async fn conversions_state(state: &State) -> Result<Value, HttpError> {
    // First, so game mode and an unreachable Tdarr fail here rather than in the background.
    let nodes = tdarr_nodes(state).await?;
    let files = state.media.tdarr_files.get().await.map_err(|e| status(502, e))?;

    let (mut queued, mut done_count, mut skipped, mut failed_count) = (0, 0, 0, 0);
    let mut done: Vec<Map<String, Value>> = Vec::new();
    let mut failed: Vec<Map<String, Value>> = Vec::new();
    let mut saved = 0.0;
    for f in files.iter() {
        let (file, at) = (&f.file, &f.last_transcode_date);
        match f.decision.as_str() {
            Some("Queued") => queued += 1,
            Some("Not required") => skipped += 1,
            Some("Transcode success") => {
                done_count += 1;
                let size = |v: &Value| if v.is_null() { 0.0 } else { crate::js::number(v) };
                let (old, new) = (size(&f.old_size) * GIB, size(&f.new_size) * GIB);
                if old != 0.0 && new != 0.0 {
                    saved += old - new;
                }
                let mut d = tdarr_file(file);
                d.insert("oldSize".into(), num(old));
                d.insert("newSize".into(), num(new));
                put(&mut d, "at", at);
                done.push(d);
            }
            Some("Transcode error") => {
                failed_count += 1;
                let mut d = tdarr_file(file);
                put(&mut d, "at", at);
                failed.push(d);
            }
            _ => {}
        }
    }
    let at = |m: &Map<String, Value>| m.get("at").and_then(Value::as_f64).unwrap_or(0.0);
    done.sort_by(|a, b| at(b).total_cmp(&at(a)));
    failed.sort_by(|a, b| at(b).total_cmp(&at(a)));

    let workers: Vec<Value> = nodes
        .iter()
        .flat_map(|n| {
            n["workers"]
                .as_object()
                .map(|w| w.values().cloned().collect::<Vec<_>>())
                .unwrap_or_default()
        })
        .map(|w| {
            let mut m = tdarr_file(&w["file"]);
            put(&mut m, "percent", &w["percentage"]);
            put(&mut m, "eta", &w["ETA"]);
            put(&mut m, "fps", &w["fps"]);
            put(&mut m, "startedAt", &w["job"]["start"]);
            m.insert("oldSize".into(), num(w["originalfileSizeInGbytes"].as_f64().unwrap_or(0.0) * GIB));
            m.insert("estSize".into(), num(w["estSize"].as_f64().unwrap_or(0.0) * GIB));
            Value::Object(m)
        })
        .collect();
    Ok(json!({
        "paused": !nodes.is_empty() && nodes.iter().all(|n| n["nodePaused"] == true),
        "workers": workers,
        "counts": { "queued": queued, "done": done_count, "skipped": skipped, "failed": failed_count },
        "savedBytes": num(saved),
        "recent": done.into_iter().take(30).collect::<Vec<_>>(),
        "errors": failed.into_iter().take(30).collect::<Vec<_>>(),
    }))
}

pub async fn conversions(AxumState(state): AxumState<State>) -> Result<Json<Value>, HttpError> {
    Ok(Json(conversions_state(&state).await?))
}

/// A paused node finishes the file it's on, then waits.
pub async fn set_conversions_paused(AxumState(state): AxumState<State>, body: Bytes) -> Result<Json<Value>, HttpError> {
    let paused = json_body(&body)?.get("paused").cloned().unwrap_or(Value::Null);
    println!("conversions paused {paused}");
    let Some(paused) = paused.as_bool() else {
        return Err(status(400, "Expected { paused: true | false }"));
    };
    let nodes = tdarr(&state, "get-nodes", None).await?;
    for id in nodes.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>()).unwrap_or_default() {
        tdarr(
            &state,
            "update-node",
            Some(json!({ "data": { "nodeID": id, "nodeUpdates": { "nodePaused": paused } } })),
        )
        .await?;
    }
    Ok(Json(conversions_state(&state).await?))
}

/// Seerr's idle stop and the TV queue's order, every minute.
pub fn start(state: State) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + Duration::from_secs(60), Duration::from_secs(60));
        loop {
            tick.tick().await;
            stop_idle_seerr(&state).await;
            let _ = sort_tv_queue(&state).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::episode_of;

    #[test]
    fn episodes_like_the_javascript_pattern() {
        let e = |n: &str| episode_of(n).map(|(s, a, b)| (s, a, b));
        assert_eq!(e("Show.Name.S01E02.1080p.WEB"), Some(("showname".into(), 1, 2)));
        assert_eq!(e("Seinfeld S09E23 720p"), Some(("seinfeld".into(), 9, 23)));
        assert_eq!(e("The Show - s2 complete"), Some(("theshow".into(), 2, 0)));
        // E with four digits: the episode can't be read, so it's the season alone.
        assert_eq!(e("Show S01E1234"), Some(("show".into(), 1, 0)));
        // S followed by three digits isn't a season.
        assert_eq!(e("Movie S123"), None);
        assert_eq!(e("Movie.2020.1080p"), None);
        assert_eq!(e("S01E01 First"), Some(("".into(), 1, 1)));
    }
}

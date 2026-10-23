//! Events: what happened to the services and the machine, kept a year in `events.jsonl`. Starts,
//! stops and restarts are noticed by comparing each reading's services with the last; who caused
//! them is worked out from what this server did around then. Memory kills come from the journal.
//! Problems (a full disk, a hot CPU, a failed service, an ailing drive) are logged and sent through
//! ntfy when they start and when they clear.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::args;
use crate::command;
use crate::gamemode::ON_DEMAND_UNITS;
use crate::history::{HISTORY_MAX_MS, append_json_line, read_json_lines, write_json_lines};
use crate::usage::{Pod, UNITS, group_label};

/// How long after an action its effects are put down to it.
const INTENT_MS: i64 = 3 * 60_000;
const OOM_PATTERN: &str = "oom-kill:|^Killed .* due to memory";
const DISK_WARN: f64 = 0.9;
const TEMP_WARN: f64 = 90.0;

#[derive(Serialize, Deserialize, Clone)]
pub struct Event {
    pub t: i64,
    pub kind: String,
    /// For game mode: whether it went on.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub on: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub drive: Option<String>,
}

impl Event {
    pub fn new(t: i64, kind: &str) -> Self {
        Self {
            t,
            kind: kind.into(),
            on: None,
            id: None,
            name: None,
            by: None,
            detail: None,
            drive: None,
        }
    }

    fn of(mut self, id: &str, name: &str) -> Self {
        self.id = Some(id.into());
        self.name = Some(name.into());
        self
    }
}

/// A notification to send once the lock on the events is let go.
pub struct Notice {
    pub title: String,
    pub message: String,
    pub tags: &'static str,
    pub click: Option<String>,
}

fn service_link(id: &str) -> String {
    let mut encoded = String::new();
    for b in id.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            encoded.push(b as char);
        } else {
            encoded.push_str(&format!("%{b:02X}"));
        }
    }
    format!("homebase://server/service/{encoded}")
}

/// A service as the events need it.
pub struct Seen {
    pub id: String,
    pub name: String,
    pub state: String,
    pub since: Option<i64>,
    pub restarts: u64,
    pub detail: Option<String>,
}

#[derive(Clone)]
struct Settled {
    state: String,
    since: Option<i64>,
    restarts: u64,
}

pub struct Events {
    path: PathBuf,
    pub list: Vec<Event>,
    /// Service id → when it was started or stopped from the app.
    intents: HashMap<String, i64>,
    /// Each service's last settled state, to compare the next reading with.
    last_states: Option<HashMap<String, Settled>>,
    journal_checked_at: i64,
    started_at: i64,
    /// Problems as of the last look, by key, in the order found.
    known: Vec<(String, String)>,
}

impl Events {
    pub fn new(dir: &Path, now: i64) -> Self {
        Self {
            path: dir.join("events.jsonl"),
            list: Vec::new(),
            intents: HashMap::new(),
            last_states: None,
            journal_checked_at: now,
            started_at: now,
            known: Vec::new(),
        }
    }

    pub fn add(&mut self, e: Event) {
        if let Err(err) = append_json_line(&self.path, &serde_json::to_value(&e).unwrap_or_default()) {
            eprintln!("Couldn't save event: {err}");
        }
        self.list.push(e);
    }

    /// The saved events, and `boots` that aren't among them.
    pub fn load(&mut self, now: i64, boots: &[i64]) {
        self.list = read_json_lines(&self.path)
            .into_iter()
            .filter_map(|v| serde_json::from_value::<Event>(v).ok())
            .filter(|e| e.t > now - HISTORY_MAX_MS)
            .collect();
        for &boot in boots {
            if boot > now - HISTORY_MAX_MS && !self.list.iter().any(|e| e.kind == "boot" && (e.t - boot).abs() < 5 * 60_000) {
                self.add(Event::new(boot, "boot"));
            }
        }
        self.list.sort_by_key(|e| e.t);
        // Memory kills since the last one logged, including any while this server was down.
        let last_oom = self.list.iter().rev().find(|e| e.kind == "oom").map_or(0, |e| e.t);
        self.journal_checked_at = (last_oom + 1).max(now - 31 * 24 * 3_600_000);
    }

    pub fn compact(&mut self, now: i64) {
        self.list.retain(|e| e.t > now - HISTORY_MAX_MS);
        let lines = self.list.iter().map(|e| serde_json::to_value(e).unwrap_or_default());
        if let Err(e) = write_json_lines(&self.path, lines) {
            eprintln!("Couldn't compact events: {e}");
        }
    }

    pub fn note_intent(&mut self, id: &str, now: i64) {
        self.intents.insert(id.to_owned(), now);
    }

    /// Why a service started or stopped just now, when this server knows.
    fn cause_of(&self, id: &str, now: i64, game_mode: &Value) -> Option<String> {
        if self.intents.get(id).is_some_and(|at| now - at < INTENT_MS) {
            return Some("you".into());
        }
        let since = game_mode["since"].as_i64();
        let stops = game_mode["services"]
            .as_array()
            .is_some_and(|s| s.iter().any(|x| x.as_str() == Some(id)));
        if since.is_some_and(|s| now - s < INTENT_MS) && stops {
            return Some("game mode".into());
        }
        let name = id.split_once(':').map_or(id, |(_, n)| n);
        ON_DEMAND_UNITS
            .contains(&format!("{name}.service").as_str())
            .then(|| "on demand".into())
    }

    /// Compares the services with the last reading, logs what changed and returns what to say.
    pub fn note_service_changes(&mut self, list: &[Seen], now: i64, game_mode: &Value) -> Vec<Notice> {
        let mut notices = Vec::new();
        let mut next = self.last_states.clone().unwrap_or_default();
        for s in list {
            // Mid-change states settle by the next reading or two; compare settled ones.
            if s.state == "changing" {
                continue;
            }
            next.insert(
                s.id.clone(),
                Settled {
                    state: s.state.clone(),
                    since: s.since,
                    restarts: s.restarts,
                },
            );
            let Some(prev) = self.last_states.as_ref().and_then(|l| l.get(&s.id)).cloned() else {
                continue;
            };
            let base = |kind| Event::new(now, kind).of(&s.id, &s.name);
            if s.restarts > prev.restarts {
                let mut e = base("crashed");
                e.detail = Some("Restarted by systemd".into());
                self.add(e);
                notices.push(Notice {
                    title: format!("{} crashed", s.name),
                    message: "It stopped unexpectedly and systemd restarted it.".into(),
                    tags: "boom",
                    click: Some(service_link(&s.id)),
                });
            } else if s.state == "failed" && prev.state != "failed" {
                let mut e = base("failed");
                e.detail = s.detail.clone();
                self.add(e);
            } else if s.state == "stopped" && prev.state == "running" {
                let mut e = base("stopped");
                e.by = self.cause_of(&s.id, now, game_mode);
                self.add(e);
            } else if s.state == "running" && prev.state != "running" {
                let mut e = base("started");
                e.by = self.cause_of(&s.id, now, game_mode);
                self.add(e);
            } else if s.state == "running" && s.since.is_some() && prev.since.is_some() && s.since != prev.since {
                let mut e = base("restarted");
                e.by = self.cause_of(&s.id, now, game_mode);
                self.add(e);
            }
        }
        self.last_states = Some(next);
        notices
    }

    /// Problems found now against those known before: logs and says what started and cleared.
    pub fn note_problems(&mut self, current: Vec<(String, String)>, now: i64) -> Vec<Notice> {
        let has = |list: &[(String, String)], k: &str| list.iter().any(|(key, _)| key == k);
        let started: Vec<String> = current
            .iter()
            .filter(|(k, _)| !has(&self.known, k))
            .map(|(_, v)| v.clone())
            .collect();
        let cleared: Vec<String> = self
            .known
            .iter()
            .filter(|(k, _)| !has(&current, k))
            .map(|(_, v)| v.clone())
            .collect();
        // Logged once per problem, though a restart of this server forgets what it already knew.
        let drive_of = |k: &str| k.strip_prefix("drive:").and_then(|r| r.split_once(':')).map(|(d, _)| d.to_owned());
        let open = |list: &[Event], v: &str| {
            list.iter()
                .rev()
                .find(|e| (e.kind == "problem" || e.kind == "resolved") && e.detail.as_deref() == Some(v))
                .is_some_and(|e| e.kind == "problem")
        };
        for (k, v) in &current {
            if !has(&self.known, k) && !open(&self.list, v) {
                let mut e = Event::new(now, "problem");
                e.detail = Some(v.clone());
                e.drive = drive_of(k);
                self.add(e);
            }
        }
        for (k, v) in self.known.clone() {
            if !has(&current, &k) && open(&self.list, &v) {
                let mut e = Event::new(now, "resolved");
                e.detail = Some(v.clone());
                e.drive = drive_of(&k);
                self.add(e);
            }
        }
        self.known = current;
        let mut notices = Vec::new();
        if !started.is_empty() {
            notices.push(Notice {
                title: "Server problem".into(),
                message: started.join("\n"),
                tags: "warning",
                click: None,
            });
        }
        if !cleared.is_empty() {
            let message = cleared.iter().map(|m| format!("Resolved: {m}")).collect::<Vec<_>>().join("\n");
            notices.push(Notice {
                title: "Server back to normal".into(),
                message,
                tags: "white_check_mark",
                click: None,
            });
        }
        notices
    }

    /// Since when the journal is still to be looked through for memory kills; moves it to now.
    pub fn journal_window(&mut self, now: i64) -> i64 {
        std::mem::replace(&mut self.journal_checked_at, now)
    }

    /// Memory kills in the journal output since `since`, logged unless already known.
    pub fn note_memory_kills(&mut self, journal: &str, since: i64, pods: &[Pod]) -> Vec<Notice> {
        static KERNEL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"task_memcg=([^,\s]+),task=([^,\s]+)").unwrap());
        static OOMD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^Killed (\S+) due to memory (\w+)").unwrap());
        let mut notices = Vec::new();
        for line in journal.lines().filter(|l| !l.is_empty()) {
            let Ok(entry) = serde_json::from_str::<Value>(line) else { continue };
            let t = entry["__REALTIME_TIMESTAMP"]
                .as_str()
                .and_then(|s| s.parse::<f64>().ok())
                .map_or(0, |us| (us / 1000.0).round() as i64);
            if t < since || self.list.iter().any(|e| e.kind == "oom" && e.t == t) {
                continue;
            }
            let message = entry["MESSAGE"].as_str().unwrap_or_default();
            let kernel = KERNEL.captures(message);
            let oomd = OOMD.captures(message);
            let (cgroup, detail) = match (&kernel, &oomd) {
                (Some(k), _) => (k[1].to_owned(), format!("Ran out of memory; the kernel killed {}", &k[2])),
                (None, Some(o)) => (o[1].to_owned(), "Killed by systemd-oomd under memory pressure".to_owned()),
                (None, None) => continue,
            };
            let (id, name) = service_of_cgroup(&cgroup, pods);
            let mut e = Event::new(t, "oom");
            e.id = id.clone();
            e.name = Some(name.clone());
            e.detail = Some(detail.clone());
            self.add(e);
            if t < self.started_at - 5 * 60_000 {
                continue;
            }
            notices.push(Notice {
                title: format!("{name} was killed for memory"),
                message: detail,
                tags: "skull",
                click: id.as_deref().map(service_link),
            });
        }
        notices
    }
}

/// When each boot the journal remembers started. The boot time worked out from the uptime moves by
/// a second or so between starts, and the journal's first entry comes a little after it, so they're
/// matched within minutes.
pub async fn journal_boots() -> Vec<i64> {
    let listed = command::run(
        "journalctl",
        &args!["--list-boots", "-o", "json", "--no-pager"],
        Duration::from_secs(30),
    )
    .await;
    listed
        .ok()
        .and_then(|out| serde_json::from_str::<Vec<Value>>(&out).ok())
        .unwrap_or_default()
        .iter()
        .filter_map(|b| b["first_entry"].as_f64().map(|us| (us / 1000.0).round() as i64))
        .collect()
}

/// The service a cgroup path belongs to, or a readable name for it.
fn service_of_cgroup(cgroup: &str, pods: &[Pod]) -> (Option<String>, String) {
    let mut units: HashMap<String, (String, String)> = HashMap::new();
    for p in pods {
        let Some(name) = p.names.as_ref().and_then(|n| n.first()) else {
            continue;
        };
        let found = (format!("container:{name}"), name.clone());
        if let Some(unit) = p.systemd_unit().filter(|u| !u.is_empty()) {
            units.insert(unit.to_owned(), found.clone());
        }
        units.insert(format!("libpod-{}.scope", p.id), found);
    }
    for u in UNITS {
        units.insert(u.runs.unwrap_or(u.unit).to_owned(), (format!("unit:{}", u.id), u.name.to_owned()));
    }
    let parts: Vec<&str> = cgroup.split('/').filter(|p| !p.is_empty()).collect();
    if let Some((id, name)) = parts.iter().rev().find_map(|p| units.get(*p)) {
        return (Some(id.clone()), name.clone());
    }
    // The outermost unit, so a terminal's tab counts as the terminal.
    let unit = parts
        .iter()
        .find(|p| (p.ends_with(".service") || p.ends_with(".scope")) && !p.starts_with("user@"));
    (None, unit.map_or_else(|| cgroup.to_owned(), |u| group_label(u)))
}

/// journalctl output with the memory kills since `since`.
pub async fn read_memory_kills(since: i64) -> String {
    let a = args![
        "-o",
        "json",
        "--no-pager",
        "-q",
        "--since",
        format!("@{}", since / 1000),
        "-g",
        OOM_PATTERN,
        "_TRANSPORT=kernel",
        "+",
        "_SYSTEMD_UNIT=systemd-oomd.service"
    ];
    // Exits with 1 when nothing matches.
    match command::output("journalctl", &a, Duration::from_secs(30)).await {
        Ok(out) => out.stdout,
        Err(e) => {
            eprintln!("Checking the journal failed: {e}");
            String::new()
        }
    }
}

/// What's wrong now, keyed so the same problem is known again next time.
pub fn problems(status: &Value, drives: &[crate::drives::Drive]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut set = |k: String, v: String| match out.iter_mut().find(|(key, _)| *key == k) {
        Some((_, was)) => *was = v,
        None => out.push((k, v)),
    };
    let round = |x: f64| (x + 0.5).floor();
    for d in status["disks"].as_array().into_iter().flatten() {
        let used = d["usedBytes"].as_f64().unwrap_or(0.0) / d["totalBytes"].as_f64().unwrap_or(f64::INFINITY);
        let mount = d["mount"].as_str().unwrap_or_default();
        if used >= DISK_WARN {
            set(format!("disk:{mount}"), format!("{mount} is {}% full", round(used * 100.0)));
        }
    }
    for t in status["temperatures"].as_array().into_iter().flatten() {
        let (label, celsius) = (t["label"].as_str().unwrap_or_default(), t["celsius"].as_f64().unwrap_or(0.0));
        if celsius >= TEMP_WARN {
            set(format!("temp:{label}"), format!("{label} is at {}°C", round(celsius)));
        }
    }
    for s in status["services"].as_array().into_iter().flatten() {
        let (id, name) = (s["id"].as_str().unwrap_or_default(), s["name"].as_str().unwrap_or_default());
        if s["state"] == "failed" {
            let detail = s["detail"]
                .as_str()
                .filter(|d| !d.is_empty())
                .map(|d| format!(" ({d})"))
                .unwrap_or_default();
            set(format!("svc:{id}"), format!("{name} has failed{detail}"));
        }
        if s["health"] == "unhealthy" {
            set(format!("health:{id}"), format!("{name} is unhealthy"));
        }
    }
    for d in drives {
        for issue in &d.issues {
            // The temperature is in the text, so key hot drives on the fact rather than the reading.
            let key = if issue.starts_with("Running hot") { "hot" } else { issue };
            set(format!("drive:{}:{key}", d.id), format!("{}: {issue}", d.model));
        }
    }
    out
}

/// Sends a notification through ntfy; the app can't get push notifications any other way.
pub async fn notify(upstream: &crate::client::Upstream, n: Notice) {
    let url = std::env::var("NTFY_URL").unwrap_or_else(|_| "http://localhost:2586/Homebase".into());
    let mut req = axum::http::Request::post(url)
        .header(
            "Title",
            axum::http::HeaderValue::from_bytes(n.title.as_bytes()).unwrap_or(axum::http::HeaderValue::from_static("Homebase")),
        )
        .header("Tags", n.tags)
        .header("Click", n.click.unwrap_or_else(|| "homebase://server".into()));
    req = req.header("Content-Type", "text/plain; charset=utf-8");
    let Ok(req) = req.body(axum::body::Body::from(n.message)) else {
        return;
    };
    match upstream.0.request(req).await {
        Ok(res) if res.status().is_success() => {}
        Ok(res) => eprintln!("Couldn't send ntfy notification: HTTP {}", res.status()),
        Err(e) => eprintln!("Couldn't send ntfy notification: {e}"),
    }
}

/// Crashes, restarts and memory kills per service, running time, and the events, over the range.
pub fn reliability(events: &Events, history: &crate::history::History, names: &[(String, String)], range_sec: f64, end: i64) -> Value {
    let start = end - (range_sec * 1000.0) as i64;
    let in_range: Vec<&Event> = events.list.iter().filter(|e| e.t >= start).collect();
    let entries = history.entries(start, end);
    let readings = crate::history::reading_count(&entries);
    let running = history.totals(&entries, |k| crate::history::between(k, "s:", ":mem"));

    #[derive(Default)]
    struct Row {
        name: String,
        crashes: u64,
        failures: u64,
        oom_kills: u64,
        restarts: u64,
        stops: u64,
    }
    // In the order first seen: the services as of the last reading, then any only in the events.
    let mut rows: Vec<(String, Row)> = Vec::new();
    fn row<'a>(rows: &'a mut Vec<(String, Row)>, names: &[(String, String)], id: &str, name: Option<&str>) -> &'a mut Row {
        let i = match rows.iter().position(|(i, _)| i == id) {
            Some(i) => i,
            None => {
                let known = names.iter().find(|(i, _)| i == id).map(|(_, n)| n.as_str());
                let name = known.or(name).unwrap_or(id).to_owned();
                rows.push((
                    id.to_owned(),
                    Row {
                        name,
                        ..Default::default()
                    },
                ));
                rows.len() - 1
            }
        };
        &mut rows[i].1
    }
    for (id, name) in names {
        row(&mut rows, names, id, Some(name));
    }
    for e in &in_range {
        let Some(id) = &e.id else { continue };
        let r = row(&mut rows, names, id, e.name.as_deref());
        match e.kind.as_str() {
            "crashed" => r.crashes += 1,
            "failed" => r.failures += 1,
            "oom" => r.oom_kills += 1,
            "restarted" => r.restarts += 1,
            "stopped" if e.by.is_none() => r.stops += 1,
            _ => {}
        }
    }
    let mut services = rows;
    services.sort_by(|(_, a), (_, b)| {
        let trouble = |r: &Row| r.crashes + r.failures + r.oom_kills;
        trouble(b)
            .cmp(&trouble(a))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    let services: Vec<Value> = services
        .into_iter()
        .map(|(id, r)| {
            let mut v = json!({
                "id": id, "name": r.name, "crashes": r.crashes, "failures": r.failures,
                "oomKills": r.oom_kills, "restarts": r.restarts, "stops": r.stops,
            });
            if readings != 0.0 {
                // Share of the readings it was running for, of those the server took in the range.
                v["running"] = crate::history::num((running.get(&id).map_or(0.0, |t| t.readings) / readings).min(1.0));
            }
            let trouble = in_range
                .iter()
                .rev()
                .find(|e| e.id.as_deref() == Some(&id) && ["crashed", "failed", "oom"].contains(&e.kind.as_str()));
            if let Some(e) = trouble {
                v["lastTrouble"] = json!(e.t);
            }
            v
        })
        .collect();
    let skip = in_range.len().saturating_sub(300);
    json!({
        "start": start,
        "end": end,
        "oldest": history.oldest(end),
        "boots": in_range.iter().filter(|e| e.kind == "boot").map(|e| e.t).collect::<Vec<_>>(),
        "services": services,
        "events": in_range[skip..].iter().rev().collect::<Vec<_>>(),
        "at": end,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seen(id: &str, state: &str, since: i64, restarts: u64) -> Seen {
        Seen {
            id: id.into(),
            name: id.into(),
            state: state.into(),
            since: Some(since),
            restarts,
            detail: None,
        }
    }

    #[test]
    fn service_changes_become_events_with_their_cause() {
        let dir = std::env::temp_dir().join(format!("events-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut ev = Events::new(&dir, 0);
        let game = json!({ "on": true, "since": 1000, "services": ["container:sonarr"] });
        ev.note_service_changes(
            &[seen("container:sonarr", "running", 1, 0), seen("unit:x", "running", 1, 0)],
            1000,
            &game,
        );
        assert!(ev.list.is_empty(), "the first reading only sets the baseline");

        ev.note_intent("unit:x", 1500);
        let notices = ev.note_service_changes(
            &[seen("container:sonarr", "stopped", 1, 0), seen("unit:x", "running", 2, 0)],
            2000,
            &game,
        );
        assert!(notices.is_empty());
        assert_eq!((ev.list[0].kind.as_str(), ev.list[0].by.as_deref()), ("stopped", Some("game mode")));
        assert_eq!((ev.list[1].kind.as_str(), ev.list[1].by.as_deref()), ("restarted", Some("you")));

        let notices = ev.note_service_changes(&[seen("unit:x", "running", 2, 1)], 3000, &game);
        assert_eq!(ev.list[2].kind, "crashed");
        assert_eq!(notices[0].title, "unit:x crashed");
        assert_eq!(notices[0].click.as_deref(), Some("homebase://server/service/unit%3Ax"));

        let saved = std::fs::read_to_string(dir.join("events.jsonl")).unwrap();
        assert_eq!(
            saved.lines().next().unwrap(),
            r#"{"t":2000,"kind":"stopped","id":"container:sonarr","name":"container:sonarr","by":"game mode"}"#
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn memory_kills_are_put_down_to_their_service() {
        let pods: Vec<Pod> = serde_json::from_value(json!([
            { "Id": "abc", "Names": ["sonarr"], "Labels": { "PODMAN_SYSTEMD_UNIT": "sonarr.service" } }
        ]))
        .unwrap();
        let of = |c: &str| service_of_cgroup(c, &pods);
        assert_eq!(
            of("/user.slice/user-1000.slice/user@1000.service/app.slice/sonarr.service/libpod-payload-abc"),
            (Some("container:sonarr".into()), "sonarr".into())
        );
        assert_eq!(
            of("/user.slice/user-1000.slice/user@1000.service/app.slice/app-org.kde.konsole-12.scope/tab"),
            (None, "konsole".into())
        );
    }
}

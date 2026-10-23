//! Starting, stopping and restarting what the dashboard lists (`POST /api/services/{id}/{action}`)
//! and reading what it wrote (`GET /api/services/{id}/logs`).

use std::net::SocketAddr;
use std::sync::LazyLock;
use std::time::Duration;

use axum::Json;
use axum::extract::{ConnectInfo, Path, Query, State as AxumState};
use axum::http::StatusCode;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::args;
use crate::command::{self, run};
use crate::http::{HttpError, State};
use crate::services::quadlets;
use crate::usage::{UNITS, now_ms};

/// Starting or stopping a container can take a while; systemd waits up to 90 s for one to stop.
const ACTION_TIMEOUT: Duration = Duration::from_secs(120);
const QUICK: Duration = Duration::from_secs(30);

fn bad_request(message: String) -> HttpError {
    HttpError(StatusCode::BAD_REQUEST, message)
}

fn not_found(message: String) -> HttpError {
    HttpError(StatusCode::NOT_FOUND, message)
}

/// "container:sonarr" → ("container", "sonarr").
fn split_id(id: &str) -> (&str, &str) {
    id.split_once(':').unwrap_or(("", id))
}

pub async fn handler(
    AxumState(state): AxumState<State>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path((id, action)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, HttpError> {
    if !["start", "stop", "restart", "run"].contains(&action.as_str()) {
        return Err(not_found("Not found".into()));
    }
    println!("{} {action} {id}", peer.ip().to_canonical());
    // So the events log can put what follows down to you.
    state.recorder.events.lock().unwrap().note_intent(&id, now_ms());
    let result = change(&state, &id, &action).await;
    state.services.expire(&state.usage);
    result?;
    Ok(Json(json!({ "ok": true })))
}

async fn change(state: &State, id: &str, action: &str) -> Result<(), HttpError> {
    let (kind, name) = split_id(id);
    if kind == "container" {
        if !["start", "stop", "restart"].contains(&action) {
            return Err(bad_request(format!("Can't {action} a container")));
        }
        let pods = state.usage.pods.get_fresh().await.map_err(HttpError::internal)?;
        let Some(pod) = pods.iter().find(|p| p.names.as_ref().is_some_and(|n| n.iter().any(|x| x == name))) else {
            // A stopped Quadlet container no longer exists; its unit creates it again.
            let q = quadlets().await.into_iter().find(|q| q.name == name);
            let q = q.ok_or_else(|| not_found(format!("No container named {name}")))?;
            let verb = if action == "stop" { "stop" } else { "start" };
            run("systemctl", &args!["--user", verb, q.unit], ACTION_TIMEOUT)
                .await
                .map_err(HttpError::internal)?;
            return Ok(());
        };
        // Quadlet containers go through systemd, which would otherwise restart or fight a direct
        // podman command.
        let result = match pod.systemd_unit().filter(|u| !u.is_empty()) {
            Some(unit) => run("systemctl", &args!["--user", action, unit], ACTION_TIMEOUT).await,
            None if action == "stop" => run("podman", &args!["stop", name], ACTION_TIMEOUT).await,
            None => start_container_unit(name, action == "restart").await,
        };
        result.map_err(HttpError::internal)?;
        return Ok(());
    }

    let u = UNITS.iter().find(|u| u.id == name).filter(|_| kind == "unit");
    let u = u.ok_or_else(|| not_found(format!("No service {id}")))?;
    if u.system {
        return Err(HttpError(StatusCode::FORBIDDEN, format!("{} is read-only", u.name)));
    }
    if let Some(runs) = u.runs {
        if action != "run" {
            return Err(bad_request(format!("Can't {action} a timer")));
        }
        run("systemctl", &args!["--user", "start", "--no-block", runs], QUICK)
            .await
            .map_err(HttpError::internal)?;
        return Ok(());
    }
    if !["start", "stop", "restart"].contains(&action) {
        return Err(bad_request(format!("Can't {action} a service")));
    }
    if u.this_server {
        if action != "restart" {
            return Err(bad_request("The status server can only be restarted".into()));
        }
        // After answering, since this server goes down with it. --no-block, as systemd stops the
        // systemctl call itself along with this server.
        tokio::spawn(async {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let restart = args!["--user", "restart", "--no-block", "homebase-status.service"];
            if let Err(e) = run("systemctl", &restart, QUICK).await {
                eprintln!("Restarting the status server failed: {e}");
            }
        });
        return Ok(());
    }
    run("systemctl", &args!["--user", action, u.unit], ACTION_TIMEOUT)
        .await
        .map_err(HttpError::internal)?;
    Ok(())
}

/// Starts a container that isn't a Quadlet in a transient systemd unit of its own. Started
/// directly, it would land in this service's cgroup, inherit its sandbox, and be killed whenever
/// this server restarts. `podman start --attach` stays in the foreground, so the unit lives as
/// long as the container and its output goes to the journal.
async fn start_container_unit(name: &str, restart: bool) -> Result<String, String> {
    let unit = format!("container-{name}.service");
    if restart {
        run("podman", &args!["stop", name], ACTION_TIMEOUT).await?;
        // The unit ends once `podman start --attach` notices; wait so the name is free again.
        for _ in 0..50 {
            let state = command::output("systemctl", &args!["--user", "is-active", &unit], QUICK).await?;
            if !matches!(state.stdout.trim(), "active" | "deactivating") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    let _ = run("systemctl", &args!["--user", "reset-failed", &unit], QUICK).await;
    run(
        "systemd-run",
        &args![
            "--user",
            "--collect",
            format!("--unit={unit}"),
            format!("--description=Podman container {name}"),
            "podman",
            "start",
            "--attach",
            name
        ],
        QUICK,
    )
    .await
}

// ---------------------------------------------------------------------------------------------
// Logs

const LOG_LINES: u32 = 300;
const AFTER_CURSOR_LINES: u32 = 2000;
const LOG_ERRORS: &str = "error|fatal|exception|fail|warn|crit|panic|traceback|denied";
// Sonarr and Prowlarr put API keys in the URLs they log.
static SECRET_IN_LOG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)((?:api[_-]?key|token|password|passkey|secret)["']?\s*[=:]\s*["']?)[^\s&"',;]+"#).unwrap());
static BEARER_IN_LOG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(Bearer\s+)[A-Za-z0-9_.~+/=-]+").unwrap());
static ANSI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\[[0-9;?]*[A-Za-z]").unwrap());

/// journalctl arguments that pick out one dashboard service's journal.
async fn log_source(state: &State, id: &str) -> Result<Vec<String>, HttpError> {
    let (kind, name) = split_id(id);
    if kind == "container" {
        let pods = state.usage.pods.get().await.unwrap_or_default();
        let pod = pods.iter().find(|p| p.names.as_ref().is_some_and(|n| n.iter().any(|x| x == name)));
        let unit = match pod.and_then(|p| p.systemd_unit()) {
            Some(u) => Some(u.to_owned()),
            None => quadlets().await.into_iter().find(|q| q.name == name).map(|q| q.unit),
        };
        return match (unit, pod) {
            (Some(unit), _) => Ok(args!["--user", "-u", unit].to_vec()),
            (None, Some(_)) => Ok(args!["--user", format!("CONTAINER_NAME={name}")].to_vec()),
            (None, None) => Err(not_found(format!("No container named {name}"))),
        };
    }
    let u = UNITS.iter().find(|u| u.id == name).filter(|_| kind == "unit");
    let u = u.ok_or_else(|| not_found(format!("No service {id}")))?;
    let mut args = if u.system { vec![] } else { args!["--user"].to_vec() };
    args.extend(args!["-u", u.runs.unwrap_or(u.unit)]);
    Ok(args)
}

#[derive(Deserialize)]
pub struct LogQuery {
    after: Option<String>,
    errors: Option<String>,
}

#[derive(Serialize)]
pub struct LogLine {
    pub at: i64,
    priority: i64,
    pub text: String,
}

#[derive(Serialize)]
pub struct Logs {
    pub lines: Vec<LogLine>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cursor: Option<String>,
    at: i64,
}

/// Messages that aren't valid UTF-8 come as arrays of bytes.
fn message_text(message: &serde_json::Value) -> String {
    match message {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(bytes) => {
            String::from_utf8_lossy(&bytes.iter().filter_map(|b| b.as_u64().map(|b| b as u8)).collect::<Vec<_>>()).into_owned()
        }
        serde_json::Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn clean(text: &str) -> String {
    let text = ANSI.replace_all(text, "");
    let text = SECRET_IN_LOG.replace_all(&text, "${1}•••");
    BEARER_IN_LOG.replace_all(&text, "${1}•••").trim_end().to_owned()
}

/// The last lines a service wrote, or with `after` (the cursor from an earlier call) only what
/// came since. `errors=1` keeps lines that mention an error, failure or warning.
pub async fn logs(
    AxumState(state): AxumState<State>,
    Path(id): Path<String>,
    Query(query): Query<LogQuery>,
) -> Result<Json<Logs>, HttpError> {
    let after = query.after.filter(|a| !a.is_empty());
    if after
        .as_ref()
        .is_some_and(|a| !a.bytes().all(|b| b.is_ascii_alphanumeric() || b"_=;-".contains(&b)))
    {
        return Err(bad_request("Bad cursor".into()));
    }
    let window = LogWindow {
        after,
        errors: query.errors.as_deref() == Some("1"),
        since: None,
        until: None,
        lines: LOG_LINES,
    };
    Ok(Json(read_logs(&state, &id, window).await?))
}

/// Which of a service's log lines to read.
pub struct LogWindow {
    /// The cursor from an earlier read: only what came since.
    pub after: Option<String>,
    /// Only lines that mention an error, failure or warning.
    pub errors: bool,
    pub since: Option<i64>,
    pub until: Option<i64>,
    pub lines: u32,
}

/// The last lines a service wrote within the window, cleaned of colors and secrets.
pub async fn read_logs(state: &State, id: &str, window: LogWindow) -> Result<Logs, HttpError> {
    let LogWindow {
        after,
        errors,
        since,
        until,
        lines: count,
    } = window;
    let mut args = log_source(state, id).await?;
    args.extend(args![
        "--no-pager",
        "-o",
        "json",
        "--output-fields=MESSAGE,PRIORITY"
    ]);
    // After a cursor, -n keeps only the last lines of what came since, so it's set well above
    // what a poll a few seconds later can bring, yet still bounded for a cursor from long ago.
    match &after {
        Some(after) => args.extend(args![format!("--after-cursor={after}"), "-n", AFTER_CURSOR_LINES.to_string()]),
        None => args.extend(args!["-n", count.to_string()]),
    }
    if let Some(since) = since {
        args.push(format!("--since=@{}", since.div_euclid(1000)));
    }
    if let Some(until) = until {
        args.push(format!("--until=@{}", (until + 999).div_euclid(1000)));
    }
    if errors {
        args.extend(args![format!("--grep={LOG_ERRORS}"), "--case-sensitive=false"]);
    }
    let out = command::output("journalctl", &args, Duration::from_secs(15))
        .await
        .map_err(HttpError::internal)?;
    // journalctl exits 1 when --grep matches nothing.
    if !out.success && !(out.code == Some(1) && out.stderr.is_empty()) {
        return Err(HttpError::internal(if out.stderr.is_empty() {
            "journalctl failed".into()
        } else {
            out.stderr
        }));
    }

    let mut lines = Vec::new();
    let mut cursor = after;
    for row in out.stdout.lines().filter(|r| !r.is_empty()) {
        let entry: serde_json::Value = serde_json::from_str(row).map_err(|e| HttpError::internal(e.to_string()))?;
        if let Some(c) = entry["__CURSOR"].as_str() {
            cursor = Some(c.to_owned());
        }
        let text = clean(&message_text(&entry["MESSAGE"]));
        if text.is_empty() {
            continue;
        }
        let number = |v: &serde_json::Value| v.as_str().and_then(|s| s.parse::<f64>().ok()).or_else(|| v.as_f64());
        lines.push(LogLine {
            at: (number(&entry["__REALTIME_TIMESTAMP"]).unwrap_or(0.0) / 1000.0).round() as i64,
            priority: number(&entry["PRIORITY"]).map_or(6, |p| p as i64),
            text,
        });
    }
    Ok(Logs {
        lines,
        cursor,
        at: now_ms(),
    })
}

#[cfg(test)]
mod tests {
    use super::clean;

    #[test]
    fn secrets_and_colors_are_taken_out() {
        assert_eq!(clean("GET /api?apikey=abc123&x=1"), "GET /api?apikey=•••&x=1");
        assert_eq!(clean(r#"{"api_key": "s3cret", "n": 1}"#), r#"{"api_key": "•••", "n": 1}"#);
        assert_eq!(clean("Authorization: Bearer eyJ.abc-_x="), "Authorization: Bearer •••");
        assert_eq!(clean("\x1b[32mINFO\x1b[0m started  "), "INFO started");
        assert_eq!(clean("Password: hunter2, next"), "Password: •••, next");
    }
}

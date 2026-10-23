//! Media: the Requests mini-app talks to Sonarr and Radarr through here, so their API keys stay
//! on this machine. Keys are read from each app's own config on every call, so a rotated key just
//! works. Only the calls the app makes are let through. Search and requests are requests.rs.
//! qBittorrent's speed limit and seeding have a small client of their own, since it logs in
//! rather than taking a key.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Request, State as AxumState};
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use regex::Regex;
use serde_json::{Value, json};

use crate::client::{Reply, call, form};
use crate::http::{HttpError, State};
use crate::machine::json_body;

/// A release search asks every indexer, some through FlareSolverr, so it can take a while.
const ARR_TIMEOUT: Duration = Duration::from_secs(180);
const MAX_BODY: usize = 64 * 1024;

fn arr_dir() -> PathBuf {
    std::env::var("ARR_DIR").map_or_else(
        |_| PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".local/share/arr"),
        PathBuf::from,
    )
}

/// A value from the shared credentials file, as `key=value` lines.
pub fn credential(key: &str) -> Option<String> {
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
// Sonarr and Radarr

struct App {
    label: &'static str,
    base: &'static str,
    routes: &'static [(&'static str, &'static str)],
}

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
    for (name, app) in [("sonarr", &SONARR), ("radarr", &RADARR)] {
        for (method, pattern) in app.routes {
            m.insert((name, *method), Regex::new(pattern).unwrap());
        }
    }
    m
});

fn app(name: &str) -> Option<(&'static str, &'static App)> {
    match name {
        "sonarr" => Some(("sonarr", &SONARR)),
        "radarr" => Some(("radarr", &RADARR)),
        _ => None,
    }
}

fn api_key(name: &str) -> Option<String> {
    let dir = arr_dir().join(name);
    let xml = std::fs::read_to_string(dir.join("config.xml")).ok()?;
    let start = xml.find("<ApiKey>")? + "<ApiKey>".len();
    let end = start + xml[start..].find('<')?;
    Some(xml[start..end].to_owned()).filter(|k| !k.is_empty())
}

pub struct Media {
    qbit_cookie: Mutex<Option<String>>,
}

impl Media {
    pub fn new() -> Self {
        Self {
            qbit_cookie: Mutex::new(None),
        }
    }
}

/// Why Sonarr or Radarr said no: the reason in `message`, or a list of validation failures.
fn failure(name: &str, reply: &Reply) -> String {
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
    message
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| format!("{name} answered {}", reply.status.as_u16()))
}

fn json_reply(body: Bytes) -> Response {
    let mut res = (StatusCode::OK, body).into_response();
    res.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

/// `/api/requests/{path}`: see requests.rs.
pub async fn requests(AxumState(state): AxumState<State>, req: Request) -> Result<Response, HttpError> {
    let (parts, body) = req.into_parts();
    let path = parts.uri.path();
    let path = path.strip_prefix("/api/requests/").unwrap_or_default();
    let body = axum::body::to_bytes(body, MAX_BODY)
        .await
        .map_err(|_| status(413, "Request body too large"))?;
    let query = parts.uri.query().unwrap_or_default();
    let value = crate::requests::handle(&state, &parts.method, path, query, &body).await?;
    Ok(json_reply(Bytes::from(value.to_string())))
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
        return Err(HttpError(reply.status, failure(name, &reply)));
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

pub async fn qbit(state: &State, api_path: &str, form_body: Option<&[(&str, &str)]>) -> Result<Value, HttpError> {
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
// Calls of the server's own, rather than the phone's, so not held to the allow-lists.

/// Sonarr's or Radarr's API, `path` after `/api/v3/`, answering JSON (null when there's no body).
pub async fn arr_call(state: &State, name: &str, method: Method, path: &str, body: Option<Value>) -> Result<Value, String> {
    let (name, app) = app(name).ok_or("No such app")?;
    let key = api_key(name).ok_or_else(|| format!("{} isn't set up on the server", app.label))?;
    let headers = [("X-Api-Key", key), ("Content-Type", "application/json".to_owned())];
    let body = body.map(|b| b.to_string().into());
    let reply = call(&state.upstream, method, &format!("{}/{path}", app.base), &headers, body, Duration::from_secs(60))
        .await
        .map_err(|e| format!("{} didn't answer ({e})", app.label))?;
    if !reply.status.is_success() {
        return Err(failure(app.label, &reply));
    }
    if reply.body.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_slice(&reply.body).map_err(|e| format!("{} answered something that isn't JSON ({e})", app.label))
}

// ---------------------------------------------------------------------------------------------
// After a conversion replaces a file, Sonarr or Radarr rescans its show or movie, so it knows the
// new file rather than looking for the old one.

/// `file` is the path as the app sees it, under /data.
pub async fn rescan(state: &State, name: &str, file: &str) -> Result<(), String> {
    let (name, app) = app(name).ok_or("No such app")?;
    let key = api_key(name).ok_or_else(|| format!("{} isn't set up on the server", app.label))?;
    let (list, command, id_field) = if name == "sonarr" {
        ("series", "RescanSeries", "seriesId")
    } else {
        ("movie", "RescanMovie", "movieId")
    };
    let headers = [("X-Api-Key", key), ("Content-Type", "application/json".to_owned())];
    let reply = call(&state.upstream, Method::GET, &format!("{}/{list}", app.base), &headers, None, Duration::from_secs(30)).await?;
    if !reply.status.is_success() {
        return Err(format!("{} answered {}", app.label, reply.status.as_u16()));
    }
    let items: Value = serde_json::from_slice(&reply.body).map_err(|e| e.to_string())?;
    let id = items
        .as_array()
        .into_iter()
        .flatten()
        .find(|i| {
            i["path"]
                .as_str()
                .is_some_and(|p| file.starts_with(&format!("{}/", p.trim_end_matches('/'))))
        })
        .and_then(|i| i["id"].as_i64())
        .ok_or_else(|| format!("{} doesn't have a folder holding it", app.label))?;
    let body = json!({ "name": command, id_field: id }).to_string();
    let reply = call(&state.upstream, Method::POST, &format!("{}/command", app.base), &headers, Some(body.into()), Duration::from_secs(30)).await?;
    if !reply.status.is_success() {
        return Err(format!("{} answered {}", app.label, reply.status.as_u16()));
    }
    Ok(())
}

/// The TV queue's order, every minute.
pub fn start(state: State) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + Duration::from_secs(60), Duration::from_secs(60));
        loop {
            tick.tick().await;
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

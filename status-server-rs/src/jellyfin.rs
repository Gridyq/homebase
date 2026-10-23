//! Who's watching what on Jellyfin, read from its sessions every 5 seconds: the title, how far
//! along, and whether it plays directly or is transcoded, and why. `GET /api/jellyfin/sessions`
//! and the dashboard show it; conversions hold off while Jellyfin transcodes video, and the app
//! warns before game mode while someone is watching.
//!
//! Uses the server's Jellyfin API key. Jellyfin 12 only takes it in a `MediaBrowser` header.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Json;
use axum::extract::State as AxumState;
use axum::http::Method;
use serde_json::{Map, Value, json};

use crate::http::State;
use crate::usage::now_ms;

pub const JELLYFIN_URL: &str = "http://127.0.0.1:8096";
/// Where the Jellyfin container sees the media drive.
pub const MEDIA_IN_CONTAINER: &str = "/media/drive";
const POLL_EVERY: Duration = Duration::from_secs(5);
/// Jellyfin counts time in ticks of 100 ns.
const TICKS_PER_MS: f64 = 10_000.0;

/// The server's admin-level API key for Jellyfin, from the shared credentials file.
pub fn api_key() -> Option<String> {
    crate::media::credential("jellyfin_api_key")
}

#[derive(Default)]
pub struct Jellyfin {
    /// The sessions playing something, as the app gets them, and what went wrong reading them.
    sessions: Mutex<(Arc<Vec<Value>>, Option<String>)>,
}

impl Jellyfin {
    pub fn sessions(&self) -> Arc<Vec<Value>> {
        Arc::clone(&self.sessions.lock().unwrap().0)
    }

    /// Who Jellyfin is transcoding video for right now, which keeps the GPU busy.
    pub fn transcoding_for(&self) -> Option<String> {
        self.sessions()
            .iter()
            .find(|s| s["paused"] == false && s["transcode"]["video"] == true)
            .map(|s| s["user"].as_str().unwrap_or("someone").to_owned())
    }

    /// (streams, of which transcoding) for the history.
    pub fn counts(&self) -> (f64, f64) {
        let s = self.sessions();
        let playing = s.iter().filter(|s| s["paused"] == false);
        let transcoding = s.iter().filter(|s| s["paused"] == false && s["method"] == "transcode");
        (playing.count() as f64, transcoding.count() as f64)
    }
}

fn ms(ticks: &Value) -> Option<f64> {
    ticks.as_f64().map(|t| (t / TICKS_PER_MS).round())
}

/// One of Jellyfin's sessions as the app shows it, or none if it isn't playing anything.
pub fn session(s: &Value) -> Option<Value> {
    let item = s.get("NowPlayingItem").filter(|i| i.is_object())?;
    let play = &s["PlayState"];
    let mut out = Map::new();
    let text = |v: &Value| v.as_str().filter(|t| !t.is_empty()).map(str::to_owned);
    out.insert("id".into(), json!(s["Id"]));
    out.insert("itemId".into(), json!(item["Id"]));
    out.insert("user".into(), json!(text(&s["UserName"]).unwrap_or_else(|| "Someone".into())));
    for (from, to) in [("Client", "client"), ("DeviceName", "device")] {
        if let Some(v) = text(&s[from]) {
            out.insert(to.into(), json!(v));
        }
    }
    out.insert("title".into(), json!(text(&item["Name"]).unwrap_or_default()));
    out.insert("kind".into(), json!(text(&item["Type"]).unwrap_or_default()));
    if let Some(show) = text(&item["SeriesName"]) {
        out.insert("show".into(), json!(show));
        if let (Some(season), Some(episode)) = (item["ParentIndexNumber"].as_u64(), item["IndexNumber"].as_u64()) {
            out.insert("episode".into(), json!(format!("S{season}E{episode}")));
        }
    }
    if let Some(year) = item["ProductionYear"].as_u64() {
        out.insert("year".into(), json!(year));
    }
    out.insert("paused".into(), json!(play["IsPaused"].as_bool().unwrap_or(false)));
    if let Some(p) = ms(&play["PositionTicks"]) {
        out.insert("positionMs".into(), json!(p));
    }
    if let Some(r) = ms(&item["RunTimeTicks"]) {
        out.insert("runtimeMs".into(), json!(r));
    }
    let method = match play["PlayMethod"].as_str() {
        Some("Transcode") => "transcode",
        Some("DirectStream") => "stream",
        _ => "direct",
    };
    out.insert("method".into(), json!(method));
    let t = &s["TranscodingInfo"];
    if method == "transcode" && t.is_object() {
        let mut tc = Map::new();
        tc.insert("video".into(), json!(t["IsVideoDirect"] == false));
        tc.insert("audio".into(), json!(t["IsAudioDirect"] == false));
        for (from, to) in [
            ("VideoCodec", "videoCodec"),
            ("AudioCodec", "audioCodec"),
            ("Container", "container"),
            ("HardwareAccelerationType", "hardware"),
        ] {
            if let Some(v) = text(&t[from]) {
                tc.insert(to.into(), json!(v));
            }
        }
        for (from, to) in [("Bitrate", "bitrate"), ("Framerate", "fps"), ("CompletionPercentage", "progress")] {
            if let Some(v) = t[from].as_f64() {
                tc.insert(to.into(), json!(v));
            }
        }
        let reasons: Vec<String> = t["TranscodeReasons"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(reason)
            .collect();
        tc.insert("reasons".into(), json!(reasons));
        out.insert("transcode".into(), Value::Object(tc));
    }
    Some(Value::Object(out))
}

/// "VideoCodecNotSupported" → "video codec not supported".
fn reason(r: &str) -> String {
    let mut out = String::new();
    for (i, c) in r.chars().enumerate() {
        if c.is_uppercase() && i > 0 {
            out.push(' ');
        }
        out.extend(c.to_lowercase());
    }
    out
}

async fn read(state: &State) -> Result<Vec<Value>, String> {
    let key = api_key().ok_or("No jellyfin_api_key in the credentials file")?;
    let reply = crate::client::call(
        &state.upstream,
        Method::GET,
        &format!("{JELLYFIN_URL}/Sessions?activeWithinSeconds=120"),
        &[("Authorization", format!("MediaBrowser Token=\"{key}\""))],
        None,
        Duration::from_secs(5),
    )
    .await?;
    if !reply.status.is_success() {
        return Err(format!("Jellyfin answered {}", reply.status.as_u16()));
    }
    let list: Value = serde_json::from_slice(&reply.body).map_err(|e| e.to_string())?;
    Ok(list.as_array().into_iter().flatten().filter_map(session).collect())
}

/// The files being played now, as the container sees them.
pub async fn playing_paths(state: &State) -> Result<Vec<String>, String> {
    let ids: Vec<String> = state
        .jellyfin
        .sessions()
        .iter()
        .filter_map(|s| s["itemId"].as_str().map(str::to_owned))
        .collect();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let key = api_key().ok_or("No jellyfin_api_key in the credentials file")?;
    let reply = crate::client::call(
        &state.upstream,
        Method::GET,
        &format!("{JELLYFIN_URL}/Items?ids={}&fields=Path", ids.join(",")),
        &[("Authorization", format!("MediaBrowser Token=\"{key}\""))],
        None,
        Duration::from_secs(5),
    )
    .await?;
    if !reply.status.is_success() {
        return Err(format!("Jellyfin answered {}", reply.status.as_u16()));
    }
    let list: Value = serde_json::from_slice(&reply.body).map_err(|e| e.to_string())?;
    Ok(list["Items"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|i| i["Path"].as_str().map(str::to_owned))
        .collect())
}

fn report(state: &State) -> Value {
    let (sessions, error) = state.jellyfin.sessions.lock().unwrap().clone();
    let mut out = json!({ "sessions": *sessions, "at": now_ms() });
    if let Some(e) = error {
        out["error"] = json!(e);
    }
    out
}

pub fn start(state: State) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(POLL_EVERY);
        loop {
            tick.tick().await;
            let read = read(&state).await;
            let changed = {
                let mut current = state.jellyfin.sessions.lock().unwrap();
                let next = match read {
                    Ok(list) => (Arc::new(list), None),
                    // Jellyfin restarting or stopped: nobody's watching anything.
                    Err(e) => (Arc::new(Vec::new()), Some(e)),
                };
                let changed = *current.0 != *next.0 || current.1 != next.1;
                *current = next;
                changed
            };
            // Positions move while anything plays, so this is every poll then and seldom otherwise.
            if changed || state.live.sessions.borrow().is_none() {
                state.live.status_changed.notify_one();
                crate::live::publish(&state.live.sessions, report(&state).to_string());
            }
        }
    });
}

pub async fn handler(AxumState(state): AxumState<State>) -> Json<Value> {
    Json(report(&state))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sessions_as_the_app_gets_them() {
        let s = json!({
            "Id": "abc", "UserName": "guest", "Client": "Jellyfin Roku", "DeviceName": "Living room",
            "NowPlayingItem": {
                "Name": "Pilot", "SeriesName": "Show", "ParentIndexNumber": 1, "IndexNumber": 2,
                "Type": "Episode", "RunTimeTicks": 26_000_000_000i64
            },
            "PlayState": { "PositionTicks": 6_000_000_000i64, "IsPaused": false, "PlayMethod": "Transcode" },
            "TranscodingInfo": {
                "IsVideoDirect": false, "IsAudioDirect": true, "VideoCodec": "h264", "Bitrate": 8_000_000,
                "HardwareAccelerationType": "vaapi", "TranscodeReasons": ["VideoCodecNotSupported"]
            }
        });
        let v = session(&s).unwrap();
        assert_eq!(v["episode"], "S1E2");
        assert_eq!(v["positionMs"], json!(600_000.0));
        assert_eq!(v["method"], "transcode");
        assert_eq!(v["transcode"]["video"], true);
        assert_eq!(v["transcode"]["reasons"], json!(["video codec not supported"]));
        assert!(session(&json!({ "Id": "idle", "UserName": "x" })).is_none());
    }
}

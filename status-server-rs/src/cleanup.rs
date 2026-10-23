//! Cleanup: clears downloads that won't finish out of Sonarr's and Radarr's queues and searches
//! again, and keeps qBittorrent from downloading files that look like malware. Took over from
//! Cleanuparr on 2026-10-23 and does what it was set up to do:
//!
//! - Every 5 minutes each download in the queues can earn a strike: stalled (public torrents only;
//!   any progress since the last strike starts the count over), stuck fetching its metadata, or
//!   finished but not importing. 6, 6 and 3 strikes remove it from qBittorrent, block the release
//!   and search for another. Strikes lapse after a day without a new one.
//! - Every 30 seconds the files of new TV and movie torrents are checked against Cleanuparr's
//!   blocklist; matching files aren't downloaded, and a torrent with nothing left is removed and
//!   searched again like the rest.
//!
//! Strikes and what was removed are kept in `cleanup.json`, the blocklist in `blocklist.txt`.
//! `CLEANUP_DRY_RUN=1` only says what it would do.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use axum::Json;
use axum::extract::State as AxumState;
use axum::http::Method;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::args;
use crate::command::output;
use crate::http::State;
use crate::media::{arr_call, qbit};
use crate::usage::now_ms;

const QUEUE_EVERY: Duration = Duration::from_secs(5 * 60);
const FILES_EVERY: Duration = Duration::from_secs(30);
const STALLED_STRIKES: u32 = 6;
const METADATA_STRIKES: u32 = 6;
const FAILED_IMPORT_STRIKES: u32 = 3;
const STRIKES_LAPSE_MS: i64 = 24 * 3600 * 1000;
const BLOCKLIST_URL: &str = "https://cleanuparr.pages.dev/static/blacklist";
const BLOCKLIST_EVERY_MS: i64 = 6 * 3600 * 1000;
const REMOVED_KEPT: usize = 100;
/// How long the queue check can fail before it's reported, so a restart of an app doesn't count.
const FAILING_REPORTED_MS: i64 = 15 * 60 * 1000;
/// qBittorrent's categories for each app's downloads.
const APPS: &[(&str, &str)] = &[("sonarr", "tv"), ("radarr", "movies")];
const METADATA_STATES: &[&str] = &["metaDL", "forcedMetaDL"];
/// Sonarr's and Radarr's states for a finished download they couldn't import.
const IMPORT_STUCK_STATES: &[&str] = &["importPending", "importBlocked", "importFailed", "failedPending"];

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct Strikes {
    title: String,
    stalled: u32,
    metadata: u32,
    failed_import: u32,
    /// Bytes downloaded at the last stalled strike, to notice progress.
    downloaded: u64,
    last_strike: i64,
}

#[derive(Serialize, Deserialize, Clone)]
struct Removed {
    at: i64,
    app: String,
    title: String,
    reason: String,
}

#[derive(Serialize, Deserialize, Default)]
struct Saved {
    /// By torrent hash, lowercase.
    strikes: BTreeMap<String, Strikes>,
    removed: Vec<Removed>,
}

pub struct Cleanup {
    path: PathBuf,
    blocklist_path: PathBuf,
    saved: Mutex<Saved>,
    blocklist: Mutex<Vec<String>>,
    blocklist_fetched: Mutex<i64>,
    /// Torrents whose files have been checked since the server started.
    checked: Mutex<HashSet<String>>,
    /// Since when the queue check has failed, and why.
    failing: Mutex<Option<(i64, String)>>,
    dry_run: bool,
}

impl Cleanup {
    pub fn new(dir: &Path) -> Self {
        let path = dir.join("cleanup.json");
        let saved = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        let blocklist_path = dir.join("blocklist.txt");
        let blocklist = std::fs::read_to_string(&blocklist_path).map(|t| patterns(&t)).unwrap_or_default();
        Self {
            path,
            blocklist_path,
            saved: Mutex::new(saved),
            blocklist: Mutex::new(blocklist),
            blocklist_fetched: Mutex::new(0),
            checked: Mutex::default(),
            failing: Mutex::default(),
            dry_run: std::env::var("CLEANUP_DRY_RUN").is_ok_and(|v| v == "1"),
        }
    }

    fn save(&self, saved: &Saved) {
        let result = serde_json::to_vec(saved)
            .map_err(std::io::Error::other)
            .and_then(|bytes| crate::files::write_private(&self.path, &bytes));
        if let Err(e) = result {
            eprintln!("Couldn't save cleanup: {e}");
        }
    }

    /// Notes how the queue check went: `None` when it worked.
    fn went(&self, trouble: Option<String>) {
        let mut failing = self.failing.lock().unwrap();
        match (trouble, failing.as_mut()) {
            (None, _) => *failing = None,
            (Some(why), Some((_, was))) => *was = why,
            (Some(why), None) => *failing = Some((now_ms(), why)),
        }
    }

    /// The queue check failing for a while, for the server's problem notifications.
    pub fn problems(&self, now: i64) -> Vec<(String, String)> {
        let failing = self.failing.lock().unwrap();
        failing
            .iter()
            .filter(|(since, _)| now - since >= FAILING_REPORTED_MS)
            .map(|(_, why)| ("cleanup:failing".to_owned(), format!("Download cleanup isn't working: {why}")))
            .collect()
    }
}

// ---------------------------------------------------------------------------------------------
// The blocklist: one pattern a line, `*` for any run of characters and `?` for one, matched
// against a file's name without case.

fn patterns(text: &str) -> Vec<String> {
    text.lines()
        .map(|l| l.trim().to_lowercase())
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .collect()
}

fn glob(pattern: &[u8], text: &[u8]) -> bool {
    let (mut p, mut t) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while t < text.len() {
        if p < pattern.len() && (pattern[p] == b'?' || pattern[p] == text[t]) {
            p += 1;
            t += 1;
        } else if p < pattern.len() && pattern[p] == b'*' {
            star = Some((p, t));
            p += 1;
        } else if let Some((sp, st)) = star {
            // Let the last star take one more character.
            p = sp + 1;
            t = st + 1;
            star = Some((sp, st + 1));
        } else {
            return false;
        }
    }
    pattern[p..].iter().all(|&c| c == b'*')
}

fn blocked(patterns: &[String], path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path).to_lowercase();
    patterns.iter().any(|p| glob(p.as_bytes(), name.as_bytes()))
}

async fn refresh_blocklist(state: &State) {
    let cleanup = &state.cleanup;
    let now = now_ms();
    if now - *cleanup.blocklist_fetched.lock().unwrap() < BLOCKLIST_EVERY_MS {
        return;
    }
    *cleanup.blocklist_fetched.lock().unwrap() = now;
    // curl, since the server's own client only speaks plain HTTP to this machine.
    let fetched = output("curl", &args!["-fsS", "--max-time", "30", BLOCKLIST_URL], Duration::from_secs(40)).await;
    match fetched {
        Ok(out) if out.success && !patterns(&out.stdout).is_empty() => {
            if let Err(e) = std::fs::write(&cleanup.blocklist_path, &out.stdout) {
                eprintln!("Couldn't save the blocklist: {e}");
            }
            *cleanup.blocklist.lock().unwrap() = patterns(&out.stdout);
        }
        Ok(out) => eprintln!("Couldn't fetch the blocklist: {}", out.stderr.trim()),
        Err(e) => eprintln!("Couldn't fetch the blocklist: {e}"),
    }
}

// ---------------------------------------------------------------------------------------------

/// An app's queue, grouped by torrent hash (lowercase). A season pack is one entry per episode.
async fn queue(state: &State, app: &str) -> Result<HashMap<String, Vec<Value>>, String> {
    let unknown = if app == "sonarr" { "includeUnknownSeriesItems" } else { "includeUnknownMovieItems" };
    let page = arr_call(state, app, Method::GET, &format!("queue?pageSize=1000&{unknown}=true"), None).await?;
    let mut out: HashMap<String, Vec<Value>> = HashMap::new();
    for item in page["records"].as_array().into_iter().flatten() {
        if item["protocol"] != "torrent" {
            continue;
        }
        if let Some(hash) = item["downloadId"].as_str() {
            out.entry(hash.to_lowercase()).or_default().push(item.clone());
        }
    }
    Ok(out)
}

/// Removes a download from qBittorrent and the queue, blocks the release so it isn't grabbed
/// again, and searches for another.
async fn remove(state: &State, app: &str, items: &[Value], title: &str, reason: &str) {
    println!("cleanup: removing {title} from {app}: {reason}");
    if !state.cleanup.dry_run {
        let ids: Vec<&Value> = items.iter().map(|i| &i["id"]).collect();
        let removed = arr_call(
            state,
            app,
            Method::DELETE,
            "queue/bulk?removeFromClient=true&blocklist=true&skipRedownload=true",
            Some(json!({ "ids": ids })),
        )
        .await;
        if let Err(e) = removed {
            eprintln!("cleanup: couldn't remove {title}: {e}");
            return;
        }
        let (field, ids_field, command) = if app == "sonarr" {
            ("episodeId", "episodeIds", "EpisodeSearch")
        } else {
            ("movieId", "movieIds", "MoviesSearch")
        };
        let mut wanted: Vec<i64> = items.iter().filter_map(|i| i[field].as_i64()).filter(|&id| id > 0).collect();
        wanted.sort_unstable();
        wanted.dedup();
        if !wanted.is_empty() {
            let searched = arr_call(state, app, Method::POST, "command", Some(json!({ "name": command, ids_field: wanted }))).await;
            if let Err(e) = searched {
                eprintln!("cleanup: couldn't search again for {title}: {e}");
            }
        }
    }
    let mut saved = state.cleanup.saved.lock().unwrap();
    saved.removed.push(Removed {
        at: now_ms(),
        app: app.into(),
        title: title.into(),
        reason: reason.into(),
    });
    let extra = saved.removed.len().saturating_sub(REMOVED_KEPT);
    saved.removed.drain(..extra);
    state.cleanup.save(&saved);
}

fn import_stuck(items: &[Value]) -> bool {
    items.iter().any(|i| {
        i["status"] == "completed"
            && matches!(i["trackedDownloadStatus"].as_str(), Some("warning" | "error"))
            && i["trackedDownloadState"].as_str().is_some_and(|s| IMPORT_STUCK_STATES.contains(&s))
    })
}

/// Gives a download this round's strike, if it earns one, and says why it's out of strikes.
fn strike(s: &mut Strikes, t: &Value, items: &[Value], now: i64) -> Option<&'static str> {
    let torrent_state = t["state"].as_str().unwrap_or_default();
    let downloaded = t["downloaded"].as_u64().unwrap_or(0);
    let stalled = torrent_state == "stalledDL" && t["private"] != true;
    let metadata = METADATA_STATES.contains(&torrent_state);
    let stuck = import_stuck(items);
    if downloaded > s.downloaded {
        s.stalled = 0;
    }
    if !(stalled || metadata || stuck) {
        return None;
    }
    s.title = items[0]["title"].as_str().unwrap_or_default().to_owned();
    s.last_strike = now;
    s.downloaded = downloaded;
    s.stalled += u32::from(stalled);
    s.metadata += u32::from(metadata);
    s.failed_import += u32::from(stuck);
    println!(
        "cleanup: strike for {} (stalled {}, metadata {}, failed import {})",
        s.title, s.stalled, s.metadata, s.failed_import
    );
    if s.stalled >= STALLED_STRIKES {
        Some("Stalled")
    } else if s.metadata >= METADATA_STRIKES {
        Some("Stuck downloading metadata")
    } else if s.failed_import >= FAILED_IMPORT_STRIKES {
        Some("Failed to import")
    } else {
        None
    }
}

/// Hands out this round's strikes and removes the downloads that have run out.
async fn check_queues(state: &State) {
    if state.game_mode.active() {
        state.cleanup.went(None);
        return;
    }
    let Ok(torrents) = qbit(state, "torrents/info", None).await else {
        state.cleanup.went(Some("it can't reach qBittorrent".into()));
        return;
    };
    let torrents: HashMap<String, &Value> = torrents
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|t| Some((t["hash"].as_str()?.to_lowercase(), t)))
        .collect();
    let now = now_ms();
    let mut out_of_strikes = Vec::new();
    let mut trouble = None;
    for (app, _) in APPS {
        let downloads = match queue(state, app).await {
            Ok(d) => d,
            Err(e) => {
                eprintln!("cleanup: {e}");
                trouble = Some(format!("it can't read {}'s queue", if *app == "sonarr" { "Sonarr" } else { "Radarr" }));
                continue;
            }
        };
        let mut saved = state.cleanup.saved.lock().unwrap();
        for (hash, items) in downloads {
            // Not in qBittorrent: nothing to judge it by.
            let Some(t) = torrents.get(&hash) else {
                continue;
            };
            let s = saved.strikes.entry(hash.clone()).or_default();
            let reason = strike(s, t, &items, now);
            if let Some(reason) = reason {
                out_of_strikes.push((*app, items, s.title.clone(), reason));
                saved.strikes.remove(&hash);
            }
        }
        state.cleanup.save(&saved);
    }
    state.cleanup.went(trouble);
    for (app, items, title, reason) in out_of_strikes {
        remove(state, app, &items, &title, reason).await;
    }
    let mut saved = state.cleanup.saved.lock().unwrap();
    saved.strikes.retain(|_, s| {
        let struck = s.stalled + s.metadata + s.failed_import > 0;
        struck && now - s.last_strike < STRIKES_LAPSE_MS
    });
    state.cleanup.save(&saved);
}

/// Skips blocked files in new TV and movie torrents, and removes those with nothing else.
async fn check_files(state: &State) {
    if state.game_mode.active() {
        return;
    }
    refresh_blocklist(state).await;
    let patterns = state.cleanup.blocklist.lock().unwrap().clone();
    if patterns.is_empty() {
        return;
    }
    let Ok(torrents) = qbit(state, "torrents/info", None).await else {
        return;
    };
    let torrents: Vec<&Value> = torrents.as_array().into_iter().flatten().collect();
    let present: HashSet<String> = torrents.iter().filter_map(|t| t["hash"].as_str()).map(str::to_lowercase).collect();
    state.cleanup.checked.lock().unwrap().retain(|h| present.contains(h));
    for t in torrents {
        let Some(hash) = t["hash"].as_str().map(str::to_lowercase) else {
            continue;
        };
        let Some((app, _)) = APPS.iter().find(|(_, category)| t["category"] == *category) else {
            continue;
        };
        // Files aren't known until the metadata is in.
        let torrent_state = t["state"].as_str().unwrap_or_default();
        if METADATA_STATES.contains(&torrent_state) || state.cleanup.checked.lock().unwrap().contains(&hash) {
            continue;
        }
        let Ok(files) = qbit(state, &format!("torrents/files?hash={hash}"), None).await else {
            continue;
        };
        let files: Vec<&Value> = files.as_array().into_iter().flatten().collect();
        if files.is_empty() {
            continue;
        }
        let bad: Vec<&Value> = files
            .iter()
            .copied()
            .filter(|f| blocked(&patterns, f["name"].as_str().unwrap_or_default()))
            .collect();
        let title = t["name"].as_str().unwrap_or_default();
        let skip: Vec<String> = bad
            .iter()
            .filter(|f| f["priority"].as_i64() != Some(0))
            .filter_map(|f| f["index"].as_i64())
            .map(|i| i.to_string())
            .collect();
        if !skip.is_empty() {
            println!("cleanup: not downloading {} blocked file(s) of {title}", skip.len());
            if !state.cleanup.dry_run {
                let ids = skip.join("|");
                let set = qbit(state, "torrents/filePrio", Some(&[("hash", &hash), ("id", &ids), ("priority", "0")])).await;
                if set.is_err() {
                    continue;
                }
            }
        }
        if bad.len() == files.len() {
            match queue(state, app).await {
                Ok(mut downloads) => {
                    if let Some(items) = downloads.remove(&hash) {
                        remove(state, app, &items, title, "Every file is on the malware blocklist").await;
                    }
                }
                Err(e) => {
                    eprintln!("cleanup: {e}");
                    continue;
                }
            }
        }
        state.cleanup.checked.lock().unwrap().insert(hash);
    }
}

pub fn start(state: State) {
    let files = state.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(QUEUE_EVERY);
        loop {
            tick.tick().await;
            check_queues(&state).await;
        }
    });
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(FILES_EVERY);
        loop {
            tick.tick().await;
            check_files(&files).await;
        }
    });
}

/// Downloads with strikes against them, and what's been removed lately.
pub async fn get(AxumState(state): AxumState<State>) -> Json<Value> {
    let saved = state.cleanup.saved.lock().unwrap();
    Json(json!({
        "dryRun": state.cleanup.dry_run,
        "blocklist": state.cleanup.blocklist.lock().unwrap().len(),
        "strikes": saved.strikes.values().collect::<Vec<_>>(),
        "removed": saved.removed.iter().rev().collect::<Vec<_>>(),
    }))
}

#[cfg(test)]
mod tests {
    use super::{Strikes, blocked, glob, patterns, strike};
    use serde_json::json;

    #[test]
    fn strikes() {
        let items = [json!({ "title": "Show S01E01", "status": "downloading" })];
        let stalled = |bytes: u64| json!({ "state": "stalledDL", "downloaded": bytes, "private": false });
        let mut s = Strikes::default();
        for _ in 0..5 {
            assert_eq!(strike(&mut s, &stalled(100), &items, 1), None);
        }
        // Progress starts the count over.
        assert_eq!(strike(&mut s, &stalled(200), &items, 2), None);
        assert_eq!(s.stalled, 1);
        for _ in 0..4 {
            assert_eq!(strike(&mut s, &stalled(200), &items, 3), None);
        }
        assert_eq!(strike(&mut s, &stalled(200), &items, 4), Some("Stalled"));

        // Private torrents aren't struck for stalling; downloading ones aren't struck at all.
        let mut s = Strikes::default();
        let private = json!({ "state": "stalledDL", "downloaded": 0, "private": true });
        assert_eq!(strike(&mut s, &private, &items, 1), None);
        assert_eq!(strike(&mut s, &json!({ "state": "downloading" }), &items, 1), None);
        assert_eq!(s.stalled + s.metadata + s.failed_import, 0);

        let mut s = Strikes::default();
        let meta = json!({ "state": "metaDL", "downloaded": 0 });
        for _ in 0..5 {
            assert_eq!(strike(&mut s, &meta, &items, 1), None);
        }
        assert_eq!(strike(&mut s, &meta, &items, 1), Some("Stuck downloading metadata"));

        let stuck = [json!({
            "title": "Movie", "status": "completed",
            "trackedDownloadStatus": "warning", "trackedDownloadState": "importPending",
        })];
        let done = json!({ "state": "stalledUP", "downloaded": 5 });
        let mut s = Strikes::default();
        assert_eq!(strike(&mut s, &done, &stuck, 1), None);
        assert_eq!(strike(&mut s, &done, &stuck, 1), None);
        assert_eq!(strike(&mut s, &done, &stuck, 1), Some("Failed to import"));
    }

    #[test]
    fn globs() {
        let g = |p: &str, t: &str| glob(p.as_bytes(), t.as_bytes());
        assert!(g("*.exe", "setup.exe"));
        assert!(!g("*.exe", "setup.exe.mkv"));
        assert!(g("*(sample).*", "movie (sample).mkv"));
        assert!(g("trailer.*", "trailer.mp4"));
        assert!(!g("trailer.*", "the trailer.mp4"));
        assert!(g("*sample.mkv", "show.s01e01.sample.mkv"));
        assert!(g("a*b*c", "aXbYbZc"));
        assert!(g("vostfr", "vostfr"));
        assert!(!g("vostfr", "show.vostfr.mkv"));
    }

    #[test]
    fn blocks_by_file_name() {
        let p = patterns("*.exe\n\n*.vbscript \nTrailer.*\n");
        assert!(blocked(&p, "Show S01/Setup.EXE"));
        assert!(blocked(&p, "Movie/Trailer.mp4"));
        assert!(blocked(&p, "x.vbscript"));
        assert!(!blocked(&p, "Show S01/Show.S01E01.mkv"));
        assert!(!blocked(&p, "Trailer.Park.Boys/Episode.mkv"));
    }
}

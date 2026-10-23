//! Videos: links from the Videos mini-app are saved by yt-dlp into Jellyfin's YouTube library, one
//! folder per channel, one download at a time. Jellyfin watches the folder, and reads the title,
//! description and thumbnail that yt-dlp embeds in the file. h264 and AAC in mp4 play on the phone
//! without transcoding.
//!
//! Each job is kept as the JSON the app gets, in `videos.json`, newest first.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Path as UrlPath, State as AxumState};
use axum::http::{Method, StatusCode};
use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::events::{Notice, notify};
use crate::http::{HttpError, State};
use crate::usage::now_ms;

const VIDEO_KEEP: usize = 50;
const VIDEO_QUALITIES: [i64; 3] = [1080, 720, 480];
/// YouTube changes often enough that yt-dlp needs updating every few weeks to keep working.
const YTDLP_UPDATE_EVERY: Duration = Duration::from_secs(24 * 3600);
/// Jellyfin runs in a container that sees the media drive somewhere else.
const JELLYFIN_URL: &str = "http://127.0.0.1:8096";
const JELLYFIN_MEDIA: (&str, &str) = ("/mnt/media", "/media/drive");

type Job = Map<String, Value>;

fn ytdlp() -> String {
    std::env::var("YTDLP").unwrap_or_else(|_| format!("{}/.local/bin/yt-dlp", std::env::var("HOME").unwrap_or_default()))
}

fn video_dir() -> PathBuf {
    PathBuf::from(std::env::var("VIDEO_DIR").unwrap_or_else(|_| "/mnt/media/YouTube".into()))
}

/// Outside the library so Jellyfin doesn't pick up half-downloaded pieces, but on the same drive.
fn partial_dir() -> PathBuf {
    video_dir().parent().unwrap_or(Path::new("/")).join(".youtube-partial")
}

pub struct Videos {
    path: PathBuf,
    jobs: Mutex<Vec<Job>>,
    /// The job downloading now, and its yt-dlp's pid.
    running: Mutex<Option<(String, u32)>>,
    ytdlp_updated_at: Mutex<Option<Instant>>,
}

fn id_of(job: &Job) -> &str {
    job["id"].as_str().unwrap_or_default()
}

fn state_of(job: &Job) -> &str {
    job["state"].as_str().unwrap_or_default()
}

fn not_found() -> HttpError {
    HttpError(StatusCode::NOT_FOUND, "No such download".into())
}

impl Videos {
    pub fn new(dir: &Path) -> Self {
        Self {
            path: dir.join("videos.json"),
            jobs: Mutex::default(),
            running: Mutex::default(),
            ytdlp_updated_at: Mutex::default(),
        }
    }

    /// Keeps the newest 50 and saves them.
    fn save(&self, jobs: &mut Vec<Job>) {
        jobs.truncate(VIDEO_KEEP);
        let text = Value::Array(jobs.iter().cloned().map(Value::Object).collect()).to_string();
        if let Err(e) = crate::files::write_private(&self.path, text.as_bytes()) {
            eprintln!("Couldn't save video jobs: {e}");
        }
    }

    fn kill_running(&self, id: &str) -> bool {
        match &*self.running.lock().unwrap() {
            Some((running, pid)) if running == id => {
                // SAFETY: sends SIGTERM to the yt-dlp this server started.
                unsafe { libc::kill(*pid as i32, libc::SIGTERM) };
                true
            }
            _ => false,
        }
    }
}

/// Picks up the saved jobs. Downloads cut short by a restart start over; yt-dlp picks up the pieces
/// it already has.
pub fn start(state: State) {
    let videos = &state.videos;
    let saved: Vec<Value> = std::fs::read_to_string(&videos.path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    let mut jobs: Vec<Job> = saved.into_iter().filter_map(|v| v.as_object().cloned()).collect();
    for job in &mut jobs {
        if state_of(job) == "downloading" {
            job.insert("state".into(), json!("queued"));
            job.remove("progress");
        }
    }
    *videos.jobs.lock().unwrap() = jobs;
    next_video(&state);
    tokio::spawn(async move {
        let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + Duration::from_secs(3600), Duration::from_secs(3600));
        loop {
            tick.tick().await;
            update_ytdlp(&state).await;
        }
    });
}

async fn update_ytdlp(state: &State) {
    if state.videos.running.lock().unwrap().is_some() {
        return;
    }
    {
        let mut at = state.videos.ytdlp_updated_at.lock().unwrap();
        if at.is_some_and(|t| t.elapsed() < YTDLP_UPDATE_EVERY) {
            return;
        }
        *at = Some(Instant::now());
    }
    match crate::command::run(&ytdlp(), &["-U".to_owned()], Duration::from_secs(120)).await {
        Ok(out) => {
            if let Some(line) = out.trim().lines().last() {
                println!("yt-dlp: {line}");
            }
        }
        Err(e) => eprintln!("Couldn't update yt-dlp: {e}"),
    }
}

pub async fn list(AxumState(state): AxumState<State>) -> Json<Value> {
    let jobs = state.videos.jobs.lock().unwrap().clone();
    Json(json!({ "jobs": jobs, "folder": video_dir().to_string_lossy() }))
}

fn random_id() -> String {
    use std::io::Read;
    let mut b = [0u8; 6];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        let _ = f.read_exact(&mut b);
    }
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub async fn add(AxumState(state): AxumState<State>, body: Bytes) -> Result<Json<Value>, HttpError> {
    let body = crate::machine::json_body(&body)?;
    let body = if body.is_null() { json!({}) } else { body };
    println!(
        "save video {}",
        body.get("url")
            .map_or("undefined".into(), |u| u.as_str().map_or(u.to_string(), str::to_owned))
    );
    // String(url), as the Node server took it.
    let raw = match body.get("url") {
        None | Some(Value::Null) => "undefined".to_owned(),
        Some(Value::String(s)) => s.clone(),
        Some(v) => v.to_string(),
    };
    let parsed = url::Url::parse(raw.trim())
        .ok()
        .filter(|u| u.scheme() == "http" || u.scheme() == "https");
    let Some(parsed) = parsed else {
        return Err(HttpError(StatusCode::BAD_REQUEST, "That isn’t a link".into()));
    };
    let quality = match body.get("quality") {
        None | Some(Value::Null) => Some(1080),
        Some(q) => q
            .as_f64()
            .filter(|q| q.fract() == 0.0)
            .map(|q| q as i64)
            .filter(|q| VIDEO_QUALITIES.contains(q)),
    };
    let Some(quality) = quality else {
        return Err(HttpError(StatusCode::BAD_REQUEST, "Quality must be 1080, 720 or 480".into()));
    };
    let mut job = Job::new();
    job.insert("id".into(), json!(random_id()));
    job.insert("url".into(), json!(parsed.as_str()));
    job.insert("quality".into(), json!(quality));
    job.insert("state".into(), json!("queued"));
    job.insert("createdAt".into(), json!(now_ms()));
    job.insert("files".into(), json!([]));
    {
        let mut jobs = state.videos.jobs.lock().unwrap();
        jobs.insert(0, job.clone());
        state.videos.save(&mut jobs);
    }
    next_video(&state);
    Ok(Json(Value::Object(job)))
}

pub async fn action(
    AxumState(state): AxumState<State>,
    UrlPath((id, action)): UrlPath<(String, String)>,
) -> Result<Json<Value>, HttpError> {
    if !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') || !["retry", "cancel"].contains(&action.as_str()) {
        return Err(HttpError(StatusCode::NOT_FOUND, "Not found".into()));
    }
    println!("video {action} {id}");
    let job = {
        let mut jobs = state.videos.jobs.lock().unwrap();
        let i = jobs.iter().position(|j| id_of(j) == id).ok_or_else(not_found)?;
        if action == "retry" {
            if !["failed", "cancelled"].contains(&state_of(&jobs[i])) {
                return Err(HttpError(
                    StatusCode::CONFLICT,
                    "Only failed or cancelled downloads can be retried".into(),
                ));
            }
            let job = &mut jobs[i];
            job.insert("state".into(), json!("queued"));
            for k in ["error", "note", "progress"] {
                job.remove(k);
            }
            job.insert("files".into(), json!([]));
        } else if state_of(&jobs[i]) == "queued" || state.videos.kill_running(&id) {
            jobs[i].insert("state".into(), json!("cancelled"));
        }
        let job = jobs[i].clone();
        state.videos.save(&mut jobs);
        job
    };
    if action == "retry" {
        next_video(&state);
    }
    Ok(Json(Value::Object(job)))
}

/// Cancels it if it's running, and takes it off the list. The saved video stays in Jellyfin.
pub async fn remove(AxumState(state): AxumState<State>, UrlPath(id): UrlPath<String>) -> Result<Json<Value>, HttpError> {
    if !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
        return Err(HttpError(StatusCode::NOT_FOUND, "Not found".into()));
    }
    println!("video remove {id}");
    let mut jobs = state.videos.jobs.lock().unwrap();
    let i = jobs.iter().position(|j| id_of(j) == id).ok_or_else(not_found)?;
    if state.videos.kill_running(&id) {
        jobs[i].insert("state".into(), json!("cancelled"));
    }
    jobs.remove(i);
    state.videos.save(&mut jobs);
    Ok(Json(json!({ "ok": true })))
}

/// Starts the oldest queued download when nothing is downloading.
fn next_video(state: &State) {
    if state.videos.running.lock().unwrap().is_some() {
        return;
    }
    let job = state
        .videos
        .jobs
        .lock()
        .unwrap()
        .iter()
        .rev()
        .find(|j| state_of(j) == "queued")
        .cloned();
    if let Some(job) = job {
        let state = state.clone();
        tokio::spawn(async move { download(state, job).await });
    }
}

/// Lines yt-dlp prints for the app to follow along, as JSON so titles with spaces survive.
const VIDEO_PRINTS: &[&str] = &[
    "--progress-template",
    "download:PROGRESS %(progress.{downloaded_bytes,total_bytes,total_bytes_estimate,speed,eta})j",
    "--print",
    "before_dl:VIDEO %(.{id,title,uploader,channel,thumbnail,playlist_index,n_entries,playlist_title})j",
    "--print",
    "after_move:SAVED %(filepath)j",
];

/// Changes a job by id, if it's still listed.
fn with_job(state: &State, id: &str, f: impl FnOnce(&mut Job)) {
    if let Some(job) = state.videos.jobs.lock().unwrap().iter_mut().find(|j| id_of(j) == id) {
        f(job);
    }
}

fn set(job: &mut Job, key: &str, v: Option<Value>) {
    match v.filter(|v| !v.is_null()) {
        Some(v) => job.insert(key.into(), v),
        None => job.remove(key),
    };
}

/// What a line of yt-dlp's output says about the job.
fn on_line(job: &mut Job, line: &str, errors: &mut Vec<String>) {
    let (kind, rest) = line.split_once(' ').unwrap_or((line, ""));
    if !["PROGRESS", "VIDEO", "SAVED"].contains(&kind) {
        if let Some(e) = line.strip_prefix("ERROR:") {
            errors.push(e.trim().to_owned());
        }
        return;
    }
    let Ok(v) = serde_json::from_str::<Value>(rest) else { return };
    let given = |k: &str| Some(v[k].clone()).filter(|x| !x.is_null());
    match kind {
        "PROGRESS" => {
            let mut p = Map::new();
            p.insert("bytes".into(), given("downloaded_bytes").unwrap_or(json!(0)));
            if let Some(t) = given("total_bytes").or_else(|| given("total_bytes_estimate")) {
                p.insert("total".into(), t);
            }
            for k in ["speed", "eta"] {
                if let Some(x) = given(k) {
                    p.insert(k.into(), x);
                }
            }
            job.insert("progress".into(), Value::Object(p));
        }
        "VIDEO" => {
            let many = v["n_entries"].as_f64().is_some_and(|n| n > 1.0);
            let playlist = given("playlist_title").filter(|t| t.as_str() != Some(""));
            set(job, "title", if many && playlist.is_some() { playlist } else { given("title") });
            set(job, "channel", given("uploader").or_else(|| given("channel")));
            if job.get("thumbnail").is_none_or(Value::is_null) {
                set(job, "thumbnail", given("thumbnail"));
            }
            let item = many.then(|| {
                let mut i = Map::new();
                for (to, from) in [("index", "playlist_index"), ("count", "n_entries"), ("title", "title")] {
                    if let Some(x) = given(from) {
                        i.insert(to.into(), x);
                    }
                }
                Value::Object(i)
            });
            set(job, "item", item);
            job.remove("progress");
        }
        _ => {
            let saved = v.as_str().unwrap_or_default();
            let dir = video_dir();
            let relative = Path::new(saved)
                .strip_prefix(&dir)
                .map_or(saved.to_owned(), |p| p.to_string_lossy().into_owned());
            if let Some(files) = job.get_mut("files").and_then(Value::as_array_mut) {
                files.push(json!(relative));
            }
        }
    }
}

async fn download(state: State, job: Job) {
    let id = id_of(&job).to_owned();
    let partial = partial_dir().join(&id);
    let dir = video_dir();
    let quality = job["quality"].as_i64().unwrap_or(1080);
    let mut args: Vec<String> = [
        "--js-runtimes",
        "node",
        "-S",
        &format!("res:{quality},vcodec:h264,acodec:aac"),
        "--merge-output-format",
        "mp4",
        "--embed-metadata",
        "--embed-thumbnail",
        "--embed-chapters",
        "--download-archive",
        &dir.join(".downloaded.txt").to_string_lossy(),
        "--no-overwrites",
        "--newline",
        "--no-colors",
        "--progress",
        "-P",
        &dir.to_string_lossy(),
        "-P",
        &format!("temp:{}", partial.to_string_lossy()),
        "-o",
        "%(uploader,channel|Unknown channel)s/%(title).180B [%(id)s].%(ext)s",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    args.extend(VIDEO_PRINTS.iter().map(|s| s.to_string()));
    args.push("--".into());
    args.push(job["url"].as_str().unwrap_or_default().to_owned());

    with_job(&state, &id, |j| {
        j.insert("state".into(), json!("downloading"));
        j.insert("startedAt".into(), json!(now_ms()));
        j.remove("error");
    });
    println!("Saving video {}", job["url"].as_str().unwrap_or_default());
    // The service's umask keeps files private, but Jellyfin's container reads them as another user.
    let child = tokio::process::Command::new("sh")
        .arg("-c")
        .arg(r#"umask 022 && exec "$0" "$@""#)
        .arg(ytdlp())
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    let (code, failure) = match child {
        Err(e) => {
            let failure = if e.kind() == std::io::ErrorKind::NotFound {
                format!("yt-dlp isn't installed at {}", ytdlp())
            } else {
                e.to_string()
            };
            (-1, Some(failure))
        }
        Ok(mut child) => {
            *state.videos.running.lock().unwrap() = Some((id.clone(), child.id().unwrap_or(0)));
            {
                let mut jobs = state.videos.jobs.lock().unwrap();
                state.videos.save(&mut jobs);
            }
            let mut errors = Vec::new();
            let mut out = BufReader::new(child.stdout.take().unwrap()).lines();
            let mut err = BufReader::new(child.stderr.take().unwrap()).lines();
            let (mut out_open, mut err_open) = (true, true);
            while out_open || err_open {
                let line = tokio::select! {
                    l = out.next_line(), if out_open => l.ok().flatten().or_else(|| { out_open = false; None }),
                    l = err.next_line(), if err_open => l.ok().flatten().or_else(|| { err_open = false; None }),
                };
                if let Some(line) = line {
                    with_job(&state, &id, |j| on_line(j, line.trim(), &mut errors));
                }
            }
            let status = child.wait().await;
            let code = status.ok().and_then(|s| s.code());
            let last = errors.pop();
            (
                code.unwrap_or(-2),
                if code == Some(0) {
                    None
                } else {
                    last.or(Some(format!("yt-dlp stopped ({})", code.map_or("null".into(), |c| c.to_string()))))
                },
            )
        }
    };
    finish(&state, &id, code, failure).await;
    let _ = tokio::fs::remove_dir_all(&partial).await;
    update_ytdlp(&state).await;
    next_video(&state);
}

async fn finish(state: &State, id: &str, code: i32, failure: Option<String>) {
    *state.videos.running.lock().unwrap() = None;
    let mut notice = None;
    let mut announce = Vec::new();
    {
        let mut jobs = state.videos.jobs.lock().unwrap();
        if let Some(job) = jobs.iter_mut().find(|j| id_of(j) == id) {
            job.insert("finishedAt".into(), json!(now_ms()));
            job.remove("progress");
            let files: Vec<String> = job["files"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|f| f.as_str().map(str::to_owned))
                .collect();
            let title = job
                .get("title")
                .and_then(Value::as_str)
                .or(job["url"].as_str())
                .unwrap_or_default()
                .to_owned();
            if state_of(job) == "cancelled" {
                // Leave nothing behind but whole videos.
            } else if code == 0 {
                job.insert("state".into(), json!("done"));
                // A video that was already saved is skipped, so nothing new turns up in Jellyfin.
                if files.is_empty() {
                    job.insert("note".into(), json!("Already saved"));
                } else {
                    let what = if files.len() > 1 {
                        format!("{} videos from {title}", files.len())
                    } else {
                        title
                    };
                    notice = Some(Notice {
                        title: "Saved to Jellyfin".into(),
                        message: what,
                        tags: "tv",
                        click: Some("homebase://videos".into()),
                    });
                    announce = files;
                }
            } else {
                let error = failure.unwrap_or_else(|| format!("yt-dlp stopped ({code})"));
                job.insert("state".into(), json!("failed"));
                job.insert("error".into(), json!(error));
                notice = Some(Notice {
                    title: "Video download failed".into(),
                    message: format!("{title}: {error}"),
                    tags: "warning",
                    click: Some("homebase://videos".into()),
                });
            }
            let error = job
                .get("error")
                .and_then(Value::as_str)
                .map(|e| format!(" ({e})"))
                .unwrap_or_default();
            println!("Video {}: {}{error}", state_of(job), job["url"].as_str().unwrap_or_default());
        }
        state.videos.save(&mut jobs);
    }
    if !announce.is_empty() {
        announce_to_jellyfin(state, &announce).await;
    }
    if let Some(n) = notice {
        notify(&state.upstream, n).await;
    }
}

/// Tells Jellyfin about new files rather than waiting for its folder watcher, which can take
/// minutes. Borrows Seerr's API key for Jellyfin.
async fn announce_to_jellyfin(state: &State, files: &[String]) {
    let arr = std::env::var("ARR_DIR").map_or_else(
        |_| PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".local/share/arr"),
        PathBuf::from,
    );
    let key = std::fs::read_to_string(arr.join("seerr/settings.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|s| s["jellyfin"]["apiKey"].as_str().map(str::to_owned));
    let Some(key) = key else {
        eprintln!("Couldn't tell Jellyfin about new videos: no API key in Seerr settings");
        return;
    };
    let updates: Vec<Value> = files
        .iter()
        .map(|f| json!({ "Path": video_dir().join(f).to_string_lossy().replacen(JELLYFIN_MEDIA.0, JELLYFIN_MEDIA.1, 1), "UpdateType": "Created" }))
        .collect();
    let headers = [
        ("Authorization", format!("MediaBrowser Token=\"{key}\"")),
        ("Content-Type", "application/json".to_owned()),
    ];
    let body = json!({ "Updates": updates }).to_string();
    match crate::client::call(
        &state.upstream,
        Method::POST,
        &format!("{JELLYFIN_URL}/Library/Media/Updated"),
        &headers,
        Some(body.into()),
        Duration::from_secs(10),
    )
    .await
    {
        Ok(r) if r.status.is_success() => {}
        Ok(r) => eprintln!("Couldn't tell Jellyfin about new videos: HTTP {}", r.status.as_u16()),
        Err(e) => eprintln!("Couldn't tell Jellyfin about new videos: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_from_ytdlp() {
        let mut job = Job::new();
        job.insert("files".into(), json!([]));
        let mut errors = Vec::new();
        on_line(
            &mut job,
            r#"VIDEO {"id":"a","title":"Ep 1","uploader":null,"channel":"Chan","thumbnail":"t.jpg","playlist_index":1,"n_entries":3,"playlist_title":"Series"}"#,
            &mut errors,
        );
        assert_eq!(job["title"], "Series");
        assert_eq!(job["channel"], "Chan");
        assert_eq!(job["item"], json!({ "index": 1, "count": 3, "title": "Ep 1" }));
        on_line(
            &mut job,
            r#"PROGRESS {"downloaded_bytes":10,"total_bytes":null,"total_bytes_estimate":100,"speed":null,"eta":4}"#,
            &mut errors,
        );
        assert_eq!(job["progress"], json!({ "bytes": 10, "total": 100, "eta": 4 }));
        on_line(&mut job, r#"SAVED "/mnt/media/YouTube/Chan/Ep 1 [a].mp4""#, &mut errors);
        assert_eq!(job["files"], json!(["Chan/Ep 1 [a].mp4"]));
        on_line(&mut job, "ERROR: [youtube] a: Video unavailable", &mut errors);
        assert_eq!(errors, ["[youtube] a: Video unavailable"]);
    }
}

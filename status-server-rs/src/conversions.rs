//! Conversions: shrinks the library to 10-bit HEVC in MP4s the iPhone plays without transcoding,
//! one file at a time on the GPU (VAAPI). Took over from Tdarr on 2026-10-23 and does what its
//! "x265 Shows/Movies" flows did:
//!
//! - h264 and the like → 10-bit HEVC at QP 24, kept only if it's 10–90% of the original's size.
//!   When it isn't, an h264 original is remuxed to MP4 as it is instead.
//! - HEVC in anything but an hvc1-tagged MP4 → remuxed to MP4. AV1 and HDR are left alone.
//! - In the MP4: HEVC tagged hvc1 (Apple ignores hev1), text subtitles as mov_text, image subtitles
//!   and attachments dropped, audio the iPhone can't play as E-AC-3, and the index at the front so
//!   playback starts before the whole file loads.
//!
//! The new file is checked with ffprobe and waits while anyone plays the original, then replaces
//! it, and Sonarr or Radarr rescans the show or movie. The
//! libraries are watched (inotify), and scanned once a file has had time to settle after a change,
//! and every half hour besides; what's been decided is kept in `conversions.json` by path, with
//! the size and time the file had, so a changed file is looked at again. ffmpeg runs in a scope of
//! its own with a low CPU and disk weight. Game mode stops it, and the file starts over
//! afterwards. While Jellyfin transcodes video for someone, or any of Jellyfin's ffmpegs uses the
//! GPU, ours is paused (SIGSTOP) and no new file is started: the RX 5700's video engine hard-froze
//! the machine on 2026-10-23 with our encode and Jellyfin's trickplay on it at once. A file still hard-linked to a seeding download
//! waits until the torrent is removed.

use std::collections::BTreeMap;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;

use axum::Json;
use axum::body::Bytes;
use axum::extract::State as AxumState;
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::Notify;

use crate::args;
use crate::command::run;
use crate::http::{HttpError, State};
use crate::machine::{json_body, media_root};
use crate::usage::now_ms;

/// The libraries, with the app that manages each.
const LIBRARIES: &[(&str, &str)] = &[("Shows", "sonarr"), ("Movies", "radarr")];
const EXTENSIONS: &[&str] = &[
    "mkv", "mp4", "mov", "m4v", "mpg", "mpeg", "avi", "flv", "webm", "wmv", "vob", "evo", "m2ts", "ts",
];
/// In case the watch missed something, as it would a drive mounted over the libraries.
const SCAN_EVERY: Duration = Duration::from_secs(30 * 60);
/// A file is left alone until it's gone this long without changing, in case it's still being written.
const SETTLE_MS: i64 = 2 * 60 * 1000;
const QP: &str = "24";
/// The encode is kept only if its size is within this share of the original's.
const KEEP_RATIO: (f64, f64) = (0.1, 0.9);
const RENDER_NODE: &str = "/dev/dri/renderD128";
const PROBE_TIMEOUT: Duration = Duration::from_secs(60);
/// What the GPU decodes, in these pixel formats; the rest is decoded on the CPU and uploaded.
const GPU_DECODES: &[&str] = &["h264", "hevc", "mpeg2video", "vc1", "vp9"];
const GPU_PIXEL_FORMATS: &[&str] = &["yuv420p", "yuvj420p", "yuv420p10le"];
/// Audio the iPhone plays from an MP4; anything else becomes E-AC-3.
const PHONE_AUDIO: &[&str] = &["aac", "ac3", "eac3", "mp3", "alac", "flac", "opus"];
const TEXT_SUBTITLES: &[&str] = &["subrip", "srt", "ass", "ssa", "webvtt", "mov_text", "text"];
const HDR_TRANSFERS: &[&str] = &["smpte2084", "arib-std-b67"];
/// Shown as `heldFor` when Jellyfin has the GPU without anyone watching (trickplay and the like).
const BACKGROUND_TASK: &str = "a background task";
/// How often a running job checks whether game mode wants the GPU.
const GAME_CHECK: Duration = Duration::from_secs(5);
/// A job that hasn't moved in this long, while nothing's holding it, is reported as stuck.
const STUCK_MS: i64 = 30 * 60 * 1000;
/// How long a finished file waits for someone to stop playing the original before replacing it
/// anyway, for a session that never ends.
const PLAYING_WAIT: Duration = Duration::from_secs(4 * 3600);
/// Failures in a row that are reported, since one bad file is normal and a run of them isn't.
const FAILURES_REPORTED: usize = 3;

fn ffmpeg() -> String {
    std::env::var("FFMPEG").unwrap_or_else(|_| "ffmpeg".into())
}

fn ffprobe() -> String {
    std::env::var("FFPROBE").unwrap_or_else(|_| "ffprobe".into())
}

/// ffprobe and ffmpeg parse files from strangers' torrents, so they run in bubblewrap: no
/// network, no home folder, nothing of the media drive but the files they're given. Returns the
/// program to run and the arguments that go before `program`'s own. CONVERSIONS_SANDBOX=off runs
/// them straight, for testing with fakes outside /usr.
fn sandboxed(program: String, read: &[&str], write: &[&str]) -> (String, Vec<String>) {
    if std::env::var("CONVERSIONS_SANDBOX").as_deref() == Ok("off") {
        return (program, Vec::new());
    }
    let mut a = args![
        "--unshare-all", "--die-with-parent", "--new-session",
        "--ro-bind", "/usr", "/usr",
        "--symlink", "usr/bin", "/bin",
        "--symlink", "usr/sbin", "/sbin",
        "--symlink", "usr/lib", "/lib",
        "--symlink", "usr/lib64", "/lib64",
        "--ro-bind", "/etc", "/etc",
        "--proc", "/proc",
        "--dev", "/dev",
        "--dev-bind", "/dev/dri", "/dev/dri",
        // libva finds the GPU's driver through /sys.
        "--ro-bind", "/sys", "/sys",
        "--tmpfs", "/tmp",
        "--clearenv", "--setenv", "PATH", "/usr/bin",
    ]
    .to_vec();
    for path in read {
        a.extend(args!["--ro-bind", *path, *path]);
    }
    for path in write {
        a.extend(args!["--bind", *path, *path]);
    }
    a.extend(args!["--", program]);
    ("bwrap".into(), a)
}

/// The scope ffmpeg runs in; empty runs it straight from the server (for testing).
fn scope_unit() -> String {
    std::env::var("CONVERT_UNIT").unwrap_or_else(|_| "homebase-convert".into())
}

/// On the media drive, so the finished file moves into place rather than being copied.
fn cache_dir() -> PathBuf {
    media_root().join(".conversions")
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
enum Verdict {
    Queued,
    Skipped,
    Done,
    Failed,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
enum Action {
    Encode,
    Remux,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Entry {
    /// The file's size and modification time (ms) when it was looked at.
    size: u64,
    mtime: i64,
    verdict: Verdict,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    action: Option<Action>,
    /// Why it was skipped or failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    old_size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    new_size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    at: Option<i64>,
}

#[derive(Serialize, Deserialize, Default)]
struct Saved {
    paused: bool,
    files: BTreeMap<String, Entry>,
}

/// The file converting now.
#[derive(Clone)]
struct Job {
    path: String,
    started_at: i64,
    old_size: u64,
    /// Seconds of video, and how far ffmpeg is.
    duration: f64,
    done: f64,
    fps: f64,
    speed: f64,
    written: u64,
    /// When ffmpeg last got further, or was last let go on.
    progressed_at: i64,
    /// Paused while Jellyfin transcodes for this user.
    held_for: Option<String>,
}

pub struct Conversions {
    file: crate::files::JsonFile,
    saved: Mutex<Saved>,
    job: Mutex<Option<Job>>,
    /// Wakes the worker when there may be something to do.
    work: Notify,
    /// Asks for a scan before the next one is due.
    rescan: Notify,
    /// Something in the libraries changed; a scan follows once it has settled.
    changed: Notify,
    /// Why each file since the last one that worked failed.
    failures: Mutex<Vec<String>>,
}

impl Conversions {
    pub fn new(dir: &Path) -> Self {
        let file = crate::files::JsonFile::new(dir.join("conversions.json"), "conversions");
        let saved = match file.read() {
            Ok(Some(saved)) => saved,
            // Paused at first, so it waits to be switched on from the app; and paused when the
            // file is there but can't be read, rather than start work it may have been told not to.
            Ok(None) => Saved { paused: true, ..Saved::default() },
            Err(crate::files::ReadError::Unreadable(e)) => {
                eprintln!("Couldn't read conversions.json, so starting paused: {e}");
                Saved { paused: true, ..Saved::default() }
            }
            Err(crate::files::ReadError::Invalid(e)) => {
                eprintln!("Couldn't read conversions.json: {e}");
                Saved::default()
            }
        };
        Self {
            file,
            saved: Mutex::new(saved),
            job: Mutex::default(),
            work: Notify::new(),
            rescan: Notify::new(),
            changed: Notify::new(),
            failures: Mutex::default(),
        }
    }

    fn save(&self, saved: &Saved) {
        self.file.save(saved);
    }

    /// Files converting right now, for the history.
    pub fn converting(&self) -> f64 {
        if self.job.lock().unwrap().is_some() { 1.0 } else { 0.0 }
    }
}

fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.mtime() * 1000 + meta.mtime_nsec() / 1_000_000
}

fn extension(path: &str) -> String {
    Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

/// Every video under `dir`, with its size and modification time. Hidden folders are skipped, and
/// so are symlinks, which could lead the walk (and the replacing) out of the library.
fn walk(dir: &Path, out: &mut Vec<(String, u64, i64)>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let path = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.is_dir() {
            walk(&path, out);
        } else if let Some(p) = path.to_str()
            && meta.is_file()
            && EXTENSIONS.contains(&extension(p).as_str())
        {
            out.push((p.to_owned(), meta.len(), mtime_ms(&meta)));
        }
    }
}

// ---------------------------------------------------------------------------------------------
// What's in a file, and what to do with it.

#[derive(Clone, Debug, Default)]
struct Stream {
    index: u64,
    kind: String,
    codec: String,
    tag: String,
    pix_fmt: String,
    channels: u64,
    hdr: bool,
    /// Cover art, which ffprobe lists as video.
    picture: bool,
}

#[derive(Debug, Default)]
struct Probe {
    duration: f64,
    /// Where the file's timestamps start.
    start: f64,
    streams: Vec<Stream>,
}

impl Probe {
    fn video(&self) -> Option<&Stream> {
        self.streams.iter().find(|s| s.kind == "video" && !s.picture)
    }
}

fn parse_probe(v: &Value) -> Probe {
    let text = |s: &Value, k: &str| s[k].as_str().unwrap_or_default().to_owned();
    let streams = v["streams"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|s| Stream {
            index: s["index"].as_u64().unwrap_or(0),
            kind: text(s, "codec_type"),
            codec: text(s, "codec_name"),
            tag: text(s, "codec_tag_string"),
            pix_fmt: text(s, "pix_fmt"),
            channels: s["channels"].as_u64().unwrap_or(0),
            hdr: HDR_TRANSFERS.contains(&s["color_transfer"].as_str().unwrap_or_default())
                || s["side_data_list"].as_array().into_iter().flatten().any(|d| {
                    d["side_data_type"].as_str().is_some_and(|t| t.contains("DOVI"))
                }),
            picture: s["disposition"]["attached_pic"] == 1,
        })
        .collect();
    let duration = v["format"]["duration"].as_str().and_then(|d| d.parse().ok()).unwrap_or(0.0);
    let start = v["format"]["start_time"].as_str().and_then(|d| d.parse().ok()).unwrap_or(0.0);
    Probe { duration, start, streams }
}

async fn probe(path: &str) -> Result<Probe, String> {
    let (program, mut a) = sandboxed(ffprobe(), &[path], &[]);
    a.extend(args!["-v", "error", "-protocol_whitelist", "file", "-print_format", "json", "-show_format", "-show_streams", path]);
    let out = run(&program, &a, PROBE_TIMEOUT)
        .await
        .map_err(|e| format!("Couldn't read it: {}", e.lines().next().unwrap_or_default()))?;
    let v: Value = serde_json::from_str(&out).map_err(|e| format!("Couldn't read it: {e}"))?;
    Ok(parse_probe(&v))
}

/// What to do with a file, or why it's left as it is.
fn decide(path: &str, probe: &Probe) -> Result<Action, String> {
    let Some(v) = probe.video() else {
        return Err("No video in it".into());
    };
    if v.hdr {
        return Err("HDR, left as it is".into());
    }
    match v.codec.as_str() {
        "hevc" if extension(path) == "mp4" && v.tag == "hvc1" => Err("Already HEVC in MP4".into()),
        "hevc" => Ok(Action::Remux),
        "av1" => Err("AV1, left as it is".into()),
        _ => Ok(Action::Encode),
    }
}

fn gpu_decodes(v: &Stream) -> bool {
    GPU_DECODES.contains(&v.codec.as_str())
        && GPU_PIXEL_FORMATS.contains(&v.pix_fmt.as_str())
        // AMD's GPUs don't decode 10-bit h264.
        && !(v.codec == "h264" && v.pix_fmt == "yuv420p10le")
}

/// The ffmpeg runs that make the MP4 at `output` from `input`, in order.
///
/// An encode takes two. AMD's driver writes the HEVC with parameter sets of its own (Mesa 26.2:
/// deeper transform trees, dependent slices, another initial QP), not the ones ffmpeg puts in
/// the MP4's hvcC, and an hvc1 MP4 keeps only the hvcC, so players decoded garbage, mostly
/// without a single error (found 2026-10-27, after every encode since 2026-10-23 came out so).
/// So the video goes to an MPEG-TS first, which keeps the driver's sets in the stream, and the
/// second run builds the hvcC from those, taking the audio and subtitles from the original.
/// -copyts in both keeps the video where it was against them, and the offset brings the start
/// to zero as a single run would.
fn ffmpeg_passes(input: &str, output: &str, probe: &Probe, action: Action, gpu_decode: bool) -> Vec<Vec<String>> {
    let head = || args!["-hide_banner", "-nostdin", "-nostats", "-loglevel", "error", "-progress", "pipe:1", "-y"].to_vec();
    let mut a = head();
    let mut codecs: Vec<String> = Vec::new();
    let mut out = 0;
    let video = probe.video();
    let mut passes = Vec::new();
    let source = match (action, video) {
        (Action::Encode, Some(v)) => {
            let ts = format!("{output}.video.ts");
            let mut first = head();
            first.push("-copyts".into());
            if gpu_decode {
                first.extend(args!["-hwaccel", "vaapi", "-hwaccel_device", RENDER_NODE, "-hwaccel_output_format", "vaapi"]);
            } else {
                first.extend(args!["-init_hw_device", format!("vaapi=va:{RENDER_NODE}"), "-filter_hw_device", "va"]);
            }
            first.extend(args![
                "-protocol_whitelist",
                "file",
                "-i",
                input,
                "-map",
                format!("0:{}", v.index),
                "-c:v",
                "hevc_vaapi",
                "-rc_mode:v",
                "CQP",
                "-qp:v",
                QP,
                "-profile:v",
                "main10",
                // 10-bit on the GPU: -pix_fmt can't touch frames that stay there.
                "-filter:v",
                if gpu_decode { "scale_vaapi=format=p010" } else { "format=p010le,hwupload" },
                "-muxdelay",
                "0",
                "-muxpreload",
                "0",
                "-f",
                "mpegts",
                &ts,
            ]);
            passes.push(first);
            a.extend(args!["-copyts", "-protocol_whitelist", "file", "-i", &ts, "-protocol_whitelist", "file", "-i", input]);
            a.extend(args!["-map", "0:0"]);
            codecs.extend(args!["-c:0", "copy", "-tag:0", "hvc1"]);
            out += 1;
            1
        }
        (_, v) => {
            a.extend(args!["-protocol_whitelist", "file", "-i", input]);
            if let Some(v) = v {
                a.extend(args!["-map", format!("0:{}", v.index)]);
                codecs.extend(args![format!("-c:{out}"), "copy"]);
                let tag = match v.codec.as_str() {
                    "hevc" => Some("hvc1"),
                    "h264" => Some("avc1"),
                    _ => None,
                };
                if let Some(tag) = tag {
                    codecs.extend(args![format!("-tag:{out}"), tag]);
                }
                out += 1;
            }
            0
        }
    };
    for s in probe.streams.iter().filter(|s| s.kind == "audio") {
        a.extend(args!["-map", format!("{source}:{}", s.index)]);
        if PHONE_AUDIO.contains(&s.codec.as_str()) {
            codecs.extend(args![format!("-c:{out}"), "copy"]);
        } else {
            codecs.extend(args![format!("-c:{out}"), "eac3", format!("-b:{out}"), "640k"]);
            if s.channels > 6 {
                codecs.extend(args![format!("-ac:{out}"), "6"]);
            }
        }
        out += 1;
    }
    for s in probe.streams.iter().filter(|s| s.kind == "subtitle" && TEXT_SUBTITLES.contains(&s.codec.as_str())) {
        a.extend(args!["-map", format!("{source}:{}", s.index)]);
        codecs.extend(args![format!("-c:{out}"), "mov_text"]);
        out += 1;
    }
    a.extend(codecs);
    if source == 1 && probe.start != 0.0 {
        a.extend(args!["-output_ts_offset", format!("{}", -probe.start)]);
    }
    a.extend(args!["-movflags", "+faststart", "-max_muxing_queue_size", "9999", output]);
    passes.push(a);
    passes
}

// ---------------------------------------------------------------------------------------------
// Scanning the libraries.

async fn scan(state: &State) {
    let found = tokio::task::spawn_blocking(|| {
        let mut found = Vec::new();
        for (library, _) in LIBRARIES {
            walk(&media_root().join(library), &mut found);
        }
        found
    })
    .await
    .unwrap_or_default();
    // An unmounted drive looks empty; don't forget everything over it.
    if found.is_empty() {
        return;
    }
    let now = now_ms();
    let busy = state.conversions.job.lock().unwrap().as_ref().map(|j| j.path.clone());
    // With each file, its entry as it was: probing takes a while, and the worker may finish one
    // meanwhile, whose Done mustn't be overwritten.
    type Seen = Option<(Verdict, u64, i64)>;
    let to_probe: Vec<(String, u64, i64, Seen)> = {
        let mut saved = state.conversions.saved.lock().unwrap();
        let present: std::collections::HashSet<&str> = found.iter().map(|(p, ..)| p.as_str()).collect();
        // What's done stays for the totals; the rest of what's gone is forgotten.
        saved.files.retain(|p, e| e.verdict == Verdict::Done || present.contains(p.as_str()));
        found
            .iter()
            .filter(|(p, size, mtime)| {
                busy.as_deref() != Some(p.as_str())
                    && now - mtime >= SETTLE_MS
                    && saved.files.get(p).is_none_or(|e| (e.size, e.mtime) != (*size, *mtime))
            })
            .map(|(p, size, mtime)| {
                let was = saved.files.get(p).map(|e| (e.verdict, e.size, e.mtime));
                (p.clone(), *size, *mtime, was)
            })
            .collect()
    };
    for (path, size, mtime, was) in to_probe {
        let (verdict, action, reason) = match probe(&path).await.map(|p| decide(&path, &p)) {
            Ok(Ok(action)) => (Verdict::Queued, Some(action), None),
            Ok(Err(why)) => (Verdict::Skipped, None, Some(why)),
            Err(e) => (Verdict::Failed, None, Some(e)),
        };
        let mut saved = state.conversions.saved.lock().unwrap();
        if saved.files.get(&path).map(|e| (e.verdict, e.size, e.mtime)) != was {
            continue;
        }
        match saved.files.get_mut(&path) {
            // A converted file that's since been touched keeps its history.
            Some(e) if e.verdict == Verdict::Done && verdict == Verdict::Skipped => {
                (e.size, e.mtime) = (size, mtime);
            }
            _ => {
                let at = (verdict == Verdict::Failed).then_some(now_ms());
                let entry = Entry { size, mtime, verdict, action, reason, old_size: None, new_size: None, at };
                saved.files.insert(path, entry);
            }
        }
    }
    let saved = state.conversions.saved.lock().unwrap();
    state.conversions.save(&saved);
    drop(saved);
    state.conversions.work.notify_one();
}

// ---------------------------------------------------------------------------------------------
// Converting a file.

enum Outcome {
    Done { path: String, old_size: u64, new_size: u64, action: Action },
    Skipped(String),
    Failed(String),
    /// Game mode wanted the GPU; it's tried again later.
    Stopped,
    /// The file changed or went away; the next scan looks at it afresh.
    Forget,
}

enum RunError {
    Failed(String),
    Stopped,
}

/// Whether one of Jellyfin's own ffmpegs has the GPU, read from the command lines in /proc.
fn jellyfin_on_gpu() -> bool {
    let Ok(dir) = std::fs::read_dir("/proc") else { return false };
    dir.flatten().any(|e| {
        let Ok(cmdline) = std::fs::read(e.path().join("cmdline")) else { return false };
        let mut args = cmdline.split(|&b| b == 0).map(String::from_utf8_lossy);
        args.next().is_some_and(|a| a.contains("jellyfin-ffmpeg"))
            && args.any(|a| a.contains(RENDER_NODE) || a.contains("vaapi"))
    })
}

/// `pid` and everything under it. ffmpeg runs under bwrap (and bwrap's init in the sandbox's pid
/// namespace), so pausing the child alone stopped only bwrap and left ffmpeg on the GPU
/// (2026-10-25 to 2026-10-27).
fn process_tree(pid: libc::pid_t) -> Vec<libc::pid_t> {
    let parents: Vec<(libc::pid_t, libc::pid_t)> = crate::kernel::names("/proc")
        .iter()
        .filter_map(|n| n.parse().ok())
        .filter_map(|p| {
            let stat = crate::kernel::read(format!("/proc/{p}/stat"))?;
            // The name in parentheses may hold spaces; the state and then the parent follow it.
            let ppid = stat.rsplit_once(')')?.1.split_whitespace().nth(1)?.parse().ok()?;
            Some((p, ppid))
        })
        .collect();
    let mut tree = vec![pid];
    let mut i = 0;
    while i < tree.len() {
        let p = tree[i];
        tree.extend(parents.iter().filter(|&&(_, parent)| parent == p).map(|&(child, _)| child));
        i += 1;
    }
    tree
}

/// What's holding the conversions back for the GPU's sake: who Jellyfin transcodes for, or a
/// background task when one of its ffmpegs is on the GPU anyway.
fn gpu_hold(state: &State) -> Option<String> {
    state.jellyfin.transcoding_for().or_else(|| jellyfin_on_gpu().then(|| BACKGROUND_TASK.into()))
}

/// Runs ffmpeg in its scope, following its progress, until it finishes or game mode stops it.
/// It sees only `input` and the cache folder it writes to.
async fn run_ffmpeg(state: &State, input: &str, args: Vec<String>) -> Result<(), RunError> {
    let unit = scope_unit();
    let cache = cache_dir();
    let (program, sandbox) = sandboxed(ffmpeg(), &[input], &[&cache.to_string_lossy()]);
    let mut command = if unit.is_empty() {
        let mut c = tokio::process::Command::new(program);
        c.args(sandbox);
        c
    } else {
        let mut c = tokio::process::Command::new("systemd-run");
        // A name per run: the CPU retry straight after a failed GPU run could otherwise find the
        // old scope not yet collected, and fail a good file.
        c.args(["--user", "--scope", "--quiet", "--collect"])
            .arg(format!("--unit={unit}-{}", now_ms()))
            .args(["-p", "CPUWeight=20", "-p", "IOWeight=20", "-p", "MemoryHigh=1G", "-p", "MemoryMax=3G", "--"])
            .arg(program)
            .args(sandbox);
        c
    };
    let mut child = command
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| RunError::Failed(format!("Couldn't run ffmpeg: {e}")))?;
    let mut out = BufReader::new(child.stdout.take().unwrap()).lines();
    let mut err = BufReader::new(child.stderr.take().unwrap()).lines();
    let (mut out_open, mut err_open) = (true, true);
    let mut errors: Vec<String> = Vec::new();
    let mut check = tokio::time::interval(GAME_CHECK);
    // With --scope, systemd-run becomes what it runs: bwrap, with ffmpeg below it.
    let pid = child.id().map(|p| p as libc::pid_t);
    let mut held = false;
    while out_open || err_open {
        tokio::select! {
            l = out.next_line(), if out_open => match l.ok().flatten() {
                Some(line) => on_progress(state, &line),
                None => out_open = false,
            },
            l = err.next_line(), if err_open => match l.ok().flatten() {
                Some(line) if !line.trim().is_empty() => {
                    errors.push(line.trim().to_owned());
                    if errors.len() > 20 {
                        errors.remove(0);
                    }
                }
                Some(_) => {}
                None => err_open = false,
            },
            _ = check.tick() => {
                if state.game_mode.active() {
                    let _ = child.kill().await;
                    return Err(RunError::Stopped);
                }
                let hold = gpu_hold(state);
                if let Some(pid) = pid && hold.is_some() != held {
                    held = hold.is_some();
                    println!("{} converting while Jellyfin uses the GPU", if held { "Paused" } else { "Resumed" });
                    for p in process_tree(pid) {
                        // SAFETY: signals the child this owns and what it started, which
                        // kill_on_drop (and bwrap's --die-with-parent) take down with it.
                        unsafe { libc::kill(p, if held { libc::SIGSTOP } else { libc::SIGCONT }) };
                    }
                    if let Some(job) = state.conversions.job.lock().unwrap().as_mut() {
                        (job.held_for, job.progressed_at) = (hold, now_ms());
                    }
                }
            },
        }
    }
    let status = child.wait().await.map_err(|e| RunError::Failed(e.to_string()))?;
    if status.success() {
        return Ok(());
    }
    if state.game_mode.active() {
        return Err(RunError::Stopped);
    }
    Err(RunError::Failed(errors.pop().unwrap_or_else(|| format!("ffmpeg stopped ({status})"))))
}

/// One `key=value` line of ffmpeg's `-progress` output.
fn on_progress(state: &State, line: &str) {
    let Some((key, value)) = line.split_once('=') else {
        return;
    };
    let mut job = state.conversions.job.lock().unwrap();
    let Some(job) = job.as_mut() else {
        return;
    };
    match key {
        "out_time_us" => {
            let done = value.parse::<f64>().unwrap_or(0.0).max(0.0) / 1e6;
            if done > job.done {
                job.progressed_at = now_ms();
            }
            job.done = done;
        }
        "fps" => job.fps = value.parse().unwrap_or(0.0),
        "speed" => job.speed = value.trim_end_matches('x').trim().parse().unwrap_or(0.0),
        "total_size" => job.written = value.parse().unwrap_or(0),
        _ => {}
    }
}

/// Whether the converted file holds the whole video: ffmpeg can exit cleanly on a damaged source
/// and leave a cut-short file, which would then replace the original.
fn check_output(source: &Probe, made: &Probe) -> Result<(), String> {
    if made.video().is_none() {
        return Err("it has no video".into());
    }
    let audio = |p: &Probe| p.streams.iter().filter(|s| s.kind == "audio").count();
    if audio(made) != audio(source) {
        return Err(format!("it has {} audio tracks instead of {}", audio(made), audio(source)));
    }
    if made.duration <= 0.0 {
        return Err("its length can't be read".into());
    }
    if source.duration > 0.0 && (made.duration - source.duration).abs() > (source.duration * 0.01).max(2.0) {
        return Err(format!("it's {:.0} s long instead of {:.0} s", made.duration, source.duration));
    }
    Ok(())
}

/// Waits while Jellyfin plays the original: a player reading it in ranges would otherwise seek
/// into a different file once it's swapped.
async fn wait_until_unplayed(state: &State, original: &Path) {
    let Ok(relative) = original.strip_prefix(media_root()) else { return };
    let seen_as = Path::new(crate::jellyfin::MEDIA_IN_CONTAINER).join(relative).to_string_lossy().into_owned();
    let started = std::time::Instant::now();
    loop {
        let playing = match crate::jellyfin::playing_paths(state).await {
            Ok(paths) => paths.contains(&seen_as),
            // Better a seek that fails than a queue that never moves.
            Err(e) => {
                eprintln!("Couldn't ask Jellyfin what's playing: {e}");
                false
            }
        };
        let waited = started.elapsed() >= PLAYING_WAIT;
        if let Some(job) = state.conversions.job.lock().unwrap().as_mut() {
            job.held_for = (playing && !waited).then(|| "someone watching it".into());
            job.progressed_at = now_ms();
        }
        if !playing || waited {
            return;
        }
        tokio::time::sleep(Duration::from_secs(30)).await;
    }
}

/// Moves `made` into the original's place as an MP4, unless the original changed meanwhile.
fn replace(original: &Path, made: &Path, seen: (u64, i64)) -> Result<PathBuf, Outcome> {
    let Ok(meta) = std::fs::metadata(original) else {
        return Err(Outcome::Forget);
    };
    if (meta.len(), mtime_ms(&meta)) != seen {
        return Err(Outcome::Forget);
    }
    let target = original.with_extension("mp4");
    if target != original && target.exists() {
        return Err(Outcome::Failed("There's already an MP4 with its name".into()));
    }
    let failed = |e: std::io::Error| Outcome::Failed(format!("Couldn't replace the original: {e}"));
    // The server's umask keeps what it makes private, but Jellyfin reads it as another user.
    std::fs::set_permissions(made, std::fs::Permissions::from_mode(meta.mode() & 0o777)).map_err(failed)?;
    std::fs::rename(made, &target).map_err(failed)?;
    if target != original
        && let Err(e) = std::fs::remove_file(original)
    {
        eprintln!("Couldn't remove {} after converting it: {e}", original.display());
    }
    Ok(target)
}

async fn convert(state: &State, path: &str) -> Outcome {
    let original = Path::new(path);
    let Ok(meta) = std::fs::metadata(original) else {
        return Outcome::Forget;
    };
    let seen = (meta.len(), mtime_ms(&meta));
    let probe = match probe(path).await {
        Ok(p) => p,
        Err(e) => return Outcome::Failed(e),
    };
    let mut action = match decide(path, &probe) {
        Ok(a) => a,
        Err(why) => return Outcome::Skipped(why),
    };
    let video = probe.video().cloned().unwrap_or_default();
    let cache = cache_dir();
    let _ = std::fs::remove_dir_all(&cache);
    if let Err(e) = std::fs::create_dir_all(&cache) {
        return Outcome::Failed(format!("Couldn't make {}: {e}", cache.display()));
    }
    let stem = original.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "video".into());
    let made = cache.join(format!("{stem}.mp4"));
    let made_str = made.to_string_lossy().into_owned();

    *state.conversions.job.lock().unwrap() = Some(Job {
        path: path.to_owned(),
        started_at: now_ms(),
        old_size: seen.0,
        duration: probe.duration,
        done: 0.0,
        fps: 0.0,
        speed: 0.0,
        written: 0,
        progressed_at: now_ms(),
        held_for: None,
    });
    println!("Converting ({action:?}) {path}");
    let mut gpu_decode = gpu_decodes(&video);
    let outcome = loop {
        if let Some(job) = state.conversions.job.lock().unwrap().as_mut() {
            (job.done, job.written, job.progressed_at) = (0.0, 0, now_ms());
        }
        let mut ran = Ok(());
        for pass in ffmpeg_passes(path, &made_str, &probe, action, gpu_decode) {
            ran = run_ffmpeg(state, path, pass).await;
            if ran.is_err() {
                break;
            }
        }
        match ran {
            Err(RunError::Stopped) => break Outcome::Stopped,
            // The GPU can't decode everything it claims to; the CPU can.
            Err(RunError::Failed(e)) if action == Action::Encode && gpu_decode => {
                println!("Decoding on the GPU failed ({e}); trying the CPU");
                gpu_decode = false;
            }
            Err(RunError::Failed(e)) => break Outcome::Failed(e),
            Ok(()) => {
                // An encode's video on its own, from the first run.
                let _ = std::fs::remove_file(format!("{made_str}.video.ts"));
                let new_size = std::fs::metadata(&made).map(|m| m.len()).unwrap_or(0);
                let ratio = new_size as f64 / seen.0.max(1) as f64;
                if action == Action::Encode && !(KEEP_RATIO.0..=KEEP_RATIO.1).contains(&ratio) {
                    let _ = std::fs::remove_file(&made);
                    if video.codec == "h264" && extension(path) != "mp4" {
                        println!("Converting {path} came to {:.0}%; remuxing it instead", ratio * 100.0);
                        action = Action::Remux;
                        continue;
                    }
                    break Outcome::Skipped(format!("Converting it came to {:.0}% of its size, so it's kept as it is", ratio * 100.0));
                }
                let checked = match self::probe(&made_str).await {
                    Ok(p) => check_output(&probe, &p),
                    Err(e) => Err(e),
                };
                if let Err(why) = checked {
                    break Outcome::Failed(format!("The converted file didn't check out, so the original is kept: {why}"));
                }
                wait_until_unplayed(state, original).await;
                break match replace(original, &made, seen) {
                    Ok(target) => Outcome::Done {
                        path: target.to_string_lossy().into_owned(),
                        old_size: seen.0,
                        new_size,
                        action,
                    },
                    Err(o) => o,
                };
            }
        }
    };
    let _ = std::fs::remove_dir_all(&cache);
    *state.conversions.job.lock().unwrap() = None;
    outcome
}

/// The library and the app that manages a file.
fn library_of(path: &str) -> Option<(&'static str, &'static str)> {
    let root = media_root();
    LIBRARIES
        .iter()
        .find(|(library, _)| Path::new(path).starts_with(root.join(library)))
        .copied()
}

async fn record(state: &State, path: &str, outcome: Outcome) {
    let now = now_ms();
    let mut rescan = None;
    match &outcome {
        Outcome::Failed(why) => state.conversions.failures.lock().unwrap().push(why.clone()),
        Outcome::Done { .. } | Outcome::Skipped(_) => state.conversions.failures.lock().unwrap().clear(),
        Outcome::Stopped | Outcome::Forget => {}
    }
    {
        let mut saved = state.conversions.saved.lock().unwrap();
        match outcome {
            Outcome::Done { path: new_path, old_size, new_size, action } => {
                println!("Converted {path} → {new_path} ({old_size} → {new_size} bytes)");
                saved.files.remove(path);
                let mtime = std::fs::metadata(&new_path).map(|m| mtime_ms(&m)).unwrap_or(now);
                let entry = Entry {
                    size: new_size,
                    mtime,
                    verdict: Verdict::Done,
                    action: Some(action),
                    reason: None,
                    old_size: Some(old_size),
                    new_size: Some(new_size),
                    at: Some(now),
                };
                saved.files.insert(new_path.clone(), entry);
                rescan = Some(new_path);
            }
            Outcome::Skipped(why) | Outcome::Failed(why) if !saved.files.contains_key(path) => {
                eprintln!("{path}: {why}");
            }
            Outcome::Skipped(why) => {
                println!("Left {path} as it is: {why}");
                let e = saved.files.get_mut(path).unwrap();
                (e.verdict, e.reason, e.at) = (Verdict::Skipped, Some(why), Some(now));
            }
            Outcome::Failed(why) => {
                eprintln!("Couldn't convert {path}: {why}");
                if let Some(e) = saved.files.get_mut(path) {
                    (e.verdict, e.reason, e.at) = (Verdict::Failed, Some(why), Some(now));
                }
            }
            Outcome::Stopped => println!("Stopped converting {path} for game mode"),
            Outcome::Forget => {
                println!("{path} changed while converting; it's looked at again on the next scan");
                saved.files.remove(path);
            }
        }
        state.conversions.save(&saved);
    }
    if let Some(new_path) = rescan
        && let Some((_, app)) = library_of(&new_path)
    {
        let in_app = Path::new("/data").join(Path::new(&new_path).strip_prefix(media_root()).unwrap_or(Path::new("")));
        if let Err(e) = crate::media::rescan(state, app, &in_app.to_string_lossy()).await {
            eprintln!("Couldn't have {app} rescan {new_path}: {e}");
        }
    }
}

/// The next file to convert, unless it's paused, game mode is on or Jellyfin is using the GPU.
/// Files still hard-linked to a seeding download wait: converting one would free nothing until
/// the torrent goes, and use room for the new copy meanwhile.
fn next(state: &State) -> Option<String> {
    if state.game_mode.active() || gpu_hold(state).is_some() {
        return None;
    }
    let queued: Vec<String> = {
        let saved = state.conversions.saved.lock().unwrap();
        if saved.paused {
            return None;
        }
        saved.files.iter().filter(|(_, e)| e.verdict == Verdict::Queued).map(|(p, _)| p.clone()).collect()
    };
    // Looked at outside the lock, which the summary and the scan need meanwhile.
    queued.into_iter().find(|p| std::fs::metadata(p).map_or(true, |m| m.nlink() <= 1))
}

/// Watches the libraries' folders for videos arriving, changing and going, on a thread of its own.
fn watch_libraries(changed: impl Fn() + Send + 'static) {
    use inotify::{Inotify, WatchMask};
    let mask = WatchMask::CREATE | WatchMask::CLOSE_WRITE | WatchMask::MOVED_TO | WatchMask::MOVED_FROM | WatchMask::DELETE | WatchMask::ATTRIB;
    std::thread::spawn(move || {
        loop {
            let result = (|| -> std::io::Result<()> {
                let mut inotify = Inotify::init()?;
                type Dirs = std::collections::HashMap<inotify::WatchDescriptor, PathBuf>;
                let mut dirs = Dirs::default();
                /// Watches `dir`, then the folders in it, so one made in between isn't missed.
                fn add(inotify: &mut Inotify, dirs: &mut Dirs, dir: &Path, mask: WatchMask) {
                    match inotify.watches().add(dir, mask) {
                        Ok(wd) => {
                            dirs.insert(wd, dir.to_owned());
                        }
                        Err(e) => {
                            eprintln!("Couldn't watch {}: {e}", dir.display());
                            return;
                        }
                    }
                    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
                        if !entry.file_name().to_string_lossy().starts_with('.') && entry.file_type().is_ok_and(|t| t.is_dir()) {
                            add(inotify, dirs, &entry.path(), mask);
                        }
                    }
                }
                for (library, _) in LIBRARIES {
                    add(&mut inotify, &mut dirs, &media_root().join(library), mask);
                }
                println!("Watching the libraries ({} folders)", dirs.len());
                let mut buffer = [0; 8192];
                loop {
                    let mut new_dirs = Vec::new();
                    let mut relevant = false;
                    for event in inotify.read_events_blocking(&mut buffer)? {
                        let Some(name) = event.name.map(|n| n.to_string_lossy().into_owned()) else {
                            continue;
                        };
                        if name.starts_with('.') {
                            continue;
                        }
                        let is_dir = event.mask.contains(inotify::EventMask::ISDIR);
                        if is_dir && event.mask.intersects(inotify::EventMask::CREATE | inotify::EventMask::MOVED_TO)
                            && let Some(parent) = dirs.get(&event.wd)
                        {
                            new_dirs.push(parent.join(&name));
                        }
                        relevant |= is_dir || EXTENSIONS.contains(&extension(&name).as_str());
                    }
                    for d in new_dirs {
                        add(&mut inotify, &mut dirs, &d, mask);
                    }
                    if relevant {
                        changed();
                    }
                }
            })();
            if let Err(e) = result {
                eprintln!("Watching the libraries failed: {e}");
            }
            std::thread::sleep(Duration::from_secs(5 * 60));
        }
    });
}

/// Scans when the libraries change and every half hour, and converts what's queued one file at a
/// time.
pub fn start(state: State) {
    tokio::spawn(async move {
        // A conversion left running by the last server is in its own scope, so it outlived it.
        // Cleared before either loop starts, or the first files fail on the old scope or folder.
        let unit = scope_unit();
        if !unit.is_empty() {
            let stop = args!["--user", "stop", format!("{unit}.scope"), format!("{unit}-*.scope")];
            let _ = run("systemctl", &stop, Duration::from_secs(30)).await;
        }
        let _ = std::fs::remove_dir_all(cache_dir());
        let scanner = state.clone();
        let watcher = state.clone();
        watch_libraries(move || watcher.conversions.changed.notify_one());
        tokio::spawn(async move {
            // A file is only looked at once it has gone this long unchanged.
            let settle = Duration::from_millis(SETTLE_MS as u64) + Duration::from_secs(5);
            loop {
                scan(&scanner).await;
                let mut due = tokio::time::Instant::now() + SCAN_EVERY;
                loop {
                    tokio::select! {
                        _ = tokio::time::sleep_until(due) => break,
                        _ = scanner.conversions.rescan.notified() => break,
                        _ = scanner.conversions.changed.notified() => {
                            due = due.min(tokio::time::Instant::now() + settle);
                        }
                    }
                }
            }
        });
        loop {
            let Some(path) = next(&state) else {
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(30)) => {}
                    _ = state.conversions.work.notified() => {}
                }
                continue;
            };
            let outcome = convert(&state, &path).await;
            let stopped = matches!(outcome, Outcome::Stopped);
            record(&state, &path, outcome).await;
            if stopped {
                tokio::time::sleep(Duration::from_secs(30)).await;
            }
        }
    });
}

/// What's wrong with the conversions, for the server's problem notifications: a file that's stopped
/// getting anywhere, or a run of failures (as when an update breaks ffmpeg or the GPU driver).
pub fn problems(state: &State, now: i64) -> Vec<(String, String)> {
    let mut out = Vec::new();
    if let Some(job) = state.conversions.job.lock().unwrap().as_ref()
        && job.held_for.is_none()
        && now - job.progressed_at >= STUCK_MS
    {
        let file = describe(&job.path)["file"].as_str().unwrap_or_default().to_owned();
        out.push(("conversions:stuck".into(), format!("Converting {file} has stopped making progress")));
    }
    let failures = state.conversions.failures.lock().unwrap();
    if failures.len() >= FAILURES_REPORTED {
        let why = &failures[FAILURES_REPORTED - 1];
        out.push(("conversions:failing".into(), format!("Conversions keep failing: {why}")));
    }
    out
}

// ---------------------------------------------------------------------------------------------
// The Requests app's Conversions screen.

/// A file's name without the extension, and whether it's a show.
fn describe(path: &str) -> Map<String, Value> {
    let stem = Path::new(path).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let mut m = Map::new();
    m.insert("file".into(), json!(stem));
    m.insert("show".into(), json!(library_of(path).is_some_and(|(l, _)| l == "Shows")));
    m
}

fn eta(seconds: f64) -> String {
    let s = seconds.max(0.0).round() as u64;
    format!("{}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60)
}

pub fn summary(state: &State) -> Value {
    let saved = state.conversions.saved.lock().unwrap();
    let (mut queued, mut done, mut skipped, mut failed) = (0, 0, 0, 0);
    let mut saved_bytes = 0.0;
    let mut recent: Vec<(&String, &Entry)> = Vec::new();
    let mut errors: Vec<(&String, &Entry)> = Vec::new();
    for (path, e) in &saved.files {
        match e.verdict {
            Verdict::Queued => queued += 1,
            Verdict::Skipped => skipped += 1,
            Verdict::Done => {
                done += 1;
                if let (Some(old), Some(new)) = (e.old_size, e.new_size) {
                    saved_bytes += old as f64 - new as f64;
                }
                recent.push((path, e));
            }
            Verdict::Failed => {
                failed += 1;
                errors.push((path, e));
            }
        }
    }
    let newest = |list: &mut Vec<(&String, &Entry)>| list.sort_by_key(|(_, e)| std::cmp::Reverse(e.at.unwrap_or(0)));
    newest(&mut recent);
    newest(&mut errors);
    let recent: Vec<Value> = recent
        .iter()
        .take(30)
        .map(|(path, e)| {
            let mut m = describe(path);
            m.insert("oldSize".into(), json!(e.old_size.unwrap_or(0)));
            m.insert("newSize".into(), json!(e.new_size.unwrap_or(0)));
            if let Some(at) = e.at {
                m.insert("at".into(), json!(at));
            }
            Value::Object(m)
        })
        .collect();
    let errors: Vec<Value> = errors
        .iter()
        .take(30)
        .map(|(path, e)| {
            let mut m = describe(path);
            if let Some(at) = e.at {
                m.insert("at".into(), json!(at));
            }
            if let Some(r) = &e.reason {
                m.insert("reason".into(), json!(r));
            }
            Value::Object(m)
        })
        .collect();
    let workers: Vec<Value> = state
        .conversions
        .job
        .lock()
        .unwrap()
        .iter()
        .map(|j| {
            let fraction = if j.duration > 0.0 { (j.done / j.duration).clamp(0.0, 1.0) } else { 0.0 };
            let mut m = describe(&j.path);
            m.insert("percent".into(), json!(fraction * 100.0));
            // Always there: the app reads it as a string. 0:00:00 shows as no estimate.
            let left = if j.speed > 0.0 { (j.duration - j.done) / j.speed } else { 0.0 };
            m.insert("eta".into(), json!(eta(left)));
            m.insert("fps".into(), json!(j.fps));
            m.insert("startedAt".into(), json!(j.started_at));
            m.insert("oldSize".into(), json!(j.old_size));
            if fraction > 0.01 {
                m.insert("estSize".into(), json!((j.written as f64 / fraction).round()));
            }
            if let Some(user) = &j.held_for {
                m.insert("heldFor".into(), json!(user));
            }
            Value::Object(m)
        })
        .collect();
    // Who Jellyfin is transcoding for, when that's holding the conversions up.
    let held_for = gpu_hold(state).filter(|_| !saved.paused && (queued > 0 || !workers.is_empty()));
    json!({
        "paused": saved.paused,
        "gameMode": state.game_mode.active(),
        "heldFor": held_for,
        "workers": workers,
        "counts": { "queued": queued, "done": done, "skipped": skipped, "failed": failed },
        "savedBytes": saved_bytes,
        "recent": recent,
        "errors": errors,
    })
}

pub async fn get(AxumState(state): AxumState<State>) -> Json<Value> {
    Json(summary(&state))
}

/// `{ paused }` pauses after the file it's on, or resumes; `{ retry: true }` looks at the failed
/// files again.
pub async fn set(AxumState(state): AxumState<State>, body: Bytes) -> Result<Json<Value>, HttpError> {
    let body = json_body(&body)?;
    if let Some(paused) = body.get("paused").and_then(Value::as_bool) {
        println!("conversions paused {paused}");
        let mut saved = state.conversions.saved.lock().unwrap();
        saved.paused = paused;
        state.conversions.save(&saved);
        drop(saved);
        state.conversions.work.notify_one();
    } else if body.get("retry") == Some(&Value::Bool(true)) {
        println!("conversions retry");
        let mut saved = state.conversions.saved.lock().unwrap();
        saved.files.retain(|_, e| e.verdict != Verdict::Failed);
        state.conversions.save(&saved);
        drop(saved);
        state.conversions.rescan.notify_one();
    } else {
        return Err(HttpError(StatusCode::BAD_REQUEST, "Expected { paused: true | false } or { retry: true }".into()));
    }
    Ok(Json(summary(&state)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stream(index: u64, kind: &str, codec: &str) -> Stream {
        Stream { index, kind: kind.into(), codec: codec.into(), pix_fmt: "yuv420p".into(), ..Stream::default() }
    }

    fn probe_of(streams: Vec<Stream>) -> Probe {
        Probe { duration: 60.0, start: 0.0, streams }
    }

    #[test]
    fn output_checks() {
        let source = probe_of(vec![stream(0, "video", "h264"), stream(1, "audio", "aac"), stream(2, "audio", "dts")]);
        let good = probe_of(vec![stream(0, "video", "hevc"), stream(1, "audio", "aac"), stream(2, "audio", "eac3")]);
        assert_eq!(check_output(&source, &good), Ok(()));
        let short = Probe { duration: 30.0, ..probe_of(good.streams.clone()) };
        assert!(check_output(&source, &short).is_err());
        let close = Probe { duration: 61.5, ..probe_of(good.streams.clone()) };
        assert_eq!(check_output(&source, &close), Ok(()));
        let one_audio = probe_of(vec![stream(0, "video", "hevc"), stream(1, "audio", "aac")]);
        assert!(check_output(&source, &one_audio).is_err());
        assert!(check_output(&source, &probe_of(vec![stream(0, "audio", "aac"), stream(1, "audio", "aac")])).is_err());
    }

    #[test]
    fn decisions() {
        let h264 = probe_of(vec![stream(0, "video", "h264")]);
        assert_eq!(decide("/m/a.mkv", &h264), Ok(Action::Encode));
        let mut hevc = stream(0, "video", "hevc");
        assert_eq!(decide("/m/a.mkv", &probe_of(vec![hevc.clone()])), Ok(Action::Remux));
        // hev1 in an MP4 doesn't play on the iPhone, so it's remuxed to fix the tag.
        assert_eq!(decide("/m/a.mp4", &probe_of(vec![hevc.clone()])), Ok(Action::Remux));
        hevc.tag = "hvc1".into();
        assert!(decide("/m/a.mp4", &probe_of(vec![hevc.clone()])).is_err());
        hevc.hdr = true;
        assert!(decide("/m/a.mkv", &probe_of(vec![hevc])).is_err());
        assert!(decide("/m/a.mkv", &probe_of(vec![stream(0, "video", "av1")])).is_err());
        let mut cover = stream(1, "video", "mjpeg");
        cover.picture = true;
        let with_cover = probe_of(vec![cover, stream(0, "video", "h264")]);
        assert_eq!(with_cover.video().map(|v| v.index), Some(0));
        assert!(decide("/m/a.mkv", &probe_of(vec![stream(0, "audio", "aac")])).is_err());
    }

    #[test]
    fn encode_arguments() {
        let mut dts = stream(2, "audio", "dts");
        dts.channels = 8;
        let p = probe_of(vec![
            stream(0, "video", "h264"),
            stream(1, "audio", "eac3"),
            dts,
            stream(3, "subtitle", "subrip"),
            stream(4, "subtitle", "hdmv_pgs_subtitle"),
            stream(5, "attachment", "ttf"),
        ]);
        let passes = ffmpeg_passes("in.mkv", "out.mp4", &p, Action::Encode, true);
        assert_eq!(passes.len(), 2);
        let (video, mux) = (passes[0].join(" "), passes[1].join(" "));
        assert!(video.contains(
            "-copyts -hwaccel vaapi -hwaccel_device /dev/dri/renderD128 -hwaccel_output_format vaapi -protocol_whitelist file -i in.mkv"
        ));
        assert!(video.contains("-map 0:0 -c:v hevc_vaapi"));
        assert!(video.contains("-filter:v scale_vaapi=format=p010"));
        assert!(video.ends_with("-f mpegts out.mp4.video.ts"));
        assert!(!video.contains("hvc1") && !video.contains("0:1"));
        assert!(mux.contains("-copyts -protocol_whitelist file -i out.mp4.video.ts -protocol_whitelist file -i in.mkv"));
        assert!(mux.contains("-map 0:0 -map 1:1 -map 1:2 -map 1:3 -c:0 copy -tag:0 hvc1"));
        assert!(!mux.contains("1:4") && !mux.contains("1:5") && !mux.contains("vaapi"));
        assert!(mux.contains("-c:1 copy -c:2 eac3 -b:2 640k -ac:2 6 -c:3 mov_text"));
        assert!(mux.ends_with("-movflags +faststart -max_muxing_queue_size 9999 out.mp4"));
        let late = Probe { start: 1.4, ..probe_of(p.streams.clone()) };
        assert!(ffmpeg_passes("in.ts", "out.mp4", &late, Action::Encode, true)[1].join(" ").contains("-output_ts_offset -1.4"));
        let cpu = ffmpeg_passes("in.mkv", "out.mp4", &p, Action::Encode, false)[0].join(" ");
        assert!(cpu.contains("-init_hw_device vaapi=va:/dev/dri/renderD128 -filter_hw_device va -protocol_whitelist file -i"));
        assert!(cpu.contains("-filter:v format=p010le,hwupload"));
        let remux = ffmpeg_passes("in.mkv", "out.mp4", &p, Action::Remux, true);
        assert_eq!(remux.len(), 1);
        let remux = remux[0].join(" ");
        assert!(!remux.contains("vaapi") && !remux.contains("copyts"));
        assert!(remux.contains("-map 0:0 -map 0:1 -map 0:2 -map 0:3 -c:0 copy -tag:0 avc1"));
    }

    #[test]
    fn process_tree_reaches_grandchildren() {
        let mut child = std::process::Command::new("sh").args(["-c", "sh -c 'sleep 30 & wait' & wait"]).spawn().unwrap();
        std::thread::sleep(Duration::from_millis(300));
        let tree = process_tree(child.id() as libc::pid_t);
        child.kill().unwrap();
        let _ = child.wait();
        // sh → sh → sleep
        assert!(tree.len() >= 3, "{tree:?}");
    }

    #[test]
    fn probe_parsing() {
        let v = json!({
            "streams": [
                { "index": 0, "codec_type": "video", "codec_name": "hevc", "codec_tag_string": "hvc1",
                  "pix_fmt": "yuv420p10le", "color_transfer": "smpte2084", "disposition": { "attached_pic": 0 } },
                { "index": 1, "codec_type": "audio", "codec_name": "truehd", "channels": 8 },
                { "index": 2, "codec_type": "video", "codec_name": "mjpeg", "disposition": { "attached_pic": 1 } },
            ],
            "format": { "duration": "1297.296000" }
        });
        let p = parse_probe(&v);
        assert_eq!(p.duration, 1297.296);
        assert!(p.streams[0].hdr && p.streams[2].picture && !p.streams[0].picture);
        assert_eq!(p.streams[1].channels, 8);
        assert_eq!(eta(3725.0), "1:02:05");
    }
}

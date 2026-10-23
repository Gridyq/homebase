//! Drop: files sent from the phone land in ~/Downloads/Homebase, and the phone can list, fetch and
//! delete what's there, so putting a file in that folder sends it the other way. Text sent from the
//! phone goes on the clipboard, and a lone link opens in the browser instead.

use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::{Duration, UNIX_EPOCH};

use axum::Json;
use axum::body::{Body, Bytes};
use axum::extract::{Request, State as AxumState};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use unicode_normalization::UnicodeNormalization;

use crate::args;
use crate::history::num;
use crate::http::{HttpError, State};

const DROP_MAX_BYTES: u64 = 8 * 1024 * 1024 * 1024;

fn drop_dir() -> PathBuf {
    std::env::var("DROP_DIR").map_or_else(|_| home().join("Downloads/Homebase"), PathBuf::from)
}

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default())
}

fn content_type(name: &str) -> &'static str {
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "heic" => "image/heic",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

fn too_big() -> HttpError {
    HttpError(StatusCode::PAYLOAD_TOO_LARGE, "Files can be up to 8 GB".into())
}

fn gone() -> HttpError {
    HttpError(StatusCode::NOT_FOUND, "That file is gone".into())
}

/// `decodeURIComponent`: fails on a broken escape or bytes that aren't UTF-8.
pub fn decode_uri_component(raw: &str) -> Option<String> {
    let b = raw.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = raw.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `encodeURIComponent`.
pub fn encode_uri_component(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

/// A plain file name in the drop folder. Hidden names are left out so uploads in progress stay out
/// of the way.
fn drop_name(raw: &str) -> Result<String, HttpError> {
    let name: String = decode_uri_component(raw)
        .map(|n| n.nfc().collect::<String>().trim().to_owned())
        .unwrap_or_default();
    if name.is_empty() || name.encode_utf16().count() > 255 || name.starts_with('.') || name.contains(['/', '\\', '\0']) {
        return Err(HttpError(StatusCode::BAD_REQUEST, "Bad file name".into()));
    }
    Ok(name)
}

/// Milliseconds since 1970, with the fraction, as Node's `mtimeMs`.
fn mtime_ms(meta: &std::fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0.0, |d| d.as_secs() as f64 * 1000.0 + d.subsec_nanos() as f64 / 1e6)
}

pub async fn list() -> Result<Json<Value>, HttpError> {
    let dir = drop_dir();
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| HttpError::internal(e.to_string()))?;
    let mut files: Vec<(f64, Value)> = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| HttpError::internal(e.to_string()))?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !entry.file_type().is_ok_and(|t| t.is_file()) || name.starts_with('.') {
            continue;
        }
        let Ok(meta) = std::fs::metadata(entry.path()) else { continue };
        let modified = mtime_ms(&meta);
        files.push((modified, json!({ "name": name, "size": meta.len(), "modified": num(modified) })));
    }
    files.sort_by(|a, b| b.0.total_cmp(&a.0));
    let folder = dir.to_string_lossy().replacen(&*home().to_string_lossy(), "~", 1);
    Ok(Json(
        json!({ "folder": folder, "files": files.into_iter().map(|(_, f)| f).collect::<Vec<_>>() }),
    ))
}

fn notify_desktop(title: &str, body: &str) {
    let a = args!["--app-name=Homebase", "--icon=smartphone", title, body];
    tokio::spawn(async move {
        if let Err(e) = crate::command::run("notify-send", &a, Duration::from_secs(5)).await {
            eprintln!("Couldn't show a desktop notification: {e}");
        }
    });
}

/// The raw name in `/api/drop/files/{name}`.
fn raw_name(req: &Request) -> &str {
    req.uri().path().strip_prefix("/api/drop/files/").unwrap_or_default()
}

/// Writes the upload to a hidden file first, then gives it the name, or "name (2).ext" when that's
/// taken.
pub async fn receive(AxumState(_): AxumState<State>, req: Request) -> Result<Json<Value>, HttpError> {
    let name = drop_name(raw_name(&req))?;
    println!("drop {name}");
    let length = req
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    if length.is_some_and(|l| l > DROP_MAX_BYTES) {
        return Err(too_big());
    }
    let dir = drop_dir();
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| HttpError::internal(e.to_string()))?;
    let mut random = [0u8; 6];
    getrandom(&mut random);
    let part = dir.join(format!(".{}.part", random.iter().map(|b| format!("{b:02x}")).collect::<String>()));
    let result = save(req.into_body(), &part, &dir, &name).await;
    let _ = tokio::fs::remove_file(&part).await;
    let (saved, size) = result?;
    notify_desktop("Received from your phone", &saved);
    Ok(Json(json!({ "name": saved, "size": size })))
}

async fn save(body: Body, part: &std::path::Path, dir: &std::path::Path, name: &str) -> Result<(String, u64), HttpError> {
    let internal = |e: std::io::Error| HttpError::internal(e.to_string());
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(part)
        .await
        .map_err(internal)?;
    let mut size = 0u64;
    let mut stream = body.into_data_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| HttpError(StatusCode::BAD_REQUEST, e.to_string()))?;
        size += chunk.len() as u64;
        if size > DROP_MAX_BYTES {
            return Err(too_big());
        }
        file.write_all(&chunk).await.map_err(internal)?;
    }
    file.flush().await.map_err(internal)?;
    drop(file);
    // "a.tar.gz" → "a.tar (2).gz", as Node's path.parse splits it.
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    for n in 1.. {
        let saved = if n == 1 { name.to_owned() } else { format!("{stem} ({n}){ext}") };
        // Unlike rename, link won't replace a file that's already there.
        match tokio::fs::hard_link(part, dir.join(&saved)).await {
            Ok(()) => return Ok((saved, size)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(internal(e)),
        }
    }
    unreachable!()
}

fn getrandom(buf: &mut [u8]) {
    use std::io::Read;
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        let _ = f.read_exact(buf);
    }
}

pub async fn send(req: Request) -> Result<Response, HttpError> {
    let name = drop_name(raw_name(&req))?;
    let path = drop_dir().join(&name);
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&path)
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound || e.raw_os_error() == Some(libc::ELOOP) {
                gone()
            } else {
                HttpError::internal(e.to_string())
            }
        })?;
    let meta = file.metadata().map_err(|e| HttpError::internal(e.to_string()))?;
    if !meta.is_file() {
        return Err(gone());
    }
    let stream = tokio_util::io::ReaderStream::new(tokio::fs::File::from_std(file));
    let mut res = Body::from_stream(stream).into_response();
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type(&name)));
    h.insert(header::CONTENT_LENGTH, HeaderValue::from(meta.len()));
    if let Ok(v) = HeaderValue::from_str(&format!("attachment; filename*=UTF-8''{}", encode_uri_component(&name))) {
        h.insert(header::CONTENT_DISPOSITION, v);
    }
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(res)
}

pub async fn delete(req: Request) -> Result<Json<Value>, HttpError> {
    let name = drop_name(raw_name(&req))?;
    println!("drop delete {name}");
    match tokio::fs::remove_file(drop_dir().join(&name)).await {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(HttpError::internal(e.to_string())),
        _ => Ok(Json(json!({ "ok": true }))),
    }
}

/// Runs a desktop program that might stay open, and returns once it has started or failed.
async fn start_desktop(program: &str, args: &[&str], input: Option<&str>) -> Result<(), HttpError> {
    let mut child = tokio::process::Command::new(program)
        .args(args)
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| HttpError::internal(format!("spawn {program}: {e}")))?;
    if let (Some(text), Some(mut stdin)) = (input, child.stdin.take()) {
        let _ = stdin.write_all(text.as_bytes()).await;
    }
    let out = child.wait_with_output().await.map_err(|e| HttpError::internal(e.to_string()))?;
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_owned();
    Err(HttpError::internal(if stderr.is_empty() {
        format!(
            "{program} failed ({})",
            out.status.code().map_or("killed".into(), |c| c.to_string())
        )
    } else {
        stderr
    }))
}

pub async fn text(body: Bytes) -> Result<Json<Value>, HttpError> {
    let text = crate::machine::json_body(&body)?
        .get("text")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_default();
    println!("drop text");
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(HttpError(StatusCode::BAD_REQUEST, "Nothing to send".into()));
    }
    let lower = trimmed.to_ascii_lowercase();
    let link = (lower.starts_with("http://") || lower.starts_with("https://")) && !trimmed.contains(char::is_whitespace);
    if link && trimmed.split_once("://").is_some_and(|(_, rest)| !rest.is_empty()) {
        start_desktop("xdg-open", &[trimmed], None).await?;
        return Ok(Json(json!({ "action": "opened" })));
    }
    // wl-copy stays behind in the background to hand the text to whoever pastes it.
    start_desktop("wl-copy", &[], Some(&text)).await?;
    let units: Vec<u16> = trimmed.encode_utf16().collect();
    let shown = if units.len() > 200 {
        format!("{}…", String::from_utf16_lossy(&units[..200]))
    } else {
        trimmed.to_owned()
    };
    notify_desktop("Copied from your phone", &shown);
    Ok(Json(json!({ "action": "copied" })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert_eq!(drop_name("IMG%201.png").unwrap(), "IMG 1.png");
        // Decomposed é becomes the composed one.
        assert_eq!(drop_name("Caf%65%CC%81.txt").unwrap(), "Caf\u{e9}.txt");
        for bad in [".hidden", "a%2Fb", "%E0%A4%A", "%FF", "%20%20", "a\\b"] {
            assert!(drop_name(bad).is_err(), "{bad}");
        }
        assert_eq!(encode_uri_component("Café (1).png"), "Caf%C3%A9%20(1).png");
    }
}

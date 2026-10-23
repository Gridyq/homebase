//! Self-hosted update server for Homebase, implementing the Expo Updates protocol v1 (iOS only).
//! Replaced the Node server that was in `update-server/server.mjs`, and keeps serving that folder:
//!
//!   keys/private-key.pem               signs manifests; the app only accepts updates signed with it
//!   updates/<runtimeVersion>/<ms>/     one `expo export` output per update, newest wins
//!
//! Publish with `npm run publish-update` from the project root. Only loopback and Tailscale
//! addresses are answered, in case the firewall ever opens the port to the home network.
//!
//! Spec: https://docs.expo.dev/technical-specs/expo-updates-1/

use std::collections::HashMap;
use std::io::Write;
use std::net::{IpAddr, SocketAddr};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use axum::Router;
use axum::extract::{ConnectInfo, Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use md5::Digest;
use ring::rand::SystemRandom;
use ring::signature::{RSA_PKCS1_SHA256, RsaKeyPair};
use serde_json::{Value, json};

const KEY_ID: &str = "main";

const MIME: &[(&str, &str)] = &[
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("svg", "image/svg+xml"),
    ("ttf", "font/ttf"),
    ("otf", "font/otf"),
    ("woff", "font/woff"),
    ("woff2", "font/woff2"),
    ("json", "application/json"),
    ("mp3", "audio/mpeg"),
    ("wav", "audio/wav"),
    ("mp4", "video/mp4"),
];

struct Server {
    updates_dir: PathBuf,
    key_path: PathBuf,
    key: OnceLock<RsaKeyPair>,
    /// The last manifest served, keyed by update folder and base URL: hashing the bundle each
    /// time the app checks would read it all again.
    manifest: Mutex<Option<CachedManifest>>,
}

struct CachedManifest {
    dir: PathBuf,
    base_url: String,
    json: Arc<String>,
}

type Shared = Arc<Server>;

#[tokio::main]
async fn main() {
    let port: u16 = std::env::var("PORT")
        .unwrap_or_else(|_| "8787".into())
        .parse()
        .expect("PORT must be a port number");
    // `update-server/` beside this crate, without a `..`: the service's sandbox only shows that folder.
    let root = std::env::var_os("UPDATE_SERVER_DIR").map_or_else(
        || {
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .expect("crate has a parent folder")
                .join("update-server")
        },
        PathBuf::from,
    );
    if !root.join("updates").is_dir() {
        eprintln!("No updates folder in {}", root.display());
    }
    let server = Arc::new(Server {
        updates_dir: root.join("updates"),
        key_path: root.join("keys").join("private-key.pem"),
        key: OnceLock::new(),
        manifest: Mutex::new(None),
    });

    let app = Router::new()
        .route("/api/manifest", get(manifest))
        .route("/api/assets", get(asset))
        .route("/health", get(|| async { text(StatusCode::OK, "ok") }))
        .fallback(|| async { text(StatusCode::NOT_FOUND, "Not found") })
        .layer(middleware::from_fn(require_allowed_peer))
        .with_state(server);

    // `::` also takes IPv4 connections.
    let listener = tokio::net::TcpListener::bind((std::net::Ipv6Addr::UNSPECIFIED, port))
        .await
        .unwrap_or_else(|e| panic!("Couldn't listen on :{port}: {e}"));
    println!("Homebase update server listening on :{port}");
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .await
        .expect("Server stopped");
}

fn text(status: StatusCode, body: &'static str) -> Response {
    (status, [(header::CONTENT_TYPE, "text/plain")], body).into_response()
}

fn internal(error: impl std::fmt::Display) -> Response {
    eprintln!("{error}");
    text(StatusCode::INTERNAL_SERVER_ERROR, "Internal error")
}

fn protocol_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert("expo-protocol-version", HeaderValue::from_static("1"));
    headers.insert("expo-sfv-version", HeaderValue::from_static("0"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=0"));
    headers
}

fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

/// Loopback, or Tailscale's 100.64.0.0/10 and fd7a:115c:a1e0::/48.
fn allowed_peer(ip: IpAddr) -> bool {
    match ip.to_canonical() {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            v4.octets() == [127, 0, 0, 1] || (a == 100 && (64..=127).contains(&b))
        }
        IpAddr::V6(v6) => {
            let s = v6.segments();
            v6.is_loopback() || (s[0] == 0xfd7a && s[1] == 0x115c && s[2] == 0xa1e0)
        }
    }
}

async fn require_allowed_peer(ConnectInfo(peer): ConnectInfo<SocketAddr>, req: Request, next: Next) -> Response {
    if !allowed_peer(peer.ip()) {
        return text(StatusCode::FORBIDDEN, "Only reachable over Tailscale");
    }
    if req.method() != axum::http::Method::GET {
        return text(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed");
    }
    next.run(req).await
}

/// A path of plain names under a folder: no `..`, no root, nothing empty.
fn safe_join(base: &Path, relative: &str) -> Option<PathBuf> {
    let rel = Path::new(relative);
    let plain = rel.components().all(|c| matches!(c, Component::Normal(_)));
    (plain && rel.components().next().is_some()).then(|| base.join(rel))
}

fn is_update_id(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// Folder and id of the newest update for a runtime version.
fn latest_update(updates_dir: &Path, runtime_version: &str) -> Option<(PathBuf, String)> {
    let runtime_dir = safe_join(updates_dir, runtime_version)?;
    let newest = std::fs::read_dir(&runtime_dir)
        .ok()?
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|name| is_update_id(name))
        .max_by_key(|name| name.parse::<u128>().unwrap_or(0))?;
    Some((runtime_dir.join(&newest), newest))
}

fn uuid_from_hash(input: &str) -> String {
    let h = hex(ring::digest::digest(&ring::digest::SHA256, input.as_bytes()).as_ref());
    format!("{}-{}-4{}-a{}-{}", &h[0..8], &h[8..12], &h[13..16], &h[17..20], &h[20..32])
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `new Date(ms).toISOString()`.
fn iso_time(ms: i64) -> String {
    let (days, ms_of_day) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    let (h, m, s, milli) = (
        ms_of_day / 3_600_000,
        ms_of_day / 60_000 % 60,
        ms_of_day / 1000 % 60,
        ms_of_day % 1000,
    );
    format!("{year:04}-{month:02}-{day:02}T{h:02}:{m:02}:{s:02}.{milli:03}Z")
}

/// `fileMetadata.ios` from an update's `metadata.json`, and the raw file.
fn read_metadata(dir: &Path) -> Result<(Value, String), String> {
    let raw = std::fs::read_to_string(dir.join("metadata.json")).map_err(|e| format!("metadata.json: {e}"))?;
    let parsed: Value = serde_json::from_str(&raw).map_err(|e| format!("metadata.json: {e}"))?;
    Ok((parsed["fileMetadata"]["ios"].clone(), raw))
}

fn content_type(ext: Option<&str>) -> &'static str {
    match ext {
        None => "application/javascript",
        Some(ext) => MIME.iter().find(|(e, _)| *e == ext).map_or("application/octet-stream", |(_, t)| t),
    }
}

fn build_manifest(dir: &Path, update_id: &str, runtime_version: &str, base_url: &str) -> Result<String, String> {
    let (metadata, metadata_raw) = read_metadata(dir)?;
    let expo_client: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("expoConfig.json")).map_err(|e| format!("expoConfig.json: {e}"))?)
            .map_err(|e| format!("expoConfig.json: {e}"))?;

    let describe = |rel_path: &str, ext: Option<&str>| -> Result<Value, String> {
        let data = std::fs::read(dir.join(rel_path)).map_err(|e| format!("{rel_path}: {e}"))?;
        let query = form_urlencoded::Serializer::new(String::new())
            .append_pair("runtime", runtime_version)
            .append_pair("update", update_id)
            .append_pair("path", rel_path)
            .finish();
        let mut asset = serde_json::Map::new();
        asset.insert(
            "hash".into(),
            URL_SAFE_NO_PAD.encode(ring::digest::digest(&ring::digest::SHA256, &data)).into(),
        );
        asset.insert("key".into(), hex(&md5::Md5::digest(&data)).into());
        if let Some(ext) = ext {
            asset.insert("fileExtension".into(), format!(".{ext}").into());
        }
        asset.insert("contentType".into(), content_type(ext).into());
        asset.insert("url".into(), format!("{base_url}/api/assets?{query}").into());
        Ok(asset.into())
    };

    let bundle = metadata["bundle"].as_str().ok_or("metadata.json has no bundle")?;
    let assets = metadata["assets"]
        .as_array()
        .ok_or("metadata.json has no assets")?
        .iter()
        .map(|a| describe(a["path"].as_str().unwrap_or_default(), a["ext"].as_str()))
        .collect::<Result<Vec<_>, _>>()?;
    let manifest = json!({
        "id": uuid_from_hash(&format!("{runtime_version}/{update_id}/{metadata_raw}")),
        "createdAt": iso_time(update_id.parse().map_err(|_| "bad update id")?),
        "runtimeVersion": runtime_version,
        "launchAsset": describe(bundle, None)?,
        "assets": assets,
        "metadata": {},
        "extra": { "expoClient": expo_client },
    });
    Ok(manifest.to_string())
}

impl Server {
    fn sign(&self, message: &[u8]) -> Result<String, String> {
        if self.key.get().is_none() {
            let pem = std::fs::read_to_string(&self.key_path).map_err(|e| format!("{}: {e}", self.key_path.display()))?;
            let body: String = pem.lines().filter(|l| !l.starts_with("-----")).collect();
            let der = STANDARD.decode(body).map_err(|e| format!("private key: {e}"))?;
            let key = RsaKeyPair::from_der(&der)
                .or_else(|_| RsaKeyPair::from_pkcs8(&der))
                .map_err(|e| format!("private key: {e}"))?;
            let _ = self.key.set(key);
        }
        let key = self.key.get().expect("set above");
        let mut signature = vec![0; key.public().modulus_len()];
        key.sign(&RSA_PKCS1_SHA256, &SystemRandom::new(), message, &mut signature)
            .map_err(|e| format!("signing: {e}"))?;
        Ok(STANDARD.encode(signature))
    }

    fn cached_manifest(&self, dir: &Path, update_id: &str, runtime_version: &str, base_url: &str) -> Result<Arc<String>, String> {
        if let Some(cached) = &*self.manifest.lock().unwrap()
            && cached.dir == dir
            && cached.base_url == base_url
        {
            return Ok(Arc::clone(&cached.json));
        }
        let manifest = Arc::new(build_manifest(dir, update_id, runtime_version, base_url)?);
        *self.manifest.lock().unwrap() = Some(CachedManifest {
            dir: dir.to_owned(),
            base_url: base_url.to_owned(),
            json: Arc::clone(&manifest),
        });
        Ok(manifest)
    }
}

/// A multipart/mixed part: its name, extra headers and JSON body.
type Part<'a> = (&'a str, Vec<(&'a str, String)>, &'a str);

fn multipart(parts: &[Part]) -> (String, String) {
    let mut random = [0u8; 12];
    ring::rand::SecureRandom::fill(&SystemRandom::new(), &mut random).expect("random bytes");
    let boundary = format!("homebase-{}", hex(&random));
    let mut body = String::new();
    for (name, headers, part) in parts {
        body +=
            &format!("--{boundary}\r\ncontent-type: application/json; charset=utf-8\r\ncontent-disposition: form-data; name=\"{name}\"");
        for (k, v) in headers {
            body += &format!("\r\n{k}: {v}");
        }
        body += &format!("\r\n\r\n{part}\r\n");
    }
    body += &format!("--{boundary}--\r\n");
    (format!("multipart/mixed; boundary={boundary}"), body)
}

async fn manifest(State(server): State<Shared>, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap) -> Response {
    if header_str(&headers, "expo-protocol-version") != Some("1") {
        return text(StatusCode::BAD_REQUEST, "Unsupported protocol version");
    }
    if header_str(&headers, "expo-platform") != Some("ios") {
        return text(StatusCode::BAD_REQUEST, "Only ios is supported");
    }
    let Some(runtime_version) = header_str(&headers, "expo-runtime-version")
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
    else {
        return text(StatusCode::BAD_REQUEST, "Missing expo-runtime-version");
    };
    let host = header_str(&headers, "host").unwrap_or("localhost").to_owned();
    let wants_signature = headers.contains_key("expo-expect-signature");

    let result = tokio::task::spawn_blocking(move || {
        let Some((dir, update_id)) = latest_update(&server.updates_dir, &runtime_version) else {
            return Ok(None);
        };
        let manifest = server.cached_manifest(&dir, &update_id, &runtime_version, &format!("http://{host}"))?;
        let signature = if wants_signature {
            Some(server.sign(manifest.as_bytes())?)
        } else {
            None
        };
        Ok::<_, String>(Some((update_id, runtime_version, manifest, signature)))
    })
    .await;

    let peer = peer.ip().to_canonical();
    match result {
        Ok(Ok(None)) => {
            println!(
                "{peer} no update for runtime {}",
                header_str(&headers, "expo-runtime-version").unwrap_or_default()
            );
            (StatusCode::NO_CONTENT, protocol_headers()).into_response()
        }
        Ok(Ok(Some((update_id, runtime_version, manifest, signature)))) => {
            let manifest_headers = signature
                .map(|sig| vec![("expo-signature", format!("sig=\"{sig}\", keyid=\"{KEY_ID}\""))])
                .unwrap_or_default();
            let (content_type, body) = multipart(&[
                ("manifest", manifest_headers, &manifest),
                ("extensions", vec![], r#"{"assetRequestHeaders":{}}"#),
            ]);
            println!("{peer} serving update {update_id} for runtime {runtime_version}");
            let mut headers = protocol_headers();
            headers.insert(header::CONTENT_TYPE, HeaderValue::from_str(&content_type).expect("ascii boundary"));
            (StatusCode::OK, headers, body).into_response()
        }
        Ok(Err(e)) => internal(e),
        Err(e) => internal(e),
    }
}

async fn asset(State(server): State<Shared>, Query(query): Query<HashMap<String, String>>, headers: HeaderMap) -> Response {
    let get = |k: &str| query.get(k).map(String::as_str).unwrap_or_default();
    let (runtime, update, rel_path) = (get("runtime"), get("update"), get("path"));
    if !is_update_id(update) {
        return text(StatusCode::BAD_REQUEST, "Bad update id");
    }
    let Some(update_dir) = safe_join(&server.updates_dir, runtime).map(|d| d.join(update)) else {
        return text(StatusCode::BAD_REQUEST, "Bad path");
    };
    let Some(file) = safe_join(&update_dir, rel_path) else {
        return text(StatusCode::BAD_REQUEST, "Bad path");
    };
    let Ok(data) = tokio::fs::read(&file).await else {
        return text(StatusCode::NOT_FOUND, "Not found");
    };

    let gzip = header_str(&headers, "accept-encoding").is_some_and(|v| v.split(',').any(|e| e.trim().starts_with("gzip")));
    let rel_path = rel_path.to_owned();
    let result = tokio::task::spawn_blocking(move || {
        let (metadata, _) = read_metadata(&update_dir)?;
        let content_type = if metadata["bundle"].as_str() == Some(&rel_path) {
            content_type(None)
        } else {
            let file_ext = file.extension().and_then(|e| e.to_str());
            let ext = metadata["assets"]
                .as_array()
                .and_then(|assets| assets.iter().find(|a| a["path"].as_str() == Some(&rel_path)))
                .and_then(|a| a["ext"].as_str())
                .or(file_ext);
            content_type(Some(ext.unwrap_or_default()))
        };
        let data = if gzip {
            let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            encoder.write_all(&data).and_then(|_| encoder.finish()).map_err(|e| e.to_string())?
        } else {
            data
        };
        Ok::<_, String>((content_type, data))
    })
    .await;

    match result {
        Ok(Ok((content_type, data))) => {
            let mut headers = HeaderMap::new();
            headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
            headers.insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static("public, max-age=31536000, immutable"),
            );
            if gzip {
                headers.insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
            }
            (StatusCode::OK, headers, data).into_response()
        }
        Ok(Err(e)) => internal(e),
        Err(e) => internal(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn times() {
        assert_eq!(iso_time(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_time(1792780927281), "2026-10-23T18:42:07.281Z");
        assert_eq!(iso_time(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn paths() {
        let base = Path::new("/u");
        assert_eq!(safe_join(base, "assets/abc"), Some(PathBuf::from("/u/assets/abc")));
        for bad in ["", "..", "../x", "a/../../x", "/etc/passwd", "./x"] {
            assert_eq!(safe_join(base, bad), None, "{bad}");
        }
    }

    #[test]
    fn peers() {
        for ok in ["127.0.0.1", "::1", "::ffff:127.0.0.1", "100.64.0.1", "fd7a:115c:a1e0::1"] {
            assert!(allowed_peer(ok.parse().unwrap()), "{ok}");
        }
        for no in ["127.0.0.2", "100.128.0.1", "192.168.1.5", "::ffff:192.168.1.5"] {
            assert!(!allowed_peer(no.parse().unwrap()), "{no}");
        }
    }
}

//! The token every request needs, and pairing: `homebase-status pair` sends a link to the phone
//! through ntfy that fills in the app's connection settings. The link carries a one-time code
//! rather than the token, since ntfy keeps messages for days. Also the app's crash reports.

use std::path::Path;
use std::time::Duration;

use axum::Json;
use axum::body::Bytes;
use axum::extract::{ConnectInfo, State as AxumState};
use axum::http::StatusCode;
use serde_json::{Value, json};
use subtle::ConstantTimeEq;

use crate::client::form;
use crate::encoding::{base64url, random_bytes};
use crate::http::{HttpError, State, data_dir};
use crate::usage::now_ms;

const PAIRING_TTL_MS: i64 = 10 * 60_000;
/// Shorter than this (made ones are 32) and the token file is treated as broken, since an empty
/// one would match a request with no token at all.
pub const MIN_TOKEN_LEN: usize = 16;

/// Makes the token on first start, or again if the file has lost it.
pub fn ensure_token(path: &Path) {
    if std::fs::read_to_string(path).is_ok_and(|t| t.trim().len() >= MIN_TOKEN_LEN) {
        return;
    }
    let token = base64url(&random_bytes(24));
    match crate::files::write_private(path, format!("{token}\n").as_bytes()) {
        Ok(()) => println!("Created a new token in {}", path.display()),
        Err(e) => eprintln!("Couldn't create a token in {}: {e}", path.display()),
    }
}

/// Address the phone uses, sent in the pairing link.
/// The real server is reached through `tailscale serve`, which takes HTTPS on 443 and forwards
/// it to 8788; a test instance on another port is plain HTTP.
fn public_url() -> String {
    std::env::var("PUBLIC_URL").unwrap_or_else(|_| match std::env::var("PORT").as_deref() {
        Ok(port) if port != "8788" => format!("http://fedora.tail27f991.ts.net:{port}"),
        _ => "https://fedora.tail27f991.ts.net".into(),
    })
}

/// `homebase-status pair`: saves a one-time code and sends the link through ntfy.
pub async fn pair(config: &crate::Config) {
    let code = base64url(&random_bytes(24));
    let pending = json!({ "code": code, "expires": now_ms() + PAIRING_TTL_MS }).to_string();
    if let Err(e) = crate::files::write_private(&data_dir(config).join("pairing"), pending.as_bytes()) {
        eprintln!("Couldn't save the pairing code: {e}");
        return;
    }
    let link = format!("homebase://server/connect?{}", form(&[("url", &public_url()), ("code", &code)]));
    println!("Pairing link: {link}");
    let url = std::env::var("NTFY_URL").unwrap_or_else(|_| "http://localhost:2586/Homebase".into());
    let mut headers = vec![
        ("Title", "Connect Homebase to this server".to_owned()),
        ("Tags", "link".to_owned()),
        ("Click", link),
    ];
    headers.extend(crate::events::ntfy_auth().map(|auth| ("Authorization", auth)));
    let body = Bytes::from("Tap to fill in the Server mini-app settings. The link works once, within 10 minutes.");
    let client = crate::client::Upstream::new();
    match crate::client::call(
        &client,
        axum::http::Method::POST,
        &url,
        &headers,
        Some(body),
        Duration::from_secs(10),
    )
    .await
    {
        Ok(r) if r.status.is_success() => println!("Sent through ntfy."),
        Ok(r) => println!("Couldn't send through ntfy: {}", r.status.canonical_reason().unwrap_or_default()),
        Err(e) => println!("Couldn't send through ntfy: {e}"),
    }
}

/// Trades the code from a pairing link for the token. Each code works once.
pub async fn redeem(
    AxumState(state): AxumState<State>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    headers: axum::http::HeaderMap,
    body: Bytes,
) -> Result<Json<Value>, HttpError> {
    // A web page can only send JSON here after a CORS preflight, which this server never allows,
    // so a page that read the code from ntfy can't spend it.
    let json = headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(';').next().is_some_and(|t| t.trim().eq_ignore_ascii_case("application/json")));
    if !json {
        return Err(HttpError(StatusCode::UNSUPPORTED_MEDIA_TYPE, "Expected JSON".into()));
    }
    let given = crate::machine::json_body(&body)?.get("code").cloned();
    let path = data_dir(&state.config).join("pairing");
    let pending = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok());
    let now = now_ms();
    let expired = pending.as_ref().is_some_and(|p| p["expires"].as_i64().is_none_or(|e| e <= now));
    let ok = match (
        given.as_ref().and_then(Value::as_str),
        pending.as_ref().and_then(|p| p["code"].as_str()),
    ) {
        (Some(g), Some(code)) if !expired && !code.is_empty() && g.len() == code.len() => bool::from(g.as_bytes().ct_eq(code.as_bytes())),
        _ => false,
    };
    // Removing the code claims it: of two requests with it at once, only one gets to remove it.
    let ok = ok && std::fs::remove_file(&path).is_ok();
    println!("{} pairing {}", peer.ip().to_canonical(), if ok { "accepted" } else { "refused" });
    if expired {
        let _ = std::fs::remove_file(&path);
    }
    if !ok {
        return Err(HttpError(
            StatusCode::FORBIDDEN,
            "This pairing link has expired or was already used. Run pair again.".into(),
        ));
    }
    let token = std::fs::read_to_string(&state.config.token_path).map_err(|e| HttpError::internal(e.to_string()))?;
    if token.trim().len() < MIN_TOKEN_LEN {
        return Err(HttpError::internal("The server's token file is empty; restart the server to make a new one"));
    }
    Ok(Json(json!({ "token": token.trim() })))
}

/// The JS error behind the app's last crash, which iOS's own report leaves out.
pub async fn crash(ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>, body: Bytes) -> Result<Json<Value>, HttpError> {
    let report = crate::machine::json_body(&body)?.get("report").cloned();
    // String(report), as the Node server wrote it.
    let text = match report {
        None => "undefined".to_owned(),
        Some(Value::String(s)) => s,
        Some(Value::Null) => "null".to_owned(),
        Some(Value::Object(_)) => "[object Object]".to_owned(),
        Some(v) => v.to_string(),
    };
    println!(
        "{} app crash report:\n{}",
        peer.ip().to_canonical(),
        crate::assistant_tools::js_slice(&text, 8000)
    );
    Ok(Json(json!({ "ok": true })))
}

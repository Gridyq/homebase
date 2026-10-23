//! What every request goes through: the address check, the token, and errors as `{ error }`.

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use axum::Json;
use axum::extract::{ConnectInfo, Request, State as AxumState};
use axum::http::{HeaderValue, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde_json::json;
use subtle::ConstantTimeEq;

use crate::Config;
use crate::proxy::Upstream;

#[derive(Clone)]
pub struct State {
    pub config: Arc<Config>,
    pub upstream: Upstream,
    pub usage: Arc<crate::usage::Usage>,
    pub processes: Arc<crate::processes::Processes>,
    pub gpu: Arc<crate::gpu::Gpu>,
    pub services: Arc<crate::services::Services>,
    pub sampler: Arc<crate::status::Sampler>,
}

impl State {
    pub fn new(config: Arc<Config>) -> Self {
        Self {
            upstream: Upstream::new(),
            usage: Arc::new(crate::usage::Usage::new()),
            processes: Default::default(),
            gpu: Default::default(),
            services: Default::default(),
            sampler: Default::default(),
            config,
        }
    }
}

/// An error the app shows as is, like the Node server's `HttpError`.
pub struct HttpError(pub StatusCode, pub String);

impl HttpError {
    pub fn internal(message: impl Into<String>) -> Self {
        Self(StatusCode::INTERNAL_SERVER_ERROR, message.into())
    }
}

impl IntoResponse for HttpError {
    fn into_response(self) -> Response {
        json_response(self.0, json!({ "error": self.1 }))
    }
}

pub fn json_response(status: StatusCode, body: serde_json::Value) -> Response {
    let mut res = (status, Json(body)).into_response();
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

pub async fn health() -> Response {
    json_response(StatusCode::OK, json!({ "ok": true }))
}

/// Loopback, or Tailscale's 100.64.0.0/10 and fd7a:115c:a1e0::/48.
pub fn allowed_peer(ip: IpAddr) -> bool {
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

pub async fn require_allowed_peer(ConnectInfo(peer): ConnectInfo<SocketAddr>, req: Request, next: Next) -> Response {
    if !allowed_peer(peer.ip()) {
        println!("{} refused: not a Tailscale or local address", peer.ip());
        return HttpError(StatusCode::FORBIDDEN, "Only reachable over Tailscale".into()).into_response();
    }
    next.run(req).await
}

/// The token is read each time, so a new one from the Node server counts straight away.
pub async fn require_token(AxumState(state): AxumState<State>, req: Request, next: Next) -> Response {
    let Ok(expected) = tokio::fs::read_to_string(&state.config.token_path).await else {
        return HttpError::internal("The server has no token yet").into_response();
    };
    let given = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    let expected = expected.trim();
    if given.len() != expected.len() || !bool::from(given.as_bytes().ct_eq(expected.as_bytes())) {
        return HttpError(StatusCode::UNAUTHORIZED, "Wrong or missing token".into()).into_response();
    }
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::allowed_peer;

    #[test]
    fn peers() {
        for ok in [
            "127.0.0.1",
            "::1",
            "::ffff:127.0.0.1",
            "100.64.0.1",
            "100.127.255.255",
            "fd7a:115c:a1e0::1",
        ] {
            assert!(allowed_peer(ok.parse().unwrap()), "{ok}");
        }
        for no in [
            "127.0.0.2",
            "100.63.0.1",
            "100.128.0.1",
            "192.168.1.5",
            "fd7a:115c:a1e1::1",
            "::ffff:192.168.1.5",
        ] {
            assert!(!allowed_peer(no.parse().unwrap()), "{no}");
        }
    }
}

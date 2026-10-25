//! What every request goes through: the address check, the token, and errors as `{ error }`.

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use axum::Json;
use axum::extract::connect_info::Connected;
use axum::extract::{ConnectInfo, Request, State as AxumState};
use axum::http::{HeaderValue, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::serve::IncomingStream;
use tokio::net::TcpListener;
use serde_json::json;
use subtle::ConstantTimeEq;

use crate::Config;
use crate::client::Upstream;

#[derive(Clone)]
pub struct State {
    pub config: Arc<Config>,
    pub upstream: Upstream,
    pub usage: Arc<crate::usage::Usage>,
    pub processes: Arc<crate::processes::Processes>,
    pub gpu: Arc<crate::gpu::Gpu>,
    pub services: Arc<crate::services::Services>,
    pub sampler: Arc<crate::status::Sampler>,
    pub recorder: Arc<crate::recorder::Recorder>,
    pub machine: Arc<crate::machine::Machine>,
    pub game_mode: Arc<crate::gamemode::GameMode>,
    pub media: Arc<crate::media::Media>,
    pub conversions: Arc<crate::conversions::Conversions>,
    pub cleanup: Arc<crate::cleanup::Cleanup>,
    pub requests: Arc<crate::requests::Requests>,
    pub videos: Arc<crate::videos::Videos>,
    pub assistant: Arc<crate::assistant::Assistant>,
    pub jellyfin: Arc<crate::jellyfin::Jellyfin>,
    pub live: Arc<crate::live::Live>,
    pub updates: Arc<crate::updates::Updates>,
    pub container_updates: Arc<crate::container_updates::ContainerUpdates>,
}

impl State {
    pub fn new(config: Arc<Config>) -> Self {
        let upstream = Upstream::new();
        let recorder = Arc::new(crate::recorder::Recorder::new(data_dir(&config)));
        let live = crate::live::Live::new(recorder.events.lock().unwrap().feed.clone());
        Self {
            upstream: upstream.clone(),
            usage: Arc::new(crate::usage::Usage::new()),
            processes: Default::default(),
            gpu: Default::default(),
            services: Default::default(),
            sampler: Default::default(),
            recorder,
            machine: Arc::new(crate::machine::Machine::new(data_dir(&config))),
            game_mode: Arc::new(crate::gamemode::GameMode::new(data_dir(&config))),
            media: Arc::new(crate::media::Media::new()),
            conversions: Arc::new(crate::conversions::Conversions::new(data_dir(&config))),
            cleanup: Arc::new(crate::cleanup::Cleanup::new(data_dir(&config))),
            requests: Arc::new(crate::requests::Requests::new(data_dir(&config))),
            videos: Arc::new(crate::videos::Videos::new(data_dir(&config))),
            assistant: Arc::new(crate::assistant::Assistant::new(data_dir(&config))),
            jellyfin: Default::default(),
            live: Arc::new(live),
            updates: Arc::new(crate::updates::Updates::new()),
            container_updates: Arc::new(crate::container_updates::ContainerUpdates::new(data_dir(&config))),
            config,
        }
    }
}

/// Where the server keeps its files: next to the token, in `status-server/`.
pub fn data_dir(config: &Config) -> &std::path::Path {
    config.token_path.parent().unwrap_or(std::path::Path::new("."))
}

/// An error the app shows as is, like the Node server's `HttpError`.
#[derive(Debug)]
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

pub async fn not_found() -> Response {
    HttpError(StatusCode::NOT_FOUND, "Not found".into()).into_response()
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

/// Both ends of a connection. Rootless containers reach this machine's Tailscale address through
/// pasta and arrive from that same address, so a peer is only a Tailscale device when it isn't
/// the address it connected to.
#[derive(Clone, Copy, Debug)]
pub struct Conn {
    pub peer: SocketAddr,
    pub local: Option<SocketAddr>,
}

impl Connected<IncomingStream<'_, TcpListener>> for Conn {
    fn connect_info(stream: IncomingStream<'_, TcpListener>) -> Self {
        Conn { peer: *stream.remote_addr(), local: stream.io().local_addr().ok() }
    }
}

/// The machine's tailnet; its MagicDNS names end in this.
pub const TAILNET_DOMAIN: &str = "tail27f991.ts.net";

/// Why a connection is refused, if it is.
pub fn refusal(conn: Conn, host: Option<&str>) -> Option<&'static str> {
    let peer = conn.peer.ip().to_canonical();
    if !allowed_peer(peer) {
        return Some("Only reachable over Tailscale");
    }
    if !peer.is_loopback() && conn.local.is_some_and(|l| l.ip().to_canonical() == peer) {
        return Some("Not reachable from this machine's containers");
    }
    if !host.is_some_and(allowed_host) {
        return Some("Unexpected Host");
    }
    None
}

/// Against DNS rebinding: a web page can point its own name at this machine, but it can't make
/// the browser send an IP address or one of this machine's names as the Host.
pub fn allowed_host(host: &str) -> bool {
    let name = match host.strip_prefix('[') {
        Some(rest) => match rest.split_once(']') {
            Some((ip, port)) if port.is_empty() || port.strip_prefix(':').is_some_and(|p| p.parse::<u16>().is_ok()) => ip,
            _ => return false,
        },
        None => match host.rsplit_once(':') {
            Some((name, port)) if port.parse::<u16>().is_ok() => name,
            Some(_) => return false,
            None => host,
        },
    };
    let name = name.strip_suffix('.').unwrap_or(name).to_ascii_lowercase();
    name.parse::<IpAddr>().is_ok()
        || name == "localhost"
        || name.strip_suffix(TAILNET_DOMAIN).is_some_and(|n| n.ends_with('.') && n.len() > 1)
}

/// Checks [`refusal`], then hands handlers the peer as `ConnectInfo<SocketAddr>`.
pub async fn require_allowed_peer(ConnectInfo(conn): ConnectInfo<Conn>, mut req: Request, next: Next) -> Response {
    let host = req.headers().get(header::HOST).and_then(|v| v.to_str().ok());
    if let Some(why) = refusal(conn, host) {
        println!("{} refused: {why}", conn.peer.ip().to_canonical());
        return HttpError(StatusCode::FORBIDDEN, why.into()).into_response();
    }
    req.extensions_mut().insert(ConnectInfo(conn.peer));
    next.run(req).await
}

/// The token is read each time, so a new one counts straight away.
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
    if expected.len() < crate::pairing::MIN_TOKEN_LEN {
        return HttpError::internal("The server's token file is empty; restart the server to make a new one").into_response();
    }
    if given.len() != expected.len() || !bool::from(given.as_bytes().ct_eq(expected.as_bytes())) {
        return HttpError(StatusCode::UNAUTHORIZED, "Wrong or missing token".into()).into_response();
    }
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::{Conn, allowed_host, allowed_peer, refusal};

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

    #[test]
    fn hosts() {
        for ok in [
            "fedora.tail27f991.ts.net:8788",
            "FEDORA.tail27f991.ts.net.",
            "localhost:8787",
            "127.0.0.1:8788",
            "100.118.162.26",
            "[::1]:8788",
            "[fd7a:115c:a1e0::1]",
        ] {
            assert!(allowed_host(ok), "{ok}");
        }
        for no in [
            "evil.example:8788",
            "tail27f991.ts.net",
            "evil.example.tail27f991.ts.net.evil.example",
            "fedora.tail27f991.ts.net:x",
            "fedora.tail27f991.ts.net@evil.example",
            "eviltail27f991.ts.net",
            "[::1]x",
            "",
        ] {
            assert!(!allowed_host(no), "{no}");
        }
    }

    #[test]
    fn containers() {
        let conn = |peer: &str, local: &str| Conn { peer: peer.parse().unwrap(), local: Some(local.parse().unwrap()) };
        let host = Some("fedora.tail27f991.ts.net:8788");
        assert_eq!(refusal(conn("100.119.9.44:5000", "100.118.162.26:8788"), host), None);
        assert_eq!(refusal(conn("127.0.0.1:5000", "127.0.0.1:8788"), Some("localhost:8788")), None);
        assert_eq!(
            refusal(conn("[::ffff:100.118.162.26]:5000", "[::ffff:100.118.162.26]:8788"), host),
            Some("Not reachable from this machine's containers")
        );
        assert_eq!(refusal(conn("100.119.9.44:5000", "100.118.162.26:8788"), Some("evil.example")), Some("Unexpected Host"));
        assert_eq!(refusal(conn("100.119.9.44:5000", "100.118.162.26:8788"), None), Some("Unexpected Host"));
    }
}

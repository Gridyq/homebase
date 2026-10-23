//! Calls to the services on this machine (Seerr, the *arrs, qBittorrent, Tdarr, ntfy, the model),
//! with a time limit, like Node's `fetch` with `AbortSignal.timeout`.

use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, Method, Request, StatusCode};
use http_body_util::BodyExt;

use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;

/// The HTTP client for the services on this machine, shared so connections are reused.
#[derive(Clone)]
pub struct Upstream(pub Client<HttpConnector, Body>);

impl Upstream {
    pub fn new() -> Self {
        Self(Client::builder(TokioExecutor::new()).build_http())
    }
}

pub struct Reply {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Bytes,
}

impl Reply {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    pub fn is_json(&self) -> bool {
        self.headers
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|t| t.contains("json"))
    }
}

pub async fn call(
    client: &Upstream,
    method: Method,
    url: &str,
    headers: &[(&str, String)],
    body: Option<Bytes>,
    limit: Duration,
) -> Result<Reply, String> {
    let mut req = Request::builder().method(method).uri(url);
    for (k, v) in headers {
        req = req.header(*k, v);
    }
    let req = req.body(body.map_or_else(Body::empty, Body::from)).map_err(|e| e.to_string())?;
    let work = async {
        let res = client.0.request(req).await.map_err(|e| e.to_string())?;
        let (parts, body) = res.into_parts();
        let body = body.collect().await.map_err(|e| e.to_string())?.to_bytes();
        Ok::<_, String>(Reply {
            status: parts.status,
            headers: parts.headers,
            body,
        })
    };
    tokio::time::timeout(limit, work).await.map_err(|_| "timed out".to_owned())?
}

/// `application/x-www-form-urlencoded`, as `URLSearchParams` writes it.
pub fn form(pairs: &[(&str, &str)]) -> String {
    let encode = |s: &str| {
        s.bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => (b as char).to_string(),
                b' ' => "+".into(),
                _ => format!("%{b:02X}"),
            })
            .collect::<String>()
    };
    pairs
        .iter()
        .map(|(k, v)| format!("{}={}", encode(k), encode(v)))
        .collect::<Vec<_>>()
        .join("&")
}

#[cfg(test)]
mod tests {
    #[test]
    fn forms() {
        assert_eq!(super::form(&[("hashes", "a|b"), ("q", "x y&z")]), "hashes=a%7Cb&q=x+y%26z");
    }
}

//! Everything not answered here goes to the Node server. Bodies stream both ways, since Drop
//! moves large files and the Assistant streams its replies a line at a time.

use std::net::SocketAddr;

use axum::body::Body;
use axum::extract::{ConnectInfo, Request, State as AxumState};
use axum::http::{HeaderValue, Method, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use http_body_util::BodyExt;
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;

use crate::http::{HttpError, State};

#[derive(Clone)]
pub struct Upstream(Client<HttpConnector, Body>);

impl Upstream {
    pub fn new() -> Self {
        Self(Client::builder(TokioExecutor::new()).build_http())
    }
}

pub async fn forward(AxumState(state): AxumState<State>, ConnectInfo(peer): ConnectInfo<SocketAddr>, mut req: Request) -> Response {
    let path = req.uri().path_and_query().map_or("/", |p| p.as_str());
    let Ok(uri) = format!("{}{path}", state.config.upstream).parse::<Uri>() else {
        return HttpError(StatusCode::BAD_REQUEST, "Bad address".into()).into_response();
    };
    *req.uri_mut() = uri;
    // The Node server sees every request come from loopback; this says who it's really from.
    if let Ok(v) = HeaderValue::from_str(&peer.ip().to_canonical().to_string()) {
        req.headers_mut().insert("x-forwarded-for", v);
    }
    // Starting, stopping and game mode change what the dashboard shows.
    let changes_services =
        req.method() == Method::POST && (req.uri().path().starts_with("/api/services/") || req.uri().path() == "/api/game-mode");
    match state.upstream.0.request(req).await {
        Ok(res) => {
            // The Node server answers once the change is made.
            if changes_services {
                state.services.expire(&state.usage);
            }
            res.map(Body::new)
        }
        Err(e) => {
            eprintln!("Passing a request on failed: {e}");
            HttpError(StatusCode::BAD_GATEWAY, "The status server's Node part isn't answering".into()).into_response()
        }
    }
}

/// One of the Node server's endpoints, for what only it knows, such as game mode.
pub async fn get_json(state: &State, path: &str) -> Result<serde_json::Value, String> {
    node_json(state, Method::GET, path, None).await
}

/// Tells the Node server something it keeps track of, such as an action taken from the app.
pub async fn post_json(state: &State, path: &str, body: serde_json::Value) -> Result<serde_json::Value, String> {
    node_json(state, Method::POST, path, Some(body)).await
}

async fn node_json(state: &State, method: Method, path: &str, body: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
    let token = tokio::fs::read_to_string(&state.config.token_path)
        .await
        .map_err(|e| e.to_string())?;
    let req = Request::builder()
        .method(method)
        .uri(format!("{}{path}", state.config.upstream))
        .header(header::AUTHORIZATION, format!("Bearer {}", token.trim()))
        .header(header::CONTENT_TYPE, "application/json")
        .body(body.map_or_else(Body::empty, |b| Body::from(b.to_string())))
        .map_err(|e| e.to_string())?;
    let res = state.upstream.0.request(req).await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("answered {}", res.status()));
    }
    let body = res.into_body().collect().await.map_err(|e| e.to_string())?.to_bytes();
    serde_json::from_slice(&body).map_err(|e| e.to_string())
}

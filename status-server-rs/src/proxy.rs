//! Everything not answered here goes to the Node server. Bodies stream both ways, since Drop
//! moves large files and the Assistant streams its replies a line at a time.

use std::net::SocketAddr;

use axum::body::Body;
use axum::extract::{ConnectInfo, Request, State as AxumState};
use axum::http::{HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
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
    match state.upstream.0.request(req).await {
        Ok(res) => res.map(Body::new),
        Err(e) => {
            eprintln!("Passing a request on failed: {e}");
            HttpError(StatusCode::BAD_GATEWAY, "The status server's Node part isn't answering".into()).into_response()
        }
    }
}

//! Status server for Homebase's Server mini-app, being moved over from `status-server/server.mjs`
//! one group of endpoints at a time. It answers the endpoints moved so far and passes every other
//! request on to the Node server, which listens on loopback only, so the app keeps talking to one
//! address throughout.
//!
//! Like the Node server, it only answers loopback and Tailscale addresses, and its own endpoints
//! need `Authorization: Bearer <token>`, read from the token file the Node server creates.

mod cache;
mod gpu;
mod http;
mod kernel;
mod processes;
mod proxy;
mod services;
mod status;
mod usage;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::Router;
use axum::middleware;
use axum::routing::get;

pub struct Config {
    /// Where the Node server listens, for everything not answered here.
    pub upstream: String,
    pub token_path: PathBuf,
}

#[tokio::main]
async fn main() {
    let port: u16 = env_or("PORT", "8788").parse().expect("PORT must be a port number");
    let config = Arc::new(Config {
        upstream: env_or("UPSTREAM", "http://127.0.0.1:8789"),
        token_path: env_or("TOKEN_PATH", "../status-server/token").into(),
    });
    let state = http::State::new(config);
    let sampler = Arc::clone(&state.sampler);
    tokio::spawn(async move { sampler.run().await });

    let api = Router::new()
        .route("/api/status", get(status::handler))
        .route("/api/usage", get(usage::handler))
        .route("/api/processes", get(processes::handler))
        .route("/api/gpu", get(gpu::handler))
        .route_layer(middleware::from_fn_with_state(state.clone(), http::require_token));

    let app = Router::new()
        .route("/health", get(http::health))
        .merge(api)
        .fallback(proxy::forward)
        .layer(middleware::from_fn(http::require_allowed_peer))
        .with_state(state);

    // `::` also takes IPv4 connections, as Node's default listen does.
    let listener = tokio::net::TcpListener::bind((std::net::Ipv6Addr::UNSPECIFIED, port))
        .await
        .unwrap_or_else(|e| panic!("Couldn't listen on :{port}: {e}"));
    println!("Homebase status server listening on :{port}");
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .await
        .expect("Server stopped");
}

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_owned())
}

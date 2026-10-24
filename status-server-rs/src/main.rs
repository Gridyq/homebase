//! Status server for Homebase's mini-apps: the Server app's stats, services, history, drives and
//! logs; game mode; the Requests app's searches and requests, its Sonarr and Radarr calls, qBittorrent, clearing stuck downloads and converting the library;
//! Drop; Videos; keeping the containers updated; the Assistant's chats with a local model; what Jellyfin is playing; and, on a port
//! of its own, the app's over-the-air updates. Replaced the Node server that was in
//! `status-server/server.mjs`, and keeps its files in that folder: the token, history, events,
//! chats and settings. The app can keep `/api/live` open to hear of changes as they happen.
//!
//! It only answers loopback and Tailscale addresses, in case the firewall ever opens the port to
//! the home network, and every request but `/health` and pairing needs
//! `Authorization: Bearer <token>`. `homebase-status pair` sends the phone a link that fills in
//! the app's connection settings.

mod actions;
mod assistant;
mod assistant_tools;
mod cache;
mod cleanup;
mod client;
mod command;
mod container_updates;
mod conversions;
mod dbus;
mod drives;
mod drop;
mod encoding;
mod events;
mod files;
mod gamemode;
mod gpu;
mod history;
mod http;
mod jellyfin;
mod js;
mod kernel;
mod live;
mod localtime;
mod machine;
mod media;
mod pairing;
mod processes;
mod recorder;
mod requests;
mod services;
mod status;
mod updates;
mod usage;
mod videos;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::Router;
use axum::middleware;
use axum::routing::{any, get, post};

pub struct Config {
    pub token_path: PathBuf,
}

/// The token, next to which the server keeps its files: in `status-server/` beside this crate.
const DEFAULT_TOKEN_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../status-server/token");

#[tokio::main]
async fn main() {
    let port: u16 = env_or("PORT", "8788").parse().expect("PORT must be a port number");
    let config = Arc::new(Config {
        token_path: env_or("TOKEN_PATH", DEFAULT_TOKEN_PATH).into(),
    });
    if std::env::args().nth(1).as_deref() == Some("pair") {
        pairing::pair(&config).await;
        return;
    }
    pairing::ensure_token(&config.token_path);
    drop::sweep_parts();
    let data = http::data_dir(&config);
    files::sweep_temp(data);
    files::sweep_temp(&data.join("assistant"));
    let state = http::State::new(config);
    let sampler = Arc::clone(&state.sampler);
    tokio::spawn(async move { sampler.run().await });
    state.recorder.load().await;
    recorder::start(state.clone());
    tokio::spawn(gamemode::start(state.clone()));
    media::start(state.clone());
    conversions::start(state.clone());
    cleanup::start(state.clone());
    videos::start(state.clone());
    assistant::start(state.clone());
    jellyfin::start(state.clone());
    dbus::start(state.clone());
    live::start(state.clone());
    updates::start(state.clone()).await;
    container_updates::start(state.clone());

    let api = Router::new()
        .route("/api/status", get(status::handler))
        .route("/api/live", get(live::handler))
        .route("/api/jellyfin/sessions", get(jellyfin::handler))
        .route("/api/crash", post(pairing::crash))
        .route("/api/history", get(recorder::history_handler))
        .route("/api/game-mode", get(gamemode::get).post(gamemode::set))
        .route("/api/qbittorrent/limit", get(media::speed_limit).post(media::set_speed_limit))
        .route("/api/qbittorrent/seeding", get(media::seeding).post(media::set_seeding))
        .route("/api/qbittorrent/order", get(media::queue_order).post(media::set_queue_order))
        .route("/api/conversions", get(conversions::get).post(conversions::set))
        .route("/api/requests/{*rest}", any(media::requests))
        .route("/api/arr/{*rest}", any(media::arr))
        .route("/api/cleanup", get(cleanup::get))
        .route("/api/container-updates", get(container_updates::get).post(container_updates::set))
        .route("/api/drop", get(drop::list))
        .route("/api/drop/text", post(drop::text))
        .route("/api/drop/files/{name}", get(drop::send).put(drop::receive).delete(drop::delete))
        .route("/api/videos", get(videos::list).post(videos::add))
        .route("/api/videos/{id}", axum::routing::delete(videos::remove))
        .route("/api/videos/{id}/{action}", post(videos::action))
        .route("/api/assistant", get(assistant::state_handler))
        .route("/api/assistant/chats", get(assistant::list))
        .route(
            "/api/assistant/chats/{id}",
            get(assistant::get).post(assistant::ask).delete(assistant::delete),
        )
        .route("/api/assistant/chats/{id}/stop", post(assistant::stop))
        .route("/api/assistant/images", post(assistant::receive_image))
        .route("/api/assistant/images/{id}", get(assistant::send_image))
        .route("/api/cpu", get(machine::cpu))
        .route("/api/power", get(machine::power).post(machine::set_power))
        .route("/api/storage", get(machine::storage))
        .route("/api/tailscale", get(machine::tailscale))
        .route("/api/drives", get(machine::drives))
        .route("/api/network", get(recorder::network_handler))
        .route("/api/reliability", get(recorder::reliability_handler))
        .route("/api/services/{id}/logs", get(actions::logs))
        .route("/api/services/{id}/{action}", post(actions::handler))
        .route("/api/usage", get(usage::handler))
        .route("/api/processes", get(processes::handler))
        .route("/api/gpu", get(gpu::handler))
        .route_layer(middleware::from_fn_with_state(state.clone(), http::require_token));

    let app = Router::new()
        .route("/health", get(http::health))
        .route("/api/pair", post(pairing::redeem))
        .merge(api)
        .fallback(http::not_found)
        .layer(middleware::from_fn(http::require_allowed_peer))
        .with_state(state);

    // `::` also takes IPv4 connections.
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

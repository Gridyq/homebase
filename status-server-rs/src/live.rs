//! `GET /api/live?topics=status,conversions,sessions,events`: a WebSocket the app keeps open
//! instead of asking every few seconds. Each message is `{ topic, data }`, with `data` what the
//! topic's endpoint answers (`/api/status`, `/api/conversions`, `/api/jellyfin/sessions`), or for
//! `events` one new event as it's logged. A topic is sent when it's first ready and then whenever
//! it changes; the dashboard is only worked out while someone is watching it.

use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State as AxumState};
use axum::response::Response;
use serde::Deserialize;
use tokio::sync::{Notify, broadcast, watch};

use crate::http::State;

const STATUS_EVERY: Duration = Duration::from_secs(2);
const CONVERSIONS_EVERY: Duration = Duration::from_secs(1);
const PING_EVERY: Duration = Duration::from_secs(25);

/// A topic's latest JSON, or none while nobody has watched it.
pub type Feed = watch::Sender<Option<Arc<str>>>;

pub struct Live {
    pub status: Feed,
    pub conversions: Feed,
    pub sessions: Feed,
    pub events: broadcast::Sender<Arc<str>>,
    /// Something on the dashboard changed; send it now rather than at the next tick.
    pub status_changed: Notify,
}

impl Live {
    /// `events` is the events log's own feed.
    pub fn new(events: broadcast::Sender<Arc<str>>) -> Self {
        Self {
            status: watch::Sender::new(None),
            conversions: watch::Sender::new(None),
            sessions: watch::Sender::new(None),
            events,
            status_changed: Notify::new(),
        }
    }
}

/// Puts `json` on the feed if it's different from what's there, so watchers only hear of changes.
pub fn publish(feed: &Feed, json: String) {
    feed.send_if_modified(|current| {
        if current.as_deref() == Some(json.as_str()) {
            return false;
        }
        *current = Some(json.into());
        true
    });
}

/// Works out the dashboard and the conversions while anyone is watching them.
pub fn start(state: State) {
    let s = state.clone();
    tokio::spawn(async move {
        loop {
            if s.live.status.receiver_count() > 0 {
                match crate::status::read(&s).await {
                    Ok(status) => publish(&s.live.status, serde_json::to_string(&status).unwrap_or_default()),
                    Err(e) => eprintln!("Live status failed: {}", e.1),
                }
            } else {
                // Nobody's watching: what's there would be stale by the time someone does.
                s.live.status.send_replace(None);
            }
            tokio::select! {
                _ = tokio::time::sleep(STATUS_EVERY) => {}
                _ = s.live.status_changed.notified() => {}
            }
        }
    });
    tokio::spawn(async move {
        loop {
            if state.live.conversions.receiver_count() > 0 {
                publish(&state.live.conversions, crate::conversions::summary(&state).to_string());
            } else {
                state.live.conversions.send_replace(None);
            }
            tokio::time::sleep(CONVERSIONS_EVERY).await;
        }
    });
}

#[derive(Deserialize)]
pub struct LiveQuery {
    topics: Option<String>,
}

pub async fn handler(ws: WebSocketUpgrade, AxumState(state): AxumState<State>, Query(q): Query<LiveQuery>) -> Response {
    let topics: Vec<String> = q
        .topics
        .unwrap_or_else(|| "status".into())
        .split(',')
        .map(|t| t.trim().to_owned())
        .collect();
    ws.on_upgrade(move |socket| serve(socket, state, topics))
}

fn message(topic: &str, data: &str) -> Message {
    Message::Text(Utf8Bytes::from(format!("{{\"topic\":\"{topic}\",\"data\":{data}}}")))
}

async fn serve(mut socket: WebSocket, state: State, topics: Vec<String>) {
    let wants = |t: &str| topics.iter().any(|x| x == t);
    let mut feeds: Vec<(&'static str, watch::Receiver<Option<Arc<str>>>)> = Vec::new();
    for (name, feed) in [
        ("status", &state.live.status),
        ("conversions", &state.live.conversions),
        ("sessions", &state.live.sessions),
    ] {
        if wants(name) {
            let mut rx = feed.subscribe();
            // What's there now is sent straight away, if anything is.
            rx.mark_changed();
            feeds.push((name, rx));
        }
    }
    if wants("status") {
        state.live.status_changed.notify_one();
    }
    let mut events = wants("events").then(|| state.live.events.subscribe());
    let mut ping = tokio::time::interval(PING_EVERY);
    ping.tick().await;

    enum Next {
        Feed(usize, bool),
        Event(Result<Arc<str>, broadcast::error::RecvError>),
        Ping,
        Incoming(Option<Result<Message, axum::Error>>),
    }
    loop {
        let next = {
            // Whichever feed changes first.
            let changed = async {
                if feeds.is_empty() {
                    return std::future::pending().await;
                }
                let waits = feeds.iter_mut().enumerate().map(|(i, (_, rx))| {
                    Box::pin(async move {
                        let ok = rx.changed().await.is_ok();
                        (i, ok)
                    })
                });
                futures_util::future::select_all(waits).await.0
            };
            let event = async {
                match events.as_mut() {
                    Some(rx) => rx.recv().await,
                    None => std::future::pending().await,
                }
            };
            tokio::select! {
                (i, ok) = changed => Next::Feed(i, ok),
                e = event => Next::Event(e),
                _ = ping.tick() => Next::Ping,
                incoming = socket.recv() => Next::Incoming(incoming),
            }
        };
        let out = match next {
            Next::Feed(_, false) => return,
            Next::Feed(i, true) => {
                let (name, rx) = &mut feeds[i];
                let Some(data) = rx.borrow_and_update().clone() else { continue };
                message(name, &data)
            }
            Next::Event(Ok(data)) => message("events", &data),
            Next::Event(Err(broadcast::error::RecvError::Lagged(_))) => continue,
            Next::Event(Err(_)) => return,
            Next::Ping => Message::Ping(Default::default()),
            Next::Incoming(Some(Ok(Message::Close(_))) | None | Some(Err(_))) => return,
            Next::Incoming(Some(Ok(_))) => continue,
        };
        if socket.send(out).await.is_err() {
            return;
        }
    }
}

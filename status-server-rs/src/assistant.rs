//! Assistant: chats for the Assistant mini-app, answered by a model running on this machine. Each
//! model is its own systemd unit serving llama.cpp's OpenAI-style API. Only one fits in video
//! memory, so starting one stops the others, and the one in use stops after a quarter of an hour
//! without questions. To add a model: give it a quadlet on its own port with no [Install], add its
//! container to GAME_MODE_UNITS, and add an entry to MODELS. The first entry is the default.
//! An answer keeps being written when the phone disconnects, so leaving the app doesn't lose it.
//! Each chat is a JSON file in `assistant/`.

use std::collections::HashMap;
use std::convert::Infallible;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Json;
use axum::body::{Body, Bytes};
use axum::extract::{Path as UrlPath, Request, State as AxumState};
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use http_body_util::BodyExt;
use serde_json::{Map, Value, json};
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::args;
use crate::assistant_tools::{TOOL_RESULTS_CHARS, TOOL_ROUNDS, definitions, js_slice, use_tool};
use crate::command::run;
use crate::http::{HttpError, State};
use crate::localtime::{clock, long_date, tool_time};
use crate::usage::now_ms;

pub struct Model {
    id: &'static str,
    name: &'static str,
    unit: &'static str,
    url: &'static str,
    /// Can think before answering, switched with the chat template's enable_thinking.
    thinking: bool,
    /// Can look at photos (llama.cpp loads the mmproj file that -hf finds next to the model).
    vision: bool,
    /// Can call the assistant tools to look at the server.
    tools: bool,
    /// Recommended settings for thinking and for quick answers, as JSON.
    sampling: (&'static str, &'static str),
}

pub const MODELS: &[Model] = &[Model {
    id: "qwen3.5-9b",
    name: "Qwen3.5 9B",
    unit: "llama.service",
    url: "http://localhost:8080",
    thinking: true,
    vision: true,
    tools: true,
    // Qwen's recommended settings for each mode.
    sampling: (
        r#"{"temperature":0.6,"top_p":0.95,"top_k":20,"min_p":0}"#,
        r#"{"temperature":0.7,"top_p":0.8,"top_k":20,"min_p":0,"presence_penalty":1.5}"#,
    ),
}];

const IDLE_MS: i64 = 15 * 60_000;
const START_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// Longest answer, thinking included. Thinking takes far more room than the answer.
const REPLY_TOKENS: (u64, u64) = (8192, 4096);
const MAX_TEXT: usize = 32_000;
const MAX_BODY: usize = 64 * 1024;
/// A rough count, for keeping a long chat inside the model's context.
const CHARS_PER_TOKEN: i64 = 3;
/// Photos are made a JPEG of at most this many pixels on the long side, which keeps one to roughly
/// 1,600 tokens of context and reads fine for text in a screenshot.
const IMAGE_MAX_SIDE: u32 = 1280;
const IMAGE_TOKENS: i64 = 1600;
const IMAGE_MAX_BYTES: u64 = 50 * 1024 * 1024;
const IMAGES_PER_MESSAGE: usize = 4;
/// Photos sent without a question after them are deleted once they're this old.
const IMAGE_ORPHAN: Duration = Duration::from_secs(3600);

type Chat = Arc<Mutex<Map<String, Value>>>;

/// An answer being written: the chat it goes in, and how to stop it.
struct Generation {
    chat: Chat,
    cancel: CancellationToken,
    /// Stopped from the app, rather than the chat deleted.
    stopped: Arc<AtomicBool>,
}

pub struct Assistant {
    dir: PathBuf,
    last_used: Mutex<i64>,
    /// The model being started, if one is.
    starting: Mutex<Option<&'static str>>,
    start_lock: tokio::sync::Mutex<()>,
    /// Context per request (tokens), read from each model once it's up.
    context: Mutex<HashMap<&'static str, i64>>,
    generations: Mutex<HashMap<String, Generation>>,
}

fn bad(code: StatusCode, message: impl Into<String>) -> HttpError {
    HttpError(code, message.into())
}

impl Assistant {
    pub fn new(dir: &Path) -> Self {
        Self {
            dir: dir.join("assistant"),
            last_used: Mutex::new(0),
            starting: Mutex::new(None),
            start_lock: Default::default(),
            context: Mutex::default(),
            generations: Mutex::default(),
        }
    }

    fn images(&self) -> PathBuf {
        self.dir.join("images")
    }

    fn touch(&self) {
        *self.last_used.lock().unwrap() = now_ms();
    }

    fn chat_path(&self, id: &str) -> Result<PathBuf, HttpError> {
        let ok = (8..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
        if !ok {
            return Err(bad(StatusCode::BAD_REQUEST, "Bad chat id"));
        }
        Ok(self.dir.join(format!("{id}.json")))
    }

    fn image_path(&self, id: &str) -> Result<PathBuf, HttpError> {
        if id.len() != 24 || !id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            return Err(bad(StatusCode::BAD_REQUEST, "Bad photo id"));
        }
        Ok(self.images().join(format!("{id}.jpg")))
    }

    /// The chat as it is now: the one being answered, or as saved. An answer the server was
    /// writing when it stopped shows as stopped.
    fn load_chat(&self, id: &str) -> Result<Option<Map<String, Value>>, HttpError> {
        if let Some(g) = self.generations.lock().unwrap().get(id) {
            return Ok(Some(g.chat.lock().unwrap().clone()));
        }
        let path = self.chat_path(id)?;
        let Some(mut chat) = std::fs::read_to_string(path)
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .and_then(|v| v.as_object().cloned())
        else {
            return Ok(None);
        };
        for m in chat.get_mut("messages").and_then(Value::as_array_mut).into_iter().flatten() {
            if m.get("pending").is_some_and(|p| !p.is_null()) {
                m.as_object_mut().map(|o| {
                    o.remove("pending");
                    o.insert("stopped".into(), json!(true))
                });
            }
        }
        Ok(Some(chat))
    }

    fn save_chat(&self, chat: &Map<String, Value>) -> Result<(), String> {
        std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let id = chat.get("id").and_then(Value::as_str).unwrap_or_default();
        let file = self.chat_path(id).map_err(|e| e.1)?;
        let tmp = file.with_extension("json.tmp");
        crate::files::write_private(&tmp, Value::Object(chat.clone()).to_string().as_bytes()).map_err(|e| e.to_string())?;
        std::fs::rename(tmp, file).map_err(|e| e.to_string())
    }
}

fn find_model(id: Option<&Value>) -> Result<&'static Model, HttpError> {
    match id.filter(|v| !v.is_null()) {
        None => Ok(&MODELS[0]),
        Some(v) => {
            let name = v.as_str().map_or_else(|| v.to_string(), str::to_owned);
            MODELS
                .iter()
                .find(|m| m.id == name)
                .ok_or_else(|| bad(StatusCode::BAD_REQUEST, format!("No model called {name}")))
        }
    }
}

async fn model_answers(state: &State, model: &Model) -> bool {
    crate::client::call(
        &state.upstream,
        Method::GET,
        &format!("{}/health", model.url),
        &[],
        None,
        Duration::from_secs(2),
    )
    .await
    .is_ok_and(|r| r.status.is_success())
}

async fn unit_active(unit: &str) -> bool {
    crate::command::output("systemctl", &args!["--user", "is-active", unit], Duration::from_secs(30))
        .await
        .is_ok_and(|o| o.stdout.trim() == "active")
}

pub async fn state_handler(AxumState(state): AxumState<State>) -> Json<Value> {
    let starting = *state.assistant.starting.lock().unwrap();
    let mut models = Vec::new();
    for m in MODELS {
        let s = if starting == Some(m.id) {
            "starting"
        } else if model_answers(&state, m).await {
            "running"
        } else if unit_active(m.unit).await {
            "starting"
        } else {
            "stopped"
        };
        models.push(json!({ "id": m.id, "name": m.name, "thinking": m.thinking, "vision": m.vision, "state": s }));
    }
    Json(json!({ "models": models, "gameMode": state.game_mode.active() }))
}

/// Starts the model if it isn't running, stopping any other one first.
async fn wake_model(state: &State, model: &'static Model) -> Result<(), HttpError> {
    state.game_mode.error("the assistant")?;
    let a = &state.assistant;
    a.touch();
    // One start at a time; whoever waited finds the model running.
    let _starting = a.start_lock.lock().await;
    if model_answers(state, model).await {
        return Ok(());
    }
    *a.starting.lock().unwrap() = Some(model.id);
    let result = async {
        for other in MODELS.iter().filter(|o| o.id != model.id) {
            if unit_active(other.unit).await {
                println!("Stopping {} to make room for {}", other.name, model.name);
                run("systemctl", &args!["--user", "stop", other.unit], Duration::from_secs(120))
                    .await
                    .map_err(HttpError::internal)?;
            }
        }
        println!("Starting {} for the Assistant app", model.name);
        run("systemctl", &args!["--user", "start", model.unit], Duration::from_secs(120))
            .await
            .map_err(HttpError::internal)?;
        let deadline = tokio::time::Instant::now() + START_TIMEOUT;
        while !model_answers(state, model).await {
            if tokio::time::Instant::now() > deadline {
                return Err(bad(
                    StatusCode::GATEWAY_TIMEOUT,
                    format!("{} is taking too long to start. Try again in a minute.", model.name),
                ));
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        Ok(())
    }
    .await;
    *a.starting.lock().unwrap() = None;
    result
}

async fn context_tokens(state: &State, model: &'static Model) -> i64 {
    if let Some(n) = state.assistant.context.lock().unwrap().get(model.id) {
        return *n;
    }
    let props = crate::client::call(
        &state.upstream,
        Method::GET,
        &format!("{}/props", model.url),
        &[],
        None,
        Duration::from_secs(5),
    )
    .await;
    let n = props
        .ok()
        .and_then(|r| serde_json::from_slice::<Value>(&r.body).ok())
        .and_then(|p| p["default_generation_settings"]["n_ctx"].as_i64())
        .filter(|n| *n != 0);
    match n {
        Some(n) => {
            state.assistant.context.lock().unwrap().insert(model.id, n);
            n
        }
        None => 8192,
    }
}

async fn stop_idle(state: &State) {
    let a = &state.assistant;
    let idle = || {
        a.starting.lock().unwrap().is_none()
            && a.generations.lock().unwrap().is_empty()
            && now_ms() - *a.last_used.lock().unwrap() >= IDLE_MS
    };
    if !idle() {
        return;
    }
    for model in MODELS {
        // Checked again after the wait, in case a question came in meanwhile.
        if !unit_active(model.unit).await || !idle() {
            continue;
        }
        println!("Stopping {}, unused for a quarter of an hour", model.name);
        if let Err(e) = run("systemctl", &args!["--user", "stop", model.unit], Duration::from_secs(120)).await {
            eprintln!("Couldn't stop {}: {e}", model.name);
        }
    }
}

/// Stops the model when it's idle, and clears out photos nobody asked about.
pub fn start(state: State) {
    let s = state.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + Duration::from_secs(60), Duration::from_secs(60));
        loop {
            tick.tick().await;
            stop_idle(&s).await;
        }
    });
    tokio::spawn(async move {
        let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + Duration::from_secs(3600), Duration::from_secs(3600));
        loop {
            tick.tick().await;
            sweep_images(&state);
        }
    });
}

// ---------------------------------------------------------------------------------------------
// Chats

pub async fn list(AxumState(state): AxumState<State>) -> Json<Value> {
    let a = &state.assistant;
    let mut chats: Vec<(f64, Value)> = Vec::new();
    for name in crate::kernel::names(&a.dir) {
        let Some(id) = name.strip_suffix(".json") else { continue };
        let Ok(Some(c)) = a.load_chat(id) else { continue };
        let last = c
            .get("messages")
            .and_then(Value::as_array)
            .and_then(|m| m.last())
            .cloned()
            .unwrap_or(Value::Null);
        let text = [&last["content"], &last["error"]]
            .into_iter()
            .find_map(|v| v.as_str().filter(|s| !s.is_empty()))
            .unwrap_or("");
        let updated = c.get("updatedAt").and_then(Value::as_f64).unwrap_or(f64::NAN);
        let mut s = Map::new();
        for k in ["id", "title", "model", "updatedAt"] {
            if let Some(v) = c.get(k) {
                s.insert(k.into(), v.clone());
            }
        }
        s.insert("preview".into(), json!(js_slice(text, 200)));
        s.insert("answering".into(), json!(a.generations.lock().unwrap().contains_key(id)));
        chats.push((updated, Value::Object(s)));
    }
    chats.sort_by(|x, y| y.0.total_cmp(&x.0));
    Json(Value::Array(chats.into_iter().map(|(_, c)| c).collect()))
}

pub async fn get(AxumState(state): AxumState<State>, UrlPath(id): UrlPath<String>) -> Result<Json<Value>, HttpError> {
    let chat = state
        .assistant
        .load_chat(&id)?
        .ok_or_else(|| bad(StatusCode::NOT_FOUND, "No such chat"))?;
    Ok(Json(Value::Object(chat)))
}

pub async fn delete(AxumState(state): AxumState<State>, UrlPath(id): UrlPath<String>) -> Result<Json<Value>, HttpError> {
    println!("assistant delete {id}");
    let a = &state.assistant;
    if let Some(g) = a.generations.lock().unwrap().get(&id) {
        g.cancel.cancel();
    }
    let chat = a.load_chat(&id).ok().flatten();
    for m in chat
        .as_ref()
        .and_then(|c| c.get("messages"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        for image in m["images"].as_array().into_iter().flatten() {
            let _ = std::fs::remove_file(a.image_path(image.as_str().unwrap_or_default())?);
        }
    }
    let _ = std::fs::remove_file(a.chat_path(&id)?);
    Ok(Json(json!({ "ok": true })))
}

pub async fn stop(AxumState(state): AxumState<State>, UrlPath(id): UrlPath<String>) -> Result<Json<Value>, HttpError> {
    let generations = state.assistant.generations.lock().unwrap();
    let g = generations
        .get(&id)
        .ok_or_else(|| bad(StatusCode::CONFLICT, "Nothing is being answered"))?;
    g.stopped.store(true, Ordering::SeqCst);
    if let Some(m) = g
        .chat
        .lock()
        .unwrap()
        .get_mut("messages")
        .and_then(Value::as_array_mut)
        .and_then(|m| m.last_mut())
    {
        m["stopped"] = json!(true);
    }
    g.cancel.cancel();
    Ok(Json(json!({ "ok": true })))
}

// ---------------------------------------------------------------------------------------------
// Photos

fn random_hex(n: usize) -> String {
    crate::encoding::random_bytes(n).iter().map(|x| format!("{x:02x}")).collect()
}

fn too_big() -> HttpError {
    bad(StatusCode::PAYLOAD_TOO_LARGE, "Photos can be up to 50 MB")
}

/// Takes a photo from the phone and keeps a smaller JPEG of it, upright and without its metadata.
pub async fn receive_image(AxumState(state): AxumState<State>, req: Request) -> Result<Json<Value>, HttpError> {
    let length = req
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    if length.is_some_and(|l| l > IMAGE_MAX_BYTES) {
        return Err(too_big());
    }
    let a = &state.assistant;
    tokio::fs::create_dir_all(a.images())
        .await
        .map_err(|e| HttpError::internal(e.to_string()))?;
    let id = random_hex(12);
    let part = a.images().join(format!(".{id}.part"));
    let result = async {
        let internal = |e: std::io::Error| HttpError::internal(e.to_string());
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&part)
            .await
            .map_err(internal)?;
        let mut size = 0u64;
        let mut stream = req.into_body().into_data_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| bad(StatusCode::BAD_REQUEST, e.to_string()))?;
            size += chunk.len() as u64;
            if size > IMAGE_MAX_BYTES {
                return Err(too_big());
            }
            file.write_all(&chunk).await.map_err(internal)?;
        }
        file.flush().await.map_err(internal)?;
        drop(file);
        let out = a.image_path(&id)?;
        // [0]: the first frame of a GIF or the like.
        let convert = args![
            format!("{}[0]", part.to_string_lossy()),
            "-auto-orient",
            "-resize",
            format!("{IMAGE_MAX_SIDE}x{IMAGE_MAX_SIDE}>"),
            "-strip",
            "-quality",
            "85",
            format!("jpg:{}", out.to_string_lossy())
        ];
        if let Err(e) = run("magick", &convert, Duration::from_secs(60)).await {
            eprintln!("Assistant: couldn't read a photo: {e}");
            return Err(bad(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "Couldn’t read that photo. JPEG, PNG and WebP work.",
            ));
        }
        Ok(json!({ "id": id }))
    }
    .await;
    let _ = tokio::fs::remove_file(&part).await;
    Ok(Json(result?))
}

pub async fn send_image(AxumState(state): AxumState<State>, UrlPath(id): UrlPath<String>) -> Result<Response, HttpError> {
    let data = tokio::fs::read(state.assistant.image_path(&id)?)
        .await
        .map_err(|_| bad(StatusCode::NOT_FOUND, "That photo is gone"))?;
    let mut res = (StatusCode::OK, data).into_response();
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("image/jpeg"));
    // A photo never changes once saved, so the phone can keep it.
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=31536000, immutable"),
    );
    Ok(res)
}

/// Deletes photos that were sent but never asked about, such as ones removed before sending.
fn sweep_images(state: &State) {
    let a = &state.assistant;
    let names = crate::kernel::names(a.images());
    if names.is_empty() {
        return;
    }
    let mut used = std::collections::HashSet::new();
    for name in crate::kernel::names(&a.dir) {
        let Some(id) = name.strip_suffix(".json") else { continue };
        let Ok(Some(chat)) = a.load_chat(id) else { continue };
        for m in chat.get("messages").and_then(Value::as_array).into_iter().flatten() {
            for image in m["images"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                used.insert(image.to_owned());
            }
        }
    }
    for name in names {
        let file = a.images().join(&name);
        let stem = match name.rfind('.') {
            Some(i) if i > 0 => &name[..i],
            _ => name.as_str(),
        };
        let old = std::fs::metadata(&file)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age >= IMAGE_ORPHAN);
        if !used.contains(stem) && old {
            let _ = std::fs::remove_file(file);
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Answering

fn system_prompt(model: &Model) -> String {
    let now = now_ms();
    let mut parts = vec![
        format!(
            "You are the assistant in Homebase, the user's personal iPhone app. You are {}, running on their home PC.",
            model.name
        ),
        format!("Today is {}, and the time is {}.", long_date(now), clock(now)),
    ];
    if model.tools {
        parts.extend([
            "The PC is also the home server: Jellyfin, the Sonarr/Radarr/qBittorrent download stack and more; this server also converts the library to HEVC on the GPU, as Podman containers.".to_owned(),
            "For questions about it (slowness, crashes, what happened when, drives, what a service logged), look with the tools rather than guessing, then answer from what they show.".to_owned(),
            "Say what the data shows. When it doesn’t show why something happened, say so rather than guessing a cause.".to_owned(),
            format!("Times you pass to tools are the PC's local time, like {}. Don't use tools for questions that aren't about the server.", tool_time(now)),
        ]);
    }
    parts.push("Answers are read on a phone, so get to the point and keep them short unless asked for detail.".into());
    parts
        .push("Markdown is shown: headings, lists, bold, italics, inline code and code blocks. Avoid tables, which display poorly.".into());
    parts.join(" ")
}

fn js_len(s: &str) -> i64 {
    s.encode_utf16().count() as i64
}

/// The newest messages that fit in the model's context, leaving room for the answer. Photos go in
/// as data URLs, for a model that can see them.
fn chat_history(a: &Assistant, messages: &[Value], model: &Model, budget: i64) -> Vec<Value> {
    let mut history = Vec::new();
    let mut used = 0;
    for m in messages[..messages.len().saturating_sub(1)].iter().rev() {
        let content = m["content"].as_str().unwrap_or_default();
        let images: Vec<&str> = if model.vision {
            m["images"].as_array().into_iter().flatten().filter_map(Value::as_str).collect()
        } else {
            Vec::new()
        };
        if content.is_empty() && images.is_empty() {
            continue;
        }
        used += js_len(content) + images.len() as i64 * IMAGE_TOKENS * CHARS_PER_TOKEN;
        if used > budget && !history.is_empty() {
            break;
        }
        if images.is_empty() {
            history.insert(0, json!({ "role": m["role"], "content": content }));
            continue;
        }
        let mut parts: Vec<Value> = images
            .iter()
            .filter_map(|id| a.image_path(id).ok().and_then(|p| std::fs::read(p).ok()))
            .map(|data| json!({ "type": "image_url", "image_url": { "url": format!("data:image/jpeg;base64,{}", crate::encoding::base64(&data)) } }))
            .collect();
        // A photo sent on its own gets a plain question, rather than a guess at what's wanted.
        let text = if !content.is_empty() {
            content
        } else if images.len() > 1 {
            "What’s in these photos?"
        } else {
            "What’s in this photo?"
        };
        parts.push(json!({ "type": "text", "text": text }));
        history.insert(0, json!({ "role": m["role"], "content": parts }));
    }
    history
}

/// Changes the answer being written: the chat's last message.
fn with_message(chat: &Chat, f: impl FnOnce(&mut Map<String, Value>)) {
    let mut c = chat.lock().unwrap();
    if let Some(m) = c
        .get_mut("messages")
        .and_then(Value::as_array_mut)
        .and_then(|m| m.last_mut())
        .and_then(Value::as_object_mut)
    {
        f(m);
    }
}

fn event(tx: &mpsc::UnboundedSender<Bytes>, e: Value) {
    // The phone may have gone away mid-answer; the answer is still finished and saved.
    let _ = tx.send(Bytes::from(format!("{e}\n")));
}

/// Adds the question to the chat (making the chat if it's new) and streams the answer back as
/// newline-separated JSON: `status` while the model starts, then `reasoning` and `content` pieces,
/// and `done` with the finished message, or `error`.
pub async fn ask(AxumState(state): AxumState<State>, UrlPath(id): UrlPath<String>, body: Request) -> Result<Response, HttpError> {
    println!("assistant ask {id}");
    let a = &state.assistant;
    a.chat_path(&id)?;
    let bytes = axum::body::to_bytes(body.into_body(), MAX_BODY)
        .await
        .map_err(|_| bad(StatusCode::PAYLOAD_TOO_LARGE, "Request body too large"))?;
    let body = crate::machine::json_body(&bytes)?;
    let text = body["text"].as_str().map(|t| t.trim().to_owned()).unwrap_or_default();
    let images: Vec<Value> = body["images"].as_array().cloned().unwrap_or_default();
    if text.is_empty() && images.is_empty() {
        return Err(bad(StatusCode::BAD_REQUEST, "Nothing to ask"));
    }
    if images.len() > IMAGES_PER_MESSAGE {
        return Err(bad(StatusCode::BAD_REQUEST, format!("Up to {IMAGES_PER_MESSAGE} photos at a time")));
    }
    for image in &images {
        let Some(image) = image.as_str() else {
            return Err(bad(StatusCode::BAD_REQUEST, "One of the photos is gone. Add it again."));
        };
        if !a.image_path(image)?.exists() {
            return Err(bad(StatusCode::BAD_REQUEST, "One of the photos is gone. Add it again."));
        }
    }
    if text.encode_utf16().count() > MAX_TEXT {
        return Err(bad(StatusCode::PAYLOAD_TOO_LARGE, "That message is too long"));
    }
    if a.generations.lock().unwrap().contains_key(&id) {
        return Err(bad(StatusCode::CONFLICT, "Still answering the last message"));
    }
    state.game_mode.error("the assistant")?;

    let now = now_ms();
    let first_line = js_slice(text.split('\n').next().unwrap_or_default(), 80);
    let title = if !first_line.is_empty() {
        first_line
    } else if images.len() > 1 {
        "Photos".into()
    } else {
        "Photo".into()
    };
    let mut chat = a.load_chat(&id)?.unwrap_or_else(|| {
        let mut c = Map::new();
        c.insert("id".into(), json!(id));
        c.insert("title".into(), json!(title));
        c.insert("createdAt".into(), json!(now));
        c.insert("messages".into(), json!([]));
        c
    });
    let model = find_model(body.get("model").or(chat.get("model")))?;
    if !images.is_empty() && !model.vision {
        return Err(bad(StatusCode::BAD_REQUEST, format!("{} can’t look at photos", model.name)));
    }
    let think = crate::assistant_tools::truthy(&body["think"]) && model.thinking;
    chat.insert("model".into(), json!(model.id));
    chat.insert("updatedAt".into(), json!(now));
    let mut question = Map::new();
    question.insert("role".into(), json!("user"));
    question.insert("content".into(), json!(text));
    if !images.is_empty() {
        question.insert("images".into(), json!(images));
    }
    question.insert("at".into(), json!(now));
    let messages = chat.entry("messages").or_insert(json!([]));
    if let Some(list) = messages.as_array_mut() {
        list.push(Value::Object(question));
        list.push(json!({ "role": "assistant", "content": "", "reasoning": "", "model": model.id, "at": now, "pending": true }));
    }
    let chat: Chat = Arc::new(Mutex::new(chat));
    let cancel = CancellationToken::new();
    let stopped = Arc::new(AtomicBool::new(false));
    a.generations.lock().unwrap().insert(
        id.clone(),
        Generation {
            chat: Arc::clone(&chat),
            cancel: cancel.clone(),
            stopped: Arc::clone(&stopped),
        },
    );
    if let Err(e) = a.save_chat(&chat.lock().unwrap()) {
        a.generations.lock().unwrap().remove(&id);
        return Err(HttpError::internal(e));
    }

    let (tx, rx) = mpsc::unbounded_channel::<Bytes>();
    let s = state.clone();
    tokio::spawn(async move { answer(s, id, chat, model, think, cancel, stopped, tx).await });
    let stream = futures_util::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|b| (Ok::<_, Infallible>(b), rx)) });
    let mut res = Body::from_stream(stream).into_response();
    res.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("application/x-ndjson"));
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(res)
}

const ABORTED: &str = "This operation was aborted";

/// Writes the answer to the chat's last question, sending each piece, and saves the chat. A model
/// with tools may look at the server first, a few rounds at most.
#[allow(clippy::too_many_arguments)]
async fn answer(
    state: State,
    id: String,
    chat: Chat,
    model: &'static Model,
    think: bool,
    cancel: CancellationToken,
    stopped: Arc<AtomicBool>,
    tx: mpsc::UnboundedSender<Bytes>,
) {
    let result = tokio::select! {
        r = write_answer(&state, &chat, model, think, &cancel, &tx) => r,
        _ = cancel.cancelled() => Err(ABORTED.to_owned()),
    };
    let a = &state.assistant;
    if let Err(e) = result
        && !stopped.load(Ordering::SeqCst)
    {
        eprintln!("Assistant: {e}");
        with_message(&chat, |m| {
            m.insert("error".into(), json!(e));
        });
    }
    with_message(&chat, |m| {
        m.remove("pending");
        if m.get("reasoning").and_then(Value::as_str).is_some_and(str::is_empty) {
            m.remove("reasoning");
        }
    });
    chat.lock().unwrap().insert("updatedAt".into(), json!(now_ms()));
    a.touch();
    a.generations.lock().unwrap().remove(&id);
    // A chat deleted while it was being answered stays deleted.
    let final_chat = chat.lock().unwrap().clone();
    if (!cancel.is_cancelled() || stopped.load(Ordering::SeqCst))
        && let Err(e) = a.save_chat(&final_chat)
    {
        eprintln!("Couldn't save a chat: {e}");
    }
    let message = final_chat
        .get("messages")
        .and_then(Value::as_array)
        .and_then(|m| m.last())
        .cloned()
        .unwrap_or(Value::Null);
    match message.get("error") {
        Some(e) => event(&tx, json!({ "type": "error", "error": e })),
        None => event(&tx, json!({ "type": "done", "message": message })),
    }
}

async fn write_answer(
    state: &State,
    chat: &Chat,
    model: &'static Model,
    think: bool,
    cancel: &CancellationToken,
    tx: &mpsc::UnboundedSender<Bytes>,
) -> Result<(), String> {
    if !model_answers(state, model).await {
        event(tx, json!({ "type": "status", "text": format!("Starting {}…", model.name) }));
    }
    wake_model(state, model).await.map_err(|e| e.1)?;
    let reply = if think { REPLY_TOKENS.0 } else { REPLY_TOKENS.1 };
    let system = system_prompt(model);
    let tools = definitions();
    let tools_len = if model.tools { js_len(&tools.to_string()) } else { 0 };
    let budget = (context_tokens(state, model).await - reply as i64) * CHARS_PER_TOKEN - js_len(&system) - tools_len;
    let earlier = chat
        .lock()
        .unwrap()
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    // What the tools return needs room too, so a long chat gives up some of its oldest messages.
    let mut messages = vec![json!({ "role": "system", "content": system })];
    messages.extend(chat_history(
        &state.assistant,
        &earlier,
        model,
        if model.tools { budget - TOOL_RESULTS_CHARS as i64 } else { budget },
    ));
    let sampling: Value = serde_json::from_str(if think { model.sampling.0 } else { model.sampling.1 }).unwrap_or_default();
    let mut tool_chars = 0usize;
    for round in 0.. {
        // The last round has no tools, so it has to answer with what it found.
        let offer_tools = model.tools && round < TOOL_ROUNDS;
        let mut body = Map::new();
        body.insert("stream".into(), json!(true));
        body.insert("max_tokens".into(), json!(reply));
        body.insert("messages".into(), json!(messages));
        if offer_tools {
            body.insert("tools".into(), tools.clone());
        }
        if model.thinking {
            body.insert("chat_template_kwargs".into(), json!({ "enable_thinking": think }));
        }
        for (k, v) in sampling.as_object().into_iter().flatten() {
            body.insert(k.clone(), v.clone());
        }
        let req = axum::http::Request::post(format!("{}/v1/chat/completions", model.url))
            .header("content-type", "application/json")
            .body(Body::from(Value::Object(body).to_string()))
            .map_err(|e| e.to_string())?;
        let res = state.upstream.0.request(req).await.map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            let status = res.status().as_u16();
            let detail = res
                .into_body()
                .collect()
                .await
                .ok()
                .and_then(|b| serde_json::from_slice::<Value>(&b.to_bytes()).ok())
                .and_then(|v| v["error"]["message"].as_str().map(str::to_owned));
            return Err(format!(
                "{} answered {status}{}",
                model.name,
                detail.map(|d| format!(": {d}")).unwrap_or_default()
            ));
        }
        let mut body = res.into_body();
        let mut buffer = String::new();
        let mut pending_bytes: Vec<u8> = Vec::new();
        let mut said = String::new();
        // Tool calls come in pieces, by index: the id and name first, then the arguments bit by bit.
        let mut calls: Vec<(String, String, String)> = Vec::new();
        while let Some(frame) = body.frame().await {
            if cancel.is_cancelled() {
                return Err(ABORTED.into());
            }
            let Ok(data) = frame.map_err(|e| e.to_string())?.into_data() else {
                continue;
            };
            pending_bytes.extend_from_slice(&data);
            // Keep a multi-byte character cut between chunks for the next one.
            let valid = match std::str::from_utf8(&pending_bytes) {
                Ok(_) => pending_bytes.len(),
                Err(e) => e.valid_up_to(),
            };
            buffer.push_str(std::str::from_utf8(&pending_bytes[..valid]).unwrap_or_default());
            pending_bytes.drain(..valid);
            while let Some(end) = buffer.find('\n') {
                let line: String = buffer.drain(..=end).collect();
                let line = line.trim_end_matches(['\n', '\r']);
                let Some(data) = line.strip_prefix("data: ").filter(|d| *d != "[DONE]") else {
                    continue;
                };
                let Ok(parsed) = serde_json::from_str::<Value>(data) else {
                    continue;
                };
                let choice = &parsed["choices"][0];
                let delta = &choice["delta"];
                if let Some(r) = delta["reasoning_content"].as_str().filter(|r| !r.is_empty()) {
                    with_message(chat, |m| {
                        let was = m.get("reasoning").and_then(Value::as_str).unwrap_or_default().to_owned();
                        m.insert("reasoning".into(), json!(was + r));
                    });
                    event(tx, json!({ "type": "reasoning", "text": r }));
                }
                if let Some(c) = delta["content"].as_str().filter(|c| !c.is_empty()) {
                    let mut content = c.to_owned();
                    with_message(chat, |m| {
                        let was = m.get("content").and_then(Value::as_str).unwrap_or_default().to_owned();
                        // Text from before a look at the server, then the answer after it: keep them apart.
                        if said.is_empty() && !was.is_empty() && !was.ends_with('\n') {
                            content = format!("\n\n{content}");
                        }
                        m.insert("content".into(), json!(was + &content));
                    });
                    said.push_str(&content);
                    event(tx, json!({ "type": "content", "text": content }));
                }
                for part in delta["tool_calls"].as_array().into_iter().flatten() {
                    let i = part["index"].as_u64().unwrap_or(0) as usize;
                    while calls.len() <= i {
                        calls.push(Default::default());
                    }
                    if let Some(cid) = part["id"].as_str().filter(|s| !s.is_empty()) {
                        calls[i].0 = cid.to_owned();
                    }
                    if let Some(n) = part["function"]["name"].as_str() {
                        calls[i].1.push_str(n);
                    }
                    if let Some(args) = part["function"]["arguments"].as_str() {
                        calls[i].2.push_str(args);
                    }
                }
                if choice["finish_reason"] == "length" {
                    with_message(chat, |m| {
                        m.insert("cutOff".into(), json!(true));
                    });
                }
            }
            state.assistant.touch();
        }
        let made: Vec<_> = calls.into_iter().filter(|c| !c.1.is_empty()).collect();
        if !offer_tools || made.is_empty() {
            break;
        }
        let tool_calls: Vec<Value> = made
            .iter()
            .map(|(cid, name, args)| json!({ "id": cid, "type": "function", "function": { "name": name, "arguments": args } }))
            .collect();
        messages.push(
            json!({ "role": "assistant", "content": if said.is_empty() { Value::Null } else { json!(said) }, "tool_calls": tool_calls }),
        );
        for (cid, name, args) in &made {
            let (label, result) = use_tool(state, name, args, TOOL_RESULTS_CHARS.saturating_sub(tool_chars)).await;
            tool_chars += result.encode_utf16().count();
            with_message(chat, |m| {
                let steps = m.entry("steps").or_insert(json!([]));
                if let Some(s) = steps.as_array_mut() {
                    s.push(json!({ "label": label }));
                }
            });
            event(tx, json!({ "type": "step", "label": label }));
            messages.push(json!({ "role": "tool", "tool_call_id": cid, "content": result }));
        }
        state.assistant.touch();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids() {
        let a = Assistant::new(Path::new("/tmp"));
        assert!(a.chat_path("abc-DEF_123").is_ok());
        assert!(a.chat_path("short").is_err());
        assert!(a.chat_path("../../etc/passwd").is_err());
        assert!(a.image_path("0123456789abcdef01234567").is_ok());
        assert!(a.image_path("0123456789ABCDEF01234567").is_err());
    }
}

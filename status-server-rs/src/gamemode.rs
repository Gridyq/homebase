//! Game mode: stops the download stack to leave its memory to a game. It turns on by itself while a
//! Steam game or Starsector runs and off half a minute after the game closes, or can be switched
//! from the app. Turned on from the app, it stays on until turned off there. Turned off while a
//! game runs, it stays off until that game closes. Jellyfin keeps running so the TV still works.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use axum::Json;
use axum::body::Bytes;
use axum::extract::State as AxumState;
use axum::http::StatusCode;
use serde_json::{Map, Value, json};

use crate::args;
use crate::command::run;
use crate::events::Event;
use crate::http::{HttpError, State};
use crate::kernel;
use crate::usage::now_ms;

/// In start order; systemd works out the rest from the units' own dependencies. The assistant's
/// models hold several GB of video memory, so they stop too. Conversions stop by themselves
/// while game mode is on (see conversions.rs).
pub const GAME_MODE_UNITS: &[&str] = &[
    "gluetun",
    "qbittorrent",
    "flaresolverr",
    "prowlarr",
    "sonarr",
    "radarr",
    "recyclarr",
    "llama",
];
/// Units that only run while something uses them, so game mode doesn't start them again.
pub const ON_DEMAND_UNITS: &[&str] = &["llama.service"];
pub const GAME_CHECK_INTERVAL: Duration = Duration::from_secs(10);
/// How long after a game closes before the services come back, so restarting a game doesn't
/// bounce them.
const GAME_GRACE_MS: i64 = 30_000;
const UNITS_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Default, Clone)]
struct Mode {
    /// Set from the app: Some(true) or Some(false); None while following games.
    manual: Option<bool>,
    active: bool,
    /// The game running, or the last one, kept through the grace period.
    game: Option<String>,
    last_seen: Option<i64>,
    since: Option<i64>,
}

pub struct GameMode {
    path: PathBuf,
    mode: Mutex<Mode>,
    /// One change at a time.
    changing: tokio::sync::Mutex<()>,
}

fn unit_files(filter: impl Fn(&str) -> bool) -> Vec<String> {
    GAME_MODE_UNITS
        .iter()
        .map(|u| format!("{u}.service"))
        .filter(|u| filter(u))
        .collect()
}

impl GameMode {
    pub fn new(dir: &Path) -> Self {
        Self {
            path: dir.join("game-mode.json"),
            mode: Mutex::default(),
            changing: Default::default(),
        }
    }

    pub fn active(&self) -> bool {
        self.mode.lock().unwrap().active
    }

    /// What the app shows, and what the events use to put stops down to game mode.
    pub fn state(&self) -> Value {
        let m = self.mode.lock().unwrap().clone();
        let now = now_ms();
        let closing = m.game.is_some()
            && m.last_seen
                .is_some_and(|seen| now - seen > GAME_CHECK_INTERVAL.as_millis() as i64 * 2);
        let mut out = Map::new();
        out.insert("on".into(), json!(m.active));
        out.insert("manual".into(), json!(m.manual.is_some()));
        if let Some(g) = &m.game {
            out.insert("game".into(), json!(g));
        }
        if let Some(s) = m.since {
            out.insert("since".into(), json!(s));
        }
        // When it turns off by itself, once the game has closed.
        if m.active && m.manual.is_none() && closing {
            out.insert("endsAt".into(), json!(m.last_seen.unwrap_or(0) + GAME_GRACE_MS));
        }
        out.insert(
            "services".into(),
            GAME_MODE_UNITS.iter().map(|u| json!(format!("container:{u}"))).collect(),
        );
        Value::Object(out)
    }

    /// For what game mode stops: refuses while it's on.
    pub fn error(&self, service: &str) -> Result<(), HttpError> {
        if self.active() {
            return Err(HttpError(
                StatusCode::SERVICE_UNAVAILABLE,
                format!("Game mode is on, so {service} is stopped. Turn it off in the Server app to use it."),
            ));
        }
        Ok(())
    }

    fn save(&self, m: &Mode) {
        let mut saved = Map::new();
        if let Some(manual) = m.manual {
            saved.insert("manual".into(), json!(manual));
        }
        saved.insert("active".into(), json!(m.active));
        if let Some(g) = &m.game {
            saved.insert("game".into(), json!(g));
        }
        if let Err(e) = crate::files::write_private(&self.path, Value::Object(saved).to_string().as_bytes()) {
            eprintln!("Couldn't save game mode: {e}");
        }
    }
}

async fn stop_units(state: &State) {
    let units = unit_files(|_| true);
    let mut stop = args!["--user", "stop"].to_vec();
    stop.extend(units.iter().cloned());
    let result = run("systemctl", &stop, UNITS_TIMEOUT).await;
    state.services.expire(&state.usage);
    if let Err(e) = result {
        eprintln!("Couldn't stop the game mode services: {e}");
    }
    // Some exit with an error when stopped (gluetun with 1); that's not a failure worth showing.
    let mut reset = args!["--user", "reset-failed"].to_vec();
    reset.extend(units);
    let _ = run("systemctl", &reset, Duration::from_secs(30)).await;
}

/// Starts or stops the services if game mode should change.
async fn update(state: &State) {
    let gm = &state.game_mode;
    let _changing = gm.changing.lock().await;
    let (want, game) = {
        let mut m = gm.mode.lock().unwrap();
        let want = m.manual.unwrap_or(m.game.is_some());
        if want == m.active {
            return;
        }
        m.active = want;
        m.since = Some(now_ms());
        gm.save(&m);
        (want, m.game.clone())
    };
    println!(
        "Game mode {}{}",
        if want { "on" } else { "off" },
        game.as_ref().map(|g| format!(" ({g})")).unwrap_or_default()
    );
    let mut e = Event::new(now_ms(), "game");
    e.on = Some(want);
    e.detail = game;
    state.recorder.events.lock().unwrap().add(e);
    if want {
        stop_units(state).await;
    } else {
        let mut start = args!["--user", "start"].to_vec();
        start.extend(unit_files(|u| !ON_DEMAND_UNITS.contains(&u)));
        if let Err(e) = run("systemctl", &start, UNITS_TIMEOUT).await {
            eprintln!("Couldn't start the game mode services: {e}");
        }
        state.services.expire(&state.usage);
    }
}

fn steam_dir() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".local/share/Steam")
}

/// The value of the first `"key" "value"` pair in a Steam .vdf/.acf file.
fn vdf_values<'a>(text: &'a str, key: &str) -> Vec<&'a str> {
    let quoted = format!("\"{key}\"");
    text.lines()
        .filter_map(|l| {
            let rest = l.trim().strip_prefix(&quoted)?;
            let rest = rest.trim_start();
            rest.strip_prefix('"')?.split('"').next()
        })
        .collect()
}

fn steam_game_name(app_id: &str) -> String {
    let steam = steam_dir();
    let vdf = std::fs::read_to_string(steam.join("steamapps/libraryfolders.vdf")).unwrap_or_default();
    let mut libraries: Vec<PathBuf> = vdf_values(&vdf, "path").into_iter().map(PathBuf::from).collect();
    if libraries.is_empty() {
        libraries.push(steam);
    }
    for lib in libraries {
        let manifest = std::fs::read_to_string(lib.join(format!("steamapps/appmanifest_{app_id}.acf"))).unwrap_or_default();
        if let Some(name) = vdf_values(&manifest, "name").first() {
            return (*name).to_owned();
        }
    }
    "A Steam game".into()
}

/// Name of a game that's running.
fn running_game() -> Option<String> {
    for pid in kernel::pids() {
        let Some(cmdline) = kernel::read(format!("/proc/{pid}/cmdline")) else {
            continue;
        };
        let args: Vec<&str> = cmdline.split('\0').collect();
        if args.contains(&"com.fs.starfarer.StarfarerLauncher") {
            return Some("Starsector".into());
        }
        // Steam starts every game, native or Proton, under `reaper SteamLaunch AppId=<id> -- ...`.
        if args.contains(&"SteamLaunch")
            && let Some(id) = args.iter().find_map(|a| {
                a.strip_prefix("AppId=")
                    .filter(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()))
            })
        {
            return Some(steam_game_name(id));
        }
    }
    None
}

async fn check(state: &State) {
    let game = tokio::task::spawn_blocking(running_game).await.unwrap_or(None);
    {
        let now = now_ms();
        let mut m = state.game_mode.mode.lock().unwrap();
        if let Some(game) = game {
            m.game = Some(game);
            m.last_seen = Some(now);
        } else if m.game.is_some() && m.last_seen.is_some_and(|seen| now - seen >= GAME_GRACE_MS) {
            m.game = None;
            // Turning it off only lasted for that game.
            if m.manual == Some(false) {
                m.manual = None;
            }
        }
    }
    update(state).await;
}

/// Picks up where it was, then follows games for as long as the server runs.
pub async fn start(state: State) {
    let saved = std::fs::read_to_string(&state.game_mode.path)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok());
    if let Some(saved) = saved.filter(|s| s["active"] == true) {
        // On while a game ran: give it the grace period from now, in case the game is still going.
        let now = now_ms();
        *state.game_mode.mode.lock().unwrap() = Mode {
            manual: saved["manual"].as_bool(),
            active: true,
            game: saved["game"].as_str().map(str::to_owned),
            last_seen: Some(now),
            since: Some(now),
        };
        // After a reboot the services started with everything else, so stop them again.
        stop_units(&state).await;
    }
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(GAME_CHECK_INTERVAL);
        loop {
            tick.tick().await;
            check(&state).await;
        }
    });
}

pub async fn get(AxumState(state): AxumState<State>) -> Json<Value> {
    Json(state.game_mode.state())
}

pub async fn set(AxumState(state): AxumState<State>, body: Bytes) -> Result<Json<Value>, HttpError> {
    let body = crate::machine::json_body(&body)?;
    let Some(on) = body.get("on").and_then(Value::as_bool) else {
        return Err(HttpError(StatusCode::BAD_REQUEST, r#"Expected { "on": true | false }"#.into()));
    };
    println!("game mode {on}");
    {
        let mut m = state.game_mode.mode.lock().unwrap();
        m.manual = if on {
            Some(true)
        } else if m.game.is_some() {
            Some(false)
        } else {
            None
        };
    }
    update(&state).await;
    Ok(Json(state.game_mode.state()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steam_files() {
        let vdf = "\"libraryfolders\"\n{\n\t\"0\"\n\t{\n\t\t\"path\"\t\t\"/home/u/.local/share/Steam\"\n\t}\n\t\"1\"\n\t{\n\t\t\"path\"\t\t\"/games\"\n\t}\n}";
        assert_eq!(vdf_values(vdf, "path"), ["/home/u/.local/share/Steam", "/games"]);
        let acf = "\"AppState\"\n{\n\t\"appid\"\t\t\"620\"\n\t\"name\"\t\t\"Portal 2\"\n}";
        assert_eq!(vdf_values(acf, "name"), ["Portal 2"]);
    }
}

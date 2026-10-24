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
use crate::events::{Event, Notice, notify};
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
/// Between tries at starting the services after that failed: rarely enough not to hit systemd's
/// start limit on a unit that keeps failing.
const START_RETRY_MS: i64 = 5 * 60_000;
/// Tries in all, about half an hour, before giving up and saying so: a unit broken for good
/// (gluetun with expired credentials) would otherwise be started, with the rest, forever.
const START_TRIES: u32 = 6;

#[derive(Default, Clone)]
struct Mode {
    /// Set from the app: Some(true) or Some(false); None while following games.
    manual: Option<bool>,
    active: bool,
    /// The game running, or the last one, kept through the grace period.
    game: Option<String>,
    last_seen: Option<i64>,
    since: Option<i64>,
    /// Starting the services when game mode went off failed: when to try again. Saved as
    /// `retryStart`, so a restart of this server tries again straight away.
    retry_start_at: Option<i64>,
    /// Tries at starting them so far.
    start_tries: u32,
}

pub struct GameMode {
    file: crate::files::JsonFile,
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
            file: crate::files::JsonFile::new(dir.join("game-mode.json"), "game mode"),
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
        if m.retry_start_at.is_some() {
            saved.insert("retryStart".into(), json!(true));
        }
        self.file.save(&saved);
    }
}

async fn stop_units(state: &State) -> Result<(), String> {
    let units = unit_files(|_| true);
    let mut stop = args!["--user", "stop"].to_vec();
    stop.extend(units.iter().cloned());
    let result = run("systemctl", &stop, UNITS_TIMEOUT).await;
    state.services.expire(&state.usage);
    // Some exit with an error when stopped (gluetun with 1); that's not a failure worth showing.
    let mut reset = args!["--user", "reset-failed"].to_vec();
    reset.extend(units);
    let _ = run("systemctl", &reset, Duration::from_secs(30)).await;
    result.map(|_| ())
}

/// Starts what game mode stopped, apart from the services that only run on demand.
async fn start_units(state: &State) -> Result<(), String> {
    let mut start = args!["--user", "start"].to_vec();
    start.extend(unit_files(|u| !ON_DEMAND_UNITS.contains(&u)));
    let result = run("systemctl", &start, UNITS_TIMEOUT).await.map(|_| ());
    state.services.expire(&state.usage);
    result
}

/// Starts or stops the services if game mode should change.
async fn update(state: &State) {
    let gm = &state.game_mode;
    let _changing = gm.changing.lock().await;
    enum Next {
        Change(bool, Option<String>),
        RetryStart,
        Nothing,
    }
    let next = {
        let mut m = gm.mode.lock().unwrap();
        let want = m.manual.unwrap_or(m.game.is_some());
        if want != m.active {
            // On straight away, so what it stops refuses work while it does; saved once it's done.
            m.active = want;
            m.since = Some(now_ms());
            m.retry_start_at = None;
            m.start_tries = 0;
            Next::Change(want, m.game.clone())
        } else if !want && m.retry_start_at.is_some_and(|at| now_ms() >= at) {
            Next::RetryStart
        } else {
            Next::Nothing
        }
    };
    let (want, game) = match next {
        Next::Change(want, game) => (want, game),
        Next::RetryStart => return retry_start(state).await,
        Next::Nothing => return,
    };
    println!(
        "Game mode {}{}",
        if want { "on" } else { "off" },
        game.as_ref().map(|g| format!(" ({g})")).unwrap_or_default()
    );
    let result = if want { stop_units(state).await } else { start_units(state).await };
    // The change stands either way: going back would leave the services stopped with game mode
    // off, or game mode stuck on with no game. A stop does what it can; a start that didn't work
    // is tried again (see retry_start), since a unit left inactive raises no alert.
    if let Err(e) = result {
        eprintln!("Couldn't {} all the game mode services: {e}", if want { "stop" } else { "start" });
        if !want {
            let mut m = gm.mode.lock().unwrap();
            m.retry_start_at = Some(now_ms() + START_RETRY_MS);
            m.start_tries = 1;
        }
    }
    let mut e = Event::new(now_ms(), "game");
    e.on = Some(want);
    e.detail = game;
    state.recorder.events.lock().unwrap().add(e);
    gm.save(&gm.mode.lock().unwrap());
}

/// Another go at starting the services after it failed when game mode went off. Runs from
/// update(), holding `changing`, so game mode can't come back on meanwhile.
async fn retry_start(state: &State) {
    let gm = &state.game_mode;
    let result = start_units(state).await;
    let give_up = {
        let mut m = gm.mode.lock().unwrap();
        m.start_tries += 1;
        let give_up = match &result {
            Ok(()) => {
                println!("Started the game mode services on another try");
                None
            }
            Err(e) if m.start_tries >= START_TRIES => {
                eprintln!("Starting the game mode services failed {} times, giving up: {e}", m.start_tries);
                Some(e.clone())
            }
            Err(e) => {
                eprintln!("Starting the game mode services failed again: {e}");
                m.retry_start_at = Some(now_ms() + START_RETRY_MS);
                gm.save(&m);
                return;
            }
        };
        m.retry_start_at = None;
        m.start_tries = 0;
        gm.save(&m);
        give_up
    };
    if let Some(e) = give_up {
        notify(
            &state.upstream,
            Notice {
                title: "Services didn't come back after game mode".into(),
                message: format!("Starting them failed {START_TRIES} times: {e}"),
                tags: "warning",
                click: Some("homebase://server".into()),
            },
        )
        .await;
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
    let saved = state.game_mode.file.load::<Value>();
    if let Some(saved) = saved.as_ref().filter(|s| s["active"] == true) {
        // On while a game ran: give it the grace period from now, in case the game is still going.
        let now = now_ms();
        *state.game_mode.mode.lock().unwrap() = Mode {
            manual: saved["manual"].as_bool(),
            active: true,
            game: saved["game"].as_str().map(str::to_owned),
            last_seen: Some(now),
            since: Some(now),
            retry_start_at: None,
            start_tries: 0,
        };
        // After a reboot the services started with everything else, so stop them again.
        if let Err(e) = stop_units(&state).await {
            eprintln!("Couldn't stop the game mode services: {e}");
        }
    } else if saved.is_some_and(|s| s["retryStart"] == true) {
        // Starting the services was still failing when this server stopped: try again now.
        let mut m = state.game_mode.mode.lock().unwrap();
        m.retry_start_at = Some(now_ms());
        m.start_tries = 1;
    }
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(GAME_CHECK_INTERVAL);
        // A slow change holds up the checks; don't make up the missed ones back to back.
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
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

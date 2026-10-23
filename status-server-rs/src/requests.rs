//! Requests: searching for shows and movies, their title pages, and asking for them, done with
//! Sonarr's and Radarr's own lookups. Took over from Seerr on 2026-10-23 and answers in the shape
//! the app knew from Seerr, so a title's id is its TMDB id.
//!
//! Nothing is approved or tracked here: what a title's status is comes from Sonarr or Radarr
//! (in the library, monitored, files on disk). Only the list of recent requests is kept, in
//! `requests.json`, and a title taken out of Sonarr or Radarr drops off it.
//!
//! Shows that TheTVDB has no TMDB id for are left out of searches, as they were in Seerr.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::http::Method;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::args;
use crate::command::output;
use crate::http::{HttpError, State};
use crate::media::arr_call;
use crate::usage::now_ms;

const ROOT_SHOWS: &str = "/data/Shows";
const ROOT_MOVIES: &str = "/data/Movies";
/// The quality profiles a request gets unless it picks one, by name since recyclarr owns them.
const DEFAULT_SHOW_PROFILE: &str = "WEB-1080p";
const DEFAULT_MOVIE_PROFILE: &str = "HD Bluray + WEB";
/// How long Sonarr's and Radarr's libraries are reused between calls.
const LIBRARY_FOR: Duration = Duration::from_secs(30);
/// Titles' details from the metadata servers change slowly.
const LOOKUP_FOR: Duration = Duration::from_secs(6 * 3600);
const KEPT: usize = 200;
const SEARCH_RESULTS: usize = 20;

/// Seerr's statuses, which the app still uses.
const UNKNOWN: u8 = 1;
const PROCESSING: u8 = 3;
const PARTIALLY_AVAILABLE: u8 = 4;
const AVAILABLE: u8 = 5;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Request {
    id: u64,
    #[serde(rename = "type")]
    kind: String,
    tmdb_id: i64,
    #[serde(default)]
    seasons: Vec<i64>,
    created_at: String,
}

struct Timed<T>(Mutex<HashMap<String, (Instant, Arc<T>)>>, Duration);

impl<T> Timed<T> {
    fn new(keep_for: Duration) -> Self {
        Self(Mutex::default(), keep_for)
    }

    fn get(&self, key: &str) -> Option<Arc<T>> {
        let map = self.0.lock().unwrap();
        map.get(key).filter(|(at, _)| at.elapsed() < self.1).map(|(_, v)| Arc::clone(v))
    }

    fn put(&self, key: String, value: T) -> Arc<T> {
        let value = Arc::new(value);
        let mut map = self.0.lock().unwrap();
        map.retain(|_, (at, _)| at.elapsed() < self.1);
        map.insert(key, (Instant::now(), Arc::clone(&value)));
        value
    }

    fn clear(&self) {
        self.0.lock().unwrap().clear();
    }
}

pub struct Requests {
    path: PathBuf,
    saved: Mutex<Vec<Request>>,
    /// Sonarr's series list, Radarr's movie list, and a series' episodes, by "series", "movies"
    /// and "episodes:<id>".
    library: Timed<Value>,
    /// Lookups by "tv:<tmdb id>", "movie:<tmdb id>" and "tvdb:<tvdb id>".
    lookups: Timed<Value>,
}

impl Requests {
    pub fn new(dir: &Path) -> Self {
        let path = dir.join("requests.json");
        let saved = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Self {
            path,
            saved: Mutex::new(saved),
            library: Timed::new(LIBRARY_FOR),
            lookups: Timed::new(LOOKUP_FOR),
        }
    }

    fn save(&self, saved: &[Request]) {
        let result = serde_json::to_vec(saved)
            .map_err(std::io::Error::other)
            .and_then(|bytes| crate::files::write_private(&self.path, &bytes));
        if let Err(e) = result {
            eprintln!("Couldn't save requests: {e}");
        }
    }
}

fn bad_request(message: impl Into<String>) -> HttpError {
    HttpError(axum::http::StatusCode::BAD_REQUEST, message.into())
}

fn upstream(e: String) -> HttpError {
    HttpError(axum::http::StatusCode::BAD_GATEWAY, e)
}

fn not_found() -> HttpError {
    HttpError(axum::http::StatusCode::NOT_FOUND, "Not found".into())
}

/// `/api/requests/{path}`.
pub async fn handle(state: &State, method: &Method, path: &str, query: &str, body: &[u8]) -> Result<Value, HttpError> {
    let param = |name: &str| {
        url::form_urlencoded::parse(query.as_bytes())
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.into_owned())
    };
    let id = |prefix: &str| path.strip_prefix(prefix).and_then(|n| n.parse::<i64>().ok());
    match (method.as_str(), path) {
        ("GET", "search") => {
            state.game_mode.error("Requests")?;
            search(state, param("query").unwrap_or_default().trim()).await.map_err(upstream)
        }
        ("GET", "request") => {
            state.game_mode.error("Requests")?;
            let take = param("take").and_then(|t| t.parse().ok()).unwrap_or(10);
            recent(state, take).await.map_err(upstream)
        }
        ("POST", "request") => {
            let body: Value = serde_json::from_slice(body).map_err(|_| bad_request("Expected JSON"))?;
            request(state, &body).await
        }
        // Seerr kept titles it had sent on; here a title removed from Sonarr or Radarr is simply gone.
        ("DELETE", _) if id("media/").is_some() => Ok(Value::Null),
        ("GET", _) => {
            if let Some(tmdb) = id("movie/") {
                state.game_mode.error("Radarr")?;
                movie_details(state, tmdb).await.map_err(upstream)
            } else if let Some(tmdb) = id("tv/") {
                state.game_mode.error("Sonarr")?;
                show_details(state, tmdb).await.map_err(upstream)
            } else {
                Err(not_found())
            }
        }
        _ => Err(not_found()),
    }
}

// ---------------------------------------------------------------------------------------------
// Sonarr's and Radarr's libraries, and what's in them

async fn library(state: &State, key: &str, app: &str, path: &str) -> Result<Arc<Value>, String> {
    let lib = &state.requests.library;
    if let Some(v) = lib.get(key) {
        return Ok(v);
    }
    let v = arr_call(state, app, Method::GET, path, None).await?;
    Ok(lib.put(key.to_owned(), v))
}

async fn library_series(state: &State) -> Result<Arc<Value>, String> {
    library(state, "series", "sonarr", "series").await
}

async fn library_movies(state: &State) -> Result<Arc<Value>, String> {
    library(state, "movies", "radarr", "movie").await
}

fn find_by<'a>(list: &'a Value, field: &str, id: i64) -> Option<&'a Value> {
    list.as_array()?.iter().find(|i| i[field].as_i64() == Some(id))
}

/// Episodes aired and on disk in each season of a series in Sonarr.
#[derive(Default, Clone, Copy)]
struct SeasonCount {
    episodes: u32,
    aired: u32,
    files: u32,
    first_aired: Option<i64>,
}

fn days(date: &str) -> Option<i64> {
    // "2024-07-10" or "2024-07-11T01:00:00Z", as 20240710.
    let mut parts = date.get(..10)?.split('-').map(|p| p.parse::<i64>().ok());
    let (y, m, d) = (parts.next()??, parts.next()??, parts.next()??);
    Some(y * 10_000 + m * 100 + d)
}

fn today() -> i64 {
    let secs = now_ms() / 1000;
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    y * 10_000 + m * 100 + d
}

/// Days since 1970-01-01 to a year, month and day (Howard Hinnant's algorithm).
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// Episodes by season, from Sonarr's list or Skyhook's, which both have the local `airDate`.
fn count_seasons(episodes: &Value) -> HashMap<i64, SeasonCount> {
    let today = today();
    let mut seasons: HashMap<i64, SeasonCount> = HashMap::new();
    for e in episodes.as_array().into_iter().flatten() {
        let Some(n) = e["seasonNumber"].as_i64() else { continue };
        let s = seasons.entry(n).or_default();
        s.episodes += 1;
        let aired = e["airDate"].as_str().and_then(days);
        if aired.is_some_and(|a| a <= today) {
            s.aired += 1;
        }
        if let Some(a) = aired {
            s.first_aired = Some(s.first_aired.map_or(a, |f| f.min(a)));
        }
        if e["hasFile"].as_bool() == Some(true) {
            s.files += 1;
        }
    }
    seasons
}

async fn series_episodes(state: &State, series_id: i64) -> Result<Arc<Value>, String> {
    library(state, &format!("episodes:{series_id}"), "sonarr", &format!("episode?seriesId={series_id}")).await
}

fn season_status(count: SeasonCount, monitored: bool) -> u8 {
    if count.aired > 0 && count.files >= count.aired {
        AVAILABLE
    } else if count.files > 0 {
        PARTIALLY_AVAILABLE
    } else if monitored {
        PROCESSING
    } else {
        UNKNOWN
    }
}

/// Seerr's `mediaInfo` for a series in Sonarr.
async fn series_info(state: &State, tmdb: i64, series: &Value) -> Result<Value, String> {
    let id = series["id"].as_i64().unwrap_or_default();
    let counts = count_seasons(&*series_episodes(state, id).await?);
    let seasons: Vec<(i64, u8, u32)> = series["seasons"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|s| {
            let n = s["seasonNumber"].as_i64().filter(|n| *n > 0)?;
            let count = counts.get(&n).copied().unwrap_or_default();
            Some((n, season_status(count, s["monitored"].as_bool() == Some(true)), count.aired))
        })
        .collect();
    let aired: Vec<u8> = seasons.iter().filter(|(_, _, a)| *a > 0).map(|(_, s, _)| *s).collect();
    let status = if !aired.is_empty() && aired.iter().all(|s| *s == AVAILABLE) {
        AVAILABLE
    } else if aired.iter().any(|s| *s == AVAILABLE || *s == PARTIALLY_AVAILABLE) {
        PARTIALLY_AVAILABLE
    } else if seasons.iter().any(|(_, s, _)| *s == PROCESSING) {
        PROCESSING
    } else {
        UNKNOWN
    };
    Ok(json!({
        "id": tmdb,
        "status": status,
        "externalServiceId": id,
        "seasons": seasons.iter().map(|(n, s, _)| json!({ "seasonNumber": n, "status": s })).collect::<Vec<_>>(),
    }))
}

fn movie_info(tmdb: i64, movie: &Value) -> Value {
    let status = if movie["hasFile"].as_bool() == Some(true) {
        AVAILABLE
    } else if movie["monitored"].as_bool() == Some(true) {
        PROCESSING
    } else {
        UNKNOWN
    };
    json!({ "id": tmdb, "status": status, "externalServiceId": movie["id"] })
}

// ---------------------------------------------------------------------------------------------
// Looking titles up

/// An image's address. TMDB's are given as a path, which the app sizes itself; TheTVDB's whole.
fn image(item: &Value, kind: &str) -> Value {
    let url = item["images"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|i| i["coverType"] == kind)
        .and_then(|i| i["remoteUrl"].as_str());
    match url {
        Some(u) => match u.strip_prefix("https://image.tmdb.org/t/p/original") {
            Some(path) => json!(path),
            None => json!(u),
        },
        None => Value::Null,
    }
}

fn date(v: &Value) -> Value {
    v.as_str().and_then(|d| d.get(..10)).map_or(Value::Null, |d| json!(d))
}

/// When a movie came out in cinemas, or just its year when that isn't known.
fn release(movie: &Value) -> Value {
    match date(&movie["inCinemas"]) {
        Value::Null => json!(movie["year"].as_i64().filter(|y| *y > 0).map(|y| format!("{y}-01-01"))),
        d => d,
    }
}

fn genres(item: &Value) -> Value {
    item["genres"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|g| g.as_str())
        .map(|g| json!({ "name": g }))
        .collect()
}

async fn lookup_show(state: &State, tmdb: i64) -> Result<Arc<Value>, String> {
    let key = format!("tv:{tmdb}");
    if let Some(v) = state.requests.lookups.get(&key) {
        return Ok(v);
    }
    let found = arr_call(state, "sonarr", Method::GET, &format!("series/lookup?term=tmdb:{tmdb}"), None).await?;
    let show = found
        .as_array()
        .and_then(|a| a.iter().find(|s| s["tmdbId"].as_i64() == Some(tmdb)))
        .cloned()
        .ok_or("TheTVDB doesn't know this show")?;
    Ok(state.requests.lookups.put(key, show))
}

async fn lookup_movie(state: &State, tmdb: i64) -> Result<Arc<Value>, String> {
    let key = format!("movie:{tmdb}");
    if let Some(v) = state.requests.lookups.get(&key) {
        return Ok(v);
    }
    let movie = arr_call(state, "radarr", Method::GET, &format!("movie/lookup/tmdb?tmdbId={tmdb}"), None).await?;
    if movie["tmdbId"].as_i64() != Some(tmdb) {
        return Err("TMDB doesn't know this movie".into());
    }
    Ok(state.requests.lookups.put(key, movie))
}

/// A show's episodes from Skyhook, Sonarr's metadata server, for shows not in Sonarr yet.
async fn skyhook_episodes(state: &State, tvdb: i64) -> Result<Arc<Value>, String> {
    let key = format!("tvdb:{tvdb}");
    if let Some(v) = state.requests.lookups.get(&key) {
        return Ok(v);
    }
    // curl, since the server's own client only speaks plain HTTP to this machine.
    let url = format!("https://skyhook.sonarr.tv/v1/tvdb/shows/en/{tvdb}");
    let out = output("curl", &args!["-fsS", "--max-time", "20", url], Duration::from_secs(30)).await?;
    if !out.success {
        return Err(format!("Couldn't get the episodes: {}", out.stderr.trim()));
    }
    let show: Value = serde_json::from_str(&out.stdout).map_err(|e| e.to_string())?;
    Ok(state.requests.lookups.put(key, show["episodes"].clone()))
}

async fn search(state: &State, query: &str) -> Result<Value, String> {
    if query.is_empty() {
        return Ok(json!({ "results": [] }));
    }
    let term: String = url::form_urlencoded::byte_serialize(query.as_bytes()).collect();
    let (show_path, movie_path) = (format!("series/lookup?term={term}"), format!("movie/lookup?term={term}"));
    let (shows, movies, series, library) = tokio::join!(
        arr_call(state, "sonarr", Method::GET, &show_path, None),
        arr_call(state, "radarr", Method::GET, &movie_path, None),
        library_series(state),
        library_movies(state),
    );
    // One app down still leaves the other's results.
    if let (Err(a), Err(b)) = (&shows, &movies) {
        return Err(format!("{a}; {b}"));
    }
    let shows = shows.unwrap_or_default();
    let movies = movies.unwrap_or_default();

    let mut tv = Vec::new();
    for s in shows.as_array().into_iter().flatten().take(SEARCH_RESULTS) {
        let Some(tmdb) = s["tmdbId"].as_i64().filter(|id| *id > 0) else { continue };
        let in_sonarr = series.as_ref().ok().and_then(|l| find_by(l, "tmdbId", tmdb));
        let info = match in_sonarr {
            Some(found) => series_info(state, tmdb, found).await.ok(),
            None => None,
        };
        tv.push(json!({
            "id": tmdb,
            "mediaType": "tv",
            "name": s["title"],
            "firstAirDate": date(&s["firstAired"]),
            "posterPath": image(s, "poster"),
            "mediaInfo": info,
        }));
    }
    let film: Vec<Value> = movies
        .as_array()
        .into_iter()
        .flatten()
        .take(SEARCH_RESULTS)
        .filter_map(|m| {
            let tmdb = m["tmdbId"].as_i64().filter(|id| *id > 0)?;
            let in_radarr = library.as_ref().ok().and_then(|l| find_by(l, "tmdbId", tmdb));
            Some(json!({
                "id": tmdb,
                "mediaType": "movie",
                "title": m["title"],
                "releaseDate": release(m),
                "posterPath": image(m, "poster"),
                "mediaInfo": in_radarr.map(|found| movie_info(tmdb, found)),
            }))
        })
        .collect();
    Ok(json!({ "results": merge(query, tv, film) }))
}

/// Shows and movies taken in turn, each list's best first, with titles matching the search
/// exactly ahead of the rest.
fn merge(query: &str, tv: Vec<Value>, film: Vec<Value>) -> Vec<Value> {
    let exact = |v: &Value| {
        v["title"].as_str().or(v["name"].as_str()).is_some_and(|t| t.eq_ignore_ascii_case(query))
    };
    let mut ranked: Vec<(bool, usize, Value)> = tv
        .into_iter()
        .enumerate()
        .map(|(i, v)| (2 * i + 1, v))
        .chain(film.into_iter().enumerate().map(|(i, v)| (2 * i, v)))
        .map(|(rank, v)| (!exact(&v), rank, v))
        .collect();
    ranked.sort_by_key(|(not_exact, rank, _)| (*not_exact, *rank));
    ranked.into_iter().map(|(_, _, v)| v).collect()
}

async fn show_details(state: &State, tmdb: i64) -> Result<Value, String> {
    let series = library_series(state).await?;
    let in_sonarr = find_by(&series, "tmdbId", tmdb).cloned();
    let (show, episodes, info) = match &in_sonarr {
        Some(s) => {
            let id = s["id"].as_i64().unwrap_or_default();
            (Arc::new(s.clone()), series_episodes(state, id).await?, Some(series_info(state, tmdb, s).await?))
        }
        None => {
            let show = lookup_show(state, tmdb).await?;
            let tvdb = show["tvdbId"].as_i64().unwrap_or_default();
            (Arc::clone(&show), skyhook_episodes(state, tvdb).await?, None)
        }
    };
    let counts = count_seasons(&episodes);
    let mut seasons: Vec<Value> = show["seasons"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|s| s["seasonNumber"].as_i64())
        .map(|n| {
            let c = counts.get(&n).copied().unwrap_or_default();
            json!({
                "seasonNumber": n,
                "episodeCount": c.episodes,
                "name": if n == 0 { "Specials".to_owned() } else { format!("Season {n}") },
                "airDate": c.first_aired.map(|d| format!("{:04}-{:02}-{:02}", d / 10_000, d / 100 % 100, d % 100)),
            })
        })
        .collect();
    seasons.sort_by_key(|s| s["seasonNumber"].as_i64());
    let runtime = show["runtime"].as_i64().filter(|r| *r > 0);
    Ok(json!({
        "id": tmdb,
        "name": show["title"],
        "overview": show["overview"],
        "firstAirDate": date(&show["firstAired"]),
        "episodeRunTime": runtime.map(|r| vec![r]).unwrap_or_default(),
        "voteAverage": show["ratings"]["value"],
        "genres": genres(&show),
        "posterPath": image(&show, "poster"),
        "backdropPath": image(&show, "fanart"),
        "seasons": seasons,
        "status": show["status"],
        "mediaInfo": info,
    }))
}

async fn movie_details(state: &State, tmdb: i64) -> Result<Value, String> {
    let movies = library_movies(state).await?;
    let in_radarr = find_by(&movies, "tmdbId", tmdb).cloned();
    let movie = match &in_radarr {
        Some(m) => Arc::new(m.clone()),
        None => lookup_movie(state, tmdb).await?,
    };
    Ok(json!({
        "id": tmdb,
        "title": movie["title"],
        "overview": movie["overview"],
        "releaseDate": release(&movie),
        "runtime": movie["runtime"].as_i64().filter(|r| *r > 0),
        "voteAverage": movie["ratings"]["tmdb"]["value"],
        "genres": genres(&movie),
        "posterPath": image(&movie, "poster"),
        "backdropPath": image(&movie, "fanart"),
        "status": movie["status"],
        "mediaInfo": in_radarr.map(|m| movie_info(tmdb, &m)),
    }))
}

// ---------------------------------------------------------------------------------------------
// Asking for titles, and the list of what was asked for

async fn profile(state: &State, app: &str, chosen: Option<i64>, default: &str) -> Result<i64, HttpError> {
    let profiles = arr_call(state, app, Method::GET, "qualityprofile", None).await.map_err(upstream)?;
    let list = profiles.as_array().cloned().unwrap_or_default();
    let found = match chosen {
        Some(id) => list.iter().find(|p| p["id"].as_i64() == Some(id)),
        None => list.iter().find(|p| p["name"] == default).or(list.first()),
    };
    found
        .and_then(|p| p["id"].as_i64())
        .ok_or_else(|| bad_request("No such quality profile"))
}

async fn request(state: &State, body: &Value) -> Result<Value, HttpError> {
    let kind = body["mediaType"].as_str().unwrap_or_default();
    let tmdb = body["mediaId"].as_i64().filter(|id| *id > 0).ok_or_else(|| bad_request("Which title?"))?;
    let chosen = body["profileId"].as_i64();
    let seasons: Vec<i64> = match kind {
        "movie" => Vec::new(),
        "tv" => {
            let s: Vec<i64> = body["seasons"].as_array().into_iter().flatten().filter_map(Value::as_i64).filter(|n| *n > 0).collect();
            if s.is_empty() {
                return Err(bad_request("Which seasons?"));
            }
            s
        }
        _ => return Err(bad_request("mediaType must be movie or tv")),
    };
    println!("Request {kind} {tmdb} {seasons:?}");
    if kind == "movie" {
        state.game_mode.error("Radarr")?;
        request_movie(state, tmdb, chosen).await?;
    } else {
        state.game_mode.error("Sonarr")?;
        request_show(state, tmdb, &seasons, chosen).await?;
    }
    state.requests.library.clear();

    let mut saved = state.requests.saved.lock().unwrap();
    let id = saved.iter().map(|r| r.id).max().unwrap_or_default() + 1;
    let created_at = iso_now();
    let request = Request { id, kind: kind.to_owned(), tmdb_id: tmdb, seasons, created_at };
    saved.push(request.clone());
    let extra = saved.len().saturating_sub(KEPT);
    saved.drain(..extra);
    state.requests.save(&saved);
    Ok(shaped(&request, PROCESSING))
}

async fn request_movie(state: &State, tmdb: i64, chosen: Option<i64>) -> Result<(), HttpError> {
    let movies = library_movies(state).await.map_err(upstream)?;
    if let Some(existing) = find_by(&movies, "tmdbId", tmdb) {
        let id = existing["id"].as_i64().unwrap_or_default();
        let mut movie = existing.clone();
        movie["monitored"] = json!(true);
        if let Some(p) = chosen {
            movie["qualityProfileId"] = json!(p);
        }
        arr_call(state, "radarr", Method::PUT, &format!("movie/{id}"), Some(movie)).await.map_err(upstream)?;
        arr_call(state, "radarr", Method::POST, "command", Some(json!({ "name": "MoviesSearch", "movieIds": [id] })))
            .await
            .map_err(upstream)?;
        return Ok(());
    }
    let mut movie = (*lookup_movie(state, tmdb).await.map_err(upstream)?).clone();
    movie["qualityProfileId"] = json!(profile(state, "radarr", chosen, DEFAULT_MOVIE_PROFILE).await?);
    movie["rootFolderPath"] = json!(ROOT_MOVIES);
    movie["monitored"] = json!(true);
    movie["minimumAvailability"] = json!("released");
    movie["addOptions"] = json!({ "searchForMovie": true });
    arr_call(state, "radarr", Method::POST, "movie", Some(movie)).await.map_err(upstream)?;
    Ok(())
}

async fn request_show(state: &State, tmdb: i64, wanted: &[i64], chosen: Option<i64>) -> Result<(), HttpError> {
    let series = library_series(state).await.map_err(upstream)?;
    if let Some(existing) = find_by(&series, "tmdbId", tmdb) {
        let id = existing["id"].as_i64().unwrap_or_default();
        let mut show = existing.clone();
        for s in show["seasons"].as_array_mut().into_iter().flatten() {
            if s["seasonNumber"].as_i64().is_some_and(|n| wanted.contains(&n)) {
                s["monitored"] = json!(true);
            }
        }
        show["monitored"] = json!(true);
        // Sonarr monitors a season's episodes when the season is.
        arr_call(state, "sonarr", Method::PUT, &format!("series/{id}"), Some(show)).await.map_err(upstream)?;
        for n in wanted {
            arr_call(state, "sonarr", Method::POST, "command", Some(json!({ "name": "SeasonSearch", "seriesId": id, "seasonNumber": n })))
                .await
                .map_err(upstream)?;
        }
        return Ok(());
    }
    let mut show = (*lookup_show(state, tmdb).await.map_err(upstream)?).clone();
    for s in show["seasons"].as_array_mut().into_iter().flatten() {
        let n = s["seasonNumber"].as_i64().unwrap_or_default();
        s["monitored"] = json!(wanted.contains(&n));
    }
    let anime = show["genres"].as_array().is_some_and(|g| g.iter().any(|g| g == "Anime"));
    show["seriesType"] = json!(if anime { "anime" } else { "standard" });
    show["qualityProfileId"] = json!(profile(state, "sonarr", chosen, DEFAULT_SHOW_PROFILE).await?);
    show["rootFolderPath"] = json!(ROOT_SHOWS);
    show["seasonFolder"] = json!(true);
    show["monitored"] = json!(true);
    show["addOptions"] = json!({ "searchForMissingEpisodes": true, "ignoreEpisodesWithFiles": true });
    arr_call(state, "sonarr", Method::POST, "series", Some(show)).await.map_err(upstream)?;
    Ok(())
}

fn iso_now() -> String {
    let ms = now_ms();
    let secs = ms / 1000;
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    let t = secs.rem_euclid(86_400);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z", t / 3600, t / 60 % 60, t % 60, ms % 1000)
}

fn shaped(r: &Request, status: u8) -> Value {
    json!({
        "id": r.id,
        "type": r.kind,
        // Seerr's "approved": nothing waits for approval here.
        "status": 2,
        "createdAt": r.created_at,
        "seasons": r.seasons.iter().map(|n| json!({ "seasonNumber": n })).collect::<Vec<_>>(),
        "media": { "tmdbId": r.tmdb_id, "status": status },
    })
}

/// The newest requests for titles still in Sonarr or Radarr.
async fn recent(state: &State, take: usize) -> Result<Value, String> {
    let saved = state.requests.saved.lock().unwrap().clone();
    let (series, movies) = tokio::join!(library_series(state), library_movies(state));
    let (series, movies) = (series?, movies?);
    let mut results = Vec::new();
    for r in saved.iter().rev() {
        if results.len() >= take {
            break;
        }
        let status = if r.kind == "tv" {
            match find_by(&series, "tmdbId", r.tmdb_id) {
                Some(s) => series_info(state, r.tmdb_id, s).await?["status"].as_u64().unwrap_or(1) as u8,
                None => continue,
            }
        } else {
            match find_by(&movies, "tmdbId", r.tmdb_id) {
                Some(m) => movie_info(r.tmdb_id, m)["status"].as_u64().unwrap_or(1) as u8,
                None => continue,
            }
        };
        results.push(shaped(r, status));
    }
    Ok(json!({ "results": results }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(20_749), (2026, 10, 23));
        assert!(days("2024-07-10").unwrap() < days("2024-07-11T01:00:00Z").unwrap());
        assert!(days("2024-12-31").unwrap() < days("2025-01-01").unwrap());
    }

    #[test]
    fn seasons() {
        let eps = json!([
            { "seasonNumber": 1, "airDate": "2020-01-01", "hasFile": true },
            { "seasonNumber": 1, "airDate": "2020-01-08", "hasFile": true },
            { "seasonNumber": 2, "airDate": "2021-01-01", "hasFile": true },
            { "seasonNumber": 2, "airDate": "2021-01-08", "hasFile": false },
            { "seasonNumber": 3, "airDate": "2999-01-01" },
        ]);
        let c = count_seasons(&eps);
        assert_eq!(season_status(c[&1], false), AVAILABLE);
        assert_eq!(season_status(c[&2], false), PARTIALLY_AVAILABLE);
        assert_eq!(season_status(c[&2], true), PARTIALLY_AVAILABLE);
        assert_eq!(season_status(c[&3], true), PROCESSING);
        assert_eq!(season_status(c[&3], false), UNKNOWN);
        assert_eq!(c[&3].aired, 0);
        assert_eq!(c[&3].episodes, 1);
    }

    #[test]
    fn exact_titles_first() {
        let tv = vec![json!({ "name": "Dune: Prophecy" })];
        let film = vec![json!({ "title": "Dune: Part Two" }), json!({ "title": "Dune" })];
        let merged = merge("dune", tv, film);
        assert_eq!(merged[0]["title"], "Dune");
        assert_eq!(merged[1]["title"], "Dune: Part Two");
        assert_eq!(merged[2]["name"], "Dune: Prophecy");
    }
}

//! The machine's own screens: the CPU, power and what it costs, what fills the media drive, the
//! Tailscale devices, and the drives' health with what's using each.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use axum::Json;
use axum::body::Bytes;
use axum::extract::State as AxumState;
use axum::http::StatusCode;
use serde_json::{Map, Value, json};

use crate::args;
use crate::command;
use crate::history::num;
use crate::http::{HttpError, State};
use crate::js;
use crate::kernel::{self, read_number, read_trimmed};
use crate::usage::{UNITS, group_label, now_ms, pressure, service_groups};

fn bad_request(message: &str) -> HttpError {
    HttpError(StatusCode::BAD_REQUEST, message.into())
}

/// A request body as JSON; an empty one is `{}`.
pub fn json_body(body: &Bytes) -> Result<Value, HttpError> {
    if body.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_slice(body).map_err(|_| bad_request("Expected JSON"))
}

// ---------------------------------------------------------------------------------------------
// CPU: each core's load and clock speed, and the package's power draw.

pub async fn cpu(AxumState(state): AxumState<State>) -> Json<Value> {
    let model = state.machine.cpu_model.lock().unwrap().clone();
    let model = match model {
        Some(m) => m,
        None => {
            let info = kernel::read("/proc/cpuinfo").unwrap_or_default();
            let m = info.lines().find_map(|l| {
                let (k, v) = l.split_once(':')?;
                (k.trim_end() == "model name").then(|| v.trim().to_owned())
            });
            *state.machine.cpu_model.lock().unwrap() = Some(m.clone());
            m
        }
    };
    let (clocks, temps, press, max_khz, governor, preference) = tokio::task::spawn_blocking(|| {
        let dir = "/sys/devices/system/cpu/cpu0/cpufreq";
        (
            crate::recorder::cpu_clocks(),
            crate::status::temperatures(),
            pressure(10),
            read_number(format!("{dir}/cpuinfo_max_freq")),
            read_trimmed(format!("{dir}/scaling_governor")),
            read_trimmed(format!("{dir}/energy_performance_preference")),
        )
    })
    .await
    .unwrap_or_default();
    let load: Vec<f64> = read_trimmed("/proc/loadavg")
        .unwrap_or_default()
        .split(' ')
        .take(3)
        .map(|v| v.parse().unwrap_or(0.0))
        .collect();
    let rates = state.sampler.rates.lock().unwrap();
    let mut out = Map::new();
    if let Some(m) = model {
        out.insert("model".into(), json!(m));
    }
    if let Some(u) = rates.cpu {
        out.insert("usage".into(), num(u));
    }
    out.insert("load".into(), json!(load));
    let cores: Vec<Value> = rates
        .cores
        .iter()
        .enumerate()
        .map(|(i, usage)| {
            let mut c = Map::new();
            if let Some(u) = usage {
                c.insert("usage".into(), num(*u));
            }
            if let Some(khz) = clocks.get(i) {
                c.insert("mhz".into(), num((khz / 1000.0).round()));
            }
            Value::Object(c)
        })
        .collect();
    out.insert("cores".into(), json!(cores));
    if let Some(k) = max_khz {
        out.insert("maxMhz".into(), num(if k == 0.0 { 0.0 } else { (k / 1000.0).round() }));
    }
    if let Some(t) = temps.iter().find(|t| t.label == "CPU") {
        out.insert("temperature".into(), num(t.celsius));
    }
    if let Some(w) = rates.cpu_watts {
        out.insert("watts".into(), num(w));
    }
    if let Some(e) = rates.cpu_power_error {
        out.insert("powerError".into(), json!(e));
    }
    out.insert("pressure".into(), Value::Object(press));
    if let Some(g) = governor {
        out.insert("governor".into(), json!(g));
    }
    if let Some(p) = preference {
        out.insert("preference".into(), json!(p));
    }
    out.insert("at".into(), json!(now_ms()));
    Json(Value::Object(out))
}

// ---------------------------------------------------------------------------------------------
// Power: the CPU package's and graphics card's measured draw, and what that costs. The rest of
// the PC (drives, board, fans, the power supply's losses) isn't measured, so it's an estimate set
// in the app, added on top.

#[derive(Clone)]
struct PowerSettings {
    price_per_kwh: Option<f64>,
    currency: String,
    other_watts: f64,
}

impl PowerSettings {
    fn to_json(&self) -> Map<String, Value> {
        let mut m = Map::new();
        if let Some(p) = self.price_per_kwh {
            m.insert("pricePerKwh".into(), num(p));
        }
        m.insert("currency".into(), json!(self.currency));
        m.insert("otherWatts".into(), num(self.other_watts));
        m
    }
}

pub struct Machine {
    cpu_model: Mutex<Option<Option<String>>>,
    power_path: PathBuf,
    power: Mutex<PowerSettings>,
}

impl Machine {
    pub fn new(dir: &Path) -> Self {
        let power_path = dir.join("power.json");
        let mut power = PowerSettings {
            price_per_kwh: None,
            currency: "$".into(),
            other_watts: 0.0,
        };
        if let Some(saved) = std::fs::read_to_string(&power_path)
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        {
            if let Some(p) = saved.get("pricePerKwh") {
                power.price_per_kwh = p.as_f64();
            }
            if let Some(c) = saved["currency"].as_str() {
                power.currency = c.into();
            }
            if let Some(w) = saved["otherWatts"].as_f64() {
                power.other_watts = w;
            }
        }
        Self {
            cpu_model: Mutex::new(None),
            power_path,
            power: Mutex::new(power),
        }
    }
}

fn power_state(state: &State) -> Value {
    let mut m = state.machine.power.lock().unwrap().to_json();
    let rates = state.sampler.rates.lock().unwrap();
    if let Some(w) = rates.cpu_watts {
        m.insert("cpuWatts".into(), num(w));
    }
    if let Some(e) = rates.cpu_power_error {
        m.insert("cpuPowerError".into(), json!(e));
    }
    Value::Object(m)
}

pub async fn power(AxumState(state): AxumState<State>) -> Json<Value> {
    Json(power_state(&state))
}

pub async fn set_power(AxumState(state): AxumState<State>, body: Bytes) -> Result<Json<Value>, HttpError> {
    let body = json_body(&body)?;
    let body = if body.is_null() { json!({}) } else { body };
    println!("power settings {body}");
    let mut next = state.machine.power.lock().unwrap().clone();
    if let Some(p) = body.get("pricePerKwh") {
        let price = (!p.is_null()).then(|| js::number(p));
        if price.is_some_and(|p| !(0.0..100.0).contains(&p)) {
            return Err(bad_request("Price must be a number per kWh"));
        }
        next.price_per_kwh = price;
    }
    if let Some(c) = body.get("currency") {
        match c.as_str() {
            Some(c) if c.encode_utf16().count() <= 4 => next.currency = c.into(),
            _ => return Err(bad_request("Currency must be a short symbol")),
        }
    }
    if let Some(w) = body.get("otherWatts") {
        let watts = js::number(w);
        if !(0.0..=1000.0).contains(&watts) {
            return Err(bad_request("Other watts must be 0 to 1000"));
        }
        next.other_watts = watts;
    }
    let saved = Value::Object(next.to_json()).to_string();
    crate::files::write_private(&state.machine.power_path, saved.as_bytes()).map_err(|e| HttpError::internal(e.to_string()))?;
    *state.machine.power.lock().unwrap() = next;
    Ok(Json(power_state(&state)))
}

// ---------------------------------------------------------------------------------------------
// Storage: what fills the media drive.

const STORAGE_ITEMS: usize = 8;

/// What the media drive holds, in this order: du counts a hardlinked file only the first time it
/// sees it, so downloads that are also in the library count toward the library.
const MEDIA_FOLDERS: &[(&str, &str, &str, usize)] = &[
    ("shows", "Shows", "Shows", 1),
    ("movies", "Movies", "Movies", 1),
    ("youtube", "YouTube", "Videos", 1),
    // tv/ and movies/ hold the torrents; list those rather than the two folders.
    ("downloads", "Downloads", "Downloads", 2),
    ("conversions", ".tdarr-cache", "Conversion cache", 1),
    ("partial", ".youtube-partial", "Unfinished videos", 1),
    ("backups", "Backups", "Backups", 1),
    ("trash", ".Trash-1000", "Trash", 1),
];

pub fn media_root() -> PathBuf {
    PathBuf::from(std::env::var("MEDIA_ROOT").unwrap_or_else(|_| "/mnt/media".into()))
}

/// `du -B1` output as sizes by path, in its order.
async fn du(args: Vec<String>) -> Result<Vec<(String, f64)>, HttpError> {
    let mut a = args!["-B1", "-x"].to_vec();
    a.extend(args);
    let out = command::output_in("du", &a, Duration::from_secs(120), Some(&media_root()))
        .await
        .map_err(HttpError::internal)?;
    // du exits 1 when it can't read something (lost+found) but still prints the rest.
    if !out.success && out.stdout.is_empty() {
        return Err(HttpError::internal(out.stderr));
    }
    Ok(out
        .stdout
        .lines()
        .filter_map(|l| {
            let (size, path) = l.split_once('\t')?;
            Some((path.to_owned(), size.parse().ok()?))
        })
        .collect())
}

pub async fn storage() -> Result<Json<Value>, HttpError> {
    let root = media_root();
    let present: Vec<_> = MEDIA_FOLDERS.iter().filter(|(_, dir, ..)| root.join(dir).exists()).collect();
    let mut tree = args!["-d", "2"].to_vec();
    tree.extend(present.iter().map(|(_, dir, ..)| dir.to_string()));
    let has_downloads = present.iter().any(|(id, ..)| *id == "downloads");
    let (sizes, alone) = tokio::join!(du(tree), async {
        if has_downloads {
            du(args!["-s", "Downloads"].to_vec()).await
        } else {
            Ok(Vec::new())
        }
    });
    let (sizes, alone) = (sizes?, alone?);
    let fs = crate::status::statfs(&root.to_string_lossy()).ok_or_else(|| HttpError::internal("Couldn't read the media drive"))?;

    let categories: Vec<Value> = present
        .iter()
        .map(|(id, dir, label, depth)| {
            let mut items: Vec<(String, f64)> = sizes
                .iter()
                .filter(|(p, _)| p.starts_with(&format!("{dir}/")) && p.split('/').count() == depth + 1)
                .map(|(p, bytes)| (p.rsplit('/').next().unwrap_or(p).to_owned(), *bytes))
                .filter(|(_, b)| *b > 0.0)
                .collect();
            items.sort_by(|a, b| b.1.total_cmp(&a.1));
            json!({
                "id": id,
                "label": label,
                "bytes": num(sizes.iter().find(|(p, _)| p == dir).map_or(0.0, |(_, b)| *b)),
                "items": items.iter().take(STORAGE_ITEMS).map(|(name, bytes)| json!({ "name": name, "bytes": num(*bytes) })).collect::<Vec<_>>(),
                "more": items.len().saturating_sub(STORAGE_ITEMS),
            })
        })
        .collect();
    let bsize = fs.f_bsize as f64;
    let total = fs.f_blocks as f64 * bsize;
    let downloads = categories.iter().find(|c| c["id"] == "downloads");
    let downloads_alone = alone.iter().find(|(p, _)| p == "Downloads").map_or(0.0, |(_, b)| *b);
    Ok(Json(json!({
        "mount": root.to_string_lossy(),
        "totalBytes": num(total),
        "usedBytes": num(total - fs.f_bfree as f64 * bsize),
        "availableBytes": num(fs.f_bavail as f64 * bsize),
        "categories": categories,
        // Downloads that are hardlinked into the library and so take no extra room.
        "sharedDownloadBytes": num(downloads.map_or(0.0, |d| (downloads_alone - d["bytes"].as_f64().unwrap_or(0.0)).max(0.0))),
        "at": now_ms(),
    })))
}

// ---------------------------------------------------------------------------------------------
// Tailscale

fn tailscale_time(v: &Value) -> Option<i64> {
    v.as_str()
        .filter(|s| !s.is_empty() && !s.starts_with("0001-"))
        .and_then(js::parse_time)
}

fn tailscale_device(p: &Value, this: bool) -> Value {
    let dns = p["DNSName"].as_str().and_then(|d| d.split('.').next()).filter(|d| !d.is_empty());
    let mut d = Map::new();
    if let Some(id) = p.get("ID") {
        d.insert("id".into(), id.clone());
    }
    if let Some(name) = dns.or(p["HostName"].as_str()) {
        d.insert("name".into(), json!(name));
    }
    if let Some(os) = p.get("OS") {
        d.insert("os".into(), os.clone());
    }
    d.insert(
        "ips".into(),
        p.get("TailscaleIPs").filter(|v| !v.is_null()).cloned().unwrap_or(json!([])),
    );
    d.insert("self".into(), json!(this));
    let truthy = |k: &str| p[k].as_bool().unwrap_or(false);
    d.insert("online".into(), json!(truthy("Online")));
    // Traffic in the last couple of minutes.
    d.insert("active".into(), json!(truthy("Active")));
    if let Some(t) = tailscale_time(&p["LastSeen"]) {
        d.insert("lastSeen".into(), json!(t));
    }
    // A direct address once one is found; until then traffic goes through Tailscale's relay.
    if let Some(a) = p["CurAddr"].as_str().filter(|a| !a.is_empty()) {
        d.insert("direct".into(), json!(a));
    }
    if let Some(r) = p["Relay"].as_str().filter(|r| !r.is_empty()) {
        d.insert("relay".into(), json!(r));
    }
    d.insert(
        "rxBytes".into(),
        p.get("RxBytes").filter(|v| !v.is_null()).cloned().unwrap_or(json!(0)),
    );
    d.insert(
        "txBytes".into(),
        p.get("TxBytes").filter(|v| !v.is_null()).cloned().unwrap_or(json!(0)),
    );
    if let Some(t) = tailscale_time(&p["KeyExpiry"]) {
        d.insert("keyExpiry".into(), json!(t));
    }
    d.insert("exitNode".into(), json!(truthy("ExitNode")));
    d.insert("offersExitNode".into(), json!(truthy("ExitNodeOption")));
    Value::Object(d)
}

pub async fn tailscale() -> Result<Json<Value>, HttpError> {
    let out = command::run("tailscale", &args!["status", "--json"], Duration::from_secs(10))
        .await
        .map_err(HttpError::internal)?;
    let s: Value = serde_json::from_str(&out).map_err(|e| HttpError::internal(e.to_string()))?;
    let mut peers: Vec<Value> = s["Peer"]
        .as_object()
        .into_iter()
        .flat_map(|p| p.values())
        .map(|p| tailscale_device(p, false))
        .collect();
    let name = |d: &Value| d["name"].as_str().unwrap_or_default().to_lowercase();
    peers.sort_by(|a, b| {
        b["online"]
            .as_bool()
            .cmp(&a["online"].as_bool())
            .then_with(|| name(a).cmp(&name(b)))
    });
    let mut devices = vec![tailscale_device(&s["Self"], true)];
    devices.extend(peers);
    let mut out = Map::new();
    if let Some(state) = s.get("BackendState") {
        out.insert("state".into(), state.clone());
    }
    if let Some(v) = s["Version"].as_str() {
        out.insert("version".into(), json!(v.split('-').next().unwrap_or(v)));
    }
    if let Some(t) = s["CurrentTailnet"].get("Name") {
        out.insert("tailnet".into(), t.clone());
    }
    out.insert(
        "health".into(),
        s.get("Health").filter(|v| !v.is_null()).cloned().unwrap_or(json!([])),
    );
    out.insert("devices".into(), json!(devices));
    out.insert("at".into(), json!(now_ms()));
    Ok(Json(Value::Object(out)))
}

// ---------------------------------------------------------------------------------------------
// Drives

/// Each drive with its health, what it's doing now and which services are using it most.
pub async fn drives(AxumState(state): AxumState<State>) -> Result<Json<Value>, HttpError> {
    let groups = state.usage.groups().await?;
    let pods = state.usage.pods.get().await.unwrap_or_default();
    let services = service_groups(&groups, &pods);
    let mut names: Vec<(String, Option<String>)> = pods
        .iter()
        .map(|p| (format!("container:{}", p.name()), p.names.as_ref().and_then(|n| n.first()).cloned()))
        .collect();
    names.extend(UNITS.iter().map(|u| (format!("unit:{}", u.id), Some(u.name.to_owned()))));
    let service_by_dir: std::collections::HashMap<&str, String> = services.iter().map(|(id, dir)| (*dir, id.clone())).collect();
    let (drives, error) = state.recorder.drives.lock().unwrap().clone();
    let rates = state.sampler.rates.lock().unwrap().disks.clone();

    let list: Vec<Value> = drives
        .iter()
        .map(|d| {
            let dev = d.device.as_ref().and_then(|name| read_trimmed(format!("/sys/block/{name}/dev")));
            let mut users: Vec<(f64, Value)> = groups
                .iter()
                .filter_map(|(g, r)| {
                    let (_, read, write) = r.as_ref()?.device_rates.iter().find(|(x, ..)| Some(x) == dev.as_ref())?.clone();
                    if read + write <= 0.0 {
                        return None;
                    }
                    let id = service_by_dir.get(g.dir.as_str());
                    let name = match id {
                        Some(id) => names.iter().find(|(n, _)| n == id).and_then(|(_, n)| n.clone()),
                        None => Some(group_label(g.dir.rsplit('/').next().unwrap_or(&g.dir))),
                    };
                    let mut u = Map::new();
                    if let Some(id) = id {
                        u.insert("id".into(), json!(id));
                    }
                    if let Some(n) = name {
                        u.insert("name".into(), json!(n));
                    }
                    u.insert("readPerSec".into(), num(read));
                    u.insert("writePerSec".into(), num(write));
                    Some((read + write, Value::Object(u)))
                })
                .collect();
            users.sort_by(|a, b| b.0.total_cmp(&a.0));
            let mut v = d.json.clone();
            if let Some(r) = d.device.as_ref().and_then(|name| rates.get(name)) {
                v["activity"] = json!({ "readPerSec": num(r.read_per_sec), "writePerSec": num(r.write_per_sec), "busy": num(r.busy) });
            }
            v["users"] = users.into_iter().take(6).map(|(_, u)| u).collect();
            v
        })
        .collect();
    let mut out = Map::new();
    out.insert("drives".into(), json!(list));
    if let Some(e) = error {
        out.insert("error".into(), json!(e));
    }
    out.insert("at".into(), json!(now_ms()));
    Ok(Json(Value::Object(out)))
}

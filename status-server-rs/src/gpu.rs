//! `GET /api/gpu`: the graphics card's load, memory, sensors and link, and the programs using it
//! with each engine's share since the previous call.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::Json;
use axum::extract::State as AxumState;
use axum::http::StatusCode;
use serde::Serialize;
use tokio::process::Command;

use crate::http::{HttpError, State};
use crate::kernel::{self, read_number, read_trimmed};
use crate::usage::{now_ms, service_of_group};

/// Engines in the order they're listed, as a JSON object keeps the order keys were added.
type Engines = Vec<(String, f64)>;

const ENGINE_LABELS: &[(&str, &str)] = &[
    ("gfx", "3D"),
    ("compute", "Compute"),
    ("dec", "Video decode"),
    ("enc", "Video encode"),
    ("jpeg", "JPEG"),
    ("dma", "Copy"),
];
const GPU_TEMPS: &[(&str, &str)] = &[("edge", "Edge"), ("junction", "Hotspot"), ("mem", "Memory")];
/// hwmon clock label → shown label and the pp_dpm table listing its levels.
const CLOCKS: &[(&str, &str, &str)] = &[("sclk", "Core", "pp_dpm_sclk"), ("mclk", "Memory", "pp_dpm_mclk")];

/// Finding the card's files means looking at all ~5000 open files on the machine (~25 ms), so
/// only new processes are looked at each time, which catches a transcode as it starts, and all
/// of them this often, which catches a program that opens the card some time after starting.
const CARD_FILES_RESCAN: Duration = Duration::from_secs(30);
/// An older reading is too far back to say what the card is doing now.
const PREVIOUS_MAX_AGE: Duration = Duration::from_secs(5 * 60);

fn lookup<'a>(table: &[(&str, &'a str)], key: &str) -> Option<&'a str> {
    table.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
}

#[derive(Default)]
pub struct Gpu {
    names: Mutex<HashMap<PathBuf, String>>,
    card_files: Mutex<CardFiles>,
    last_clients: Mutex<Option<(Instant, HashMap<String, Client>)>>,
}

#[derive(Default)]
struct CardFiles {
    at: Option<Instant>,
    by_pid: HashMap<String, Vec<String>>,
}

#[derive(Clone)]
struct Client {
    pid: u32,
    vram_bytes: u64,
    gtt_bytes: u64,
    /// Busy time in ns, divided by how many of that engine the card has.
    engines: Engines,
}

/// The first card that reports how busy it is, which skips display-only devices.
pub fn card() -> Option<PathBuf> {
    kernel::names("/sys/class/drm")
        .into_iter()
        .filter(|c| {
            c.strip_prefix("card")
                .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
        })
        .map(|c| Path::new("/sys/class/drm").join(c).join("device"))
        .find(|dir| read_number(dir.join("gpu_busy_percent")).is_some())
}

/// Which files of which processes are the card, by pid.
fn card_files(cache: &mut CardFiles) -> Vec<(String, Vec<String>)> {
    let full = cache.at.is_none_or(|at| at.elapsed() >= CARD_FILES_RESCAN);
    let mut next = HashMap::new();
    for pid in kernel::pids() {
        if !full && let Some(fds) = cache.by_pid.get(&pid) {
            next.insert(pid, fds.clone());
            continue;
        }
        let fds: Vec<String> = kernel::names(format!("/proc/{pid}/fd"))
            .into_iter()
            .filter(|fd| fs::read_link(format!("/proc/{pid}/fd/{fd}")).is_ok_and(|l| l.starts_with("/dev/dri/")))
            .collect();
        next.insert(pid, fds);
    }
    cache.by_pid = next;
    if full {
        cache.at = Some(Instant::now());
    }
    cache
        .by_pid
        .iter()
        .filter(|(_, fds)| !fds.is_empty())
        .map(|(p, f)| (p.clone(), f.clone()))
        .collect()
}

/// Programs with the card open, from the DRM fdinfo the kernel keeps per open file: the memory
/// each holds and the time each engine has spent on its work. Only our own processes are
/// readable, which covers the containers since they're rootless.
fn read_clients(files: &[(String, Vec<String>)], slot: &str) -> (Vec<String>, HashMap<String, Client>) {
    let mut order = Vec::new();
    let mut clients = HashMap::new();
    for (pid, fds) in files {
        for fd in fds {
            // Gone if it exited or closed the card. An fd number taken since by another file has no
            // client id.
            let Some(info) = kernel::read(format!("/proc/{pid}/fdinfo/{fd}")) else {
                continue;
            };
            let fields: Vec<(&str, &str)> = info
                .lines()
                .filter_map(|l| {
                    let (k, v) = l.split_once(':')?;
                    (!k.is_empty() && k.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')).then(|| (k, v.trim()))
                })
                .collect();
            let field = |k: &str| fields.iter().find(|(key, _)| *key == k).map(|(_, v)| *v);
            let Some(id) = field("drm-client-id") else { continue };
            if field("drm-pdev") != Some(slot) || clients.contains_key(id) {
                continue;
            }
            let int = |v: &str| {
                v.split(|c: char| !c.is_ascii_digit())
                    .next()
                    .and_then(|n| n.parse::<u64>().ok())
                    .unwrap_or(0)
            };
            let kib = |k: &str| field(k).map_or(0, int) * 1024;
            let engines = fields
                .iter()
                .filter_map(|(k, v)| {
                    let engine = k.strip_prefix("drm-engine-").filter(|e| !e.starts_with("capacity"))?;
                    let capacity = field(&format!("drm-engine-capacity-{engine}"))
                        .and_then(|c| c.parse::<f64>().ok())
                        .filter(|c| *c != 0.0);
                    Some((engine.to_owned(), int(v) as f64 / capacity.unwrap_or(1.0)))
                })
                .collect();
            let vram = kib("drm-memory-vram");
            let gtt = kib("drm-memory-gtt");
            order.push(id.to_owned());
            clients.insert(
                id.to_owned(),
                Client {
                    pid: pid.parse().unwrap_or(0),
                    vram_bytes: if vram > 0 { vram } else { kib("drm-total-vram") },
                    gtt_bytes: if gtt > 0 { gtt } else { kib("drm-total-gtt") },
                    engines,
                },
            );
        }
    }
    (order, clients)
}

/// The marketing name from lspci, such as "Radeon RX 5600 OEM/5600 XT / 5700/5700 XT".
async fn card_name(gpu: &Gpu, dir: &Path, slot: &str) -> String {
    if let Some(name) = gpu.names.lock().unwrap().get(dir) {
        return name.clone();
    }
    let lspci = tokio::time::timeout(Duration::from_secs(5), Command::new("lspci").args(["-mm", "-s", slot]).output()).await;
    let device = lspci
        .ok()
        .and_then(Result::ok)
        .and_then(|o| String::from_utf8_lossy(&o.stdout).split('"').nth(5).map(str::to_owned));
    let name = match device {
        Some(d) if !d.is_empty() => match (d.find('['), d.rfind(']')) {
            (Some(open), Some(close)) if close > open + 1 => d[open + 1..close].to_owned(),
            _ => d,
        },
        _ => "Graphics card".to_owned(),
    };
    gpu.names.lock().unwrap().insert(dir.to_owned(), name.clone());
    name
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Temperature {
    pub label: String,
    pub celsius: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    critical_celsius: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Clock {
    label: &'static str,
    mhz: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_mhz: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Power {
    pub watts: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    cap_watts: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Fan {
    rpm: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_rpm: Option<f64>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Sensors {
    pub temperatures: Vec<Temperature>,
    clocks: Vec<Clock>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub power: Option<Power>,
    #[serde(skip_serializing_if = "Option::is_none")]
    fan: Option<Fan>,
    #[serde(skip_serializing_if = "Option::is_none")]
    voltage_mv: Option<f64>,
}

/// Highest level in a pp_dpm_* table ("2: 2100Mhz"), in MHz.
fn max_clock(file: &Path) -> Option<f64> {
    let text = read_trimmed(file).unwrap_or_default().to_lowercase();
    text.split("mhz")
        .filter_map(|before| {
            let digits: String = before.chars().rev().take_while(char::is_ascii_digit).collect();
            digits.chars().rev().collect::<String>().parse::<f64>().ok()
        })
        .reduce(f64::max)
}

/// Sensors from the card's hwmon: temperatures, power, fan, clocks and voltage.
pub fn sensors(dir: &Path) -> Sensors {
    let mut out = Sensors::default();
    let Some(hwmon) = kernel::names(dir.join("hwmon")).into_iter().next() else {
        return out;
    };
    let h = dir.join("hwmon").join(hwmon);
    let files = kernel::names(&h);
    let numbered = |f: &str, prefix: &str, suffix: &str| {
        f.strip_prefix(prefix)
            .and_then(|r| r.strip_suffix(suffix))
            .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
    };
    for f in files.iter().filter(|f| numbered(f, "temp", "_label")) {
        let label = read_trimmed(h.join(f)).unwrap_or_default();
        let base = f.trim_end_matches("_label");
        let Some(milli) = read_number(h.join(format!("{base}_input"))) else {
            continue;
        };
        let crit = read_number(h.join(format!("{base}_crit")));
        out.temperatures.push(Temperature {
            label: lookup(GPU_TEMPS, &label).map_or(label.clone(), str::to_owned),
            celsius: milli / 1000.0,
            // `crit && crit / 1000` in the Node server: 0 stays 0.
            critical_celsius: crit.map(|c| if c == 0.0 { 0.0 } else { c / 1000.0 }),
        });
    }
    for f in files.iter().filter(|f| numbered(f, "freq", "_label")) {
        let label = read_trimmed(h.join(f)).unwrap_or_default();
        let hz = read_number(h.join(f.replace("_label", "_input")));
        let (Some(&(_, shown, table)), Some(hz)) = (CLOCKS.iter().find(|(k, _, _)| *k == label), hz) else {
            continue;
        };
        out.clocks.push(Clock {
            label: shown,
            mhz: (hz / 1e6).round(),
            max_mhz: max_clock(&dir.join(table)),
        });
    }
    if let Some(micro) = read_number(h.join("power1_average")).or_else(|| read_number(h.join("power1_input"))) {
        let cap = read_number(h.join("power1_cap")).unwrap_or(0.0) / 1e6;
        out.power = Some(Power {
            watts: micro / 1e6,
            cap_watts: (cap != 0.0 && !cap.is_nan()).then_some(cap),
        });
    }
    if let Some(rpm) = read_number(h.join("fan1_input")) {
        out.fan = Some(Fan {
            rpm,
            max_rpm: read_number(h.join("fan1_max")),
        });
    }
    out.voltage_mv = read_number(h.join("in0_input"));
    out
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Memory {
    total_bytes: f64,
    used_bytes: f64,
}

/// NaN for a part that didn't read, which JSON shows as `null`, as in the Node server.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Link {
    gts: f64,
    width: f64,
    max_gts: f64,
    max_width: f64,
}

#[derive(Serialize)]
struct Engine {
    id: String,
    label: String,
    usage: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientOut {
    pid: u32,
    vram_bytes: u64,
    gtt_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    engines: Option<Vec<Engine>>,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    service: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuOut {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    driver: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    usage: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    memory_controller_usage: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    vram: Option<Memory>,
    #[serde(skip_serializing_if = "Option::is_none")]
    gtt: Option<Memory>,
    #[serde(flatten)]
    sensors: Sensors,
    #[serde(skip_serializing_if = "Option::is_none")]
    performance_level: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    link: Option<Link>,
    #[serde(skip_serializing_if = "Option::is_none")]
    engines: Option<Vec<Engine>>,
    clients: Vec<ClientOut>,
    at: i64,
}

fn engine_list(engines: &Engines) -> Vec<Engine> {
    engines
        .iter()
        .map(|(id, usage)| Engine {
            id: id.clone(),
            label: lookup(ENGINE_LABELS, id).unwrap_or(id).to_owned(),
            usage: *usage,
        })
        .collect()
}

/// Everything read from files, taken together off the async threads.
struct Reading {
    slot: String,
    driver: Option<String>,
    numbers: [Option<f64>; 6],
    sensors: Sensors,
    level: Option<String>,
    link: [Option<String>; 4],
    order: Vec<String>,
    clients: HashMap<String, Client>,
}

pub async fn handler(AxumState(state): AxumState<State>) -> Result<Json<GpuOut>, HttpError> {
    let Some(dir) = card() else {
        return Err(HttpError(StatusCode::NOT_FOUND, "No graphics card that reports its load".into()));
    };
    let gpu = std::sync::Arc::clone(&state.gpu);
    let card_dir = dir.clone();
    let reading = tokio::task::spawn_blocking(move || -> Result<Reading, String> {
        let dir = card_dir;
        let real = fs::canonicalize(&dir).map_err(|e| e.to_string())?;
        let slot = real.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_owned();
        let files = card_files(&mut gpu.card_files.lock().unwrap());
        let (order, clients) = read_clients(&files, &slot);
        let n = |f: &str| read_number(dir.join(f));
        Ok(Reading {
            driver: fs::canonicalize(dir.join("driver"))
                .ok()
                .and_then(|p| p.file_name()?.to_str().map(str::to_owned)),
            numbers: [
                n("gpu_busy_percent"),
                n("mem_busy_percent"),
                n("mem_info_vram_total"),
                n("mem_info_vram_used"),
                n("mem_info_gtt_total"),
                n("mem_info_gtt_used"),
            ],
            sensors: sensors(&dir),
            level: read_trimmed(dir.join("power_dpm_force_performance_level")),
            link: ["current_link_speed", "current_link_width", "max_link_speed", "max_link_width"].map(|f| read_trimmed(dir.join(f))),
            slot,
            order,
            clients,
        })
    })
    .await
    .map_err(|e| HttpError::internal(e.to_string()))?
    .map_err(HttpError::internal)?;

    let name = card_name(&state.gpu, &dir, &reading.slot).await;

    // Each engine's share since the previous reading.
    let now = Instant::now();
    let previous = {
        let mut last = state.gpu.last_clients.lock().unwrap();
        let previous = last.take().filter(|(at, _)| now.duration_since(*at) < PREVIOUS_MAX_AGE);
        *last = Some((now, reading.clients.clone()));
        previous
    };
    let elapsed_ns = previous.as_ref().map_or(0.0, |(at, _)| now.duration_since(*at).as_nanos() as f64);
    let measured = previous.is_some();

    // One program can open the card several times; add those up.
    let mut by_pid: Vec<(u32, u64, u64, Engines)> = Vec::new();
    for id in &reading.order {
        let c = &reading.clients[id];
        let i = match by_pid.iter().position(|p| p.0 == c.pid) {
            Some(i) => i,
            None => {
                by_pid.push((c.pid, 0, 0, Vec::new()));
                by_pid.len() - 1
            }
        };
        let p = &mut by_pid[i];
        p.1 += c.vram_bytes;
        p.2 += c.gtt_bytes;
        let before = previous.as_ref().and_then(|(_, clients)| clients.get(id));
        for (engine, ns) in &c.engines {
            let Some(was) = before.and_then(|b| b.engines.iter().find(|(e, _)| e == engine)).map(|(_, v)| *v) else {
                continue;
            };
            if elapsed_ns == 0.0 {
                continue;
            }
            let share = (ns - was).max(0.0) / elapsed_ns;
            match p.3.iter_mut().find(|(e, _)| e == engine) {
                Some((_, v)) => *v += share,
                None => p.3.push((engine.clone(), share)),
            }
        }
    }

    let names = state.usage.group_names().await?;
    let mut clients: Vec<(ClientOut, Engines)> = by_pid
        .into_iter()
        .map(|(pid, vram_bytes, gtt_bytes, mut engines)| {
            for (_, v) in &mut engines {
                *v = v.min(1.0);
            }
            let comm = read_trimmed(format!("/proc/{pid}/comm"));
            let cgroup = kernel::read(format!("/proc/{pid}/cgroup")).unwrap_or_default();
            let service = kernel::cgroup_of(&cgroup).and_then(|g| service_of_group(g, &names));
            let out = ClientOut {
                pid,
                vram_bytes,
                gtt_bytes,
                engines: measured.then(|| engine_list(&engines)),
                name: comm.unwrap_or_else(|| pid.to_string()),
                service,
            };
            (out, engines)
        })
        .collect();
    clients.sort_by_key(|(c, _)| std::cmp::Reverse(c.vram_bytes));

    // The card as a whole, from adding up every program's share of each engine. The kernel only
    // lists an engine for a program once it has used it, so start with the ones worth watching.
    let mut engines: Engines = ["gfx", "compute", "dec", "enc"].iter().map(|e| (e.to_string(), 0.0)).collect();
    for (_, client_engines) in &clients {
        for (e, v) in client_engines {
            match engines.iter_mut().find(|(id, _)| id == e) {
                Some((_, total)) => *total = (*total + v).min(1.0),
                None => engines.push((e.clone(), v.min(1.0))),
            }
        }
    }

    let [busy, mem_busy, vram_total, vram_used, gtt_total, gtt_used] = reading.numbers;
    let memory = |total: Option<f64>, used: Option<f64>| {
        // Truthy in the Node server: present, not 0 and not NaN.
        total.filter(|t| *t != 0.0 && !t.is_nan()).map(|t| Memory {
            total_bytes: t,
            used_bytes: used.unwrap_or(0.0),
        })
    };
    let pcie = |speed: &Option<String>| {
        speed
            .as_deref()
            .and_then(|s| s.split(" GT/s").next().filter(|_| s.contains(" GT/s")))
            .and_then(|n| n.rsplit(' ').next())
            .and_then(|n| n.parse::<f64>().ok())
            .unwrap_or(f64::NAN)
    };
    // `Number()` in the Node server: missing is NaN, empty is 0.
    let number = |v: &Option<String>| match v.as_deref() {
        Some("") => 0.0,
        Some(v) => v.parse().unwrap_or(f64::NAN),
        None => f64::NAN,
    };
    let link = reading.link[0].as_ref().filter(|s| !s.is_empty()).map(|_| Link {
        gts: pcie(&reading.link[0]),
        width: number(&reading.link[1]),
        max_gts: pcie(&reading.link[2]),
        max_width: number(&reading.link[3]),
    });

    Ok(Json(GpuOut {
        name,
        driver: reading.driver.filter(|d| !d.is_empty()),
        usage: busy.map(|b| b / 100.0),
        memory_controller_usage: mem_busy.map(|b| b / 100.0),
        vram: memory(vram_total, vram_used),
        gtt: memory(gtt_total, gtt_used),
        sensors: reading.sensors,
        performance_level: reading.level,
        link,
        engines: measured.then(|| engine_list(&engines)),
        clients: clients.into_iter().map(|(c, _)| c).collect(),
        at: now_ms(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn highest_clock_level() {
        let dir = std::env::temp_dir().join(format!("gpu-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("pp_dpm_sclk");
        fs::write(&file, "0: 500Mhz\n1: 800Mhz *\n2: 2100Mhz\n").unwrap();
        assert_eq!(max_clock(&file), Some(2100.0));
        fs::write(&file, "").unwrap();
        assert_eq!(max_clock(&file), None);
        fs::remove_dir_all(dir).unwrap();
    }
}

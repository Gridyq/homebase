//! Takes a reading of everything every 15 seconds into the history, notices what changed among the
//! services for the events log, looks for problems every 5 minutes, and answers the screens that
//! show the past: `/api/history`, `/api/network` and `/api/reliability`.
//!
//! Readings it needs besides the ones the dashboard has: each container's network traffic (from
//! its network namespace; containers sharing one, as qBittorrent does gluetun's VPN, are counted
//! together), each Tailscale device's, the drives' temperatures and the cores' clocks.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::Json;
use axum::extract::{Query, State as AxumState};
use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::args;
use crate::command;
use crate::drives::{DRIVE_REFRESH_INTERVAL, Drive, read_drives};
use crate::events::{Events, Notice, Seen, notify, problems, read_memory_kills, reliability};
use crate::history::{HISTORY_INTERVAL_MS, HISTORY_MAX_MS, HISTORY_POINTS, History, between, num, trim};
use crate::http::{HttpError, State};
use crate::kernel;
use crate::usage::{Pod, meminfo, now_ms, pressure};

const COMPACT_INTERVAL: Duration = Duration::from_secs(6 * 3600);
const JOURNAL_INTERVAL: Duration = Duration::from_secs(60);
const PEER_INTERVAL: Duration = Duration::from_secs(60);
const WATCH_INTERVAL: Duration = Duration::from_secs(5 * 60);

/// Series for the whole machine, by the name the app knows them by.
const SYSTEM_SERIES: &[(&str, &str)] = &[
    ("cpu", "cpu"),
    ("gpu", "gpu"),
    ("memory", "mem"),
    ("cache", "cache"),
    ("swap", "swap"),
    ("rx", "rx"),
    ("tx", "tx"),
    ("temp", "temp"),
    ("gpuTemp", "gtemp"),
    ("gpuPower", "gpow"),
    ("vram", "vram"),
    ("cpuPower", "cpow"),
    ("cpuClock", "clock"),
    ("pressureCpu", "pcpu"),
    ("pressureMemory", "pmem"),
    ("pressureIo", "pio"),
    ("converting", "conv"),
];

/// When counters were last read, and their values (received, sent) by what they belong to.
type LastCounters = Option<(Instant, HashMap<String, (f64, f64)>)>;
type Related = Box<dyn Fn(&crate::events::Event) -> bool>;

#[derive(Clone, Copy)]
struct Rate {
    rx_per_sec: Option<f64>,
    tx_per_sec: Option<f64>,
}

#[derive(Default)]
struct ContainerNet {
    last: LastCounters,
    /// Service id → rate.
    rates: HashMap<String, Rate>,
    /// Containers sharing a network, as service ids.
    groups: Vec<Vec<String>>,
}

struct Peer {
    rate: Rate,
    os: Option<String>,
    online: bool,
}

#[derive(Default)]
struct Peers {
    last: LastCounters,
    /// Device name → its traffic, in Tailscale's order.
    list: Vec<(String, Peer)>,
}

pub struct Recorder {
    pub history: Mutex<History>,
    pub events: Mutex<Events>,
    pub drives: Mutex<(Arc<Vec<Drive>>, Option<String>)>,
    net: Mutex<ContainerNet>,
    peers: Mutex<Peers>,
    /// Service id and name, as of the last reading.
    pub names: Mutex<Vec<(String, String)>>,
}

impl Recorder {
    pub fn new(dir: &Path) -> Self {
        Self {
            history: Mutex::new(History::new(dir)),
            events: Mutex::new(Events::new(dir, now_ms())),
            drives: Mutex::new((Arc::new(Vec::new()), None)),
            net: Mutex::default(),
            peers: Mutex::default(),
            names: Mutex::default(),
        }
    }

    pub async fn load(&self) {
        let now = now_ms();
        tokio::task::block_in_place(|| self.history.lock().unwrap().load(now));
        let uptime = kernel::read_trimmed("/proc/uptime")
            .and_then(|u| u.split(' ').next()?.parse::<f64>().ok())
            .unwrap_or(0.0);
        let mut boots = crate::events::journal_boots().await;
        boots.push(now - (uptime * 1000.0).round() as i64);
        self.events.lock().unwrap().load(now, &boots);
        // Reading the files leaves freed memory the allocator would otherwise keep.
        // SAFETY: malloc_trim only hands free memory back to the system.
        unsafe { libc::malloc_trim(0) };
    }
}

/// Starts the readings and the loops that keep the history, events and drives.
pub fn start(state: State) {
    let s = state.clone();
    tokio::spawn(async move {
        loop {
            refresh_drives(&s).await;
            tokio::time::sleep(DRIVE_REFRESH_INTERVAL).await;
        }
    });
    let s = state.clone();
    tokio::spawn(async move {
        loop {
            sample_peers(&s).await;
            tokio::time::sleep(PEER_INTERVAL).await;
        }
    });
    let s = state.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval_at(
            tokio::time::Instant::now() + Duration::from_millis(HISTORY_INTERVAL_MS as u64),
            Duration::from_millis(HISTORY_INTERVAL_MS as u64),
        );
        loop {
            tick.tick().await;
            if let Err(e) = record(&s).await {
                eprintln!("Recording history failed: {}", e.1);
            }
        }
    });
    let s = state.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + COMPACT_INTERVAL, COMPACT_INTERVAL);
        loop {
            tick.tick().await;
            let now = now_ms();
            tokio::task::block_in_place(|| {
                s.recorder.history.lock().unwrap().compact(now);
                s.recorder.events.lock().unwrap().compact(now);
            });
        }
    });
    let s = state.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + JOURNAL_INTERVAL, JOURNAL_INTERVAL);
        loop {
            tick.tick().await;
            check_journal(&s).await;
        }
    });
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(10)).await;
        let mut tick = tokio::time::interval(WATCH_INTERVAL);
        loop {
            tick.tick().await;
            watch(&state).await;
        }
    });
}

async fn send(state: &State, notices: Vec<Notice>) {
    for n in notices {
        notify(&state.upstream, n).await;
    }
}

async fn refresh_drives(state: &State) {
    match read_drives().await {
        Ok(drives) => *state.recorder.drives.lock().unwrap() = (Arc::new(drives), None),
        Err(e) => {
            eprintln!("Couldn't read the drives: {e}");
            state.recorder.drives.lock().unwrap().1 = Some(e);
        }
    }
}

async fn check_journal(state: &State) {
    let since = state.recorder.events.lock().unwrap().journal_window(now_ms());
    let journal = read_memory_kills(since).await;
    let pods = state.usage.pods.get().await.unwrap_or_default();
    let notices = state.recorder.events.lock().unwrap().note_memory_kills(&journal, since, &pods);
    send(state, notices).await;
}

/// Sends a notification when a problem starts and when it clears.
async fn watch(state: &State) {
    let status = match crate::status::read(state).await {
        Ok(s) => serde_json::to_value(s).unwrap_or_default(),
        Err(e) => {
            eprintln!("Watch failed: {}", e.1);
            return;
        }
    };
    let drives = Arc::clone(&state.recorder.drives.lock().unwrap().0);
    let current = problems(&status, &drives);
    let notices = state.recorder.events.lock().unwrap().note_problems(current, now_ms());
    send(state, notices).await;
}

// ---------------------------------------------------------------------------------------------
// Readings

/// Each core's clock in kHz, in core order.
pub fn cpu_clocks() -> Vec<f64> {
    let mut cpus: Vec<u32> = kernel::names("/sys/devices/system/cpu")
        .iter()
        .filter_map(|c| c.strip_prefix("cpu")?.parse().ok())
        .collect();
    cpus.sort_unstable();
    cpus.iter()
        .filter_map(|c| kernel::read_number(format!("/sys/devices/system/cpu/cpu{c}/cpufreq/scaling_cur_freq")))
        .collect()
}

/// Each running container's traffic, from its network namespace, by namespace.
fn container_traffic(pods: &[Pod]) -> Vec<(String, Vec<String>, f64, f64)> {
    let ns_of = |pid: &str| {
        std::fs::read_link(format!("/proc/{pid}/ns/net"))
            .ok()
            .map(|p| p.to_string_lossy().into_owned())
    };
    let host = ns_of("self");
    let mut out: Vec<(String, Vec<String>, f64, f64)> = Vec::new();
    for p in pods {
        let Some(pid) = p.pid.filter(|pid| *pid > 0 && p.state.as_deref() == Some("running")) else {
            continue;
        };
        let Some(ns) = ns_of(&pid.to_string()) else { continue };
        // Host networking is the machine's own traffic, already counted.
        if Some(&ns) == host.as_ref() {
            continue;
        }
        let id = format!("container:{}", p.name());
        if let Some(known) = out.iter_mut().find(|(n, ..)| *n == ns) {
            known.1.push(id);
            continue;
        }
        let dev = kernel::read(format!("/proc/{pid}/net/dev")).unwrap_or_default();
        let ifaces: Vec<(&str, &str)> = dev
            .lines()
            .skip(2)
            .filter_map(|l| l.trim().split_once(':'))
            .filter(|(name, _)| *name != "lo")
            .collect();
        // A VPN's tunnel carries the real traffic; the same data also crosses eth0, encrypted.
        let tunnel: Vec<_> = ifaces
            .iter()
            .filter(|(name, _)| name.starts_with("tun") || name.starts_with("wg"))
            .collect();
        let counted: Vec<_> = if tunnel.is_empty() { ifaces.iter().collect() } else { tunnel };
        let (mut rx, mut tx) = (0.0, 0.0);
        for (_, data) in counted {
            let f: Vec<f64> = data.split_whitespace().map(|v| v.parse().unwrap_or(0.0)).collect();
            rx += f.first().copied().unwrap_or(0.0);
            tx += f.get(8).copied().unwrap_or(0.0);
        }
        out.push((ns, vec![id], rx, tx));
    }
    out
}

fn sample_container_net(net: &mut ContainerNet, traffic: Vec<(String, Vec<String>, f64, f64)>) {
    let now = Instant::now();
    let mut rates = HashMap::new();
    if let Some((at, prev)) = &net.last {
        let secs = now.duration_since(*at).as_secs_f64();
        for (ns, ids, rx, tx) in &traffic {
            let Some((prx, ptx)) = prev.get(ns).filter(|_| secs > 0.0) else {
                continue;
            };
            let r = Rate {
                rx_per_sec: Some(((rx - prx) / secs).max(0.0)),
                tx_per_sec: Some(((tx - ptx) / secs).max(0.0)),
            };
            for id in ids {
                rates.insert(id.clone(), r);
            }
        }
    }
    net.last = Some((now, traffic.iter().map(|(ns, _, rx, tx)| (ns.clone(), (*rx, *tx))).collect()));
    net.rates = rates;
    net.groups = traffic.into_iter().map(|(_, ids, ..)| ids).collect();
}

async fn sample_peers(state: &State) {
    let out = match command::run("tailscale", &args!["status", "--json"], Duration::from_secs(10)).await {
        Ok(out) => out,
        Err(e) => {
            eprintln!("Couldn't read Tailscale's traffic: {e}");
            return;
        }
    };
    let Ok(status) = serde_json::from_str::<Value>(&out) else { return };
    let now = Instant::now();
    let devices: Vec<(String, f64, f64, Option<String>, bool)> = status["Peer"]
        .as_object()
        .into_iter()
        .flat_map(|p| p.values())
        .map(|p| {
            let dns = p["DNSName"].as_str().and_then(|d| d.split('.').next()).filter(|d| !d.is_empty());
            let name = dns.or(p["HostName"].as_str()).unwrap_or_default().to_owned();
            let bytes = |k: &str| p[k].as_f64().unwrap_or(0.0);
            (
                name,
                bytes("RxBytes"),
                bytes("TxBytes"),
                p["OS"].as_str().map(str::to_owned),
                p["Online"].as_bool().unwrap_or(false),
            )
        })
        .collect();
    let mut peers = state.recorder.peers.lock().unwrap();
    let mut list = Vec::new();
    for (name, rx, tx, os, online) in &devices {
        let prev = peers
            .last
            .as_ref()
            .and_then(|(at, p)| Some((now.duration_since(*at).as_secs_f64(), *p.get(name)?)));
        // The counters start over when tailscaled restarts.
        let rate = |a: f64, b: Option<f64>| prev.and_then(|(secs, _)| b.filter(|b| secs > 0.0 && a >= *b).map(|b| (a - b) / secs));
        let rate = Rate {
            rx_per_sec: rate(*rx, prev.map(|(_, p)| p.0)),
            tx_per_sec: rate(*tx, prev.map(|(_, p)| p.1)),
        };
        list.push((
            name.clone(),
            Peer {
                rate,
                os: os.clone(),
                online: *online,
            },
        ));
    }
    peers.last = Some((now, devices.iter().map(|(n, rx, tx, ..)| (n.clone(), (*rx, *tx))).collect()));
    peers.list = list;
}

async fn record(state: &State) -> Result<(), HttpError> {
    let card = crate::gpu::card();
    let machine = tokio::task::spawn_blocking(move || {
        let gpu_sense = card.as_deref().map(crate::gpu::sensors);
        let vram = card.as_ref().and_then(|c| kernel::read_number(c.join("mem_info_vram_used")));
        let busy = card
            .as_ref()
            .and_then(|c| kernel::read_number(c.join("gpu_busy_percent")))
            .map(|b| b / 100.0);
        (
            meminfo(),
            crate::status::temperatures(),
            busy,
            gpu_sense,
            vram,
            pressure(10),
            cpu_clocks(),
        )
    });
    let (machine, list) = tokio::join!(machine, crate::services::list(&state.services, &state.usage));
    let game_mode = state.game_mode.state();
    let (info, temps, gpu, gpu_sense, vram, press, clocks) = machine.map_err(|e| HttpError::internal(e.to_string()))?;
    let list = list?;
    let pods = state.usage.pods.get().await.unwrap_or_default();
    let traffic = tokio::task::spawn_blocking(move || container_traffic(&pods))
        .await
        .unwrap_or_default();
    sample_container_net(&mut state.recorder.net.lock().unwrap(), traffic);
    // Nothing while Tdarr is stopped.
    let tdarr_running = list.iter().any(|s| s.id == "container:tdarr" && s.state == "running");
    let conv = if tdarr_running {
        crate::media::converting(state).await
    } else {
        None
    };

    let now = now_ms();
    let seen: Vec<Seen> = list
        .iter()
        .map(|s| Seen {
            id: s.id.clone(),
            name: s.name.clone(),
            state: s.state.to_owned(),
            since: s.since,
            restarts: s.restarts.unwrap_or(0),
            detail: s.detail.clone(),
        })
        .collect();
    let notices = state.recorder.events.lock().unwrap().note_service_changes(&seen, now, &game_mode);
    *state.recorder.names.lock().unwrap() = list.iter().map(|s| (s.id.clone(), s.name.clone())).collect();

    let mut a: Vec<(String, f64)> = Vec::new();
    let mut put = |key: String, v: Option<f64>| {
        if let Some(v) = v.filter(|v| v.is_finite()) {
            a.push((key, trim(v)));
        }
    };
    let get = |k: &str| info.get(k).copied().map(|v| v as f64);
    let cache =
        get("Buffers").unwrap_or(0.0) + get("Cached").unwrap_or(0.0) - get("Shmem").unwrap_or(0.0) + get("SReclaimable").unwrap_or(0.0);
    {
        let rates = state.sampler.rates.lock().unwrap();
        put("cpu".into(), rates.cpu);
        put("gpu".into(), gpu);
        put(
            "mem".into(),
            Some(get("MemTotal").unwrap_or(0.0) - get("MemAvailable").unwrap_or(0.0)),
        );
        put("cache".into(), Some(cache));
        put(
            "swap".into(),
            Some(get("SwapTotal").unwrap_or(0.0) - get("SwapFree").unwrap_or(0.0)),
        );
        put("rx".into(), rates.rx_per_sec);
        put("tx".into(), rates.tx_per_sec);
        put("temp".into(), temps.iter().find(|t| t.label == "CPU").map(|t| t.celsius));
        let gtemps = gpu_sense.as_ref().map(|g| &g.temperatures);
        put(
            "gtemp".into(),
            gtemps
                .and_then(|t| t.iter().find(|t| t.label == "Hotspot").or(t.first()))
                .map(|t| t.celsius),
        );
        put("gpow".into(), gpu_sense.as_ref().and_then(|g| g.power.as_ref()).map(|p| p.watts));
        put("vram".into(), vram);
        put("cpow".into(), rates.cpu_watts);
        put(
            "clock".into(),
            (!clocks.is_empty()).then(|| clocks.iter().sum::<f64>() / clocks.len() as f64 / 1000.0),
        );
        for (key, name) in [("pcpu", "cpu"), ("pmem", "memory"), ("pio", "io")] {
            put(key.into(), press.get(name).and_then(Value::as_f64));
        }
        put("conv".into(), conv);
        let drives = Arc::clone(&state.recorder.drives.lock().unwrap().0);
        for d in drives.iter() {
            if let Some(r) = d.device.as_ref().and_then(|dev| rates.disks.get(dev)) {
                put(format!("d:{}:r", d.id), Some(r.read_per_sec));
                put(format!("d:{}:w", d.id), Some(r.write_per_sec));
                put(format!("d:{}:busy", d.id), Some(r.busy));
            }
            put(format!("d:{}:temp", d.id), d.temperature);
        }
    }
    {
        let net = state.recorder.net.lock().unwrap();
        for s in &list {
            let Some(u) = &s.usage else { continue };
            put(format!("s:{}:mem", s.id), Some(u.used_bytes as f64));
            put(format!("s:{}:cpu", s.id), u.cpu);
            put(format!("s:{}:r", s.id), u.read_per_sec);
            put(format!("s:{}:w", s.id), u.write_per_sec);
            if let Some(r) = net.rates.get(&s.id) {
                put(format!("s:{}:rx", s.id), r.rx_per_sec);
                put(format!("s:{}:tx", s.id), r.tx_per_sec);
            }
        }
    }
    for (name, p) in &state.recorder.peers.lock().unwrap().list {
        put(format!("t:{name}:rx"), p.rate.rx_per_sec);
        put(format!("t:{name}:tx"), p.rate.tx_per_sec);
    }
    tokio::task::block_in_place(|| state.recorder.history.lock().unwrap().record(now, a));
    send(state, notices).await;
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// The screens that show the past

#[derive(Deserialize)]
pub struct RangeQuery {
    range: Option<String>,
    service: Option<String>,
    drive: Option<String>,
    device: Option<String>,
}

/// Seconds, 60 to a year, as `Number()` reads it in the Node server.
fn range_of(q: &RangeQuery) -> Result<f64, HttpError> {
    let range = match q.range.as_deref().map(str::trim) {
        None => 3600.0,
        Some("") => 0.0,
        Some(r) => r.parse().unwrap_or(f64::NAN),
    };
    if !(60.0..=(HISTORY_MAX_MS / 1000) as f64).contains(&range) {
        return Err(HttpError(StatusCode::BAD_REQUEST, "Range must be 60 seconds to a year".into()));
    }
    Ok(range)
}

/// The series for the whole machine, a service, a drive or a Tailscale device, with what happened
/// meanwhile.
pub async fn history_handler(AxumState(state): AxumState<State>, Query(q): Query<RangeQuery>) -> Result<Json<Value>, HttpError> {
    let range = range_of(&q)?;
    let end = now_ms();
    let start = end - (range * 1000.0) as i64;
    let (series, related): (Vec<(&str, String)>, Related) = if let Some(service) = q.service.clone() {
        let keys = [
            ("memory", "mem"),
            ("cpu", "cpu"),
            ("read", "r"),
            ("write", "w"),
            ("rx", "rx"),
            ("tx", "tx"),
        ];
        (
            keys.iter().map(|(name, k)| (*name, format!("s:{service}:{k}"))).collect(),
            Box::new(move |e| e.id.as_deref() == Some(&service) || e.kind == "boot"),
        )
    } else if let Some(drive) = q.drive.clone() {
        let keys = [("read", "r"), ("write", "w"), ("busy", "busy"), ("temp", "temp")];
        (
            keys.iter().map(|(name, k)| (*name, format!("d:{drive}:{k}"))).collect(),
            Box::new(move |e| e.kind == "boot" || e.drive.as_deref() == Some(&drive)),
        )
    } else if let Some(device) = &q.device {
        (
            vec![("rx", format!("t:{device}:rx")), ("tx", format!("t:{device}:tx"))],
            Box::new(|_| false),
        )
    } else {
        (
            SYSTEM_SERIES.iter().map(|(name, k)| (*name, (*k).to_owned())).collect(),
            Box::new(|e| e.kind != "problem" && e.kind != "resolved"),
        )
    };
    let history = state.recorder.history.lock().unwrap();
    let entries = history.entries(start, end);
    let summary = history.summarize(&entries, &series, start, end, HISTORY_POINTS);
    let events: Vec<Value> = state
        .recorder
        .events
        .lock()
        .unwrap()
        .list
        .iter()
        .filter(|e| e.t >= start && related(e))
        .map(|e| serde_json::to_value(e).unwrap_or_default())
        .collect();
    Ok(Json(json!({
        "start": start,
        "end": end,
        "step": num((end - start) as f64 / HISTORY_POINTS as f64),
        "series": summary,
        "events": events,
        "oldest": history.oldest(end),
        "memoryTotalBytes": meminfo().get("MemTotal").copied().unwrap_or(0),
    })))
}

pub async fn reliability_handler(AxumState(state): AxumState<State>, Query(q): Query<RangeQuery>) -> Result<Json<Value>, HttpError> {
    let range = range_of(&q)?;
    let names = state.recorder.names.lock().unwrap().clone();
    let history = state.recorder.history.lock().unwrap();
    let events = state.recorder.events.lock().unwrap();
    Ok(Json(reliability(&events, &history, &names, range, now_ms())))
}

/// Traffic over the range: the machine's, each service's and each Tailscale device's.
pub async fn network_handler(AxumState(state): AxumState<State>, Query(q): Query<RangeQuery>) -> Result<Json<Value>, HttpError> {
    let range = range_of(&q)?;
    let end = now_ms();
    let start = end - (range * 1000.0) as i64;
    let names: HashMap<String, String> = state.recorder.names.lock().unwrap().iter().cloned().collect();
    let name_of = |id: &str| {
        names
            .get(id)
            .cloned()
            .unwrap_or_else(|| id.split_once(':').map_or(id, |(_, n)| n).to_owned())
    };

    let history = state.recorder.history.lock().unwrap();
    let entries = history.entries(start, end);
    let machine = history.summarize(&entries, &[("rx", "rx".into()), ("tx", "tx".into())], start, end, HISTORY_POINTS);
    let rx = history.totals(&entries, |k| between(k, "s:", ":rx"));
    let tx = history.totals(&entries, |k| between(k, "s:", ":tx"));
    let peer_rx = history.totals(&entries, |k| between(k, "t:", ":rx"));
    let peer_tx = history.totals(&entries, |k| between(k, "t:", ":tx"));
    let oldest = history.oldest(end);
    drop(history);

    let net = state.recorder.net.lock().unwrap();
    // Containers sharing a network have the same numbers; show them once.
    let mut seen = HashSet::new();
    let mut services = Vec::new();
    let mut singles: Vec<Vec<String>> = rx.keys().map(|id| vec![id.clone()]).collect();
    singles.sort();
    for ids in net.groups.iter().cloned().chain(singles) {
        if ids.iter().any(|id| seen.contains(id)) {
            continue;
        }
        seen.extend(ids.iter().cloned());
        let id = ids.iter().find(|x| rx.contains_key(*x)).unwrap_or(&ids[0]).clone();
        let live = net.rates.get(&id);
        let mut s = Map::new();
        s.insert("id".into(), json!(id));
        s.insert("ids".into(), json!(ids));
        s.insert("name".into(), json!(ids.iter().map(|i| name_of(i)).collect::<Vec<_>>().join(" + ")));
        if let Some(r) = live.and_then(|l| l.rx_per_sec) {
            s.insert("rxPerSec".into(), num(r));
        }
        if let Some(t) = live.and_then(|l| l.tx_per_sec) {
            s.insert("txPerSec".into(), num(t));
        }
        let bytes = |m: &HashMap<String, crate::history::Total>| m.get(&id).map_or(0.0, |t| t.total);
        s.insert("rxBytes".into(), num(bytes(&rx)));
        s.insert("txBytes".into(), num(bytes(&tx)));
        services.push((bytes(&rx) + bytes(&tx), s));
    }
    drop(net);
    services.sort_by(|a, b| b.0.total_cmp(&a.0));

    let peers = state.recorder.peers.lock().unwrap();
    let mut device_names: Vec<String> = peers.list.iter().map(|(n, _)| n.clone()).collect();
    let mut recorded: Vec<&String> = peer_rx.keys().collect();
    recorded.sort();
    for n in recorded {
        if !device_names.contains(n) {
            device_names.push(n.clone());
        }
    }
    let mut devices: Vec<(f64, String, Value)> = device_names
        .into_iter()
        .map(|name| {
            let live = peers.list.iter().find(|(n, _)| *n == name).map(|(_, p)| p);
            let total = |m: &HashMap<String, crate::history::Total>| m.get(&name).map_or(0.0, |t| t.total);
            let mut d = Map::new();
            d.insert("name".into(), json!(name));
            if let Some(os) = live.and_then(|l| l.os.clone()) {
                d.insert("os".into(), json!(os));
            }
            d.insert("online".into(), json!(live.is_some_and(|l| l.online)));
            if let Some(r) = live.and_then(|l| l.rate.rx_per_sec) {
                d.insert("rxPerSec".into(), num(r));
            }
            if let Some(t) = live.and_then(|l| l.rate.tx_per_sec) {
                d.insert("txPerSec".into(), num(t));
            }
            d.insert("rxBytes".into(), num(total(&peer_rx)));
            d.insert("txBytes".into(), num(total(&peer_tx)));
            (total(&peer_rx) + total(&peer_tx), name.to_lowercase(), Value::Object(d))
        })
        .collect();
    drop(peers);
    devices.sort_by(|a, b| b.0.total_cmp(&a.0).then_with(|| a.1.cmp(&b.1)));

    let rates = state.sampler.rates.lock().unwrap();
    let mut out = Map::new();
    out.insert("start".into(), json!(start));
    out.insert("end".into(), json!(end));
    out.insert("oldest".into(), json!(oldest));
    if let Some(r) = rates.rx_per_sec {
        out.insert("rxPerSec".into(), num(r));
    }
    if let Some(t) = rates.tx_per_sec {
        out.insert("txPerSec".into(), num(t));
    }
    out.insert("rxBytes".into(), machine["rx"]["total"].clone());
    out.insert("txBytes".into(), machine["tx"]["total"].clone());
    out.insert("services".into(), services.into_iter().map(|(_, s)| Value::Object(s)).collect());
    out.insert("devices".into(), devices.into_iter().map(|(.., d)| d).collect());
    out.insert("at".into(), json!(end));
    Ok(Json(Value::Object(out)))
}

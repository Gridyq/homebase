//! `GET /api/status`, the dashboard: the machine at a glance and every service. CPU and network
//! rates come from a reading every 2 seconds in the background, so a request gets a current
//! figure without waiting.

use std::collections::HashMap;
use std::ffi::CString;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::Json;
use axum::extract::State as AxumState;
use serde::Serialize;

use crate::http::{HttpError, State};
use crate::kernel::{self, read_number, read_trimmed};
use crate::services::{self, Service};
use crate::usage::{meminfo, now_ms};

const SAMPLE_INTERVAL: Duration = Duration::from_secs(2);

/// Mounts left out of the disk list.
fn hidden_mount(mount: &str) -> bool {
    ["/boot", "/efi"]
        .iter()
        .any(|m| mount.strip_prefix(m).is_some_and(|rest| rest.is_empty() || rest.starts_with('/')))
}
const REAL_FILESYSTEMS: &[&str] = &["ext4", "ext3", "btrfs", "xfs", "f2fs", "zfs", "ntfs", "ntfs3", "exfat", "vfat"];

/// One reading per sensor chip we know about, picking its most telling input.
const SENSORS: &[(&str, &str, &[&str])] = &[
    ("k10temp", "CPU", &["Tctl", "Tdie"]),
    ("coretemp", "CPU", &["Package id 0"]),
    ("amdgpu", "GPU", &["edge"]),
    ("nvme", "SSD", &["Composite"]),
];

// ---------------------------------------------------------------------------------------------
// Rates

#[derive(Default, Clone, Copy)]
struct CpuTimes {
    idle: u64,
    total: u64,
}

fn times(line: &str) -> Option<CpuTimes> {
    let f: Vec<u64> = line.split_whitespace().skip(1).take(8).map(|v| v.parse().unwrap_or(0)).collect();
    let [user, nice, system, idle, iowait, irq, softirq, steal] = f.try_into().ok()?;
    Some(CpuTimes {
        idle: idle + iowait,
        total: user + nice + system + idle + iowait + irq + softirq + steal,
    })
}

/// The whole CPU, and each core.
fn cpu_times() -> Option<(CpuTimes, Vec<Option<CpuTimes>>)> {
    let stat = kernel::read("/proc/stat")?;
    let all = times(stat.lines().next()?)?;
    let cores = stat
        .lines()
        .filter(|l| {
            l.strip_prefix("cpu")
                .and_then(|r| r.split(' ').next())
                .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
        })
        .map(times)
        .collect();
    Some((all, cores))
}

/// iowait counts as idle and can go backwards, so idle can fall between readings.
fn busy_between(a: CpuTimes, b: CpuTimes) -> Option<f64> {
    (b.total > a.total)
        .then(|| (1.0 - b.idle.saturating_sub(a.idle) as f64 / (b.total - a.total) as f64).clamp(0.0, 1.0))
}

/// Physical interfaces only: lo, tailscale0 and container bridges have no `device` link.
fn net_bytes() -> (u64, u64) {
    let dev = kernel::read("/proc/net/dev").unwrap_or_default();
    let (mut rx, mut tx) = (0, 0);
    for line in dev.lines().skip(2) {
        let Some((name, data)) = line.trim().split_once(':') else {
            continue;
        };
        if std::fs::read_dir(format!("/sys/class/net/{name}/device")).is_err() {
            continue;
        }
        let fields: Vec<u64> = data.split_whitespace().map(|v| v.parse().unwrap_or(0)).collect();
        rx += fields.first().copied().unwrap_or(0);
        tx += fields.get(8).copied().unwrap_or(0);
    }
    (rx, tx)
}

// The CPU package's energy counter (RAPL), which AMD chips offer under Intel's name too. Only root
// can read it unless a udev rule lets this user read it (see README.md).
const RAPL: &str = "/sys/class/powercap/intel-rapl:0";

/// Microjoules used so far, or why it can't be read.
fn energy() -> Result<f64, &'static str> {
    match std::fs::read_to_string(format!("{RAPL}/energy_uj")) {
        Ok(text) => text.trim().parse().map_err(|_| "missing"),
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => Err("permission"),
        Err(_) => Err("missing"),
    }
}

/// Bytes read and written and milliseconds busy, per whole drive (NVMe and SATA disks have a
/// `device` link; zram, loop and dm devices don't), from /proc/diskstats (in 512-byte sectors).
fn disk_stats() -> DiskCounters {
    let disks: Vec<String> = kernel::names("/sys/block")
        .into_iter()
        .filter(|n| std::fs::read_dir(format!("/sys/block/{n}/device")).is_ok())
        .collect();
    let mut out = HashMap::new();
    for line in kernel::read("/proc/diskstats").unwrap_or_default().lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 14 || !disks.iter().any(|d| d == f[2]) {
            continue;
        }
        let n = |i: usize| f[i].parse::<f64>().unwrap_or(0.0);
        out.insert(f[2].to_owned(), (n(5) * 512.0, n(9) * 512.0, n(12)));
    }
    out
}

/// Bytes read, bytes written and milliseconds busy, by drive.
type DiskCounters = HashMap<String, (f64, f64, f64)>;

#[derive(Clone, Copy)]
pub struct DiskRate {
    pub read_per_sec: f64,
    pub write_per_sec: f64,
    /// Share of the time it was busy.
    pub busy: f64,
}

#[derive(Default)]
pub struct Rates {
    pub cpu: Option<f64>,
    /// Each core's, missing for one that didn't move.
    pub cores: Vec<Option<f64>>,
    pub rx_per_sec: Option<f64>,
    pub tx_per_sec: Option<f64>,
    pub cpu_watts: Option<f64>,
    /// Why the CPU's power draw can't be read, when it can't.
    pub cpu_power_error: Option<&'static str>,
    /// By kernel name (sda).
    pub disks: HashMap<String, DiskRate>,
}

#[derive(Default)]
pub struct Sampler {
    pub rates: Mutex<Rates>,
}

impl Sampler {
    /// Runs for as long as the server does.
    pub async fn run(&self) {
        let mut last_cpu: Option<(CpuTimes, Vec<Option<CpuTimes>>)> = None;
        let mut last_net: Option<(Instant, u64, u64)> = None;
        let mut last_energy: Option<(Instant, f64)> = None;
        let mut last_disks: Option<(Instant, DiskCounters)> = None;
        let mut tick = tokio::time::interval(SAMPLE_INTERVAL);
        loop {
            tick.tick().await;
            let reading = tokio::task::spawn_blocking(|| {
                let max_energy = read_number(format!("{RAPL}/max_energy_range_uj"));
                (cpu_times(), net_bytes(), energy(), max_energy, disk_stats())
            });
            let (cpu, (rx, tx), energy, max_energy, disks) = match reading.await {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("Sampling failed: {e}");
                    continue;
                }
            };
            let now = Instant::now();
            let mut rates = self.rates.lock().unwrap();
            if let (Some((a, a_cores)), Some((b, b_cores))) = (&last_cpu, &cpu)
                && b.total > a.total
            {
                rates.cpu = busy_between(*a, *b);
                rates.cores = b_cores
                    .iter()
                    .enumerate()
                    .map(|(i, c)| busy_between(a_cores.get(i).copied().flatten()?, (*c)?))
                    .collect();
            }
            if cpu.is_some() {
                last_cpu = cpu;
            }

            match energy {
                Ok(uj) => {
                    rates.cpu_power_error = None;
                    if let Some((at, was)) = last_energy {
                        let secs = now.duration_since(at).as_secs_f64();
                        let mut used = uj - was;
                        // The counter wraps around.
                        if used < 0.0 {
                            used += max_energy.unwrap_or(0.0);
                        }
                        rates.cpu_watts = (used >= 0.0 && secs > 0.0).then(|| used / 1e6 / secs);
                    }
                    last_energy = Some((now, uj));
                }
                Err(why) => {
                    rates.cpu_power_error = Some(why);
                    rates.cpu_watts = None;
                    last_energy = None;
                }
            }

            if let Some((at, last_rx, last_tx)) = last_net {
                let secs = now.duration_since(at).as_secs_f64();
                if secs > 0.0 {
                    rates.rx_per_sec = Some((rx as f64 - last_rx as f64).max(0.0) / secs);
                    rates.tx_per_sec = Some((tx as f64 - last_tx as f64).max(0.0) / secs);
                }
            }
            last_net = Some((now, rx, tx));

            if let Some((at, prev)) = &last_disks {
                let ms = now.duration_since(*at).as_secs_f64() * 1000.0;
                rates.disks = disks
                    .iter()
                    .filter_map(|(name, (read, written, busy))| {
                        let (pr, pw, pb) = prev.get(name)?;
                        Some((
                            name.clone(),
                            DiskRate {
                                read_per_sec: ((read - pr) * 1000.0 / ms).max(0.0),
                                write_per_sec: ((written - pw) * 1000.0 / ms).max(0.0),
                                busy: ((busy - pb) / ms).clamp(0.0, 1.0),
                            },
                        ))
                    })
                    .collect();
            }
            last_disks = Some((now, disks));
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Readings

#[derive(Serialize)]
pub struct Temperature {
    pub label: &'static str,
    pub celsius: f64,
}

pub fn temperatures() -> Vec<Temperature> {
    let mut out = Vec::new();
    for h in kernel::names("/sys/class/hwmon") {
        let dir = format!("/sys/class/hwmon/{h}");
        let chip = read_trimmed(format!("{dir}/name")).unwrap_or_default();
        let Some(&(_, label, inputs)) = SENSORS.iter().find(|(c, _, _)| *c == chip) else {
            continue;
        };
        for f in kernel::names(&dir) {
            let Some(n) = f.strip_prefix("temp").and_then(|r| r.strip_suffix("_label")) else {
                continue;
            };
            if n.is_empty() || !n.bytes().all(|b| b.is_ascii_digit()) {
                continue;
            }
            if !read_trimmed(format!("{dir}/{f}")).is_some_and(|l| inputs.contains(&l.as_str())) {
                continue;
            }
            if let Some(milli) = read_number(format!("{dir}/temp{n}_input")) {
                out.push(Temperature {
                    label,
                    celsius: milli / 1000.0,
                });
            }
            break;
        }
    }
    let order = |label: &str| SENSORS.iter().position(|(_, l, _)| *l == label).unwrap_or(usize::MAX);
    out.sort_by_key(|t| order(t.label));
    out
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Disk {
    mount: String,
    total_bytes: u64,
    used_bytes: u64,
    available_bytes: u64,
}

pub fn statfs(mount: &str) -> Option<libc::statfs> {
    let path = CString::new(mount).ok()?;
    let mut s: libc::statfs = unsafe { std::mem::zeroed() };
    // SAFETY: `path` is a valid C string and `s` a buffer of the right type for the call to fill.
    (unsafe { libc::statfs(path.as_ptr(), &mut s) } == 0).then_some(s)
}

fn disks() -> Vec<Disk> {
    let mut seen: Vec<(String, String)> = Vec::new();
    for line in kernel::read("/proc/mounts").unwrap_or_default().lines() {
        let mut f = line.split(' ');
        let (Some(device), Some(mount), Some(fs_type)) = (f.next(), f.next(), f.next()) else {
            continue;
        };
        if !REAL_FILESYSTEMS.contains(&fs_type) || hidden_mount(mount) {
            continue;
        }
        let mount = mount.replace("\\040", " ");
        // btrfs subvolumes (/ and /home) share a device; keep the shortest mount point.
        match seen.iter_mut().find(|(d, _)| d == device) {
            Some((_, m)) if mount.len() < m.len() => *m = mount,
            Some(_) => {}
            None => seen.push((device.to_owned(), mount)),
        }
    }
    let mut out: Vec<Disk> = seen
        .into_iter()
        .filter_map(|(_, mount)| {
            let s = statfs(&mount)?;
            let bsize = s.f_bsize as u64;
            let total = s.f_blocks * bsize;
            Some(Disk {
                total_bytes: total,
                used_bytes: total - s.f_bfree * bsize,
                available_bytes: s.f_bavail * bsize,
                mount,
            })
        })
        .collect();
    out.sort_by(|a, b| {
        a.mount
            .to_lowercase()
            .cmp(&b.mount.to_lowercase())
            .then_with(|| a.mount.cmp(&b.mount))
    });
    out
}

// ---------------------------------------------------------------------------------------------
// The endpoint

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Host {
    name: String,
    uptime_sec: f64,
    kernel: String,
}

#[derive(Serialize)]
struct Cpu {
    #[serde(skip_serializing_if = "Option::is_none")]
    usage: Option<f64>,
    load: [f64; 3],
    cores: usize,
}

#[derive(Serialize)]
struct Gpu {
    #[serde(skip_serializing_if = "Option::is_none")]
    usage: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Memory {
    total_bytes: i64,
    available_bytes: i64,
    swap_total_bytes: i64,
    swap_free_bytes: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Network {
    #[serde(skip_serializing_if = "Option::is_none")]
    rx_per_sec: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tx_per_sec: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusOut {
    host: Host,
    cpu: Cpu,
    gpu: Gpu,
    memory: Memory,
    network: Network,
    temperatures: Vec<Temperature>,
    disks: Vec<Disk>,
    services: Vec<Service>,
    game_mode: serde_json::Value,
    /// What Jellyfin is playing, as `/api/jellyfin/sessions` lists it.
    streams: Vec<serde_json::Value>,
    at: i64,
}

/// What's quick to read, taken together off the async threads.
struct Machine {
    host: Host,
    load: [f64; 3],
    gpu_busy: Option<f64>,
    memory: Memory,
    temperatures: Vec<Temperature>,
    disks: Vec<Disk>,
}

fn machine() -> Machine {
    let load: Vec<f64> = read_trimmed("/proc/loadavg")
        .unwrap_or_default()
        .split(' ')
        .take(3)
        .map(|v| v.parse().unwrap_or(0.0))
        .collect();
    let info = meminfo();
    let get = |k: &str| info.get(k).copied().unwrap_or(0);
    Machine {
        host: Host {
            name: read_trimmed("/proc/sys/kernel/hostname").unwrap_or_default(),
            uptime_sec: read_trimmed("/proc/uptime")
                .and_then(|u| u.split(' ').next()?.parse::<f64>().ok())
                .unwrap_or(0.0)
                .round(),
            kernel: read_trimmed("/proc/sys/kernel/osrelease").unwrap_or_default(),
        },
        load: load.try_into().unwrap_or([0.0; 3]),
        gpu_busy: crate::gpu::card()
            .and_then(|dir| read_number(dir.join("gpu_busy_percent")))
            .map(|b| b / 100.0),
        memory: Memory {
            total_bytes: get("MemTotal"),
            available_bytes: get("MemAvailable"),
            swap_total_bytes: get("SwapTotal"),
            swap_free_bytes: get("SwapFree"),
        },
        temperatures: temperatures(),
        disks: disks(),
    }
}

pub async fn handler(AxumState(state): AxumState<State>) -> Result<Json<StatusOut>, HttpError> {
    Ok(Json(read(&state).await?))
}

pub async fn read(state: &State) -> Result<StatusOut, HttpError> {
    let (machine, services) = tokio::join!(tokio::task::spawn_blocking(machine), services::list(&state.services, &state.usage));
    let game_mode = state.game_mode.state();
    let machine = machine.map_err(|e| HttpError::internal(e.to_string()))?;
    let services = services?;
    let rates = state.sampler.rates.lock().unwrap();
    Ok(StatusOut {
        host: machine.host,
        cpu: Cpu {
            usage: rates.cpu,
            load: machine.load,
            cores: std::thread::available_parallelism().map_or(1, |n| n.get()),
        },
        gpu: Gpu { usage: machine.gpu_busy },
        memory: machine.memory,
        network: Network {
            rx_per_sec: rates.rx_per_sec,
            tx_per_sec: rates.tx_per_sec,
        },
        temperatures: machine.temperatures,
        disks: machine.disks,
        services,
        game_mode,
        streams: state.jellyfin.sessions().to_vec(),
        at: now_ms(),
    })
}

#[cfg(test)]
mod tests {
    use super::{CpuTimes, busy_between, hidden_mount};

    #[test]
    fn busy() {
        let t = |idle, total| CpuTimes { idle, total };
        assert_eq!(busy_between(t(50, 100), t(100, 200)), Some(0.5));
        // Idle went backwards: fully busy, not a wrapped number.
        assert_eq!(busy_between(t(100, 100), t(90, 200)), Some(1.0));
        assert_eq!(busy_between(t(0, 100), t(0, 100)), None);
    }

    #[test]
    fn hidden_mounts() {
        assert!(hidden_mount("/boot"));
        assert!(hidden_mount("/boot/efi"));
        assert!(hidden_mount("/efi"));
        assert!(!hidden_mount("/bootleg"));
        assert!(!hidden_mount("/"));
        assert!(!hidden_mount("/data"));
    }
}

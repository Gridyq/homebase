//! Usage per service. Every systemd unit and container has its own cgroup, which counts the
//! memory, CPU time and disk traffic of everything inside it. `GET /api/usage` lists them all,
//! named after their service where there is one, with where the machine's memory goes.

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::Json;
use axum::extract::State as AxumState;
use serde::{Deserialize, Serialize};

use crate::cache::Refreshed;
use crate::http::{HttpError, State};

const CGROUP_ROOT: &str = "/sys/fs/cgroup";

/// systemd units shown besides the containers; the same list as `UNITS` in the Node server.
pub struct Unit {
    pub id: &'static str,
    pub name: &'static str,
    pub unit: &'static str,
    /// The service a timer triggers, which is what does the work.
    pub runs: Option<&'static str>,
}

pub const UNITS: &[Unit] = &[
    Unit {
        id: "homebase-updates",
        name: "Homebase updates",
        unit: "homebase-updates.service",
        runs: None,
    },
    Unit {
        id: "homebase-status",
        name: "Homebase status",
        unit: "homebase-status.service",
        runs: None,
    },
    Unit {
        id: "jellyfin-backup",
        name: "Jellyfin backup",
        unit: "jellyfin-backup.timer",
        runs: Some("jellyfin-backup.service"),
    },
    Unit {
        id: "tailscale",
        name: "Tailscale",
        unit: "tailscaled.service",
        runs: None,
    },
];

// ---------------------------------------------------------------------------------------------
// Containers

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct Pod {
    pub id: String,
    pub names: Option<Vec<String>>,
    pub labels: Option<HashMap<String, String>>,
}

impl Pod {
    pub fn name(&self) -> String {
        self.names
            .as_ref()
            .and_then(|n| n.first())
            .cloned()
            .unwrap_or_else(|| self.id.chars().take(12).collect())
    }

    fn systemd_unit(&self) -> Option<&str> {
        self.labels.as_ref()?.get("PODMAN_SYSTEMD_UNIT").map(String::as_str)
    }
}

async fn podman_ps() -> Result<Vec<Pod>, String> {
    let out = tokio::process::Command::new("podman")
        .args(["ps", "--all", "--format", "json"])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_owned());
    }
    if out.stdout.iter().all(u8::is_ascii_whitespace) {
        return Ok(Vec::new());
    }
    serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------------------------
// cgroups

struct GroupReading {
    dir: String,
    used_bytes: i64,
    cache_bytes: u64,
    cpu_usec: u64,
    read_bytes: u64,
    written_bytes: u64,
}

#[derive(Clone, Copy)]
struct Rates {
    cpu: f64,
    read_per_sec: f64,
    write_per_sec: f64,
}

/// Services and scopes, as paths relative to the cgroup root. A unit's own sub-groups (a
/// terminal's tabs, a container's payload) count toward it; only a user manager, which holds
/// slices of its own, is looked into.
fn leaf_groups(dir: &str) -> Vec<String> {
    let children: Vec<String> = fs::read_dir(Path::new(CGROUP_ROOT).join(dir))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| [".slice", ".service", ".scope"].iter().any(|s| n.ends_with(s)))
        .collect();
    let is_unit = dir.ends_with(".service") || dir.ends_with(".scope");
    if is_unit && !children.iter().any(|c| c.ends_with(".slice")) {
        return vec![dir.to_owned()];
    }
    if !dir.is_empty() && children.is_empty() {
        return Vec::new();
    }
    children
        .iter()
        .flat_map(|c| leaf_groups(&if dir.is_empty() { c.clone() } else { format!("{dir}/{c}") }))
        .collect()
}

/// "key value" lines, as in memory.stat and cpu.stat.
fn stat_field(text: &str, key: &str) -> Option<u64> {
    text.lines().find_map(|l| l.strip_prefix(key)?.strip_prefix(' ')?.parse().ok())
}

fn read_group(dir: String) -> Option<GroupReading> {
    let base = Path::new(CGROUP_ROOT).join(&dir);
    let read = |f: &str| fs::read_to_string(base.join(f)).unwrap_or_default();
    let current: i64 = fs::read_to_string(base.join("memory.current")).ok()?.trim().parse().ok()?;
    let (mem, cpu, io) = (read("memory.stat"), read("cpu.stat"), read("io.stat"));

    let (mut read_bytes, mut written_bytes) = (0, 0);
    // "8:0 rbytes=1 wbytes=2 rios=..." per drive.
    for line in io.lines() {
        let mut fields = line.split(' ').skip(1);
        let rbytes = fields.next().and_then(|f| f.strip_prefix("rbytes=")?.parse::<u64>().ok());
        let wbytes = fields.next().and_then(|f| f.strip_prefix("wbytes=")?.parse::<u64>().ok());
        if let (Some(r), Some(w)) = (rbytes, wbytes) {
            read_bytes += r;
            written_bytes += w;
        }
    }
    // File pages are cache the kernel can take back, except shared memory, which counts as file.
    let cache = stat_field(&mem, "file")
        .unwrap_or(0)
        .saturating_sub(stat_field(&mem, "shmem").unwrap_or(0));
    Some(GroupReading {
        dir,
        used_bytes: current - cache as i64,
        cache_bytes: cache,
        cpu_usec: stat_field(&cpu, "usage_usec").unwrap_or(0),
        read_bytes,
        written_bytes,
    })
}

/// "app-org.kde.konsole-3158.scope" → "konsole", "session-c10.scope" → "Login session c10".
fn group_label(unit: &str) -> String {
    if let Some(id) = unit.strip_prefix("session-").and_then(|s| s.strip_suffix(".scope"))
        && !id.is_empty()
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return format!("Login session {id}");
    }
    if unit.starts_with("run-") {
        return "Command".into();
    }
    let name = unit
        .strip_suffix(".service")
        .or_else(|| unit.strip_suffix(".scope"))
        .unwrap_or(unit);
    let name = name.strip_prefix("app-").unwrap_or(name);
    let name = name.split('@').next().unwrap_or(name);
    // A trailing instance number, as in "-3158".
    let name = match name.rsplit_once('-') {
        Some((head, digits)) if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) => head,
        _ => name,
    };
    let name = name.replace("\\x2d", "-");
    // Reverse-DNS names (org.kde.konsole) read best as their last part.
    match name.rsplit_once('.') {
        Some((_, last)) => last.to_owned(),
        None => name,
    }
}

fn group_category(dir: &str) -> &'static str {
    if dir.starts_with("system.slice/") || dir == "init.scope" {
        return "system";
    }
    let login = dir
        .strip_prefix("user.slice/")
        .and_then(|rest| rest.split_once('/'))
        .is_some_and(|(user, rest)| !user.is_empty() && rest.starts_with("session-"));
    if login { "login" } else { "desktop" }
}

/// Maps cgroups to the dashboard's services: by systemd unit, or a plain container's scope.
/// In order, as the later of two services claiming a cgroup wins.
fn service_groups<'a>(groups: &'a [(GroupReading, Option<Rates>)], pods: &[Pod]) -> Vec<(String, &'a str)> {
    let mut by_unit: HashMap<&str, &str> = HashMap::new();
    for (g, _) in groups {
        let unit = g.dir.rsplit('/').next().unwrap_or(&g.dir);
        // A user unit wins over a system unit of the same name.
        if !by_unit.contains_key(unit) || g.dir.contains("/user@") {
            by_unit.insert(unit, &g.dir);
        }
    }
    let mut out = Vec::new();
    for p in pods {
        let scope = format!("libpod-{}.scope", p.id);
        let dir = p
            .systemd_unit()
            .and_then(|u| by_unit.get(u))
            .or_else(|| by_unit.get(scope.as_str()));
        if let Some(dir) = dir {
            out.push((format!("container:{}", p.name()), *dir));
        }
    }
    for u in UNITS {
        if let Some(dir) = by_unit.get(u.runs.unwrap_or(u.unit)) {
            out.push((format!("unit:{}", u.id), *dir));
        }
    }
    out
}

// ---------------------------------------------------------------------------------------------
// Memory

/// /proc/meminfo in bytes.
fn meminfo() -> HashMap<String, i64> {
    fs::read_to_string("/proc/meminfo")
        .unwrap_or_default()
        .lines()
        .filter_map(|l| {
            let (key, rest) = l.split_once(':')?;
            let kib: i64 = rest.split_whitespace().next()?.parse().ok()?;
            Some((key.to_owned(), kib * 1024))
        })
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MemoryBreakdown {
    total_bytes: i64,
    available_bytes: i64,
    apps_bytes: i64,
    cache_bytes: i64,
    kernel_bytes: i64,
    free_bytes: i64,
    swap_total_bytes: i64,
    swap_used_bytes: i64,
}

/// `apps` is memory programs asked for (including shared memory, which graphics and browsers
/// use), `cache` is file data the kernel keeps around and hands back when something needs it, and
/// `kernel` is the rest of what isn't free.
fn memory_breakdown(info: &HashMap<String, i64>) -> MemoryBreakdown {
    let get = |k: &str| info.get(k).copied().unwrap_or(0);
    let apps = get("AnonPages") + get("Shmem");
    let cache = get("Buffers") + get("Cached") - get("Shmem") + get("SReclaimable");
    let free = get("MemFree");
    MemoryBreakdown {
        total_bytes: get("MemTotal"),
        available_bytes: get("MemAvailable"),
        apps_bytes: apps,
        cache_bytes: cache,
        kernel_bytes: (get("MemTotal") - free - apps - cache).max(0),
        free_bytes: free,
        swap_total_bytes: get("SwapTotal"),
        swap_used_bytes: get("SwapTotal") - get("SwapFree"),
    }
}

/// Share of the last minute something waited on the CPU, memory or disk.
fn pressure() -> serde_json::Map<String, serde_json::Value> {
    let mut out = serde_json::Map::new();
    for kind in ["cpu", "memory", "io"] {
        let text = fs::read_to_string(format!("/proc/pressure/{kind}")).unwrap_or_default();
        let avg = text
            .lines()
            .find(|l| l.starts_with("some "))
            .and_then(|l| l.split(' ').find_map(|f| f.strip_prefix("avg60=")))
            .and_then(|v| v.parse::<f64>().ok());
        if let Some(avg) = avg {
            out.insert(kind.into(), (avg / 100.0).into());
        }
    }
    out
}

// ---------------------------------------------------------------------------------------------
// The endpoint

type PodList = Refreshed<Vec<Pod>, fn() -> std::pin::Pin<Box<dyn Future<Output = Result<Vec<Pod>, String>> + Send>>>;

/// CPU time, bytes read and bytes written per cgroup at the last reading, for the rates.
type GroupCounters = HashMap<String, (u64, u64, u64)>;

pub struct Usage {
    /// `podman ps` takes ~60 ms, and most screens ask for it every few seconds.
    pods: Arc<PodList>,
    last_groups: Mutex<Option<(Instant, GroupCounters)>>,
    rates: Mutex<HashMap<String, Rates>>,
}

impl Usage {
    pub fn new() -> Self {
        Self {
            pods: Refreshed::new("podman ps", Duration::from_secs(2), Duration::from_secs(10), || {
                Box::pin(podman_ps())
            }),
            last_groups: Mutex::new(None),
            rates: Mutex::new(HashMap::new()),
        }
    }

    /// Every leaf cgroup with its memory now and its CPU and disk rates since the last reading.
    /// Readings less than a second apart reuse the previous rates rather than divide by almost
    /// zero.
    async fn groups(&self) -> Result<Vec<(GroupReading, Option<Rates>)>, HttpError> {
        // The kernel builds memory.stat when it's read, ~15 ms for them all.
        let groups = tokio::task::spawn_blocking(|| leaf_groups("").into_iter().filter_map(read_group).collect::<Vec<_>>())
            .await
            .map_err(|e| HttpError::internal(e.to_string()))?;
        let now = Instant::now();
        let mut last = self.last_groups.lock().unwrap();
        let mut rates = self.rates.lock().unwrap();
        if last
            .as_ref()
            .is_none_or(|(at, _)| now.duration_since(*at) >= Duration::from_secs(1))
        {
            if let Some((at, prev)) = last.as_ref() {
                let secs = now.duration_since(*at).as_secs_f64();
                let cores = std::thread::available_parallelism().map_or(1, |n| n.get()) as f64;
                let per_sec = |now: u64, before: u64| (now as f64 - before as f64).max(0.0) / secs;
                *rates = groups
                    .iter()
                    .filter_map(|g| {
                        let &(cpu, read, written) = prev.get(&g.dir)?;
                        Some((
                            g.dir.clone(),
                            Rates {
                                cpu: per_sec(g.cpu_usec, cpu) / 1e6 / cores,
                                read_per_sec: per_sec(g.read_bytes, read),
                                write_per_sec: per_sec(g.written_bytes, written),
                            },
                        ))
                    })
                    .collect();
            }
            *last = Some((
                now,
                groups
                    .iter()
                    .map(|g| (g.dir.clone(), (g.cpu_usec, g.read_bytes, g.written_bytes)))
                    .collect(),
            ));
        }
        Ok(groups
            .into_iter()
            .map(|g| {
                let r = rates.get(&g.dir).copied();
                (g, r)
            })
            .collect())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GroupOut {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    category: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    service_id: Option<String>,
    used_bytes: i64,
    cache_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    cpu: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    read_per_sec: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    write_per_sec: Option<f64>,
}

#[derive(Serialize)]
pub struct UsageOut {
    memory: MemoryBreakdown,
    pressure: serde_json::Map<String, serde_json::Value>,
    groups: Vec<GroupOut>,
    at: u64,
}

pub async fn handler(AxumState(state): AxumState<State>) -> Result<Json<UsageOut>, HttpError> {
    let usage = &state.usage;
    let (groups, pods) = tokio::join!(usage.groups(), usage.pods.get());
    let groups = groups?;
    let pods = pods.unwrap_or_else(|e| {
        eprintln!("podman ps failed: {e}");
        Arc::new(Vec::new())
    });

    let mut names: HashMap<String, Option<String>> = HashMap::new();
    for p in pods.iter() {
        names.insert(format!("container:{}", p.name()), p.names.as_ref().and_then(|n| n.first()).cloned());
    }
    for u in UNITS {
        names.insert(format!("unit:{}", u.id), Some(u.name.to_owned()));
    }
    let service_by_dir: HashMap<String, String> = service_groups(&groups, &pods)
        .into_iter()
        .map(|(id, dir)| (dir.to_owned(), id))
        .collect();

    let mut out: Vec<GroupOut> = groups
        .iter()
        .map(|(g, rates)| {
            let service_id = service_by_dir.get(&g.dir).cloned();
            let basename = g.dir.rsplit('/').next().unwrap_or(&g.dir);
            GroupOut {
                id: g.dir.clone(),
                name: match &service_id {
                    Some(id) => names.get(id).cloned().flatten(),
                    None => Some(group_label(basename)),
                },
                category: match &service_id {
                    Some(id) if id.starts_with("container:") => "container",
                    Some(_) => "homebase",
                    None => group_category(&g.dir),
                },
                service_id,
                used_bytes: g.used_bytes,
                cache_bytes: g.cache_bytes,
                cpu: rates.map(|r| r.cpu),
                read_per_sec: rates.map(|r| r.read_per_sec),
                write_per_sec: rates.map(|r| r.write_per_sec),
            }
        })
        .collect();
    out.sort_by_key(|g| std::cmp::Reverse(g.used_bytes));

    Ok(Json(UsageOut {
        memory: memory_breakdown(&meminfo()),
        pressure: pressure(),
        groups: out,
        at: now_ms(),
    }))
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels() {
        assert_eq!(group_label("app-org.kde.konsole-3158.scope"), "konsole");
        assert_eq!(group_label("session-c10.scope"), "Login session c10");
        assert_eq!(group_label("run-r1234.scope"), "Command");
        assert_eq!(group_label("user@1000.service"), "user");
        assert_eq!(group_label("app-flatpak-com.valvesoftware.Steam-12.scope"), "Steam");
        assert_eq!(group_label("dbus\\x2dbroker.service"), "dbus-broker");
        assert_eq!(group_label("pipewire.service"), "pipewire");
    }

    #[test]
    fn categories() {
        assert_eq!(group_category("system.slice/sshd.service"), "system");
        assert_eq!(group_category("init.scope"), "system");
        assert_eq!(group_category("user.slice/user-1000.slice/session-2.scope"), "login");
        assert_eq!(
            group_category("user.slice/user-1000.slice/user@1000.service/app.slice/x.service"),
            "desktop"
        );
    }
}

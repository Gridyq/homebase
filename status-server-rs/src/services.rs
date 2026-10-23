//! Everything the dashboard lists: the Podman containers, the Quadlet containers that are
//! stopped (Quadlet removes a container when it stops), and the systemd units in `UNITS`, each with
//! its state, what can be done to it, and what it's using.
//!
//! Starting and stopping still happens in the Node server; when it has, the proxy calls
//! `Services::expire` so the next look waits for what they're doing now.

use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tokio::process::Command;

use crate::cache::Refreshed;
use crate::http::HttpError;
use crate::usage::{Pod, Rates, UNITS, Usage, service_groups};

const UNIT_PROPS: &str = "ActiveState,SubState,Result,ActiveEnterTimestamp,LastTriggerUSec,NextElapseUSecRealtime,NRestarts";

type Take = Box<dyn Fn() -> Pin<Box<dyn Future<Output = Result<String, String>> + Send>> + Send + Sync>;
type UnitReading = Refreshed<String, Take>;

/// `systemctl show` readings by their arguments, since each takes ~10 ms.
#[derive(Default)]
pub struct Services {
    unit_readings: Mutex<HashMap<Vec<String>, Arc<UnitReading>>>,
}

type Props = HashMap<String, String>;

impl Services {
    async fn show_units(&self, units: &[String], system: bool) -> Result<HashMap<String, Props>, HttpError> {
        if units.is_empty() {
            return Ok(HashMap::new());
        }
        let mut args: Vec<String> = if system { vec![] } else { vec!["--user".into()] };
        args.extend(["show".into(), "--timestamp=unix".into(), format!("--property={UNIT_PROPS}")]);
        args.extend(units.iter().cloned());
        let reading = {
            let mut readings = self.unit_readings.lock().unwrap();
            let args = args.clone();
            Arc::clone(readings.entry(args.clone()).or_insert_with(|| {
                let take: Take = Box::new(move || Box::pin(run("systemctl", args.clone())));
                Refreshed::new("systemctl show", Duration::from_secs(2), Duration::from_secs(10), take)
            }))
        };
        let stdout = reading.get().await.map_err(HttpError::internal)?;
        // One block per unit, in the order asked, separated by blank lines.
        let blocks: Vec<&str> = stdout.trim().split("\n\n").filter(|b| !b.trim().is_empty()).collect();
        Ok(units
            .iter()
            .enumerate()
            .map(|(i, u)| {
                let props = blocks
                    .get(i)
                    .map(|b| {
                        b.lines()
                            .filter_map(|l| l.split_once('='))
                            .map(|(k, v)| (k.to_owned(), v.to_owned()))
                            .collect()
                    })
                    .unwrap_or_default();
                (u.clone(), props)
            })
            .collect())
    }

    /// After starting or stopping something.
    pub fn expire(&self, usage: &Usage) {
        usage.pods.expire();
        for reading in self.unit_readings.lock().unwrap().drain() {
            reading.1.expire();
        }
    }
}

async fn run(program: &str, args: Vec<String>) -> Result<String, String> {
    let out = Command::new(program).args(&args).output().await.map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_owned());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

struct Quadlet {
    name: String,
    image: Option<String>,
    unit: String,
}

/// Containers that systemd runs from Quadlet files, with their units.
async fn quadlets() -> Vec<Quadlet> {
    let dir = PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".config/containers/systemd");
    tokio::task::spawn_blocking(move || {
        crate::kernel::names(&dir)
            .into_iter()
            .filter_map(|f| {
                let base = f.strip_suffix(".container")?.to_owned();
                let text = std::fs::read_to_string(dir.join(&f)).ok()?;
                let key = |k: &str| {
                    text.lines()
                        .find_map(|l| l.strip_prefix(k))
                        .map(|v| v.trim().to_owned())
                        .filter(|v| !v.is_empty())
                };
                Some(Quadlet {
                    name: key("ContainerName=").unwrap_or_else(|| format!("systemd-{base}")),
                    image: key("Image="),
                    unit: format!("{base}.service"),
                })
            })
            .collect()
    })
    .await
    .unwrap_or_else(|e| {
        eprintln!("Reading Quadlet files failed: {e}");
        Vec::new()
    })
}

/// "@1792553287" → milliseconds, or none for an empty or zero timestamp.
fn unix_timestamp(value: Option<&String>) -> Option<i64> {
    let secs: i64 = value?.trim_start_matches('@').parse().ok()?;
    (secs != 0).then_some(secs * 1000)
}

fn unit_state(props: &Props) -> &'static str {
    match props.get("ActiveState").map(String::as_str) {
        Some("failed") => "failed",
        Some("active" | "reloading") => "running",
        Some("activating" | "deactivating") => "changing",
        _ => "stopped",
    }
}

fn restarts(props: Option<&Props>) -> u64 {
    props.and_then(|p| p.get("NRestarts")).and_then(|n| n.parse().ok()).unwrap_or(0)
}

fn image_name(image: &str) -> String {
    let short = image.strip_prefix("docker.io/").unwrap_or(image);
    short
        .strip_prefix("library/")
        .filter(|_| image.starts_with("docker.io/"))
        .unwrap_or(short)
        .to_owned()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceUsage {
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
#[serde(rename_all = "camelCase")]
pub struct Service {
    id: String,
    name: String,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    health: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    since: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    restarts: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_run: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_run: Option<i64>,
    actions: Vec<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    usage: Option<ServiceUsage>,
}

impl Service {
    fn new(id: String, name: String, kind: &'static str, state: &'static str, actions: Vec<&'static str>) -> Self {
        Self {
            id,
            name,
            kind,
            detail: None,
            state,
            health: None,
            since: None,
            restarts: None,
            last_run: None,
            next_run: None,
            actions,
            usage: None,
        }
    }
}

/// "Up 2 hours (healthy)" → "healthy".
fn health(status: &str) -> Option<String> {
    ["healthy", "unhealthy", "starting"]
        .iter()
        .find(|h| status.contains(&format!("({h})")))
        .map(|h| h.to_string())
}

pub async fn list(services: &Services, usage: &Usage) -> Result<Vec<Service>, HttpError> {
    let (pods, quadlet_list, groups) = tokio::join!(usage.pods.get(), quadlets(), usage.groups());
    let pods = pods.unwrap_or_else(|e| {
        eprintln!("podman ps failed: {e}");
        Arc::new(Vec::new())
    });
    let groups = groups.unwrap_or_else(|e| {
        eprintln!("Reading cgroups failed: {}", e.1);
        Vec::new()
    });
    let usage_by_id: HashMap<String, &str> = service_groups(&groups, &pods).into_iter().collect();
    let group_by_dir: HashMap<&str, &(crate::usage::GroupReading, Option<Rates>)> = groups.iter().map(|g| (g.0.dir.as_str(), g)).collect();

    let has_name = |p: &Pod, name: &str| p.names.as_ref().is_some_and(|n| n.iter().any(|x| x == name));
    let gone: Vec<&Quadlet> = quadlet_list.iter().filter(|q| !pods.iter().any(|p| has_name(p, &q.name))).collect();
    let mut user_units: Vec<String> = pods
        .iter()
        .filter_map(|p| p.systemd_unit().filter(|u| !u.is_empty()))
        .map(str::to_owned)
        .collect();
    user_units.extend(gone.iter().map(|q| q.unit.clone()));
    user_units.extend(UNITS.iter().filter(|u| !u.system).map(|u| u.unit.to_owned()));
    user_units.extend(UNITS.iter().filter_map(|u| u.runs).map(str::to_owned));
    let system_units: Vec<String> = UNITS.iter().filter(|u| u.system).map(|u| u.unit.to_owned()).collect();
    let (user_props, system_props) = tokio::join!(services.show_units(&user_units, false), services.show_units(&system_units, true));
    let (user_props, system_props) = (user_props?, system_props?);
    let empty = Props::new();

    let mut list: Vec<Service> = pods
        .iter()
        .map(|p| {
            let name = p.name();
            let props = p
                .systemd_unit()
                .filter(|u| !u.is_empty())
                .map(|u| user_props.get(u).unwrap_or(&empty));
            let running = p.state.as_deref() == Some("running");
            let state = match props {
                Some(props) => unit_state(props),
                None if running => "running",
                None if matches!(p.state.as_deref(), Some("created" | "exited")) => "stopped",
                None => "changing",
            };
            let mut s = Service::new(
                format!("container:{name}"),
                name,
                "container",
                state,
                if running { vec!["restart", "stop"] } else { vec!["start"] },
            );
            s.detail = p.image.as_deref().map(image_name);
            s.health = p.status.as_deref().and_then(health);
            s.since = if running {
                p.started_at.map(|t| (t * 1000.0) as i64)
            } else {
                p.exited_at.filter(|t| *t != 0.0).map(|t| (t * 1000.0) as i64)
            };
            s.restarts = Some(restarts(props));
            s
        })
        .collect();

    for q in gone {
        let state = unit_state(user_props.get(&q.unit).unwrap_or(&empty));
        let mut s = Service::new(
            format!("container:{}", q.name),
            q.name.clone(),
            "container",
            state,
            if state == "changing" { vec![] } else { vec!["start"] },
        );
        s.detail = q.image.as_deref().map(image_name);
        list.push(s);
    }

    for u in UNITS {
        let props = (if u.system { &system_props } else { &user_props }).get(u.unit).unwrap_or(&empty);
        if let Some(runs) = u.runs {
            let job = user_props.get(runs).unwrap_or(&empty);
            let state = match job.get("ActiveState").map(String::as_str) {
                Some("failed") => "failed",
                Some("activating") => "changing",
                _ => unit_state(props),
            };
            let mut s = Service::new(
                format!("unit:{}", u.id),
                u.name.into(),
                "timer",
                state,
                if state == "changing" { vec![] } else { vec!["run"] },
            );
            s.detail = job
                .get("Result")
                .filter(|r| !r.is_empty() && *r != "success")
                .map(|r| format!("Last run: {r}"));
            s.last_run = unix_timestamp(props.get("LastTriggerUSec"));
            s.next_run = unix_timestamp(props.get("NextElapseUSecRealtime"));
            list.push(s);
            continue;
        }
        let state = unit_state(props);
        let actions = match () {
            _ if u.system => vec![],
            _ if u.this_server => vec!["restart"],
            _ if state == "running" => vec!["restart", "stop"],
            _ => vec!["start"],
        };
        let mut s = Service::new(format!("unit:{}", u.id), u.name.into(), "service", state, actions);
        s.detail = props
            .get("Result")
            .filter(|r| state == "failed" && !r.is_empty())
            .map(|r| format!("Failed: {r}"));
        s.since = unix_timestamp(props.get("ActiveEnterTimestamp"));
        s.restarts = Some(restarts(Some(props)));
        list.push(s);
    }

    for s in &mut list {
        // A stopped unit's cgroup can linger with leftover cache; don't show that as usage.
        if s.state == "stopped" {
            continue;
        }
        if let Some((g, rates)) = usage_by_id.get(&s.id).and_then(|dir| group_by_dir.get(dir)).copied() {
            s.usage = Some(ServiceUsage {
                used_bytes: g.used_bytes,
                cache_bytes: g.cache_bytes,
                cpu: rates.map(|r| r.cpu),
                read_per_sec: rates.map(|r| r.read_per_sec),
                write_per_sec: rates.map(|r| r.write_per_sec),
            });
        }
    }
    Ok(list)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn images_lose_the_docker_hub_prefix() {
        assert_eq!(image_name("docker.io/library/nginx:1"), "nginx:1");
        assert_eq!(image_name("docker.io/jellyfin/jellyfin"), "jellyfin/jellyfin");
        assert_eq!(image_name("lscr.io/linuxserver/sonarr"), "lscr.io/linuxserver/sonarr");
        assert_eq!(image_name("ghcr.io/library/x"), "ghcr.io/library/x");
    }

    #[test]
    fn timestamps() {
        assert_eq!(unix_timestamp(Some(&"@1792553287".into())), Some(1792553287000));
        assert_eq!(unix_timestamp(Some(&"".into())), None);
        assert_eq!(unix_timestamp(Some(&"@0".into())), None);
        assert_eq!(unix_timestamp(None), None);
    }

    #[test]
    fn healths() {
        assert_eq!(health("Up 2 hours (healthy)").as_deref(), Some("healthy"));
        assert_eq!(health("Up 1 second (starting)").as_deref(), Some("starting"));
        assert_eq!(health("Up 2 hours"), None);
    }
}

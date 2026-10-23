//! `GET /api/processes`: the processes using the most memory or CPU, with CPU measured since the
//! previous call, each named after the service it belongs to.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::Json;
use axum::extract::State as AxumState;
use serde::Serialize;

use crate::http::{HttpError, State};
use crate::kernel;
use crate::usage::{now_ms, service_of_group};

const CLOCK_TICKS: f64 = 100.0;
const PAGE_SIZE: u64 = 4096;
const LIST_LENGTH: usize = 40;
/// An older reading is too far back to say what a process is doing now.
const PREVIOUS_MAX_AGE: Duration = Duration::from_secs(5 * 60);

struct Reading {
    pid: u32,
    name: String,
    command: String,
    group: Option<String>,
    /// Pid and start time, since pids are reused.
    key: String,
    ticks: u64,
    rss_bytes: u64,
}

fn read_process(pid: &str) -> Option<Reading> {
    let stat = kernel::read(format!("/proc/{pid}/stat"))?;
    let cgroup = kernel::read(format!("/proc/{pid}/cgroup"))?;
    let cmdline = kernel::read(format!("/proc/{pid}/cmdline"))?;
    // The name sits in parentheses and can itself contain spaces or parentheses.
    let open = stat.find('(')?;
    let close = stat.rfind(')')?;
    let f: Vec<&str> = stat.get(close + 2..)?.split(' ').collect();
    let field = |i: usize| f.get(i).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
    let rss_bytes = field(21) * PAGE_SIZE;
    if rss_bytes == 0 {
        return None; // Kernel threads.
    }
    Some(Reading {
        pid: pid.parse().ok()?,
        name: stat[open + 1..close].to_owned(),
        command: cmdline.trim_end_matches('\0').replace('\0', " ").chars().take(300).collect(),
        group: kernel::cgroup_of(&cgroup).map(str::to_owned),
        key: format!("{pid}:{}", f.get(19).unwrap_or(&"")),
        ticks: field(11) + field(12),
        rss_bytes,
    })
}

#[derive(Default)]
pub struct Processes {
    last: Mutex<Option<(Instant, HashMap<String, u64>)>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProcessOut {
    pid: u32,
    name: String,
    command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    service: Option<String>,
    rss_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    cpu: Option<f64>,
}

#[derive(Serialize)]
pub struct ProcessesOut {
    processes: Vec<ProcessOut>,
    count: usize,
    at: u64,
}

pub async fn handler(AxumState(state): AxumState<State>) -> Result<Json<ProcessesOut>, HttpError> {
    let list = tokio::task::spawn_blocking(|| kernel::pids().iter().filter_map(|p| read_process(p)).collect::<Vec<_>>())
        .await
        .map_err(|e| HttpError::internal(e.to_string()))?;

    let now = Instant::now();
    let previous = {
        let mut last = state.processes.last.lock().unwrap();
        let previous = last.take().filter(|(at, _)| now.duration_since(*at) < PREVIOUS_MAX_AGE);
        *last = Some((now, list.iter().map(|p| (p.key.clone(), p.ticks)).collect()));
        previous
    };
    let cores = std::thread::available_parallelism().map_or(1, |n| n.get()) as f64;

    let names = state.usage.group_names().await?;
    let with_cpu: Vec<ProcessOut> = list
        .iter()
        .map(|p| {
            let cpu = previous.as_ref().and_then(|(at, ticks)| {
                let secs = now.duration_since(*at).as_secs_f64();
                let before = *ticks.get(&p.key)?;
                (secs > 0.0).then(|| (p.ticks as f64 - before as f64).max(0.0) / CLOCK_TICKS / secs / cores)
            });
            ProcessOut {
                pid: p.pid,
                name: p.name.clone(),
                command: p.command.clone(),
                service: p.group.as_deref().and_then(|g| service_of_group(g, &names)),
                rss_bytes: p.rss_bytes,
                cpu,
            }
        })
        .collect();

    let mut by_memory = with_cpu.clone();
    by_memory.sort_by_key(|p| std::cmp::Reverse(p.rss_bytes));
    let mut by_cpu = with_cpu;
    by_cpu.sort_by(|a, b| b.cpu.unwrap_or(0.0).total_cmp(&a.cpu.unwrap_or(0.0)));
    let mut seen = HashSet::new();
    let processes = by_memory
        .into_iter()
        .take(LIST_LENGTH)
        .chain(by_cpu.into_iter().take(LIST_LENGTH))
        .filter(|p| seen.insert(p.pid))
        .collect();

    Ok(Json(ProcessesOut {
        processes,
        count: list.len(),
        at: now_ms(),
    }))
}

//! Assistant tools: what a model with `tools` can look at to answer questions about the server. All
//! of them only read. Each returns plain text, short enough for a small model's context.

use serde_json::{Value, json};

use crate::actions::{LogWindow, read_logs};
use crate::history::{DAY_MS, between};
use crate::http::State;
use crate::localtime::{clock, day_time, parse, span, tool_time};
use crate::usage::now_ms;

/// Rounds of tool calls before the model has to answer with what it has.
pub const TOOL_ROUNDS: usize = 4;
/// Room for everything the tools return in one answer (characters).
pub const TOOL_RESULTS_CHARS: usize = 14_000;
const TOOL_RESULT_CHARS: usize = 5000;
const TOOL_LOG_LINES: u32 = 60;
const TOOL_LOG_LINE_CHARS: usize = 300;
const TOOL_HISTORY_POINTS: usize = 12;
const GIB: f64 = 1024.0 * 1024.0 * 1024.0;

fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "function",
        "function": { "name": name, "description": description, "parameters": { "type": "object", "properties": properties, "required": required } },
    })
}

/// The tools, as the model is told about them.
pub fn definitions() -> Value {
    let when = json!({ "type": "string", "description": "Local time, like 2026-10-22 23:00" });
    let service = json!({ "type": "string", "description": "A service name, like sonarr or jellyfin" });
    json!([
        tool(
            "server_now",
            "What the server is doing right now: CPU, memory, temperatures, disk space, and each service with its state and usage.",
            json!({}),
            &[]
        ),
        tool(
            "server_history",
            "How busy the server was over a stretch of time: CPU, GPU, memory, swap, stalls, temperatures, network and power, with the services using the most CPU and memory. Give a service to see just that one.",
            json!({ "from": when, "to": when, "service": service }),
            &["from", "to"],
        ),
        tool(
            "server_events",
            "What happened over a stretch of time: boots, services starting, stopping, crashing or failing, memory kills, problems like full disks or hot drives, and game mode.",
            json!({ "from": when, "to": when }),
            &["from", "to"],
        ),
        tool(
            "service_logs",
            "What a service wrote to its log, newest last. Defaults to its last lines; give a stretch of time to look at when something happened.",
            json!({
                "service": service,
                "from": when,
                "to": when,
                "problems_only": { "type": "boolean", "description": "Only lines mentioning errors, failures or warnings" },
            }),
            &["service"],
        ),
        tool(
            "reliability",
            "How each service held up over the last days: crashes, failures, memory kills, restarts, and how much of the time it was running.",
            json!({ "days": { "type": "number", "description": "How many days back, 1 to 365" } }),
            &["days"],
        ),
        tool(
            "drives",
            "Each drive with its SMART health, temperature, age, wear and what is reading or writing it now.",
            json!({}),
            &[]
        ),
    ])
}

/// JavaScript's `Math.round`, which rounds halves up.
fn round(v: f64) -> f64 {
    (v + 0.5).floor()
}

/// A number as JavaScript prints it: "NaN" for none, no ".0" for whole numbers.
fn js(v: f64) -> String {
    if v.is_nan() {
        "NaN".into()
    } else if v.fract() == 0.0 {
        format!("{}", v as i64)
    } else {
        v.to_string()
    }
}

fn pct(v: Option<f64>) -> String {
    format!("{}%", js(round(v.unwrap_or(f64::NAN) * 100.0)))
}
fn gb(v: f64) -> String {
    format!("{:.1} GB", v / GIB)
}
fn mbits(v: Option<f64>) -> String {
    format!("{:.1} Mb/s", v.unwrap_or(f64::NAN) * 8.0 / 1e6)
}
fn mbytes(v: f64) -> String {
    format!("{:.1} MB/s", v / 1e6)
}
fn degrees(v: f64) -> String {
    format!("{}°C", js(round(v)))
}
fn watts(v: f64) -> String {
    format!("{} W", js(round(v)))
}

/// The first `n` UTF-16 units, as JavaScript's `slice(0, n)` cuts a string.
pub fn js_slice(s: &str, n: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().collect();
    if units.len() <= n {
        s.to_owned()
    } else {
        String::from_utf16_lossy(&units[..n])
    }
}

fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn tool_time_of(value: &Value, name: &str) -> Result<i64, String> {
    value
        .as_str()
        .and_then(parse)
        .ok_or_else(|| format!("{name} should be a local time like {}", tool_time(now_ms())))
}

fn tool_range(args: &Value) -> Result<(i64, i64), String> {
    let from = tool_time_of(&args["from"], "from")?;
    let to = now_ms().min(tool_time_of(&args["to"], "to")?);
    if from >= to {
        return Err("from must be before to, and in the past".into());
    }
    Ok((from, to))
}

/// The service a model named: by id, name, or part of the name.
async fn find_service(state: &State, name: &Value) -> Result<(String, String), String> {
    let mut list = state.recorder.names.lock().unwrap().clone();
    if list.is_empty() {
        list = crate::services::list(&state.services, &state.usage)
            .await
            .map_err(|e| e.1)?
            .into_iter()
            .map(|s| (s.id, s.name))
            .collect();
    }
    let raw = match name {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        v => v.to_string(),
    };
    let want = raw.trim().to_lowercase();
    let found = list
        .iter()
        .find(|(id, n)| id.to_lowercase() == want || n.to_lowercase() == want)
        .or_else(|| {
            list.iter()
                .find(|(id, n)| n.to_lowercase().contains(&want) || id.to_lowercase().contains(&want))
        });
    match found {
        Some(f) if !want.is_empty() => Ok(f.clone()),
        _ => Err(format!(
            "No service called \"{raw}\". There are: {}",
            list.iter().map(|(_, n)| n.as_str()).collect::<Vec<_>>().join(", ")
        )),
    }
}

type Format = fn(f64) -> String;

/// System series the history tool reports, with how to show their values.
const TOOL_SERIES: &[(&str, &str, Format)] = &[
    ("CPU", "cpu", |v| pct(Some(v))),
    ("GPU", "gpu", |v| pct(Some(v))),
    ("Memory used", "mem", gb),
    ("Swap used", "swap", gb),
    ("Time stalled waiting for CPU", "pcpu", |v| pct(Some(v))),
    ("Time stalled waiting for memory", "pmem", |v| pct(Some(v))),
    ("Time stalled waiting for disk", "pio", |v| pct(Some(v))),
    ("CPU temperature", "temp", degrees),
    ("GPU temperature", "gtemp", degrees),
    ("Download", "rx", |v| mbits(Some(v))),
    ("Upload", "tx", |v| mbits(Some(v))),
    ("CPU power", "cpow", watts),
    ("GPU power", "gpow", watts),
    ("Files being converted to HEVC", "conv", |v| format!("{v:.1}")),
];
const TOOL_SERVICE_SERIES: &[(&str, &str, Format)] = &[
    ("CPU (share of the whole machine)", "cpu", |v| pct(Some(v))),
    ("Memory", "mem", gb),
    ("Disk read", "r", mbytes),
    ("Disk write", "w", mbytes),
    ("Download", "rx", |v| mbits(Some(v))),
    ("Upload", "tx", |v| mbits(Some(v))),
];

fn history_text(state: &State, from: i64, to: i64, service: Option<&(String, String)>) -> String {
    let names: std::collections::HashMap<String, String> = state.recorder.names.lock().unwrap().iter().cloned().collect();
    let history = state.recorder.history.lock().unwrap();
    let entries = history.range(from, to, now_ms());
    if history.reading_count(&entries) == 0.0 {
        return "No readings in that stretch; the server may have been off.".into();
    }
    let series: Vec<(&str, String, Format)> = match service {
        Some((id, _)) => TOOL_SERVICE_SERIES
            .iter()
            .map(|(label, k, f)| (*label, format!("s:{id}:{k}"), *f))
            .collect(),
        None => TOOL_SERIES.iter().map(|(label, k, f)| (*label, (*k).to_owned(), *f)).collect(),
    };
    let keys: Vec<(&str, String)> = series.iter().map(|(label, key, _)| (*label, key.clone())).collect();
    let summary = history.summarize(&entries, &keys, from, to, TOOL_HISTORY_POINTS);
    let step = (to - from) as f64 / TOOL_HISTORY_POINTS as f64;
    let stamp = |t: i64| if to - from > DAY_MS { day_time(t) } else { clock(t) };
    let mut out = vec![format!(
        "{}, {} to {}, in {TOOL_HISTORY_POINTS} steps from {}, {} min each (- = no reading):",
        service.map_or("Whole server", |(_, n)| n.as_str()),
        day_time(from),
        day_time(to),
        stamp(from),
        js(round(step / 60_000.0))
    )];
    for (label, _, format) in &series {
        let s = &summary[*label];
        let Some(average) = s["average"].as_f64() else { continue };
        let peak = s["peak"].as_f64().unwrap_or(f64::NAN);
        let values: Vec<String> = s["values"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|v| v.as_f64().map_or("-".into(), format))
            .collect();
        out.push(format!(
            "{label}: average {}, peak {}; {}",
            format(average),
            format(peak),
            values.join(", ")
        ));
    }
    if service.is_none() {
        for (label, suffix, format) in [("Most CPU", ":cpu", (|v| pct(Some(v))) as Format), ("Most memory", ":mem", gb)] {
            let totals = history.totals(&entries, |k| between(k, "s:", suffix));
            let mut top: Vec<_> = totals.into_iter().collect();
            top.sort_by(|a, b| b.1.average.total_cmp(&a.1.average));
            let listed: Vec<String> = top
                .iter()
                .take(5)
                .map(|(id, t)| format!("{} {}", names.get(id).unwrap_or(id), format(t.average)))
                .collect();
            out.push(format!("{label} (average while running): {}", listed.join(", ")));
        }
    }
    out.join("\n")
}

fn event_text(e: &crate::events::Event) -> String {
    let detail = |prefix: &str| e.detail.as_ref().map(|d| format!("{prefix}({d})")).unwrap_or_default();
    let what = match e.kind.as_str() {
        "game" => format!("Game mode {}{}", if e.on == Some(true) { "on" } else { "off" }, detail(" ")),
        "problem" => format!("Problem: {}", e.detail.as_deref().unwrap_or("undefined")),
        "resolved" => format!("Resolved: {}", e.detail.as_deref().unwrap_or("undefined")),
        "boot" => "Server booted".into(),
        "oom" => format!(
            "{} killed for running out of memory{}",
            e.name.as_deref().unwrap_or("undefined"),
            detail(" ")
        ),
        kind => format!(
            "{} {kind}{}{}",
            e.name.as_deref().or(e.id.as_deref()).unwrap_or("undefined"),
            e.by.as_ref().map(|b| format!(" by {b}")).unwrap_or_default(),
            detail(" ")
        ),
    };
    format!("{} {what}", day_time(e.t))
}

/// What a tool found, with the label the app shows for the step.
async fn run_tool(state: &State, name: &str, args: &Value) -> Result<(String, String), String> {
    match name {
        "server_now" => {
            let s = serde_json::to_value(crate::status::read(state).await.map_err(|e| e.1)?).unwrap_or_default();
            let f = |v: &Value| v.as_f64();
            let mem = &s["memory"];
            let load: Vec<String> = s["cpu"]["load"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|l| format!("{:.1}", l.as_f64().unwrap_or(0.0)))
                .collect();
            let mut lines = vec![
                format!(
                    "Up {} h. CPU {} (load {} on {} threads), GPU {}.",
                    js(round(f(&s["host"]["uptimeSec"]).unwrap_or(0.0) / 3600.0)),
                    pct(f(&s["cpu"]["usage"])),
                    load.join(" "),
                    s["cpu"]["cores"],
                    pct(f(&s["gpu"]["usage"]))
                ),
                format!(
                    "Memory {} used of {}, swap {} used.",
                    gb(f(&mem["totalBytes"]).unwrap_or(0.0) - f(&mem["availableBytes"]).unwrap_or(0.0)),
                    gb(f(&mem["totalBytes"]).unwrap_or(0.0)),
                    gb(f(&mem["swapTotalBytes"]).unwrap_or(0.0) - f(&mem["swapFreeBytes"]).unwrap_or(0.0))
                ),
                format!(
                    "Network: down {}, up {}.",
                    mbits(f(&s["network"]["rxPerSec"])),
                    mbits(f(&s["network"]["txPerSec"]))
                ),
                format!(
                    "Temperatures: {}.",
                    s["temperatures"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|t| format!(
                            "{} {}",
                            t["label"].as_str().unwrap_or_default(),
                            degrees(t["celsius"].as_f64().unwrap_or(0.0))
                        ))
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
                format!(
                    "Disks: {}.",
                    s["disks"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|d| {
                            let total = f(&d["totalBytes"]).unwrap_or(0.0);
                            format!(
                                "{} {} full, {} free",
                                d["mount"].as_str().unwrap_or_default(),
                                pct(Some(f(&d["usedBytes"]).unwrap_or(0.0) / total)),
                                gb(f(&d["availableBytes"]).unwrap_or(0.0))
                            )
                        })
                        .collect::<Vec<_>>()
                        .join("; ")
                ),
                format!(
                    "Game mode {}.",
                    if s["gameMode"]["on"] == true {
                        "on: the download stack is stopped"
                    } else {
                        "off"
                    }
                ),
                "Services:".into(),
            ];
            for x in s["services"].as_array().into_iter().flatten() {
                let state_name = x["state"].as_str().unwrap_or_default();
                let mut line = format!("- {}: {state_name}", x["name"].as_str().unwrap_or_default());
                if let Some(h) = x["health"].as_str() {
                    line += &format!(" ({h})");
                }
                if let Some(d) = x["detail"].as_str().filter(|d| !d.is_empty() && state_name == "failed") {
                    line += &format!(", {d}");
                }
                if x["usage"].is_object() {
                    line += &format!(
                        ", {} memory, {} CPU",
                        gb(f(&x["usage"]["usedBytes"]).unwrap_or(0.0)),
                        pct(f(&x["usage"]["cpu"]))
                    );
                }
                if let Some(since) = x["since"].as_i64().filter(|s| *s != 0 && state_name == "running") {
                    line += &format!(", since {}", day_time(since));
                }
                if let Some(r) = x["restarts"].as_u64().filter(|r| *r != 0) {
                    line += &format!(", restarted {r}×");
                }
                lines.push(line);
            }
            Ok(("Checked the server now".into(), lines.join("\n")))
        }
        "server_history" => {
            let (from, to) = tool_range(args)?;
            let service = if truthy(&args["service"]) {
                Some(find_service(state, &args["service"]).await?)
            } else {
                None
            };
            let label = format!(
                "{} usage, {}",
                service.as_ref().map_or("Server".to_owned(), |(_, n)| format!("{n}’s")),
                span(from, to)
            );
            Ok((label, history_text(state, from, to, service.as_ref())))
        }
        "server_events" => {
            let (from, to) = tool_range(args)?;
            let events = state.recorder.events.lock().unwrap();
            let list: Vec<_> = events.list.iter().filter(|e| e.t >= from && e.t <= to).collect();
            let shown = &list[list.len().saturating_sub(80)..];
            let text = if list.is_empty() {
                "Nothing happened in that stretch.".to_owned()
            } else {
                let mut lines = Vec::new();
                if list.len() > shown.len() {
                    lines.push(format!("{} earlier events left out.", list.len() - shown.len()));
                }
                lines.extend(shown.iter().map(|e| event_text(e)));
                lines.join("\n")
            };
            Ok((format!("Events, {}", span(from, to)), text))
        }
        "service_logs" => {
            let (id, name) = find_service(state, &args["service"]).await?;
            let range = if truthy(&args["from"]) || truthy(&args["to"]) {
                let from = if truthy(&args["from"]) {
                    args["from"].clone()
                } else {
                    json!(tool_time(now_ms() - DAY_MS))
                };
                let to = if truthy(&args["to"]) {
                    args["to"].clone()
                } else {
                    json!(tool_time(now_ms()))
                };
                Some(tool_range(&json!({ "from": from, "to": to }))?)
            } else {
                None
            };
            let errors = truthy(&args["problems_only"]);
            let window = LogWindow {
                after: None,
                errors,
                since: range.map(|r| r.0),
                until: range.map(|r| r.1),
                lines: TOOL_LOG_LINES,
            };
            let logs = read_logs(state, &id, window).await.map_err(|e| e.1)?;
            let stamp = |t: i64| {
                if range.is_some_and(|(f, to)| to - f <= DAY_MS) {
                    clock(t)
                } else {
                    day_time(t)
                }
            };
            let text = if logs.lines.is_empty() {
                format!(
                    "{name} logged nothing{}{}.",
                    if errors { " about problems" } else { "" },
                    if range.is_some() { " then" } else { "" }
                )
            } else {
                logs.lines
                    .iter()
                    .map(|l| {
                        let t = if js_len(&l.text) > TOOL_LOG_LINE_CHARS {
                            format!("{}…", js_slice(&l.text, TOOL_LOG_LINE_CHARS))
                        } else {
                            l.text.clone()
                        };
                        format!("{} {t}", stamp(l.at))
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            let label = format!(
                "{name}’s {}{}",
                if errors { "problems" } else { "log" },
                range.map(|(f, t)| format!(", {}", span(f, t))).unwrap_or_default()
            );
            Ok((label, text))
        }
        "reliability" => {
            let asked = crate::js::number(&args["days"]);
            let days = if asked.is_nan() || asked == 0.0 { 7.0 } else { asked }.clamp(1.0, 365.0);
            let r = {
                let names = state.recorder.names.lock().unwrap().clone();
                let history = state.recorder.history.lock().unwrap();
                let events = state.recorder.events.lock().unwrap();
                crate::events::reliability(&events, &history, &names, days * 86400.0, now_ms())
            };
            let start = r["start"].as_i64().unwrap_or(0);
            let oldest = r["oldest"].as_i64().unwrap_or(0);
            let covered = (now_ms() - start.max(oldest)) as f64 / DAY_MS as f64;
            let mut lines = Vec::new();
            if covered < days - 0.5 {
                lines.push(format!("Records only go back {covered:.1} days."));
            }
            let boots: Vec<String> = r["boots"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_i64)
                .map(day_time)
                .collect();
            lines.push(if boots.is_empty() {
                "The server didn’t reboot.".into()
            } else {
                format!("The server booted {} times: {}.", boots.len(), boots.join(", "))
            });
            for x in r["services"].as_array().into_iter().flatten() {
                let n = |k: &str| x[k].as_u64().unwrap_or(0);
                let trouble: Vec<String> = [
                    ("crashes", "crashes"),
                    ("failures", "failures"),
                    ("oomKills", "memory kills"),
                    ("restarts", "restarts"),
                    ("stops", "unexplained stops"),
                ]
                .iter()
                .filter(|(k, _)| n(k) != 0)
                .map(|(k, what)| format!("{} {what}", n(k)))
                .collect();
                lines.push(format!(
                    "- {}: running {} of the time{}{}",
                    x["name"].as_str().unwrap_or_default(),
                    x["running"].as_f64().map_or("?".into(), |v| pct(Some(v))),
                    if trouble.is_empty() {
                        String::new()
                    } else {
                        format!(", {}", trouble.join(", "))
                    },
                    x["lastTrouble"]
                        .as_i64()
                        .map(|t| format!(", last trouble {}", day_time(t)))
                        .unwrap_or_default()
                ));
            }
            lines.push(
                "Services that only start on demand (llama) or stop in game mode run less than all the time by design.".into(),
            );
            Ok((format!("Reliability over {} days", js(days)), lines.join("\n")))
        }
        "drives" => {
            let d = crate::machine::drives(axum::extract::State(state.clone()))
                .await
                .map_err(|e| e.1)?
                .0;
            let mut lines = Vec::new();
            if let Some(e) = d["error"].as_str() {
                lines.push(format!("Couldn't read SMART data: {e}"));
            }
            for drive in d["drives"].as_array().into_iter().flatten() {
                let m = &drive["smart"];
                let num = |v: &Value| v.as_f64().filter(|x| *x != 0.0);
                let mounts: Vec<&str> = drive["mounts"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
                let mut facts = vec![
                    format!(
                        "{}, {}",
                        drive["kind"].as_str().unwrap_or_default(),
                        gb(drive["sizeBytes"].as_f64().unwrap_or(f64::NAN))
                    ),
                    if mounts.is_empty() {
                        "not mounted".into()
                    } else {
                        format!("mounted at {}", mounts.join(", "))
                    },
                    format!("health {}", drive["health"].as_str().unwrap_or_default()),
                ];
                if let Some(t) = drive["temperature"].as_f64() {
                    facts.push(degrees(t));
                }
                if let Some(h) = m["powerOnHours"].as_f64() {
                    facts.push(format!("{:.1} years powered on", h / 8766.0));
                }
                if let Some(l) = m["lifeLeft"].as_f64() {
                    facts.push(format!("{} life left", pct(Some(l))));
                }
                for (key, what) in [
                    ("badSectors", "bad sectors"),
                    ("reallocated", "reallocated"),
                    ("pending", "pending sectors"),
                    ("cableErrors", "cable errors"),
                ] {
                    if let Some(v) = num(&m[key]) {
                        facts.push(format!("{} {what}", js(v)));
                    }
                }
                if let Some(t) = m["selfTest"].as_str().filter(|t| !t.is_empty()) {
                    facts.push(format!("last self-test {t}"));
                }
                if drive["activity"].is_object() {
                    let a = &drive["activity"];
                    facts.push(format!(
                        "now reading {}, writing {}, {} busy",
                        mbytes(a["readPerSec"].as_f64().unwrap_or(0.0)),
                        mbytes(a["writePerSec"].as_f64().unwrap_or(0.0)),
                        pct(a["busy"].as_f64())
                    ));
                }
                let issues: Vec<&str> = drive["issues"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|i| i["text"].as_str())
                    .collect();
                let users: Vec<&str> = drive["users"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|u| u["name"].as_str())
                    .collect();
                lines.push(format!(
                    "- {}: {}{}{}",
                    drive["model"].as_str().unwrap_or_default(),
                    facts.join(", "),
                    if issues.is_empty() {
                        String::new()
                    } else {
                        format!(". Issues: {}", issues.join("; "))
                    },
                    if users.is_empty() {
                        String::new()
                    } else {
                        format!(". Using it most: {}", users.join(", "))
                    }
                ));
            }
            Ok(("Checked the drives".into(), lines.join("\n")))
        }
        _ => Err(format!("There's no tool called {name}")),
    }
}

/// JavaScript's truthiness for a tool argument.
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// Runs one tool call; failures go back to the model as text, so it can try again or say so.
pub async fn use_tool(state: &State, name: &str, arguments: &str, room: usize) -> (String, String) {
    let args: Value = match serde_json::from_str(if arguments.is_empty() { "{}" } else { arguments }) {
        Ok(v) => v,
        Err(_) => return (format!("Tried {name}"), "Error: the arguments weren’t valid JSON.".into()),
    };
    let args = if args.is_null() { json!({}) } else { args };
    // Earlier calls used up the room set aside for results; more would crowd out the chat.
    if room < 500 {
        return (
            format!("Tried {}", name.replace('_', " ")),
            "Error: no room left for more results. Answer with what you have.".into(),
        );
    }
    match run_tool(state, name, &args).await {
        Ok((label, text)) => {
            let max = TOOL_RESULT_CHARS.min(room);
            let text = if js_len(&text) > max {
                format!("{}\n… (cut short)", js_slice(&text, max))
            } else {
                text
            };
            (label, text)
        }
        Err(e) => {
            eprintln!("Assistant tool {name} failed: {e}");
            (format!("Tried {}", name.replace('_', " ")), format!("Error: {e}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_read_like_the_node_server_wrote_them() {
        assert_eq!(pct(Some(0.123)), "12%");
        assert_eq!(pct(None), "NaN%");
        assert_eq!(gb(5.0 * GIB), "5.0 GB");
        assert_eq!(mbits(Some(125_000.0)), "1.0 Mb/s");
        assert_eq!(degrees(36.5), "37°C");
        assert_eq!(js_slice("héllo", 2), "hé");
    }
}

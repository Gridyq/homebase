//! Drives: model, health and temperature from udisks, which reads the drives' SMART data every
//! ten minutes and lets any user see it. Each drive is kept as the JSON the app gets, the Node
//! server's shape.

use std::time::Duration;

use serde_json::{Map, Value, json};

use crate::args;
use crate::command::run;
use crate::history::num;

pub const DRIVE_REFRESH_INTERVAL: Duration = Duration::from_secs(10 * 60);
/// Normalized SMART values for an SSD's remaining life, by attribute id.
const LIFE_ATTRIBUTES: [u64; 4] = [177, 231, 202, 233];

fn hot(kind: &str) -> f64 {
    match kind {
        "hdd" => 55.0,
        "ssd" => 70.0,
        _ => 75.0,
    }
}

pub struct Drive {
    pub id: String,
    pub model: String,
    /// The kernel's name for it, such as "sda".
    pub device: Option<String>,
    pub temperature: Option<f64>,
    pub issues: Vec<String>,
    pub json: Value,
}

async fn udisks_call(object: &str, iface: &str, method: &str, signature: Option<&str>) -> Result<Value, String> {
    let mut a = args!["--json=short", "call", "org.freedesktop.UDisks2", object, iface, method].to_vec();
    if let Some(sig) = signature {
        a.extend(args![sig, "0"]);
    }
    let out = run("busctl", &a, Duration::from_secs(20)).await?;
    let v: Value = serde_json::from_str(&out).map_err(|e| e.to_string())?;
    Ok(v["data"].clone())
}

/// D-Bus byte strings end in a NUL.
fn byte_string(v: &Value) -> String {
    let bytes: Vec<u8> = v
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_u64)
        .filter(|b| *b != 0)
        .map(|b| b as u8)
        .collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

fn prop<'a>(o: &'a Value, iface: &str, name: &str) -> Option<&'a Value> {
    o.get(format!("org.freedesktop.UDisks2.{iface}"))?.get(name)?.get("data")
}

fn kelvin(k: Option<f64>) -> Option<f64> {
    k.filter(|k| *k > 0.0).map(|k| ((k - 273.15) * 10.0 + 0.5).floor() / 10.0)
}

/// JavaScript's truthiness, for values udisks gives.
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn insert(map: &mut Map<String, Value>, key: &str, v: Option<f64>) {
    if let Some(v) = v {
        map.insert(key.into(), num(v));
    }
}

async fn read_drive(path: &str, o: &Value, blocks: &[(&String, &Value)]) -> Drive {
    let mine: Vec<_> = blocks
        .iter()
        .filter(|(_, b)| prop(b, "Block", "Drive").and_then(Value::as_str) == Some(path))
        .collect();
    // Encrypted volumes sit on a partition of the drive rather than on the drive itself.
    let backed: Vec<_> = blocks
        .iter()
        .filter(|(_, b)| {
            let backing = prop(b, "Block", "CryptoBackingDevice").and_then(Value::as_str);
            mine.iter().any(|(p, _)| Some(p.as_str()) == backing)
        })
        .collect();
    let whole = mine.iter().find(|(_, b)| b.get("org.freedesktop.UDisks2.Partition").is_none());
    let mut mounts: Vec<String> = mine
        .iter()
        .chain(backed.iter())
        .flat_map(|(_, b)| {
            prop(b, "Filesystem", "MountPoints")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        })
        .map(|m| byte_string(&m))
        .collect();
    mounts.sort();
    mounts.dedup();

    let rotation = prop(o, "Drive", "RotationRate").and_then(Value::as_i64);
    let nvme = o.get("org.freedesktop.UDisks2.NVMe.Controller").is_some();
    let ata = o.get("org.freedesktop.UDisks2.Drive.Ata").is_some();
    let kind = if nvme {
        "nvme"
    } else if rotation == Some(0) {
        "ssd"
    } else {
        "hdd"
    };
    let basename = |p: &str| p.rsplit('/').next().unwrap_or(p).to_owned();
    let id = prop(o, "Drive", "Serial")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map_or_else(|| basename(path), str::to_owned);
    let model = prop(o, "Drive", "Model")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or("Drive")
        .to_owned();
    let device = whole
        .and_then(|(_, b)| prop(b, "Block", "Device"))
        .map(|d| basename(&byte_string(d)));

    let mut drive = Map::new();
    drive.insert("id".into(), json!(id));
    drive.insert("model".into(), json!(model));
    drive.insert("kind".into(), json!(kind));
    insert(&mut drive, "rpm", rotation.filter(|r| *r > 0).map(|r| r as f64));
    if let Some(size) = prop(o, "Drive", "Size") {
        drive.insert("sizeBytes".into(), size.clone());
    }
    if let Some(d) = &device {
        drive.insert("device".into(), json!(d));
    }
    drive.insert("mounts".into(), json!(mounts));

    let mut issues: Vec<(&str, String)> = Vec::new();
    let mut temperature = None;
    let mut smart: Option<Map<String, Value>> = None;
    let f = |v: Option<&Value>| v.and_then(Value::as_f64);

    if nvme {
        let attrs = udisks_call(path, "org.freedesktop.UDisks2.NVMe.Controller", "SmartGetAttributes", Some("a{sv}"))
            .await
            .map(|d| d[0].clone())
            .unwrap_or_else(|_| json!({}));
        let a = |k: &str| attrs.get(k).and_then(|v| v["data"].as_f64());
        let warnings: Vec<String> = prop(o, "NVMe.Controller", "SmartCriticalWarning")
            .and_then(Value::as_array)
            .map(|w| w.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect())
            .unwrap_or_default();
        temperature = kelvin(f(prop(o, "NVMe.Controller", "SmartTemperature")));
        let mut s = Map::new();
        insert(
            &mut s,
            "updated",
            f(prop(o, "NVMe.Controller", "SmartUpdated"))
                .map(|t| t * 1000.0)
                .filter(|t| *t != 0.0),
        );
        insert(&mut s, "powerOnHours", f(prop(o, "NVMe.Controller", "SmartPowerOnHours")));
        insert(&mut s, "lifeLeft", a("percent_used").map(|p| (1.0 - p / 100.0).max(0.0)));
        insert(&mut s, "spare", a("avail_spare").map(|v| v / 100.0));
        insert(&mut s, "spareThreshold", a("spare_thresh").map(|v| v / 100.0));
        insert(&mut s, "readBytes", a("total_data_read"));
        insert(&mut s, "writtenBytes", a("total_data_written"));
        insert(&mut s, "powerCycles", a("power_cycles"));
        insert(&mut s, "unsafeShutdowns", a("unsafe_shutdowns"));
        insert(&mut s, "mediaErrors", a("media_errors"));
        insert(
            &mut s,
            "hotMinutes",
            Some(a("warning_temp_time").unwrap_or(0.0) + a("critical_temp_time").unwrap_or(0.0)),
        );
        if let Some(t) = prop(o, "NVMe.Controller", "SmartSelftestStatus").filter(|v| truthy(Some(v))) {
            s.insert("selfTest".into(), t.clone());
        }
        s.insert("warnings".into(), json!(warnings));
        for w in &warnings {
            issues.push(("failing", format!("The drive reports a critical warning: {}", w.replace('_', " "))));
        }
        if let (Some(spare), Some(threshold)) = (a("avail_spare"), a("spare_thresh"))
            && spare / 100.0 <= threshold / 100.0
        {
            issues.push(("failing", "Spare blocks are used up".into()));
        }
        if let Some(errors) = a("media_errors").filter(|e| *e != 0.0) {
            issues.push(("warning", format!("{} data errors", num(errors))));
        }
        smart = Some(s);
    } else if ata && truthy(prop(o, "Drive.Ata", "SmartSupported")) {
        let rows = udisks_call(path, "org.freedesktop.UDisks2.Drive.Ata", "SmartGetAttributes", Some("a{sv}"))
            .await
            .map(|d| d[0].clone())
            .unwrap_or_else(|_| json!([]));
        // [id, name, flags, value, worst, threshold, pretty, prettyUnit, expansion]
        let row = |id: u64| rows.as_array().and_then(|r| r.iter().find(|a| a[0].as_u64() == Some(id)));
        let pretty = |id: u64| row(id).and_then(|a| a[6].as_f64());
        let life = LIFE_ATTRIBUTES
            .iter()
            .filter_map(|id| row(*id))
            .find_map(|a| a[3].as_f64().filter(|v| *v > 0.0 && *v <= 100.0));
        let written = row(241)
            .filter(|a| matches!(a[7].as_i64(), Some(1 | 3)))
            .and_then(|a| a[6].as_f64());
        temperature = kelvin(f(prop(o, "Drive.Ata", "SmartTemperature")));
        let failing = truthy(prop(o, "Drive.Ata", "SmartFailing"));
        let count = |name: &str| f(prop(o, "Drive.Ata", name)).unwrap_or(0.0);
        let mut s = Map::new();
        insert(
            &mut s,
            "updated",
            f(prop(o, "Drive.Ata", "SmartUpdated")).map(|t| t * 1000.0).filter(|t| *t != 0.0),
        );
        insert(
            &mut s,
            "powerOnHours",
            Some((count("SmartPowerOnSeconds") / 3600.0 + 0.5).floor()).filter(|h| *h != 0.0),
        );
        s.insert("failing".into(), json!(failing));
        s.insert("failingAttributes".into(), num(count("SmartNumAttributesFailing")));
        s.insert("failedInPast".into(), num(count("SmartNumAttributesFailedInThePast")));
        s.insert("badSectors".into(), num(count("SmartNumBadSectors")));
        insert(&mut s, "reallocated", pretty(5));
        insert(&mut s, "pending", pretty(197));
        insert(&mut s, "uncorrectable", pretty(198));
        insert(&mut s, "cableErrors", pretty(199));
        insert(&mut s, "powerCycles", pretty(12));
        insert(&mut s, "loadCycles", pretty(193).filter(|_| kind == "hdd"));
        insert(&mut s, "lifeLeft", life.filter(|_| kind == "ssd").map(|v| v / 100.0));
        // Total LBAs written counts 512-byte sectors on most drives.
        insert(&mut s, "writtenBytes", written.map(|w| w * 512.0));
        if let Some(t) = prop(o, "Drive.Ata", "SmartSelftestStatus").filter(|v| truthy(Some(v))) {
            s.insert("selfTest".into(), t.clone());
        }
        if failing {
            issues.push(("failing", "The drive says it is about to fail".into()));
        } else if count("SmartNumAttributesFailing") != 0.0 {
            issues.push((
                "failing",
                format!("{} health checks are failing", num(count("SmartNumAttributesFailing"))),
            ));
        }
        if count("SmartNumBadSectors") != 0.0 {
            issues.push(("warning", format!("{} bad sectors", num(count("SmartNumBadSectors")))));
        }
        if let Some(p) = pretty(197).filter(|p| *p != 0.0) {
            issues.push(("warning", format!("{} sectors waiting to be remapped", num(p))));
        }
        smart = Some(s);
    }
    if let Some(s) = &smart {
        if let Some(life) = s.get("lifeLeft").and_then(Value::as_f64).filter(|l| *l <= 0.1) {
            issues.push(("warning", format!("{}% of its life left", (life * 100.0 + 0.5).floor())));
        }
        if s.get("selfTest")
            .and_then(Value::as_str)
            .is_some_and(|t| t.starts_with("fatal") || t.starts_with("error"))
        {
            issues.push(("warning", "The last self-test failed".into()));
        }
    }
    if let Some(t) = temperature.filter(|t| *t >= hot(kind)) {
        issues.push(("warning", format!("Running hot at {}°C", (t + 0.5).floor())));
    }
    let health = if issues.iter().any(|(level, _)| *level == "failing") {
        "failing"
    } else if !issues.is_empty() {
        "warning"
    } else if smart.is_some() {
        "good"
    } else {
        "unknown"
    };
    if let Some(s) = smart {
        drive.insert("smart".into(), Value::Object(s));
    }
    drive.insert(
        "issues".into(),
        issues.iter().map(|(level, text)| json!({ "level": level, "text": text })).collect(),
    );
    insert(&mut drive, "temperature", temperature);
    drive.insert("health".into(), json!(health));
    Drive {
        id,
        model,
        device,
        temperature,
        issues: issues.into_iter().map(|(_, t)| t).collect(),
        json: Value::Object(drive),
    }
}

/// Every drive: the system drive first, then by where they're mounted.
pub async fn read_drives() -> Result<Vec<Drive>, String> {
    let data = udisks_call(
        "/org/freedesktop/UDisks2",
        "org.freedesktop.DBus.ObjectManager",
        "GetManagedObjects",
        None,
    )
    .await?;
    let objects = data[0].as_object().ok_or("udisks gave no objects")?;
    let list: Vec<(&String, &Value)> = objects.iter().collect();
    let blocks: Vec<(&String, &Value)> = list
        .iter()
        .filter(|(_, o)| o.get("org.freedesktop.UDisks2.Block").is_some())
        .copied()
        .collect();
    let mut drives = Vec::new();
    for (path, o) in list.iter().filter(|(_, o)| o.get("org.freedesktop.UDisks2.Drive").is_some()) {
        drives.push(read_drive(path, o, &blocks).await);
    }
    let mounts = |d: &Drive| d.json["mounts"].as_array().cloned().unwrap_or_default();
    let rank = |d: &Drive| {
        let m = mounts(d);
        if m.iter().any(|x| x == "/") {
            0
        } else if !m.is_empty() {
            1
        } else {
            2
        }
    };
    let label = |d: &Drive| {
        mounts(d)
            .first()
            .and_then(Value::as_str)
            .map_or_else(|| d.model.clone(), str::to_owned)
            .to_lowercase()
    };
    drives.sort_by(|a, b| rank(a).cmp(&rank(b)).then_with(|| label(a).cmp(&label(b))));
    Ok(drives)
}

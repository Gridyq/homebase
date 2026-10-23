//! History: a reading every 15 seconds, kept for a day, and averages of them kept longer: every
//! 10 minutes for a week, every hour for a month and every 6 hours for a year. Each tier is a file
//! with one JSON line per entry, appended as it's made and rewritten without the entries too old
//! to keep every few hours, so the disk isn't rewritten all the time. The format is the Node
//! server's, which wrote these files before.
//!
//! An entry is { t, n, a, m }: when it starts, how many readings it stands for (1 for a reading,
//! left out), the average of each key over them, and the peak of each machine-wide key (left out
//! for a reading, whose peak is its value). A key that's missing had no reading, like a service
//! that wasn't running. Keys:
//!   cpu gpu (share busy), mem cache swap vram (bytes), rx tx (bytes/s), temp gtemp (°C),
//!   cpow gpow (watts), clock (average core MHz), pcpu pmem pio (share of time stalled),
//!   conv (files being converted to HEVC),
//!   d:<drive>:r|w (bytes/s), d:<drive>:busy (share), d:<drive>:temp (°C),
//!   s:<service>:mem (bytes), s:<service>:cpu (share), s:<service>:r|w|rx|tx (bytes/s),
//!   t:<device>:rx|tx (bytes/s, as the server sees it: rx came from the device).

use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

pub const HISTORY_INTERVAL_MS: i64 = 15_000;
pub const HISTORY_POINTS: usize = 120;
pub const DAY_MS: i64 = 24 * 3_600_000;
pub const HISTORY_MAX_MS: i64 = 366 * DAY_MS;

/// A JSON number as JavaScript writes it: whole numbers without ".0".
pub fn num(v: f64) -> Value {
    if v.fract() == 0.0 && v.abs() < 9e15 {
        Value::from(v as i64)
    } else {
        serde_json::Number::from_f64(v).map_or(Value::Null, Value::Number)
    }
}

/// Whole numbers from 100 up, three decimals below.
pub fn trim(v: f64) -> f64 {
    // JavaScript's Math.round rounds halves up, toward +∞.
    let round = |x: f64| (x + 0.5).floor();
    if v.abs() >= 100.0 { round(v) } else { round(v * 1000.0) / 1000.0 }
}

/// Peaks are kept for these, not for every service, drive and device, to keep the files small.
fn is_machine_key(key: &str) -> bool {
    !key.contains(':')
}

/// Key names, stored once; entries refer to them by number.
#[derive(Default)]
pub struct Keys {
    names: Vec<String>,
    ids: HashMap<String, u32>,
}

impl Keys {
    pub fn id(&mut self, name: &str) -> u32 {
        if let Some(&id) = self.ids.get(name) {
            return id;
        }
        let id = self.names.len() as u32;
        self.names.push(name.to_owned());
        self.ids.insert(name.to_owned(), id);
        id
    }

    pub fn find(&self, name: &str) -> Option<u32> {
        self.ids.get(name).copied()
    }

    pub fn name(&self, id: u32) -> &str {
        &self.names[id as usize]
    }
}

pub struct Entry {
    pub t: i64,
    /// Readings it stands for.
    pub n: f64,
    pub a: Vec<(u32, f64)>,
    /// Peaks, for averages.
    pub m: Option<Vec<(u32, f64)>>,
}

impl Entry {
    pub fn get(&self, key: u32) -> Option<f64> {
        self.a.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
    }

    fn peak(&self, key: u32) -> Option<f64> {
        self.m.as_ref()?.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
    }

    fn to_json(&self, keys: &Keys) -> Value {
        let map = |pairs: &[(u32, f64)]| Value::Object(pairs.iter().map(|(k, v)| (keys.name(*k).to_owned(), num(*v))).collect());
        match &self.m {
            None => json!({ "t": self.t, "a": map(&self.a) }),
            Some(m) => json!({ "t": self.t, "n": num(self.n), "a": map(&self.a), "m": map(m) }),
        }
    }

    fn from_json(v: &Value, keys: &mut Keys) -> Option<Self> {
        let pairs = |v: Option<&Value>, keys: &mut Keys| -> Vec<(u32, f64)> {
            v.and_then(Value::as_object)
                .map(|o| o.iter().filter_map(|(k, v)| Some((keys.id(k), v.as_f64()?))).collect())
                .unwrap_or_default()
        };
        Some(Self {
            t: v.get("t")?.as_f64()? as i64,
            n: v.get("n").and_then(Value::as_f64).unwrap_or(1.0),
            a: pairs(v.get("a"), keys),
            m: v.get("m").map(|m| pairs(Some(m), keys)),
        })
    }
}

/// A tier's average in the making.
struct Pending {
    t: i64,
    n: f64,
    sum: Vec<(u32, f64, f64)>,
    peak: Vec<(u32, f64)>,
}

pub struct Tier {
    pub name: &'static str,
    pub step: i64,
    pub keep: i64,
    path: PathBuf,
    pub entries: VecDeque<Entry>,
    pending: Option<Pending>,
}

pub fn read_json_lines(file: &Path) -> Vec<Value> {
    std::fs::read_to_string(file)
        .unwrap_or_default()
        .lines()
        .filter(|l| !l.is_empty())
        // A line cut short when the server stopped.
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

pub fn write_json_lines(file: &Path, lines: impl Iterator<Item = Value>) -> std::io::Result<()> {
    let tmp = file.with_extension("jsonl.tmp");
    let mut out = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)?;
    let mut text = String::new();
    for line in lines {
        text.push_str(&line.to_string());
        text.push('\n');
    }
    out.write_all(text.as_bytes())?;
    std::fs::rename(tmp, file)
}

pub fn append_json_line(file: &Path, line: &Value) -> std::io::Result<()> {
    let mut out = std::fs::OpenOptions::new().append(true).create(true).mode(0o600).open(file)?;
    out.write_all(format!("{line}\n").as_bytes())
}

pub struct History {
    pub keys: Keys,
    pub tiers: Vec<Tier>,
}

impl History {
    pub fn new(dir: &Path) -> Self {
        let tier = |name, step, keep| Tier {
            name,
            step,
            keep,
            path: dir.join(format!("history-{name}.jsonl")),
            entries: VecDeque::new(),
            pending: None,
        };
        Self {
            keys: Keys::default(),
            tiers: vec![
                tier("raw", HISTORY_INTERVAL_MS, DAY_MS),
                tier("10m", 10 * 60_000, 7 * DAY_MS),
                tier("1h", 3_600_000, 31 * DAY_MS),
                tier("6h", 6 * 3_600_000, HISTORY_MAX_MS),
            ],
        }
    }

    pub fn load(&mut self, now: i64) {
        for i in 0..self.tiers.len() {
            // A line at a time, so the whole file is never held as JSON values at once.
            let text = std::fs::read_to_string(&self.tiers[i].path).unwrap_or_default();
            let keep = self.tiers[i].keep;
            let mut lines = 0;
            let mut entries = VecDeque::new();
            for line in text.lines().filter(|l| !l.is_empty()) {
                // A line cut short when the server stopped is skipped.
                let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
                lines += 1;
                if let Some(e) = Entry::from_json(&v, &mut self.keys).filter(|e| e.t > now - keep) {
                    entries.push_back(e);
                }
            }
            let dropped = entries.len() < lines;
            self.tiers[i].entries = entries;
            if dropped {
                self.rewrite(i);
            }
        }
        // The averages being made when the server last stopped, from the readings since the last
        // one saved.
        for i in 1..self.tiers.len() {
            let after = self.tiers[i].entries.back().map_or(0, |e| e.t + self.tiers[i].step);
            let below: Vec<usize> = (0..self.tiers[i - 1].entries.len())
                .filter(|&j| self.tiers[i - 1].entries[j].t >= after)
                .collect();
            for j in below {
                let e = &self.tiers[i - 1].entries[j];
                let entry = Entry {
                    t: e.t,
                    n: e.n,
                    a: e.a.clone(),
                    m: e.m.clone(),
                };
                self.feed(i, &entry, false);
            }
        }
    }

    fn rewrite(&self, i: usize) {
        let tier = &self.tiers[i];
        if let Err(e) = write_json_lines(&tier.path, tier.entries.iter().map(|e| e.to_json(&self.keys))) {
            eprintln!("Couldn't compact {} history: {e}", tier.name);
        }
    }

    fn append(&mut self, i: usize, entry: Entry) {
        let tier = &self.tiers[i];
        if let Err(e) = append_json_line(&tier.path, &entry.to_json(&self.keys)) {
            eprintln!("Couldn't save {} history: {e}", tier.name);
        }
        self.tiers[i].entries.push_back(entry);
    }

    /// Adds an entry of the tier below to tier `i`'s average in the making. When the entry belongs
    /// to a later step, the finished average is saved and, with `cascade`, passed up a tier in turn.
    fn feed(&mut self, i: usize, entry: &Entry, cascade: bool) {
        let step = self.tiers[i].step;
        let start = entry.t.div_euclid(step) * step;
        if self.tiers[i].pending.as_ref().is_some_and(|p| p.t != start) {
            let done = finish(self.tiers[i].pending.take().unwrap());
            let copy = Entry {
                t: done.t,
                n: done.n,
                a: done.a.clone(),
                m: done.m.clone(),
            };
            self.append(i, done);
            if cascade && i + 1 < self.tiers.len() {
                self.feed(i + 1, &copy, true);
            }
        }
        let keys = &self.keys;
        let p = self.tiers[i].pending.get_or_insert_with(|| Pending {
            t: start,
            n: 0.0,
            sum: Vec::new(),
            peak: Vec::new(),
        });
        let n = entry.n;
        p.n += n;
        for &(k, v) in &entry.a {
            match p.sum.iter_mut().find(|(key, _, _)| *key == k) {
                Some((_, sum, weight)) => {
                    *sum += v * n;
                    *weight += n;
                }
                None => p.sum.push((k, v * n, n)),
            }
            if is_machine_key(keys.name(k)) {
                let peak = entry.peak(k).unwrap_or(v);
                match p.peak.iter_mut().find(|(key, _)| *key == k) {
                    Some((_, was)) if *was >= peak => {}
                    Some((_, was)) => *was = peak,
                    None => p.peak.push((k, peak)),
                }
            }
        }
    }

    /// A new reading, by key name.
    pub fn record(&mut self, t: i64, values: Vec<(String, f64)>) {
        let a = values.into_iter().map(|(k, v)| (self.keys.id(&k), v)).collect();
        let entry = Entry { t, n: 1.0, a, m: None };
        let copy = Entry {
            t,
            n: 1.0,
            a: entry.a.clone(),
            m: None,
        };
        self.append(0, entry);
        self.feed(1, &copy, true);
        let keep = self.tiers[0].keep;
        while self.tiers[0].entries.front().is_some_and(|e| e.t < t - keep) {
            self.tiers[0].entries.pop_front();
        }
    }

    pub fn compact(&mut self, now: i64) {
        for i in 0..self.tiers.len() {
            let keep = self.tiers[i].keep;
            let before = self.tiers[i].entries.len();
            self.tiers[i].entries.retain(|e| e.t > now - keep);
            if self.tiers[i].entries.len() != before {
                self.rewrite(i);
            }
        }
    }

    /// The entries from `start`: the finest tier that reaches back that far, then the readings
    /// since its last entry.
    pub fn entries(&self, start: i64, now: i64) -> Vec<&Entry> {
        let tier = self
            .tiers
            .iter()
            .find(|t| t.keep >= now - start)
            .unwrap_or_else(|| self.tiers.last().unwrap());
        let raw = &self.tiers[0];
        if std::ptr::eq(tier, raw) {
            return raw.entries.iter().filter(|e| e.t >= start).collect();
        }
        let after = start.max(tier.entries.back().map_or(0, |e| e.t + tier.step));
        tier.entries
            .iter()
            .filter(|e| e.t >= start)
            .chain(raw.entries.iter().filter(|e| e.t >= after))
            .collect()
    }

    /// The oldest entry kept, in any tier.
    pub fn oldest(&self, end: i64) -> i64 {
        self.tiers
            .iter()
            .filter_map(|t| t.entries.front().map(|e| e.t))
            .filter(|t| *t != 0)
            .fold(end, i64::min)
    }

    /// Each of `keys` (name → key) over the entries, averaged into `points` evenly spaced buckets
    /// so the app gets as many points for an hour as for a year. A bucket without readings is null.
    /// Each also gets its average and peak over the whole range, and its total (value × seconds),
    /// which makes bytes of a rate and joules of watts.
    pub fn summarize(&self, entries: &[&Entry], series: &[(&str, String)], start: i64, end: i64, points: usize) -> Map<String, Value> {
        let step = (end - start) as f64 / points as f64;
        let mut out = Map::new();
        for (name, key) in series {
            let id = self.keys.find(key);
            let mut sums = vec![0.0; points];
            let mut weights = vec![0.0; points];
            let (mut sum, mut weight, mut peak) = (0.0, 0.0, None::<f64>);
            for e in entries {
                let Some(v) = id.and_then(|id| e.get(id)) else { continue };
                let i = (((e.t - start) as f64 / step).floor().max(0.0) as usize).min(points - 1);
                sums[i] += v * e.n;
                weights[i] += e.n;
                sum += v * e.n;
                weight += e.n;
                let p = id.and_then(|id| e.peak(id)).unwrap_or(v);
                if peak.is_none_or(|was| p > was) {
                    peak = Some(p);
                }
            }
            let mut s = Map::new();
            s.insert(
                "values".into(),
                sums.iter()
                    .zip(&weights)
                    .map(|(s, w)| if *w != 0.0 { num(s / w) } else { Value::Null })
                    .collect(),
            );
            if weight != 0.0 {
                s.insert("average".into(), num(sum / weight));
            }
            if let Some(p) = peak {
                s.insert("peak".into(), num(p));
            }
            s.insert("total".into(), num(sum * HISTORY_INTERVAL_MS as f64 / 1000.0));
            out.insert((*name).to_owned(), Value::Object(s));
        }
        out
    }

    /// Totals and averages of every key `name_of` names, without buckets.
    pub fn totals(&self, entries: &[&Entry], name_of: impl Fn(&str) -> Option<&str>) -> HashMap<String, Total> {
        let mut out: HashMap<String, Total> = HashMap::new();
        let mut names: HashMap<u32, Option<String>> = HashMap::new();
        for e in entries {
            for &(k, v) in &e.a {
                let name = names.entry(k).or_insert_with(|| name_of(self.keys.name(k)).map(str::to_owned));
                let Some(name) = name else { continue };
                let t = out.entry(name.clone()).or_default();
                t.sum += v * e.n;
                t.readings += e.n;
            }
        }
        for t in out.values_mut() {
            t.total = t.sum * HISTORY_INTERVAL_MS as f64 / 1000.0;
            t.average = t.sum / t.readings;
        }
        out
    }
}

#[derive(Default, Clone, Copy)]
pub struct Total {
    sum: f64,
    pub readings: f64,
    pub total: f64,
    pub average: f64,
}

/// How many readings the entries stand for, which `totals` readings can be compared with.
pub fn reading_count(entries: &[&Entry]) -> f64 {
    entries.iter().map(|e| e.n).sum()
}

/// The part of a key between its prefix and suffix, as in "s:" + id + ":mem".
pub fn between<'a>(key: &'a str, prefix: &str, suffix: &str) -> Option<&'a str> {
    key.strip_prefix(prefix)?.strip_suffix(suffix).filter(|s| !s.is_empty())
}

fn finish(p: Pending) -> Entry {
    Entry {
        t: p.t,
        n: p.n,
        a: p.sum.iter().map(|(k, sum, weight)| (*k, trim(sum / weight))).collect(),
        m: Some(p.peak.iter().map(|(k, v)| (*k, trim(*v))).collect()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("history-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn trims_like_javascript() {
        assert_eq!(trim(1234.5), 1235.0);
        assert_eq!(trim(0.12345), 0.123);
        assert_eq!(trim(0.0125), 0.013);
        assert_eq!(num(5.0).to_string(), "5");
        assert_eq!(num(0.5).to_string(), "0.5");
    }

    #[test]
    fn readings_roll_up_into_averages_and_survive_a_restart() {
        let d = dir("rollup");
        let start = 1_800_000_000_000 / 600_000 * 600_000;
        let mut h = History::new(&d);
        // 40 readings fill one 10-minute step; one more starts the next and finishes it.
        for i in 0..41 {
            let cpu = if i == 7 { 0.9 } else { 0.1 };
            h.record(
                start + i * HISTORY_INTERVAL_MS,
                vec![("cpu".into(), cpu), ("s:x:mem".into(), 100.0)],
            );
        }
        let ten = &h.tiers[1].entries;
        assert_eq!(ten.len(), 1);
        let cpu = h.keys.find("cpu").unwrap();
        assert_eq!(ten[0].n, 40.0);
        assert_eq!(ten[0].get(cpu), Some(trim((0.1 * 39.0 + 0.9) / 40.0)));
        assert_eq!(ten[0].peak(cpu), Some(0.9));
        assert_eq!(ten[0].peak(h.keys.find("s:x:mem").unwrap()), None, "no peaks for per-service keys");

        let line = std::fs::read_to_string(d.join("history-10m.jsonl")).unwrap();
        let v: Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(v["n"], json!(40));
        assert_eq!(v["m"]["cpu"], json!(0.9));
        assert_eq!(v["a"]["s:x:mem"], json!(100));

        // A restart rebuilds the 10-minute average in the making from the readings saved.
        let mut again = History::new(&d);
        again.load(start + 41 * HISTORY_INTERVAL_MS);
        assert_eq!(again.tiers[0].entries.len(), 41);
        assert_eq!(again.tiers[1].pending.as_ref().map(|p| p.n), Some(1.0));
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn summaries_bucket_and_total() {
        let d = dir("summary");
        let mut h = History::new(&d);
        let start = 1_800_000_000_000;
        for i in 0..4 {
            h.record(start + i * HISTORY_INTERVAL_MS, vec![("rx".into(), 1000.0 * (i + 1) as f64)]);
        }
        let entries = h.entries(start, start + 60_000);
        let s = h.summarize(&entries, &[("rx", "rx".into()), ("none", "nope".into())], start, start + 60_000, 2);
        assert_eq!(s["rx"]["values"], json!([1500, 3500]));
        assert_eq!(s["rx"]["average"], json!(2500));
        assert_eq!(s["rx"]["peak"], json!(4000));
        assert_eq!(s["rx"]["total"], json!(150_000));
        assert_eq!(s["none"], json!({ "values": [null, null], "total": 0 }));
        std::fs::remove_dir_all(d).unwrap();
    }
}

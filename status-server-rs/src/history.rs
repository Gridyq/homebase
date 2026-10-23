//! History: a reading every 15 seconds, kept for a day, and averages of them kept longer: every
//! 10 minutes for a week, every hour for a month and every 6 hours for a year. All four tiers live
//! in `history.db` (SQLite), one row per key per entry, so a screen asks for the keys it shows
//! over the range it shows and nothing else is read. Only the averages still being made are held
//! in memory; they're rebuilt from the tier below after a restart.
//!
//! An entry is when it starts, how many readings it stands for (1 for a reading), the average of
//! each key over them, and the peak of each machine-wide key (none for a reading, whose peak is its
//! value). A key that's missing had no reading, like a service that wasn't running. Keys:
//!   cpu gpu (share busy), mem cache swap vram (bytes), rx tx (bytes/s), temp gtemp (°C),
//!   cpow gpow (watts), clock (average core MHz), pcpu pmem pio (share of time stalled),
//!   conv (files being converted to HEVC), play tc (Jellyfin streams, and those transcoding),
//!   d:<drive>:r|w (bytes/s), d:<drive>:busy (share), d:<drive>:temp (°C),
//!   s:<service>:mem (bytes), s:<service>:cpu (share), s:<service>:r|w|rx|tx (bytes/s),
//!   t:<device>:rx|tx (bytes/s, as the server sees it: rx came from the device).
//!
//! Before 2026-10-23 the tiers were `history-<tier>.jsonl` files, one JSON line per entry
//! ({ t, n, a, m }); they're imported once and renamed to `.jsonl.old`.

use std::collections::HashMap;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value};

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

/// Peaks are kept for these, not for every service, drive and device, to keep the database small.
fn is_machine_key(key: &str) -> bool {
    !key.contains(':')
}

/// Key names, stored once; rows refer to them by number.
#[derive(Default)]
pub struct Keys {
    /// A map rather than a list: a key the database couldn't save gets an id far past the rest.
    names: HashMap<u32, String>,
    ids: HashMap<String, u32>,
}

impl Keys {
    fn add(&mut self, id: u32, name: String) {
        self.ids.insert(name.clone(), id);
        self.names.insert(id, name);
    }

    pub fn find(&self, name: &str) -> Option<u32> {
        self.ids.get(name).copied()
    }

    pub fn name(&self, id: u32) -> &str {
        self.names.get(&id).map_or("", String::as_str)
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
    #[cfg(test)]
    fn get(&self, key: u32) -> Option<f64> {
        self.a.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
    }

    fn peak(&self, key: u32) -> Option<f64> {
        self.m.as_ref()?.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
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
    pending: Option<Pending>,
}

/// Per key and bucket: key, bucket, sum of value × readings, readings, peak.
type Sums = (u32, i64, f64, f64, Option<f64>);

/// Where a range's entries are: the finest tier that reaches back far enough, then the readings
/// since its last entry. Each part is (tier, from, until), until exclusive.
pub struct Range {
    parts: Vec<(usize, i64, i64)>,
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
    let mut text = String::new();
    for line in lines {
        text.push_str(&line.to_string());
        text.push('\n');
    }
    crate::files::write_private(file, text.as_bytes())
}

pub fn append_json_line(file: &Path, line: &Value) -> std::io::Result<()> {
    let mut out = std::fs::OpenOptions::new().append(true).create(true).mode(0o600).open(file)?;
    out.write_all(format!("{line}\n").as_bytes())
}

const SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS keys (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
    -- One row per entry: how many readings it stands for.
    CREATE TABLE IF NOT EXISTS entries (
        tier INTEGER NOT NULL, t INTEGER NOT NULL, n REAL NOT NULL,
        PRIMARY KEY (tier, t)
    ) WITHOUT ROWID;
    -- One row per key per entry. n is the entry's, repeated so sums need no join.
    CREATE TABLE IF NOT EXISTS vals (
        tier INTEGER NOT NULL, key INTEGER NOT NULL, t INTEGER NOT NULL,
        n REAL NOT NULL, avg REAL NOT NULL, peak REAL,
        PRIMARY KEY (tier, key, t)
    ) WITHOUT ROWID;
";

pub struct History {
    dir: PathBuf,
    db: Connection,
    pub keys: Keys,
    pub tiers: Vec<Tier>,
}

impl History {
    pub fn new(dir: &Path) -> Self {
        Self::open(dir, &dir.join("history.db"))
    }

    fn open(dir: &Path, file: &Path) -> Self {
        let db = Connection::open(file)
            .or_else(|e| {
                eprintln!("Couldn't open {}: {e}; keeping history in memory", file.display());
                Connection::open_in_memory()
            })
            .expect("SQLite opens in memory");
        // Freed pages go back to the file system after a compaction; set before the first table.
        let setup = "PRAGMA auto_vacuum = INCREMENTAL; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;";
        if let Err(e) = db.execute_batch(setup).and_then(|_| db.execute_batch(SCHEMA)) {
            eprintln!("Couldn't set up {}: {e}", file.display());
        }
        let _ = std::fs::set_permissions(file, std::os::unix::fs::PermissionsExt::from_mode(0o600));
        let tier = |name, step, keep| Tier {
            name,
            step,
            keep,
            pending: None,
        };
        Self {
            dir: dir.to_owned(),
            db,
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
        self.import_json(now);
        let keys: Vec<(u32, String)> = self
            .db
            .prepare("SELECT id, name FROM keys")
            .and_then(|mut s| s.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect())
            .unwrap_or_default();
        for (id, name) in keys {
            self.keys.add(id, name);
        }
        self.compact(now);
        // The averages being made when the server last stopped, from the entries below them since
        // the last one saved.
        for i in 1..self.tiers.len() {
            let after = self.last_t(i).map_or(0, |t| t + self.tiers[i].step);
            for entry in self.entries_from(i - 1, after) {
                self.feed(i, &entry, false);
            }
        }
    }

    /// Moves the JSON-lines history the server kept before into the database, once.
    fn import_json(&mut self, now: i64) {
        let files: Vec<(usize, PathBuf)> = (0..self.tiers.len())
            .map(|i| (i, self.dir.join(format!("history-{}.jsonl", self.tiers[i].name))))
            .filter(|(_, f)| f.exists())
            .collect();
        if files.is_empty() {
            return;
        }
        println!("Moving the history into history.db");
        let mut names: HashMap<String, u32> = HashMap::new();
        let result = (|| -> rusqlite::Result<usize> {
            let tx = self.db.transaction()?;
            let mut count = 0;
            {
                let mut key = tx.prepare("INSERT OR IGNORE INTO keys (name) VALUES (?1)")?;
                let mut key_id = tx.prepare("SELECT id FROM keys WHERE name = ?1")?;
                let mut entry = tx.prepare("INSERT OR REPLACE INTO entries (tier, t, n) VALUES (?1, ?2, ?3)")?;
                let mut val = tx.prepare("INSERT OR REPLACE INTO vals (tier, key, t, n, avg, peak) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")?;
                for (i, file) in &files {
                    let keep = self.tiers[*i].keep;
                    // A line at a time, so the whole file is never held as JSON values at once.
                    let text = std::fs::read_to_string(file).unwrap_or_default();
                    for line in text.lines().filter(|l| !l.is_empty()) {
                        // A line cut short when the server stopped is skipped.
                        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
                        let Some(t) = v.get("t").and_then(Value::as_f64).map(|t| t as i64) else { continue };
                        if t <= now - keep {
                            continue;
                        }
                        let n = v.get("n").and_then(Value::as_f64).unwrap_or(1.0);
                        entry.execute(params![*i as i64, t, n])?;
                        let peaks = v.get("m").and_then(Value::as_object);
                        for (k, a) in v.get("a").and_then(Value::as_object).into_iter().flatten() {
                            let Some(a) = a.as_f64() else { continue };
                            let id = match names.get(k) {
                                Some(id) => *id,
                                None => {
                                    key.execute([k])?;
                                    let id: u32 = key_id.query_row([k], |r| r.get(0))?;
                                    names.insert(k.clone(), id);
                                    id
                                }
                            };
                            let peak = peaks.and_then(|m| m.get(k)).and_then(Value::as_f64);
                            val.execute(params![*i as i64, id, t, n, a, peak])?;
                        }
                        count += 1;
                    }
                }
            }
            tx.commit()?;
            Ok(count)
        })();
        match result {
            Ok(count) => {
                println!("Moved {count} history entries into history.db");
                for (_, file) in files {
                    if let Err(e) = std::fs::rename(&file, file.with_extension("jsonl.old")) {
                        eprintln!("Couldn't rename {}: {e}", file.display());
                    }
                }
            }
            Err(e) => eprintln!("Couldn't move the history into history.db: {e}"),
        }
    }

    fn key_id(&mut self, name: &str) -> u32 {
        if let Some(id) = self.keys.find(name) {
            return id;
        }
        let inserted = self
            .db
            .execute("INSERT OR IGNORE INTO keys (name) VALUES (?1)", [name])
            .and_then(|_| self.db.query_row("SELECT id FROM keys WHERE name = ?1", [name], |r| r.get(0)));
        let id = inserted.unwrap_or_else(|e| {
            eprintln!("Couldn't save history key {name}: {e}");
            // Kept in memory only; out of the way of the database's ids.
            u32::MAX / 2 + self.keys.ids.len() as u32
        });
        self.keys.add(id, name.to_owned());
        id
    }

    fn last_t(&self, tier: usize) -> Option<i64> {
        self.db
            .query_row("SELECT MAX(t) FROM entries WHERE tier = ?1", [tier as i64], |r| r.get(0))
            .optional()
            .ok()
            .flatten()
            .flatten()
    }

    /// A tier's entries from `from` on, with their values.
    fn entries_from(&self, tier: usize, from: i64) -> Vec<Entry> {
        let query = |db: &Connection| -> rusqlite::Result<Vec<Entry>> {
            let mut out: Vec<Entry> = db
                .prepare("SELECT t, n FROM entries WHERE tier = ?1 AND t >= ?2 ORDER BY t")?
                .query_map(params![tier as i64, from], |r| {
                    Ok(Entry {
                        t: r.get(0)?,
                        n: r.get(1)?,
                        a: Vec::new(),
                        m: (tier > 0).then(Vec::new),
                    })
                })?
                .collect::<rusqlite::Result<_>>()?;
            let index: HashMap<i64, usize> = out.iter().enumerate().map(|(i, e)| (e.t, i)).collect();
            let mut vals = db.prepare("SELECT t, key, avg, peak FROM vals WHERE tier = ?1 AND t >= ?2")?;
            let mut rows = vals.query(params![tier as i64, from])?;
            while let Some(r) = rows.next()? {
                let Some(&i) = index.get(&r.get::<_, i64>(0)?) else { continue };
                let key: u32 = r.get(1)?;
                out[i].a.push((key, r.get(2)?));
                if let (Some(m), Some(peak)) = (out[i].m.as_mut(), r.get::<_, Option<f64>>(3)?) {
                    m.push((key, peak));
                }
            }
            Ok(out)
        };
        query(&self.db).unwrap_or_else(|e| {
            eprintln!("Couldn't read {} history: {e}", self.tiers[tier].name);
            Vec::new()
        })
    }

    fn save(&self, tier: usize, entry: &Entry) {
        let result = (|| -> rusqlite::Result<()> {
            let tx = self.db.unchecked_transaction()?;
            tx.prepare_cached("INSERT OR REPLACE INTO entries (tier, t, n) VALUES (?1, ?2, ?3)")?
                .execute(params![tier as i64, entry.t, entry.n])?;
            let mut val = tx.prepare_cached("INSERT OR REPLACE INTO vals (tier, key, t, n, avg, peak) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")?;
            for &(k, v) in &entry.a {
                val.execute(params![tier as i64, k, entry.t, entry.n, v, entry.peak(k)])?;
            }
            drop(val);
            tx.commit()
        })();
        if let Err(e) = result {
            eprintln!("Couldn't save {} history: {e}", self.tiers[tier].name);
        }
    }

    /// Adds an entry of the tier below to tier `i`'s average in the making. When the entry belongs
    /// to a later step, the finished average is saved and, with `cascade`, passed up a tier in turn.
    fn feed(&mut self, i: usize, entry: &Entry, cascade: bool) {
        let step = self.tiers[i].step;
        let start = entry.t.div_euclid(step) * step;
        if self.tiers[i].pending.as_ref().is_some_and(|p| p.t != start) {
            let done = finish(self.tiers[i].pending.take().unwrap());
            self.save(i, &done);
            if cascade && i + 1 < self.tiers.len() {
                self.feed(i + 1, &done, true);
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
        let a = values.into_iter().map(|(k, v)| (self.key_id(&k), v)).collect();
        let entry = Entry { t, n: 1.0, a, m: None };
        self.save(0, &entry);
        self.feed(1, &entry, true);
    }

    /// Drops what's too old to keep and hands the space back.
    pub fn compact(&mut self, now: i64) {
        let result = (|| -> rusqlite::Result<()> {
            let tx = self.db.transaction()?;
            for (i, tier) in self.tiers.iter().enumerate() {
                let before = now - tier.keep;
                tx.execute("DELETE FROM entries WHERE tier = ?1 AND t <= ?2", params![i as i64, before])?;
                tx.execute("DELETE FROM vals WHERE tier = ?1 AND t <= ?2", params![i as i64, before])?;
            }
            tx.commit()?;
            self.db.execute_batch("PRAGMA incremental_vacuum; PRAGMA wal_checkpoint(TRUNCATE);")
        })();
        if let Err(e) = result {
            eprintln!("Couldn't compact the history: {e}");
        }
    }

    /// Where the entries from `start` to `end` are: the finest tier that reaches back to `start`,
    /// then the readings since its last entry.
    pub fn range(&self, start: i64, end: i64, now: i64) -> Range {
        let tier = self
            .tiers
            .iter()
            .position(|t| t.keep >= now - start)
            .unwrap_or(self.tiers.len() - 1);
        if tier == 0 {
            return Range {
                parts: vec![(0, start, end)],
            };
        }
        let after = start.max(self.last_t(tier).map_or(0, |t| t + self.tiers[tier].step));
        Range {
            parts: vec![(tier, start, end.min(after)), (0, after, end)],
        }
    }

    /// Sum of value × readings, readings, and peak per key over the range, for the keys given.
    fn sums(&self, range: &Range, keys: &[u32], bucket: Option<(i64, f64)>) -> rusqlite::Result<Vec<Sums>> {
        let mut out = Vec::new();
        if keys.is_empty() {
            return Ok(out);
        }
        let list = keys.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
        // Buckets from the start of the range, or one for the whole of it.
        let (origin, width) = bucket.unwrap_or((0, f64::INFINITY));
        let bucket_of = if width.is_finite() {
            format!("CAST((t - {origin}) / {width} AS INTEGER)")
        } else {
            "0".into()
        };
        let sql = format!(
            "SELECT key, {bucket_of} AS b, SUM(avg * n), SUM(n), MAX(COALESCE(peak, avg))
             FROM vals WHERE tier = ?1 AND t >= ?2 AND t < ?3 AND key IN ({list}) GROUP BY key, b"
        );
        let mut stmt = self.db.prepare(&sql)?;
        for &(tier, from, until) in &range.parts {
            if from >= until {
                continue;
            }
            let rows = stmt.query_map(params![tier as i64, from, until], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?;
            for row in rows {
                out.push(row?);
            }
        }
        Ok(out)
    }

    /// The oldest entry kept, in any tier.
    pub fn oldest(&self, end: i64) -> i64 {
        self.db
            .query_row("SELECT MIN(t) FROM entries WHERE t != 0", [], |r| r.get::<_, Option<i64>>(0))
            .ok()
            .flatten()
            .map_or(end, |t| t.min(end))
    }

    /// Each of `keys` (name → key) over the range, averaged into `points` evenly spaced buckets
    /// so the app gets as many points for an hour as for a year. A bucket without readings is null.
    /// Each also gets its average and peak over the whole range, and its total (value × seconds),
    /// which makes bytes of a rate and joules of watts.
    pub fn summarize(&self, range: &Range, series: &[(&str, String)], start: i64, end: i64, points: usize) -> Map<String, Value> {
        let step = (end - start) as f64 / points as f64;
        let ids: Vec<u32> = series.iter().filter_map(|(_, k)| self.keys.find(k)).collect();
        let rows = self.sums(range, &ids, Some((start, step))).unwrap_or_else(|e| {
            eprintln!("Couldn't read the history: {e}");
            Vec::new()
        });
        let mut out = Map::new();
        for (name, key) in series {
            let id = self.keys.find(key);
            let mut sums = vec![0.0; points];
            let mut weights = vec![0.0; points];
            let (mut sum, mut weight, mut peak) = (0.0, 0.0, None::<f64>);
            for &(_, b, s, w, p) in rows.iter().filter(|r| Some(r.0) == id) {
                let i = (b.max(0) as usize).min(points - 1);
                sums[i] += s;
                weights[i] += w;
                sum += s;
                weight += w;
                if let Some(p) = p
                    && peak.is_none_or(|was| p > was)
                {
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
    pub fn totals(&self, range: &Range, name_of: impl Fn(&str) -> Option<&str>) -> HashMap<String, Total> {
        let named: Vec<(u32, &str)> = self
            .keys
            .ids
            .iter()
            .filter_map(|(key, id)| Some((*id, name_of(key)?)))
            .collect();
        let ids: Vec<u32> = named.iter().map(|(id, _)| *id).collect();
        let rows = self.sums(range, &ids, None).unwrap_or_else(|e| {
            eprintln!("Couldn't read the history: {e}");
            Vec::new()
        });
        let names: HashMap<u32, &str> = named.into_iter().collect();
        let mut out: HashMap<String, Total> = HashMap::new();
        for (k, _, sum, readings, _) in rows {
            let Some(name) = names.get(&k) else { continue };
            let t = out.entry((*name).to_owned()).or_default();
            t.sum += sum;
            t.readings += readings;
        }
        for t in out.values_mut() {
            t.total = t.sum * HISTORY_INTERVAL_MS as f64 / 1000.0;
            t.average = t.sum / t.readings;
        }
        out
    }

    /// How many readings the range's entries stand for, which `totals` readings can be compared
    /// with.
    pub fn reading_count(&self, range: &Range) -> f64 {
        range
            .parts
            .iter()
            .filter(|(_, from, until)| from < until)
            .map(|&(tier, from, until)| {
                self.db
                    .query_row(
                        "SELECT COALESCE(SUM(n), 0) FROM entries WHERE tier = ?1 AND t >= ?2 AND t < ?3",
                        params![tier as i64, from, until],
                        |r| r.get::<_, f64>(0),
                    )
                    .unwrap_or(0.0)
            })
            .sum()
    }
}

#[derive(Default, Clone, Copy)]
pub struct Total {
    sum: f64,
    pub readings: f64,
    pub total: f64,
    pub average: f64,
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
    use serde_json::json;

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
        h.load(start);
        // 40 readings fill one 10-minute step; one more starts the next and finishes it.
        for i in 0..41 {
            let cpu = if i == 7 { 0.9 } else { 0.1 };
            h.record(
                start + i * HISTORY_INTERVAL_MS,
                vec![("cpu".into(), cpu), ("s:x:mem".into(), 100.0)],
            );
        }
        let ten = h.entries_from(1, 0);
        assert_eq!(ten.len(), 1);
        let cpu = h.keys.find("cpu").unwrap();
        assert_eq!(ten[0].n, 40.0);
        assert_eq!(ten[0].get(cpu), Some(trim((0.1 * 39.0 + 0.9) / 40.0)));
        assert_eq!(ten[0].peak(cpu), Some(0.9));
        assert_eq!(ten[0].peak(h.keys.find("s:x:mem").unwrap()), None, "no peaks for per-service keys");
        drop(h);

        // A restart rebuilds the 10-minute average in the making from the readings saved.
        let mut again = History::new(&d);
        again.load(start + 41 * HISTORY_INTERVAL_MS);
        assert_eq!(again.entries_from(0, 0).len(), 41);
        assert_eq!(again.tiers[1].pending.as_ref().map(|p| p.n), Some(1.0));
        assert_eq!(again.keys.find("cpu"), Some(cpu));
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn summaries_bucket_and_total() {
        let d = dir("summary");
        let mut h = History::new(&d);
        let start = 1_800_000_000_000;
        h.load(start);
        for i in 0..4 {
            h.record(start + i * HISTORY_INTERVAL_MS, vec![("rx".into(), 1000.0 * (i + 1) as f64)]);
        }
        let range = h.range(start, start + 60_000, start + 60_000);
        let s = h.summarize(&range, &[("rx", "rx".into()), ("none", "nope".into())], start, start + 60_000, 2);
        assert_eq!(s["rx"]["values"], json!([1500, 3500]));
        assert_eq!(s["rx"]["average"], json!(2500));
        assert_eq!(s["rx"]["peak"], json!(4000));
        assert_eq!(s["rx"]["total"], json!(150_000));
        assert_eq!(s["none"], json!({ "values": [null, null], "total": 0 }));
        assert_eq!(h.reading_count(&range), 4.0);
        let totals = h.totals(&range, |k| (k == "rx").then_some("all"));
        assert_eq!(totals["all"].average, 2500.0);
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn longer_ranges_use_averages_then_the_latest_readings() {
        let d = dir("tiers");
        let mut h = History::new(&d);
        let start = 1_800_000_000_000 / 600_000 * 600_000;
        h.load(start);
        // 25 minutes: two finished 10-minute averages and the readings since.
        for i in 0..100 {
            h.record(start + i * HISTORY_INTERVAL_MS, vec![("cpu".into(), 0.5)]);
        }
        let now = start + 100 * HISTORY_INTERVAL_MS;
        let range = h.range(now - 2 * DAY_MS, now, now);
        assert_eq!(range.parts[0].0, 1);
        assert_eq!(h.reading_count(&range), 100.0);
        let s = h.summarize(&range, &[("cpu", "cpu".into())], now - 2 * DAY_MS, now, 4);
        assert_eq!(s["cpu"]["average"], json!(0.5));
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn json_lines_are_imported_once() {
        let d = dir("import");
        let now = 1_800_000_000_000;
        std::fs::write(
            d.join("history-raw.jsonl"),
            format!(
                "{}\n{}\n{{\"t\":1,\"a\"\n",
                json!({ "t": now - 30_000, "a": { "cpu": 0.25, "s:x:mem": 10 } }),
                json!({ "t": now - 15_000, "a": { "cpu": 0.75 } })
            ),
        )
        .unwrap();
        std::fs::write(
            d.join("history-1h.jsonl"),
            format!("{}\n", json!({ "t": now - 5 * DAY_MS, "n": 240, "a": { "cpu": 0.5 }, "m": { "cpu": 0.9 } })),
        )
        .unwrap();
        let mut h = History::new(&d);
        h.load(now);
        assert!(d.join("history-raw.jsonl.old").exists() && !d.join("history-raw.jsonl").exists());
        let range = h.range(now - 60_000, now, now);
        let s = h.summarize(&range, &[("cpu", "cpu".into())], now - 60_000, now, 1);
        assert_eq!(s["cpu"]["average"], json!(0.5));
        let month = h.range(now - 20 * DAY_MS, now, now);
        let s = h.summarize(&month, &[("cpu", "cpu".into())], now - 20 * DAY_MS, now, 1);
        assert_eq!(s["cpu"]["peak"], json!(0.9));
        assert_eq!(h.oldest(now), now - 5 * DAY_MS);
        std::fs::remove_dir_all(d).unwrap();
    }
}

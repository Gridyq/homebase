//! Reading /proc and /sys, whose files the kernel makes on the spot from memory, so they're read
//! synchronously (inside `spawn_blocking`) rather than one async round trip per tiny file.

use std::fs;
use std::path::Path;

/// A file's text, with bytes that aren't UTF-8 (a process can name itself anything) replaced,
/// as Node's `readFile(f, 'utf8')` does. `None` when it can't be read, as for a process that
/// exited or belongs to someone else.
pub fn read(path: impl AsRef<Path>) -> Option<String> {
    fs::read(path).ok().map(|b| String::from_utf8_lossy(&b).into_owned())
}

pub fn read_trimmed(path: impl AsRef<Path>) -> Option<String> {
    read(path).map(|t| t.trim().to_owned())
}

/// A number file, such as `gpu_busy_percent`. Like the Node server's `readNumber`, a file that
/// reads but doesn't hold a number gives NaN, which becomes `null` in JSON, not a missing field.
pub fn read_number(path: impl AsRef<Path>) -> Option<f64> {
    let text = read(path)?;
    let text = text.trim();
    Some(if text.is_empty() { 0.0 } else { text.parse().unwrap_or(f64::NAN) })
}

/// Names in a directory, in the order the kernel lists them; none when it can't be read.
pub fn names(dir: impl AsRef<Path>) -> Vec<String> {
    fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .collect()
}

/// Process ids, from /proc.
pub fn pids() -> Vec<String> {
    names("/proc")
        .into_iter()
        .filter(|n| n.bytes().all(|b| b.is_ascii_digit()))
        .collect()
}

/// The cgroup a process is in, relative to the cgroup root.
pub fn cgroup_of(cgroup_file: &str) -> Option<&str> {
    cgroup_file.lines().find_map(|l| l.strip_prefix("0::/"))
}

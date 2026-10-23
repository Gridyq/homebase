//! Files only this user may read, as the Node server wrote them (mode 0600).

use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use serde::de::DeserializeOwned;

/// A module's saved state, as JSON in one file.
pub struct JsonFile {
    path: PathBuf,
    /// What it holds, for the log: "Couldn't save {what}".
    what: &'static str,
}

impl JsonFile {
    pub fn new(path: PathBuf, what: &'static str) -> Self {
        Self { path, what }
    }

    /// What was saved: none when there's no file yet, or (logged) when it can't be read.
    pub fn load<T: DeserializeOwned>(&self) -> Option<T> {
        self.read().unwrap_or_else(|e| {
            eprintln!("Couldn't read {}: {e}", self.path.display());
            None
        })
    }

    /// Like `load`, but tells a missing file (`Ok(None)`) from one that can't be read.
    pub fn read<T: DeserializeOwned>(&self) -> Result<Option<T>, String> {
        match std::fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|e| e.to_string()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn save<T: Serialize + ?Sized>(&self, value: &T) {
        let result = serde_json::to_vec(value)
            .map_err(std::io::Error::other)
            .and_then(|bytes| write_private(&self.path, &bytes));
        if let Err(e) = result {
            eprintln!("Couldn't save {}: {e}", self.what);
        }
    }
}

/// Replaces `path` all at once: a crash mid-write leaves the old file, never a cut-short one.
pub fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    // Unique per writer, so two saves of the same file never share a temp file.
    let tmp = path.with_file_name(format!(".{name}.{}.{}.tmp", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed)));
    let result = (|| {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_the_file_and_leaves_no_temp() {
        let dir = std::env::temp_dir().join(format!("files-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.json");
        write_private(&path, b"one").unwrap();
        write_private(&path, b"two").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"two");
        let names: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, vec![std::ffi::OsString::from("state.json")]);
        let mode = std::fs::metadata(&path).unwrap().permissions();
        assert_eq!(std::os::unix::fs::PermissionsExt::mode(&mode) & 0o777, 0o600);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

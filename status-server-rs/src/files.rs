//! Files only this user may read, as the Node server wrote them (mode 0600).

use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

pub fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(bytes)
}

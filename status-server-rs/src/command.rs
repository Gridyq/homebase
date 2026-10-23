//! Running systemctl, podman and journalctl, with a time limit after which the program is killed,
//! like Node's `execFile` with `timeout`.

use std::time::Duration;

use tokio::process::Command;

pub struct Output {
    pub success: bool,
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

pub async fn output(program: &str, args: &[String], limit: Duration) -> Result<Output, String> {
    output_in(program, args, limit, None).await
}

/// Like `output`, run in `dir`.
pub async fn output_in(program: &str, args: &[String], limit: Duration, dir: Option<&std::path::Path>) -> Result<Output, String> {
    let mut command = Command::new(program);
    if let Some(dir) = dir {
        command.current_dir(dir);
    }
    let child = command.args(args).kill_on_drop(true).output();
    let out = tokio::time::timeout(limit, child)
        .await
        .map_err(|_| format!("{program} took longer than {}s", limit.as_secs()))?
        .map_err(|e| format!("Couldn't run {program}: {e}"))?;
    Ok(Output {
        success: out.status.success(),
        code: out.status.code(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).trim().to_owned(),
    })
}

/// Its output, or what it said went wrong.
pub async fn run(program: &str, args: &[String], limit: Duration) -> Result<String, String> {
    let out = output(program, args, limit).await?;
    if out.success {
        Ok(out.stdout)
    } else if out.stderr.is_empty() {
        Err(format!(
            "{program} failed ({})",
            out.code.map_or("killed".into(), |c| c.to_string())
        ))
    } else {
        Err(out.stderr)
    }
}

/// Owned arguments from string literals and formatted ones alike.
#[macro_export]
macro_rules! args {
    ($($a:expr),* $(,)?) => { [$(String::from($a)),*] };
}

//! One daemon per state directory. Port of `deploy/backup-daemon/src/instanceLock.ts`.
//!
//! Two daemons sharing a catalog, a job queue and a repository would run overlapping
//! `pg_basebackup`/`pg_ctl` processes and race on the same scratch directory, which the in-process
//! queue cannot prevent. The lock is a pid file: a live holder blocks a second start, a stale one
//! (crash, power loss) is taken over.
//!
//! Scope: this protects a state directory on ONE host. Two hosts pointed at the same S3 bucket are
//! not detected and remain unsupported.

use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::time::Duration;

use chrono::{DateTime, Utc};
use tokio::fs;
use tokio::io::AsyncWriteExt;

pub type CommandLineFuture =
    Pin<Box<dyn std::future::Future<Output = Option<String>> + Send + 'static>>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstanceLockError(pub String);

impl std::fmt::Display for InstanceLockError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for InstanceLockError {}

pub struct InstanceLockDeps {
    pub pid: i32,
    pub is_alive: Box<dyn Fn(i32) -> bool + Send + Sync>,
    /// Command line of a pid, to tell a recycled pid from our daemon. `None` when unknown.
    pub command_line: Box<dyn Fn(i32) -> CommandLineFuture + Send + Sync>,
    pub clock: Box<dyn Fn() -> DateTime<Utc> + Send + Sync>,
}

impl InstanceLockDeps {
    #[must_use]
    pub fn new() -> Self {
        Self {
            pid: std::process::id() as i32,
            is_alive: Box::new(default_is_alive),
            command_line: Box::new(|pid| Box::pin(default_command_line(pid))),
            clock: Box::new(Utc::now),
        }
    }

    #[must_use]
    pub fn with_pid(mut self, pid: i32) -> Self {
        self.pid = pid;
        self
    }

    #[must_use]
    pub fn with_alive(mut self, is_alive: impl Fn(i32) -> bool + Send + Sync + 'static) -> Self {
        self.is_alive = Box::new(is_alive);
        self
    }

    #[must_use]
    pub fn with_command_line(
        mut self,
        command_line: impl Fn(i32) -> Option<String> + Send + Sync + 'static,
    ) -> Self {
        let command_line = std::sync::Arc::new(command_line);
        self.command_line = Box::new(move |pid| {
            let command_line = std::sync::Arc::clone(&command_line);
            Box::pin(async move { command_line(pid) })
        });
        self
    }
}

impl Default for InstanceLockDeps {
    fn default() -> Self {
        Self::new()
    }
}

/// `/proc/<pid>` exists. `EPERM` cannot be distinguished without `kill(2)`, which the workspace's
/// dependency policy keeps out of this crate; a pid we cannot inspect reads as alive.
fn default_is_alive(pid: i32) -> bool {
    pid > 0 && Path::new(&format!("/proc/{pid}")).exists()
}

async fn default_command_line(pid: i32) -> Option<String> {
    fs::read_to_string(format!("/proc/{pid}/cmdline"))
        .await
        .ok()
        .map(|raw| raw.replace('\u{0}', " "))
}

pub struct HeldLock {
    pub path: PathBuf,
    pid: i32,
}

impl HeldLock {
    /// Only removes our own lock: after a takeover the file belongs to someone else.
    pub async fn release(&self) {
        if let Some(holder) = read_holder(&self.path).await {
            if holder.pid == Some(self.pid) {
                let _ = fs::remove_file(&self.path).await;
            }
        }
    }
}

struct Holder {
    raw: String,
    pid: Option<i32>,
    started_at: Option<String>,
}

async fn read_holder(path: &Path) -> Option<Holder> {
    let raw = fs::read_to_string(path).await.ok()?;
    let parsed: Option<serde_json::Value> = serde_json::from_str(&raw).ok();
    Some(Holder {
        pid: parsed
            .as_ref()
            .and_then(|value| value.get("pid"))
            .and_then(serde_json::Value::as_i64)
            .map(|value| value as i32),
        started_at: parsed
            .as_ref()
            .and_then(|value| value.get("startedAt"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        raw,
    })
}

pub async fn acquire_instance_lock(
    path: &Path,
    deps: InstanceLockDeps,
) -> Result<HeldLock, InstanceLockError> {
    let pid = deps.pid;
    let now = (deps.clock)().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await.map_err(|error| {
            InstanceLockError(format!("cannot create {}: {error}", parent.display()))
        })?;
    }
    let mine = serde_json::json!({"pid": pid, "startedAt": now}).to_string();

    // The lock must appear with its content already in it. Creating the file and writing afterwards
    // leaves a window in which a second starter reads an EMPTY file, calls it stale, deletes it, and
    // both end up "holding" the lock. So: write a private temp file, then link() it into place
    // (atomic, fails with EEXIST if the lock exists).
    let try_create = |pid: i32| {
        let path = path.to_path_buf();
        let mine = mine.clone();
        async move {
            let temp = path.with_file_name(format!(
                "{}.{pid}.{}.tmp",
                path.file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "daemon.lock".to_owned()),
                uuid::Uuid::new_v4()
            ));
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            let mut file = options.open(&temp).await.map_err(|error| {
                InstanceLockError(format!("cannot create {}: {error}", temp.display()))
            })?;
            if let Err(error) = file.write_all(mine.as_bytes()).await {
                let _ = fs::remove_file(&temp).await;
                return Err(InstanceLockError(format!(
                    "cannot write {}: {error}",
                    temp.display()
                )));
            }
            let _ = file.sync_all().await;
            drop(file);
            let linked = fs::hard_link(&temp, &path).await;
            let _ = fs::remove_file(&temp).await;
            match linked {
                Ok(()) => Ok(true),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
                Err(error) => Err(InstanceLockError(format!(
                    "cannot link {}: {error}",
                    path.display()
                ))),
            }
        }
    };

    for _attempt in 0..5 {
        if try_create(pid).await? {
            // Verify we really are the holder (a concurrent stale takeover may have replaced it).
            if read_holder(path).await.and_then(|holder| holder.pid) == Some(pid) {
                return Ok(HeldLock {
                    path: path.to_path_buf(),
                    pid,
                });
            }
            continue;
        }
        let holder = match read_holder(path).await {
            Some(holder) => holder,
            None => continue, // released between our attempts
        };
        if let Some(holder_pid) = holder.pid {
            if holder_pid != pid && (deps.is_alive)(holder_pid) {
                let command = (deps.command_line)(holder_pid).await;
                // A recycled pid belongs to some unrelated program: only a daemon/bun process counts
                // as a live holder.
                if command.as_deref().is_none_or(|line| {
                    line.contains("backup-daemon")
                        || line.contains("bun")
                        || line.contains("pg-backup")
                }) {
                    return Err(InstanceLockError(format!(
                        "another pg-backup-daemon (pid {holder_pid}, started {}) holds {}; \
                         two daemons on one state directory would run overlapping backups and drills",
                        holder.started_at.as_deref().unwrap_or("unknown"),
                        path.display()
                    )));
                }
            }
        }
        // Stale (dead holder, recycled pid, or genuinely corrupt content). Remove it ONLY if it is
        // still the very content we judged stale: if another starter already replaced it, that one
        // owns the lock now.
        let again = read_holder(path).await;
        if let Some(again) = again {
            if again.raw == holder.raw {
                fs::remove_file(path).await.map_err(|error| {
                    InstanceLockError(format!(
                        "cannot clear the stale lock {}: {error}",
                        path.display()
                    ))
                })?;
            }
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    Err(InstanceLockError(format!(
        "could not acquire {}",
        path.display()
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_live_holder_blocks_a_second_daemon() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("state").join("daemon.lock");
        let first = acquire_instance_lock(
            &path,
            InstanceLockDeps::new()
                .with_pid(1111)
                .with_alive(|_| true)
                .with_command_line(|_| Some("bun run src/index.ts".to_owned())),
        )
        .await
        .expect("first");
        let second = acquire_instance_lock(
            &path,
            InstanceLockDeps::new()
                .with_pid(2222)
                .with_alive(|pid| pid == 1111)
                .with_command_line(|_| Some("bun run src/index.ts".to_owned())),
        )
        .await;
        assert!(second.is_err());
        assert!(second.err().expect("error").0.contains("pid 1111"));
        first.release().await;
        assert!(!path.exists());
    }
}

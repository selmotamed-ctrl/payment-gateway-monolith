//! A JSON catalog with atomic replace-on-write semantics and an encrypted, HMAC-signed mirror.
//! Port of `deploy/backup-daemon/src/catalogStore.ts` and `src/catalogMirror.ts`.
//!
//! A corrupt or unwritable file never takes the daemon down: the store keeps functioning
//! in-memory and reports the persistence failure to the caller.

use std::collections::BTreeMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tokio::fs;

use crate::crypto::{open_to_buffer, seal_buffer, sign_text, verify_text_signature, SealOptions};
use crate::drill::DrillReport;
use crate::util::temp_sibling;

pub type CatalogFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
/// Warning callback (the TS `onWarning` option).
pub type WarningFn = Box<dyn Fn(&str) + Send + Sync>;

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

pub const BACKUP_TARGETS: [&str; 4] = ["all", "postgres_core", "audit_db", "redis"];
pub const BACKUP_KINDS: [&str; 2] = ["full", "delta"];
pub const RUN_STATUSES: [&str; 4] = ["QUEUED", "RUNNING", "PASSED", "FAILED"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupRun {
    pub id: String,
    pub target: String,
    pub kind: String,
    pub engine: String,
    pub status: String,
    pub started_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_lsn: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_lsn: Option<String>,
    pub storage_targets: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

impl BackupRun {
    fn is_valid(&self) -> bool {
        !self.id.is_empty()
            && BACKUP_TARGETS.contains(&self.target.as_str())
            && BACKUP_KINDS.contains(&self.kind.as_str())
            && crate::config::ENGINE_MODES.contains(&self.engine.as_str())
            && RUN_STATUSES.contains(&self.status.as_str())
            && !self.started_at.is_empty()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupPolicy {
    pub full_cron: String,
    pub delta_cron: String,
    pub drill_cron: String,
    pub full_retention_days: u32,
    pub wal_retention_days: u32,
    pub alert_lag_seconds: u32,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_by: Option<String>,
}

impl BackupPolicy {
    fn is_valid(&self) -> bool {
        !self.full_cron.is_empty()
            && !self.delta_cron.is_empty()
            && !self.drill_cron.is_empty()
            && self.full_retention_days >= 1
            && self.wal_retention_days >= 1
            && self.alert_lag_seconds >= 1
            && !self.updated_at.is_empty()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupCatalog {
    #[serde(default)]
    pub runs: Vec<BackupRun>,
    #[serde(default)]
    pub drills: Vec<DrillReport>,
    pub policy: BackupPolicy,
}

#[must_use]
pub fn create_default_policy() -> BackupPolicy {
    BackupPolicy {
        full_cron: "0 2 * * 0".to_owned(),
        delta_cron: "0 2 * * 1-6".to_owned(),
        drill_cron: "0 4 * * 0".to_owned(),
        full_retention_days: 56,
        wal_retention_days: 14,
        alert_lag_seconds: 300,
        updated_at: "1970-01-01T00:00:00.000Z".to_owned(),
        updated_by: None,
    }
}

// ---------------------------------------------------------------------------
// File system abstraction (the TS store accepts an injected fileSystem)
// ---------------------------------------------------------------------------

pub trait CatalogFileSystem: Send + Sync {
    fn read_file<'a>(&'a self, path: &'a Path) -> CatalogFuture<'a, std::io::Result<String>>;
    fn write_file<'a>(
        &'a self,
        path: &'a Path,
        data: &'a str,
    ) -> CatalogFuture<'a, std::io::Result<()>>;
    fn rename<'a>(
        &'a self,
        old_path: &'a Path,
        new_path: &'a Path,
    ) -> CatalogFuture<'a, std::io::Result<()>>;
    fn mkdir<'a>(&'a self, path: &'a Path) -> CatalogFuture<'a, std::io::Result<()>>;
    fn unlink<'a>(&'a self, path: &'a Path) -> CatalogFuture<'a, std::io::Result<()>>;
}

pub struct RealCatalogFileSystem;

impl CatalogFileSystem for RealCatalogFileSystem {
    fn read_file<'a>(&'a self, path: &'a Path) -> CatalogFuture<'a, std::io::Result<String>> {
        Box::pin(async move { fs::read_to_string(path).await })
    }

    fn write_file<'a>(
        &'a self,
        path: &'a Path,
        data: &'a str,
    ) -> CatalogFuture<'a, std::io::Result<()>> {
        Box::pin(async move { fs::write(path, data).await })
    }

    fn rename<'a>(
        &'a self,
        old_path: &'a Path,
        new_path: &'a Path,
    ) -> CatalogFuture<'a, std::io::Result<()>> {
        Box::pin(async move { fs::rename(old_path, new_path).await })
    }

    fn mkdir<'a>(&'a self, path: &'a Path) -> CatalogFuture<'a, std::io::Result<()>> {
        Box::pin(async move { fs::create_dir_all(path).await })
    }

    fn unlink<'a>(&'a self, path: &'a Path) -> CatalogFuture<'a, std::io::Result<()>> {
        Box::pin(async move { fs::remove_file(path).await })
    }
}

/// In-memory file system used by the ported test suite.
#[derive(Default)]
pub struct MemoryCatalogFileSystem {
    pub files: Mutex<BTreeMap<PathBuf, String>>,
    pub directories: Mutex<Vec<PathBuf>>,
}

impl CatalogFileSystem for MemoryCatalogFileSystem {
    fn read_file<'a>(&'a self, path: &'a Path) -> CatalogFuture<'a, std::io::Result<String>> {
        Box::pin(async move {
            self.files
                .lock()
                .ok()
                .and_then(|files| files.get(path).cloned())
                .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "ENOENT"))
        })
    }

    fn write_file<'a>(
        &'a self,
        path: &'a Path,
        data: &'a str,
    ) -> CatalogFuture<'a, std::io::Result<()>> {
        Box::pin(async move {
            if let Ok(mut files) = self.files.lock() {
                files.insert(path.to_path_buf(), data.to_owned());
            }
            Ok(())
        })
    }

    fn rename<'a>(
        &'a self,
        old_path: &'a Path,
        new_path: &'a Path,
    ) -> CatalogFuture<'a, std::io::Result<()>> {
        Box::pin(async move {
            let mut files = self
                .files
                .lock()
                .map_err(|_| std::io::Error::other("memory file system lock poisoned"))?;
            let value = files.remove(old_path).ok_or_else(|| {
                std::io::Error::other(format!("missing temporary file {}", old_path.display()))
            })?;
            files.insert(new_path.to_path_buf(), value);
            Ok(())
        })
    }

    fn mkdir<'a>(&'a self, path: &'a Path) -> CatalogFuture<'a, std::io::Result<()>> {
        Box::pin(async move {
            if let Ok(mut directories) = self.directories.lock() {
                directories.push(path.to_path_buf());
            }
            Ok(())
        })
    }

    fn unlink<'a>(&'a self, path: &'a Path) -> CatalogFuture<'a, std::io::Result<()>> {
        Box::pin(async move {
            if let Ok(mut files) = self.files.lock() {
                files.remove(path);
            }
            Ok(())
        })
    }
}

/// A read-only/unreadable file system (the TS `FailingCatalogFileSystem`).
pub struct FailingCatalogFileSystem;

impl CatalogFileSystem for FailingCatalogFileSystem {
    fn read_file<'a>(&'a self, path: &'a Path) -> CatalogFuture<'a, std::io::Result<String>> {
        Box::pin(async move {
            Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("ENOENT: {}", path.display()),
            ))
        })
    }

    fn write_file<'a>(
        &'a self,
        _path: &'a Path,
        _data: &'a str,
    ) -> CatalogFuture<'a, std::io::Result<()>> {
        Box::pin(async move {
            Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "EACCES: catalog is read-only",
            ))
        })
    }

    fn rename<'a>(
        &'a self,
        _old_path: &'a Path,
        _new_path: &'a Path,
    ) -> CatalogFuture<'a, std::io::Result<()>> {
        Box::pin(async move {
            Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "EACCES: catalog is read-only",
            ))
        })
    }

    fn mkdir<'a>(&'a self, _path: &'a Path) -> CatalogFuture<'a, std::io::Result<()>> {
        Box::pin(async { Ok(()) })
    }

    fn unlink<'a>(&'a self, _path: &'a Path) -> CatalogFuture<'a, std::io::Result<()>> {
        Box::pin(async { Ok(()) })
    }
}

// ---------------------------------------------------------------------------
// Catalog mirror
// ---------------------------------------------------------------------------

pub trait CatalogMirror: Send + Sync {
    fn upload<'a>(&'a self, catalog_json: &'a str) -> CatalogFuture<'a, Result<(), String>>;
    fn download<'a>(&'a self) -> CatalogFuture<'a, Result<Option<String>, String>>;
}

pub const CATALOG_KEY: &str = "catalog/catalog.json.enc";

/// Keeps an encrypted, HMAC-signed copy of `catalog.json` on every storage tier. If the backup host
/// is destroyed, a replacement daemon pointed at the same tiers recovers its history and policy here.
pub struct RepositoryCatalogMirror {
    repository: std::sync::Arc<crate::artifacts::ArtifactRepository>,
    master: Vec<u8>,
    staging_dir: PathBuf,
}

impl RepositoryCatalogMirror {
    #[must_use]
    pub fn new(
        repository: std::sync::Arc<crate::artifacts::ArtifactRepository>,
        master: Vec<u8>,
        staging_dir: impl Into<PathBuf>,
    ) -> Self {
        Self {
            repository,
            master,
            staging_dir: staging_dir.into(),
        }
    }
}

impl CatalogMirror for RepositoryCatalogMirror {
    fn upload<'a>(&'a self, catalog_json: &'a str) -> CatalogFuture<'a, Result<(), String>> {
        Box::pin(async move {
            fs::create_dir_all(&self.staging_dir)
                .await
                .map_err(|error| error.to_string())?;
            let signature =
                sign_text(catalog_json, &self.master).map_err(|error| error.to_string())?;
            let payload = serde_json::json!({"catalog": catalog_json, "signature": signature});
            let tmp = temp_sibling(&self.staging_dir.join("catalog.json.enc"));
            let options = SealOptions::new(&self.master, "catalog", "catalog.json");
            seal_buffer(payload.to_string().as_bytes(), &tmp, &options)
                .await
                .map_err(|error| error.to_string())?;
            let result = self
                .repository
                .put_file(CATALOG_KEY, &tmp, None)
                .await
                .map_err(|error| error.message);
            let _ = fs::remove_file(&tmp).await;
            result.map(|_| ())
        })
    }

    fn download<'a>(&'a self) -> CatalogFuture<'a, Result<Option<String>, String>> {
        Box::pin(async move {
            fs::create_dir_all(&self.staging_dir)
                .await
                .map_err(|error| error.to_string())?;
            for store in self.repository.stores() {
                if !matches!(store.exists(CATALOG_KEY).await, Ok(true)) {
                    continue;
                }
                let tmp =
                    temp_sibling(&self.staging_dir.join(format!("catalog-{}.enc", store.id())));
                let outcome = async {
                    store
                        .get_file(CATALOG_KEY, &tmp)
                        .await
                        .map_err(|error| error.to_string())?;
                    let plain = open_to_buffer(&tmp, &self.master, "catalog", "catalog.json", true)
                        .await
                        .map_err(|error| error.to_string())?;
                    let envelope: serde_json::Value =
                        serde_json::from_slice(&plain).map_err(|error| error.to_string())?;
                    let catalog = envelope
                        .get("catalog")
                        .and_then(serde_json::Value::as_str)
                        .ok_or_else(|| "catalog mirror has no catalog".to_owned())?;
                    let signature = envelope
                        .get("signature")
                        .and_then(serde_json::Value::as_str)
                        .ok_or_else(|| "catalog mirror has no signature".to_owned())?;
                    if !verify_text_signature(catalog, signature, &self.master) {
                        return Err("catalog mirror signature does not verify".to_owned());
                    }
                    Ok(catalog.to_owned())
                }
                .await;
                let _ = fs::remove_file(&tmp).await;
                match outcome {
                    Ok(catalog) => return Ok(Some(catalog)),
                    Err(_error) => continue, // try the next tier
                }
            }
            Ok(None)
        })
    }
}

// ---------------------------------------------------------------------------
// Catalog store
// ---------------------------------------------------------------------------

pub struct CatalogStoreOptions {
    pub path: PathBuf,
    pub default_policy: BackupPolicy,
    pub file_system: Option<std::sync::Arc<dyn CatalogFileSystem>>,
    pub max_runs: Option<usize>,
    pub max_drills: Option<usize>,
    pub mirror: Option<std::sync::Arc<dyn CatalogMirror>>,
    pub on_warning: Option<WarningFn>,
}

impl CatalogStoreOptions {
    #[must_use]
    pub fn new(path: impl Into<PathBuf>, default_policy: BackupPolicy) -> Self {
        Self {
            path: path.into(),
            default_policy,
            file_system: None,
            max_runs: None,
            max_drills: None,
            mirror: None,
            on_warning: None,
        }
    }
}

pub struct CatalogStore {
    path: PathBuf,
    catalog: CatalogCatalogCell,
    file_system: std::sync::Arc<dyn CatalogFileSystem>,
    max_runs: usize,
    max_drills: usize,
    clock: Box<dyn Fn() -> chrono::DateTime<chrono::Utc> + Send + Sync>,
    write_counter: std::sync::atomic::AtomicU64,
    write_lock: tokio::sync::Mutex<()>,
    persistent: std::sync::atomic::AtomicBool,
    persistence_error: Mutex<Option<String>>,
    load_warning: Option<String>,
    mirror: Option<std::sync::Arc<dyn CatalogMirror>>,
    mirror_error: Mutex<Option<String>>,
    /// True when this catalog was rebuilt from the mirror because no local file existed.
    recovered: bool,
}

struct CatalogCatalogCell(std::sync::RwLock<BackupCatalog>);

impl CatalogCatalogCell {
    fn read(&self) -> std::sync::RwLockReadGuard<'_, BackupCatalog> {
        self.0
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn write(&self) -> std::sync::RwLockWriteGuard<'_, BackupCatalog> {
        self.0
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl CatalogStore {
    pub async fn load(options: CatalogStoreOptions) -> Self {
        let file_system = options
            .file_system
            .clone()
            .unwrap_or_else(|| std::sync::Arc::new(RealCatalogFileSystem));
        let mut warning: Option<String> = None;
        let mut raw: Option<String> = None;
        let mut recovered_from_mirror = false;

        match file_system.read_file(&options.path).await {
            Ok(text) => raw = Some(text),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if let Some(mirror) = &options.mirror {
                    match mirror.download().await {
                        Ok(Some(remote)) => {
                            raw = Some(remote);
                            recovered_from_mirror = true;
                        }
                        Ok(None) => {}
                        Err(error) => {
                            warning = Some(format!("catalog mirror could not be read: {error}"))
                        }
                    }
                }
            }
            Err(error) => warning = Some(format!("catalog could not be read: {error}")),
        }

        let mut parsed: Option<BackupCatalog> = None;
        if let Some(text) = &raw {
            match serde_json::from_str::<BackupCatalog>(text) {
                Ok(catalog)
                    if catalog.runs.iter().all(BackupRun::is_valid)
                        && catalog.policy.is_valid() =>
                {
                    parsed = Some(catalog);
                }
                Ok(_) => {
                    warning = Some(
                        "catalog is corrupt and was replaced in memory: invalid record values"
                            .to_owned(),
                    );
                }
                Err(error) => {
                    warning = Some(format!(
                        "catalog is corrupt and was replaced in memory: {error}"
                    ));
                }
            }
        }

        let mut initial = parsed.clone().unwrap_or_else(|| BackupCatalog {
            runs: Vec::new(),
            drills: Vec::new(),
            policy: options.default_policy.clone(),
        });
        initial
            .runs
            .sort_by(|left, right| right.started_at.cmp(&left.started_at));
        initial
            .drills
            .sort_by(|left, right| right.started_at.cmp(&left.started_at));

        let store = Self {
            path: options.path.clone(),
            catalog: CatalogCatalogCell(std::sync::RwLock::new(initial)),
            file_system,
            max_runs: options.max_runs.unwrap_or(500),
            max_drills: options.max_drills.unwrap_or(100),
            clock: Box::new(chrono::Utc::now),
            write_counter: std::sync::atomic::AtomicU64::new(0),
            write_lock: tokio::sync::Mutex::new(()),
            persistent: std::sync::atomic::AtomicBool::new(true),
            persistence_error: Mutex::new(None),
            load_warning: warning.clone(),
            mirror: options.mirror.clone(),
            mirror_error: Mutex::new(None),
            recovered: recovered_from_mirror && parsed.is_some(),
        };

        if let Some(message) = &warning {
            if let Ok(mut slot) = store.persistence_error.lock() {
                *slot = Some(message.clone());
            }
            if raw.is_none() {
                store
                    .persistent
                    .store(false, std::sync::atomic::Ordering::Relaxed);
            }
            if let Some(callback) = &options.on_warning {
                callback(message);
            }
        }

        if store.recovered
            || (raw.is_none() && warning.is_none())
            || (warning.is_some() && raw.is_some())
        {
            let _ = store.save().await;
        }
        store
    }

    pub fn with_clock(
        mut self,
        clock: Box<dyn Fn() -> chrono::DateTime<chrono::Utc> + Send + Sync>,
    ) -> Self {
        self.clock = clock;
        self
    }

    pub fn snapshot(&self) -> BackupCatalog {
        let catalog = self.catalog.read();
        BackupCatalog {
            runs: catalog.runs.clone(),
            drills: catalog.drills.clone(),
            policy: catalog.policy.clone(),
        }
    }

    pub fn get_policy(&self) -> BackupPolicy {
        self.catalog.read().policy.clone()
    }

    pub fn list_runs(&self, limit: usize) -> Vec<BackupRun> {
        self.catalog
            .read()
            .runs
            .iter()
            .take(limit)
            .cloned()
            .collect()
    }

    pub fn list_drills(&self, limit: usize) -> Vec<DrillReport> {
        self.catalog
            .read()
            .drills
            .iter()
            .take(limit)
            .cloned()
            .collect()
    }

    pub fn latest_drill(&self) -> Option<DrillReport> {
        self.catalog.read().drills.first().cloned()
    }

    pub async fn add_run(&self, run: BackupRun) -> BackupRun {
        {
            let mut catalog = self.catalog.write();
            catalog.runs.insert(0, run.clone());
            Self::prune(&mut catalog, self.max_runs, self.max_drills);
        }
        self.save().await;
        run
    }

    pub async fn update_run(&self, id: &str, patch: RunPatch) -> Option<BackupRun> {
        let updated = {
            let mut catalog = self.catalog.write();
            let index = catalog.runs.iter().position(|run| run.id == id)?;
            let current = catalog.runs[index].clone();
            let updated = patch.apply(current);
            catalog.runs[index] = updated.clone();
            updated
        };
        self.save().await;
        Some(updated)
    }

    /// Runs that were QUEUED/RUNNING when the daemon stopped can never finish: nothing is running
    /// them any more. Without this they stay "RUNNING" forever in the Admin Portal.
    pub async fn fail_interrupted_runs(&self, reason: &str) -> Vec<String> {
        let interrupted: Vec<String> = {
            let mut catalog = self.catalog.write();
            let at = (self.clock)().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            let mut ids = Vec::new();
            for run in &mut catalog.runs {
                if run.status == "QUEUED" || run.status == "RUNNING" {
                    run.status = "FAILED".to_owned();
                    run.completed_at = Some(at.clone());
                    run.error_message = Some(reason.to_owned());
                    ids.push(run.id.clone());
                }
            }
            ids
        };
        if !interrupted.is_empty() {
            self.save().await;
        }
        interrupted
    }

    pub fn has_finished_job(&self, id: &str) -> bool {
        let catalog = self.catalog.read();
        catalog
            .runs
            .iter()
            .any(|run| run.id == id && (run.status == "PASSED" || run.status == "FAILED"))
            || catalog.drills.iter().any(|drill| drill.id == id)
    }

    /// Adds history rebuilt from the repository without duplicating ids already known.
    pub async fn import_runs(&self, runs: Vec<BackupRun>) -> usize {
        let imported = {
            let mut catalog = self.catalog.write();
            let known: std::collections::BTreeSet<String> =
                catalog.runs.iter().map(|run| run.id.clone()).collect();
            let fresh: Vec<BackupRun> = runs
                .into_iter()
                .filter(|run| !known.contains(&run.id))
                .collect();
            if fresh.is_empty() {
                return 0;
            }
            catalog.runs.extend(fresh.iter().cloned());
            catalog
                .runs
                .sort_by(|left, right| right.started_at.cmp(&left.started_at));
            Self::prune(&mut catalog, self.max_runs, self.max_drills);
            fresh.len()
        };
        self.save().await;
        imported
    }

    pub async fn add_drill(&self, report: DrillReport) -> DrillReport {
        {
            let mut catalog = self.catalog.write();
            catalog.drills.insert(0, report.clone());
            Self::prune(&mut catalog, self.max_runs, self.max_drills);
        }
        self.save().await;
        report
    }

    // The TS `updatePolicy(patch)` takes a partial policy object; the flat argument list keeps the
    // port literal instead of hiding the fields in a DTO.
    #[allow(clippy::too_many_arguments)]
    pub async fn update_policy(
        &self,
        full_cron: Option<String>,
        delta_cron: Option<String>,
        drill_cron: Option<String>,
        full_retention_days: Option<u32>,
        wal_retention_days: Option<u32>,
        alert_lag_seconds: Option<u32>,
        updated_by: Option<String>,
        updated_at: Option<String>,
    ) -> BackupPolicy {
        let policy = {
            let mut catalog = self.catalog.write();
            if let Some(value) = full_cron {
                catalog.policy.full_cron = value;
            }
            if let Some(value) = delta_cron {
                catalog.policy.delta_cron = value;
            }
            if let Some(value) = drill_cron {
                catalog.policy.drill_cron = value;
            }
            if let Some(value) = full_retention_days {
                catalog.policy.full_retention_days = value;
            }
            if let Some(value) = wal_retention_days {
                catalog.policy.wal_retention_days = value;
            }
            if let Some(value) = alert_lag_seconds {
                catalog.policy.alert_lag_seconds = value;
            }
            if let Some(value) = updated_by {
                catalog.policy.updated_by = Some(value);
            }
            catalog.policy.updated_at = updated_at.unwrap_or_else(|| {
                (self.clock)().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            });
            catalog.policy.clone()
        };
        self.save().await;
        policy
    }

    #[must_use]
    pub fn is_persistent(&self) -> bool {
        self.persistent.load(std::sync::atomic::Ordering::Relaxed)
    }

    pub fn get_persistence_error(&self) -> Option<String> {
        self.persistence_error
            .lock()
            .ok()
            .and_then(|value| value.clone())
    }

    pub fn get_load_warning(&self) -> Option<String> {
        self.load_warning.clone()
    }

    pub fn get_mirror_error(&self) -> Option<String> {
        self.mirror_error
            .lock()
            .ok()
            .and_then(|value| value.clone())
    }

    #[must_use]
    pub fn is_recovered(&self) -> bool {
        self.recovered
    }

    pub async fn save(&self) -> bool {
        // Latest write wins; the write lock serializes the temp+rename pair.
        let _guard = self.write_lock.lock().await;
        let payload = {
            let catalog = self.catalog.read();
            format!(
                "{}\n",
                serde_json::to_string_pretty(&*catalog).unwrap_or_else(|_| "{}".to_owned())
            )
        };
        let ok = self.write_atomically(&payload).await;
        if let Some(mirror) = &self.mirror {
            // Synchronous, latest-wins upload. The TS store schedules it; blocking here keeps the
            // ordering guaranteed and still never fails the catalog write.
            match mirror.upload(&payload).await {
                Ok(()) => {
                    if let Ok(mut slot) = self.mirror_error.lock() {
                        *slot = None;
                    }
                }
                Err(error) => {
                    if let Ok(mut slot) = self.mirror_error.lock() {
                        *slot = Some(error);
                    }
                }
            }
        }
        ok
    }

    /// Resolves once every queued mirror upload has finished. The Rust mirror is synchronous, so a
    /// `save()` already implies the upload happened; this exists for API parity.
    pub async fn when_mirrored(&self) {
        let _guard = self.write_lock.lock().await;
    }

    fn prune(catalog: &mut BackupCatalog, max_runs: usize, max_drills: usize) {
        if catalog.runs.len() > max_runs {
            catalog.runs.truncate(max_runs);
        }
        if catalog.drills.len() > max_drills {
            catalog.drills.truncate(max_drills);
        }
    }

    async fn write_atomically(&self, payload: &str) -> bool {
        let counter = self
            .write_counter
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let directory = self
            .path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        let name = self
            .path
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| "catalog.json".to_owned());
        let tmp = directory.join(format!(".{}.{}.{}.tmp", name, std::process::id(), counter));

        if let Err(error) = self.file_system.mkdir(&directory).await {
            self.record_write_failure(&error.to_string());
            return false;
        }
        if let Err(error) = self.file_system.write_file(&tmp, payload).await {
            self.record_write_failure(&error.to_string());
            let _ = self.file_system.unlink(&tmp).await;
            return false;
        }
        if let Err(error) = self.file_system.rename(&tmp, &self.path).await {
            self.record_write_failure(&error.to_string());
            let _ = self.file_system.unlink(&tmp).await;
            return false;
        }
        self.persistent
            .store(true, std::sync::atomic::Ordering::Relaxed);
        if let Ok(mut slot) = self.persistence_error.lock() {
            *slot = None;
        }
        true
    }

    fn record_write_failure(&self, message: &str) {
        self.persistent
            .store(false, std::sync::atomic::Ordering::Relaxed);
        if let Ok(mut slot) = self.persistence_error.lock() {
            *slot = Some(message.to_owned());
        }
    }
}

/// Partial update for a run (`updateRun(id, patch)`).
#[derive(Debug, Clone, Default)]
pub struct RunPatch {
    pub status: Option<String>,
    pub completed_at: Option<String>,
    pub duration_ms: Option<u64>,
    pub size_bytes: Option<u64>,
    pub start_lsn: Option<String>,
    pub end_lsn: Option<String>,
    pub storage_targets: Option<Vec<String>>,
    pub error_message: Option<String>,
}

impl RunPatch {
    fn apply(&self, mut run: BackupRun) -> BackupRun {
        if let Some(value) = &self.status {
            run.status = value.clone();
        }
        if let Some(value) = &self.completed_at {
            run.completed_at = Some(value.clone());
        }
        if let Some(value) = self.duration_ms {
            run.duration_ms = Some(value);
        }
        if let Some(value) = self.size_bytes {
            run.size_bytes = Some(value);
        }
        if let Some(value) = &self.start_lsn {
            run.start_lsn = Some(value.clone());
        }
        if let Some(value) = &self.end_lsn {
            run.end_lsn = Some(value.clone());
        }
        if let Some(value) = &self.storage_targets {
            run.storage_targets = value.clone();
        }
        if let Some(value) = &self.error_message {
            run.error_message = Some(value.clone());
        }
        run
    }
}

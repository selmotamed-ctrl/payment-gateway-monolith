//! Receives WAL files (from `archive_command` over mTLS or the spool sweeper) and stores each one
//! compressed + encrypted. Port of `deploy/backup-daemon/src/walArchive.ts`.
//!
//! The write is idempotent: the same bytes uploaded again are acknowledged, different bytes for an
//! existing name are refused (409) so a segment in the archive can never be silently replaced.

use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Utc};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::fs;

use crate::artifacts::ArtifactRepository;
use crate::crypto::{open_to_buffer, seal_file, SealOptions};
use crate::util::{sha256_file, temp_sibling};
use crate::wal_names::{is_archivable_wal_file, is_wal_segment_name, WalTarget};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalIngestError {
    pub status: u16,
    pub code: String,
    pub message: String,
}

impl WalIngestError {
    #[must_use]
    pub fn new(status: u16, code: &str, message: impl Into<String>) -> Self {
        Self {
            status,
            code: code.to_owned(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for WalIngestError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for WalIngestError {}

#[must_use]
pub fn wal_key(target: WalTarget, file: &str) -> String {
    format!("wal/{}/{file}.zst.enc", target.as_str())
}

fn seal_id(file: &str) -> String {
    format!("wal/{file}")
}

fn seal_target(target: WalTarget) -> String {
    format!("wal:{}", target.as_str())
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalTrackerState {
    pub last_archived_wal: String,
    pub last_archived_at: Option<String>,
    pub received: u64,
    pub duplicates: u64,
    pub conflicts: u64,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IngestResult {
    pub status: String,
    pub key: String,
    pub bytes: u64,
}

pub struct WalArchive {
    repository: Arc<ArtifactRepository>,
    master: Vec<u8>,
    staging_dir: PathBuf,
    max_bytes: u64,
    clock: Box<dyn Fn() -> DateTime<Utc> + Send + Sync>,
    tracker: Mutex<WalTrackerState>,
    in_flight: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    pub mirror: Arc<WalMirror>,
}

impl WalArchive {
    #[must_use]
    pub fn new(
        repository: Arc<ArtifactRepository>,
        master: Vec<u8>,
        staging_dir: PathBuf,
        max_bytes: u64,
        clock: Box<dyn Fn() -> DateTime<Utc> + Send + Sync>,
    ) -> Self {
        let mirror = Arc::new(WalMirror::new(Arc::clone(&repository), staging_dir.clone()));
        Self {
            repository,
            master,
            staging_dir,
            max_bytes,
            clock,
            tracker: Mutex::new(WalTrackerState::default()),
            in_flight: Mutex::new(HashMap::new()),
            mirror,
        }
    }

    pub fn state(&self) -> WalTrackerState {
        self.tracker
            .lock()
            .map(|tracker| tracker.clone())
            .unwrap_or_default()
    }

    fn primary_ids(&self) -> Vec<String> {
        self.repository
            .stores()
            .first()
            .map(|store| vec![store.id().to_owned()])
            .unwrap_or_default()
    }

    pub fn validate(target: &str, file: &str) -> Result<WalTarget, WalIngestError> {
        let target = WalTarget::parse(target).ok_or_else(|| {
            WalIngestError::new(
                400,
                "invalid_wal_target",
                "target must be postgres_core or audit_db",
            )
        })?;
        if !is_archivable_wal_file(file) {
            return Err(WalIngestError::new(
                400,
                "invalid_wal_file",
                "not a WAL segment, timeline history or backup label file name",
            ));
        }
        Ok(target)
    }

    /// Streams a request body into a staging file (size capped), then stores it.
    pub async fn ingest_stream(
        &self,
        target: &str,
        file: &str,
        body: &[u8],
        declared_length: Option<u64>,
    ) -> Result<IngestResult, WalIngestError> {
        let wal_target = Self::validate(target, file)?;
        if let Some(declared) = declared_length {
            if declared > self.max_bytes {
                return Err(WalIngestError::new(
                    413,
                    "payload_too_large",
                    format!("WAL file exceeds {} bytes", self.max_bytes),
                ));
            }
        }
        if body.len() as u64 > self.max_bytes {
            return Err(WalIngestError::new(
                413,
                "payload_too_large",
                format!("WAL file exceeds {} bytes", self.max_bytes),
            ));
        }
        if body.is_empty() {
            return Err(WalIngestError::new(
                400,
                "empty_wal_file",
                "empty WAL upload",
            ));
        }
        if let Some(declared) = declared_length {
            if declared != body.len() as u64 {
                return Err(WalIngestError::new(
                    400,
                    "truncated_upload",
                    "uploaded size does not match Content-Length",
                ));
            }
        }
        let staging = self.staging_dir.join("wal-in");
        fs::create_dir_all(&staging)
            .await
            .map_err(|error| WalIngestError::new(500, "internal_error", error.to_string()))?;
        let incoming = staging.join(format!(
            "{}-{}-{}-{file}",
            std::process::id(),
            (self.clock)().timestamp_millis(),
            uuid::Uuid::new_v4()
        ));
        fs::write(&incoming, body)
            .await
            .map_err(|error| WalIngestError::new(500, "internal_error", error.to_string()))?;
        let result = self.ingest_file(wal_target, file, &incoming).await;
        let _ = fs::remove_file(&incoming).await;
        result
    }

    /// Stores a WAL file that is already on disk (also used by the spool sweeper).
    pub async fn ingest_file(
        &self,
        target: WalTarget,
        file: &str,
        path: &std::path::Path,
    ) -> Result<IngestResult, WalIngestError> {
        let key = wal_key(target, file);
        let gate = {
            let mut in_flight = self.in_flight.lock().map_err(|_| {
                WalIngestError::new(500, "internal_error", "WAL ingest lock poisoned")
            })?;
            Arc::clone(
                in_flight
                    .entry(key.clone())
                    .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
            )
        };
        let guard = gate.lock().await;
        let result = self.do_ingest(target, file, path, &key).await;
        drop(guard);
        // Bound the in-flight map: remove the entry when no other upload shares this key.
        if std::sync::Arc::strong_count(&gate) <= 2 {
            if let Ok(mut in_flight) = self.in_flight.lock() {
                in_flight.remove(&key);
            }
        }
        result
    }

    async fn do_ingest(
        &self,
        target: WalTarget,
        file: &str,
        path: &std::path::Path,
        key: &str,
    ) -> Result<IngestResult, WalIngestError> {
        let internal = |error: String| WalIngestError::new(500, "internal_error", error);
        let plain_sha = sha256_file(path)
            .await
            .map_err(|error| internal(error.to_string()))?;
        let size = fs::metadata(path)
            .await
            .map_err(|error| internal(error.to_string()))?
            .len();
        if let Some(existing) = self.existing_plaintext_sha(target, file, key).await? {
            if existing == plain_sha {
                if let Ok(mut tracker) = self.tracker.lock() {
                    tracker.duplicates += 1;
                }
                self.touch(file);
                return Ok(IngestResult {
                    status: "duplicate".to_owned(),
                    key: key.to_owned(),
                    bytes: size,
                });
            }
            if let Ok(mut tracker) = self.tracker.lock() {
                tracker.conflicts += 1;
            }
            tracing::error!(
                key,
                "WAL conflict: already archived with different content; refusing to overwrite"
            );
            return Err(WalIngestError::new(
                409,
                "wal_conflict",
                format!("{file} already archived with different content"),
            ));
        }
        let options = SealOptions::new(&self.master, &seal_target(target), &seal_id(file));
        let sealed = self.temp_seal_path(file);
        seal_file(path, &sealed, &options)
            .await
            .map_err(|error| internal(error.to_string()))?;
        let outcome = self
            .repository
            .put_file(key, &sealed, Some(&self.primary_ids()))
            .await;
        let _ = fs::remove_file(&sealed).await;
        outcome.map_err(|error| {
            if let Ok(mut tracker) = self.tracker.lock() {
                tracker.last_error = Some(error.message.chars().take(300).collect());
            }
            internal(error.message)
        })?;
        if let Ok(mut tracker) = self.tracker.lock() {
            tracker.received += 1;
        }
        self.touch(file);
        self.mirror.schedule(key);
        let mirror = Arc::clone(&self.mirror);
        tokio::spawn(async move {
            let _ = mirror.drain_once().await;
        });
        Ok(IngestResult {
            status: "stored".to_owned(),
            key: key.to_owned(),
            bytes: size,
        })
    }

    fn temp_seal_path(&self, file: &str) -> PathBuf {
        temp_sibling(
            &self
                .staging_dir
                .join("wal-in")
                .join(format!("{file}.zst.enc")),
        )
    }

    fn touch(&self, file: &str) {
        if let Ok(mut tracker) = self.tracker.lock() {
            if is_wal_segment_name(file) && file > tracker.last_archived_wal.as_str() {
                tracker.last_archived_wal = file.to_owned();
            }
            tracker.last_archived_at =
                Some((self.clock)().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
            tracker.last_error = None;
        }
    }

    /// SHA-256 of the stored plaintext, or None when the file has not been archived yet.
    async fn existing_plaintext_sha(
        &self,
        target: WalTarget,
        file: &str,
        key: &str,
    ) -> Result<Option<String>, WalIngestError> {
        let Some(primary) = self.repository.stores().first() else {
            return Ok(None);
        };
        if !matches!(primary.exists(key).await, Ok(true)) {
            return Ok(None);
        }
        let staging = self.staging_dir.join("wal-in");
        fs::create_dir_all(&staging)
            .await
            .map_err(|error| WalIngestError::new(500, "internal_error", error.to_string()))?;
        let tmp = staging.join(format!(
            "existing-{}-{}-{file}",
            std::process::id(),
            (self.clock)().timestamp_millis()
        ));
        let outcome = async {
            primary
                .get_file(key, &tmp)
                .await
                .map_err(|error| WalIngestError::new(500, "internal_error", error.to_string()))?;
            let plain = open_to_buffer(
                &tmp,
                &self.master,
                &seal_target(target),
                &seal_id(file),
                true,
            )
            .await
            .map_err(|error| WalIngestError::new(500, "internal_error", error.to_string()))?;
            Ok::<String, WalIngestError>(hex::encode(Sha256::digest(&plain)))
        }
        .await;
        let _ = fs::remove_file(&tmp).await;
        outcome.map(Some)
    }
}

// ---------------------------------------------------------------------------
// Asynchronous mirroring of WAL to the non-primary tiers
// ---------------------------------------------------------------------------

pub struct WalMirror {
    repository: Arc<ArtifactRepository>,
    staging_dir: PathBuf,
    pending: Mutex<BTreeSet<String>>,
    last_error: Mutex<Option<String>>,
    mirrored: AtomicU64,
    running: AtomicBool,
}

impl WalMirror {
    #[must_use]
    pub fn new(repository: Arc<ArtifactRepository>, staging_dir: PathBuf) -> Self {
        Self {
            repository,
            staging_dir,
            pending: Mutex::new(BTreeSet::new()),
            last_error: Mutex::new(None),
            mirrored: AtomicU64::new(0),
            running: AtomicBool::new(false),
        }
    }

    pub fn pending_count(&self) -> usize {
        self.pending
            .lock()
            .map(|pending| pending.len())
            .unwrap_or(0)
    }

    pub fn mirrored(&self) -> u64 {
        self.mirrored.load(Ordering::Relaxed)
    }

    pub fn last_error(&self) -> Option<String> {
        self.last_error.lock().ok().and_then(|value| value.clone())
    }

    pub fn schedule(&self, key: &str) {
        if self.repository.stores().len() < 2 {
            return;
        }
        if let Ok(mut pending) = self.pending.lock() {
            pending.insert(key.to_owned());
        }
    }

    /// Queues every WAL object that exists on the primary tier but not on a mirror tier.
    pub async fn reconcile(&self) -> usize {
        let listings = self.repository.list_by_store("wal").await;
        let Some(primary) = self.repository.stores().first() else {
            return 0;
        };
        let Some(source) = listings.get(primary.id()) else {
            return 0;
        };
        let mut queued = 0;
        for store in self.repository.stores().iter().skip(1) {
            let Some(have) = listings.get(store.id()) else {
                continue;
            };
            for key in source {
                if have.contains(key) {
                    continue;
                }
                if let Ok(mut pending) = self.pending.lock() {
                    if pending.insert(key.clone()) {
                        queued += 1;
                    }
                }
            }
        }
        queued
    }

    pub async fn drain_once(&self) -> (u64, u64) {
        if self.running.swap(true, Ordering::AcqRel) {
            return (0, 0);
        }
        let mut mirrored = 0;
        let mut failed = 0;
        let result: Result<(), String> = async {
            let Some(primary) = self.repository.stores().first().cloned() else {
                return Ok(());
            };
            let pending: Vec<String> = self
                .pending
                .lock()
                .map(|pending| pending.iter().cloned().collect())
                .unwrap_or_default();
            for key in pending {
                let source = if let Some(path) = primary.local_path(&key) {
                    path
                } else {
                    let staging = self.staging_dir.join(format!(
                        "mirror-{}-{}.tmp",
                        std::process::id(),
                        chrono::Utc::now().timestamp_millis()
                    ));
                    primary
                        .get_file(&key, &staging)
                        .await
                        .map_err(|error| error.to_string())?;
                    staging
                };
                let mut all_mirrored = true;
                for store in self.repository.stores().iter().skip(1) {
                    if matches!(store.exists(&key).await, Ok(true)) {
                        continue;
                    }
                    if let Err(error) = store.put_file(&key, &source).await {
                        all_mirrored = false;
                        failed += 1;
                        if let Ok(mut slot) = self.last_error.lock() {
                            *slot = Some(format!("{}: {}", store.id(), error));
                        }
                        tracing::warn!(store = store.id(), key = key.as_str(), "WAL mirror failed");
                    }
                }
                if all_mirrored {
                    if let Ok(mut pending) = self.pending.lock() {
                        pending.remove(&key);
                    }
                    mirrored += 1;
                    self.mirrored.fetch_add(1, Ordering::Relaxed);
                }
            }
            Ok(())
        }
        .await;
        if let Err(error) = result {
            if let Ok(mut slot) = self.last_error.lock() {
                *slot = Some(error.chars().take(200).collect());
            }
        }
        self.running.store(false, Ordering::Release);
        (mirrored, failed)
    }

    /// Periodic reconcile + drain. Every WAL object missing from a mirror tier is re-queued, so a
    /// daemon restart repairs the gap.
    pub fn start(self: &Arc<Self>, interval_ms: u64) {
        if self.repository.stores().len() < 2 {
            return;
        }
        let mirror = Arc::clone(self);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(std::time::Duration::from_millis(interval_ms));
            loop {
                ticker.tick().await;
                let _ = mirror.reconcile().await;
                let _ = mirror.drain_once().await;
            }
        });
    }
}

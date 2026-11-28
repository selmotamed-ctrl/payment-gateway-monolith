//! The 3-2-1 storage pipeline. Port of `deploy/backup-daemon/src/artifactStore.ts` and
//! `src/repository.ts`.
//!
//! Every artifact is addressed by a relative, forward-slash key
//! (`backups/postgres_core/<id>.tar.zst.enc`, `wal/postgres_core/<segment>.zst.enc`, ...) that
//! means the same thing on every tier. Tier 1 (the local content repository) is implemented.
//! S3 and the off-site SSH/rclone vault report `S3_NOT_CONFIGURED` / `SSH_VAULT_NOT_PORTED` instead
//! of pretending to store data (documented gap in `README.md`).

use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tokio::fs;

use crate::command_runner::CommandRunner;
use crate::config::Config;
use crate::util::{is_not_found, sha256_file, temp_sibling};

pub type StoreFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoreKind {
    Local,
    S3,
    Ssh,
}

impl StoreKind {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::S3 => "s3",
            Self::Ssh => "ssh",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreHealth {
    pub healthy: bool,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreError {
    NotFound(String),
    UnsafeKey(String),
    S3NotConfigured,
    SshVaultNotPorted,
    Io(String),
    Other(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound(key) => write!(formatter, "{key} not found"),
            Self::UnsafeKey(key) => write!(formatter, "unsafe artifact key: {key}"),
            Self::S3NotConfigured => write!(
                formatter,
                "S3_NOT_CONFIGURED: the S3/MinIO tier needs the AWS SDK, which this build does not include; \
                 configure BACKUP_LOCAL_REPO_DIR only, or run the TypeScript daemon for an S3 deployment"
            ),
            Self::SshVaultNotPorted => write!(
                formatter,
                "SSH_VAULT_NOT_PORTED: the off-site rsync/rclone vault is not ported yet; \
                 use the local repository or the TypeScript daemon for a secondary tier"
            ),
            Self::Io(message) => write!(formatter, "{message}"),
            Self::Other(message) => write!(formatter, "{message}"),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<std::io::Error> for StoreError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error.to_string())
    }
}

pub trait ArtifactStore: Send + Sync {
    fn id(&self) -> &str;
    fn name(&self) -> &str;
    fn kind(&self) -> StoreKind;
    /// When false the store never deletes (append-only off-site vault).
    fn allow_delete(&self) -> bool;

    fn put_file<'a>(
        &'a self,
        key: &'a str,
        local_path: &'a Path,
    ) -> StoreFuture<'a, Result<(), StoreError>>;
    fn put_buffer<'a>(
        &'a self,
        key: &'a str,
        data: &'a [u8],
    ) -> StoreFuture<'a, Result<(), StoreError>>;
    fn get_file<'a>(
        &'a self,
        key: &'a str,
        dest_path: &'a Path,
    ) -> StoreFuture<'a, Result<(), StoreError>>;
    fn get_buffer<'a>(
        &'a self,
        key: &'a str,
    ) -> StoreFuture<'a, Result<Option<Vec<u8>>, StoreError>>;
    fn exists<'a>(&'a self, key: &'a str) -> StoreFuture<'a, Result<bool, StoreError>>;
    fn list<'a>(&'a self, prefix: &'a str) -> StoreFuture<'a, Result<Vec<String>, StoreError>>;
    fn delete<'a>(&'a self, key: &'a str) -> StoreFuture<'a, Result<(), StoreError>>;
    fn health(&self) -> StoreFuture<'_, StoreHealth>;

    /// Absolute path when this store keeps artifacts on local disk (used to avoid a copy).
    fn local_path(&self, _key: &str) -> Option<PathBuf> {
        None
    }
}

const KEY_PATTERN_START: &[u8] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._";
const KEY_PATTERN_REST: &[u8] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._/-";

pub fn assert_safe_key(key: &str) -> Result<&str, StoreError> {
    let bytes = key.as_bytes();
    let valid = !bytes.is_empty()
        && KEY_PATTERN_START.contains(&bytes[0])
        && bytes.iter().all(|byte| KEY_PATTERN_REST.contains(byte))
        && key
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..");
    if !valid {
        return Err(StoreError::UnsafeKey(format!(
            "\"{}\"",
            key.chars().take(120).collect::<String>()
        )));
    }
    Ok(key)
}

// ---------------------------------------------------------------------------
// Tier 1: local content repository
// ---------------------------------------------------------------------------

pub struct LocalRepoStore {
    root: PathBuf,
}

impl LocalRepoStore {
    #[must_use]
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// Absolute path of a key (validated to stay inside the repository root).
    pub fn path_for(&self, key: &str) -> Result<PathBuf, StoreError> {
        let key = assert_safe_key(key)?;
        let full = self.root.join(key);
        let root = self.root.clone();
        if full != root && !full.starts_with(&root) {
            return Err(StoreError::UnsafeKey(
                "artifact key escapes the repository".to_owned(),
            ));
        }
        Ok(full)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
}

impl ArtifactStore for LocalRepoStore {
    fn id(&self) -> &str {
        "local-repo"
    }

    fn name(&self) -> &str {
        "Local Repository"
    }

    fn kind(&self) -> StoreKind {
        StoreKind::Local
    }

    fn allow_delete(&self) -> bool {
        true
    }

    fn put_file<'a>(
        &'a self,
        key: &'a str,
        local_path: &'a Path,
    ) -> StoreFuture<'a, Result<(), StoreError>> {
        Box::pin(async move {
            let destination = self.path_for(key)?;
            if destination == local_path {
                return Ok(());
            }
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent).await?;
            }
            let tmp = temp_sibling(&destination);
            if let Err(error) = fs::copy(local_path, &tmp).await {
                let _ = fs::remove_file(&tmp).await;
                return Err(error.into());
            }
            match fs::rename(&tmp, &destination).await {
                Ok(()) => Ok(()),
                Err(error) => {
                    let _ = fs::remove_file(&tmp).await;
                    Err(error.into())
                }
            }
        })
    }

    fn put_buffer<'a>(
        &'a self,
        key: &'a str,
        data: &'a [u8],
    ) -> StoreFuture<'a, Result<(), StoreError>> {
        Box::pin(async move {
            let destination = self.path_for(key)?;
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent).await?;
            }
            let tmp = temp_sibling(&destination);
            if let Err(error) = fs::write(&tmp, data).await {
                let _ = fs::remove_file(&tmp).await;
                return Err(error.into());
            }
            match fs::rename(&tmp, &destination).await {
                Ok(()) => Ok(()),
                Err(error) => {
                    let _ = fs::remove_file(&tmp).await;
                    Err(error.into())
                }
            }
        })
    }

    fn get_file<'a>(
        &'a self,
        key: &'a str,
        dest_path: &'a Path,
    ) -> StoreFuture<'a, Result<(), StoreError>> {
        Box::pin(async move {
            let source = self.path_for(key)?;
            if source == dest_path {
                return Ok(());
            }
            if let Some(parent) = dest_path.parent() {
                fs::create_dir_all(parent).await?;
            }
            fs::copy(&source, dest_path)
                .await
                .map(|_| ())
                .map_err(|error| {
                    if is_not_found(&error) {
                        StoreError::NotFound(key.to_owned())
                    } else {
                        error.into()
                    }
                })
        })
    }

    fn get_buffer<'a>(
        &'a self,
        key: &'a str,
    ) -> StoreFuture<'a, Result<Option<Vec<u8>>, StoreError>> {
        Box::pin(async move {
            let path = self.path_for(key)?;
            match fs::read(&path).await {
                Ok(bytes) => Ok(Some(bytes)),
                Err(error) if is_not_found(&error) => Ok(None),
                Err(error) => Err(error.into()),
            }
        })
    }

    fn exists<'a>(&'a self, key: &'a str) -> StoreFuture<'a, Result<bool, StoreError>> {
        Box::pin(async move {
            let path = self.path_for(key)?;
            Ok(fs::metadata(&path).await.is_ok())
        })
    }

    fn list<'a>(&'a self, prefix: &'a str) -> StoreFuture<'a, Result<Vec<String>, StoreError>> {
        Box::pin(async move {
            let base = if prefix.is_empty() {
                self.root.clone()
            } else {
                self.path_for(prefix.trim_end_matches('/'))?
            };
            let mut keys = Vec::new();
            let mut stack = vec![base];
            while let Some(directory) = stack.pop() {
                let mut entries = match fs::read_dir(&directory).await {
                    Ok(entries) => entries,
                    Err(error) if is_not_found(&error) => continue,
                    Err(error) => return Err(error.into()),
                };
                while let Some(entry) = entries.next_entry().await.map_err(StoreError::from)? {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if name.starts_with('.') && name.ends_with(".tmp") {
                        continue;
                    }
                    let path = entry.path();
                    let metadata = entry.metadata().await.map_err(StoreError::from)?;
                    if metadata.is_dir() {
                        stack.push(path);
                    } else if metadata.is_file() {
                        let relative = path
                            .strip_prefix(&self.root)
                            .map_err(|_| {
                                StoreError::Other("path escaped the repository".to_owned())
                            })?
                            .to_string_lossy()
                            .replace('\\', "/");
                        keys.push(relative);
                    }
                }
            }
            keys.sort();
            Ok(keys)
        })
    }

    fn delete<'a>(&'a self, key: &'a str) -> StoreFuture<'a, Result<(), StoreError>> {
        Box::pin(async move {
            let path = self.path_for(key)?;
            let _ = fs::remove_file(&path).await;
            Ok(())
        })
    }

    fn health(&self) -> StoreFuture<'_, StoreHealth> {
        Box::pin(async move {
            let probe = self
                .root
                .join(format!(".health-{}.tmp", std::process::id()));
            match fs::create_dir_all(&self.root).await {
                Ok(()) => {}
                Err(error) => {
                    return StoreHealth {
                        healthy: false,
                        detail: error.to_string(),
                    }
                }
            }
            if let Err(error) = fs::write(&probe, b"ok").await {
                return StoreHealth {
                    healthy: false,
                    detail: error.to_string(),
                };
            }
            let _ = fs::remove_file(&probe).await;
            StoreHealth {
                healthy: true,
                detail: format!("writable ({})", self.root.display()),
            }
        })
    }

    fn local_path(&self, key: &str) -> Option<PathBuf> {
        self.path_for(key).ok()
    }
}

// ---------------------------------------------------------------------------
// In-memory store (tests, dry runs)
// ---------------------------------------------------------------------------

pub struct MemoryArtifactStore {
    id: String,
    name: String,
    kind: StoreKind,
    allow_delete: bool,
    pub objects: Mutex<BTreeMap<String, Vec<u8>>>,
    pub fail_puts: AtomicBool,
}

impl MemoryArtifactStore {
    #[must_use]
    pub fn new(id: &str, name: &str, kind: StoreKind) -> Self {
        Self {
            id: id.to_owned(),
            name: name.to_owned(),
            kind,
            allow_delete: true,
            objects: Mutex::new(BTreeMap::new()),
            fail_puts: AtomicBool::new(false),
        }
    }

    pub fn set_fail_puts(&self, fail: bool) {
        self.fail_puts.store(fail, Ordering::Relaxed);
    }

    pub fn object(&self, key: &str) -> Option<Vec<u8>> {
        self.objects
            .lock()
            .ok()
            .and_then(|objects| objects.get(key).cloned())
    }

    pub fn put_object(&self, key: &str, value: Vec<u8>) {
        if let Ok(mut objects) = self.objects.lock() {
            objects.insert(key.to_owned(), value);
        }
    }
}

impl ArtifactStore for MemoryArtifactStore {
    fn id(&self) -> &str {
        &self.id
    }

    fn name(&self) -> &str {
        &self.name
    }

    fn kind(&self) -> StoreKind {
        self.kind
    }

    fn allow_delete(&self) -> bool {
        self.allow_delete
    }

    fn put_file<'a>(
        &'a self,
        key: &'a str,
        local_path: &'a Path,
    ) -> StoreFuture<'a, Result<(), StoreError>> {
        Box::pin(async move {
            if self.fail_puts.load(Ordering::Relaxed) {
                return Err(StoreError::Other(format!("{} is unavailable", self.id)));
            }
            let bytes = fs::read(local_path).await?;
            self.put_object(assert_safe_key(key)?, bytes);
            Ok(())
        })
    }

    fn put_buffer<'a>(
        &'a self,
        key: &'a str,
        data: &'a [u8],
    ) -> StoreFuture<'a, Result<(), StoreError>> {
        Box::pin(async move {
            if self.fail_puts.load(Ordering::Relaxed) {
                return Err(StoreError::Other(format!("{} is unavailable", self.id)));
            }
            self.put_object(assert_safe_key(key)?, data.to_vec());
            Ok(())
        })
    }

    fn get_file<'a>(
        &'a self,
        key: &'a str,
        dest_path: &'a Path,
    ) -> StoreFuture<'a, Result<(), StoreError>> {
        Box::pin(async move {
            let key = assert_safe_key(key)?;
            let value = self
                .object(key)
                .ok_or_else(|| StoreError::NotFound(key.to_owned()))?;
            if let Some(parent) = dest_path.parent() {
                fs::create_dir_all(parent).await?;
            }
            fs::write(dest_path, value).await?;
            Ok(())
        })
    }

    fn get_buffer<'a>(
        &'a self,
        key: &'a str,
    ) -> StoreFuture<'a, Result<Option<Vec<u8>>, StoreError>> {
        Box::pin(async move {
            let key = assert_safe_key(key)?;
            Ok(self.object(key))
        })
    }

    fn exists<'a>(&'a self, key: &'a str) -> StoreFuture<'a, Result<bool, StoreError>> {
        Box::pin(async move {
            let key = assert_safe_key(key)?;
            Ok(self
                .objects
                .lock()
                .map(|objects| objects.contains_key(key))
                .unwrap_or(false))
        })
    }

    fn list<'a>(&'a self, prefix: &'a str) -> StoreFuture<'a, Result<Vec<String>, StoreError>> {
        Box::pin(async move {
            let normalized = prefix.trim_end_matches('/');
            let objects = self
                .objects
                .lock()
                .map_err(|_| StoreError::Other("memory store lock poisoned".to_owned()))?;
            let mut keys: Vec<String> = objects
                .keys()
                .filter(|key| normalized.is_empty() || key.starts_with(&format!("{normalized}/")))
                .cloned()
                .collect();
            keys.sort();
            Ok(keys)
        })
    }

    fn delete<'a>(&'a self, key: &'a str) -> StoreFuture<'a, Result<(), StoreError>> {
        Box::pin(async move {
            if self.allow_delete {
                let key = assert_safe_key(key)?;
                if let Ok(mut objects) = self.objects.lock() {
                    objects.remove(key);
                }
            }
            Ok(())
        })
    }

    fn health(&self) -> StoreFuture<'_, StoreHealth> {
        Box::pin(async move {
            if self.fail_puts.load(Ordering::Relaxed) {
                StoreHealth {
                    healthy: false,
                    detail: "unavailable".to_owned(),
                }
            } else {
                StoreHealth {
                    healthy: true,
                    detail: "reachable".to_owned(),
                }
            }
        })
    }
}

// ---------------------------------------------------------------------------
// Unsupported tiers (documented gaps, never pretend to store data)
// ---------------------------------------------------------------------------

pub struct UnsupportedStore {
    id: String,
    name: String,
    kind: StoreKind,
    error: StoreError,
}

impl UnsupportedStore {
    #[must_use]
    pub fn s3() -> Self {
        Self {
            id: "primary-s3".to_owned(),
            name: "Primary S3 Bucket".to_owned(),
            kind: StoreKind::S3,
            error: StoreError::S3NotConfigured,
        }
    }

    #[must_use]
    pub fn ssh_vault() -> Self {
        Self {
            id: "secondary-ssh".to_owned(),
            name: "Secondary Off-site Target".to_owned(),
            kind: StoreKind::Ssh,
            error: StoreError::SshVaultNotPorted,
        }
    }
}

impl ArtifactStore for UnsupportedStore {
    fn id(&self) -> &str {
        &self.id
    }

    fn name(&self) -> &str {
        &self.name
    }

    fn kind(&self) -> StoreKind {
        self.kind
    }

    fn allow_delete(&self) -> bool {
        false
    }

    fn put_file<'a>(
        &'a self,
        _key: &'a str,
        _local_path: &'a Path,
    ) -> StoreFuture<'a, Result<(), StoreError>> {
        Box::pin(async move { Err(self.error.clone()) })
    }

    fn put_buffer<'a>(
        &'a self,
        _key: &'a str,
        _data: &'a [u8],
    ) -> StoreFuture<'a, Result<(), StoreError>> {
        Box::pin(async move { Err(self.error.clone()) })
    }

    fn get_file<'a>(
        &'a self,
        _key: &'a str,
        _dest_path: &'a Path,
    ) -> StoreFuture<'a, Result<(), StoreError>> {
        Box::pin(async move { Err(self.error.clone()) })
    }

    fn get_buffer<'a>(
        &'a self,
        _key: &'a str,
    ) -> StoreFuture<'a, Result<Option<Vec<u8>>, StoreError>> {
        Box::pin(async move { Ok(None) })
    }

    fn exists<'a>(&'a self, _key: &'a str) -> StoreFuture<'a, Result<bool, StoreError>> {
        Box::pin(async move { Ok(false) })
    }

    fn list<'a>(&'a self, _prefix: &'a str) -> StoreFuture<'a, Result<Vec<String>, StoreError>> {
        Box::pin(async move { Ok(Vec::new()) })
    }

    fn delete<'a>(&'a self, _key: &'a str) -> StoreFuture<'a, Result<(), StoreError>> {
        Box::pin(async move { Ok(()) })
    }

    fn health(&self) -> StoreFuture<'_, StoreHealth> {
        Box::pin(async move {
            StoreHealth {
                healthy: false,
                detail: self.error.to_string(),
            }
        })
    }
}

// ---------------------------------------------------------------------------
// Multi-tier repository
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PutOutcome {
    pub stored: Vec<String>,
    pub failed: Vec<(String, String)>,
}

#[derive(Debug, Clone)]
pub struct RepositoryWriteError {
    pub message: String,
    pub outcome: PutOutcome,
}

impl std::fmt::Display for RepositoryWriteError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for RepositoryWriteError {}

pub struct ArtifactRepository {
    stores: Vec<std::sync::Arc<dyn ArtifactStore>>,
    required_ids: BTreeSet<String>,
}

impl ArtifactRepository {
    /// Local (tier 1) and S3 (tier 2) are required; the append-only off-site vault is best effort.
    #[must_use]
    pub fn new(stores: Vec<std::sync::Arc<dyn ArtifactStore>>) -> Self {
        if stores.is_empty() {
            // The constructor cannot fail in the TS class without throwing; callers use
            // `try_new` when they want the error.
            return Self {
                stores,
                required_ids: BTreeSet::new(),
            };
        }
        let required_ids = stores
            .iter()
            .filter(|store| store.kind() != StoreKind::Ssh)
            .map(|store| store.id().to_owned())
            .collect();
        Self {
            stores,
            required_ids,
        }
    }

    pub fn try_new(stores: Vec<std::sync::Arc<dyn ArtifactStore>>) -> Result<Self, StoreError> {
        if stores.is_empty() {
            return Err(StoreError::Other(
                "at least one artifact store (local repository or S3) is required".to_owned(),
            ));
        }
        Ok(Self::new(stores))
    }

    #[must_use]
    pub fn stores(&self) -> &[std::sync::Arc<dyn ArtifactStore>] {
        &self.stores
    }

    #[must_use]
    pub fn local(&self) -> Option<&std::sync::Arc<dyn ArtifactStore>> {
        self.stores
            .iter()
            .find(|store| store.kind() == StoreKind::Local)
    }

    #[must_use]
    pub fn required_store_ids(&self) -> Vec<String> {
        self.required_ids.iter().cloned().collect()
    }

    async fn fan_out(
        &self,
        only_ids: Option<&[String]>,
        key: &str,
        write: impl Fn(
            std::sync::Arc<dyn ArtifactStore>,
        ) -> Pin<Box<dyn Future<Output = Result<(), StoreError>> + Send>>,
    ) -> Result<PutOutcome, RepositoryWriteError> {
        let targets: Vec<std::sync::Arc<dyn ArtifactStore>> = self
            .stores
            .iter()
            .filter(|store| only_ids.is_none_or(|ids| ids.iter().any(|id| id == store.id())))
            .cloned()
            .collect();
        let mut outcome = PutOutcome::default();
        for store in targets {
            let id = store.id().to_owned();
            match write(store).await {
                Ok(()) => outcome.stored.push(id),
                Err(error) => outcome.failed.push((id, error.to_string())),
            }
        }
        if let Some((id, error)) = outcome
            .failed
            .iter()
            .find(|(id, _)| self.required_ids.contains(id))
        {
            return Err(RepositoryWriteError {
                message: format!("storing {key} on {id} failed: {error}"),
                outcome,
            });
        }
        Ok(outcome)
    }

    pub async fn put_file(
        &self,
        key: &str,
        local_path: &Path,
        only_ids: Option<&[String]>,
    ) -> Result<PutOutcome, RepositoryWriteError> {
        assert_safe_key(key).map_err(|error| RepositoryWriteError {
            message: error.to_string(),
            outcome: PutOutcome::default(),
        })?;
        let key_owned = key.to_owned();
        let path_owned = local_path.to_path_buf();
        self.fan_out(only_ids, key, move |store| {
            let key = key_owned.clone();
            let path = path_owned.clone();
            Box::pin(async move { store.put_file(&key, &path).await })
        })
        .await
    }

    pub async fn put_buffer(
        &self,
        key: &str,
        data: &[u8],
        only_ids: Option<&[String]>,
    ) -> Result<PutOutcome, RepositoryWriteError> {
        assert_safe_key(key).map_err(|error| RepositoryWriteError {
            message: error.to_string(),
            outcome: PutOutcome::default(),
        })?;
        let key_owned = key.to_owned();
        let data_owned = data.to_vec();
        self.fan_out(only_ids, key, move |store| {
            let key = key_owned.clone();
            let data = data_owned.clone();
            Box::pin(async move { store.put_buffer(&key, &data).await })
        })
        .await
    }

    /// Downloads from the first tier that has the artifact; returns that tier's id.
    pub async fn get_file(&self, key: &str, dest_path: &Path) -> Result<String, StoreError> {
        let mut errors = Vec::new();
        for store in &self.stores {
            match store.exists(key).await {
                Ok(false) | Err(_) => continue,
                Ok(true) => {}
            }
            match store.get_file(key, dest_path).await {
                Ok(()) => return Ok(store.id().to_owned()),
                Err(error) => errors.push(format!("{}: {error}", store.id())),
            }
        }
        Err(StoreError::Other(format!(
            "artifact {key} is not available on any storage tier{}",
            if errors.is_empty() {
                String::new()
            } else {
                format!(" ({})", errors.join("; "))
            }
        )))
    }

    /// Like [`Self::get_file`], but a copy whose SHA-256 does not match is discarded and the next
    /// tier is tried. A bit-rotted local copy must not stop a restore a good copy could serve.
    pub async fn get_file_verified(
        &self,
        key: &str,
        dest_path: &Path,
        expected_sha256: &str,
    ) -> Result<String, StoreError> {
        let mut errors = Vec::new();
        for store in &self.stores {
            match store.exists(key).await {
                Ok(false) | Err(_) => continue,
                Ok(true) => {}
            }
            if let Err(error) = store.get_file(key, dest_path).await {
                errors.push(format!("{}: {error}", store.id()));
                continue;
            }
            match sha256_file(dest_path).await {
                Ok(actual) if actual == expected_sha256 => return Ok(store.id().to_owned()),
                Ok(_) => {
                    errors.push(format!("{}: ciphertext checksum mismatch", store.id()));
                }
                Err(error) => errors.push(format!("{}: {error}", store.id())),
            }
            let _ = fs::remove_file(dest_path).await;
        }
        Err(StoreError::Other(format!(
            "artifact {key} is missing or failed verification on every storage tier{}",
            if errors.is_empty() {
                String::new()
            } else {
                format!(" ({})", errors.join("; "))
            }
        )))
    }

    pub async fn get_buffer(&self, key: &str) -> Option<Vec<u8>> {
        for store in &self.stores {
            if let Ok(Some(buffer)) = store.get_buffer(key).await {
                return Some(buffer);
            }
        }
        None
    }

    /// Tier ids that do not currently hold `key` (used to repair a 3-2-1 repository).
    pub async fn missing_stores(&self, key: &str) -> Vec<String> {
        let mut missing = Vec::new();
        for store in &self.stores {
            match store.exists(key).await {
                Ok(true) => {}
                _ => missing.push(store.id().to_owned()),
            }
        }
        missing
    }

    /// Union of keys across tiers.
    pub async fn list(&self, prefix: &str) -> Vec<String> {
        let mut keys = BTreeSet::new();
        for store in &self.stores {
            if let Ok(entries) = store.list(prefix).await {
                keys.extend(entries);
            }
        }
        keys.into_iter().collect()
    }

    pub async fn list_by_store(&self, prefix: &str) -> BTreeMap<String, BTreeSet<String>> {
        let mut result = BTreeMap::new();
        for store in &self.stores {
            if let Ok(entries) = store.list(prefix).await {
                result.insert(store.id().to_owned(), entries.into_iter().collect());
            }
        }
        result
    }

    pub async fn delete(&self, key: &str) {
        for store in &self.stores {
            let _ = store.delete(key).await;
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedBucket {
    pub bucket: String,
    pub prefix: String,
}

/// `s3://bucket/some/prefix` or a bare `bucket` name.
#[must_use]
pub fn parse_bucket_spec(value: &str) -> ParsedBucket {
    let stripped = value.trim().trim_start_matches("s3://");
    let mut pieces = stripped.split('/');
    let bucket = pieces.next().unwrap_or_default().to_owned();
    let prefix = pieces
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("/");
    ParsedBucket { bucket, prefix }
}

/// Builds the configured storage tiers, in restore-preference order:
/// local repository -> S3/MinIO -> off-site vault.
pub fn build_repository(
    config: &Config,
    _runner: &dyn CommandRunner,
) -> Result<ArtifactRepository, StoreError> {
    let mut stores: Vec<std::sync::Arc<dyn ArtifactStore>> = Vec::new();
    if !config.local_repo_dir.is_empty() {
        stores.push(std::sync::Arc::new(LocalRepoStore::new(
            &config.local_repo_dir,
        )));
    }
    if !config.primary_s3_endpoint.is_empty() && !config.primary_s3_bucket.is_empty() {
        stores.push(std::sync::Arc::new(UnsupportedStore::s3()));
    }
    if config.secondary_ssh_target.is_some() {
        stores.push(std::sync::Arc::new(UnsupportedStore::ssh_vault()));
    }
    if stores.is_empty() {
        return Err(StoreError::Other(
            "no backup storage tier is configured: set BACKUP_LOCAL_REPO_DIR and/or \
             BACKUP_PRIMARY_S3_ENDPOINT + BACKUP_PRIMARY_S3_BUCKET"
                .to_owned(),
        ));
    }
    Ok(ArtifactRepository::new(stores))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artifact_keys_refuse_traversal_and_absolute_paths() {
        assert!(assert_safe_key("backups/postgres_core/a.tar.zst.enc").is_ok());
        assert!(assert_safe_key("wal/postgres_core/000000010000000000000001.zst.enc").is_ok());
        assert!(assert_safe_key("../escape").is_err());
        assert!(assert_safe_key("/absolute").is_err());
        assert!(assert_safe_key("a//b").is_err());
        assert!(assert_safe_key("").is_err());
    }

    #[test]
    fn bucket_specs_parse_both_forms() {
        assert_eq!(
            parse_bucket_spec("s3://bucket/prod/core"),
            ParsedBucket {
                bucket: "bucket".to_owned(),
                prefix: "prod/core".to_owned()
            }
        );
        assert_eq!(parse_bucket_spec("bucket").bucket, "bucket");
    }
}

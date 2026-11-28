//! Atomic filesystem blob store.
//!
//! Byte-identical semantics to the TS `FsBlobStore`: same bucket directories, same path rules,
//! atomic write through `tmp/<uuid>.part` with fsync then rename, mode 0640, the same `.trash`
//! layout and the same list/stat shapes.

#![forbid(unsafe_code)]

use std::path::{Component, Path, PathBuf};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::fs;
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum BucketTier {
    Hot,
    Cold,
    Quarantine,
}

impl BucketTier {
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.to_ascii_uppercase().as_str() {
            "HOT" => Some(Self::Hot),
            "COLD" => Some(Self::Cold),
            "QUARANTINE" => Some(Self::Quarantine),
            _ => None,
        }
    }

    #[must_use]
    pub fn dir_name(self) -> &'static str {
        match self {
            Self::Hot => "hot",
            Self::Cold => "cold",
            Self::Quarantine => "quarantine",
        }
    }

    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Hot => "HOT",
            Self::Cold => "COLD",
            Self::Quarantine => "QUARANTINE",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlobListEntry {
    pub bucket: String,
    #[serde(rename = "relPath")]
    pub rel_path: String,
    #[serde(rename = "byteSize")]
    pub byte_size: u64,
    #[serde(rename = "mtimeMs")]
    pub mtime_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BlobHealthReport {
    pub ok: bool,
    pub mode: String,
    #[serde(rename = "rootDirOrUrl")]
    pub root_dir_or_url: String,
    #[serde(rename = "freeBytes")]
    pub free_bytes: u64,
    #[serde(rename = "latencyMs")]
    pub latency_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("Unsafe storage relative path rejected: \"{0}\"")]
    UnsafePath(String),
    #[error("Path traversal outside bucket root rejected: {0}")]
    Traversal(String),
    #[error("Invalid storage bucket tier: {0}")]
    InvalidBucket(String),
    #[error("BLOB_NOT_FOUND")]
    NotFound,
    #[error("storage I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("request body exceeds {0} bytes")]
    BodyTooLarge(usize),
}

#[async_trait]
pub trait BlobStore: Send + Sync {
    async fn put(
        &self,
        bucket: BucketTier,
        rel_path: &str,
        data: &[u8],
    ) -> Result<(u64, String), StorageError>;
    async fn read_bytes(&self, bucket: BucketTier, rel_path: &str)
        -> Result<Vec<u8>, StorageError>;
    async fn stat(&self, bucket: BucketTier, rel_path: &str) -> Result<(bool, u64), StorageError>;
    async fn move_to_trash(
        &self,
        bucket: BucketTier,
        rel_path: &str,
        trash_date_iso: Option<&str>,
    ) -> Result<(), StorageError>;
    async fn purge_trash_older_than(&self, cutoff_date_iso: &str) -> Result<u64, StorageError>;
    async fn list(
        &self,
        bucket: BucketTier,
        prefix: &str,
    ) -> Result<Vec<BlobListEntry>, StorageError>;
    async fn health_check(&self) -> BlobHealthReport;
}

/// `sanitizeRelPath`: POSIX-normalise, strip leading slashes, reject `..`, `.` and NUL.
pub fn sanitize_rel_path(rel_path: &str) -> Result<String, StorageError> {
    if rel_path.contains('\0') {
        return Err(StorageError::UnsafePath(rel_path.to_owned()));
    }
    let mut parts: Vec<&str> = Vec::new();
    for part in rel_path.split('/') {
        match part {
            "" | "." => continue,
            ".." => return Err(StorageError::UnsafePath(rel_path.to_owned())),
            other => parts.push(other),
        }
    }
    if parts.is_empty() {
        return Err(StorageError::UnsafePath(rel_path.to_owned()));
    }
    Ok(parts.join("/"))
}

/// A filesystem blob store rooted at `root_dir`.
#[derive(Debug, Clone)]
pub struct FsBlobStore {
    root_dir: PathBuf,
}

impl FsBlobStore {
    pub async fn new(root_dir: impl Into<PathBuf>) -> Result<Self, StorageError> {
        let root_dir = root_dir.into();
        let absolute = std::path::absolute(&root_dir)?;
        let store = Self { root_dir: absolute };
        store.ensure_layout().await?;
        Ok(store)
    }

    pub async fn ensure_layout(&self) -> Result<(), StorageError> {
        for sub in ["hot", "cold", "quarantine", "tmp", ".trash"] {
            fs::create_dir_all(self.root_dir.join(sub)).await?;
        }
        Ok(())
    }

    #[must_use]
    pub fn root_dir(&self) -> &Path {
        &self.root_dir
    }

    fn resolve(&self, bucket: BucketTier, rel_path: &str) -> Result<PathBuf, StorageError> {
        let safe = sanitize_rel_path(rel_path)?;
        let bucket_root = self.root_dir.join(bucket.dir_name());
        let resolved = bucket_root.join(&safe);
        // Normalise lexically; no symlink resolution (the store never creates symlinks).
        let mut normalised = PathBuf::new();
        for component in resolved.components() {
            match component {
                Component::ParentDir => {
                    normalised.pop();
                }
                Component::CurDir => {}
                other => normalised.push(other.as_os_str()),
            }
        }
        if !normalised.starts_with(&bucket_root) {
            return Err(StorageError::Traversal(rel_path.to_owned()));
        }
        Ok(normalised)
    }
}

#[async_trait]
impl BlobStore for FsBlobStore {
    async fn put(
        &self,
        bucket: BucketTier,
        rel_path: &str,
        data: &[u8],
    ) -> Result<(u64, String), StorageError> {
        let target = self.resolve(bucket, rel_path)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).await?;
        }
        let tmp_path = self
            .root_dir
            .join("tmp")
            .join(format!("{}.part", Uuid::new_v4()));
        let mut file = tokio::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o640)
            .open(&tmp_path)
            .await?;
        file.write_all(data).await?;
        file.sync_all().await?;
        drop(file);
        // tokio::fs::rename replaces the target atomically on POSIX.
        if let Err(error) = fs::rename(&tmp_path, &target).await {
            let _ = fs::remove_file(&tmp_path).await;
            return Err(error.into());
        }
        let digest = Sha256::digest(data);
        Ok((data.len() as u64, hex::encode(digest)))
    }

    async fn read_bytes(
        &self,
        bucket: BucketTier,
        rel_path: &str,
    ) -> Result<Vec<u8>, StorageError> {
        let target = self.resolve(bucket, rel_path)?;
        match fs::read(&target).await {
            Ok(bytes) => Ok(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Err(StorageError::NotFound)
            }
            Err(error) => Err(error.into()),
        }
    }

    async fn stat(&self, bucket: BucketTier, rel_path: &str) -> Result<(bool, u64), StorageError> {
        let target = self.resolve(bucket, rel_path)?;
        match fs::metadata(&target).await {
            Ok(metadata) => Ok((metadata.is_file(), metadata.len())),
            Err(_) => Ok((false, 0)),
        }
    }

    async fn move_to_trash(
        &self,
        bucket: BucketTier,
        rel_path: &str,
        trash_date_iso: Option<&str>,
    ) -> Result<(), StorageError> {
        let target = self.resolve(bucket, rel_path)?;
        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
        let requested: String = trash_date_iso
            .unwrap_or(&today)
            .chars()
            .filter(|ch| ch.is_ascii_digit() || *ch == '-')
            .collect();
        let day = if valid_day(&requested) {
            requested
        } else {
            today
        };
        let safe = sanitize_rel_path(rel_path)?;
        let trash_target = self
            .root_dir
            .join(".trash")
            .join(day)
            .join(bucket.dir_name())
            .join(safe);
        if let Some(parent) = trash_target.parent() {
            fs::create_dir_all(parent).await?;
        }
        match fs::rename(&target, &trash_target).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    async fn purge_trash_older_than(&self, cutoff_date_iso: &str) -> Result<u64, StorageError> {
        let trash_root = self.root_dir.join(".trash");
        let mut entries = match fs::read_dir(&trash_root).await {
            Ok(entries) => entries,
            Err(_) => return Ok(0),
        };
        let mut purged = 0;
        while let Some(entry) = entries.next_entry().await? {
            let file_type = entry.file_type().await?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if file_type.is_dir() && valid_day(&name) && name.as_str() < cutoff_date_iso {
                fs::remove_dir_all(entry.path()).await?;
                purged += 1;
            }
        }
        Ok(purged)
    }

    async fn list(
        &self,
        bucket: BucketTier,
        prefix: &str,
    ) -> Result<Vec<BlobListEntry>, StorageError> {
        let bucket_root = self.root_dir.join(bucket.dir_name());
        let clean_prefix = if prefix.is_empty() {
            String::new()
        } else {
            sanitize_rel_path(prefix)?
        };
        let mut results = Vec::new();
        let mut stack = vec![bucket_root.clone()];
        while let Some(dir) = stack.pop() {
            let mut entries = match fs::read_dir(&dir).await {
                Ok(entries) => entries,
                Err(_) => continue,
            };
            while let Some(entry) = entries.next_entry().await? {
                let file_type = entry.file_type().await?;
                if file_type.is_dir() {
                    stack.push(entry.path());
                } else if file_type.is_file() {
                    let relative = entry
                        .path()
                        .strip_prefix(&bucket_root)
                        .map(|path| path.to_string_lossy().replace('\\', "/"))
                        .unwrap_or_default();
                    if !clean_prefix.is_empty() && !relative.starts_with(&clean_prefix) {
                        continue;
                    }
                    let metadata = entry.metadata().await?;
                    let mtime_ms = metadata
                        .modified()
                        .ok()
                        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|duration| duration.as_millis() as i64)
                        .unwrap_or(0);
                    results.push(BlobListEntry {
                        bucket: bucket.as_str().to_owned(),
                        rel_path: relative,
                        byte_size: metadata.len(),
                        mtime_ms,
                    });
                }
            }
        }
        results.sort_by(|left, right| left.rel_path.cmp(&right.rel_path));
        Ok(results)
    }

    async fn health_check(&self) -> BlobHealthReport {
        let started = std::time::Instant::now();
        let mode = "FS_LOCAL".to_owned();
        let root = self.root_dir.display().to_string();
        let probe_path = self
            .root_dir
            .join("tmp")
            .join(format!(".health-{}", Uuid::new_v4()));
        let result = async {
            fs::write(&probe_path, b"ok").await?;
            fs::remove_file(&probe_path).await?;
            Ok::<(), std::io::Error>(())
        }
        .await;
        let latency_ms = started.elapsed().as_secs_f64() * 1000.0;
        let latency_ms = (latency_ms * 100.0).round() / 100.0;
        match result {
            Ok(()) => BlobHealthReport {
                ok: true,
                mode,
                root_dir_or_url: root,
                free_bytes: free_bytes(&self.root_dir),
                latency_ms,
                error: None,
            },
            Err(error) => BlobHealthReport {
                ok: false,
                mode,
                root_dir_or_url: root,
                free_bytes: 0,
                latency_ms,
                error: Some(error.to_string()),
            },
        }
    }
}

fn valid_day(value: &str) -> bool {
    value.len() == 10
        && value.as_bytes()[4] == b'-'
        && value.as_bytes()[7] == b'-'
        && value
            .bytes()
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit())
}

fn free_bytes(path: &Path) -> u64 {
    // nix::sys::statvfs is safe and returns the same bavail * bsize value as the TS store.
    nix::sys::statvfs::statvfs(path)
        .map(|stat| stat.blocks_available().saturating_mul(stat.fragment_size()))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn put_read_stat_trash() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = FsBlobStore::new(dir.path()).await.expect("store");
        let (size, sha) = store
            .put(BucketTier::Hot, "2026/11/a.bin", b"hello")
            .await
            .expect("put");
        assert_eq!(size, 5);
        assert_eq!(
            sha,
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
        assert_eq!(
            store
                .read_bytes(BucketTier::Hot, "2026/11/a.bin")
                .await
                .expect("read"),
            b"hello"
        );
        assert_eq!(
            store
                .stat(BucketTier::Hot, "2026/11/a.bin")
                .await
                .expect("stat"),
            (true, 5)
        );
        store
            .move_to_trash(BucketTier::Hot, "2026/11/a.bin", Some("2026-11-01"))
            .await
            .expect("trash");
        assert!(matches!(
            store.read_bytes(BucketTier::Hot, "2026/11/a.bin").await,
            Err(StorageError::NotFound)
        ));
        let purged = store
            .purge_trash_older_than("2026-11-02")
            .await
            .expect("purge");
        assert_eq!(purged, 1);
    }

    #[test]
    fn rejects_traversal() {
        assert!(sanitize_rel_path("../etc/passwd").is_err());
        assert!(sanitize_rel_path("a/../b").is_err());
        assert!(sanitize_rel_path("/a//b/").is_ok());
    }
}

//! Remote blob store over mTLS (core → object-storage daemon).
//!
//! Port of `deploy/object-storage-daemon/src/shared/blobStore.ts` `RemoteMtlsBlobStore`.
//! The wire contract is the daemon's `/v1/*` API (chapter 2 §7).

#![forbid(unsafe_code)]

use std::path::Path;
use std::time::Instant;

use async_trait::async_trait;
use reqwest::{Client, StatusCode};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::blob_store::{BlobHealthReport, BlobListEntry, BlobStore, BucketTier, StorageError};

#[derive(Debug, Clone, Default)]
pub struct RemoteTlsConfig {
    pub ca_cert_path: Option<String>,
    pub client_cert_path: Option<String>,
    pub client_key_path: Option<String>,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone)]
pub struct RemoteMtlsBlobStore {
    base_url: String,
    client: Client,
    timeout_ms: u64,
}

#[derive(Debug, Deserialize)]
struct ListResponse {
    #[serde(default)]
    items: Vec<BlobListEntry>,
}

#[derive(Debug, Deserialize)]
struct PurgeResponse {
    #[serde(rename = "purgedCount", default)]
    purged_count: u64,
}

impl RemoteMtlsBlobStore {
    pub fn new(base_url: &str, tls: RemoteTlsConfig) -> Result<Self, StorageError> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let mut builder = Client::builder()
            .timeout(std::time::Duration::from_millis(if tls.timeout_ms == 0 {
                30_000
            } else {
                tls.timeout_ms
            }))
            .pool_idle_timeout(std::time::Duration::from_secs(90))
            .redirect(reqwest::redirect::Policy::none());
        if base_url.starts_with("https://") {
            let ca = required_path(&tls.ca_cert_path, "OBJECT_STORAGE_TLS_CA_PATH")?;
            let cert = required_path(&tls.client_cert_path, "OBJECT_STORAGE_TLS_CLIENT_CERT_PATH")?;
            let key = required_path(&tls.client_key_path, "OBJECT_STORAGE_TLS_CLIENT_KEY_PATH")?;
            let mut pem = std::fs::read(&cert)?;
            pem.extend_from_slice(&std::fs::read(&key)?);
            builder = builder
                .add_root_certificate(
                    reqwest::Certificate::from_pem(&std::fs::read(ca)?)
                        .map_err(|error| StorageError::Io(std::io::Error::other(error)))?,
                )
                .identity(
                    reqwest::Identity::from_pem(&pem)
                        .map_err(|error| StorageError::Io(std::io::Error::other(error)))?,
                )
                .min_tls_version(reqwest::tls::Version::TLS_1_3);
        }
        let client = builder
            .build()
            .map_err(|error| StorageError::Io(std::io::Error::other(error)))?;
        Ok(Self {
            base_url: base_url.trim_end_matches('/').to_owned(),
            client,
            timeout_ms: if tls.timeout_ms == 0 {
                30_000
            } else {
                tls.timeout_ms
            },
        })
    }

    fn url(&self, suffix: &str) -> String {
        format!("{}{}", self.base_url, suffix)
    }
}

fn required_path(value: &Option<String>, label: &str) -> Result<std::path::PathBuf, StorageError> {
    let path =
        value
            .as_deref()
            .filter(|path| !path.is_empty())
            .ok_or_else(|| {
                StorageError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("OBJECT_STORAGE_TLS_INCOMPLETE: {label} is required for an https daemon URL"),
        ))
            })?;
    let path = Path::new(path);
    if !path.is_file() {
        return Err(StorageError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("OBJECT_STORAGE_TLS_UNREADABLE: cannot read {label}"),
        )));
    }
    Ok(path.to_path_buf())
}

fn encode_segment(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(char::from(byte));
        } else {
            encoded.push('%');
            encoded.push_str(&format!("{byte:02X}"));
        }
    }
    encoded
}

fn encode_path(path: &str) -> String {
    path.split('/')
        .map(encode_segment)
        .collect::<Vec<_>>()
        .join("/")
}

fn io_error(message: String) -> StorageError {
    StorageError::Io(std::io::Error::other(message))
}

#[async_trait]
impl BlobStore for RemoteMtlsBlobStore {
    async fn put(
        &self,
        bucket: BucketTier,
        rel_path: &str,
        data: &[u8],
    ) -> Result<(u64, String), StorageError> {
        let safe = crate::blob_store::sanitize_rel_path(rel_path)?;
        let digest = Sha256::digest(data);
        let sha = hex::encode(digest);
        let response = self
            .client
            .put(self.url(&format!(
                "/v1/blobs/{}/{}",
                bucket.as_str(),
                encode_path(&safe)
            )))
            .header("content-type", "application/octet-stream")
            .header("x-content-sha256", &sha)
            .body(data.to_vec())
            .send()
            .await
            .map_err(|error| io_error(format!("RemoteMtlsBlobStore PUT failed: {error}")))?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(io_error(format!(
                "RemoteMtlsBlobStore PUT failed ({status}): {body}"
            )));
        }
        Ok((data.len() as u64, sha))
    }

    async fn read_bytes(
        &self,
        bucket: BucketTier,
        rel_path: &str,
    ) -> Result<Vec<u8>, StorageError> {
        let safe = crate::blob_store::sanitize_rel_path(rel_path)?;
        let response = self
            .client
            .get(self.url(&format!(
                "/v1/blobs/{}/{}",
                bucket.as_str(),
                encode_path(&safe)
            )))
            .send()
            .await
            .map_err(|error| io_error(format!("RemoteMtlsBlobStore GET failed: {error}")))?;
        if response.status() == StatusCode::NOT_FOUND {
            return Err(StorageError::NotFound);
        }
        if !response.status().is_success() {
            let status = response.status();
            return Err(io_error(format!(
                "RemoteMtlsBlobStore GET failed ({status})"
            )));
        }
        response
            .bytes()
            .await
            .map(|bytes| bytes.to_vec())
            .map_err(|error| io_error(format!("RemoteMtlsBlobStore GET body failed: {error}")))
    }

    async fn stat(&self, bucket: BucketTier, rel_path: &str) -> Result<(bool, u64), StorageError> {
        let safe = crate::blob_store::sanitize_rel_path(rel_path)?;
        let response = self
            .client
            .head(self.url(&format!(
                "/v1/blobs/{}/{}",
                bucket.as_str(),
                encode_path(&safe)
            )))
            .send()
            .await
            .map_err(|error| io_error(format!("RemoteMtlsBlobStore HEAD failed: {error}")))?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok((false, 0));
        }
        if !response.status().is_success() {
            return Err(io_error(format!(
                "RemoteMtlsBlobStore HEAD failed ({})",
                response.status()
            )));
        }
        let size = response
            .headers()
            .get("x-blob-byte-size")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .or_else(|| response.content_length())
            .unwrap_or(0);
        Ok((true, size))
    }

    async fn move_to_trash(
        &self,
        bucket: BucketTier,
        rel_path: &str,
        trash_date_iso: Option<&str>,
    ) -> Result<(), StorageError> {
        let safe = crate::blob_store::sanitize_rel_path(rel_path)?;
        let response = self
            .client
            .post(self.url(&format!(
                "/v1/trash/{}/{}",
                bucket.as_str(),
                encode_path(&safe)
            )))
            .json(&serde_json::json!({ "trashDateIso": trash_date_iso }))
            .send()
            .await
            .map_err(|error| io_error(format!("RemoteMtlsBlobStore trash failed: {error}")))?;
        if !response.status().is_success() {
            return Err(io_error(format!(
                "RemoteMtlsBlobStore trash failed ({})",
                response.status()
            )));
        }
        Ok(())
    }

    async fn purge_trash_older_than(&self, cutoff_date_iso: &str) -> Result<u64, StorageError> {
        let response = self
            .client
            .post(self.url("/v1/purge-trash"))
            .json(&serde_json::json!({ "cutoffDateIso": cutoff_date_iso }))
            .send()
            .await
            .map_err(|error| io_error(format!("RemoteMtlsBlobStore purge failed: {error}")))?;
        if !response.status().is_success() {
            return Err(io_error(format!(
                "RemoteMtlsBlobStore purge failed ({})",
                response.status()
            )));
        }
        let parsed: PurgeResponse = response
            .json()
            .await
            .map_err(|error| io_error(format!("RemoteMtlsBlobStore purge response: {error}")))?;
        Ok(parsed.purged_count)
    }

    async fn list(
        &self,
        bucket: BucketTier,
        prefix: &str,
    ) -> Result<Vec<BlobListEntry>, StorageError> {
        let mut url = self.url(&format!("/v1/list/{}", bucket.as_str()));
        if !prefix.is_empty() {
            url.push_str("?prefix=");
            url.push_str(&encode_segment(prefix));
        }
        let response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|error| io_error(format!("RemoteMtlsBlobStore list failed: {error}")))?;
        if !response.status().is_success() {
            return Err(io_error(format!(
                "RemoteMtlsBlobStore list failed ({})",
                response.status()
            )));
        }
        let parsed: ListResponse = response
            .json()
            .await
            .map_err(|error| io_error(format!("RemoteMtlsBlobStore list response: {error}")))?;
        Ok(parsed.items)
    }

    async fn health_check(&self) -> BlobHealthReport {
        let started = Instant::now();
        let base = BlobHealthReport {
            ok: false,
            mode: "REMOTE_MTLS".to_owned(),
            root_dir_or_url: self.base_url.clone(),
            free_bytes: 0,
            latency_ms: 0.0,
            error: None,
        };
        let result = async {
            let response = self
                .client
                .get(self.url("/v1/health"))
                .send()
                .await
                .map_err(|error| error.to_string())?;
            if !response.status().is_success() {
                return Err(format!("HTTP {}", response.status()));
            }
            let value: serde_json::Value =
                response.json().await.map_err(|error| error.to_string())?;
            let ok = value
                .get("ok")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            let free = value
                .get("freeBytes")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0);
            Ok::<(bool, u64), String>((ok, free))
        }
        .await;
        let latency_ms = started.elapsed().as_secs_f64() * 1000.0;
        let latency_ms = (latency_ms * 100.0).round() / 100.0;
        match result {
            Ok((ok, free)) => BlobHealthReport {
                ok,
                free_bytes: free,
                latency_ms,
                error: (!ok).then(|| "daemon reported unhealthy".to_owned()),
                ..base
            },
            Err(error) => BlobHealthReport {
                latency_ms,
                error: Some(error),
                ..base
            },
        }
    }
}

impl RemoteMtlsBlobStore {
    #[must_use]
    pub fn timeout_ms(&self) -> u64 {
        self.timeout_ms
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_paths_without_losing_segments() {
        assert_eq!(encode_path("2026/11/a b.png"), "2026/11/a%20b.png");
        assert_eq!(encode_path("a+b"), "a%2Bb");
    }
}

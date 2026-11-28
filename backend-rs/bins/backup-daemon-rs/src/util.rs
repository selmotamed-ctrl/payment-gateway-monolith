//! Small shared helpers. Port of `deploy/backup-daemon/src/util.ts`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use chrono::{DateTime, Utc};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::fs;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::crypto::CryptoError;

/// Deterministic JSON with sorted object keys, mirroring `stableJson` in the TS daemon
/// (and `core-back`'s audit adapter). Object keys are omitted when they hold `undefined`;
/// JSON has no `undefined`, so only `null` remains and is preserved.
pub fn stable_json(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        Value::String(text) => serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_owned()),
        Value::Array(entries) => {
            let rendered: Vec<String> = entries.iter().map(stable_json).collect();
            format!("[{}]", rendered.join(","))
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let rendered: Vec<String> = keys
                .into_iter()
                .map(|key| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_owned()),
                        stable_json(&map[key])
                    )
                })
                .collect();
            format!("{{{}}}", rendered.join(","))
        }
    }
}

/// `error instanceof Error ? error.message : String(error)`.
pub fn error_message(error: &dyn std::error::Error) -> String {
    error.to_string()
}

pub fn is_not_found(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::NotFound
}

pub async fn path_exists(path: &Path) -> bool {
    fs::metadata(path).await.is_ok()
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Unique sibling path for atomic writes (`.<name>.<pid>.<n>.tmp`).
pub fn temp_sibling(path: &Path) -> PathBuf {
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "artifact".to_owned());
    let temp = format!(".{}.{}.{}.tmp", name, std::process::id(), counter);
    path.with_file_name(temp)
}

/// Writes a small file atomically (temp + fsync + rename), mode 0600.
pub async fn write_file_atomic(path: &Path, data: &[u8]) -> Result<(), std::io::Error> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    let tmp = temp_sibling(path);
    {
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            options.mode(0o600);
        }
        let mut file = options.open(&tmp).await?;
        file.write_all(data).await?;
        file.sync_all().await?;
    }
    match fs::rename(&tmp, path).await {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = fs::remove_file(&tmp).await;
            Err(error)
        }
    }
}

/// SHA-256 hex of a file, streamed in 64 KiB chunks.
pub async fn sha256_file(path: &Path) -> Result<String, CryptoError> {
    let mut file = fs::File::open(path)
        .await
        .map_err(|error| CryptoError::Io(error.to_string()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .await
            .map_err(|error| CryptoError::Io(error.to_string()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

pub fn backup_id_stamp(date: DateTime<Utc>) -> String {
    // `toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")`
    let iso = date.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let without_dashes = iso.replace(['-', ':'], "");
    without_dashes.replacen(".000Z", "Z", 1)
}

/// `bkp_20261106T020000Z_core_full`
pub fn make_backup_id(date: DateTime<Utc>, short: &str, kind: &str) -> String {
    format!("bkp_{}_{short}_{kind}", backup_id_stamp(date))
}

/// Random bytes from `/dev/urandom` (the workspace has no `rand` dependency in this crate).
pub fn random_bytes(length: usize) -> Result<Vec<u8>, CryptoError> {
    use std::io::Read;
    let mut file = std::fs::File::open("/dev/urandom")
        .map_err(|error| CryptoError::Io(format!("/dev/urandom: {error}")))?;
    let mut buffer = vec![0_u8; length];
    file.read_exact(&mut buffer)
        .map_err(|error| CryptoError::Io(format!("/dev/urandom: {error}")))?;
    Ok(buffer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn stable_json_sorts_nested_keys_and_keeps_array_order() {
        let value = json!({"b": 1, "a": {"d": [3, 1], "c": "x"}});
        assert_eq!(stable_json(&value), r#"{"a":{"c":"x","d":[3,1]},"b":1}"#);
    }

    #[test]
    fn backup_ids_match_the_ts_shape() {
        let date = DateTime::parse_from_rfc3339("2026-11-06T02:00:00.000Z")
            .expect("date")
            .with_timezone(&Utc);
        assert_eq!(
            make_backup_id(date, "core", "full"),
            "bkp_20261106T020000Z_core_full"
        );
    }
}

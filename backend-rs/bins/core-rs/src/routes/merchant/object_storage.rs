//! The small read path of the shared object-storage vault used by the merchant attachment download.
//!
//! `readAuthorized` (`core-back/lib/objectStorageSdk/index.ts:492`) is a large control-plane port
//! (lock, tenant, authority, quarantine, GC, access log, pgos1 decrypt). This module implements the
//! read half a merchant session needs, with the same checks, error codes and audit rows, using the
//! shared `pg-objstore` blob store and `pgos1` envelope. It never returns or logs the storage key.

#![forbid(unsafe_code)]

use pg_objstore::blob_store::{BlobStore, BucketTier, FsBlobStore};
use pg_objstore::pgos1::{self, KekKeyring, ObjectCryptoMetadata};
use pg_objstore::remote::{RemoteMtlsBlobStore, RemoteTlsConfig};
use sqlx::Row;
use uuid::Uuid;

use pg_http::ApiError;

use super::super::common::database_error;
use crate::state::AppState;

/// The row the download path needs; the storage key never leaves this module.
#[derive(Debug)]
pub struct ObjectRow {
    pub id: Uuid,
    pub bucket: BucketTier,
    pub storage_key: String,
    pub status: String,
    pub sha256_hex: String,
    pub byte_size: i64,
    pub chunk_size: u64,
    pub chunk_count: u64,
    pub detected_mime_type: String,
    pub original_filename: Option<String>,
    pub kek_key_version: u32,
    pub wrapped_dek: Vec<u8>,
    pub dek_nonce: Vec<u8>,
    pub stream_nonce_prefix: Vec<u8>,
    pub owner_merchant_id: Option<Uuid>,
    pub required_authority: String,
    pub confidentiality_tier: String,
    pub gc_claim_token: Option<Uuid>,
}

/// Load a storage object by id.
pub async fn load_object(state: &AppState, object_id: Uuid) -> Result<Option<ObjectRow>, ApiError> {
    let row = sqlx::query(
        "SELECT bucket::text AS bucket, storage_key, status::text AS status, sha256_hex, byte_size, \
                chunk_size_bytes, chunk_count, detected_mime_type, original_filename, \
                kek_key_version, wrapped_dek, dek_nonce, stream_nonce_prefix, owner_merchant_id, \
                required_authority, confidentiality_tier, gc_claim_token \
           FROM storage_objects WHERE id = $1",
    )
    .bind(object_id)
    .fetch_optional(&state.pools.main)
    .await
    .map_err(database_error)?;
    let Some(row) = row else {
        return Ok(None);
    };
    let bucket_raw: String = row.get("bucket");
    let Some(bucket) = BucketTier::parse(&bucket_raw) else {
        return Err(ApiError::server_error());
    };
    Ok(Some(ObjectRow {
        id: object_id,
        bucket,
        storage_key: row.get("storage_key"),
        status: row.get("status"),
        sha256_hex: row.get("sha256_hex"),
        byte_size: row.get("byte_size"),
        chunk_size: row
            .try_get::<i32, _>("chunk_size_bytes")
            .map(|value| value.max(0) as u64)
            .unwrap_or_default(),
        chunk_count: row
            .try_get::<i32, _>("chunk_count")
            .map(|value| value.max(0) as u64)
            .unwrap_or_default(),
        detected_mime_type: row.get("detected_mime_type"),
        original_filename: row.get("original_filename"),
        kek_key_version: row
            .try_get::<i32, _>("kek_key_version")
            .map(|value| value.max(0) as u32)
            .unwrap_or(1),
        wrapped_dek: row.get("wrapped_dek"),
        dek_nonce: row.get("dek_nonce"),
        stream_nonce_prefix: row.get("stream_nonce_prefix"),
        owner_merchant_id: row.get("owner_merchant_id"),
        required_authority: row.get("required_authority"),
        confidentiality_tier: row.get("confidentiality_tier"),
        gc_claim_token: row.get("gc_claim_token"),
    }))
}

/// True when the object carries an active lock for the domain record.
pub async fn has_active_lock(
    state: &AppState,
    object_id: Uuid,
    holder_type: &str,
    holder_id: &str,
) -> Result<bool, ApiError> {
    let exists: Option<i32> = sqlx::query_scalar(
        "SELECT 1 FROM storage_object_locks \
          WHERE object_id = $1 AND holder_type = $2 AND holder_id = $3 AND released_at IS NULL \
          LIMIT 1",
    )
    .bind(object_id)
    .bind(holder_type)
    .bind(holder_id)
    .fetch_optional(&state.pools.main)
    .await
    .map_err(database_error)?;
    Ok(exists.is_some())
}

/// One best-effort access-log row (`writeAccessLog` in the TS SDK).
pub struct AccessLogEntry<'a> {
    pub object_id: Uuid,
    pub actor_type: &'a str,
    pub actor_id: &'a str,
    pub action: &'a str,
    pub allowed: bool,
    pub denial_reason: Option<&'a str>,
    pub holder_type: Option<&'a str>,
    pub holder_id: Option<&'a str>,
    pub ip_address: Option<&'a str>,
    pub request_id: Option<&'a str>,
    pub bytes_served: Option<i64>,
}

/// Best-effort access log row (an audit failure never breaks a read, like the TS `writeAccessLog`).
pub async fn write_access_log(state: &AppState, entry: &AccessLogEntry<'_>) {
    let _ = sqlx::query(
        "INSERT INTO storage_object_access_logs \
            (object_id, actor_type, actor_id, action, allowed, denial_reason, holder_type, holder_id, \
             ip_address, request_id, bytes_served) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
    )
    .bind(entry.object_id)
    .bind(entry.actor_type)
    .bind(entry.actor_id)
    .bind(entry.action)
    .bind(entry.allowed)
    .bind(entry.denial_reason)
    .bind(entry.holder_type)
    .bind(entry.holder_id)
    .bind(entry.ip_address)
    .bind(entry.request_id)
    .bind(entry.bytes_served)
    .execute(&state.pools.main)
    .await;
}

/// `Content-Disposition` (RFC 6266 + RFC 5987), copied from `lib/contentDisposition.ts`.
#[must_use]
pub fn content_disposition(kind: &str, file_name: Option<&str>, fallback_name: &str) -> String {
    let raw = file_name.unwrap_or_default();
    let cleaned: String = raw
        .chars()
        .map(|ch| {
            if ch <= '\u{1f}' || ch == '\u{7f}' {
                ' '
            } else {
                ch
            }
        })
        .collect();
    let last = cleaned
        .split(['\\', '/'])
        .next_back()
        .unwrap_or_default()
        .trim()
        .chars()
        .take(200)
        .collect::<String>();
    let name = if last.is_empty() {
        fallback_name.to_owned()
    } else {
        last
    };
    let mut ascii = String::with_capacity(name.len());
    for ch in name.chars() {
        let unsafe_char = !(' '..='~').contains(&ch)
            || matches!(ch, '"' | '\\' | '/' | ':' | '*' | '?' | '<' | '>' | '|');
        ascii.push(if unsafe_char { '_' } else { ch });
    }
    while ascii.contains("__") {
        ascii = ascii.replace("__", "_");
    }
    let extension = ascii
        .rfind('.')
        .filter(|index| {
            let tail = &ascii[index + 1..];
            !tail.is_empty() && tail.len() <= 8 && tail.chars().all(|ch| ch.is_ascii_alphanumeric())
        })
        .map(|index| ascii[index..].to_owned())
        .unwrap_or_default();
    let stem_len = ascii.len().saturating_sub(extension.len());
    let ascii_name = if ascii[..stem_len]
        .chars()
        .any(|ch| ch.is_ascii_alphanumeric())
    {
        ascii.clone()
    } else {
        format!("{fallback_name}{extension}")
    };
    let base = format!("{kind}; filename=\"{ascii_name}\"");
    if ascii_name == name {
        base
    } else {
        format!("{base}; filename*=UTF-8''{}", encode_rfc5987(&name))
    }
}

/// `encodeURIComponent` with the RFC 5987 `attr-char` exclusions.
fn encode_rfc5987(value: &str) -> String {
    let mut out = String::new();
    for byte in value.as_bytes() {
        let ch = *byte as char;
        let unreserved = ch.is_ascii_alphanumeric()
            || matches!(ch, '-' | '_' | '.' | '!' | '~' | '*' | '\'' | '(' | ')');
        if unreserved && !matches!(ch, '*' | '\'' | '(' | ')') {
            out.push(ch);
        } else {
            out.push('%');
            out.push_str(&format!("{byte:02X}"));
        }
    }
    out
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = chunk.get(1).copied().map(u32::from).unwrap_or(0);
        let b2 = chunk.get(2).copied().map(u32::from).unwrap_or(0);
        let value = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((value >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((value >> 12) & 0x3f) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((value >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(value & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
pub(crate) fn base64_decode(value: &str) -> Option<Vec<u8>> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut lookup = [255_u8; 256];
    for (index, byte) in TABLE.iter().enumerate() {
        lookup[*byte as usize] = index as u8;
    }
    let mut out = Vec::new();
    let mut buffer: u32 = 0;
    let mut bits = 0_u32;
    for byte in value.bytes() {
        if byte == b'=' {
            break;
        }
        let index = lookup[byte as usize];
        if index == 255 {
            return None;
        }
        buffer = (buffer << 6) | u32::from(index);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    Some(out)
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn keyring(state: &AppState) -> Result<KekKeyring, ApiError> {
    let spec = std::env::var("OBJECT_STORAGE_KEK_KEYRING")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    let active = std::env::var("OBJECT_STORAGE_ACTIVE_KEK_VERSION")
        .ok()
        .and_then(|value| value.trim().parse::<u32>().ok())
        .filter(|value| *value >= 1);
    if let Some(spec) = spec {
        return KekKeyring::parse(&spec, active).map_err(|_| ApiError::server_error());
    }
    if std::env::var("NODE_ENV").as_deref() == Ok("production") {
        return Err(ApiError::server_error());
    }
    let database_url = state.config.database.primary.url.as_str();
    let key = pgos1::dev_kek_from_database_url(database_url);
    KekKeyring::parse(&format!("v1:{}", hex_encode(&key)), Some(1))
        .map_err(|_| ApiError::server_error())
}

/// Read and decrypt one object from the shared store.
pub async fn read_object(state: &AppState, object: &ObjectRow) -> Result<Vec<u8>, ApiError> {
    let daemon = std::env::var("OBJECT_STORAGE_DAEMON_URL")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    let timeout = std::env::var("OBJECT_STORAGE_DAEMON_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(30_000);
    let ciphertext = if let Some(base_url) = daemon {
        let tls = RemoteTlsConfig {
            ca_cert_path: std::env::var("OBJECT_STORAGE_TLS_CA_PATH").ok(),
            client_cert_path: std::env::var("OBJECT_STORAGE_TLS_CLIENT_CERT_PATH").ok(),
            client_key_path: std::env::var("OBJECT_STORAGE_TLS_CLIENT_KEY_PATH").ok(),
            timeout_ms: timeout,
        };
        let store =
            RemoteMtlsBlobStore::new(&base_url, tls).map_err(|_| ApiError::server_error())?;
        store
            .read_bytes(object.bucket, &object.storage_key)
            .await
            .map_err(|error| blob_error(error, object.id))?
    } else {
        let root = std::env::var("OBJECT_STORAGE_ROOT_DIR")
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "/tmp/pg-object-storage-dev".to_owned());
        let store = FsBlobStore::new(root)
            .await
            .map_err(|error| blob_error(error, object.id))?;
        store
            .read_bytes(object.bucket, &object.storage_key)
            .await
            .map_err(|error| blob_error(error, object.id))?
    };
    let keyring = keyring(state)?;
    let metadata = ObjectCryptoMetadata {
        kek_version: object.kek_key_version,
        wrapped_dek: base64_encode(&object.wrapped_dek),
        dek_nonce: base64_encode(&object.dek_nonce),
        stream_prefix: base64_encode(&object.stream_nonce_prefix),
        chunk_size: object.chunk_size,
        chunk_count: object.chunk_count,
        plaintext_sha256: object.sha256_hex.clone(),
        plaintext_size: object.byte_size.max(0) as u64,
    };
    pgos1::decrypt_pgos1(object.id, &ciphertext, &keyring, &metadata)
        .map_err(|_| ApiError::server_error())
}

fn blob_error(error: pg_objstore::StorageError, object_id: Uuid) -> ApiError {
    match error {
        pg_objstore::StorageError::NotFound => ApiError::new(
            500,
            "STORAGE_INTEGRITY_CORRUPTED",
            format!("The encrypted blob for object {object_id} is missing from the vault"),
        ),
        _ => ApiError::server_error(),
    }
}

/// The status gate of `readAuthorized` (quarantine 423, purged/staging 409).
#[must_use]
pub fn status_error(status: &str, object_id: Uuid) -> Option<ApiError> {
    if matches!(status, "QUARANTINE_PENDING_AV" | "QUARANTINE_REJECTED") {
        return Some(ApiError::new(
            423,
            "STORAGE_OBJECT_QUARANTINED",
            format!("Object {object_id} cannot be downloaded while in {status} state"),
        ));
    }
    if status != "ACTIVE" {
        return Some(if status == "PURGED" {
            ApiError::new(
                409,
                "STORAGE_OBJECT_PURGED",
                format!("Object {object_id} is purged"),
            )
        } else {
            ApiError::new(
                409,
                "STORAGE_OBJECT_STAGING_NOT_READY",
                format!("Object {object_id} is in {status} state"),
            )
        });
    }
    None
}

/// Kept for symmetry with the TS SDK; the merchant vault has no super-admin principal.
#[must_use]
pub fn allowed_for_merchant(authorities: &[String], confidentiality_tier: &str) -> bool {
    if confidentiality_tier == "PUBLIC_BRAND" {
        return true;
    }
    ["disputes:read", "dispute:read", "dispute:respond"]
        .iter()
        .any(|authority| authorities.iter().any(|held| held == authority))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_disposition_matches_the_ts_helper() {
        assert_eq!(
            content_disposition("attachment", Some("evidence.pdf"), "evidence"),
            "attachment; filename=\"evidence.pdf\""
        );
        assert_eq!(
            content_disposition("attachment", Some("../../etc/passwd"), "evidence"),
            "attachment; filename=\"passwd\""
        );
        assert_eq!(
            content_disposition("attachment", Some("a\"b:c*d?e<f>g|h.txt"), "evidence"),
            "attachment; filename=\"a_b_c_d_e_f_g_h.txt\"; filename*=UTF-8''a%22b%3Ac%2Ad%3Fe%3Cf%3Eg%7Ch.txt"
        );
        let arabic = content_disposition("attachment", Some("تقرير.pdf"), "evidence");
        assert_eq!(
            arabic,
            "attachment; filename=\"evidence.pdf\"; filename*=UTF-8''%D8%AA%D9%82%D8%B1%D9%8A%D8%B1.pdf"
        );
        assert_eq!(
            content_disposition("attachment", None, "evidence"),
            "attachment; filename=\"evidence\""
        );
    }

    #[test]
    fn base64_round_trip_for_test_fixtures() {
        let bytes = b"pgos1 test bytes";
        assert_eq!(
            base64_decode(&base64_encode(bytes)).as_deref(),
            Some(&bytes[..])
        );
    }
}

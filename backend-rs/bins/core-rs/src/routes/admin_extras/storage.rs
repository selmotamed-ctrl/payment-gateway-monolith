//! Authorized object reads for the file-bytes admin routes.
//!
//! Port of `core-back/lib/objectStorageSdk` `routeClient.readAuthorized` as used by
//! `admin.ts:3418` (KYB content), `admin.ts:16982` (catalog asset content), `admin.ts:18001`
//! (dispute evidence) and `admin.ts:17426` (reconciliation statement): status gates, an active
//! holder lock, namespace/row authority and `pgos1` decryption, with an append-only
//! `storage_object_access_logs` row for every decision.
//!
//! The control-plane columns are read from the core pool; blob bytes come from the shared vault
//! (`OBJECT_STORAGE_DAEMON_URL`, mTLS) or the local filesystem store. Neither the storage key nor a
//! wrapped key ever appears in a response or a log line; a failure becomes the same
//! `503 STORAGE_OBJECT_UNAVAILABLE` envelope the SDK produces.

#![forbid(unsafe_code)]

use pg_domain_auth::Principal;
use pg_objstore::{
    decrypt_pgos1, BlobStore, BucketTier, FsBlobStore, KekKeyring, ObjectCryptoMetadata,
    RemoteMtlsBlobStore, RemoteTlsConfig, StorageNamespace,
};
use sqlx::postgres::PgRow;
use sqlx::{PgPool, Row};
use uuid::Uuid;

use pg_http::ApiError;

const STORAGE_OBJECT_PROJECTION: &str = "id, bucket::text AS bucket, namespace::text AS namespace, \
    storage_key, status::text AS status, sha256_hex, byte_size, chunk_size_bytes, chunk_count, \
    detected_mime_type, original_filename, kek_key_version, wrapped_dek, dek_nonce, \
    stream_nonce_prefix, owner_merchant_id, required_authority, confidentiality_tier, gc_claim_token";

/// The decrypted bytes and the metadata a content route renders into headers.
pub(crate) struct StoredObject {
    pub bytes: Vec<u8>,
    pub mime_type: String,
    pub original_filename: Option<String>,
    pub sha256_hex: String,
}

#[derive(Debug, Clone)]
struct StorageObjectRow {
    id: Uuid,
    bucket: String,
    namespace: String,
    storage_key: String,
    status: String,
    sha256_hex: String,
    byte_size: i64,
    chunk_size_bytes: i32,
    chunk_count: i32,
    detected_mime_type: String,
    original_filename: Option<String>,
    kek_key_version: i32,
    wrapped_dek: Vec<u8>,
    dek_nonce: Vec<u8>,
    stream_nonce_prefix: Vec<u8>,
    owner_merchant_id: Option<Uuid>,
    required_authority: String,
    confidentiality_tier: String,
    gc_claim_token: Option<Uuid>,
}

impl StorageObjectRow {
    fn from_row(row: &PgRow) -> Result<Self, ApiError> {
        Ok(Self {
            id: get(row, "id")?,
            bucket: get(row, "bucket")?,
            namespace: get(row, "namespace")?,
            storage_key: get(row, "storage_key")?,
            status: get(row, "status")?,
            sha256_hex: get(row, "sha256_hex")?,
            byte_size: get(row, "byte_size")?,
            chunk_size_bytes: get(row, "chunk_size_bytes")?,
            chunk_count: get(row, "chunk_count")?,
            detected_mime_type: get(row, "detected_mime_type")?,
            original_filename: opt_get(row, "original_filename")?,
            kek_key_version: get(row, "kek_key_version")?,
            wrapped_dek: get(row, "wrapped_dek")?,
            dek_nonce: get(row, "dek_nonce")?,
            stream_nonce_prefix: get(row, "stream_nonce_prefix")?,
            owner_merchant_id: opt_get(row, "owner_merchant_id")?,
            required_authority: get(row, "required_authority")?,
            confidentiality_tier: get(row, "confidentiality_tier")?,
            gc_claim_token: opt_get(row, "gc_claim_token")?,
        })
    }
}

fn get<'r, T>(row: &'r PgRow, column: &str) -> Result<T, ApiError>
where
    T: sqlx::Decode<'r, sqlx::Postgres> + sqlx::Type<sqlx::Postgres>,
{
    row.try_get(column).map_err(|error| {
        tracing::error!(column, error = %error, "storage object row could not be decoded");
        ApiError::server_error()
    })
}

fn opt_get<'r, T>(row: &'r PgRow, column: &str) -> Result<Option<T>, ApiError>
where
    T: sqlx::Decode<'r, sqlx::Postgres> + sqlx::Type<sqlx::Postgres>,
{
    row.try_get(column).map_err(|error| {
        tracing::error!(column, error = %error, "storage object row could not be decoded");
        ApiError::server_error()
    })
}

/// Read a storage object the way `routeClient.readAuthorized` does.
pub(crate) async fn read_authorized(
    pool: &PgPool,
    principal: Option<&Principal>,
    object_id: Uuid,
    holder_type: &str,
    holder_id: &str,
    ip_address: Option<&str>,
    request_id: Option<&str>,
) -> Result<StoredObject, ApiError> {
    let row = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {STORAGE_OBJECT_PROJECTION}, (SELECT count(*) FROM storage_object_locks l \
          WHERE l.object_id = storage_objects.id AND l.released_at IS NULL \
            AND l.holder_type = $2 AND l.holder_id = $3) AS matching_locks \
         FROM storage_objects WHERE id = $1"
    )))
    .bind(object_id)
    .bind(holder_type)
    .bind(holder_id)
    .fetch_optional(pool)
    .await
    .map_err(super::support::database_error)?
    .ok_or_else(|| {
        ApiError::new(
            404,
            "STORAGE_OBJECT_NOT_FOUND",
            format!("Object {object_id} not found"),
        )
    })?;
    let object = StorageObjectRow::from_row(&row)?;
    let matching_locks = get::<i64>(&row, "matching_locks")?;
    let authorities = principal
        .map(|principal| principal.authorities.clone())
        .unwrap_or_default();

    let deny = |action: &'static str, status: u16, code: &'static str, message: String| {
        let pool = pool.clone();
        let actor_id = actor_id(principal);
        let holder_type = holder_type.to_owned();
        let holder_id = holder_id.to_owned();
        let ip = ip_address.map(str::to_owned);
        let request = request_id.map(str::to_owned);
        async move {
            let _ = write_access_log(
                &pool,
                object_id,
                "ADMIN",
                &actor_id,
                action,
                false,
                Some(&message),
                Some(&holder_type),
                Some(&holder_id),
                ip.as_deref(),
                request.as_deref(),
                None,
            )
            .await;
            ApiError::new(status, code, message)
        }
    };

    match object.status.as_str() {
        "QUARANTINE_PENDING_AV" | "QUARANTINE_REJECTED" => {
            return Err(deny(
                "READ_DENIED_QUARANTINE",
                423,
                "STORAGE_OBJECT_QUARANTINED",
                format!(
                    "Object {} cannot be downloaded while in {} state",
                    object.id, object.status
                ),
            )
            .await)
        }
        "ACTIVE" => {}
        "PURGED" => {
            return Err(deny(
                "READ_DENIED_STATUS",
                409,
                "STORAGE_OBJECT_PURGED",
                format!("Object {} is in {} state", object.id, object.status),
            )
            .await)
        }
        _ => {
            return Err(deny(
                "READ_DENIED_STATUS",
                409,
                "STORAGE_OBJECT_STAGING_NOT_READY",
                format!("Object {} is in {} state", object.id, object.status),
            )
            .await)
        }
    }
    if object.gc_claim_token.is_some() {
        return Err(deny(
            "READ_DENIED_GC_CLAIM",
            409,
            "STORAGE_OBJECT_GC_IN_PROGRESS",
            format!("Object {} is being collected", object.id),
        )
        .await);
    }
    if matching_locks == 0 {
        return Err(deny(
            "READ_DENIED_HOLDER_MISMATCH",
            403,
            "STORAGE_ACCESS_DENIED",
            "Requested object is not bound to the specified domain record".to_owned(),
        )
        .await);
    }
    if let Some(owner) = object.owner_merchant_id {
        if let Some(merchant) = principal.and_then(|principal| principal.merchant_id.as_deref()) {
            if merchant != owner.to_string() {
                return Err(deny(
                    "READ_DENIED_TENANT_MISMATCH",
                    403,
                    "STORAGE_TENANT_MISMATCH",
                    "Cross-tenant access to storage object is forbidden".to_owned(),
                )
                .await);
            }
        }
    }
    let has_super_admin = authorities
        .iter()
        .any(|authority| authority == "*" || authority == "system:storage:admin");
    let accepted: Vec<&str> = StorageNamespace::all()
        .into_iter()
        .find(|namespace| namespace.as_str() == object.namespace)
        .map(|namespace| namespace.policy().required_authorities.to_vec())
        .unwrap_or_default();
    let has_authority = has_super_admin
        || object.confidentiality_tier == "PUBLIC_BRAND"
        || accepted
            .iter()
            .any(|authority| authorities.iter().any(|held| held.as_str() == *authority))
        || authorities
            .iter()
            .any(|held| held == &object.required_authority);
    if !has_authority {
        return Err(deny(
            "READ_DENIED_AUTHORITY",
            403,
            "STORAGE_ACCESS_DENIED",
            format!(
                "Actor lacks required authority \"{}\" to read object {}",
                object.required_authority, object.id
            ),
        )
        .await);
    }

    let bytes = read_blob_bytes(&object).await.map_err(|error| {
        tracing::error!(object = %object.id, error = %error, "object-storage read failed");
        ApiError::new(
            503,
            "STORAGE_OBJECT_UNAVAILABLE",
            "The storage vault is unavailable",
        )
    })?;
    let _ = write_access_log(
        pool,
        object.id,
        "ADMIN",
        &actor_id(principal),
        "READ_AUTHORIZED",
        true,
        None,
        Some(holder_type),
        Some(holder_id),
        ip_address,
        request_id,
        Some(i64::try_from(bytes.len()).unwrap_or(i64::MAX)),
    )
    .await;
    Ok(StoredObject {
        bytes,
        mime_type: object.detected_mime_type,
        original_filename: object.original_filename,
        sha256_hex: object.sha256_hex,
    })
}

fn actor_id(principal: Option<&Principal>) -> String {
    principal
        .and_then(|principal| {
            principal
                .user_id
                .clone()
                .or_else(|| principal.token_id.clone())
        })
        .unwrap_or_else(|| "anonymous".to_owned())
}

#[allow(clippy::too_many_arguments)]
async fn write_access_log(
    pool: &PgPool,
    object_id: Uuid,
    actor_type: &str,
    actor_id: &str,
    action: &str,
    allowed: bool,
    denial_reason: Option<&str>,
    holder_type: Option<&str>,
    holder_id: Option<&str>,
    ip_address: Option<&str>,
    request_id: Option<&str>,
    bytes_served: Option<i64>,
) -> Result<(), ApiError> {
    sqlx::query(
        "INSERT INTO storage_object_access_logs \
         (object_id, actor_type, actor_id, action, allowed, denial_reason, holder_type, holder_id, ip_address, request_id, bytes_served) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
    )
    .bind(object_id)
    .bind(actor_type)
    .bind(actor_id)
    .bind(action)
    .bind(allowed)
    .bind(denial_reason)
    .bind(holder_type)
    .bind(holder_id)
    .bind(ip_address)
    .bind(request_id)
    .bind(bytes_served)
    .execute(pool)
    .await
    .map(|_| ())
    .map_err(super::support::database_error)
}

async fn read_blob_bytes(object: &StorageObjectRow) -> Result<Vec<u8>, String> {
    let bucket = BucketTier::parse(&object.bucket)
        .ok_or_else(|| format!("invalid bucket {}", object.bucket))?;
    let stream = match std::env::var("OBJECT_STORAGE_DAEMON_URL") {
        Ok(url) if !url.trim().is_empty() => {
            let tls = RemoteTlsConfig {
                ca_cert_path: std::env::var("OBJECT_STORAGE_TLS_CA_PATH").ok(),
                client_cert_path: std::env::var("OBJECT_STORAGE_TLS_CLIENT_CERT_PATH").ok(),
                client_key_path: std::env::var("OBJECT_STORAGE_TLS_CLIENT_KEY_PATH").ok(),
                timeout_ms: std::env::var("OBJECT_STORAGE_DAEMON_TIMEOUT_MS")
                    .ok()
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(30_000),
            };
            let store =
                RemoteMtlsBlobStore::new(url.trim(), tls).map_err(|error| error.to_string())?;
            store
                .read_bytes(bucket, &object.storage_key)
                .await
                .map_err(|error| error.to_string())?
        }
        _ => {
            let root = std::env::var("OBJECT_STORAGE_ROOT_DIR")
                .unwrap_or_else(|_| "/tmp/pg-object-storage-dev".to_owned());
            let store = FsBlobStore::new(root)
                .await
                .map_err(|error| error.to_string())?;
            store
                .read_bytes(bucket, &object.storage_key)
                .await
                .map_err(|error| error.to_string())?
        }
    };
    let keyring_spec = std::env::var("OBJECT_STORAGE_KEK_KEYRING")
        .map_err(|_| "OBJECT_STORAGE_KEK_KEYRING is not configured".to_owned())?;
    let active = std::env::var("OBJECT_STORAGE_ACTIVE_KEK_VERSION")
        .ok()
        .and_then(|value| value.parse::<u32>().ok());
    let keyring = KekKeyring::parse(&keyring_spec, active).map_err(|error| error.to_string())?;
    let metadata = ObjectCryptoMetadata {
        kek_version: u32::try_from(object.kek_key_version).map_err(|error| error.to_string())?,
        wrapped_dek: base64_encode(&object.wrapped_dek),
        dek_nonce: base64_encode(&object.dek_nonce),
        stream_prefix: base64_encode(&object.stream_nonce_prefix),
        chunk_size: u64::try_from(object.chunk_size_bytes).map_err(|error| error.to_string())?,
        chunk_count: u64::try_from(object.chunk_count).map_err(|error| error.to_string())?,
        plaintext_sha256: object.sha256_hex.clone(),
        plaintext_size: u64::try_from(object.byte_size).map_err(|error| error.to_string())?,
    };
    decrypt_pgos1(object.id, &stream, &keyring, &metadata).map_err(|error| error.to_string())
}

/// `contentDisposition` from `core-back/lib/contentDisposition.ts` (RFC 6266).
#[must_use]
pub(crate) fn content_disposition(kind: &str, file_name: Option<&str>, fallback: &str) -> String {
    let cleaned: String = file_name
        .unwrap_or_default()
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect();
    let last = cleaned
        .split(['\\', '/'])
        .next_back()
        .unwrap_or_default()
        .trim();
    let name: String = last.chars().take(200).collect();
    let name = if name.is_empty() {
        fallback.to_owned()
    } else {
        name
    };
    let mut ascii = String::with_capacity(name.len());
    for character in name.chars() {
        let unsafe_ascii = !matches!(character, '\u{20}'..='\u{7e}')
            || matches!(
                character,
                '"' | '\\' | '/' | ':' | '*' | '?' | '<' | '>' | '|'
            );
        ascii.push(if unsafe_ascii { '_' } else { character });
    }
    let mut collapsed = String::with_capacity(ascii.len());
    let mut previous_underscore = false;
    for character in ascii.chars() {
        if character == '_' {
            if previous_underscore {
                continue;
            }
            previous_underscore = true;
        } else {
            previous_underscore = false;
        }
        collapsed.push(character);
    }
    let extension = collapsed
        .rfind('.')
        .map(|index| &collapsed[index..])
        .filter(|suffix| {
            suffix.len() > 1
                && suffix.len() <= 9
                && suffix[1..].bytes().all(|byte| byte.is_ascii_alphanumeric())
        })
        .unwrap_or("");
    let stem = &collapsed[..collapsed.len() - extension.len()];
    let ascii_name = if stem.bytes().any(|byte| byte.is_ascii_alphanumeric()) {
        collapsed.clone()
    } else {
        format!("{fallback}{extension}")
    };
    if ascii_name == name {
        format!("{kind}; filename=\"{ascii_name}\"")
    } else {
        format!(
            "{kind}; filename=\"{ascii_name}\"; filename*=UTF-8''{}",
            rfc5987_encode(&name)
        )
    }
}

fn rfc5987_encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'!' | b'-' | b'.' | b'_' | b'~') {
            encoded.push(char::from(*byte));
        } else {
            encoded.push('%');
            encoded.push_str(&format!("{byte:02X}"));
        }
    }
    encoded
}

/// Test-only base64 decoder for the sealed `pgos1` metadata.
#[cfg(test)]
pub(crate) fn base64_decode_for_tests(text: &str) -> Option<Vec<u8>> {
    let cleaned: Vec<u8> = text
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect();
    let value_of = |byte: u8| -> Option<u8> {
        match byte {
            b'A'..=b'Z' => Some(byte - b'A'),
            b'a'..=b'z' => Some(byte - b'a' + 26),
            b'0'..=b'9' => Some(byte - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    };
    let mut output = Vec::with_capacity(cleaned.len() * 3 / 4);
    for chunk in cleaned.chunks(4) {
        if chunk.len() < 2 {
            return None;
        }
        let a = value_of(chunk[0])?;
        let b = value_of(chunk[1])?;
        output.push((a << 2) | (b >> 4));
        if let Some(&third) = chunk.get(2) {
            if third != b'=' {
                let c = value_of(third)?;
                output.push(((b & 0x0f) << 4) | (c >> 2));
                if let Some(&fourth) = chunk.get(3) {
                    if fourth != b'=' {
                        let d = value_of(fourth)?;
                        output.push(((c & 0x03) << 6) | d);
                    }
                }
            }
        }
    }
    Some(output)
}

fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = chunk.get(1).copied().unwrap_or(0);
        let third = chunk.get(2).copied().unwrap_or(0);
        output.push(char::from(ALPHABET[usize::from(first >> 2)]));
        output.push(char::from(
            ALPHABET[usize::from(((first & 0x03) << 4) | (second >> 4))],
        ));
        output.push(if chunk.len() > 1 {
            char::from(ALPHABET[usize::from(((second & 0x0f) << 2) | (third >> 6))])
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            char::from(ALPHABET[usize::from(third & 0x3f)])
        } else {
            '='
        });
    }
    output
}

//! Object-storage console reads: summary, objects, object detail and access logs.
//!
//! Port of `core-back/api/internal/objectStorage.ts:123-360` (the GET half). Every response is
//! control-plane metadata only: wrapped DEKs, nonces and plaintext bytes are never selected, and
//! storage keys are returned to the authenticated console but never logged.
//!
//! The P3 shell has no object-storage daemon client in `AppState`. The summary therefore reports the
//! documented TS `UnavailableBlobStore.healthCheck()` fallback (`ok:false`, `STORAGE_UNAVAILABLE`
//! detail) instead of pretending the vault is healthy; the list/detail/access-log endpoints read
//! the control plane only and work without the daemon.

#![forbid(unsafe_code)]

use ntex::web::HttpRequest;
use pg_http::ApiError;
use serde_json::{json, Map, Value};
use sqlx::Row;
use uuid::Uuid;

use super::helpers::{
    coerce_int, invalid_body, iso_tz_or_null, js_json, last_path_segment, require_uuid, Params,
};
use crate::http::error_response;
use crate::routes::common::json_ok;
use crate::state::AppState;

const NAMESPACES: &[&str] = &[
    "KYB_DOCUMENTS",
    "RECON_STATEMENTS",
    "REGULATORY_REPORTS",
    "REPORT_STUDIO_ASSETS",
    "MERCHANT_STATEMENTS",
    "DISPUTE_EVIDENCE",
    "AML_CASE_ATTACHMENTS",
    "SYSTEM_BRAND_ASSETS",
    "BACKUP_ARTIFACTS",
];
const STATUSES: &[&str] = &[
    "STAGING",
    "QUARANTINE_PENDING_AV",
    "QUARANTINE_REJECTED",
    "ACTIVE",
    "PURGED",
];
const BUCKETS: &[&str] = &["HOT", "COLD", "QUARANTINE"];

const OBJECT_SELECT: &str = "id, bucket::text AS bucket, namespace::text AS namespace,
    storage_key, status::text AS status, sha256_hex, byte_size::text AS byte_size,
    chunk_size_bytes, chunk_count, detected_mime_type, original_filename, owner_merchant_id,
    uploaded_by_actor_type, uploaded_by_actor_id, required_authority, confidentiality_tier,
    retain_until, legal_hold, legal_hold_reason, legal_hold_by_admin_id, legal_hold_placed_at,
    gc_eligible_at, gc_claimed_at, av_scan_status::text AS av_scan_status, av_scanned_at,
    av_signature, last_scrubbed_at, scrub_error_count, metadata, staging_expires_at, activated_at,
    purged_at, created_at, updated_at";

const LOCK_SELECT: &str = "id, object_id, holder_type, holder_id, retention_floor_until,
    acquired_by_actor_id, acquired_reason, acquired_at, released_at, released_by_actor_id,
    release_reason";

const ACCESS_LOG_SELECT: &str = "id, object_id, actor_type, actor_id, action, allowed,
    denial_reason, holder_type, holder_id, ip_address, request_id, bytes_served::text AS bytes_served,
    occurred_at";

/// The documented `UnavailableBlobStore.healthCheck()` result (TS `blobStore.ts:488-496`).
fn storage_health() -> Value {
    let detail = match std::env::var("OBJECT_STORAGE_DAEMON_URL") {
        Ok(value) if !value.trim().is_empty() => {
            "The Rust core has no object-storage daemon client in this build"
        }
        _ => "OBJECT_STORAGE_DAEMON_URL is not configured",
    };
    json!({
        "ok": false,
        "mode": "REMOTE_MTLS",
        "rootDirOrUrl": "unavailable",
        "freeBytes": 0,
        "latencyMs": 0,
        "error": format!("{detail}; shared storage is required"),
    })
}

fn active_kek_version() -> i64 {
    std::env::var("OBJECT_STORAGE_ACTIVE_KEK_VERSION")
        .ok()
        .and_then(|value| value.trim().parse::<i64>().ok())
        .filter(|value| *value >= 1)
        .unwrap_or(1)
}

fn object_row(row: &sqlx::postgres::PgRow) -> Result<Value, ApiError> {
    let id: Uuid = row
        .try_get("id")
        .map_err(crate::routes::common::database_error)?;
    let bucket: String = row
        .try_get("bucket")
        .map_err(crate::routes::common::database_error)?;
    let namespace: String = row
        .try_get("namespace")
        .map_err(crate::routes::common::database_error)?;
    let storage_key: String = row
        .try_get("storage_key")
        .map_err(crate::routes::common::database_error)?;
    let status: String = row
        .try_get("status")
        .map_err(crate::routes::common::database_error)?;
    let sha256_hex: String = row
        .try_get("sha256_hex")
        .map_err(crate::routes::common::database_error)?;
    let byte_size: String = row
        .try_get("byte_size")
        .map_err(crate::routes::common::database_error)?;
    let chunk_size_bytes: i32 = row
        .try_get("chunk_size_bytes")
        .map_err(crate::routes::common::database_error)?;
    let chunk_count: i32 = row
        .try_get("chunk_count")
        .map_err(crate::routes::common::database_error)?;
    let detected_mime_type: String = row
        .try_get("detected_mime_type")
        .map_err(crate::routes::common::database_error)?;
    let original_filename: Option<String> = row
        .try_get("original_filename")
        .map_err(crate::routes::common::database_error)?;
    let owner_merchant_id: Option<Uuid> = row
        .try_get("owner_merchant_id")
        .map_err(crate::routes::common::database_error)?;
    let uploaded_by_actor_type: String = row
        .try_get("uploaded_by_actor_type")
        .map_err(crate::routes::common::database_error)?;
    let uploaded_by_actor_id: String = row
        .try_get("uploaded_by_actor_id")
        .map_err(crate::routes::common::database_error)?;
    let required_authority: String = row
        .try_get("required_authority")
        .map_err(crate::routes::common::database_error)?;
    let confidentiality_tier: String = row
        .try_get("confidentiality_tier")
        .map_err(crate::routes::common::database_error)?;
    let retain_until: Option<chrono::DateTime<chrono::Utc>> = row
        .try_get("retain_until")
        .map_err(crate::routes::common::database_error)?;
    let legal_hold: bool = row
        .try_get("legal_hold")
        .map_err(crate::routes::common::database_error)?;
    let legal_hold_reason: Option<String> = row
        .try_get("legal_hold_reason")
        .map_err(crate::routes::common::database_error)?;
    let legal_hold_by_admin_id: Option<Uuid> = row
        .try_get("legal_hold_by_admin_id")
        .map_err(crate::routes::common::database_error)?;
    let legal_hold_placed_at: Option<chrono::DateTime<chrono::Utc>> = row
        .try_get("legal_hold_placed_at")
        .map_err(crate::routes::common::database_error)?;
    let gc_eligible_at: Option<chrono::DateTime<chrono::Utc>> = row
        .try_get("gc_eligible_at")
        .map_err(crate::routes::common::database_error)?;
    let gc_claimed_at: Option<chrono::DateTime<chrono::Utc>> = row
        .try_get("gc_claimed_at")
        .map_err(crate::routes::common::database_error)?;
    let av_scan_status: String = row
        .try_get("av_scan_status")
        .map_err(crate::routes::common::database_error)?;
    let av_scanned_at: Option<chrono::DateTime<chrono::Utc>> = row
        .try_get("av_scanned_at")
        .map_err(crate::routes::common::database_error)?;
    let av_signature: Option<String> = row
        .try_get("av_signature")
        .map_err(crate::routes::common::database_error)?;
    let last_scrubbed_at: Option<chrono::DateTime<chrono::Utc>> =
        row.try_get("last_scrubbed_at")
            .map_err(crate::routes::common::database_error)?;
    let scrub_error_count: i32 = row
        .try_get("scrub_error_count")
        .map_err(crate::routes::common::database_error)?;
    let metadata: Option<Value> = row
        .try_get("metadata")
        .map_err(crate::routes::common::database_error)?;
    let staging_expires_at: chrono::DateTime<chrono::Utc> = row
        .try_get("staging_expires_at")
        .map_err(crate::routes::common::database_error)?;
    let activated_at: Option<chrono::DateTime<chrono::Utc>> = row
        .try_get("activated_at")
        .map_err(crate::routes::common::database_error)?;
    let purged_at: Option<chrono::DateTime<chrono::Utc>> = row
        .try_get("purged_at")
        .map_err(crate::routes::common::database_error)?;
    let created_at: chrono::DateTime<chrono::Utc> = row
        .try_get("created_at")
        .map_err(crate::routes::common::database_error)?;
    let updated_at: chrono::DateTime<chrono::Utc> = row
        .try_get("updated_at")
        .map_err(crate::routes::common::database_error)?;
    Ok(json!({
        "id": id,
        "bucket": bucket,
        "namespace": namespace,
        "storageKey": storage_key,
        "status": status,
        "sha256Hex": sha256_hex,
        "byteSize": byte_size,
        "chunkSizeBytes": chunk_size_bytes,
        "chunkCount": chunk_count,
        "detectedMimeType": detected_mime_type,
        "originalFilename": original_filename,
        "ownerMerchantId": owner_merchant_id,
        "uploadedByActorType": uploaded_by_actor_type,
        "uploadedByActorId": uploaded_by_actor_id,
        "requiredAuthority": required_authority,
        "confidentialityTier": confidentiality_tier,
        "retainUntil": iso_tz_or_null(retain_until),
        "legalHold": legal_hold,
        "legalHoldReason": legal_hold_reason,
        "legalHoldByAdminId": legal_hold_by_admin_id,
        "legalHoldPlacedAt": iso_tz_or_null(legal_hold_placed_at),
        "gcEligibleAt": iso_tz_or_null(gc_eligible_at),
        "gcClaimedAt": iso_tz_or_null(gc_claimed_at),
        "avScanStatus": av_scan_status,
        "avScannedAt": iso_tz_or_null(av_scanned_at),
        "avSignature": av_signature,
        "lastScrubbedAt": iso_tz_or_null(last_scrubbed_at),
        "scrubErrorCount": scrub_error_count,
        "metadata": metadata.map(js_json),
        "stagingExpiresAt": iso_tz_or_null(Some(staging_expires_at)),
        "activatedAt": iso_tz_or_null(activated_at),
        "purgedAt": iso_tz_or_null(purged_at),
        "createdAt": iso_tz_or_null(Some(created_at)),
        "updatedAt": iso_tz_or_null(Some(updated_at)),
    }))
}

fn lock_row(row: &sqlx::postgres::PgRow) -> Result<Value, ApiError> {
    let id: Uuid = row
        .try_get("id")
        .map_err(crate::routes::common::database_error)?;
    let object_id: Uuid = row
        .try_get("object_id")
        .map_err(crate::routes::common::database_error)?;
    let holder_type: String = row
        .try_get("holder_type")
        .map_err(crate::routes::common::database_error)?;
    let holder_id: String = row
        .try_get("holder_id")
        .map_err(crate::routes::common::database_error)?;
    let retention_floor_until: Option<chrono::DateTime<chrono::Utc>> = row
        .try_get("retention_floor_until")
        .map_err(crate::routes::common::database_error)?;
    let acquired_by_actor_id: String = row
        .try_get("acquired_by_actor_id")
        .map_err(crate::routes::common::database_error)?;
    let acquired_reason: String = row
        .try_get("acquired_reason")
        .map_err(crate::routes::common::database_error)?;
    let acquired_at: chrono::DateTime<chrono::Utc> = row
        .try_get("acquired_at")
        .map_err(crate::routes::common::database_error)?;
    let released_at: Option<chrono::DateTime<chrono::Utc>> = row
        .try_get("released_at")
        .map_err(crate::routes::common::database_error)?;
    let released_by_actor_id: Option<String> = row
        .try_get("released_by_actor_id")
        .map_err(crate::routes::common::database_error)?;
    let release_reason: Option<String> = row
        .try_get("release_reason")
        .map_err(crate::routes::common::database_error)?;
    Ok(json!({
        "id": id,
        "objectId": object_id,
        "holderType": holder_type,
        "holderId": holder_id,
        "retentionFloorUntil": iso_tz_or_null(retention_floor_until),
        "acquiredByActorId": acquired_by_actor_id,
        "acquiredReason": acquired_reason,
        "acquiredAt": iso_tz_or_null(Some(acquired_at)),
        "releasedAt": iso_tz_or_null(released_at),
        "releasedByActorId": released_by_actor_id,
        "releaseReason": release_reason,
    }))
}

fn access_log_row(row: &sqlx::postgres::PgRow) -> Result<Value, ApiError> {
    let id: Uuid = row
        .try_get("id")
        .map_err(crate::routes::common::database_error)?;
    let object_id: Uuid = row
        .try_get("object_id")
        .map_err(crate::routes::common::database_error)?;
    let actor_type: String = row
        .try_get("actor_type")
        .map_err(crate::routes::common::database_error)?;
    let actor_id: String = row
        .try_get("actor_id")
        .map_err(crate::routes::common::database_error)?;
    let action: String = row
        .try_get("action")
        .map_err(crate::routes::common::database_error)?;
    let allowed: bool = row
        .try_get("allowed")
        .map_err(crate::routes::common::database_error)?;
    let denial_reason: Option<String> = row
        .try_get("denial_reason")
        .map_err(crate::routes::common::database_error)?;
    let holder_type: Option<String> = row
        .try_get("holder_type")
        .map_err(crate::routes::common::database_error)?;
    let holder_id: Option<String> = row
        .try_get("holder_id")
        .map_err(crate::routes::common::database_error)?;
    let ip_address: Option<String> = row
        .try_get("ip_address")
        .map_err(crate::routes::common::database_error)?;
    let request_id: Option<String> = row
        .try_get("request_id")
        .map_err(crate::routes::common::database_error)?;
    let bytes_served: Option<String> = row
        .try_get("bytes_served")
        .map_err(crate::routes::common::database_error)?;
    let occurred_at: chrono::DateTime<chrono::Utc> = row
        .try_get("occurred_at")
        .map_err(crate::routes::common::database_error)?;
    Ok(json!({
        "id": id,
        "objectId": object_id,
        "actorType": actor_type,
        "actorId": actor_id,
        "action": action,
        "allowed": allowed,
        "denialReason": denial_reason,
        "holderType": holder_type,
        "holderId": holder_id,
        "ipAddress": ip_address,
        "requestId": request_id,
        "bytesServed": bytes_served,
        "occurredAt": iso_tz_or_null(Some(occurred_at)),
    }))
}

/// `GET /internal/admin/object-storage/summary`.
pub async fn summary(state: &AppState, _request: &HttpRequest) -> Result<Value, ApiError> {
    let status_rows = sqlx::query(
        "SELECT status::text AS status, count(*)::bigint AS count
           FROM storage_objects GROUP BY status ORDER BY status",
    )
    .fetch_all(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?;
    let mut counts_by_status: Map<String, Value> = Map::new();
    for row in &status_rows {
        let status: String = row
            .try_get("status")
            .map_err(crate::routes::common::database_error)?;
        let count: i64 = row
            .try_get("count")
            .map_err(crate::routes::common::database_error)?;
        counts_by_status.insert(status, json!(count));
    }
    let namespace_rows = sqlx::query(
        "SELECT namespace::text AS namespace, count(*)::bigint AS objects,
                COALESCE(sum(byte_size), 0)::text AS bytes
           FROM storage_objects GROUP BY namespace ORDER BY namespace",
    )
    .fetch_all(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?;
    let mut bytes_by_namespace: Map<String, Value> = Map::new();
    for row in &namespace_rows {
        let namespace: String = row
            .try_get("namespace")
            .map_err(crate::routes::common::database_error)?;
        let objects: i64 = row
            .try_get("objects")
            .map_err(crate::routes::common::database_error)?;
        let bytes: String = row
            .try_get("bytes")
            .map_err(crate::routes::common::database_error)?;
        bytes_by_namespace.insert(namespace, json!({ "objects": objects, "bytes": bytes }));
    }
    let active_locks: i64 = sqlx::query_scalar(
        "SELECT count(*)::bigint FROM storage_object_locks WHERE released_at IS NULL",
    )
    .fetch_one(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?;
    let legal_holds: i64 =
        sqlx::query_scalar("SELECT count(*)::bigint FROM storage_objects WHERE legal_hold")
            .fetch_one(&state.pools.main)
            .await
            .map_err(crate::routes::common::database_error)?;
    let quarantine_pending: i64 = sqlx::query_scalar(
        "SELECT count(*)::bigint FROM storage_objects WHERE status = 'QUARANTINE_PENDING_AV'",
    )
    .fetch_one(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?;
    let scrub = sqlx::query(
        "SELECT COALESCE(sum(scrub_error_count), 0)::bigint AS errors, count(*)::bigint AS objects
           FROM storage_objects
          WHERE status = 'ACTIVE' AND scrub_error_count > 0",
    )
    .fetch_one(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?;
    let scrub_errors: i64 = scrub
        .try_get("errors")
        .map_err(crate::routes::common::database_error)?;
    let scrub_objects: i64 = scrub
        .try_get("objects")
        .map_err(crate::routes::common::database_error)?;
    let total_objects: i64 = sqlx::query_scalar("SELECT count(*)::bigint FROM storage_objects")
        .fetch_one(&state.pools.main)
        .await
        .map_err(crate::routes::common::database_error)?;
    Ok(json!({
        "health": storage_health(),
        "activeKekVersion": active_kek_version(),
        "countsByStatus": counts_by_status,
        "bytesByNamespace": bytes_by_namespace,
        "activeLocksCount": active_locks,
        "legalHoldCount": legal_holds,
        "quarantinePendingCount": quarantine_pending,
        "scrubErrorsCount": scrub_errors,
        "scrubErrorObjects": scrub_objects,
        "totalObjects": total_objects,
    }))
}

fn object_sort_column(key: &str) -> &'static str {
    match key {
        "namespace" => "namespace",
        "status" => "status",
        "retainUntil" => "retain_until",
        "byteSize" => "byte_size",
        "originalFilename" => "original_filename",
        _ => "created_at",
    }
}

fn check_keys(params: &Params, allowed: &[&str]) -> Result<(), ApiError> {
    for key in params.keys() {
        if !allowed.contains(&key) {
            return Err(invalid_body(
                &[],
                "unrecognized_keys",
                &format!("Unrecognized key(s) in object: '{key}'"),
            ));
        }
    }
    Ok(())
}

fn enum_param(params: &Params, key: &str, allowed: &[&str]) -> Result<Option<String>, ApiError> {
    let Some(value) = params.string(key) else {
        return Ok(None);
    };
    if !allowed.contains(&value.as_str()) {
        return Err(invalid_body(
            &["query", key],
            "invalid_value",
            "Invalid enum value",
        ));
    }
    Ok(Some(value))
}

/// Bind values of the dynamic object/access-log queries.
enum Bind {
    Text(String),
    Bool(bool),
    Uuid(Uuid),
}

impl Bind {
    fn push(self, binds: &mut Vec<Bind>) -> String {
        binds.push(self);
        format!("${}", binds.len())
    }
}

/// `GET /internal/admin/object-storage/objects`.
pub async fn objects(state: &AppState, request: &HttpRequest) -> Result<Value, ApiError> {
    let params = Params::parse(request.query_string());
    check_keys(
        &params,
        &[
            "page",
            "pageSize",
            "namespace",
            "status",
            "statuses",
            "bucket",
            "ownerMerchantId",
            "legalHold",
            "sha256Hex",
            "search",
            "sortKey",
            "sortDirection",
        ],
    )?;
    let page = coerce_int(params.get("page"), 1, 1, i64::MAX, "page")?;
    let page_size = coerce_int(params.get("pageSize"), 25, 1, 200, "pageSize")?;
    let namespace = enum_param(&params, "namespace", NAMESPACES)?;
    let status = enum_param(&params, "status", STATUSES)?;
    let bucket = enum_param(&params, "bucket", BUCKETS)?;
    let legal_hold = enum_param(&params, "legalHold", &["true", "false"])?;
    let owner = match params.string("ownerMerchantId") {
        Some(raw) => Some(require_uuid(&raw, "ownerMerchantId")?),
        None => None,
    };
    let sha256 = params.string("sha256Hex");
    if let Some(value) = &sha256 {
        if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(invalid_body(
                &["query", "sha256Hex"],
                "invalid_format",
                "Invalid SHA-256 hex",
            ));
        }
    }
    let search = params.string("search");
    if search.as_ref().is_some_and(|value| value.len() > 200) {
        return Err(invalid_body(
            &["query", "search"],
            "too_big",
            "String must contain at most 200 character(s)",
        ));
    }
    let sort_key = enum_param(
        &params,
        "sortKey",
        &[
            "createdAt",
            "namespace",
            "status",
            "retainUntil",
            "byteSize",
            "originalFilename",
        ],
    )?
    .unwrap_or_else(|| "createdAt".to_owned());
    let sort_direction = enum_param(&params, "sortDirection", &["asc", "desc"])?
        .unwrap_or_else(|| "desc".to_owned());

    let mut clauses: Vec<String> = Vec::new();
    let mut binds: Vec<Bind> = Vec::new();
    if let Some(value) = namespace {
        let placeholder = Bind::Text(value).push(&mut binds);
        clauses.push(format!("namespace::text = {placeholder}"));
    }
    let statuses_raw = params.string("statuses");
    // TS sets `status` and then overwrites it with `statuses`; the list wins when both are sent.
    if let Some(value) = status.filter(|_| statuses_raw.is_none()) {
        let placeholder = Bind::Text(value).push(&mut binds);
        clauses.push(format!("status::text = {placeholder}"));
    }
    if let Some(raw) = statuses_raw {
        let values: Vec<&str> = raw
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .collect();
        if let Some(invalid) = values.iter().find(|value| !STATUSES.contains(value)) {
            return Err(ApiError::new(
                400,
                "STORAGE_STATUS_INVALID",
                format!("Unknown storage status: {invalid}"),
            ));
        }
        if !values.is_empty() {
            let mut placeholders = Vec::with_capacity(values.len());
            for value in values {
                placeholders.push(Bind::Text(value.to_owned()).push(&mut binds));
            }
            clauses.push(format!("status::text IN ({})", placeholders.join(", ")));
        }
    }
    if let Some(value) = bucket {
        let placeholder = Bind::Text(value).push(&mut binds);
        clauses.push(format!("bucket::text = {placeholder}"));
    }
    if let Some(value) = owner {
        let placeholder = Bind::Uuid(value).push(&mut binds);
        clauses.push(format!("owner_merchant_id = {placeholder}"));
    }
    if let Some(value) = legal_hold {
        let placeholder = Bind::Bool(value == "true").push(&mut binds);
        clauses.push(format!("legal_hold = {placeholder}"));
    }
    if let Some(value) = sha256 {
        let placeholder = Bind::Text(value.to_ascii_lowercase()).push(&mut binds);
        clauses.push(format!("sha256_hex = {placeholder}"));
    }
    if let Some(value) = search {
        let pattern = Bind::Text(format!("%{value}%")).push(&mut binds);
        let mut parts = vec![
            format!("storage_key ILIKE {pattern}"),
            format!("original_filename ILIKE {pattern}"),
        ];
        if let Ok(uuid) = Uuid::parse_str(value.trim()) {
            let placeholder = Bind::Uuid(uuid).push(&mut binds);
            parts.push(format!("id = {placeholder}"));
        }
        clauses.push(format!("({})", parts.join(" OR ")));
    }
    let where_sql = if clauses.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", clauses.join(" AND "))
    };
    let limit = Bind::Text(String::new());
    let limit_placeholder = limit.push(&mut binds);
    let offset_placeholder = Bind::Text(String::new()).push(&mut binds);
    let sql = format!(
        "SELECT {OBJECT_SELECT} FROM storage_objects{where_sql} ORDER BY {} {} LIMIT {limit_placeholder} OFFSET {offset_placeholder}",
        object_sort_column(&sort_key),
        if sort_direction == "asc" { "ASC" } else { "DESC" },
    );
    // The two pagination binds are integers, not text; bind them separately.
    let binds_where_len = binds.len().saturating_sub(2);
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()));
    for bind in &binds[..binds_where_len] {
        query = match bind {
            Bind::Text(value) => query.bind(value.as_str()),
            Bind::Bool(value) => query.bind(*value),
            Bind::Uuid(value) => query.bind(*value),
        };
    }
    let rows = query
        .bind(page_size)
        .bind((page - 1).saturating_mul(page_size))
        .fetch_all(&state.pools.main)
        .await
        .map_err(crate::routes::common::database_error)?;
    let count_sql = format!("SELECT count(*)::bigint FROM storage_objects{where_sql}");
    let total: i64 = {
        let mut query = sqlx::query(sqlx::AssertSqlSafe(count_sql.as_str()));
        for bind in &binds[..binds_where_len] {
            query = match bind {
                Bind::Text(value) => query.bind(value.as_str()),
                Bind::Bool(value) => query.bind(*value),
                Bind::Uuid(value) => query.bind(*value),
            };
        }
        query
            .fetch_one(&state.pools.main)
            .await
            .map_err(crate::routes::common::database_error)?
            .try_get("count")
            .map_err(crate::routes::common::database_error)?
    };

    let mut objects = Vec::with_capacity(rows.len());
    let mut ids = Vec::with_capacity(rows.len());
    for row in &rows {
        let object = object_row(row)?;
        if let Some(id) = object.get("id").and_then(Value::as_str) {
            if let Ok(id) = Uuid::parse_str(id) {
                ids.push(id);
            }
        }
        objects.push(object);
    }
    let mut locks_by_object: BTreeObjectLocks = BTreeObjectLocks::new();
    if !ids.is_empty() {
        let locks = sqlx::query(sqlx::AssertSqlSafe(format!(
            "SELECT {LOCK_SELECT} FROM storage_object_locks
              WHERE object_id = ANY($1::uuid[]) AND released_at IS NULL
              ORDER BY acquired_at DESC, id DESC"
        )))
        .bind(&ids)
        .fetch_all(&state.pools.main)
        .await
        .map_err(crate::routes::common::database_error)?;
        for row in &locks {
            let object_id: Uuid = row
                .try_get("object_id")
                .map_err(crate::routes::common::database_error)?;
            locks_by_object
                .entry(object_id)
                .or_default()
                .push(lock_row(row)?);
        }
    }
    for object in &mut objects {
        if let Some(id) = object
            .get("id")
            .and_then(Value::as_str)
            .and_then(|value| Uuid::parse_str(value).ok())
        {
            let active = locks_by_object.remove(&id).unwrap_or_default();
            if let Value::Object(map) = object {
                map.insert("activeLocks".to_owned(), Value::Array(active));
            }
        }
    }
    Ok(json!({
        "objects": objects,
        "total": total,
        "page": page,
        "pageSize": page_size,
    }))
}

type BTreeObjectLocks = std::collections::BTreeMap<Uuid, Vec<Value>>;

/// `GET /internal/admin/object-storage/objects/:id`.
pub async fn object_detail(state: &AppState, request: &HttpRequest) -> Result<Value, ApiError> {
    let id = require_uuid(last_path_segment(request.path()), "id")?;
    let row = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {OBJECT_SELECT} FROM storage_objects WHERE id = $1"
    )))
    .bind(id)
    .fetch_optional(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?
    .ok_or_else(|| {
        ApiError::new(
            404,
            "STORAGE_OBJECT_NOT_FOUND",
            "The storage object does not exist",
        )
    })?;
    let object = object_row(&row)?;
    let locks = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {LOCK_SELECT} FROM storage_object_locks
          WHERE object_id = $1 ORDER BY acquired_at DESC, id DESC"
    )))
    .bind(id)
    .fetch_all(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?;
    let mut lock_rows = Vec::with_capacity(locks.len());
    for lock in &locks {
        lock_rows.push(lock_row(lock)?);
    }
    let logs = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {ACCESS_LOG_SELECT} FROM storage_object_access_logs
          WHERE object_id = $1 ORDER BY occurred_at DESC, id DESC LIMIT 50"
    )))
    .bind(id)
    .fetch_all(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?;
    let mut log_rows = Vec::with_capacity(logs.len());
    for log in &logs {
        log_rows.push(access_log_row(log)?);
    }
    Ok(json!({
        "object": object,
        "locks": lock_rows,
        "accessLogs": log_rows,
    }))
}

/// `GET /internal/admin/object-storage/access-logs`.
pub async fn access_logs(state: &AppState, request: &HttpRequest) -> Result<Value, ApiError> {
    let params = Params::parse(request.query_string());
    check_keys(
        &params,
        &[
            "page", "pageSize", "allowed", "action", "objectId", "search",
        ],
    )?;
    let page = coerce_int(params.get("page"), 1, 1, i64::MAX, "page")?;
    let page_size = coerce_int(params.get("pageSize"), 50, 1, 200, "pageSize")?;
    let allowed = enum_param(&params, "allowed", &["true", "false"])?;
    let object_id = match params.string("objectId") {
        Some(raw) => Some(require_uuid(&raw, "objectId")?),
        None => None,
    };
    if params
        .string("action")
        .is_some_and(|value| value.len() > 48)
    {
        return Err(invalid_body(
            &["query", "action"],
            "too_big",
            "String must contain at most 48 character(s)",
        ));
    }
    let search = params.string("search");
    if search.as_ref().is_some_and(|value| value.len() > 200) {
        return Err(invalid_body(
            &["query", "search"],
            "too_big",
            "String must contain at most 200 character(s)",
        ));
    }
    let mut clauses: Vec<String> = Vec::new();
    let mut binds: Vec<Bind> = Vec::new();
    if let Some(value) = allowed {
        let placeholder = Bind::Bool(value == "true").push(&mut binds);
        clauses.push(format!("l.allowed = {placeholder}"));
    }
    if let Some(value) = params.string("action") {
        let placeholder = Bind::Text(value).push(&mut binds);
        clauses.push(format!("l.action = {placeholder}"));
    }
    if let Some(value) = object_id {
        let placeholder = Bind::Uuid(value).push(&mut binds);
        clauses.push(format!("l.object_id = {placeholder}"));
    }
    if let Some(value) = search {
        let pattern = Bind::Text(format!("%{value}%")).push(&mut binds);
        clauses.push(format!(
            "(l.actor_id ILIKE {pattern} OR l.request_id ILIKE {pattern} OR l.denial_reason ILIKE {pattern})"
        ));
    }
    let where_sql = if clauses.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", clauses.join(" AND "))
    };
    let limit_placeholder = Bind::Text(String::new()).push(&mut binds);
    let offset_placeholder = Bind::Text(String::new()).push(&mut binds);
    let binds_where_len = binds.len().saturating_sub(2);
    let sql = format!(
        "SELECT l.id AS id, l.object_id AS object_id, l.actor_type AS actor_type,
                l.actor_id AS actor_id, l.action AS action, l.allowed AS allowed,
                l.denial_reason AS denial_reason, l.holder_type AS holder_type,
                l.holder_id AS holder_id, l.ip_address AS ip_address, l.request_id AS request_id,
                l.bytes_served::text AS bytes_served, l.occurred_at AS occurred_at,
                o.id AS related_id, o.namespace::text AS related_namespace,
                o.storage_key AS related_storage_key, o.detected_mime_type AS related_mime_type
           FROM storage_object_access_logs l
           JOIN storage_objects o ON o.id = l.object_id{where_sql}
          ORDER BY l.occurred_at DESC, l.id DESC
          LIMIT {limit_placeholder} OFFSET {offset_placeholder}"
    );
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()));
    for bind in &binds[..binds_where_len] {
        query = match bind {
            Bind::Text(value) => query.bind(value.as_str()),
            Bind::Bool(value) => query.bind(*value),
            Bind::Uuid(value) => query.bind(*value),
        };
    }
    let rows = query
        .bind(page_size)
        .bind((page - 1).saturating_mul(page_size))
        .fetch_all(&state.pools.main)
        .await
        .map_err(crate::routes::common::database_error)?;
    let count_sql = format!("SELECT count(*)::bigint FROM storage_object_access_logs l{where_sql}");
    let total: i64 = {
        let mut query = sqlx::query(sqlx::AssertSqlSafe(count_sql.as_str()));
        for bind in &binds[..binds_where_len] {
            query = match bind {
                Bind::Text(value) => query.bind(value.as_str()),
                Bind::Bool(value) => query.bind(*value),
                Bind::Uuid(value) => query.bind(*value),
            };
        }
        query
            .fetch_one(&state.pools.main)
            .await
            .map_err(crate::routes::common::database_error)?
            .try_get("count")
            .map_err(crate::routes::common::database_error)?
    };
    let mut logs = Vec::with_capacity(rows.len());
    for row in &rows {
        let mut entry = access_log_row(row)?;
        let related_id: Uuid = row
            .try_get("related_id")
            .map_err(crate::routes::common::database_error)?;
        let related_namespace: String = row
            .try_get("related_namespace")
            .map_err(crate::routes::common::database_error)?;
        let related_storage_key: String = row
            .try_get("related_storage_key")
            .map_err(crate::routes::common::database_error)?;
        let related_mime_type: String = row
            .try_get("related_mime_type")
            .map_err(crate::routes::common::database_error)?;
        if let Value::Object(map) = &mut entry {
            map.insert(
                "object".to_owned(),
                json!({
                    "id": related_id,
                    "namespace": related_namespace,
                    "storageKey": related_storage_key,
                    "detectedMimeType": related_mime_type,
                }),
            );
        }
        logs.push(entry);
    }
    Ok(json!({
        "accessLogs": logs,
        "total": total,
        "page": page,
        "pageSize": page_size,
    }))
}

macro_rules! handler {
    ($name:ident, $target:path) => {
        pub fn $name<'a>(
            state: &'a AppState,
            request: &'a HttpRequest,
            _principal: Option<&'a pg_domain_auth::Principal>,
            _payload: ntex::web::types::Payload,
        ) -> crate::routes::HandlerFuture<'a> {
            Box::pin(async move {
                match $target(state, request).await {
                    Ok(body) => json_ok(&body),
                    Err(error) => error_response(request, error),
                }
            })
        }
    };
}

handler!(summary_handler, summary);
handler!(objects_handler, objects);
handler!(object_detail_handler, object_detail);
handler!(access_logs_handler, access_logs);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unavailable_health_matches_the_ts_fallback() {
        let health = storage_health();
        assert_eq!(health["ok"], false);
        assert_eq!(health["mode"], "REMOTE_MTLS");
        assert_eq!(health["rootDirOrUrl"], "unavailable");
        assert_eq!(health["freeBytes"], 0);
        assert!(health["error"]
            .as_str()
            .is_some_and(|value| value.contains("shared storage is required")));
    }

    #[test]
    fn sort_columns_are_allow_listed() {
        assert_eq!(object_sort_column("byteSize"), "byte_size");
        assert_eq!(object_sort_column("createdAt"), "created_at");
        assert_eq!(object_sort_column("DROP TABLE"), "created_at");
    }

    #[test]
    fn strict_query_refuses_unknown_keys() {
        let params = Params::parse("page=1&nope=2");
        let error = check_keys(&params, &["page"]).expect_err("unknown key");
        assert_eq!(error.code, "INVALID_BODY");
    }
}

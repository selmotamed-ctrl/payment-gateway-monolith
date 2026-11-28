//! File-bytes admin routes: catalog asset, KYB document, dispute evidence and reconciliation
//! statement downloads.
//!
//! Ports `admin.ts:3418` (`/kyb-documents/:id/content`), `admin.ts:16982`
//! (`/assets/:id/content`), `admin.ts:18001`
//! (`/disputes/:id/attachments/:attachmentId/content`) and `admin.ts:17426`
//! (`/reconciliation/runs/:id/statement`). Every route reads the shared object-storage vault through
//! [`super::storage::read_authorized`], so the response is the decrypted stored file with the TS
//! `Content-Type`/`Content-Disposition`/cache headers. A missing domain row, a missing object id or a
//! vault failure produces the TS error code; no storage key, wrapped DEK or vault path ever reaches
//! the body.

#![forbid(unsafe_code)]

use ntex::web::{HttpRequest, HttpResponse};
use pg_domain_auth::Principal;
use sqlx::Row;
use uuid::Uuid;

use pg_http::ApiError;

use crate::state::AppState;

use super::storage::{content_disposition, read_authorized};
use super::support::uuid_param_400;

fn error(request: &HttpRequest, error: ApiError) -> HttpResponse {
    crate::http::error_response(request, error)
}

fn object_id(row: &sqlx::postgres::PgRow, column: &str) -> Result<Uuid, ApiError> {
    row.try_get::<Option<Uuid>, _>(column)
        .ok()
        .flatten()
        .ok_or_else(ApiError::server_error)
}

/// `GET /internal/admin/assets/:id/content` (`admin.ts:16982`).
pub(crate) async fn asset_content(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> HttpResponse {
    match asset_content_inner(state, request, principal).await {
        Ok(response) => response,
        Err(error_value) => error(request, error_value),
    }
}

async fn asset_content_inner(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<HttpResponse, ApiError> {
    let id = uuid_param_400(request, 2)?;
    let row = sqlx::query(
        "SELECT id, name, mime::text AS mime, storage_object_id FROM assets WHERE id = $1::uuid",
    )
    .bind(&id)
    .fetch_optional(&state.pools.main)
    .await
    .map_err(super::support::database_error)?
    .ok_or_else(|| ApiError::new(404, "ASSET_NOT_FOUND", "The asset does not exist"))?;
    let name: String = row
        .try_get("name")
        .map_err(super::support::database_error)?;
    let mime: String = row
        .try_get("mime")
        .map_err(super::support::database_error)?;
    let storage_object_id = match row
        .try_get::<Option<Uuid>, _>("storage_object_id")
        .map_err(super::support::database_error)?
    {
        Some(value) => value,
        None => {
            return Err(ApiError::new(
                404,
                "ASSET_CONTENT_MISSING",
                "The asset was registered before the shared object storage engine and has no stored bytes",
            ))
        }
    };

    let stored = read_authorized(
        &state.pools.main,
        principal,
        storage_object_id,
        "CATALOG_ASSET",
        &id,
        crate::http::client_ip(request).as_deref(),
        crate::http::request_id(request).as_deref(),
    )
    .await?;
    let (content_type, extension) = if mime == "IMAGE_SVG_XML" {
        ("image/svg+xml", "svg")
    } else {
        ("image/png", "png")
    };
    Ok(HttpResponse::Ok()
        .content_type(content_type)
        .header(
            "Content-Disposition",
            content_disposition("inline", Some(&format!("{name}.{extension}")), "asset"),
        )
        .header("Content-Security-Policy", "sandbox; default-src 'none'")
        .header("Cache-Control", "private, max-age=300")
        .header("X-Content-Type-Options", "nosniff")
        .body(stored.bytes))
}

/// `GET /internal/admin/kyb-documents/:id/content` (`admin.ts:3418`).
pub(crate) async fn kyb_content(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> HttpResponse {
    match kyb_content_inner(state, request, principal).await {
        Ok(response) => response,
        Err(error_value) => error(request, error_value),
    }
}

async fn kyb_content_inner(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<HttpResponse, ApiError> {
    let id = uuid_param_400(request, 2)?;
    let row = sqlx::query(
        "SELECT id, join_request_id, av_status::text AS av_status, storage_object_id, mime,
                original_file_name, size_bytes
           FROM kyb_documents WHERE id = $1::uuid",
    )
    .bind(&id)
    .fetch_optional(&state.pools.main)
    .await
    .map_err(super::support::database_error)?
    .ok_or_else(|| {
        ApiError::new(
            404,
            "KIB_DOCUMENT_NOT_FOUND",
            "The KYB document does not exist",
        )
    })?;
    let av_status: String = row
        .try_get("av_status")
        .map_err(super::support::database_error)?;
    if av_status != "CLEAN" {
        return Err(ApiError::new(
            409,
            "KIB_DOCUMENT_NOT_SCANNED",
            "The KYB document has not passed malware scanning",
        ));
    }
    let storage_object_id = match row
        .try_get::<Option<Uuid>, _>("storage_object_id")
        .map_err(super::support::database_error)?
    {
        Some(value) => value,
        None => {
            return Err(ApiError::new(
                404,
                "KIB_DOCUMENT_CONTENT_MISSING",
                "The KYB document content is not available",
            ))
        }
    };
    let mime: String = row
        .try_get("mime")
        .map_err(super::support::database_error)?;
    let original_file_name: Option<String> = row
        .try_get("original_file_name")
        .map_err(super::support::database_error)?;
    let join_request_id: String = row
        .try_get::<Uuid, _>("join_request_id")
        .map(|value| value.to_string())
        .map_err(super::support::database_error)?;
    let size_bytes: i64 = row
        .try_get("size_bytes")
        .map_err(super::support::database_error)?;

    let stored = read_authorized(
        &state.pools.main,
        principal,
        storage_object_id,
        "KYB_DOCUMENT",
        &id,
        crate::http::client_ip(request).as_deref(),
        crate::http::request_id(request).as_deref(),
    )
    .await?;
    super::support::write_audit(
        state,
        principal,
        "JOIN_REQUEST_KYB_DOCUMENT_VIEWED",
        "KYB_DOCUMENT",
        &id,
        serde_json::json!({
            "joinRequestId": join_request_id,
            "mime": mime,
            "sizeBytes": size_bytes,
        }),
    )
    .await?;
    // The TS sends `document.mime` (not the sniffed mime of the stored object).
    let _ = stored.mime_type;
    Ok(HttpResponse::Ok()
        .content_type(mime)
        .header(
            "Content-Disposition",
            content_disposition("inline", original_file_name.as_deref(), "document"),
        )
        .header("Content-Security-Policy", "sandbox; default-src 'none'")
        .header("Cache-Control", "no-store, private")
        .header("Pragma", "no-cache")
        .header("X-Content-Type-Options", "nosniff")
        .body(stored.bytes))
}

/// `GET /internal/admin/disputes/:id/attachments/:attachmentId/content` (`admin.ts:18001`).
pub(crate) async fn dispute_attachment_content(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> HttpResponse {
    match dispute_attachment_content_inner(state, request, principal).await {
        Ok(response) => response,
        Err(error_value) => error(request, error_value),
    }
}

async fn dispute_attachment_content_inner(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<HttpResponse, ApiError> {
    let dispute_id = uuid_param_400(request, 4)?;
    let attachment_id = uuid_param_400(request, 2)?;
    let row = sqlx::query(
        "SELECT id, storage_object_id FROM dispute_attachments
          WHERE id = $1::uuid AND dispute_id = $2::uuid",
    )
    .bind(&attachment_id)
    .bind(&dispute_id)
    .fetch_optional(&state.pools.main)
    .await
    .map_err(super::support::database_error)?
    .ok_or_else(|| {
        ApiError::new(
            404,
            "DISPUTE_ATTACHMENT_NOT_FOUND",
            "The dispute attachment does not exist",
        )
    })?;
    let storage_object_id = object_id(&row, "storage_object_id")?;
    let stored = read_authorized(
        &state.pools.main,
        principal,
        storage_object_id,
        "DISPUTE_ATTACHMENT",
        &attachment_id,
        crate::http::client_ip(request).as_deref(),
        crate::http::request_id(request).as_deref(),
    )
    .await?;
    Ok(HttpResponse::Ok()
        .content_type(stored.mime_type)
        .header(
            "Content-Disposition",
            content_disposition(
                "attachment",
                stored.original_filename.as_deref(),
                "evidence",
            ),
        )
        .header("Content-Security-Policy", "sandbox; default-src 'none'")
        .header("Cache-Control", "private, no-store")
        .header("X-Content-Type-Options", "nosniff")
        .body(stored.bytes))
}

/// `GET /internal/admin/reconciliation/runs/:id/statement` (`admin.ts:17426`).
pub(crate) async fn reconciliation_statement(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> HttpResponse {
    match reconciliation_statement_inner(state, request, principal).await {
        Ok(response) => response,
        Err(error_value) => error(request, error_value),
    }
}

async fn reconciliation_statement_inner(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<HttpResponse, ApiError> {
    let id = uuid_param_400(request, 2)?;
    let row = sqlx::query(
        "SELECT id, storage_object_id, file_name FROM reconciliation_runs WHERE id = $1::uuid",
    )
    .bind(&id)
    .fetch_optional(&state.pools.main)
    .await
    .map_err(super::support::database_error)?
    .ok_or_else(|| {
        ApiError::new(
            404,
            "RECONCILIATION_RUN_NOT_FOUND",
            "The reconciliation run does not exist",
        )
    })?;
    let storage_object_id = match row
        .try_get::<Option<Uuid>, _>("storage_object_id")
        .map_err(super::support::database_error)?
    {
        Some(value) => value,
        None => {
            return Err(ApiError::new(
                404,
                "RECONCILIATION_FILE_MISSING",
                "The original statement is not available in the shared vault",
            ))
        }
    };
    let file_name: Option<String> = row
        .try_get("file_name")
        .map_err(super::support::database_error)?;
    let stored = read_authorized(
        &state.pools.main,
        principal,
        storage_object_id,
        "RECON_RUN",
        &id,
        crate::http::client_ip(request).as_deref(),
        crate::http::request_id(request).as_deref(),
    )
    .await?;
    super::support::write_audit(
        state,
        principal,
        "RECONCILIATION_STATEMENT_DOWNLOADED",
        "RECONCILIATION_RUN",
        &id,
        serde_json::json!({
            "storageObjectId": storage_object_id.to_string(),
            "sha256": stored.sha256_hex,
        }),
    )
    .await?;
    Ok(HttpResponse::Ok()
        .content_type(stored.mime_type)
        .header(
            "Content-Disposition",
            content_disposition(
                "attachment",
                file_name.as_deref().or(stored.original_filename.as_deref()),
                "statement",
            ),
        )
        .header("X-Content-SHA256", stored.sha256_hex)
        .header("Cache-Control", "private, no-store")
        .header("X-Content-Type-Options", "nosniff")
        .body(stored.bytes))
}

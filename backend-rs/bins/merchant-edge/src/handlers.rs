//! Custom route handlers: auth logout/OAuth, bulk user PATCH, uploads, the Sandbox proxy and the
//! SSE/download streams.
//!
//! Port of `merchant-back/api/public/auth.ts` (logout/callback),
//! `merchant-back/api/protected/{users,disputes}.ts`, `merchant-back/api/public/onboarding.ts`
//! (KYB upload), `merchant-back/api/upload.ts`, `merchant-back/api/sandboxProxy.ts`,
//! `merchant-back/lib/corePools.ts` and the stream relay of
//! `merchant-back/lib/coreInternalClient.ts:920-993`.

#![forbid(unsafe_code)]

use std::pin::Pin;
use std::task::{Context, Poll};

use bytes::Bytes;
use futures_util::{Stream, StreamExt as _};
use pg_upstream::{CoreMethod, Plane, QueryValue};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::app::{params_value, rate_limited, AppState, Prepared, StreamSlotGuard};
use crate::contract::{
    core_dispute_evidence_schema, to_core_dispute_evidence, to_core_user_patch, EvidenceUpload,
    MAX_EVIDENCE_FILE_BYTES,
};
use crate::error::EdgeApiError;
use crate::forward::{self, ForwardSpec, PathTemplate};
use crate::http::{encode_uri_component, EdgeResponse};
use crate::limits::rate_limit_key;
use crate::multipart::{self, UploadLimits, UploadedPart};
use crate::schemas;
use crate::upstream::{
    parse_json_buffer, plane_for_authorization, relayed_headers, CoreByteStream, CoreRequest,
    CoreResponse,
};
use crate::validate::{validate_to_error, Schema};

const MERCHANT_AUDIENCE: &str = pg_edge::MERCHANT_SESSION_AUDIENCE;
const TOKEN_BODY_LENGTH: usize = 43;

fn now_ms() -> i64 {
    i64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or(0),
    )
    .unwrap_or(i64::MAX)
}

/// `GET /health`.
pub fn health(app: &AppState) -> Result<EdgeResponse, EdgeApiError> {
    let health = pg_http::EdgeHealth::new(
        "merchant-back",
        &app.release,
        &app.commit,
        app.started.elapsed().as_secs(),
    );
    let value = serde_json::to_value(health).unwrap_or(Value::Null);
    Ok(EdgeResponse::json(200, &value))
}

/// `requirePgLiveToken` format check.
#[must_use]
pub fn valid_external_token(app: &AppState, token: &str) -> bool {
    let prefix = if token.starts_with("pg_test_") {
        "pg_test_"
    } else if token.starts_with(&app.config.pg_live_token_prefix) {
        app.config.pg_live_token_prefix.as_str()
    } else if token.starts_with("pg_live_") {
        "pg_live_"
    } else {
        return false;
    };
    let body = &token[prefix.len()..];
    body.len() == TOKEN_BODY_LENGTH
        && body
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// `POST /tokens`: the expiry transform and the CIDR/scope refinements, then the canonical call.
pub async fn token_create(
    app: &AppState,
    prepared: &Prepared,
    spec: &ForwardSpec,
) -> Result<EdgeResponse, EdgeApiError> {
    let body = schemas::validate_token_create(
        prepared.json_body.clone(),
        app.config.token_default_ttl_days,
        app.config.token_max_ttl_days,
        app.config.token_max_scopes,
    )?;
    forward::deliver_with_body(app, prepared, spec, body).await
}

/// `POST /auth/logout`.
pub async fn logout(
    app: &AppState,
    prepared: &Prepared,
    _req: &crate::app::IncomingRequest,
) -> Result<EdgeResponse, EdgeApiError> {
    let clear = app.cookie_config().clear_header();
    if prepared.authorization.is_none() {
        let mut response = EdgeResponse::json(200, &json!({ "revoked": false }));
        response.headers.push(("set-cookie".to_owned(), clear));
        return Ok(response);
    }
    let outcome = call_core(
        app,
        prepared,
        None,
        CoreMethod::Post,
        "/internal/merchant/auth/logout".to_owned(),
        Vec::new(),
        Some(b"{}".to_vec()),
        None,
        &[],
        None,
    )
    .await;
    match outcome {
        Ok(response) if response.status < 400 => {
            let mut edge = EdgeResponse::json(200, &json!({ "revoked": true }));
            edge.headers.push(("set-cookie".to_owned(), clear));
            Ok(edge)
        }
        Ok(response) => {
            let error = EdgeApiError::from_core(response.status, &response.json_body());
            if error.status == 401 {
                let mut edge = EdgeResponse::json(200, &json!({ "revoked": false }));
                edge.headers.push(("set-cookie".to_owned(), clear));
                return Ok(edge);
            }
            let mut edge = EdgeResponse::from_error(&error);
            edge.headers.push(("set-cookie".to_owned(), clear));
            Ok(edge)
        }
        Err(error) => {
            let mut edge = EdgeResponse::from_error(&error);
            edge.headers.push(("set-cookie".to_owned(), clear));
            Ok(edge)
        }
    }
}

/// `GET /auth/google/callback`: always redirects, even when core fails.
pub async fn google_callback(
    app: &AppState,
    prepared: &Prepared,
    req: &crate::app::IncomingRequest,
) -> Result<EdgeResponse, EdgeApiError> {
    let query = Value::Object(crate::http::query_object(&req.query));
    validate_to_error(&schemas::google_callback_query_schema(), &query)?;
    let scalar: Vec<(String, QueryValue)> = query
        .as_object()
        .map(|object| {
            object
                .iter()
                .filter_map(|(key, value)| {
                    value
                        .as_str()
                        .map(|value| (key.clone(), QueryValue::Text(value.to_owned())))
                })
                .collect()
        })
        .unwrap_or_default();
    let default = "/login?error=GOOGLE_LOGIN_FAILED";
    let outcome = call_core(
        app,
        prepared,
        None,
        CoreMethod::Get,
        "/internal/merchant/auth/google/callback".to_owned(),
        scalar,
        None,
        None,
        &[],
        None,
    )
    .await;
    let location = match outcome {
        Ok(response) if response.status < 400 => {
            let body = response.json_body();
            body.get("redirectPath")
                .and_then(Value::as_str)
                .or_else(|| body.get("errorPath").and_then(Value::as_str))
                .unwrap_or(default)
                .to_owned()
        }
        _ => default.to_owned(),
    };
    let mut edge = EdgeResponse::empty(302);
    edge.set_header("location", &location);
    Ok(edge)
}

/// `PATCH /users`: core patches one user per call, so the portal request is fanned out.
pub async fn bulk_users(app: &AppState, prepared: &Prepared) -> Result<EdgeResponse, EdgeApiError> {
    if prepared.authorization.is_none() {
        return Err(EdgeApiError::auth_required());
    }
    let body = validate_to_error(&schemas::user_bulk_patch_schema(), &prepared.json_body)?;
    let ids = body
        .get("userIds")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut users = Vec::with_capacity(ids.len());
    for id in ids {
        let mut merged = body.as_object().cloned().unwrap_or_default();
        merged.insert("id".to_owned(), id);
        let canonical = to_core_user_patch(&Value::Object(merged));
        let canonical = validate_to_error(&crate::contract::core_user_patch_schema(), &canonical)?;
        let bytes = serde_json::to_vec(&canonical).unwrap_or_else(|_| b"{}".to_vec());
        let response = call_core(
            app,
            prepared,
            None,
            CoreMethod::Patch,
            "/internal/merchant/users".to_owned(),
            Vec::new(),
            Some(bytes),
            None,
            &[],
            None,
        )
        .await?;
        if response.status >= 400 {
            return Err(EdgeApiError::from_core(
                response.status,
                &response.json_body(),
            ));
        }
        users.push(response.json_body());
    }
    Ok(EdgeResponse::json(
        200,
        &json!({ "updated": users.len(), "users": users }),
    ))
}

/// The pre-multipart gate (`uploadGuards`): budget, session shape and declared length.
fn upload_guard(app: &AppState, prepared: &Prepared) -> Result<(), EdgeResponse> {
    if prepared.upload_admitted {
        return Ok(());
    }
    let hit = app
        .limiters
        .upload
        .hit(&rate_limit_key(&prepared.client_ip, &["upload"]));
    if !hit.allowed {
        return Err(rate_limited(hit, "Too many uploads, please retry later"));
    }
    pg_edge::assert_session_shape(
        prepared.authorization.as_deref(),
        MERCHANT_AUDIENCE,
        now_ms(),
    )
    .map_err(|error| EdgeResponse::from_error(&EdgeApiError::from_edge(error)))?;
    pg_edge::check_upload_length(
        prepared.content_length,
        app.config.max_upload_bytes,
        pg_edge::UploadKind::Document,
    )
    .map_err(|error| EdgeResponse::from_error(&EdgeApiError::from_edge(error)))?;
    Ok(())
}

fn parse_multipart_body(
    app: &AppState,
    _prepared: &Prepared,
    req: &crate::app::IncomingRequest,
    accepted: &[&str],
) -> Result<multipart::ParsedMultipart, EdgeResponse> {
    multipart::parse(
        req.header("content-type").as_deref(),
        &req.body,
        UploadLimits::with_file_limit(app.config.max_upload_bytes),
        accepted,
    )
    .map_err(|error| EdgeResponse::from_error(&error))
}

/// Detect the PNG/JPEG/PDF magic bytes.
#[must_use]
pub fn detect_upload_mime(bytes: &[u8]) -> Option<&'static str> {
    const SIGNATURES: [(&str, &[u8]); 3] = [
        ("image/png", b"\x89PNG\r\n\x1a\n"),
        ("image/jpeg", b"\xff\xd8\xff"),
        ("application/pdf", b"%PDF-"),
    ];
    SIGNATURES
        .iter()
        .find(|(_, signature)| bytes.starts_with(signature))
        .map(|(mime, _)| *mime)
}

/// `assertAllowedUpload` (`merchant-back/lib/zReady/index.ts:99-132`).
pub fn assert_allowed_upload(
    bytes: &[u8],
    declared_mime: Option<&str>,
    allowed_mimes: &[String],
    max_bytes: u64,
) -> Result<String, EdgeApiError> {
    if bytes.is_empty() {
        return Err(EdgeApiError::new(
            400,
            "UPLOAD_EMPTY",
            "The uploaded document is empty",
        ));
    }
    if bytes.len() as u64 > max_bytes {
        return Err(EdgeApiError::new(
            413,
            "UPLOAD_TOO_LARGE",
            "The uploaded document exceeds the size limit",
        )
        .with_details(json!({
            "maxBytes": max_bytes,
            "receivedBytes": bytes.len(),
        })));
    }
    let normalized = declared_mime
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if !allowed_mimes.iter().any(|allowed| allowed == &normalized) {
        return Err(EdgeApiError::new(
            415,
            "UNSUPPORTED_UPLOAD_TYPE",
            "The uploaded document type is not accepted",
        )
        .with_details(json!({
            "allowed": allowed_mimes,
            "received": normalized,
        })));
    }
    let Some(detected) = detect_upload_mime(bytes) else {
        return Err(EdgeApiError::new(
            415,
            "UPLOAD_SIGNATURE_MISMATCH",
            "The uploaded document is not a valid PNG, JPEG or PDF file",
        ));
    };
    if detected != normalized {
        return Err(EdgeApiError::new(
            415,
            "UPLOAD_SIGNATURE_MISMATCH",
            "The uploaded document content does not match its declared type",
        )
        .with_details(json!({ "declared": normalized, "detected": detected })));
    }
    Ok(detected.to_owned())
}

fn base64_url_json(value: &Value) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(value).unwrap_or_default())
}

fn upload_headers(
    file: &UploadedPart,
    content_type: &str,
    metadata: &Value,
) -> Vec<(String, String)> {
    let digest = Sha256::digest(&file.bytes);
    vec![
        (
            "x-upload-filename".to_owned(),
            encode_uri_component(&file.filename.chars().take(200).collect::<String>()),
        ),
        ("x-upload-content-type".to_owned(), content_type.to_owned()),
        ("x-upload-sha256".to_owned(), hex::encode(digest)),
        ("x-upload-size".to_owned(), file.bytes.len().to_string()),
        ("x-upload-metadata".to_owned(), base64_url_json(metadata)),
    ]
}

/// `POST /onboarding/kyb-documents`.
pub async fn kyb_document(
    app: &AppState,
    prepared: &Prepared,
    req: &crate::app::IncomingRequest,
) -> Result<EdgeResponse, EdgeApiError> {
    if let Err(response) = upload_guard(app, prepared) {
        return Ok(response);
    }
    let parsed = match parse_multipart_body(app, prepared, req, &["document"]) {
        Ok(parsed) => parsed,
        Err(response) => return Ok(response),
    };
    let metadata = Value::Object(parsed.fields.clone());
    let metadata = validate_to_error(&schemas::kyb_document_schema(), &metadata)?;
    let Some(file) = parsed.file_for(&["document"]) else {
        return Err(EdgeApiError::from_edge(
            pg_edge::EdgeError::UploadRequired {
                kind: pg_edge::UploadKind::Document,
                field: "document".to_owned(),
            },
        ));
    };
    forward_upload_with_path(
        app,
        prepared,
        "/internal/merchant/onboarding/kyb-documents",
        file,
        &metadata,
        201,
        true,
    )
    .await
}

/// `POST /disputes/:id/evidence`: the document is embedded base64 in a canonical JSON payload.
pub async fn dispute_evidence(
    app: &AppState,
    prepared: &Prepared,
    req: &crate::app::IncomingRequest,
) -> Result<EdgeResponse, EdgeApiError> {
    if prepared.authorization.is_none() {
        return Err(EdgeApiError::auth_required());
    }
    if let Err(response) = upload_guard(app, prepared) {
        return Ok(response);
    }
    let parsed = match parse_multipart_body(app, prepared, req, &["evidence", "file"]) {
        Ok(parsed) => parsed,
        Err(response) => return Ok(response),
    };
    let metadata_value = Value::Object(parsed.fields.clone());
    let mut metadata = validate_to_error(&schemas::evidence_schema(), &metadata_value)?;
    // `notes ?? note` is resolved before the canonical payload is built.
    if let (Some(notes), None) = (
        metadata.get("note").and_then(Value::as_str),
        metadata.get("notes"),
    ) {
        if let Some(object) = metadata.as_object() {
            let mut object = object.clone();
            object.insert("notes".to_owned(), Value::String(notes.to_owned()));
            metadata = Value::Object(object);
        }
    }
    let id = validate_to_error(
        &schemas::wallet_params_schema(),
        &params_value(&prepared.params),
    )?
    .get("id")
    .and_then(Value::as_str)
    .unwrap_or("")
    .to_owned();
    let Some(file) = parsed.file_for(&["evidence", "file"]) else {
        return Err(EdgeApiError::new(
            400,
            "UPLOAD_REQUIRED",
            "An evidence document file is required in the evidence field",
        ));
    };
    let detected = assert_allowed_upload(
        &file.bytes,
        file.content_type.as_deref(),
        &app.config.upload_allowed_mime,
        app.config.max_upload_bytes,
    )?;
    if file.bytes.len() > MAX_EVIDENCE_FILE_BYTES {
        return Err(EdgeApiError::new(
            413,
            "UPLOAD_TOO_LARGE",
            "The evidence document is too large to be forwarded to core",
        )
        .with_details(json!({
            "maxBytes": MAX_EVIDENCE_FILE_BYTES,
            "receivedBytes": file.bytes.len(),
        })));
    }
    let upload = EvidenceUpload {
        original_name: file.filename.clone(),
        bytes: file.bytes.clone(),
    };
    let payload = to_core_dispute_evidence(&upload, &metadata, &detected);
    let payload = validate_to_error(&core_dispute_evidence_schema(), &payload)?;
    let bytes = serde_json::to_vec(&payload).unwrap_or_else(|_| b"{}".to_vec());
    let response = call_core(
        app,
        prepared,
        None,
        CoreMethod::Post,
        format!(
            "/internal/merchant/disputes/{}/evidence",
            encode_uri_component(&id)
        ),
        Vec::new(),
        Some(bytes),
        None,
        &[],
        None,
    )
    .await?;
    if response.status >= 400 {
        return Err(EdgeApiError::from_core(
            response.status,
            &response.json_body(),
        ));
    }
    Ok(EdgeResponse::json(200, &response.json_body()))
}

/// `POST /disputes/:id/attachments`.
pub async fn dispute_attachment(
    app: &AppState,
    prepared: &Prepared,
    req: &crate::app::IncomingRequest,
) -> Result<EdgeResponse, EdgeApiError> {
    if prepared.authorization.is_none() {
        return Err(EdgeApiError::auth_required());
    }
    if let Err(response) = upload_guard(app, prepared) {
        return Ok(response);
    }
    let parsed = match parse_multipart_body(app, prepared, req, &["file", "evidence"]) {
        Ok(parsed) => parsed,
        Err(response) => return Ok(response),
    };
    let Some(file) = parsed.file_for(&["file", "evidence"]) else {
        return Err(EdgeApiError::new(
            400,
            "UPLOAD_REQUIRED",
            "An evidence file is required",
        ));
    };
    let id = validate_to_error(
        &schemas::wallet_params_schema(),
        &params_value(&prepared.params),
    )?
    .get("id")
    .and_then(Value::as_str)
    .unwrap_or("")
    .to_owned();
    let label = parsed
        .fields
        .get("label")
        .and_then(Value::as_str)
        .unwrap_or(&file.filename)
        .chars()
        .take(255)
        .collect::<String>();
    forward_upload_with_path(
        app,
        prepared,
        &format!(
            "/internal/merchant/disputes/{}/attachments",
            encode_uri_component(&id)
        ),
        file,
        &json!({ "label": label }),
        201,
        true,
    )
    .await
}

/// `POST /sandbox/mirror/disputes/:id/attachments`.
pub async fn sandbox_upload(
    app: &AppState,
    prepared: &Prepared,
    req: &crate::app::IncomingRequest,
) -> Result<EdgeResponse, EdgeApiError> {
    if prepared.authorization.is_none() {
        return Err(EdgeApiError::auth_required());
    }
    if let Err(response) = upload_guard(app, prepared) {
        return Ok(response);
    }
    let parsed = match parse_multipart_body(app, prepared, req, &["file", "evidence"]) {
        Ok(parsed) => parsed,
        Err(response) => return Ok(response),
    };
    let Some(file) = parsed.file_for(&["file", "evidence"]) else {
        return Err(EdgeApiError::new(
            400,
            "UPLOAD_REQUIRED",
            "An evidence file is required",
        ));
    };
    let id = validate_to_error(
        &schemas::wallet_params_schema(),
        &params_value(&prepared.params),
    )?
    .get("id")
    .and_then(Value::as_str)
    .unwrap_or("")
    .to_owned();
    let label = parsed
        .fields
        .get("label")
        .and_then(Value::as_str)
        .unwrap_or(&file.filename)
        .chars()
        .take(255)
        .collect::<String>();
    // The Sandbox mirror sends the declared type unchanged (no magic check in TS).
    let content_type = file
        .content_type
        .clone()
        .unwrap_or_else(|| "application/octet-stream".to_owned());
    let headers = upload_headers(file, &content_type, &json!({ "label": label }));
    let response = call_core(
        app,
        prepared,
        Some(Plane::Sandbox),
        CoreMethod::Post,
        format!(
            "/internal/merchant/disputes/{}/attachments",
            encode_uri_component(&id)
        ),
        Vec::new(),
        Some(file.bytes.clone()),
        Some("application/octet-stream"),
        &headers,
        None,
    )
    .await?;
    if response.status >= 400 {
        return Err(EdgeApiError::from_core(
            response.status,
            &response.json_body(),
        ));
    }
    Ok(EdgeResponse::json(201, &response.json_body()))
}

async fn forward_upload_with_path(
    app: &AppState,
    prepared: &Prepared,
    path: &str,
    file: &UploadedPart,
    metadata: &Value,
    status: u16,
    detect: bool,
) -> Result<EdgeResponse, EdgeApiError> {
    let content_type = if detect {
        assert_allowed_upload(
            &file.bytes,
            file.content_type.as_deref(),
            &app.config.upload_allowed_mime,
            app.config.max_upload_bytes,
        )?
    } else {
        file.content_type
            .clone()
            .unwrap_or_else(|| "application/octet-stream".to_owned())
    };
    let headers = upload_headers(file, &content_type, metadata);
    let response = call_core(
        app,
        prepared,
        None,
        CoreMethod::Post,
        path.to_owned(),
        Vec::new(),
        Some(file.bytes.clone()),
        Some("application/octet-stream"),
        &headers,
        None,
    )
    .await?;
    if response.status >= 400 {
        return Err(EdgeApiError::from_core(
            response.status,
            &response.json_body(),
        ));
    }
    Ok(EdgeResponse::json(status, &response.json_body()))
}

/// `proxyPath` of the Sandbox Studio namespace.
#[must_use]
pub fn proxy_path(sub_path: &str) -> String {
    if sub_path.starts_with("/fake-rails/") {
        return format!("/internal/sandbox{sub_path}");
    }
    let wallet_detail = sub_path
        .strip_prefix("/wallets/")
        .is_some_and(|rest| !rest.is_empty());
    let payment_detail = sub_path
        .strip_prefix("/payments/")
        .is_some_and(|rest| !rest.is_empty());
    let dispute_resolve = sub_path.starts_with("/disputes/") && sub_path.ends_with("/resolve");
    if sub_path == "/overview"
        || sub_path.starts_with("/studio/")
        || sub_path == "/seed-demo"
        || sub_path == "/seed-history"
        || sub_path == "/reset"
        || sub_path == "/webhooks/test-ping"
        || wallet_detail
        || payment_detail
        || dispute_resolve
        || sub_path.starts_with("/reconciliation/")
    {
        format!("/internal/sandbox/merchant{sub_path}")
    } else {
        format!("/internal/merchant{sub_path}")
    }
}

/// All query parameters as strings (`String(array)` joins with a comma, like JS).
fn all_query(req: &crate::app::IncomingRequest) -> Vec<(String, QueryValue)> {
    crate::http::query_object(&req.query)
        .into_iter()
        .map(|(key, value)| {
            let text = match value {
                Value::String(text) => text,
                Value::Array(items) => items
                    .iter()
                    .map(|item| item.as_str().unwrap_or("").to_owned())
                    .collect::<Vec<_>>()
                    .join(","),
                other => other.to_string(),
            };
            (key, QueryValue::Text(text))
        })
        .collect()
}

/// `/api/v1/merchant/sandbox/*`.
pub async fn sandbox_proxy(
    app: &AppState,
    prepared: &Prepared,
    req: &crate::app::IncomingRequest,
) -> Result<EdgeResponse, EdgeApiError> {
    if prepared.authorization.is_none() {
        return Err(EdgeApiError::auth_required());
    }
    if !app.sandbox_configured() {
        return Err(EdgeApiError::from_pool(
            &pg_upstream::PoolError::sandbox_unavailable(),
        ));
    }
    let prefix = "/api/v1/merchant/sandbox";
    let sub_path = req.path.strip_prefix(prefix).unwrap_or("");
    if sub_path == "/mirror" || sub_path.starts_with("/mirror/") {
        let mirror_path = sub_path.strip_prefix("/mirror").unwrap_or("/");
        if let Some(screen) = mirror_screen_code(mirror_path) {
            let path = PathTemplate::parse("/internal/merchant/pos/screens/:screenCode/stream");
            let params = schemas::screen_params_schema();
            let mut prepared_params = prepared.params.clone();
            prepared_params.insert("screenCode".to_owned(), screen.to_owned());
            return open_stream(app, prepared, req, &path, &params, &prepared_params, true).await;
        }
        let response = call_core(
            app,
            prepared,
            Some(Plane::Sandbox),
            method_of(&req.method),
            format!("/internal/merchant{mirror_path}"),
            all_query(req),
            body_bytes(prepared, &req.method),
            None,
            &[],
            None,
        )
        .await?;
        let mut edge = EdgeResponse::bytes(response.status, response.body.clone());
        if let Some(content_type) = response.header("content-type") {
            edge.set_header("content-type", content_type);
        }
        if let Some(disposition) = response.header("content-disposition") {
            edge.set_header("content-disposition", disposition);
        }
        return Ok(edge);
    }
    let path = proxy_path(sub_path);
    let response = call_core(
        app,
        prepared,
        Some(Plane::Sandbox),
        method_of(&req.method),
        path,
        all_query(req),
        body_bytes(prepared, &req.method),
        None,
        &[],
        None,
    )
    .await?;
    if response.status >= 400 {
        return Err(EdgeApiError::from_core(
            response.status,
            &response.json_body(),
        ));
    }
    let mut edge = EdgeResponse::json(response.status, &response.json_body());
    for (name, value) in relayed_headers(&response) {
        edge.set_header(&name, &value);
    }
    Ok(edge)
}

fn mirror_screen_code(path: &str) -> Option<&str> {
    let rest = path.strip_prefix("/pos/screens/")?;
    let code = rest.strip_suffix("/stream")?;
    if code.is_empty() || code.contains('/') {
        return None;
    }
    Some(code)
}

fn method_of(method: &str) -> CoreMethod {
    CoreMethod::parse(method).unwrap_or(CoreMethod::Get)
}

fn body_bytes(prepared: &Prepared, method: &str) -> Option<Vec<u8>> {
    if method == "GET" || method == "HEAD" {
        None
    } else {
        Some(serde_json::to_vec(&prepared.json_body).unwrap_or_else(|_| b"{}".to_vec()))
    }
}

/// `GET /pos/screens/:screenCode/stream`.
pub async fn pos_stream(
    app: &AppState,
    prepared: &Prepared,
    req: &crate::app::IncomingRequest,
    path: &PathTemplate,
    params: &Schema,
) -> Result<EdgeResponse, EdgeApiError> {
    open_stream(app, prepared, req, path, params, &prepared.params, true).await
}

/// `GET /disputes/:id/attachments/:attachmentId/content`.
pub async fn attachment_content(
    app: &AppState,
    prepared: &Prepared,
    req: &crate::app::IncomingRequest,
    path: &PathTemplate,
    params: &Schema,
) -> Result<EdgeResponse, EdgeApiError> {
    open_stream(app, prepared, req, path, params, &prepared.params, false).await
}

struct GuardedStream {
    inner: CoreByteStream,
    _guard: StreamSlotGuard,
}

impl Stream for GuardedStream {
    type Item = Result<Bytes, std::io::Error>;

    fn poll_next(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        this.inner.as_mut().poll_next(context)
    }
}

async fn open_stream(
    app: &AppState,
    prepared: &Prepared,
    _req: &crate::app::IncomingRequest,
    path: &PathTemplate,
    params_schema: &Schema,
    params: &std::collections::BTreeMap<String, String>,
    _sse: bool,
) -> Result<EdgeResponse, EdgeApiError> {
    if prepared.authorization.is_none() {
        return Err(EdgeApiError::auth_required());
    }
    let validated = validate_to_error(params_schema, &params_value(params))?;
    let mut rendered_params = std::collections::BTreeMap::new();
    if let Value::Object(object) = validated {
        for (key, value) in object {
            if let Some(value) = value.as_str() {
                rendered_params.insert(key, value.to_owned());
            }
        }
    }
    let Some(guard) = app.streams.acquire(&prepared.client_ip) else {
        return Err(EdgeApiError::new(
            429,
            "STREAM_LIMIT_REACHED",
            "Too many concurrent event streams for this client",
        ));
    };
    let plane = plane_for_authorization(prepared.authorization.as_deref());
    if plane == Plane::Sandbox && !app.sandbox_configured() {
        return Err(EdgeApiError::from_pool(
            &pg_upstream::PoolError::sandbox_unavailable(),
        ));
    }
    let meta = pg_upstream::CoreRequestMeta {
        channel: pg_upstream::EdgeChannel::Merchant,
        plane,
        request_id: &prepared.request_id,
        client_ip: &prepared.client_ip,
        user_agent: prepared.user_agent.as_deref(),
        authorization: prepared.authorization.as_deref(),
        body_present: false,
        raw_content_type: None,
        min_lsn: None,
        idempotency_key: None,
    };
    let headers = CoreRequest::build_headers(&[], &meta, None)
        .map_err(|error| EdgeApiError::from_pool(&error))?;
    let request = CoreRequest {
        plane,
        method: CoreMethod::Get,
        path: path.render(&rendered_params),
        query: Vec::new(),
        headers,
        body: None,
        timeout_ms: Some(app.config.pos_stream_timeout_ms),
    };
    let upstream = app
        .transport
        .open_stream(request)
        .await
        .map_err(|error| EdgeApiError::from_pool(&error))?;
    if upstream.status >= 400 {
        let mut stream = upstream.stream;
        let mut body = Vec::new();
        let cap = app.config.max_response_bytes;
        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(chunk) => {
                    if body.len() as u64 + chunk.len() as u64 > cap {
                        break;
                    }
                    body.extend_from_slice(&chunk);
                }
                Err(_) => break,
            }
        }
        return Err(EdgeApiError::from_core(
            upstream.status,
            &parse_json_buffer(&body),
        ));
    }
    let content_type = upstream
        .header("content-type")
        .unwrap_or("text/event-stream")
        .to_owned();
    let disposition = upstream.header("content-disposition").map(str::to_owned);
    let stream: CoreByteStream = Box::pin(GuardedStream {
        inner: upstream.stream,
        _guard: guard,
    });
    let mut edge = EdgeResponse::stream(upstream.status, stream);
    edge.set_header("content-type", &content_type);
    if let Some(disposition) = disposition {
        edge.set_header("content-disposition", &disposition);
    }
    edge.set_header("cache-control", "no-cache, no-transform");
    edge.set_header("connection", "keep-alive");
    edge.set_header("x-accel-buffering", "no");
    Ok(edge)
}

#[allow(clippy::too_many_arguments)]
async fn call_core(
    app: &AppState,
    prepared: &Prepared,
    plane_override: Option<Plane>,
    method: CoreMethod,
    path: String,
    query: Vec<(String, QueryValue)>,
    body: Option<Vec<u8>>,
    raw_content_type: Option<&str>,
    extra_headers: &[(String, String)],
    timeout_ms: Option<u64>,
) -> Result<CoreResponse, EdgeApiError> {
    let plane = plane_override
        .unwrap_or_else(|| plane_for_authorization(prepared.authorization.as_deref()));
    if plane == Plane::Sandbox && !app.sandbox_configured() {
        return Err(EdgeApiError::from_pool(
            &pg_upstream::PoolError::sandbox_unavailable(),
        ));
    }
    let caller: Vec<(&str, &str)> = extra_headers
        .iter()
        .map(|(name, value)| (name.as_str(), value.as_str()))
        .collect();
    let meta = pg_upstream::CoreRequestMeta {
        channel: pg_upstream::EdgeChannel::Merchant,
        plane,
        request_id: &prepared.request_id,
        client_ip: &prepared.client_ip,
        user_agent: prepared.user_agent.as_deref(),
        authorization: prepared.authorization.as_deref(),
        body_present: body.is_some(),
        raw_content_type,
        min_lsn: None,
        idempotency_key: None,
    };
    let headers = CoreRequest::build_headers(&caller, &meta, body.as_ref().map(Vec::len))
        .map_err(|error| EdgeApiError::from_pool(&error))?;
    let request = CoreRequest {
        plane,
        method,
        path,
        query,
        headers,
        body,
        timeout_ms,
    };
    app.transport
        .call(request)
        .await
        .map_err(|error| EdgeApiError::from_pool(&error))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upload_magic_detection_and_allow_list() {
        let allowed = vec![
            "image/png".to_owned(),
            "image/jpeg".to_owned(),
            "application/pdf".to_owned(),
        ];
        let png = b"\x89PNG\r\n\x1a\npayload";
        assert_eq!(
            assert_allowed_upload(png, Some("image/png"), &allowed, 1024).expect("png"),
            "image/png"
        );
        assert_eq!(
            assert_allowed_upload(png, Some("image/png; charset=binary"), &allowed, 1024)
                .expect("png"),
            "image/png"
        );
        let pdf = b"%PDF-1.7\n";
        assert_eq!(
            assert_allowed_upload(pdf, Some("application/pdf"), &allowed, 1024).expect("pdf"),
            "application/pdf"
        );
        let jpeg = [0xff, 0xd8, 0xff, 0xe0, 0x00];
        assert_eq!(
            assert_allowed_upload(&jpeg, Some("image/jpeg"), &allowed, 1024).expect("jpeg"),
            "image/jpeg"
        );

        let error = assert_allowed_upload(b"not an image", Some("image/png"), &allowed, 1024)
            .expect_err("signature");
        assert_eq!(error.code, "UPLOAD_SIGNATURE_MISMATCH");
        assert_eq!(error.status, 415);

        let error =
            assert_allowed_upload(pdf, Some("image/png"), &allowed, 1024).expect_err("mismatch");
        assert_eq!(
            error.details.as_ref().expect("details")["detected"],
            json!("application/pdf")
        );

        let error =
            assert_allowed_upload(pdf, Some("text/plain"), &allowed, 1024).expect_err("type");
        assert_eq!(error.code, "UNSUPPORTED_UPLOAD_TYPE");
        assert_eq!(error.status, 415);

        let error =
            assert_allowed_upload(b"", Some("image/png"), &allowed, 1024).expect_err("empty");
        assert_eq!(error.code, "UPLOAD_EMPTY");

        let error = assert_allowed_upload(png, Some("image/png"), &allowed, 4).expect_err("large");
        assert_eq!(error.code, "UPLOAD_TOO_LARGE");
        assert_eq!(error.status, 413);
    }

    #[test]
    fn sandbox_proxy_path_rewriting_matches_the_typescript_rules() {
        assert_eq!(
            proxy_path("/overview"),
            "/internal/sandbox/merchant/overview"
        );
        assert_eq!(
            proxy_path("/studio/wallets"),
            "/internal/sandbox/merchant/studio/wallets"
        );
        assert_eq!(
            proxy_path("/seed-demo"),
            "/internal/sandbox/merchant/seed-demo"
        );
        assert_eq!(
            proxy_path("/seed-history"),
            "/internal/sandbox/merchant/seed-history"
        );
        assert_eq!(proxy_path("/reset"), "/internal/sandbox/merchant/reset");
        assert_eq!(
            proxy_path("/webhooks/test-ping"),
            "/internal/sandbox/merchant/webhooks/test-ping"
        );
        assert_eq!(
            proxy_path("/wallets/wal_1/ledger"),
            "/internal/sandbox/merchant/wallets/wal_1/ledger"
        );
        assert_eq!(
            proxy_path("/payments/pay_1/refund"),
            "/internal/sandbox/merchant/payments/pay_1/refund"
        );
        assert_eq!(
            proxy_path("/disputes/dis_1/resolve"),
            "/internal/sandbox/merchant/disputes/dis_1/resolve"
        );
        assert_eq!(
            proxy_path("/reconciliation/runs"),
            "/internal/sandbox/merchant/reconciliation/runs"
        );
        assert_eq!(
            proxy_path("/fake-rails/accounts"),
            "/internal/sandbox/fake-rails/accounts"
        );
        // List/create routes keep the Live merchant router on the sandbox pool.
        assert_eq!(proxy_path("/wallets"), "/internal/merchant/wallets");
        assert_eq!(
            proxy_path("/seed-demo-extra"),
            "/internal/merchant/seed-demo-extra"
        );
        assert_eq!(proxy_path(""), "/internal/merchant");
    }

    #[test]
    fn mirror_stream_detection() {
        assert_eq!(
            mirror_screen_code("/pos/screens/SCREEN1/stream"),
            Some("SCREEN1")
        );
        assert_eq!(mirror_screen_code("/pos/screens/a/b/stream"), None);
        assert_eq!(mirror_screen_code("/pos/screens//stream"), None);
        assert_eq!(mirror_screen_code("/pos/terminals"), None);
    }

    #[test]
    fn external_token_shape() {
        let config =
            crate::config::EdgeConfig::for_embedding(vec!["https://core.test".to_owned()], None);
        let core = crate::upstream::test_support::FakeCore::new();
        let app = AppState::new(
            config,
            std::sync::Arc::new(core),
            "r".to_owned(),
            "c".to_owned(),
        );
        assert!(valid_external_token(
            &app,
            &format!("pg_live_{}", "A".repeat(43))
        ));
        assert!(valid_external_token(
            &app,
            &format!("pg_test_{}", "A".repeat(43))
        ));
        assert!(!valid_external_token(&app, "pg_live_short"));
        assert!(!valid_external_token(
            &app,
            &format!("other_{}", "A".repeat(43))
        ));
        assert!(!valid_external_token(
            &app,
            &format!("pg_live_{}", "A".repeat(42))
        ));
        assert!(!valid_external_token(
            &app,
            &format!("pg_live_{}", "!".repeat(43))
        ));
        // The configured prefix is honoured as well.
        assert!(valid_external_token(
            &app,
            &format!("pg_live_{}", "A".repeat(43))
        ));
    }
}

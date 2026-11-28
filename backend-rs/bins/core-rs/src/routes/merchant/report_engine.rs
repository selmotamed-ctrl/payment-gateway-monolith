//! Merchant Report Studio reads: authored report versions, chrome (header/footer) versions, the
//! migration queues and usage counters.
//!
//! Port of `core-back/api/internal/merchantReportEngine.ts:770-884` (chrome list/detail/needs
//! migration), `1405-1715` (specs list/detail/needs migration/usage). Execution, verification,
//! transcripts, migration prompts and the catalog stay in P8 (see the module doc of `merchant`).
//!
//! The stored-spec compatibility classifier is reimplemented here from
//! `lib/reportEngineSdk/compatibility/*` because `core-rs` does not link `pg-report-engine` yet.
//! Its version gates and messages are copied verbatim; the "current schema" check is structural
//! (kind, version, datasets, sections) instead of the full serde view.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use ntex::web::HttpRequest;
use pg_domain_auth::Principal;
use serde_json::{json, Map, Value};
use sqlx::Row;
use uuid::Uuid;

use super::super::common::json_ok;
use super::super::{Handler, HandlerFuture, MountedRoute, PrincipalGuard};
use super::{
    assert_merchant_authority, path_uuid, positive_int, query_scalar, require_merchant_session,
};
use crate::http::error_response;
use crate::routes::common::database_error;
use crate::state::AppState;
use pg_http::{ApiError, Authn, BodyRule, Channel, Policy, ScopeRule};

const ORIGIN_CHROME: &str = "core-back/api/internal/merchantReportEngine.ts:770";
const ORIGIN_CHROME_DETAIL: &str = "core-back/api/internal/merchantReportEngine.ts:886";
const ORIGIN_CHROME_MIGRATION: &str = "core-back/api/internal/merchantReportEngine.ts:824";
const ORIGIN_SPECS: &str = "core-back/api/internal/merchantReportEngine.ts:1405";
const ORIGIN_SPEC: &str = "core-back/api/internal/merchantReportEngine.ts:1507";
const ORIGIN_SPEC_MIGRATION: &str = "core-back/api/internal/merchantReportEngine.ts:1434";
const ORIGIN_USAGE: &str = "core-back/api/internal/merchantReportEngine.ts:1680";

/// `REPORT_ENGINE_VERSION` (`pg-report-engine` carries the released artefact).
pub const REPORT_ENGINE_VERSION: &str = pg_report_engine::REPORT_ENGINE_VERSION;
/// `REPORT_SPEC_VERSION`.
pub const REPORT_SPEC_VERSION: &str = pg_report_engine::REPORT_SPEC_VERSION;
/// `REPORT_CHROME_SPEC_VERSION`.
pub const REPORT_CHROME_SPEC_VERSION: &str = pg_report_engine::REPORT_CHROME_SPEC_VERSION;
/// `MERCHANT_TIER_LIMITS.maxCodes`.
pub const MAX_REPORT_CODES: i64 = 50;

/// Routes owned by this module.
#[must_use]
pub fn routes() -> Vec<MountedRoute> {
    let author = super::policy_authorities(&["report_engine:author"]);
    let author_refs: Vec<&str> = author.iter().map(String::as_str).collect();
    let route = |path: &str, origin: &str, authorities: &[&str], handler| MountedRoute {
        policy: Policy::new("GET", path, Channel::Merchant, Authn::Session, origin)
            .authorities(authorities)
            .merchant_scope(ScopeRule::Required)
            .body(BodyRule::None),
        handler,
        guard: PrincipalGuard::Merchant,
    };
    vec![
        // Static segments precede `/specs/:id`, like the Express registration order.
        route(
            "/internal/merchant/report-engine/studio/specs",
            ORIGIN_SPECS,
            &author_refs,
            Handler::Custom(studio_specs),
        ),
        route(
            "/internal/merchant/report-engine/studio/needs-migration",
            ORIGIN_SPEC_MIGRATION,
            &author_refs,
            Handler::Custom(studio_needs_migration),
        ),
        route(
            "/internal/merchant/report-engine/studio/specs/:id",
            ORIGIN_SPEC,
            &author_refs,
            Handler::Custom(studio_spec),
        ),
        route(
            "/internal/merchant/report-engine/studio/usage",
            ORIGIN_USAGE,
            &author_refs,
            Handler::Custom(studio_usage),
        ),
        route(
            "/internal/merchant/report-engine/studio/chrome",
            ORIGIN_CHROME,
            &author_refs,
            Handler::Custom(studio_chrome),
        ),
        route(
            "/internal/merchant/report-engine/studio/chrome/needs-migration",
            ORIGIN_CHROME_MIGRATION,
            &author_refs,
            Handler::Custom(studio_chrome_needs_migration),
        ),
        route(
            "/internal/merchant/report-engine/studio/chrome/:id",
            ORIGIN_CHROME_DETAIL,
            &author_refs,
            Handler::Custom(studio_chrome_detail),
        ),
    ]
}

// ---------------------------------------------------------------------------------------------
// Compatibility (pg-report-engine classifier + chrome version gates)
// ---------------------------------------------------------------------------------------------

fn major_version_of(version: Option<&str>) -> Option<u32> {
    let trimmed = version?.trim();
    let digits: String = trimmed.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        None
    } else {
        digits.parse::<u32>().ok()
    }
}

fn supported_engine(version: Option<&str>) -> bool {
    pg_report_engine::is_supported_engine_version(version)
}

fn supported_chrome_spec(version: Option<&str>) -> bool {
    pg_report_engine::is_supported_chrome_spec_version(version)
}

fn parse_json_value(value: &Value) -> Option<Value> {
    match value {
        Value::String(text) => serde_json::from_str(text).ok(),
        Value::Null => None,
        other => Some(other.clone()),
    }
}

fn declared_text(value: &Value, key: &str) -> Option<String> {
    value.as_object()?.get(key)?.as_str().map(str::to_owned)
}

fn issue(path: &str, code: &str, message: &str) -> Value {
    json!({ "path": path, "code": code, "message": message })
}

struct CompatibilityView<'a> {
    status: &'a str,
    reason: Option<&'a str>,
    message: &'a str,
    stored_engine: Option<&'a str>,
    stored_spec: Option<&'a str>,
    current_spec: &'a str,
    declared: Option<&'a str>,
    issues: Vec<Value>,
    prompt_available: bool,
}

impl CompatibilityView<'_> {
    fn into_json(self) -> Value {
        let mut map = Map::new();
        map.insert(
            "storedEngineVersion".to_owned(),
            self.stored_engine
                .map_or(Value::Null, |value| Value::String(value.to_owned())),
        );
        map.insert(
            "storedSpecVersion".to_owned(),
            self.stored_spec
                .map_or(Value::Null, |value| Value::String(value.to_owned())),
        );
        map.insert(
            "currentEngineVersion".to_owned(),
            Value::String(REPORT_ENGINE_VERSION.to_owned()),
        );
        map.insert(
            "currentSpecVersion".to_owned(),
            Value::String(self.current_spec.to_owned()),
        );
        map.insert(
            "declaredSpecVersion".to_owned(),
            self.declared
                .map_or(Value::Null, |value| Value::String(value.to_owned())),
        );
        map.insert(
            "promptAvailable".to_owned(),
            Value::Bool(self.prompt_available),
        );
        map.insert("status".to_owned(), Value::String(self.status.to_owned()));
        map.insert(
            "reasonCode".to_owned(),
            self.reason
                .map_or(Value::Null, |value| Value::String(value.to_owned())),
        );
        map.insert("message".to_owned(), Value::String(self.message.to_owned()));
        map.insert("issues".to_owned(), Value::Array(self.issues));
        Value::Object(map)
    }
}

/// `classifyStoredReportSpec` (`pg-report-engine` ports the released SDK classifier; the port names
/// `INVALID` `UNSUPPORTED` internally, so it is mapped back to the TS wire value here).
#[must_use]
pub fn report_compatibility(
    spec_json: &Value,
    stored_engine: Option<&str>,
    stored_spec: Option<&str>,
) -> Value {
    let declared = parse_json_value(spec_json)
        .as_ref()
        .and_then(|value| declared_text(value, "spec_version"));
    let Some(parsed) = parse_json_value(spec_json) else {
        return CompatibilityView {
            status: "INVALID",
            reason: Some("INVALID_SPEC_JSON"),
            message: "The stored report spec is not valid JSON.",
            stored_engine,
            stored_spec: stored_spec.or(declared.as_deref()),
            current_spec: REPORT_SPEC_VERSION,
            declared: declared.as_deref(),
            issues: Vec::new(),
            prompt_available: true,
        }
        .into_json();
    };
    let result = pg_report_engine::classify_stored_report_spec(pg_report_engine::StoredSpecInput {
        spec_json: &parsed,
        stored_engine_version: stored_engine,
        stored_spec_version: stored_spec,
    });
    let status = match result.status {
        pg_report_engine::Compatibility::Compatible => "COMPATIBLE",
        pg_report_engine::Compatibility::NeedsMigration => "NEEDS_MIGRATION",
        pg_report_engine::Compatibility::Unsupported => "INVALID",
    };
    let issues = result
        .issues
        .iter()
        .map(|issue| {
            json!({
                "path": issue.path.clone(),
                "code": issue.code.clone(),
                "message": issue.message.clone(),
            })
        })
        .collect();
    CompatibilityView {
        status,
        reason: result.reason_code.map(|code| code.as_str()),
        message: &result.message,
        stored_engine: result.stored_engine_version.as_deref(),
        stored_spec: result.stored_spec_version.as_deref(),
        current_spec: REPORT_SPEC_VERSION,
        declared: result.declared_spec_version.as_deref(),
        issues,
        prompt_available: result.prompt_available,
    }
    .into_json()
}

/// `classifyStoredChromeSpec` (`lib/reportEngineSdk/compatibility/chromeCompatibility.ts`).
#[must_use]
pub fn chrome_compatibility(
    spec_json: &Value,
    stored_engine: Option<&str>,
    stored_spec: Option<&str>,
) -> Value {
    let parsed = parse_json_value(spec_json);
    let declared = parsed
        .as_ref()
        .and_then(|value| declared_text(value, "spec_version"));
    let kind = parsed
        .as_ref()
        .and_then(|value| declared_text(value, "spec_kind"));
    let stored_spec_version = stored_spec.map(str::to_owned).or_else(|| declared.clone());
    let base =
        |status: &str, reason: Option<&str>, message: &str, issues: Vec<Value>, prompt: bool| {
            CompatibilityView {
                status,
                reason,
                message,
                stored_engine,
                stored_spec: stored_spec_version.as_deref(),
                current_spec: REPORT_CHROME_SPEC_VERSION,
                declared: declared.as_deref(),
                issues,
                prompt_available: prompt,
            }
            .into_json()
        };
    let Some(parsed) = parsed else {
        return base(
            "INVALID",
            Some("INVALID_SPEC_JSON"),
            "The stored chrome spec is not valid JSON.",
            Vec::new(),
            true,
        );
    };
    if kind.as_deref() != Some("REPORT_CHROME") {
        return base(
            "INVALID",
            Some("WRONG_SPEC_KIND"),
            "The stored chrome spec is not a REPORT_CHROME.",
            vec![issue(
                "spec_kind",
                "WRONG_SPEC_KIND",
                "Expected REPORT_CHROME.",
            )],
            true,
        );
    }
    if stored_engine.is_none_or(str::is_empty)
        || stored_spec_version.as_deref().is_none_or(str::is_empty)
    {
        return base(
            "NEEDS_MIGRATION",
            Some("MISSING_VERSION_METADATA"),
            "The stored chrome spec has no recorded engine/spec version.",
            Vec::new(),
            true,
        );
    }
    if !supported_engine(stored_engine) {
        let stored = stored_engine.unwrap_or_default();
        let major = major_version_of(Some(stored));
        return base(
            "NEEDS_MIGRATION",
            Some("ENGINE_MAJOR_VERSION_MISMATCH"),
            &format!(
                "The header/footer was saved for engine version {stored}; this engine is {REPORT_ENGINE_VERSION}."
            ),
            vec![issue(
                "engine_version",
                "ENGINE_MAJOR_VERSION_MISMATCH",
                &format!(
                    "Engine major {} is not supported.",
                    major.map_or_else(|| "unknown".to_owned(), |value| value.to_string())
                ),
            )],
            true,
        );
    }
    if !supported_chrome_spec(stored_spec_version.as_deref()) {
        let stored = stored_spec_version.as_deref().unwrap_or_default();
        return base(
            "NEEDS_MIGRATION",
            Some("SPEC_VERSION_UNSUPPORTED"),
            &format!(
                "The header/footer uses spec version {stored}; this engine supports {REPORT_CHROME_SPEC_VERSION}."
            ),
            vec![issue(
                "spec_version",
                "SPEC_VERSION_UNSUPPORTED",
                &format!("Chrome spec version {stored} is not supported."),
            )],
            true,
        );
    }
    if parsed.get("chrome").and_then(Value::as_object).is_none() {
        return base(
            "INVALID",
            Some("CURRENT_SCHEMA_VALIDATION_FAILED"),
            "The stored chrome spec does not match the current schema.",
            vec![issue("chrome", "invalid_type", "Required")],
            true,
        );
    }
    base(
        "COMPATIBLE",
        None,
        "The stored chrome spec is compatible with the running engine.",
        Vec::new(),
        false,
    )
}

// ---------------------------------------------------------------------------------------------
// Merchant report policy and availability
// ---------------------------------------------------------------------------------------------

pub(super) struct ReportPolicy {
    pub(super) enabled: bool,
    pub(super) assets_enabled: bool,
}

fn value_is_false(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(false)) => true,
        Some(Value::String(text)) => text == "false",
        _ => false,
    }
}

async fn read_policy(state: &AppState) -> Result<ReportPolicy, ApiError> {
    let row = sqlx::query(
        "SELECT value_json FROM platform_settings \
          WHERE key = 'merchant_reports.policy' AND scope = 'PLATFORM' \
          ORDER BY version DESC LIMIT 1",
    )
    .fetch_optional(&state.pools.main)
    .await
    .map_err(database_error)?;
    let value = row
        .and_then(|row| row.try_get::<Value, _>("value_json").ok())
        .filter(Value::is_object)
        .unwrap_or(Value::Null);
    let enabled = !value_is_false(value.get("enabled"));
    let assets_raw = value
        .get("assetsEnabled")
        .or_else(|| value.get("assets_enabled"));
    let assets_enabled = !value_is_false(assets_raw);
    Ok(ReportPolicy {
        enabled,
        assets_enabled,
    })
}

pub(super) async fn assert_engine_available(
    state: &AppState,
    merchant_id: Uuid,
) -> Result<ReportPolicy, ApiError> {
    let policy = read_policy(state).await?;
    if !policy.enabled {
        return Err(ApiError::new(
            503,
            "MERCHANT_REPORT_DISABLED",
            "Merchant reporting is disabled by platform policy",
        ));
    }
    let status = sqlx::query(
        "SELECT suspended_at, reason FROM merchant_report_studio_status WHERE merchant_id = $1",
    )
    .bind(merchant_id)
    .fetch_optional(&state.pools.main)
    .await
    .map_err(database_error)?;
    if let Some(row) = status {
        let suspended: Option<DateTime<Utc>> = row.try_get("suspended_at").unwrap_or(None);
        if suspended.is_some() {
            let reason: Option<String> = row.try_get("reason").unwrap_or(None);
            let message = reason.map_or_else(
                || "Merchant reporting is suspended".to_owned(),
                |reason| format!("Merchant reporting is suspended: {reason}"),
            );
            return Err(ApiError::new(
                403,
                "MERCHANT_REPORT_STUDIO_SUSPENDED",
                message,
            ));
        }
    }
    Ok(policy)
}

// ---------------------------------------------------------------------------------------------
// Studio report specs
// ---------------------------------------------------------------------------------------------

fn report_spec_not_found() -> ApiError {
    ApiError::new(
        404,
        "MERCHANT_REPORT_SPEC_NOT_FOUND",
        "The report spec does not exist",
    )
}

/// `GET /internal/merchant/report-engine/studio/specs`.
pub fn studio_specs<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: ntex::web::types::Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            let (principal, merchant_id) = require_merchant_session(principal)?;
            assert_merchant_authority(principal, &["report_engine:author"])?;
            Ok(merchant_id)
        })();
        let merchant_id = match result {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        let code = query_scalar(request, "code").filter(|value| !value.is_empty());
        let mut sql = String::from(
            "SELECT id, code, version, category, status::text AS status, is_latest_published, \
                    supported_locales, default_locale, engine_version, spec_schema_version, \
                    authoring_transcript_version, spec_json, asset_bundle_id, created_at, \
                    published_at \
               FROM merchant_report_specs WHERE merchant_id = $1",
        );
        if code.is_some() {
            sql.push_str(" AND code = $2");
        }
        sql.push_str(" ORDER BY code ASC, version DESC");
        let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(merchant_id);
        if let Some(code) = code {
            query = query.bind(code);
        }
        let rows = match query.fetch_all(&state.pools.main).await {
            Ok(rows) => rows,
            Err(error) => return error_response(request, database_error(error)),
        };
        let mut specs = Vec::with_capacity(rows.len());
        for row in &rows {
            let spec_json: Value = row.try_get("spec_json").unwrap_or(Value::Null);
            let compatibility = report_compatibility(
                &spec_json,
                row.try_get::<Option<String>, _>("engine_version")
                    .unwrap_or(None)
                    .as_deref(),
                row.try_get::<Option<String>, _>("spec_schema_version")
                    .unwrap_or(None)
                    .as_deref(),
            );
            let mut item = Map::new();
            item.insert(
                "id".to_owned(),
                Value::String(row.get::<Uuid, _>("id").to_string()),
            );
            item.insert("code".to_owned(), Value::String(row.get("code")));
            item.insert(
                "version".to_owned(),
                Value::from(row.get::<i32, _>("version")),
            );
            item.insert("category".to_owned(), Value::String(row.get("category")));
            item.insert("status".to_owned(), Value::String(row.get("status")));
            item.insert(
                "isLatestPublished".to_owned(),
                Value::Bool(row.get("is_latest_published")),
            );
            item.insert(
                "supportedLocales".to_owned(),
                Value::Array(
                    row.try_get::<Vec<String>, _>("supported_locales")
                        .unwrap_or_default()
                        .into_iter()
                        .map(Value::String)
                        .collect(),
                ),
            );
            item.insert(
                "defaultLocale".to_owned(),
                Value::String(row.get("default_locale")),
            );
            item.insert(
                "engineVersion".to_owned(),
                Value::String(row.get("engine_version")),
            );
            item.insert(
                "specSchemaVersion".to_owned(),
                Value::String(row.get("spec_schema_version")),
            );
            item.insert(
                "authoringTranscriptVersion".to_owned(),
                row.try_get::<Option<String>, _>("authoring_transcript_version")
                    .unwrap_or(None)
                    .map_or(Value::Null, Value::String),
            );
            item.insert("compatibility".to_owned(), compatibility);
            item.insert(
                "assetBundleId".to_owned(),
                row.try_get::<Option<Uuid>, _>("asset_bundle_id")
                    .unwrap_or(None)
                    .map_or(Value::Null, |value| Value::String(value.to_string())),
            );
            item.insert(
                "createdAt".to_owned(),
                super::iso_timestamptz(row.try_get("created_at").unwrap_or(None)),
            );
            item.insert(
                "publishedAt".to_owned(),
                super::iso_timestamptz(row.try_get("published_at").unwrap_or(None)),
            );
            specs.push(Value::Object(item));
        }
        json_ok(&json!({ "specs": specs }))
    })
}

/// `GET /internal/merchant/report-engine/studio/specs/:id`.
pub fn studio_spec<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: ntex::web::types::Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            let (principal, merchant_id) = require_merchant_session(principal)?;
            assert_merchant_authority(principal, &["report_engine:author"])?;
            let id = path_uuid(
                request,
                6,
                "MERCHANT_REPORT_SPEC_NOT_FOUND",
                "The report spec does not exist",
            )?;
            Ok((merchant_id, id))
        })();
        let (merchant_id, id) = match result {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        let row = sqlx::query(
            "SELECT id, code, version, status::text AS status, is_latest_published, \
                    engine_version, spec_schema_version, authoring_transcript_version, spec_json, \
                    verification_report_json, asset_bundle_id \
               FROM merchant_report_specs WHERE id = $1 AND merchant_id = $2",
        )
        .bind(id)
        .bind(merchant_id)
        .fetch_optional(&state.pools.main)
        .await;
        match row {
            Ok(Some(row)) => {
                let spec_json: Value = row.try_get("spec_json").unwrap_or(Value::Null);
                let compatibility = report_compatibility(
                    &spec_json,
                    row.try_get::<Option<String>, _>("engine_version")
                        .unwrap_or(None)
                        .as_deref(),
                    row.try_get::<Option<String>, _>("spec_schema_version")
                        .unwrap_or(None)
                        .as_deref(),
                );
                json_ok(&json!({
                    "id": row.get::<Uuid, _>("id"),
                    "code": row.get::<String, _>("code"),
                    "version": row.get::<i32, _>("version"),
                    "status": row.get::<String, _>("status"),
                    "isLatestPublished": row.get::<bool, _>("is_latest_published"),
                    "engineVersion": row.get::<String, _>("engine_version"),
                    "specSchemaVersion": row.get::<String, _>("spec_schema_version"),
                    "authoringTranscriptVersion": row
                        .try_get::<Option<String>, _>("authoring_transcript_version")
                        .unwrap_or(None),
                    "compatibility": compatibility,
                    "spec": spec_json,
                    "verification": row.try_get::<Option<Value>, _>("verification_report_json")
                        .unwrap_or(None),
                    "assetBundleId": row.try_get::<Option<Uuid>, _>("asset_bundle_id")
                        .unwrap_or(None),
                }))
            }
            Ok(None) => error_response(request, report_spec_not_found()),
            Err(error) => error_response(request, database_error(error)),
        }
    })
}

/// `GET /internal/merchant/report-engine/studio/needs-migration`.
pub fn studio_needs_migration<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: ntex::web::types::Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            let (principal, merchant_id) = require_merchant_session(principal)?;
            assert_merchant_authority(principal, &["report_engine:author"])?;
            Ok(merchant_id)
        })();
        let merchant_id = match result {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        if let Err(error) = assert_engine_available(state, merchant_id).await {
            return error_response(request, error);
        }
        let page = positive_int(query_scalar(request, "page").as_deref(), 1, u32::MAX);
        let page_size = positive_int(query_scalar(request, "pageSize").as_deref(), 20, 200);
        let search = query_scalar(request, "search")
            .unwrap_or_default()
            .trim()
            .to_lowercase();
        let rows = sqlx::query(
            "SELECT id, code, version, category, status::text AS status, is_latest_published, \
                    engine_version, spec_schema_version, spec_json, updated_at \
               FROM merchant_report_specs \
              WHERE merchant_id = $1 AND status <> 'ARCHIVED' \
              ORDER BY code ASC, version DESC",
        )
        .bind(merchant_id)
        .fetch_all(&state.pools.main)
        .await;
        let rows = match rows {
            Ok(rows) => rows,
            Err(error) => return error_response(request, database_error(error)),
        };
        let mut latest: BTreeMap<String, &sqlx::postgres::PgRow> = BTreeMap::new();
        for row in &rows {
            latest.entry(row.get("code")).or_insert(row);
        }
        let mut items = Vec::new();
        for row in latest.values() {
            let spec_json: Value = row.try_get("spec_json").unwrap_or(Value::Null);
            let compatibility = report_compatibility(
                &spec_json,
                row.try_get::<Option<String>, _>("engine_version")
                    .unwrap_or(None)
                    .as_deref(),
                row.try_get::<Option<String>, _>("spec_schema_version")
                    .unwrap_or(None)
                    .as_deref(),
            );
            if compatibility["status"] == "COMPATIBLE" {
                continue;
            }
            let code: String = row.get("code");
            let category: String = row.get("category");
            if !search.is_empty()
                && !format!("{code} {category}")
                    .to_lowercase()
                    .contains(&search)
            {
                continue;
            }
            items.push(json!({
                "id": row.get::<Uuid, _>("id"),
                "code": code,
                "version": row.get::<i32, _>("version"),
                "category": category,
                "status": row.get::<String, _>("status"),
                "isLatestPublished": row.get::<bool, _>("is_latest_published"),
                "compatibility": compatibility,
                "updatedAt": super::iso_timestamptz(row.try_get("updated_at").unwrap_or(None)),
            }));
        }
        let total = items.len();
        let start = ((page as usize) - 1) * (page_size as usize);
        let specs: Vec<Value> = items
            .into_iter()
            .skip(start)
            .take(page_size as usize)
            .collect();
        json_ok(&json!({ "specs": specs, "total": total }))
    })
}

// ---------------------------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------------------------

fn env_i64(key: &str, fallback: i64) -> i64 {
    std::env::var(key)
        .ok()
        .and_then(|value| value.trim().parse::<i64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(fallback)
}

/// `GET /internal/merchant/report-engine/studio/usage`.
pub fn studio_usage<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: ntex::web::types::Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            let (principal, merchant_id) = require_merchant_session(principal)?;
            assert_merchant_authority(principal, &["report_engine:author"])?;
            Ok(merchant_id)
        })();
        let merchant_id = match result {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        let policy = match read_policy(state).await {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        let now = Utc::now();
        let start_of_day = now.date_naive().and_hms_opt(0, 0, 0).unwrap_or_default();
        let hour_ago = (now - chrono::Duration::hours(1)).naive_utc();
        let codes: Result<Option<i64>, sqlx::Error> = sqlx::query_scalar(
            "SELECT COUNT(DISTINCT code) FROM merchant_report_specs WHERE merchant_id = $1",
        )
        .bind(merchant_id)
        .fetch_one(&state.pools.main)
        .await;
        let runs_today: Result<Option<i64>, sqlx::Error> = sqlx::query_scalar(
            "SELECT COUNT(*) FROM merchant_report_execution_audit \
              WHERE merchant_id = $1 AND created_at >= $2",
        )
        .bind(merchant_id)
        .bind(start_of_day)
        .fetch_one(&state.pools.main)
        .await;
        let db_time: Result<Option<i64>, sqlx::Error> = sqlx::query_scalar(
            "SELECT COALESCE(SUM(duration_ms), 0) FROM merchant_report_execution_audit \
              WHERE merchant_id = $1 AND created_at >= $2",
        )
        .bind(merchant_id)
        .bind(start_of_day)
        .fetch_one(&state.pools.main)
        .await;
        let executes: Result<Option<i64>, sqlx::Error> = sqlx::query_scalar(
            "SELECT COUNT(*) FROM merchant_report_rate_events \
              WHERE merchant_id = $1 AND action = 'execute' AND created_at >= $2",
        )
        .bind(merchant_id)
        .bind(hour_ago)
        .fetch_one(&state.pools.main)
        .await;
        let verifies: Result<Option<i64>, sqlx::Error> = sqlx::query_scalar(
            "SELECT COUNT(*) FROM merchant_report_rate_events \
              WHERE merchant_id = $1 AND action = 'verify' AND created_at >= $2",
        )
        .bind(merchant_id)
        .bind(hour_ago)
        .fetch_one(&state.pools.main)
        .await;
        let suspension = sqlx::query(
            "SELECT suspended_at, reason FROM merchant_report_studio_status WHERE merchant_id = $1",
        )
        .bind(merchant_id)
        .fetch_optional(&state.pools.main)
        .await;
        let (codes, runs_today, db_time, executes, verifies) =
            match (codes, runs_today, db_time, executes, verifies) {
                (Ok(codes), Ok(runs), Ok(db), Ok(executes), Ok(verifies)) => {
                    (codes, runs, db, executes, verifies)
                }
                _ => {
                    return error_response(
                        request,
                        ApiError::new(500, "SERVER_ERROR", "Internal server error"),
                    )
                }
            };
        let (suspended, suspension_reason) = match suspension {
            Ok(Some(row)) => {
                let suspended: Option<DateTime<Utc>> = row.try_get("suspended_at").unwrap_or(None);
                let reason: Option<String> = row.try_get("reason").unwrap_or(None);
                (suspended.is_some(), reason)
            }
            Ok(None) => (false, None),
            Err(error) => return error_response(request, database_error(error)),
        };
        json_ok(&json!({
            "codes": codes.unwrap_or(0),
            "maxCodes": MAX_REPORT_CODES,
            "runsToday": runs_today.unwrap_or(0),
            "dbTimeTodayMs": db_time.unwrap_or(0),
            "maxDailyDbTimeMs": env_i64("MERCHANT_REPORT_DAILY_DB_TIME_MS", 600_000),
            "executesLastHour": executes.unwrap_or(0),
            "verifiesLastHour": verifies.unwrap_or(0),
            "maxExecutesPerHour": env_i64("MERCHANT_REPORT_EXECUTE_PER_HOUR", 60),
            "maxVerifiesPerHour": env_i64("MERCHANT_REPORT_VERIFY_PER_HOUR", 30),
            "suspended": suspended,
            "suspensionReason": suspension_reason,
            "engineEnabled": policy.enabled,
            "assetsEnabled": policy.assets_enabled,
        }))
    })
}

// ---------------------------------------------------------------------------------------------
// Chrome (header/footer) versions
// ---------------------------------------------------------------------------------------------

struct ChromeRow {
    id: Uuid,
    code: String,
    version: i32,
    name: String,
    chrome_type: String,
    status: String,
    is_default: bool,
    revoked_at: Option<Value>,
    revoked_reason: Option<String>,
    engine_version: Option<String>,
    spec_schema_version: Option<String>,
    transcript_version: Option<String>,
    supported_locales: Vec<String>,
    spec_json: Value,
    asset_bundle_id: Option<Uuid>,
}

fn chrome_row(row: &sqlx::postgres::PgRow) -> ChromeRow {
    ChromeRow {
        id: row.get("id"),
        code: row.get("code"),
        version: row.get("version"),
        name: row.get("name"),
        chrome_type: row.get("chrome_type"),
        status: row.get("status"),
        is_default: row.get("is_default_for_merchant"),
        revoked_at: Some(super::iso_timestamptz(
            row.try_get("default_revoked_at").unwrap_or(None),
        )),
        revoked_reason: row
            .try_get::<Option<String>, _>("default_revoked_reason")
            .unwrap_or(None),
        engine_version: row
            .try_get::<Option<String>, _>("engine_version")
            .unwrap_or(None),
        spec_schema_version: row
            .try_get::<Option<String>, _>("spec_schema_version")
            .unwrap_or(None),
        transcript_version: row
            .try_get::<Option<String>, _>("authoring_transcript_version")
            .unwrap_or(None),
        supported_locales: row.try_get("supported_locales").unwrap_or_default(),
        spec_json: row.try_get("spec_json").unwrap_or(Value::Null),
        asset_bundle_id: row.try_get("asset_bundle_id").unwrap_or(None),
    }
}

/// `merchantChromeView`: `assetDataUrls` needs the object-storage SDK (P4-T05), so it is empty;
/// `spec` is the stored JSON (compatible rows only are rendered by the portal).
fn chrome_view(row: &ChromeRow) -> Value {
    let compatibility = chrome_compatibility(
        &row.spec_json,
        row.engine_version.as_deref(),
        row.spec_schema_version.as_deref(),
    );
    json!({
        "id": row.id,
        "code": row.code,
        "version": row.version,
        "name": row.name,
        "chromeType": row.chrome_type,
        "status": row.status,
        "isDefaultForMerchant": row.is_default,
        "defaultRevokedAt": row.revoked_at.clone().unwrap_or(Value::Null),
        "defaultRevokedReason": row.revoked_reason,
        "engineVersion": row.engine_version,
        "specSchemaVersion": row.spec_schema_version,
        "authoringTranscriptVersion": row.transcript_version,
        "compatibility": compatibility,
        "supportedLocales": row.supported_locales,
        "assetBundleId": row.asset_bundle_id,
        "assetDataUrls": Value::Object(Map::new()),
        "spec": row.spec_json,
    })
}

fn chrome_not_found() -> ApiError {
    ApiError::new(
        404,
        "MERCHANT_REPORT_CHROME_NOT_FOUND",
        "The header/footer does not exist",
    )
}

/// `GET /internal/merchant/report-engine/studio/chrome`.
pub fn studio_chrome<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: ntex::web::types::Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            let (principal, merchant_id) = require_merchant_session(principal)?;
            assert_merchant_authority(principal, &["report_engine:author"])?;
            Ok(merchant_id)
        })();
        let merchant_id = match result {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        if let Err(error) = assert_engine_available(state, merchant_id).await {
            return error_response(request, error);
        }
        let chrome_type = query_scalar(request, "type")
            .filter(|value| value.as_str() == "HEADER" || value.as_str() == "FOOTER");
        let include_archived = matches!(
            query_scalar(request, "includeArchived").as_deref(),
            Some("1") | Some("true")
        );
        let page = positive_int(query_scalar(request, "page").as_deref(), 1, u32::MAX);
        let page_size = positive_int(query_scalar(request, "pageSize").as_deref(), 50, 200);
        let search = query_scalar(request, "search")
            .unwrap_or_default()
            .trim()
            .to_lowercase();
        let mut sql = String::from(
            "SELECT id, code, version, name, chrome_type::text AS chrome_type, \
                    status::text AS status, is_default_for_merchant, default_revoked_at, \
                    default_revoked_reason, engine_version, spec_schema_version, \
                    authoring_transcript_version, supported_locales, spec_json, asset_bundle_id \
               FROM merchant_report_chrome_specs WHERE merchant_id = $1",
        );
        if chrome_type.is_some() {
            sql.push_str(" AND chrome_type::text = $2");
        }
        if !include_archived {
            sql.push_str(" AND status <> 'ARCHIVED'");
        }
        sql.push_str(" ORDER BY chrome_type ASC, code ASC, version DESC");
        let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(merchant_id);
        if let Some(chrome_type) = chrome_type {
            query = query.bind(chrome_type);
        }
        let rows = match query.fetch_all(&state.pools.main).await {
            Ok(rows) => rows,
            Err(error) => return error_response(request, database_error(error)),
        };
        // `latestByCode` keeps the SQL order (chrome type, code); a map keyed by code would lose it.
        let mut seen = std::collections::BTreeSet::new();
        let mut latest: Vec<ChromeRow> = Vec::new();
        for row in &rows {
            let entry = chrome_row(row);
            if !search.is_empty()
                && !entry.code.to_lowercase().contains(&search)
                && !entry.name.to_lowercase().contains(&search)
            {
                continue;
            }
            if seen.insert(entry.code.clone()) {
                latest.push(entry);
            }
        }
        let mut views: Vec<Value> = latest.iter().map(chrome_view).collect();
        let total = views.len();
        let start = ((page as usize) - 1) * (page_size as usize);
        views = views
            .into_iter()
            .skip(start)
            .take(page_size as usize)
            .collect();
        json_ok(&json!({ "specs": views, "total": total }))
    })
}

async fn load_chrome(
    state: &AppState,
    merchant_id: Uuid,
    id: Uuid,
) -> Result<Option<ChromeRow>, ApiError> {
    let row = sqlx::query(
        "SELECT id, code, version, name, chrome_type::text AS chrome_type, \
                status::text AS status, is_default_for_merchant, default_revoked_at, \
                default_revoked_reason, engine_version, spec_schema_version, \
                authoring_transcript_version, supported_locales, spec_json, asset_bundle_id \
           FROM merchant_report_chrome_specs WHERE id = $1 AND merchant_id = $2",
    )
    .bind(id)
    .bind(merchant_id)
    .fetch_optional(&state.pools.main)
    .await
    .map_err(database_error)?;
    Ok(row.map(|row| chrome_row(&row)))
}

/// `GET /internal/merchant/report-engine/studio/chrome/:id`.
pub fn studio_chrome_detail<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: ntex::web::types::Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            let (principal, merchant_id) = require_merchant_session(principal)?;
            assert_merchant_authority(principal, &["report_engine:author"])?;
            let id = path_uuid(
                request,
                6,
                "MERCHANT_REPORT_CHROME_NOT_FOUND",
                "The header/footer does not exist",
            )?;
            Ok((merchant_id, id))
        })();
        let (merchant_id, id) = match result {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        match load_chrome(state, merchant_id, id).await {
            Ok(Some(row)) => json_ok(&chrome_view(&row)),
            Ok(None) => error_response(request, chrome_not_found()),
            Err(error) => error_response(request, error),
        }
    })
}

/// `GET /internal/merchant/report-engine/studio/chrome/needs-migration`.
pub fn studio_chrome_needs_migration<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: ntex::web::types::Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            let (principal, merchant_id) = require_merchant_session(principal)?;
            assert_merchant_authority(principal, &["report_engine:author"])?;
            Ok(merchant_id)
        })();
        let merchant_id = match result {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        let page = positive_int(query_scalar(request, "page").as_deref(), 1, u32::MAX);
        let page_size = positive_int(query_scalar(request, "pageSize").as_deref(), 20, 200);
        let search = query_scalar(request, "search")
            .unwrap_or_default()
            .trim()
            .to_lowercase();
        let rows = sqlx::query(
            "SELECT id, code, version, name, chrome_type::text AS chrome_type, \
                    status::text AS status, is_default_for_merchant, default_revoked_at, \
                    default_revoked_reason, engine_version, spec_schema_version, \
                    authoring_transcript_version, supported_locales, spec_json, asset_bundle_id \
               FROM merchant_report_chrome_specs \
              WHERE merchant_id = $1 AND status <> 'ARCHIVED' \
              ORDER BY chrome_type ASC, code ASC, version DESC",
        )
        .bind(merchant_id)
        .fetch_all(&state.pools.main)
        .await;
        let rows = match rows {
            Ok(rows) => rows,
            Err(error) => return error_response(request, database_error(error)),
        };
        let mut seen = std::collections::BTreeSet::new();
        let mut latest: Vec<ChromeRow> = Vec::new();
        for row in &rows {
            let entry = chrome_row(row);
            if seen.insert(entry.code.clone()) {
                latest.push(entry);
            }
        }
        let report_rows = sqlx::query(
            "SELECT id, code, spec_json, engine_version, spec_schema_version \
               FROM merchant_report_specs \
              WHERE merchant_id = $1 AND status = 'PUBLISHED' AND is_latest_published",
        )
        .bind(merchant_id)
        .fetch_all(&state.pools.main)
        .await;
        let report_rows = match report_rows {
            Ok(rows) => rows,
            Err(error) => return error_response(request, database_error(error)),
        };
        let mut report_specs: Vec<(String, Value)> = Vec::new();
        for row in &report_rows {
            let spec_json: Value = row.try_get("spec_json").unwrap_or(Value::Null);
            if report_compatibility(
                &spec_json,
                row.try_get::<Option<String>, _>("engine_version")
                    .unwrap_or(None)
                    .as_deref(),
                row.try_get::<Option<String>, _>("spec_schema_version")
                    .unwrap_or(None)
                    .as_deref(),
            )["status"]
                == "COMPATIBLE"
            {
                report_specs.push((row.get("code"), spec_json));
            }
        }
        let mut items = Vec::new();
        for row in &latest {
            let compatibility = chrome_compatibility(
                &row.spec_json,
                row.engine_version.as_deref(),
                row.spec_schema_version.as_deref(),
            );
            if compatibility["status"] == "COMPATIBLE" {
                continue;
            }
            if !search.is_empty()
                && !format!("{} {}", row.code, row.name)
                    .to_lowercase()
                    .contains(&search)
            {
                continue;
            }
            let impacted: Vec<String> = report_specs
                .iter()
                .filter(|(_, spec)| {
                    let layout = spec.get("page_layout");
                    let (mode, code) = if row.chrome_type == "HEADER" {
                        (
                            layout.and_then(|value| value.get("header_mode")),
                            layout.and_then(|value| value.get("header_chrome_code")),
                        )
                    } else {
                        (
                            layout.and_then(|value| value.get("footer_mode")),
                            layout.and_then(|value| value.get("footer_chrome_code")),
                        )
                    };
                    let mode = mode.and_then(Value::as_str).unwrap_or_default();
                    let code = code.and_then(Value::as_str).unwrap_or_default();
                    (mode == "SPECIFIC_CHROME_CODE" && code == row.code)
                        || (mode == "GLOBAL_DEFAULT"
                            && (row
                                .revoked_at
                                .as_ref()
                                .is_some_and(|value| !value.is_null())
                                || row.is_default))
                })
                .map(|(code, _)| code.clone())
                .collect();
            items.push(json!({
                "id": row.id,
                "code": row.code,
                "version": row.version,
                "name": row.name,
                "chromeType": row.chrome_type,
                "status": row.status,
                "isDefaultForMerchant": row.is_default,
                "defaultRevokedAt": row.revoked_at.clone().unwrap_or(Value::Null),
                "defaultRevokedReason": row.revoked_reason,
                "compatibility": compatibility,
                "impactedReportCount": impacted.len(),
                "impactedReportCodes": impacted.iter().take(10).cloned().collect::<Vec<_>>(),
            }));
        }
        let total = items.len();
        let start = ((page as usize) - 1) * (page_size as usize);
        let specs: Vec<Value> = items
            .into_iter()
            .skip(start)
            .take(page_size as usize)
            .collect();
        json_ok(&json!({ "specs": specs, "total": total }))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn descriptor() -> Value {
        json!({
            "spec_kind": "REPORT_DESCRIPTOR",
            "spec_version": "1.0",
            "datasets": [{
                "dataset_id": "daily",
                "from_model": "paymentAttempt",
                "select": [{ "alias": "volume", "column": "total_charged_amount" }]
            }],
            "sections": [{
                "section_id": "kpis",
                "section_type": "KPI_GRID",
                "cards": [{ "dataset_id": "daily", "value_field": "volume" }]
            }],
        })
    }

    #[test]
    fn a_current_descriptor_is_compatible() {
        let result = report_compatibility(&descriptor(), Some("1.0.0"), Some("1.0"));
        assert_eq!(result["status"], "COMPATIBLE");
        assert_eq!(result["promptAvailable"], false);
        assert_eq!(result["currentSpecVersion"], "1.0");
        assert!(result["reasonCode"].is_null());
    }

    #[test]
    fn version_gates_need_migration_and_keep_the_ts_messages() {
        let result = report_compatibility(&descriptor(), Some("2.0.0"), Some("1.0"));
        assert_eq!(result["status"], "NEEDS_MIGRATION");
        assert_eq!(result["reasonCode"], "ENGINE_MAJOR_VERSION_MISMATCH");
        assert!(result["message"]
            .as_str()
            .unwrap_or_default()
            .contains("2.0.0"));
        let result = report_compatibility(&descriptor(), Some("1.0.0"), Some("0.9"));
        assert_eq!(result["reasonCode"], "SPEC_VERSION_UNSUPPORTED");
        let result = report_compatibility(&descriptor(), None, None);
        assert_eq!(result["reasonCode"], "MISSING_VERSION_METADATA");
    }

    #[test]
    fn wrong_kinds_and_invalid_json_are_invalid() {
        let result =
            report_compatibility(&json!({ "spec_kind": "OTHER" }), Some("1.0"), Some("1.0"));
        assert_eq!(result["status"], "INVALID");
        assert_eq!(result["reasonCode"], "WRONG_SPEC_KIND");
        let result = report_compatibility(
            &Value::String("{not json".to_owned()),
            Some("1.0"),
            Some("1.0"),
        );
        assert_eq!(result["reasonCode"], "INVALID_SPEC_JSON");
    }

    #[test]
    fn chrome_specs_classify_with_the_chrome_contract() {
        let chrome = json!({ "spec_kind": "REPORT_CHROME", "spec_version": "1.0", "chrome": {} });
        let result = chrome_compatibility(&chrome, Some("1.0.0"), Some("1.0"));
        assert_eq!(result["status"], "COMPATIBLE");
        assert_eq!(result["currentSpecVersion"], "1.0");
        let missing = json!({ "spec_kind": "REPORT_CHROME", "spec_version": "1.0" });
        let result = chrome_compatibility(&missing, Some("1.0.0"), Some("1.0"));
        assert_eq!(result["reasonCode"], "CURRENT_SCHEMA_VALIDATION_FAILED");
    }
}

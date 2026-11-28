//! Admin AML read routes (P4-T04).
//!
//! Port of the 34 `GET /internal/admin/aml/*` handlers of
//! `core-back/api/internal/admin.ts` (screenings, cases, evidence, rules, reporting rules,
//! regulatory schemas/reports, filing adapters and submissions) plus the evidence-content read.
//!
//! **Confidentiality contract.** The TypeScript core declares no per-route authority for these
//! handlers: every one runs behind `requireStaffPrincipal` and then calls `assertConfidential`,
//! which is `hasConfidentialAmlAccess` — role `COMPLIANCE`/`MLRO` **or** authority `aml:read`,
//! `aml:write` (or `*`). That gate is reproduced exactly in [`confidential`]. The route policies
//! therefore keep an empty authority list (adding `aml:read` there would deny a role-only
//! COMPLIANCE user and diverge from the TS core). One route, the report-output download, also
//! calls `assertReportingAuthority` (roles `MLRO`/`COMPLIANCE` or the reporting authority list);
//! [`reporting_authority`] mirrors it. The admin edge's `amlConfidential` middleware
//! (`COMPLIANCE`, `MLRO`, `aml:read`, `aml:write`) is the same rule one hop earlier.
//!
//! **List contract.** Every list is the `buildListQuery`/`listResponse` contract of
//! `core-back/lib/listQuery.ts`; the SQL builder is `pg-db::list_query`. Enum filters use the
//! `::text` form so parameterised equality works, while enum sorts use declaration-order `CASE`
//! expressions to match Prisma.
//!
//! **Deliberate gaps** (recorded in the hand-off report):
//!
//! - `ensureBaselineReportingSchemas` is not ported, so `/report-schemas` and
//!   `/report-schema-defaults` do not lazily insert the six provisional baselines (P8-T03 owns the
//!   schema documents). A seeded database behaves the same.
//! - An invalid enum member in a `status`/`severity`/... filter matches nothing instead of raising
//!   Prisma's client-side validation 500; every valid filter is identical.
//! - [`resolve`] mirrors the dispatcher's `:name` template matching for the module's tests; the
//!   shell's `routes::find` owns live dispatch (it prefers exact static paths, like Express).
//!
//! AML data is never logged: queries bind identifiers, and error logs only carry the column or
//! object id.

#![forbid(unsafe_code)]

mod list;
mod view;

#[cfg(test)]
mod tests;

use std::collections::{BTreeMap, HashMap};

use chrono::{DateTime, Datelike, NaiveDateTime, Utc};
use ntex::web::types::Payload;
use ntex::web::{HttpRequest, HttpResponse};
use serde_json::{json, Map, Value};
use sqlx::postgres::PgRow;
use sqlx::{AssertSqlSafe, PgPool};
use uuid::Uuid;

use pg_domain_auth::Principal;
use pg_http::{ApiError, Authn, BodyRule, Channel, Policy};
use pg_types::new_v7;

use super::{Handler, HandlerFuture, MountedRoute, PrincipalGuard};
use crate::http::request_id;
use crate::state::AppState;
use list::{envelope, fetch_rows, fetch_total, request_map, CASES_TABLE, REPORTS_TABLE};
use view::{
    age_hours, base64_decode, base64_encode, case_row, content_disposition, decimal_js,
    filing_adapter_row, get, iso_date, iso_naive, load_case_relations, load_matches,
    load_subject_maps, money4, opt_get, read_authorized_object, read_internal_object, read_payload,
    report_row, schema_row, screening_row, CaseDb, FilingAdapterDb, RegulatorySchemaDb, ReportDb,
    ScreeningDb,
};

/// Reporting authority list of `assertReportingAuthority`.
const REPORTING_AUTHORITIES: [&str; 6] = [
    "report:approve",
    "report:review",
    "aml:write",
    "compliance:write",
    "approval:check",
    "approval:write",
];

/* --------------------------------------------------------------- route table */

fn route(path: &str, ts_origin: &str, handler: super::CustomHandler) -> MountedRoute {
    MountedRoute {
        policy: Policy::new("GET", path, Channel::Admin, Authn::Session, ts_origin)
            .body(BodyRule::None),
        handler: Handler::Custom(handler),
        guard: PrincipalGuard::Staff,
    }
}

/// Routes owned by this module.
#[must_use]
pub fn routes() -> Vec<MountedRoute> {
    vec![
        route(
            "/internal/admin/aml/screenings",
            "core-back/api/internal/admin.ts:7733",
            screenings_list,
        ),
        route(
            "/internal/admin/aml/screenings/export",
            "core-back/api/internal/admin.ts:7756",
            screenings_export,
        ),
        route(
            "/internal/admin/aml/screenings/summary",
            "core-back/api/internal/admin.ts:7826",
            screenings_summary,
        ),
        route(
            "/internal/admin/aml/screenings/summary/export",
            "core-back/api/internal/admin.ts:7831",
            screenings_summary_export,
        ),
        route(
            "/internal/admin/aml/screenings/:id",
            "core-back/api/internal/admin.ts:7864",
            screening_detail,
        ),
        route(
            "/internal/admin/aml/cases",
            "core-back/api/internal/admin.ts:8202",
            cases_list,
        ),
        route(
            "/internal/admin/aml/cases/export",
            "core-back/api/internal/admin.ts:8234",
            cases_export,
        ),
        route(
            "/internal/admin/aml/cases/summary",
            "core-back/api/internal/admin.ts:8321",
            cases_summary,
        ),
        route(
            "/internal/admin/aml/cases/summary/export",
            "core-back/api/internal/admin.ts:8326",
            cases_summary_export,
        ),
        route(
            "/internal/admin/aml/cases/:id",
            "core-back/api/internal/admin.ts:8361",
            case_detail,
        ),
        route(
            "/internal/admin/aml/cases/:id/evidence",
            "core-back/api/internal/admin.ts:8467",
            case_evidence,
        ),
        route(
            "/internal/admin/aml/cases/:id/evidence/:evidenceId/content",
            "core-back/api/internal/admin.ts:8574",
            case_evidence_content,
        ),
        route(
            "/internal/admin/aml/rules",
            "core-back/api/internal/admin.ts:8601",
            rules_list,
        ),
        route(
            "/internal/admin/aml/rules/export",
            "core-back/api/internal/admin.ts:8641",
            rules_export,
        ),
        route(
            "/internal/admin/aml/rules/summary",
            "core-back/api/internal/admin.ts:8716",
            rules_summary,
        ),
        route(
            "/internal/admin/aml/rules/summary/export",
            "core-back/api/internal/admin.ts:8721",
            rules_summary_export,
        ),
        route(
            "/internal/admin/aml/rules/:id",
            "core-back/api/internal/admin.ts:8841",
            rule_detail,
        ),
        route(
            "/internal/admin/aml/reporting-rules",
            "core-back/api/internal/admin.ts:8857",
            reporting_rules,
        ),
        route(
            "/internal/admin/aml/report-schemas",
            "core-back/api/internal/admin.ts:9136",
            report_schemas,
        ),
        route(
            "/internal/admin/aml/report-schemas/:id",
            "core-back/api/internal/admin.ts:9145",
            report_schema_detail,
        ),
        route(
            "/internal/admin/aml/report-context-catalog",
            "core-back/api/internal/admin.ts:9495",
            report_context_catalog,
        ),
        route(
            "/internal/admin/aml/report-schemas/:id/template",
            "core-back/api/internal/admin.ts:9682",
            report_schema_template,
        ),
        route(
            "/internal/admin/aml/reporting-rules/:id/schema-bindings",
            "core-back/api/internal/admin.ts:10006",
            reporting_rule_bindings,
        ),
        route(
            "/internal/admin/aml/reports/:id/requirements",
            "core-back/api/internal/admin.ts:10082",
            report_requirements,
        ),
        route(
            "/internal/admin/aml/report-schema-defaults",
            "core-back/api/internal/admin.ts:10127",
            report_schema_defaults,
        ),
        route(
            "/internal/admin/aml/reports/:id/payload",
            "core-back/api/internal/admin.ts:10220",
            report_payload,
        ),
        route(
            "/internal/admin/aml/reports/:id/outputs/:format/download",
            "core-back/api/internal/admin.ts:10376",
            report_output_download,
        ),
        route(
            "/internal/admin/aml/reports",
            "core-back/api/internal/admin.ts:10569",
            reports_list,
        ),
        route(
            "/internal/admin/aml/reports/export",
            "core-back/api/internal/admin.ts:10619",
            reports_export,
        ),
        route(
            "/internal/admin/aml/reports/summary",
            "core-back/api/internal/admin.ts:10711",
            reports_summary,
        ),
        route(
            "/internal/admin/aml/reports/summary/export",
            "core-back/api/internal/admin.ts:10716",
            reports_summary_export,
        ),
        route(
            "/internal/admin/aml/reports/:id",
            "core-back/api/internal/admin.ts:10750",
            report_detail,
        ),
        route(
            "/internal/admin/aml/filing-adapters",
            "core-back/api/internal/admin.ts:20728",
            filing_adapters,
        ),
        route(
            "/internal/admin/aml/reports/:id/submissions",
            "core-back/api/internal/admin.ts:20887",
            report_submissions,
        ),
    ]
}

/// A resolved route plus the `:params` of the request path.
#[derive(Debug, Clone)]
pub struct Resolved {
    pub route: MountedRoute,
    pub params: BTreeMap<String, String>,
}

/// Match a request against this module's policies, including `:name` segments.
///
/// The shell's dispatcher uses its own `routes::path_matches`; this helper keeps the matcher and
/// the policy table aligned in the module's tests (static routes win, one segment per parameter).
#[must_use]
pub fn resolve(method: &str, path: &str) -> Option<Resolved> {
    for route in routes() {
        if !route.policy.method.eq_ignore_ascii_case(method) {
            continue;
        }
        if let Some(params) = match_pattern(&route.policy.path, path) {
            return Some(Resolved { route, params });
        }
    }
    None
}

fn match_pattern(pattern: &str, path: &str) -> Option<BTreeMap<String, String>> {
    let pattern_segments: Vec<&str> = pattern.split('/').filter(|part| !part.is_empty()).collect();
    let path_segments: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    if pattern_segments.len() != path_segments.len() {
        return None;
    }
    let mut params = BTreeMap::new();
    for (expected, actual) in pattern_segments.iter().zip(path_segments.iter()) {
        if let Some(name) = expected.strip_prefix(':') {
            params.insert(name.to_owned(), (*actual).to_owned());
        } else if expected != actual {
            return None;
        }
    }
    Some(params)
}

/* --------------------------------------------------------------- auth gates */

fn principal_of(principal: Option<&Principal>) -> Result<&Principal, ApiError> {
    principal.ok_or_else(|| {
        ApiError::new(
            401,
            "AUTH_REQUIRED",
            "A bearer token is required for this endpoint",
        )
    })
}

fn has_confidential_aml_access(principal: &Principal) -> bool {
    let role = principal
        .role
        .as_deref()
        .unwrap_or_default()
        .to_ascii_uppercase();
    if role == "COMPLIANCE" || role == "MLRO" {
        return true;
    }
    principal
        .authorities
        .iter()
        .any(|authority| authority == "*" || authority == "aml:read" || authority == "aml:write")
}

fn confidential(principal: Option<&Principal>) -> Result<&Principal, ApiError> {
    let principal = principal_of(principal)?;
    if has_confidential_aml_access(principal) {
        Ok(principal)
    } else {
        Err(ApiError::new(
            403,
            "AML_CONFIDENTIAL_ROLE_REQUIRED",
            "This resource is restricted to compliance roles",
        ))
    }
}

fn reporting_authority(principal: Option<&Principal>) -> Result<&Principal, ApiError> {
    let principal = confidential(principal)?;
    let role = principal
        .role
        .as_deref()
        .unwrap_or_default()
        .to_ascii_uppercase();
    if role == "COMPLIANCE" || role == "MLRO" {
        return Ok(principal);
    }
    if principal.authorities.iter().any(|authority| {
        authority == "*"
            || REPORTING_AUTHORITIES
                .iter()
                .any(|allowed| authority == allowed)
    }) {
        Ok(principal)
    } else {
        Err(ApiError::new(
            403,
            "REPORTING_AUTHORITY_REQUIRED",
            "A reporting action requires an MLRO / compliance authority",
        ))
    }
}

fn role_of(principal: &Principal, fallback: &str) -> String {
    principal
        .role
        .clone()
        .unwrap_or_else(|| fallback.to_owned())
}

/* ------------------------------------------------------------ HTTP helpers */

fn ok(value: Value) -> Result<HttpResponse, ApiError> {
    Ok(super::common::json_ok(&value))
}

#[allow(clippy::too_many_arguments)]
async fn write_audit(
    state: &AppState,
    principal: &Principal,
    role: &str,
    action: &str,
    entity_type: &str,
    entity_id: &str,
    before: Value,
    after: Value,
) -> Result<(), ApiError> {
    let user_id = principal
        .user_id
        .as_deref()
        .ok_or_else(ApiError::server_error)?;
    let actor_id = Uuid::parse_str(user_id).map_err(|_| ApiError::server_error())?;
    let now = Utc::now().naive_utc();
    sqlx::query(
        "INSERT INTO audit_log \
         (id, created_at, updated_at, actor_id, role, action, entity_type, entity_id, before_json, after_json, approval_request_id) \
         VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8, $9, NULL)",
    )
    .bind(new_v7())
    .bind(now)
    .bind(actor_id)
    .bind(role)
    .bind(action)
    .bind(entity_type)
    .bind(entity_id)
    .bind(before)
    .bind(after)
    .execute(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?;
    Ok(())
}

fn not_found(code: &str, message: &str) -> ApiError {
    ApiError::new(404, code, message)
}

fn decode_segment(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let high = (bytes[index + 1] as char).to_digit(16);
            let low = (bytes[index + 2] as char).to_digit(16);
            if let (Some(high), Some(low)) = (high, low) {
                output.push((high as u8) << 4 | low as u8);
                index += 3;
                continue;
            }
        }
        output.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&output).into_owned()
}

/// The path segments after a fixed prefix, percent-decoded and without empty entries.
fn tail(request: &HttpRequest, prefix: &str) -> Result<Vec<String>, ApiError> {
    let path = request.path();
    let rest = path
        .strip_prefix(prefix)
        .ok_or_else(ApiError::server_error)?;
    Ok(rest
        .split('/')
        .filter(|part| !part.is_empty())
        .map(decode_segment)
        .collect())
}

/// `idSchema`: 1..64 characters of `[A-Za-z0-9_-]`, then a UUID (Prisma would answer 500 for a
/// value that passes the regex but is not a UUID, so that is reproduced).
fn uuid_param(raw: &str) -> Result<Uuid, ApiError> {
    if raw.is_empty()
        || raw.len() > 64
        || !raw.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '_' || character == '-'
        })
    {
        return Err(ApiError::new(
            400,
            "INVALID_BODY",
            "The id parameter is invalid",
        ));
    }
    Uuid::parse_str(raw).map_err(|_| ApiError::server_error())
}

fn uuid_from_tail(request: &HttpRequest, prefix: &str, index: usize) -> Result<Uuid, ApiError> {
    let segments = tail(request, prefix)?;
    let raw = segments.get(index).ok_or_else(ApiError::server_error)?;
    uuid_param(raw)
}

fn checklist(query: &Map<String, Value>, allowed: &[&str]) -> Vec<String> {
    query
        .get("checklist")
        .and_then(Value::as_str)
        .map(|raw| {
            raw.split(',')
                .map(str::trim)
                .filter(|entry| allowed.contains(entry))
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn filters_json(query: &Map<String, Value>) -> String {
    Value::Object(query.clone()).to_string()
}

fn now_iso() -> String {
    view::iso_utc(Utc::now())
}

/* --------------------------------------------------------- handler wrappers */

macro_rules! route_handler {
    ($wrapper:ident, $implementation:ident) => {
        fn $wrapper<'a>(
            state: &'a AppState,
            request: &'a HttpRequest,
            principal: Option<&'a Principal>,
            _payload: Payload,
        ) -> HandlerFuture<'a> {
            Box::pin(async move {
                match $implementation(state, request, principal).await {
                    Ok(response) => response,
                    Err(error) => crate::http::error_response(request, error),
                }
            })
        }
    };
}

/* --------------------------------------------------------------- screenings */

async fn screenings_page(
    state: &AppState,
    query: &Map<String, Value>,
    take: Option<i64>,
    incident_search: bool,
) -> Result<
    (
        Vec<ScreeningDb>,
        Vec<(ScreeningDb, Vec<view::ScreeningMatchRow>)>,
        i64,
        list::Built,
    ),
    ApiError,
> {
    let search = query.get("search").and_then(Value::as_str);
    let mut raw = query.clone();
    if incident_search {
        raw.remove("search");
    }
    let mut built = list::build(&raw, &list::screenings_spec(), &list::screenings_columns())?;
    if incident_search {
        if let Some(search) = search {
            if !search.trim().is_empty() {
                let ids = incident_ids_matching(&state.pools.main, search).await?;
                built = list::merge_incident_search(
                    built,
                    search,
                    &ids,
                    &["subject_id", "provider_code", "provider_request_ref"],
                );
            }
        }
    }
    if let Some(take) = take {
        built.take = take;
        built.skip = 0;
    }
    let rows = fetch_rows(
        &state.pools.main,
        &built,
        "aml_screenings",
        view::SCREENING_PROJECTION,
    )
    .await?;
    let mut screenings = Vec::with_capacity(rows.len());
    for row in &rows {
        screenings.push(ScreeningDb::from_row(row)?);
    }
    let ids: Vec<Uuid> = screenings.iter().map(|row| row.id).collect();
    let matches = load_matches(&state.pools.main, &ids).await?;
    let total = fetch_total(&state.pools.main, &built, "aml_screenings").await?;
    let with_matches = screenings
        .iter()
        .map(|screening| {
            (
                screening.clone(),
                matches.get(&screening.id).cloned().unwrap_or_default(),
            )
        })
        .collect::<Vec<(ScreeningDb, Vec<view::ScreeningMatchRow>)>>();
    Ok((screenings, with_matches, total, built))
}

async fn screenings_list_impl(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<HttpResponse, ApiError> {
    let _actor = confidential(principal)?;
    let query = request_map(request);
    let (_, rows, total, built) = screenings_page(state, &query, None, false).await?;
    let subjects: Vec<(String, String)> = rows
        .iter()
        .map(|(screening, _)| (screening.subject_type.clone(), screening.subject_id.clone()))
        .collect();
    let maps = load_subject_maps(&state.pools.main, &subjects).await?;
    let now = Utc::now();
    let shaped: Vec<Value> = rows
        .iter()
        .map(|(screening, matches)| screening_row(screening, matches, &maps, now))
        .collect();
    let response = envelope("screenings", Value::Array(shaped), total, &built, &[]);
    ok(response)
}

async fn screenings_export_impl(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<HttpResponse, ApiError> {
    let actor = confidential(principal)?;
    let query = request_map(request);
    let allowed = [
        "SCREENING_SCOPE_VERIFIED",
        "MATCH_DATA_REVIEWED",
        "EXPORT_AUTHORITY_CONFIRMED",
    ];
    let checklist = checklist(&query, &allowed);
    let (_, rows, total, _) = screenings_page(state, &query, Some(5000), true).await?;
    let subjects: Vec<(String, String)> = rows
        .iter()
        .map(|(screening, _)| (screening.subject_type.clone(), screening.subject_id.clone()))
        .collect();
    let maps = load_subject_maps(&state.pools.main, &subjects).await?;
    let now = Utc::now();
    let shaped: Vec<Value> = rows
        .iter()
        .map(|(screening, matches)| screening_row(screening, matches, &maps, now))
        .collect();
    let exported = shaped.len();
    write_audit(
        state,
        actor,
        &role_of(actor, "UNKNOWN"),
        "AML_SCREENINGS_EXPORTED",
        "AML_SCREENING",
        "export",
        json!({}),
        json!({
            "total": total,
            "exported": exported,
            "filters": filters_json(&query),
            "checklist": checklist,
        }),
    )
    .await?;
    ok(json!({
        "screenings": shaped,
        "total": total,
        "exported": exported,
        "truncated": total > exported as i64,
    }))
}

async fn build_screening_summary(state: &AppState) -> Result<Value, ApiError> {
    let pool = &state.pools.main;
    let since = Utc::now().naive_utc() - chrono::Duration::hours(24);
    let result_rows = sqlx::query(
        "SELECT result::text AS key, count(*) AS total FROM aml_screenings GROUP BY result ORDER BY 1",
    )
    .fetch_all(pool)
    .await
    .map_err(crate::routes::common::database_error)?;
    let trigger_rows = sqlx::query(
        "SELECT trigger::text AS key, count(*) AS total FROM aml_screenings GROUP BY trigger ORDER BY 1",
    )
    .fetch_all(pool)
    .await
    .map_err(crate::routes::common::database_error)?;
    let total: i64 = sqlx::query_scalar("SELECT count(*) FROM aml_screenings")
        .fetch_one(pool)
        .await
        .map_err(crate::routes::common::database_error)?;
    let screened_24h: i64 =
        sqlx::query_scalar("SELECT count(*) FROM aml_screenings WHERE requested_at >= $1")
            .bind(since)
            .fetch_one(pool)
            .await
            .map_err(crate::routes::common::database_error)?;
    let unresolved: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM aml_screening_matches WHERE disposition = 'UNREVIEWED'",
    )
    .fetch_one(pool)
    .await
    .map_err(crate::routes::common::database_error)?;
    let latest: Option<NaiveDateTime> =
        sqlx::query_scalar("SELECT max(requested_at) FROM aml_screenings")
            .fetch_one(pool)
            .await
            .map_err(crate::routes::common::database_error)?;
    let mut by_result = Map::new();
    for row in &result_rows {
        by_result.insert(
            get::<String>(row, "key")?,
            Value::from(get::<i64>(row, "total")?),
        );
    }
    let mut by_trigger = Map::new();
    for row in &trigger_rows {
        by_trigger.insert(
            get::<String>(row, "key")?,
            Value::from(get::<i64>(row, "total")?),
        );
    }
    Ok(json!({
        "total": total,
        "screened24h": screened_24h,
        "unresolvedMatches": unresolved,
        "byResult": by_result,
        "byTrigger": by_trigger,
        "latestScreenedAt": latest.map(iso_naive),
    }))
}

async fn screenings_summary_impl(
    state: &AppState,
    _request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<HttpResponse, ApiError> {
    let _actor = confidential(principal)?;
    ok(build_screening_summary(state).await?)
}

async fn screenings_summary_export_impl(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<HttpResponse, ApiError> {
    let actor = confidential(principal)?;
    let summary = build_screening_summary(state).await?;
    let query = request_map(request);
    let checklist = checklist(
        &query,
        &[
            "SCREENING_SCOPE_VERIFIED",
            "RESULT_TRIGGER_REVIEWED",
            "UNRESOLVED_MATCH_REVIEWED",
            "EXPORT_APPROVAL_CONFIRMED",
        ],
    );
    write_audit(
        state,
        actor,
        &role_of(actor, "UNKNOWN"),
        "AML_SCREENING_SUMMARY_EXPORTED",
        "AML_SCREENING",
        "summary",
        json!({}),
        json!({
            "total": summary.get("total").cloned().unwrap_or(Value::Null),
            "screened24h": summary.get("screened24h").cloned().unwrap_or(Value::Null),
            "unresolvedMatches": summary.get("unresolvedMatches").cloned().unwrap_or(Value::Null),
            "checklist": checklist,
        }),
    )
    .await?;
    let mut map = summary.as_object().cloned().unwrap_or_default();
    map.insert("exportedAt".into(), Value::String(now_iso()));
    ok(Value::Object(map))
}

async fn screening_detail_impl(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<HttpResponse, ApiError> {
    let _actor = confidential(principal)?;
    let id = uuid_from_tail(request, "/internal/admin/aml/screenings/", 0)?;
    let row = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {} FROM aml_screenings WHERE id = $1",
        view::SCREENING_PROJECTION.join(", ")
    )))
    .bind(id)
    .fetch_optional(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?
    .ok_or_else(|| {
        not_found(
            "AML_SCREENING_NOT_FOUND",
            "The AML screening does not exist",
        )
    })?;
    let screening = ScreeningDb::from_row(&row)?;
    let matches = load_matches(&state.pools.main, &[screening.id]).await?;
    let matches = matches.get(&screening.id).cloned().unwrap_or_default();
    let mut ordered = matches;
    ordered.sort_by_key(|left| std::cmp::Reverse(left.score));
    let subjects = vec![(screening.subject_type.clone(), screening.subject_id.clone())];
    let maps = load_subject_maps(&state.pools.main, &subjects).await?;
    let now = Utc::now();
    let base = screening_row(&screening, &ordered, &maps, now);
    let match_rows: Vec<Value> = ordered
        .iter()
        .map(|entry| {
            json!({
                "id": entry.id,
                "listType": entry.list_type,
                "listName": entry.list_name,
                "listEntryRef": entry.list_entry_ref,
                "matchedName": entry.matched_name,
                "score": money4(Some(entry.score)),
                "attributes": entry.attributes,
                "disposition": entry.disposition,
                "dispositionBy": entry.disposition_email,
                "dispositionNotes": entry.disposition_notes,
                "suppressFuture": entry.suppress_future,
                "suppressUntil": entry.suppress_until.map(iso_date),
                "createdAt": iso_naive(entry.created_at),
            })
        })
        .collect();
    let case_rows = sqlx::query(
        "SELECT id, status::text AS status, severity::text AS severity, created_at \
         FROM aml_cases WHERE screening_id = $1 ORDER BY created_at ASC, id ASC",
    )
    .bind(screening.id)
    .fetch_all(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?;
    let aml_cases: Vec<Value> = case_rows
        .iter()
        .map(|case| {
            Ok(json!({
                "id": get::<Uuid>(case, "id")?,
                "status": get::<String>(case, "status")?,
                "severity": get::<String>(case, "severity")?,
                "createdAt": iso_naive(get::<NaiveDateTime>(case, "created_at")?),
            }))
        })
        .collect::<Result<_, ApiError>>()?;
    let unresolved = ordered
        .iter()
        .any(|entry| entry.disposition == "UNREVIEWED");
    let mut map = base.as_object().cloned().unwrap_or_default();
    map.insert("matches".into(), Value::Array(match_rows));
    map.insert("amlCases".into(), Value::Array(aml_cases));
    map.insert("canDisposition".into(), Value::Bool(unresolved));
    ok(json!({ "screening": Value::Object(map) }))
}

/* -------------------------------------------------------------------- cases */

async fn cases_page(
    state: &AppState,
    query: &Map<String, Value>,
    take: Option<i64>,
) -> Result<
    (
        Vec<CaseDb>,
        view::CaseRelations,
        view::SubjectMaps,
        i64,
        list::Built,
    ),
    ApiError,
> {
    let mut built = list::build(query, &list::cases_spec(), &list::cases_columns())?;
    if let Some(take) = take {
        built.take = take;
        built.skip = 0;
    }
    let rows = fetch_rows(
        &state.pools.main,
        &built,
        CASES_TABLE,
        view::CASE_PROJECTION,
    )
    .await?;
    let mut cases = Vec::with_capacity(rows.len());
    for row in &rows {
        cases.push(CaseDb::from_row(row)?);
    }
    let relations = load_case_relations(&state.pools.main, &cases).await?;
    let subjects: Vec<(String, String)> = cases
        .iter()
        .map(|case| (case.subject_type.clone(), case.subject_id.clone()))
        .collect();
    let maps = load_subject_maps(&state.pools.main, &subjects).await?;
    let total = fetch_total(&state.pools.main, &built, CASES_TABLE).await?;
    Ok((cases, relations, maps, total, built))
}

async fn cases_list_impl(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<HttpResponse, ApiError> {
    let _actor = confidential(principal)?;
    let query = request_map(request);
    let (cases, relations, maps, total, built) = cases_page(state, &query, None).await?;
    let now = Utc::now();
    let shaped: Vec<Value> = cases
        .iter()
        .map(|entry| case_row(entry, &relations, &maps, now))
        .collect();
    let source: Vec<Vec<pg_db::list_query::CursorValue>> = cases
        .iter()
        .map(|entry| list::cursor_row(&built, Some(entry.created_at), entry.id))
        .collect();
    ok(envelope(
        "cases",
        Value::Array(shaped),
        total,
        &built,
        &source,
    ))
}

async fn cases_export_impl(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<HttpResponse, ApiError> {
    let actor = confidential(principal)?;
    let query = request_map(request);
    let checklist = checklist(
        &query,
        &[
            "AML_SCOPE_VERIFIED",
            "CASE_DATA_REVIEWED",
            "EXPORT_AUTHORITY_CONFIRMED",
        ],
    );
    let (cases, relations, maps, total, _) = cases_page(state, &query, Some(5000)).await?;
    let now = Utc::now();
    let shaped: Vec<Value> = cases
        .iter()
        .map(|entry| case_row(entry, &relations, &maps, now))
        .collect();
    let exported = shaped.len();
    write_audit(
        state,
        actor,
        &role_of(actor, "UNKNOWN"),
        "AML_CASES_EXPORTED",
        "AML_CASE",
        "export",
        json!({}),
        json!({
            "total": total,
            "exported": exported,
            "filters": filters_json(&query),
            "checklist": checklist,
        }),
    )
    .await?;
    ok(json!({
        "cases": shaped,
        "total": total,
        "exported": exported,
        "truncated": total > exported as i64,
    }))
}

async fn build_case_summary(state: &AppState) -> Result<Value, ApiError> {
    let pool = &state.pools.main;
    let status_rows = sqlx::query(
        "SELECT status::text AS key, count(*) AS total FROM aml_cases GROUP BY status ORDER BY 1",
    )
    .fetch_all(pool)
    .await
    .map_err(crate::routes::common::database_error)?;
    let severity_rows = sqlx::query(
        "SELECT severity::text AS key, count(*) AS total FROM aml_cases GROUP BY severity ORDER BY 1",
    )
    .fetch_all(pool)
    .await
    .map_err(crate::routes::common::database_error)?;
    let open: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM aml_cases WHERE status IN ('OPEN','IN_REVIEW','PENDING_CHECKER')",
    )
    .fetch_one(pool)
    .await
    .map_err(crate::routes::common::database_error)?;
    let oldest: Option<NaiveDateTime> = sqlx::query_scalar(
        "SELECT min(created_at) FROM aml_cases WHERE status IN ('OPEN','IN_REVIEW','PENDING_CHECKER')",
    )
    .fetch_one(pool)
    .await
    .map_err(crate::routes::common::database_error)?;
    let now = Utc::now();
    let overdue: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM aml_cases WHERE status IN ('OPEN','IN_REVIEW','PENDING_CHECKER') AND sla_due_at < $1",
    )
    .bind(now.naive_utc())
    .fetch_one(pool)
    .await
    .map_err(crate::routes::common::database_error)?;
    let critical: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM aml_cases WHERE status IN ('OPEN','IN_REVIEW','PENDING_CHECKER') AND severity = 'CRITICAL'",
    )
    .fetch_one(pool)
    .await
    .map_err(crate::routes::common::database_error)?;
    let frozen: i64 = sqlx::query_scalar("SELECT count(*) FROM aml_cases WHERE status = 'FROZEN'")
        .fetch_one(pool)
        .await
        .map_err(crate::routes::common::database_error)?;
    let escalated: i64 =
        sqlx::query_scalar("SELECT count(*) FROM aml_cases WHERE status = 'ESCALATED_STR'")
            .fetch_one(pool)
            .await
            .map_err(crate::routes::common::database_error)?;
    let mut by_status = Map::new();
    for row in &status_rows {
        by_status.insert(
            get::<String>(row, "key")?,
            Value::from(get::<i64>(row, "total")?),
        );
    }
    let mut by_severity = Map::new();
    for row in &severity_rows {
        by_severity.insert(
            get::<String>(row, "key")?,
            Value::from(get::<i64>(row, "total")?),
        );
    }
    Ok(json!({
        "totalOpen": open,
        "byStatus": by_status,
        "bySeverity": by_severity,
        "overdue": overdue,
        "criticalOpen": critical,
        "frozen": frozen,
        "escalated": escalated,
        "oldestOpenAgeHours": oldest.map_or(0, |created| age_hours(created, now)),
    }))
}

async fn cases_summary_impl(
    state: &AppState,
    _request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<HttpResponse, ApiError> {
    let _actor = confidential(principal)?;
    ok(build_case_summary(state).await?)
}

async fn cases_summary_export_impl(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<HttpResponse, ApiError> {
    let actor = confidential(principal)?;
    let summary = build_case_summary(state).await?;
    let query = request_map(request);
    let checklist = checklist(
        &query,
        &[
            "CASE_SCOPE_VERIFIED",
            "SEVERITY_STATUS_REVIEWED",
            "SLA_BREACH_REVIEWED",
            "EXPORT_APPROVAL_CONFIRMED",
        ],
    );
    write_audit(
        state,
        actor,
        &role_of(actor, "UNKNOWN"),
        "AML_CASE_SUMMARY_EXPORTED",
        "AML_CASE",
        "summary",
        json!({}),
        json!({
            "totalOpen": summary.get("totalOpen").cloned().unwrap_or(Value::Null),
            "overdue": summary.get("overdue").cloned().unwrap_or(Value::Null),
            "criticalOpen": summary.get("criticalOpen").cloned().unwrap_or(Value::Null),
            "frozen": summary.get("frozen").cloned().unwrap_or(Value::Null),
            "escalated": summary.get("escalated").cloned().unwrap_or(Value::Null),
            "checklist": checklist,
        }),
    )
    .await?;
    let mut map = summary.as_object().cloned().unwrap_or_default();
    map.insert("exportedAt".into(), Value::String(now_iso()));
    ok(Value::Object(map))
}

async fn load_case_by_id(
    state: &AppState,
    id: Uuid,
    code: &str,
    message: &str,
) -> Result<CaseDb, ApiError> {
    let row = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {} FROM aml_cases c WHERE c.id = $1",
        view::CASE_PROJECTION.join(", ")
    )))
    .bind(id)
    .fetch_optional(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?
    .ok_or_else(|| not_found(code, message))?;
    CaseDb::from_row(&row)
}

async fn case_detail_impl(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<HttpResponse, ApiError> {
    let actor = confidential(principal)?;
    let id = uuid_from_tail(request, "/internal/admin/aml/cases/", 0)?;
    let entry = load_case_by_id(
        state,
        id,
        "AML_CASE_NOT_FOUND",
        "The AML case does not exist",
    )
    .await?;
    write_audit(
        state,
        actor,
        &role_of(actor, "UNKNOWN"),
        "AML_CASE_VIEWED",
        "AML_CASE",
        &entry.id.to_string(),
        json!({}),
        json!({ "status": entry.status, "severity": entry.severity }),
    )
    .await?;
    let relations = load_case_relations(&state.pools.main, std::slice::from_ref(&entry)).await?;
    let subjects = vec![(entry.subject_type.clone(), entry.subject_id.clone())];
    let maps = load_subject_maps(&state.pools.main, &subjects).await?;
    let now = Utc::now();
    let base = case_row(&entry, &relations, &maps, now);

    let screening = match entry.screening_id {
        None => Value::Null,
        Some(screening_id) => {
            let screening_row_value = sqlx::query(sqlx::AssertSqlSafe(format!(
                "SELECT {} FROM aml_screenings WHERE id = $1",
                view::SCREENING_PROJECTION.join(", ")
            )))
            .bind(screening_id)
            .fetch_optional(&state.pools.main)
            .await
            .map_err(crate::routes::common::database_error)?;
            match screening_row_value {
                None => Value::Null,
                Some(row) => {
                    let screening = ScreeningDb::from_row(&row)?;
                    let matches = load_matches(&state.pools.main, &[screening.id]).await?;
                    let matches = matches.get(&screening.id).cloned().unwrap_or_default();
                    let matches: Vec<Value> = matches
                        .iter()
                        .map(|entry| {
                            json!({
                                "id": entry.id,
                                "listType": entry.list_type,
                                "listName": entry.list_name,
                                "listEntryRef": entry.list_entry_ref,
                                "matchedName": entry.matched_name,
                                "score": money4(Some(entry.score)),
                                "disposition": entry.disposition,
                                "dispositionNotes": entry.disposition_notes,
                            })
                        })
                        .collect();
                    json!({
                        "id": screening.id,
                        "result": screening.result,
                        "trigger": screening.trigger,
                        "providerCode": screening.provider_code,
                        "requestedAt": iso_naive(screening.requested_at),
                        "completedAt": screening.completed_at.map(iso_naive),
                        "highestScore": money4(screening.highest_score),
                        "matches": matches,
                    })
                }
            }
        }
    };

    let hold_journal_entry = match entry.hold_journal_entry_id {
        None => Value::Null,
        Some(journal_id) => {
            let row = sqlx::query(
                "SELECT id, ref_type, ref_id, description FROM journal_entries WHERE id = $1",
            )
            .bind(journal_id)
            .fetch_optional(&state.pools.main)
            .await
            .map_err(crate::routes::common::database_error)?;
            match row {
                None => Value::Null,
                Some(row) => json!({
                    "id": get::<Uuid>(&row, "id")?,
                    "refType": get::<String>(&row, "ref_type")?,
                    "refId": get::<String>(&row, "ref_id")?,
                    "description": opt_get::<String>(&row, "description")?,
                }),
            }
        }
    };

    let report_rows = sqlx::query(
        "SELECT id, report_type::text AS report_type, status::text AS status, submitted_at \
         FROM regulatory_reports WHERE aml_case_id = $1 ORDER BY created_at ASC, id ASC",
    )
    .bind(entry.id)
    .fetch_all(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?;
    let regulatory_reports: Vec<Value> = report_rows
        .iter()
        .map(|row| {
            Ok(json!({
                "id": get::<Uuid>(row, "id")?,
                "reportType": get::<String>(row, "report_type")?,
                "status": get::<String>(row, "status")?,
                "submittedAt": opt_get::<NaiveDateTime>(row, "submitted_at")?.map(iso_naive),
            }))
        })
        .collect::<Result<_, ApiError>>()?;
    let first_report = regulatory_reports.first().cloned().unwrap_or(Value::Null);

    let approval_row = sqlx::query(
        "SELECT id, state::text AS state, maker_user_id, checker_user_id, rejection_reason, created_at \
         FROM approval_requests WHERE subject_type IN ('AML_CASE','AmlCase','aml_case') AND subject_id = $1 \
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(entry.id.to_string())
    .fetch_optional(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?;
    let approval = match approval_row {
        None => Value::Null,
        Some(row) => json!({
            "id": get::<Uuid>(&row, "id")?,
            "state": get::<String>(&row, "state")?,
            "makerUserId": get::<Uuid>(&row, "maker_user_id")?,
            "checkerUserId": opt_get::<Uuid>(&row, "checker_user_id")?,
            "rejectionReason": opt_get::<String>(&row, "rejection_reason")?,
            "createdAt": iso_naive(get::<NaiveDateTime>(&row, "created_at")?),
        }),
    };

    let mut map = base.as_object().cloned().unwrap_or_default();
    map.insert("screening".into(), screening);
    map.insert("holdJournalEntry".into(), hold_journal_entry);
    map.insert("regulatoryReport".into(), first_report);
    map.insert("regulatoryReports".into(), Value::Array(regulatory_reports));
    map.insert("approval".into(), approval);
    ok(json!({ "case": Value::Object(map) }))
}

async fn case_evidence_impl(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<HttpResponse, ApiError> {
    let _actor = confidential(principal)?;
    let segments = tail(request, "/internal/admin/aml/cases/")?;
    let id = uuid_param(segments.first().ok_or_else(ApiError::server_error)?)?;
    let exists: Option<Uuid> = sqlx::query_scalar("SELECT id FROM aml_cases WHERE id = $1")
        .bind(id)
        .fetch_optional(&state.pools.main)
        .await
        .map_err(crate::routes::common::database_error)?;
    if exists.is_none() {
        return Err(not_found(
            "AML_CASE_NOT_FOUND",
            "The AML case does not exist",
        ));
    }
    let rows = sqlx::query(
        "SELECT e.id, e.aml_case_id, e.evidence_type, e.notes, e.uploaded_by_id, e.created_at, \
                o.original_filename, o.detected_mime_type, o.byte_size, o.sha256_hex, \
                o.status::text AS status, o.av_scan_status::text AS av_scan_status \
         FROM aml_case_evidence e JOIN storage_objects o ON o.id = e.storage_object_id \
         WHERE e.aml_case_id = $1 ORDER BY e.created_at DESC, e.id DESC",
    )
    .bind(id)
    .fetch_all(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?;
    let evidence: Vec<Value> = rows
        .iter()
        .map(|row| {
            Ok(json!({
                "id": get::<Uuid>(row, "id")?,
                "amlCaseId": get::<Uuid>(row, "aml_case_id")?,
                "evidenceType": get::<String>(row, "evidence_type")?,
                "notes": opt_get::<String>(row, "notes")?,
                "uploadedById": get::<String>(row, "uploaded_by_id")?,
                "createdAt": view::iso_utc(get::<DateTime<Utc>>(row, "created_at")?),
                "fileName": opt_get::<String>(row, "original_filename")?,
                "mimeType": get::<String>(row, "detected_mime_type")?,
                "byteSize": get::<i64>(row, "byte_size")?.to_string(),
                "sha256": get::<String>(row, "sha256_hex")?,
                "status": get::<String>(row, "status")?,
                "avScanStatus": get::<String>(row, "av_scan_status")?,
            }))
        })
        .collect::<Result<_, ApiError>>()?;
    ok(json!({ "evidence": evidence }))
}

async fn case_evidence_content_impl(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<HttpResponse, ApiError> {
    let actor = confidential(principal)?;
    let segments = tail(request, "/internal/admin/aml/cases/")?;
    let case_raw = segments.first().ok_or_else(ApiError::server_error)?;
    let evidence_raw = segments.get(2).ok_or_else(ApiError::server_error)?;
    let case_id = uuid_param(case_raw)?;
    let evidence_id = uuid_param(evidence_raw)?;
    let object_id: Option<Uuid> = sqlx::query_scalar(
        "SELECT storage_object_id FROM aml_case_evidence WHERE id = $1 AND aml_case_id = $2",
    )
    .bind(evidence_id)
    .bind(case_id)
    .fetch_optional(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?;
    let object_id = object_id
        .ok_or_else(|| not_found("AML_EVIDENCE_NOT_FOUND", "The AML evidence does not exist"))?;
    let request_id_value = request_id(request);
    let (bytes, mime_type, file_name) = read_authorized_object(
        &state.pools.main,
        Some(actor),
        object_id,
        "AML_CASE_EVIDENCE",
        &evidence_id.to_string(),
        crate::http::client_ip(request).as_deref(),
        request_id_value.as_deref(),
    )
    .await?;
    let disposition = content_disposition("attachment", file_name.as_deref(), "evidence");
    Ok(HttpResponse::Ok()
        .content_type(mime_type)
        .header("Content-Disposition", disposition)
        .header("Content-Security-Policy", "sandbox; default-src 'none'")
        .header("Cache-Control", "private, no-store")
        .header("X-Content-Type-Options", "nosniff")
        .body(bytes))
}

/* -------------------------------------------------------------------- rules */

#[derive(Debug, Clone)]
struct RuleDb {
    id: Uuid,
    created_at: NaiveDateTime,
    updated_at: NaiveDateTime,
    code: String,
    name: String,
    rule_type: String,
    scope: Value,
    params: Value,
    action: String,
    base_severity: String,
    active: bool,
    version: i32,
    effective_from: NaiveDateTime,
    effective_to: Option<NaiveDateTime>,
    approval_request_id: Option<Uuid>,
}

impl RuleDb {
    fn from_row(row: &PgRow) -> Result<Self, ApiError> {
        Ok(Self {
            id: get(row, "id")?,
            created_at: get(row, "created_at")?,
            updated_at: get(row, "updated_at")?,
            code: get(row, "code")?,
            name: get(row, "name")?,
            rule_type: get(row, "rule_type")?,
            scope: get(row, "scope")?,
            params: get(row, "params")?,
            action: get(row, "action")?,
            base_severity: get(row, "base_severity")?,
            active: get(row, "active")?,
            version: get(row, "version")?,
            effective_from: get(row, "effective_from")?,
            effective_to: opt_get(row, "effective_to")?,
            approval_request_id: opt_get(row, "approval_request_id")?,
        })
    }

    fn model(&self) -> Map<String, Value> {
        let mut map = Map::new();
        map.insert("id".into(), Value::String(self.id.to_string()));
        map.insert(
            "createdAt".into(),
            Value::String(iso_naive(self.created_at)),
        );
        map.insert(
            "updatedAt".into(),
            Value::String(iso_naive(self.updated_at)),
        );
        map.insert("code".into(), Value::String(self.code.clone()));
        map.insert("name".into(), Value::String(self.name.clone()));
        map.insert("ruleType".into(), Value::String(self.rule_type.clone()));
        map.insert("scope".into(), self.scope.clone());
        map.insert("params".into(), self.params.clone());
        map.insert("action".into(), Value::String(self.action.clone()));
        map.insert(
            "baseSeverity".into(),
            Value::String(self.base_severity.clone()),
        );
        map.insert("active".into(), Value::Bool(self.active));
        map.insert("version".into(), Value::from(self.version));
        map.insert(
            "effectiveFrom".into(),
            Value::String(iso_naive(self.effective_from)),
        );
        map.insert(
            "effectiveTo".into(),
            self.effective_to
                .map_or(Value::Null, |value| Value::String(iso_naive(value))),
        );
        map.insert(
            "approvalRequestId".into(),
            self.approval_request_id
                .map_or(Value::Null, |id| Value::String(id.to_string())),
        );
        map
    }
}

const RULE_PROJECTION: &str =
    "id, created_at, updated_at, code, name, rule_type::text AS rule_type, \
    scope, params, action::text AS action, base_severity::text AS base_severity, active, version, \
    effective_from, effective_to, approval_request_id";

async fn load_rules(
    state: &AppState,
    query: &Map<String, Value>,
    take: Option<i64>,
) -> Result<(Vec<RuleDb>, i64, list::Built), ApiError> {
    let mut built = list::build(query, &list::rules_spec(), &list::rules_columns())?;
    if let Some(take) = take {
        built.take = take;
        built.skip = 0;
    }
    let sql = format!(
        "SELECT {RULE_PROJECTION} FROM aml_rules {} ORDER BY {} LIMIT ${} OFFSET ${}",
        built.where_sql,
        built.order_by_sql,
        built.binds.len() + 1,
        built.binds.len() + 2
    );
    let rows = built
        .bind_rows(&sql)
        .fetch_all(&state.pools.main)
        .await
        .map_err(crate::routes::common::database_error)?;
    let mut rules = Vec::with_capacity(rows.len());
    for row in &rows {
        rules.push(RuleDb::from_row(row)?);
    }
    let total = fetch_total(&state.pools.main, &built, "aml_rules").await?;
    Ok((rules, total, built))
}

async fn rule_approvals(
    state: &AppState,
    rules: &[RuleDb],
) -> Result<HashMap<Uuid, (Uuid, String)>, ApiError> {
    let mut result = HashMap::new();
    if rules.is_empty() {
        return Ok(result);
    }
    let ids: Vec<Uuid> = rules.iter().map(|rule| rule.id).collect();
    let rows = sqlx::query(
        "SELECT DISTINCT ON (subject_id) subject_id, id, state::text AS state \
         FROM approval_requests \
         WHERE subject_type IN ('AML_RULE','AmlRule','aml_rule') AND subject_id = ANY($1::text[]) \
         ORDER BY subject_id, created_at DESC",
    )
    .bind(ids.iter().map(Uuid::to_string).collect::<Vec<_>>())
    .fetch_all(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?;
    for row in &rows {
        let subject: String = get(row, "subject_id")?;
        if let Ok(id) = Uuid::parse_str(&subject) {
            result.insert(id, (get(row, "id")?, get(row, "state")?));
        }
    }
    Ok(result)
}

fn rule_with_approval(rule: &RuleDb, approvals: &HashMap<Uuid, (Uuid, String)>) -> Value {
    let mut map = rule.model();
    let approval = approvals.get(&rule.id);
    map.insert(
        "approvalRequestId".into(),
        approval
            .map(|(id, _)| Value::String(id.to_string()))
            .unwrap_or(Value::Null),
    );
    map.insert(
        "approvalState".into(),
        approval
            .map(|(_, state)| Value::String(state.clone()))
            .unwrap_or(Value::Null),
    );
    map.insert(
        "pendingApproval".into(),
        Value::Bool(approval.is_some_and(|(_, state)| state == "PENDING_REVIEW")),
    );
    Value::Object(map)
}

async fn rules_list_impl(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<HttpResponse, ApiError> {
    let _actor = confidential(principal)?;
    let query = request_map(request);
    let (rules, total, built) = load_rules(state, &query, None).await?;
    let approvals = rule_approvals(state, &rules).await?;
    let shaped: Vec<Value> = rules
        .iter()
        .map(|rule| rule_with_approval(rule, &approvals))
        .collect();
    ok(envelope("rules", Value::Array(shaped), total, &built, &[]))
}

async fn rules_export_impl(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<HttpResponse, ApiError> {
    let actor = confidential(principal)?;
    let query = request_map(request);
    let checklist = checklist(
        &query,
        &[
            "RULE_SCOPE_VERIFIED",
            "RULE_DATA_REVIEWED",
            "EXPORT_AUTHORITY_CONFIRMED",
        ],
    );
    let (rules, total, _) = load_rules(state, &query, Some(5000)).await?;
    let approvals = rule_approvals(state, &rules).await?;
    let shaped: Vec<Value> = rules
        .iter()
        .map(|rule| rule_with_approval(rule, &approvals))
        .collect();
    let exported = shaped.len();
    write_audit(
        state,
        actor,
        &role_of(actor, "UNKNOWN"),
        "AML_RULES_EXPORTED",
        "AML_RULE",
        "export",
        json!({}),
        json!({
            "total": total,
            "exported": exported,
            "filters": filters_json(&query),
            "checklist": checklist,
        }),
    )
    .await?;
    ok(json!({
        "rules": shaped,
        "total": total,
        "exported": exported,
        "truncated": total > exported as i64,
    }))
}

async fn build_rule_summary(state: &AppState) -> Result<Value, ApiError> {
    let pool = &state.pools.main;
    let total: i64 = sqlx::query_scalar("SELECT count(*) FROM aml_rules")
        .fetch_one(pool)
        .await
        .map_err(crate::routes::common::database_error)?;
    let active: i64 = sqlx::query_scalar("SELECT count(*) FROM aml_rules WHERE active")
        .fetch_one(pool)
        .await
        .map_err(crate::routes::common::database_error)?;
    let pending: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM approval_requests WHERE subject_type IN ('AML_RULE','AmlRule','aml_rule') AND state = 'PENDING_REVIEW'",
    )
    .fetch_one(pool)
    .await
    .map_err(crate::routes::common::database_error)?;
    let severity_rows = sqlx::query(
        "SELECT base_severity::text AS key, count(*) AS total FROM aml_rules GROUP BY base_severity ORDER BY 1",
    )
    .fetch_all(pool)
    .await
    .map_err(crate::routes::common::database_error)?;
    let type_rows = sqlx::query(
        "SELECT rule_type::text AS key, count(*) AS total FROM aml_rules GROUP BY rule_type ORDER BY 1",
    )
    .fetch_all(pool)
    .await
    .map_err(crate::routes::common::database_error)?;
    let action_rows = sqlx::query(
        "SELECT action::text AS key, count(*) AS total FROM aml_rules GROUP BY action ORDER BY 1",
    )
    .fetch_all(pool)
    .await
    .map_err(crate::routes::common::database_error)?;
    let mut by_severity = Map::new();
    for row in &severity_rows {
        by_severity.insert(
            get::<String>(row, "key")?,
            Value::from(get::<i64>(row, "total")?),
        );
    }
    let mut by_type = Map::new();
    for row in &type_rows {
        by_type.insert(
            get::<String>(row, "key")?,
            Value::from(get::<i64>(row, "total")?),
        );
    }
    let mut by_action = Map::new();
    for row in &action_rows {
        by_action.insert(
            get::<String>(row, "key")?,
            Value::from(get::<i64>(row, "total")?),
        );
    }
    Ok(json!({
        "total": total,
        "active": active,
        "inactive": total - active,
        "pendingApprovals": pending,
        "bySeverity": by_severity,
        "byType": by_type,
        "byAction": by_action,
    }))
}

async fn rules_summary_impl(
    state: &AppState,
    _request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<HttpResponse, ApiError> {
    let _actor = confidential(principal)?;
    ok(build_rule_summary(state).await?)
}

async fn rules_summary_export_impl(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<HttpResponse, ApiError> {
    let actor = confidential(principal)?;
    let summary = build_rule_summary(state).await?;
    let query = request_map(request);
    let checklist = checklist(
        &query,
        &[
            "RULE_SCOPE_VERIFIED",
            "ACTIVE_INACTIVE_REVIEWED",
            "PENDING_APPROVAL_REVIEWED",
            "EXPORT_APPROVAL_CONFIRMED",
        ],
    );
    write_audit(
        state,
        actor,
        &role_of(actor, "UNKNOWN"),
        "AML_RULE_SUMMARY_EXPORTED",
        "AML_RULE",
        "summary",
        json!({}),
        json!({
            "total": summary.get("total").cloned().unwrap_or(Value::Null),
            "active": summary.get("active").cloned().unwrap_or(Value::Null),
            "inactive": summary.get("inactive").cloned().unwrap_or(Value::Null),
            "pendingApprovals": summary.get("pendingApprovals").cloned().unwrap_or(Value::Null),
            "checklist": checklist,
        }),
    )
    .await?;
    let mut map = summary.as_object().cloned().unwrap_or_default();
    map.insert("exportedAt".into(), Value::String(now_iso()));
    ok(Value::Object(map))
}

async fn rule_detail_impl(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<HttpResponse, ApiError> {
    let _actor = confidential(principal)?;
    let id = uuid_from_tail(request, "/internal/admin/aml/rules/", 0)?;
    let row = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {RULE_PROJECTION} FROM aml_rules WHERE id = $1"
    )))
    .bind(id)
    .fetch_optional(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?
    .ok_or_else(|| not_found("AML_RULE_NOT_FOUND", "The AML rule does not exist"))?;
    let rule = RuleDb::from_row(&row)?;
    let approval = match rule.approval_request_id {
        None => Value::Null,
        Some(approval_id) => {
            let row = sqlx::query(
                "SELECT id, state::text AS state, maker_user_id, checker_user_id, rejection_reason, created_at \
                 FROM approval_requests WHERE id = $1",
            )
            .bind(approval_id)
            .fetch_optional(&state.pools.main)
            .await
            .map_err(crate::routes::common::database_error)?;
            match row {
                None => Value::Null,
                Some(row) => json!({
                    "id": get::<Uuid>(&row, "id")?,
                    "state": get::<String>(&row, "state")?,
                    "makerUserId": get::<Uuid>(&row, "maker_user_id")?,
                    "checkerUserId": opt_get::<Uuid>(&row, "checker_user_id")?,
                    "rejectionReason": opt_get::<String>(&row, "rejection_reason")?,
                    "createdAt": iso_naive(get::<NaiveDateTime>(&row, "created_at")?),
                }),
            }
        }
    };
    let mut map = rule.model();
    map.insert("approvalRequest".into(), approval.clone());
    map.insert(
        "approvalState".into(),
        approval.get("state").cloned().unwrap_or(Value::Null),
    );
    map.insert("approval".into(), approval);
    ok(json!({ "rule": Value::Object(map) }))
}

/* ---------------------------------------------------------- reporting rules */

async fn reporting_rules_impl(
    state: &AppState,
    _request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<HttpResponse, ApiError> {
    let _actor = confidential(principal)?;
    let rows = sqlx::query(
        "SELECT id, created_at, updated_at, authority, report_type::text AS report_type, threshold_amount, \
                window_seconds, currency::text AS currency, conditions, source_reference, status::text AS status, \
                effective_from, effective_to, approval_request_id, required_output_formats::text[] AS required_output_formats, \
                primary_output_format::text AS primary_output_format \
         FROM reporting_rules",
    )
    .fetch_all(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?;
    let rules: Vec<Value> = rows
        .iter()
        .map(|row| {
            let mut map = Map::new();
            map.insert(
                "id".into(),
                Value::String(get::<Uuid>(row, "id")?.to_string()),
            );
            map.insert(
                "createdAt".into(),
                Value::String(iso_naive(get::<NaiveDateTime>(row, "created_at")?)),
            );
            map.insert(
                "updatedAt".into(),
                Value::String(iso_naive(get::<NaiveDateTime>(row, "updated_at")?)),
            );
            map.insert(
                "authority".into(),
                Value::String(get::<String>(row, "authority")?),
            );
            map.insert(
                "reportType".into(),
                Value::String(get::<String>(row, "report_type")?),
            );
            map.insert(
                "thresholdAmount".into(),
                opt_get::<rust_decimal::Decimal>(row, "threshold_amount")?
                    .map_or(Value::Null, decimal_js),
            );
            map.insert(
                "windowSeconds".into(),
                opt_get::<i32>(row, "window_seconds")?.map_or(Value::Null, Value::from),
            );
            map.insert(
                "currency".into(),
                Value::String(get::<String>(row, "currency")?),
            );
            map.insert("conditions".into(), get::<Value>(row, "conditions")?);
            map.insert(
                "sourceReference".into(),
                opt_get::<String>(row, "source_reference")?.map_or(Value::Null, Value::String),
            );
            map.insert(
                "status".into(),
                Value::String(get::<String>(row, "status")?),
            );
            map.insert(
                "effectiveFrom".into(),
                Value::String(iso_naive(get::<NaiveDateTime>(row, "effective_from")?)),
            );
            map.insert(
                "effectiveTo".into(),
                opt_get::<NaiveDateTime>(row, "effective_to")?
                    .map_or(Value::Null, |value| Value::String(iso_naive(value))),
            );
            map.insert(
                "approvalRequestId".into(),
                opt_get::<Uuid>(row, "approval_request_id")?
                    .map_or(Value::Null, |id| Value::String(id.to_string())),
            );
            map.insert(
                "requiredOutputFormats".into(),
                Value::Array(
                    get::<Vec<String>>(row, "required_output_formats")?
                        .into_iter()
                        .map(Value::String)
                        .collect(),
                ),
            );
            map.insert(
                "primaryOutputFormat".into(),
                opt_get::<String>(row, "primary_output_format")?.map_or(Value::Null, Value::String),
            );
            Ok(Value::Object(map))
        })
        .collect::<Result<_, ApiError>>()?;
    ok(json!({ "rules": rules }))
}

/* ------------------------------------------------------ regulatory schemas */

async fn load_schema(state: &AppState, id: Uuid) -> Result<Option<RegulatorySchemaDb>, ApiError> {
    let row = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {} FROM regulatory_report_schemas WHERE id = $1",
        view::SCHEMA_PROJECTION.join(", ")
    )))
    .bind(id)
    .fetch_optional(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?;
    row.as_ref().map(RegulatorySchemaDb::from_row).transpose()
}

async fn report_schemas_impl(
    state: &AppState,
    _request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<HttpResponse, ApiError> {
    let _actor = confidential(principal)?;
    let sql = format!(
        "SELECT {} FROM regulatory_report_schemas \
         ORDER BY authority ASC, \
           CASE report_type WHEN 'LARGE_TRANSACTION' THEN 0 WHEN 'SUSPICIOUS_ACTIVITY' THEN 1 WHEN 'PERIODIC_RETURN' THEN 2 WHEN 'INCIDENT' THEN 3 ELSE 4 END ASC, \
           CASE format WHEN 'XML' THEN 0 WHEN 'XLSX' THEN 1 WHEN 'DOCX' THEN 2 ELSE 3 END ASC, \
           schema_code ASC, version DESC",
        view::SCHEMA_PROJECTION.join(", ")
    );
    let rows = sqlx::query(AssertSqlSafe(sql))
        .fetch_all(&state.pools.main)
        .await
        .map_err(crate::routes::common::database_error)?;
    let schemas: Vec<Value> = rows
        .iter()
        .map(|row| Ok(schema_row(&RegulatorySchemaDb::from_row(row)?)))
        .collect::<Result<_, ApiError>>()?;
    ok(json!({ "schemas": schemas }))
}

async fn report_schema_detail_impl(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<HttpResponse, ApiError> {
    let _actor = confidential(principal)?;
    let id = uuid_from_tail(request, "/internal/admin/aml/report-schemas/", 0)?;
    let schema = load_schema(state, id).await?.ok_or_else(|| {
        not_found(
            "REPORT_SCHEMA_NOT_FOUND",
            "The reporting schema does not exist",
        )
    })?;
    let default_bindings: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM regulatory_schema_default_bindings WHERE schema_id = $1",
    )
    .bind(schema.id)
    .fetch_one(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?;
    let rule_bindings: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM regulatory_rule_schema_bindings WHERE schema_id = $1",
    )
    .bind(schema.id)
    .fetch_one(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?;
    let outputs: i64 =
        sqlx::query_scalar("SELECT count(*) FROM regulatory_report_outputs WHERE schema_id = $1")
            .bind(schema.id)
            .fetch_one(&state.pools.main)
            .await
            .map_err(crate::routes::common::database_error)?;
    let approval = match schema.approval_request_id {
        None => Value::Null,
        Some(approval_id) => {
            let row = sqlx::query(
                "SELECT id, state::text AS state, expires_at, maker_user_id, checker_user_id \
                 FROM approval_requests WHERE id = $1",
            )
            .bind(approval_id)
            .fetch_optional(&state.pools.main)
            .await
            .map_err(crate::routes::common::database_error)?;
            match row {
                None => Value::Null,
                Some(row) => json!({
                    "id": get::<Uuid>(&row, "id")?,
                    "state": get::<String>(&row, "state")?,
                    "expiresAt": opt_get::<NaiveDateTime>(&row, "expires_at")?.map(iso_naive),
                    "makerUserId": get::<Uuid>(&row, "maker_user_id")?,
                    "checkerUserId": opt_get::<Uuid>(&row, "checker_user_id")?,
                }),
            }
        }
    };
    let template_present =
        schema.template_object_id.is_some() || schema.template_ciphertext.is_some();
    ok(json!({
        "schema": schema_row(&schema),
        "definition": schema.definition_text,
        "sampleContext": schema.sample_context,
        "notes": schema.notes,
        "compiled": schema.compiled,
        "mapping": schema.mapping,
        "template": {
            "present": template_present,
            "sha256": schema.template_sha256,
            "binding": schema.template_binding,
        },
        "approval": approval,
        "usage": {
            "defaultBindings": default_bindings,
            "ruleBindings": rule_bindings,
            "outputs": outputs,
        },
        "capabilities": {
            "edit": schema.status == "DRAFT",
            "clone": true,
            "promote": schema.status == "DRAFT" || schema.status == "PROVISIONAL",
            "setDefault": schema.status == "CONFIRMED",
        },
    }))
}

const TRANSFORM_OPERATIONS: &[&str] = &[
    "scale",
    "MUL_INT",
    "DIV_DECIMAL",
    "round",
    "format_decimal",
    "to_int",
    "to_number",
    "to_string",
    "concat",
    "template",
    "lowercase",
    "uppercase",
    "trim",
    "pad_left",
    "pad_right",
    "substring",
    "mask",
    "prepend",
    "arabic_digits_to_ascii",
    "phone_normalize",
    "sort_keys",
    "values_only",
    "join_pairs",
    "format_date",
    "epoch_seconds",
    "epoch_millis",
    "uuid",
    "numeric_random",
    "base64_encode",
    "hex_lower",
    "hex_upper",
    "url_encode",
    "json_encode",
    "xml_escape",
    "sha256",
    "sha512",
    "hmac_sha256",
    "hmac_sha512",
    "rsa_sha256_sign",
];

fn report_context_catalog_value() -> Value {
    json!({
        "institution": ["rentityId", "rentityBranch", "submissionCode", "localCurrencyCode", "reportingPersonName", "reportingPersonEmail"],
        "report": ["id", "reportType", "reportCode", "authority", "periodStart", "periodEnd", "periodKey", "dueAt"],
        "merchant": ["id", "legalName", "tradeName", "registrationNo", "taxId", "businessCategory", "country", "status", "kybStatus", "riskTier", "contactPhone", "contactEmail", "payoutBankDetails"],
        "wallet": ["id", "currency", "status"],
        "transaction": ["id", "reference", "providerReference", "gatewayReference", "networkReference", "createdAt", "date", "status", "substatus", "amount", "totalChargedAmount", "settledAmount", "currency", "railCode", "railName", "gatewayCode", "gatewayName", "collectionMode", "payerPhone", "payerName"],
        "amlCase": ["id", "subjectType", "subjectId", "triggerReason", "severity", "status", "resolutionNotes"],
        "indicator": ["id", "code", "description"],
        "aggregate": ["summaryRows", "paymentRails", "refundsRows", "disputesOpenedRows", "disputesDecidedRows", "cashoutsRows", "merchantStatusRows", "fundsRows", "screeningRows", "amlCaseRows", "kybRows", "riskTierRows"],
        "narrative": ["riskAssessment", "policyAndControlChanges", "auditFindings"],
        "arrays": {
            "transactions": "transaction",
            "indicators": "indicator",
            "paymentRails": "aggregate",
            "summaryRows": "aggregate",
            "refundsRows": "aggregate",
            "disputesOpenedRows": "aggregate",
            "disputesDecidedRows": "aggregate",
            "cashoutsRows": "aggregate",
            "merchantStatusRows": "aggregate",
            "fundsRows": "aggregate",
            "screeningRows": "aggregate",
            "amlCaseRows": "aggregate",
            "kybRows": "aggregate",
            "riskTierRows": "aggregate",
        },
        "sourceKinds": ["CONTEXT_PATH", "CONSTANT", "CODE_MAP", "TEMPLATE"],
        "transformOperations": TRANSFORM_OPERATIONS,
        "conditionOperators": ["EQ", "NEQ", "IN", "NOT_EMPTY", "GT"],
    })
}

async fn report_context_catalog_impl(
    _state: &AppState,
    _request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<HttpResponse, ApiError> {
    let _actor = confidential(principal)?;
    ok(json!({ "catalog": report_context_catalog_value() }))
}

async fn report_schema_template_impl(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<HttpResponse, ApiError> {
    let actor = confidential(principal)?;
    let id = uuid_from_tail(request, "/internal/admin/aml/report-schemas/", 0)?;
    let schema = load_schema(state, id).await?.ok_or_else(|| {
        not_found(
            "REPORT_SCHEMA_NOT_FOUND",
            "The reporting schema does not exist",
        )
    })?;
    let bytes = if let Some(object_id) = schema.template_object_id {
        read_internal_object(&state.pools.main, object_id).await?
    } else if let Some(ciphertext) = schema.template_ciphertext.as_deref() {
        let plain = view::decrypt_vault(ciphertext).map_err(|error| {
            tracing::error!(schema = %schema.id, error = %error, "reporting template could not be decrypted");
            ApiError::new(
                503,
                "REPORT_SCHEMA_TEMPLATE_UNAVAILABLE",
                "The workbook template cannot be read",
            )
        })?;
        base64_decode(&plain).ok_or_else(|| {
            ApiError::new(
                503,
                "REPORT_SCHEMA_TEMPLATE_UNAVAILABLE",
                "The workbook template cannot be read",
            )
        })?
    } else {
        return Err(not_found(
            "REPORT_SCHEMA_TEMPLATE_NOT_FOUND",
            "This schema has no workbook template",
        ));
    };
    write_audit(
        state,
        actor,
        &role_of(actor, "SYSTEM"),
        "REGULATORY_REPORT_SCHEMA_TEMPLATE_DOWNLOADED",
        "REGULATORY_REPORT_SCHEMA",
        &schema.id.to_string(),
        json!({}),
        json!({ "templateSha256": schema.template_sha256 }),
    )
    .await?;
    Ok(HttpResponse::Ok()
        .content_type("text/plain; charset=utf-8")
        .body(
            json!({
                "templateBase64": base64_encode(&bytes),
                "templateSha256": schema.template_sha256,
                "templateBinding": schema.template_binding,
            })
            .to_string(),
        ))
}

async fn reporting_rule_bindings_impl(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<HttpResponse, ApiError> {
    let _actor = confidential(principal)?;
    let id = uuid_from_tail(request, "/internal/admin/aml/reporting-rules/", 0)?;
    let rows = sqlx::query(
        "SELECT b.id, b.rule_id, b.format::text AS format, b.schema_id, b.created_at, \
                s.id AS s_id, s.authority, s.report_type::text AS s_report_type, s.format::text AS s_format, \
                s.schema_code, s.report_code, s.name AS s_name, s.version AS s_version, s.revision AS s_revision, \
                s.status::text AS s_status, s.definition_sha256, s.mapping_sha256, s.template_sha256, \
                s.cloned_from_schema_id, s.compiled_definition_json, s.mapping_blueprint_json, \
                s.sample_context_json, s.notes, s.definition_text, s.template_object_id, s.template_ciphertext, \
                s.template_binding_json, s.approval_request_id, s.approved_at, s.created_at AS s_created_at, \
                s.updated_at AS s_updated_at \
         FROM regulatory_rule_schema_bindings b JOIN regulatory_report_schemas s ON s.id = b.schema_id \
         WHERE b.rule_id = $1 \
         ORDER BY CASE b.format WHEN 'XML' THEN 0 WHEN 'XLSX' THEN 1 WHEN 'DOCX' THEN 2 ELSE 3 END ASC",
    )
    .bind(id)
    .fetch_all(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?;
    let bindings: Vec<Value> = rows
        .iter()
        .map(|row| {
            let schema = schema_from_prefixed_row(row)?;
            let mut map = Map::new();
            map.insert(
                "id".into(),
                Value::String(get::<Uuid>(row, "id")?.to_string()),
            );
            map.insert(
                "ruleId".into(),
                Value::String(get::<Uuid>(row, "rule_id")?.to_string()),
            );
            map.insert(
                "format".into(),
                Value::String(get::<String>(row, "format")?),
            );
            map.insert(
                "schemaId".into(),
                Value::String(get::<Uuid>(row, "schema_id")?.to_string()),
            );
            map.insert(
                "createdAt".into(),
                Value::String(iso_naive(get::<NaiveDateTime>(row, "created_at")?)),
            );
            map.insert("schema".into(), schema_row(&schema));
            Ok(Value::Object(map))
        })
        .collect::<Result<_, ApiError>>()?;
    ok(json!({ "bindings": bindings }))
}

/// Decode the `s_` prefixed schema columns of the binding joins.
fn schema_from_prefixed_row(row: &PgRow) -> Result<RegulatorySchemaDb, ApiError> {
    Ok(RegulatorySchemaDb {
        id: get(row, "s_id")?,
        authority: get(row, "authority")?,
        report_type: get(row, "s_report_type")?,
        format: get(row, "s_format")?,
        schema_code: get(row, "schema_code")?,
        report_code: get(row, "report_code")?,
        name: get(row, "s_name")?,
        version: get(row, "s_version")?,
        revision: get(row, "s_revision")?,
        status: get(row, "s_status")?,
        definition_sha256: opt_get(row, "definition_sha256")?,
        mapping_sha256: opt_get(row, "mapping_sha256")?,
        template_sha256: opt_get(row, "template_sha256")?,
        cloned_from_schema_id: opt_get(row, "cloned_from_schema_id")?,
        compiled: get(row, "compiled_definition_json")?,
        mapping: get(row, "mapping_blueprint_json")?,
        sample_context: opt_get(row, "sample_context_json")?,
        notes: opt_get(row, "notes")?,
        definition_text: opt_get(row, "definition_text")?,
        template_object_id: opt_get(row, "template_object_id")?,
        template_ciphertext: opt_get(row, "template_ciphertext")?,
        template_binding: opt_get(row, "template_binding_json")?,
        approval_request_id: opt_get(row, "approval_request_id")?,
        approved_at: opt_get(row, "approved_at")?,
        created_at: get(row, "s_created_at")?,
        updated_at: get(row, "s_updated_at")?,
    })
}

async fn report_requirements_impl(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<HttpResponse, ApiError> {
    let _actor = confidential(principal)?;
    let id = uuid_from_tail(request, "/internal/admin/aml/reports/", 0)?;
    let row = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {}, payload_ciphertext FROM regulatory_reports WHERE id = $1",
        view::REPORT_PROJECTION.join(", ")
    )))
    .bind(id)
    .fetch_optional(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?
    .ok_or_else(|| {
        not_found(
            "REGULATORY_REPORT_NOT_FOUND",
            "The regulatory report does not exist",
        )
    })?;
    let report = ReportDb::from_row(&row)?;
    let payload_ciphertext: String = get(&row, "payload_ciphertext")?;
    let rule_id = if report.subject_type == "REPORTING_RULE" {
        Uuid::parse_str(&report.subject_id).ok()
    } else {
        None
    };
    let default_report_code = report.report_code.clone().unwrap_or_default();
    let mut requirements = Vec::with_capacity(report.required_output_formats.len());
    for format in &report.required_output_formats {
        let mut schema: Option<RegulatorySchemaDb> = None;
        if let Some(rule_id) = rule_id {
            schema = load_schema_for_rule(&state.pools.main, rule_id, format).await?;
        }
        if schema.is_none() {
            schema = load_default_schema(
                &state.pools.main,
                &report.authority,
                &report.report_type,
                &default_report_code,
                format,
            )
            .await?;
        }
        let narrative_sections = match format.as_str() {
            "DOCX" => schema
                .as_ref()
                .and_then(|schema| schema.compiled.get("sections"))
                .and_then(Value::as_array)
                .map(|sections| {
                    Value::Array(
                        sections
                            .iter()
                            .map(|section| {
                                json!({
                                    "key": section.get("key").cloned().unwrap_or(Value::Null),
                                    "title": section.get("title").cloned().unwrap_or(Value::Null),
                                    "required": section.get("required").and_then(Value::as_bool) == Some(true),
                                })
                            })
                            .collect(),
                    )
                })
                .unwrap_or_else(|| Value::Array(Vec::new())),
            "XLSX" => schema
                .as_ref()
                .and_then(|schema| schema.compiled.get("narrativeSections"))
                .cloned()
                .unwrap_or_else(|| Value::Array(Vec::new())),
            _ => Value::Array(Vec::new()),
        };
        requirements.push(json!({
            "format": format,
            "schema": schema.as_ref().map(schema_row).unwrap_or(Value::Null),
            "narrativeSections": narrative_sections,
            "paths": schema
                .as_ref()
                .map(|schema| view::object_len(&schema.compiled, "paths"))
                .unwrap_or_else(|| Value::from(0)),
            "codeLists": schema
                .as_ref()
                .map(|schema| view::object_len(&schema.compiled, "codeLists"))
                .unwrap_or_else(|| Value::from(0)),
            "editable": report.status == "DRAFT" || report.status == "PENDING_CHECKER",
        }));
    }
    let payload = read_payload(Some(&payload_ciphertext))?;
    let narrative = payload
        .get("narrative")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let pending = match payload.get("pending") {
        Some(Value::Array(entries)) => Value::Array(entries.clone()),
        _ => Value::Array(Vec::new()),
    };
    ok(json!({
        "report": {
            "id": report.id,
            "status": report.status,
            "reportCode": report.report_code,
            "periodKey": report.period_key,
            "dueAt": report.due_at.map(iso_naive),
            "requiredOutputFormats": report.required_output_formats,
            "payloadSha256": report.payload_sha256,
        },
        "requirements": requirements,
        "narrative": narrative,
        "pending": pending,
    }))
}

async fn load_schema_for_rule(
    pool: &PgPool,
    rule_id: Uuid,
    format: &str,
) -> Result<Option<RegulatorySchemaDb>, ApiError> {
    let row = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {} FROM regulatory_report_schemas s \
         JOIN regulatory_rule_schema_bindings b ON b.schema_id = s.id \
         WHERE b.rule_id = $1 AND b.format::text = $2 LIMIT 1",
        view::SCHEMA_PROJECTION
            .iter()
            .map(|column| format!("s.{column}"))
            .collect::<Vec<_>>()
            .join(", ")
    )))
    .bind(rule_id)
    .bind(format)
    .fetch_optional(pool)
    .await
    .map_err(crate::routes::common::database_error)?;
    row.as_ref().map(RegulatorySchemaDb::from_row).transpose()
}

async fn load_default_schema(
    pool: &PgPool,
    authority: &str,
    report_type: &str,
    report_code: &str,
    format: &str,
) -> Result<Option<RegulatorySchemaDb>, ApiError> {
    let row = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {} FROM regulatory_report_schemas s \
         JOIN regulatory_schema_default_bindings b ON b.schema_id = s.id \
         WHERE b.authority = $1 AND b.report_type::text = $2 AND b.report_code = $3 AND b.format::text = $4 LIMIT 1",
        view::SCHEMA_PROJECTION
            .iter()
            .map(|column| format!("s.{column}"))
            .collect::<Vec<_>>()
            .join(", ")
    )))
    .bind(authority)
    .bind(report_type)
    .bind(report_code)
    .bind(format)
    .fetch_optional(pool)
    .await
    .map_err(crate::routes::common::database_error)?;
    row.as_ref().map(RegulatorySchemaDb::from_row).transpose()
}

async fn report_schema_defaults_impl(
    state: &AppState,
    _request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<HttpResponse, ApiError> {
    let _actor = confidential(principal)?;
    let rows = sqlx::query(AssertSqlSafe(
        "SELECT b.id, b.created_at, b.updated_at, b.authority, b.report_type::text AS report_type, \
                b.report_code, b.format::text AS format, b.schema_id, b.updated_by_user_id, b.approval_request_id, \
                s.id AS s_id, s.authority AS s_authority, s.report_type::text AS s_report_type, \
                s.format::text AS s_format, s.schema_code, s.report_code AS s_report_code, s.name AS s_name, \
                s.version AS s_version, s.revision AS s_revision, s.status::text AS s_status, \
                s.definition_sha256, s.mapping_sha256, s.template_sha256, s.cloned_from_schema_id, \
                s.compiled_definition_json, s.mapping_blueprint_json, s.sample_context_json, s.notes, \
                s.definition_text, s.template_object_id, s.template_ciphertext, s.template_binding_json, \
                s.approval_request_id AS s_approval_request_id, s.approved_at, \
                s.created_at AS s_created_at, s.updated_at AS s_updated_at \
         FROM regulatory_schema_default_bindings b JOIN regulatory_report_schemas s ON s.id = b.schema_id \
         ORDER BY b.authority ASC, \
           CASE b.report_type WHEN 'LARGE_TRANSACTION' THEN 0 WHEN 'SUSPICIOUS_ACTIVITY' THEN 1 WHEN 'PERIODIC_RETURN' THEN 2 WHEN 'INCIDENT' THEN 3 ELSE 4 END ASC, \
           b.report_code ASC, \
           CASE b.format WHEN 'XML' THEN 0 WHEN 'XLSX' THEN 1 WHEN 'DOCX' THEN 2 ELSE 3 END ASC"
    ))
    .fetch_all(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?;
    let bindings: Vec<Value> = rows
        .iter()
        .map(|row| {
            let mut map = Map::new();
            map.insert(
                "id".into(),
                Value::String(get::<Uuid>(row, "id")?.to_string()),
            );
            map.insert(
                "createdAt".into(),
                Value::String(iso_naive(get::<NaiveDateTime>(row, "created_at")?)),
            );
            map.insert(
                "updatedAt".into(),
                Value::String(iso_naive(get::<NaiveDateTime>(row, "updated_at")?)),
            );
            map.insert(
                "authority".into(),
                Value::String(get::<String>(row, "authority")?),
            );
            map.insert(
                "reportType".into(),
                Value::String(get::<String>(row, "report_type")?),
            );
            map.insert(
                "reportCode".into(),
                Value::String(get::<String>(row, "report_code")?),
            );
            map.insert(
                "format".into(),
                Value::String(get::<String>(row, "format")?),
            );
            map.insert(
                "schemaId".into(),
                Value::String(get::<Uuid>(row, "schema_id")?.to_string()),
            );
            map.insert(
                "updatedByUserId".into(),
                opt_get::<Uuid>(row, "updated_by_user_id")?
                    .map_or(Value::Null, |id| Value::String(id.to_string())),
            );
            map.insert(
                "approvalRequestId".into(),
                opt_get::<Uuid>(row, "approval_request_id")?
                    .map_or(Value::Null, |id| Value::String(id.to_string())),
            );
            let schema = RegulatorySchemaDb {
                id: get(row, "s_id")?,
                authority: get(row, "s_authority")?,
                report_type: get(row, "s_report_type")?,
                format: get(row, "s_format")?,
                schema_code: get(row, "schema_code")?,
                report_code: get(row, "s_report_code")?,
                name: get(row, "s_name")?,
                version: get(row, "s_version")?,
                revision: get(row, "s_revision")?,
                status: get(row, "s_status")?,
                definition_sha256: opt_get(row, "definition_sha256")?,
                mapping_sha256: opt_get(row, "mapping_sha256")?,
                template_sha256: opt_get(row, "template_sha256")?,
                cloned_from_schema_id: opt_get(row, "cloned_from_schema_id")?,
                compiled: get(row, "compiled_definition_json")?,
                mapping: get(row, "mapping_blueprint_json")?,
                sample_context: opt_get(row, "sample_context_json")?,
                notes: opt_get(row, "notes")?,
                definition_text: opt_get(row, "definition_text")?,
                template_object_id: opt_get(row, "template_object_id")?,
                template_ciphertext: opt_get(row, "template_ciphertext")?,
                template_binding: opt_get(row, "template_binding_json")?,
                approval_request_id: opt_get(row, "s_approval_request_id")?,
                approved_at: opt_get(row, "approved_at")?,
                created_at: get(row, "s_created_at")?,
                updated_at: get(row, "s_updated_at")?,
            };
            map.insert("schema".into(), schema_row(&schema));
            Ok(Value::Object(map))
        })
        .collect::<Result<_, ApiError>>()?;
    ok(json!({ "bindings": bindings }))
}

/* ------------------------------------------------------ regulatory reports */

async fn reports_page(
    state: &AppState,
    query: &Map<String, Value>,
    take: Option<i64>,
) -> Result<(Vec<ReportDb>, i64, list::Built), ApiError> {
    let search = query.get("search").and_then(Value::as_str);
    let mut raw = query.clone();
    raw.remove("search");
    let mut built = list::build(&raw, &list::reports_spec(), &list::reports_columns())?;
    if let Some(search) = search {
        if !search.trim().is_empty() {
            let ids = incident_ids_matching(&state.pools.main, search).await?;
            built = list::merge_incident_search(
                built,
                search,
                &ids,
                &["r.subject_id", "r.submission_ref", "r.aml_case_id::text"],
            );
        }
    }
    if let Some(take) = take {
        built.take = take;
        built.skip = 0;
    }
    let rows = fetch_rows(
        &state.pools.main,
        &built,
        REPORTS_TABLE,
        view::REPORT_PROJECTION,
    )
    .await?;
    let mut reports = Vec::with_capacity(rows.len());
    for row in &rows {
        reports.push(ReportDb::from_row(row)?);
    }
    let total = fetch_total(&state.pools.main, &built, REPORTS_TABLE).await?;
    Ok((reports, total, built))
}

async fn incident_ids_matching(pool: &PgPool, search: &str) -> Result<Vec<String>, ApiError> {
    let rows = sqlx::query(
        "SELECT id FROM incidents WHERE reference ILIKE $1 OR title ILIKE $1 LIMIT 200",
    )
    .bind(format!("%{search}%"))
    .fetch_all(pool)
    .await
    .map_err(crate::routes::common::database_error)?;
    rows.iter()
        .map(|row| Ok(get::<Uuid>(row, "id")?.to_string()))
        .collect()
}

#[derive(Debug, Clone)]
struct OutputDb {
    id: Uuid,
    format: String,
    revision: i32,
    schema_id: Option<Uuid>,
    schema_version: Option<i32>,
    validation_status: String,
    validation_errors: Option<Value>,
    content_sha256: String,
    generated_at: Option<NaiveDateTime>,
    submitted_at: Option<NaiveDateTime>,
    content_ciphertext: Option<String>,
    storage_object_id: Option<Uuid>,
    schema_code: Option<String>,
    schema_name: Option<String>,
    schema_status: Option<String>,
}

impl OutputDb {
    fn from_row(row: &PgRow) -> Result<Self, ApiError> {
        Ok(Self {
            id: get(row, "id")?,
            format: get(row, "format")?,
            revision: get(row, "revision")?,
            schema_id: opt_get(row, "schema_id")?,
            schema_version: opt_get(row, "schema_version")?,
            validation_status: get(row, "validation_status")?,
            validation_errors: opt_get(row, "validation_errors_json")?,
            content_sha256: get(row, "content_sha256")?,
            generated_at: opt_get(row, "generated_at")?,
            submitted_at: opt_get(row, "submitted_at")?,
            content_ciphertext: opt_get(row, "content_ciphertext")?,
            storage_object_id: opt_get(row, "storage_object_id")?,
            schema_code: opt_get(row, "schema_code")?,
            schema_name: opt_get(row, "schema_name")?,
            schema_status: opt_get(row, "schema_status")?,
        })
    }

    fn from_download_row(row: &PgRow) -> Result<Self, ApiError> {
        Ok(Self {
            id: get(row, "id")?,
            format: get(row, "format")?,
            revision: get(row, "revision")?,
            schema_id: opt_get(row, "schema_id")?,
            schema_version: opt_get(row, "schema_version")?,
            validation_status: get(row, "validation_status")?,
            validation_errors: opt_get(row, "validation_errors_json")?,
            content_sha256: get(row, "content_sha256")?,
            generated_at: opt_get(row, "generated_at")?,
            submitted_at: opt_get(row, "submitted_at")?,
            content_ciphertext: opt_get(row, "content_ciphertext")?,
            storage_object_id: opt_get(row, "storage_object_id")?,
            schema_code: None,
            schema_name: None,
            schema_status: None,
        })
    }

    fn shape(&self, partial: bool) -> view::ReportOutputRow {
        view::ReportOutputRow {
            id: self.id,
            format: self.format.clone(),
            revision: self.revision,
            schema_id: self.schema_id,
            schema_version: self.schema_version,
            validation_status: self.validation_status.clone(),
            validation_errors: self.validation_errors.clone(),
            content_sha256: self.content_sha256.clone(),
            generated_at: self.generated_at,
            submitted_at: self.submitted_at,
            schema_code: self.schema_code.clone(),
            schema_name: self.schema_name.clone(),
            schema_status: self.schema_status.clone(),
            partial,
        }
    }
}

async fn load_report_outputs(
    pool: &PgPool,
    report_ids: &[Uuid],
    with_schema: bool,
) -> Result<HashMap<Uuid, Vec<OutputDb>>, ApiError> {
    let mut grouped: HashMap<Uuid, Vec<OutputDb>> = HashMap::new();
    if report_ids.is_empty() {
        return Ok(grouped);
    }
    let sql = if with_schema {
        "SELECT o.id, o.report_id, o.format::text AS format, o.revision, o.schema_id, o.schema_version, \
                o.validation_status::text AS validation_status, o.validation_errors_json, o.content_sha256, \
                o.generated_at, o.submitted_at, o.content_ciphertext, o.storage_object_id, \
                s.schema_code, s.name AS schema_name, s.status::text AS schema_status \
         FROM regulatory_report_outputs o LEFT JOIN regulatory_report_schemas s ON s.id = o.schema_id \
         WHERE o.report_id = ANY($1::uuid[]) AND o.superseded_at IS NULL \
         ORDER BY o.report_id ASC, o.revision ASC, o.id ASC"
    } else {
        "SELECT o.id, o.report_id, o.revision, o.format::text AS format, o.schema_version, \
                o.validation_status::text AS validation_status, o.content_sha256, o.generated_at, o.submitted_at \
         FROM regulatory_report_outputs o \
         WHERE o.report_id = ANY($1::uuid[]) AND o.superseded_at IS NULL \
         ORDER BY o.report_id ASC, o.revision ASC, o.id ASC"
    };
    let rows = sqlx::query(AssertSqlSafe(sql))
        .bind(report_ids)
        .fetch_all(pool)
        .await
        .map_err(crate::routes::common::database_error)?;
    for row in &rows {
        let report_id: Uuid = get(row, "report_id")?;
        let output = if with_schema {
            OutputDb::from_row(row)?
        } else {
            OutputDb {
                id: get(row, "id")?,
                format: get(row, "format")?,
                revision: get(row, "revision")?,
                schema_id: None,
                schema_version: opt_get(row, "schema_version")?,
                validation_status: get(row, "validation_status")?,
                validation_errors: None,
                content_sha256: get(row, "content_sha256")?,
                generated_at: opt_get(row, "generated_at")?,
                submitted_at: opt_get(row, "submitted_at")?,
                content_ciphertext: None,
                storage_object_id: None,
                schema_code: None,
                schema_name: None,
                schema_status: None,
            }
        };
        grouped.entry(report_id).or_default().push(output);
    }
    Ok(grouped)
}

async fn load_case_briefs(
    pool: &PgPool,
    ids: &[Uuid],
) -> Result<HashMap<Uuid, view::AmlCaseBrief>, ApiError> {
    let mut result = HashMap::new();
    if ids.is_empty() {
        return Ok(result);
    }
    let rows = sqlx::query(
        "SELECT id, status::text AS status, severity::text AS severity, subject_id \
         FROM aml_cases WHERE id = ANY($1::uuid[])",
    )
    .bind(ids)
    .fetch_all(pool)
    .await
    .map_err(crate::routes::common::database_error)?;
    for row in &rows {
        result.insert(
            get::<Uuid>(row, "id")?,
            view::AmlCaseBrief {
                status: Some(get::<String>(row, "status")?),
                severity: Some(get::<String>(row, "severity")?),
                subject_id: Some(get::<String>(row, "subject_id")?),
            },
        );
    }
    Ok(result)
}

async fn load_approval_states(
    pool: &PgPool,
    ids: &[Uuid],
) -> Result<HashMap<Uuid, String>, ApiError> {
    let mut result = HashMap::new();
    if ids.is_empty() {
        return Ok(result);
    }
    let rows = sqlx::query(
        "SELECT id, state::text AS state FROM approval_requests WHERE id = ANY($1::uuid[])",
    )
    .bind(ids)
    .fetch_all(pool)
    .await
    .map_err(crate::routes::common::database_error)?;
    for row in &rows {
        result.insert(get::<Uuid>(row, "id")?, get::<String>(row, "state")?);
    }
    Ok(result)
}

async fn report_subject_names(
    pool: &PgPool,
    reports: &[ReportDb],
) -> Result<HashMap<String, String>, ApiError> {
    let rule_ids: Vec<Uuid> = reports
        .iter()
        .filter(|report| report.subject_type == "REPORTING_RULE")
        .filter_map(|report| Uuid::parse_str(&report.subject_id).ok())
        .collect();
    let incident_ids: Vec<Uuid> = reports
        .iter()
        .filter(|report| report.subject_type == "INCIDENT")
        .filter_map(|report| Uuid::parse_str(&report.subject_id).ok())
        .collect();
    let mut names = HashMap::new();
    if !rule_ids.is_empty() {
        let rows = sqlx::query(
            "SELECT id, source_reference, report_type::text AS report_type, status::text AS status \
             FROM reporting_rules WHERE id = ANY($1::uuid[])",
        )
        .bind(&rule_ids)
        .fetch_all(pool)
        .await
        .map_err(crate::routes::common::database_error)?;
        for row in &rows {
            let id: Uuid = get(row, "id")?;
            let name = opt_get::<String>(row, "source_reference")?.unwrap_or_else(|| {
                format!(
                    "{} · {}",
                    get::<String>(row, "report_type").unwrap_or_default(),
                    get::<String>(row, "status").unwrap_or_default()
                )
            });
            names.insert(id.to_string(), name);
        }
    }
    if !incident_ids.is_empty() {
        let rows =
            sqlx::query("SELECT id, reference, title FROM incidents WHERE id = ANY($1::uuid[])")
                .bind(&incident_ids)
                .fetch_all(pool)
                .await
                .map_err(crate::routes::common::database_error)?;
        for row in &rows {
            names.insert(
                get::<Uuid>(row, "id")?.to_string(),
                format!(
                    "{} · {}",
                    get::<String>(row, "reference")?,
                    get::<String>(row, "title")?
                ),
            );
        }
    }
    Ok(names)
}

fn shape_reports(
    reports: &[ReportDb],
    outputs: &HashMap<Uuid, Vec<OutputDb>>,
    cases: &HashMap<Uuid, view::AmlCaseBrief>,
    approvals: &HashMap<Uuid, String>,
    names: &HashMap<String, String>,
    now: DateTime<Utc>,
) -> Vec<Value> {
    reports
        .iter()
        .map(|report| {
            let output_rows: Vec<view::ReportOutputRow> = outputs
                .get(&report.id)
                .map(|rows| rows.iter().map(|row| row.shape(true)).collect())
                .unwrap_or_default();
            let case = report.aml_case_id.and_then(|id| cases.get(&id));
            let approval_state = report
                .approval_request_id
                .and_then(|id| approvals.get(&id))
                .map(String::as_str);
            let name = names.get(&report.subject_id).map(String::as_str);
            report_row(report, case, approval_state, &output_rows, name, now)
        })
        .collect()
}

async fn reports_list_impl(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<HttpResponse, ApiError> {
    let _actor = confidential(principal)?;
    let query = request_map(request);
    let (reports, total, built) = reports_page(state, &query, None).await?;
    let ids: Vec<Uuid> = reports.iter().map(|report| report.id).collect();
    let outputs = load_report_outputs(&state.pools.main, &ids, false).await?;
    let case_ids: Vec<Uuid> = reports
        .iter()
        .filter_map(|report| report.aml_case_id)
        .collect();
    let cases = load_case_briefs(&state.pools.main, &case_ids).await?;
    let approval_ids: Vec<Uuid> = reports
        .iter()
        .filter_map(|report| report.approval_request_id)
        .collect();
    let approvals = load_approval_states(&state.pools.main, &approval_ids).await?;
    let names = report_subject_names(&state.pools.main, &reports).await?;
    let shaped = shape_reports(&reports, &outputs, &cases, &approvals, &names, Utc::now());
    let source: Vec<Vec<pg_db::list_query::CursorValue>> = reports
        .iter()
        .map(|report| list::cursor_row(&built, Some(report.created_at), report.id))
        .collect();
    ok(envelope(
        "reports",
        Value::Array(shaped),
        total,
        &built,
        &source,
    ))
}

async fn reports_export_impl(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<HttpResponse, ApiError> {
    let actor = confidential(principal)?;
    let query = request_map(request);
    let checklist = checklist(
        &query,
        &[
            "REPORT_SCOPE_VERIFIED",
            "REPORT_DATA_REVIEWED",
            "EXPORT_AUTHORITY_CONFIRMED",
        ],
    );
    let (reports, total, _) = reports_page(state, &query, Some(5000)).await?;
    let ids: Vec<Uuid> = reports.iter().map(|report| report.id).collect();
    let outputs = load_report_outputs(&state.pools.main, &ids, false).await?;
    let case_ids: Vec<Uuid> = reports
        .iter()
        .filter_map(|report| report.aml_case_id)
        .collect();
    let cases = load_case_briefs(&state.pools.main, &case_ids).await?;
    let approval_ids: Vec<Uuid> = reports
        .iter()
        .filter_map(|report| report.approval_request_id)
        .collect();
    let approvals = load_approval_states(&state.pools.main, &approval_ids).await?;
    let names = report_subject_names(&state.pools.main, &reports).await?;
    let shaped = shape_reports(&reports, &outputs, &cases, &approvals, &names, Utc::now());
    let exported = shaped.len();
    write_audit(
        state,
        actor,
        &role_of(actor, "UNKNOWN"),
        "AML_REPORTS_EXPORTED",
        "REGULATORY_REPORT",
        "export",
        json!({}),
        json!({
            "total": total,
            "exported": exported,
            "filters": filters_json(&query),
            "checklist": checklist,
        }),
    )
    .await?;
    ok(json!({
        "reports": shaped,
        "total": total,
        "exported": exported,
        "truncated": total > exported as i64,
    }))
}

async fn build_report_summary(state: &AppState) -> Result<Value, ApiError> {
    let pool = &state.pools.main;
    let status_rows = sqlx::query(
        "SELECT status::text AS key, count(*) AS total FROM regulatory_reports GROUP BY status ORDER BY 1",
    )
    .fetch_all(pool)
    .await
    .map_err(crate::routes::common::database_error)?;
    let type_rows = sqlx::query(
        "SELECT report_type::text AS key, count(*) AS total FROM regulatory_reports GROUP BY report_type ORDER BY 1",
    )
    .fetch_all(pool)
    .await
    .map_err(crate::routes::common::database_error)?;
    let now = Utc::now();
    let month_start = now
        .date_naive()
        .with_day(1)
        .unwrap_or_else(|| now.date_naive())
        .and_hms_opt(0, 0, 0)
        .unwrap_or_else(|| now.naive_utc());
    let submitted_this_month: i64 =
        sqlx::query_scalar("SELECT count(*) FROM regulatory_reports WHERE submitted_at >= $1")
            .bind(month_start)
            .fetch_one(pool)
            .await
            .map_err(crate::routes::common::database_error)?;
    let total: i64 = sqlx::query_scalar("SELECT count(*) FROM regulatory_reports")
        .fetch_one(pool)
        .await
        .map_err(crate::routes::common::database_error)?;
    let mut by_status = Map::new();
    for row in &status_rows {
        by_status.insert(
            get::<String>(row, "key")?,
            Value::from(get::<i64>(row, "total")?),
        );
    }
    let mut by_type = Map::new();
    for row in &type_rows {
        by_type.insert(
            get::<String>(row, "key")?,
            Value::from(get::<i64>(row, "total")?),
        );
    }
    Ok(json!({
        "total": total,
        "byStatus": by_status,
        "byType": by_type,
        "submittedThisMonth": submitted_this_month,
        "pendingChecker": by_status.get("PENDING_CHECKER").and_then(Value::as_i64).unwrap_or(0),
        "drafts": by_status.get("DRAFT").and_then(Value::as_i64).unwrap_or(0),
        "acknowledged": by_status.get("ACKNOWLEDGED").and_then(Value::as_i64).unwrap_or(0),
        "rejected": by_status.get("REJECTED_BY_AUTHORITY").and_then(Value::as_i64).unwrap_or(0),
    }))
}

async fn reports_summary_impl(
    state: &AppState,
    _request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<HttpResponse, ApiError> {
    let _actor = confidential(principal)?;
    ok(build_report_summary(state).await?)
}

async fn reports_summary_export_impl(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<HttpResponse, ApiError> {
    let actor = confidential(principal)?;
    let summary = build_report_summary(state).await?;
    let query = request_map(request);
    let checklist = checklist(
        &query,
        &[
            "REPORT_SCOPE_VERIFIED",
            "STATUS_BREAKDOWN_REVIEWED",
            "SUBMISSION_DEADLINE_REVIEWED",
            "EXPORT_APPROVAL_CONFIRMED",
        ],
    );
    write_audit(
        state,
        actor,
        &role_of(actor, "UNKNOWN"),
        "AML_REPORT_SUMMARY_EXPORTED",
        "REGULATORY_REPORT",
        "summary",
        json!({}),
        json!({
            "total": summary.get("total").cloned().unwrap_or(Value::Null),
            "submittedThisMonth": summary.get("submittedThisMonth").cloned().unwrap_or(Value::Null),
            "pendingChecker": summary.get("pendingChecker").cloned().unwrap_or(Value::Null),
            "drafts": summary.get("drafts").cloned().unwrap_or(Value::Null),
            "checklist": checklist,
        }),
    )
    .await?;
    let mut map = summary.as_object().cloned().unwrap_or_default();
    map.insert("exportedAt".into(), Value::String(now_iso()));
    ok(Value::Object(map))
}

async fn report_detail_impl(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<HttpResponse, ApiError> {
    let _actor = confidential(principal)?;
    let id = uuid_from_tail(request, "/internal/admin/aml/reports/", 0)?;
    let row = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {} FROM regulatory_reports WHERE id = $1",
        view::REPORT_PROJECTION.join(", ")
    )))
    .bind(id)
    .fetch_optional(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?
    .ok_or_else(|| {
        not_found(
            "REGULATORY_REPORT_NOT_FOUND",
            "The regulatory report does not exist",
        )
    })?;
    let report = ReportDb::from_row(&row)?;
    let case_ids: Vec<Uuid> = report.aml_case_id.into_iter().collect();
    let cases = load_case_briefs(&state.pools.main, &case_ids).await?;
    let case = report.aml_case_id.and_then(|id| cases.get(&id).cloned());
    let approval_ids: Vec<Uuid> = report.approval_request_id.into_iter().collect();
    let approvals = load_approval_states(&state.pools.main, &approval_ids).await?;
    let approval_state = report
        .approval_request_id
        .and_then(|id| approvals.get(&id))
        .map(String::as_str);
    let outputs_by_report = load_report_outputs(&state.pools.main, &[report.id], true).await?;
    let outputs: Vec<view::ReportOutputRow> = outputs_by_report
        .get(&report.id)
        .map(|rows| rows.iter().map(|row| row.shape(false)).collect())
        .unwrap_or_default();
    let names = report_subject_names(&state.pools.main, std::slice::from_ref(&report)).await?;
    let name = names.get(&report.subject_id).map(String::as_str);
    let base = report_row(
        &report,
        case.as_ref(),
        approval_state,
        &outputs,
        name,
        Utc::now(),
    );
    let approval = match report.approval_request_id {
        None => Value::Null,
        Some(approval_id) => {
            let row = sqlx::query(
                "SELECT id, state::text AS state, maker_user_id, checker_user_id, rejection_reason, created_at \
                 FROM approval_requests WHERE id = $1",
            )
            .bind(approval_id)
            .fetch_optional(&state.pools.main)
            .await
            .map_err(crate::routes::common::database_error)?;
            match row {
                None => Value::Null,
                Some(row) => json!({
                    "id": get::<Uuid>(&row, "id")?,
                    "state": get::<String>(&row, "state")?,
                    "makerUserId": get::<Uuid>(&row, "maker_user_id")?,
                    "checkerUserId": opt_get::<Uuid>(&row, "checker_user_id")?,
                    "rejectionReason": opt_get::<String>(&row, "rejection_reason")?,
                    "createdAt": iso_naive(get::<NaiveDateTime>(&row, "created_at")?),
                }),
            }
        }
    };
    let aml_case = match report.aml_case_id {
        None => Value::Null,
        Some(case_id) => {
            let row = sqlx::query(
                "SELECT id, status::text AS status, severity::text AS severity, subject_type::text AS subject_type, \
                        subject_id, trigger_reason FROM aml_cases WHERE id = $1",
            )
            .bind(case_id)
            .fetch_optional(&state.pools.main)
            .await
            .map_err(crate::routes::common::database_error)?;
            match row {
                None => Value::Null,
                Some(row) => json!({
                    "id": get::<Uuid>(&row, "id")?,
                    "status": get::<String>(&row, "status")?,
                    "severity": get::<String>(&row, "severity")?,
                    "subjectType": get::<String>(&row, "subject_type")?,
                    "subjectId": get::<String>(&row, "subject_id")?,
                    "triggerReason": get::<String>(&row, "trigger_reason")?,
                }),
            }
        }
    };
    let mut map = base.as_object().cloned().unwrap_or_default();
    map.insert("approval".into(), approval);
    map.insert("amlCase".into(), aml_case);
    ok(json!({ "report": Value::Object(map) }))
}

async fn report_payload_impl(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<HttpResponse, ApiError> {
    let _actor = confidential(principal)?;
    let id = uuid_from_tail(request, "/internal/admin/aml/reports/", 0)?;
    let row = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {}, payload_ciphertext FROM regulatory_reports WHERE id = $1",
        view::REPORT_PROJECTION.join(", ")
    )))
    .bind(id)
    .fetch_optional(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?
    .ok_or_else(|| {
        not_found(
            "REGULATORY_REPORT_NOT_FOUND",
            "The regulatory report does not exist",
        )
    })?;
    let report = ReportDb::from_row(&row)?;
    let payload_ciphertext: String = get(&row, "payload_ciphertext")?;
    let payload = read_payload(Some(&payload_ciphertext))?;
    let outputs = load_report_outputs(&state.pools.main, &[report.id], true).await?;
    let outputs = outputs.get(&report.id).cloned().unwrap_or_default();
    let output_values: Vec<Value> = outputs
        .iter()
        .map(|output| {
            json!({
                "id": output.id,
                "format": output.format,
                "revision": output.revision,
                "schemaId": output.schema_id,
                "schemaVersion": output.schema_version,
                "validationStatus": output.validation_status,
                "validationErrors": output.validation_errors,
                "contentSha256": output.content_sha256,
                "generatedAt": output.generated_at.map(iso_naive),
                "submittedAt": output.submitted_at.map(iso_naive),
            })
        })
        .collect();
    let narrative = payload
        .get("narrative")
        .cloned()
        .unwrap_or_else(|| json!({}));
    ok(json!({
        "reportId": report.id,
        "payload": payload,
        "payloadSha256": report.payload_sha256,
        "requiredOutputFormats": report.required_output_formats,
        "narrative": narrative,
        "outputs": output_values,
    }))
}

async fn report_output_download_impl(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<HttpResponse, ApiError> {
    let actor = reporting_authority(principal)?;
    let segments = tail(request, "/internal/admin/aml/reports/")?;
    let id = uuid_param(segments.first().ok_or_else(ApiError::server_error)?)?;
    let format = match segments.get(2).map(String::as_str) {
        Some("XML") => "XML",
        Some("XLSX") => "XLSX",
        Some("DOCX") => "DOCX",
        _ => {
            return Err(ApiError::new(
                400,
                "INVALID_BODY",
                "format must be one of XML, XLSX or DOCX",
            ))
        }
    };
    let row = sqlx::query(
        "SELECT id, format::text AS format, revision, schema_id, schema_version, \
                validation_status::text AS validation_status, validation_errors_json, content_sha256, \
                generated_at, submitted_at, content_ciphertext, storage_object_id \
         FROM regulatory_report_outputs \
         WHERE report_id = $1 AND format::text = $2 AND superseded_at IS NULL \
         ORDER BY revision DESC LIMIT 1",
    )
    .bind(id)
    .bind(format)
    .fetch_optional(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?;
    let output = row
        .as_ref()
        .map(OutputDb::from_download_row)
        .transpose()?
        .ok_or_else(|| {
            not_found(
                "REPORT_OUTPUT_NOT_FOUND",
                "The requested report output does not exist",
            )
        })?;
    if output.validation_status == "NOT_GENERATED" {
        return Err(not_found(
            "REPORT_OUTPUT_NOT_FOUND",
            "The requested report output does not exist",
        ));
    }
    let content = if let Some(object_id) = output.storage_object_id {
        let request_id_value = request_id(request);
        read_authorized_object(
            &state.pools.main,
            Some(actor),
            object_id,
            "REG_REPORT_OUTPUT",
            &output.id.to_string(),
            crate::http::client_ip(request).as_deref(),
            request_id_value.as_deref(),
        )
        .await?
        .0
    } else if let Some(ciphertext) = output.content_ciphertext.as_deref() {
        let plain = view::decrypt_vault(ciphertext).map_err(|error| {
            tracing::error!(output = %output.id, error = %error, "report output could not be decrypted");
            ApiError::new(503, "REPORT_OUTPUT_UNAVAILABLE", "The stored report output cannot be read")
        })?;
        match format {
            "XML" => plain.into_bytes(),
            _ => base64_decode(&plain).ok_or_else(|| {
                ApiError::new(
                    503,
                    "REPORT_OUTPUT_UNAVAILABLE",
                    "The stored report output cannot be read",
                )
            })?,
        }
    } else {
        return Err(not_found(
            "REPORT_OUTPUT_CONTENT_MISSING",
            "The stored report output has no content",
        ));
    };
    let actual_hash = pg_crypto::sha256_hex(&content);
    if actual_hash != output.content_sha256 {
        return Err(ApiError::new(
            409,
            "REPORT_OUTPUT_HASH_MISMATCH",
            "The stored report output failed its integrity check",
        ));
    }
    write_audit(
        state,
        actor,
        &role_of(actor, "SYSTEM"),
        "REGULATORY_REPORT_OUTPUT_DOWNLOADED",
        "REGULATORY_REPORT_OUTPUT",
        &output.id.to_string(),
        json!({}),
        json!({ "reportId": id, "format": format, "sha256": output.content_sha256 }),
    )
    .await?;
    let hash_header = output.content_sha256.clone();
    match format {
        "XML" => Ok(HttpResponse::Ok()
            .content_type("application/xml; charset=utf-8")
            .header("X-Content-SHA256", hash_header)
            .body(content)),
        "DOCX" => Ok(HttpResponse::Ok()
            .content_type("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
            .header(
                "Content-Disposition",
                format!("attachment; filename=\"report-{id}.docx\""),
            )
            .header("X-Content-SHA256", hash_header)
            .body(content)),
        _ => Ok(HttpResponse::Ok()
            .content_type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
            .header(
                "Content-Disposition",
                format!("attachment; filename=\"report-{id}.xlsx\""),
            )
            .header("X-Content-SHA256", hash_header)
            .body(content)),
    }
}

/* ---------------------------------------------------------- filing adapters */

async fn filing_adapters_impl(
    state: &AppState,
    _request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<HttpResponse, ApiError> {
    let _actor = confidential(principal)?;
    let rows = sqlx::query(
        "SELECT id, name, authority, kind::text AS kind, status::text AS status, endpoint_url, \
                auth_header_name, auth_secret_ciphertext, timeout_seconds, config_json, last_used_at, \
                created_at, updated_at \
         FROM external_filing_adapters ORDER BY authority ASC, name ASC",
    )
    .fetch_all(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?;
    let mut adapters = Vec::with_capacity(rows.len());
    for row in &rows {
        adapters.push(FilingAdapterDb::from_row(row)?);
    }
    let mut pending = HashMap::new();
    if !adapters.is_empty() {
        let ids: Vec<Uuid> = adapters.iter().map(|adapter| adapter.id).collect();
        let rows = sqlx::query(
            "SELECT DISTINCT ON (subject_id) subject_id, id \
             FROM approval_requests \
             WHERE subject_type = 'FILING_ADAPTER' AND subject_id = ANY($1::text[]) \
               AND state IN ('DRAFT','PENDING_REVIEW') \
             ORDER BY subject_id, created_at DESC",
        )
        .bind(ids.iter().map(Uuid::to_string).collect::<Vec<_>>())
        .fetch_all(&state.pools.main)
        .await
        .map_err(crate::routes::common::database_error)?;
        for row in &rows {
            let subject: String = get(row, "subject_id")?;
            if let Ok(id) = Uuid::parse_str(&subject) {
                pending.insert(id, get::<Uuid>(row, "id")?);
            }
        }
    }
    let shaped: Vec<Value> = adapters
        .iter()
        .map(|adapter| {
            let mut map = filing_adapter_row(adapter)
                .as_object()
                .cloned()
                .unwrap_or_default();
            map.insert(
                "pendingApprovalId".into(),
                pending
                    .get(&adapter.id)
                    .map_or(Value::Null, |id| Value::String(id.to_string())),
            );
            Value::Object(map)
        })
        .collect();
    ok(json!({ "adapters": shaped }))
}

async fn report_submissions_impl(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<HttpResponse, ApiError> {
    let _actor = confidential(principal)?;
    let id = uuid_from_tail(request, "/internal/admin/aml/reports/", 0)?;
    let rows = sqlx::query(
        "SELECT s.id, s.created_at, s.updated_at, s.report_id, s.adapter_id, s.status::text AS status, \
                s.request_sha256, s.external_ref, s.response_code, s.response_body, s.submitted_at, s.error_message, \
                a.id AS a_id, a.name AS a_name, a.kind::text AS a_kind \
         FROM external_submissions s JOIN external_filing_adapters a ON a.id = s.adapter_id \
         WHERE s.report_id = $1 ORDER BY s.created_at DESC LIMIT 50",
    )
    .bind(id)
    .fetch_all(&state.pools.main)
    .await
    .map_err(crate::routes::common::database_error)?;
    let submissions: Vec<Value> = rows
        .iter()
        .map(|row| {
            let mut map = Map::new();
            map.insert(
                "id".into(),
                Value::String(get::<Uuid>(row, "id")?.to_string()),
            );
            map.insert(
                "createdAt".into(),
                Value::String(iso_naive(get::<NaiveDateTime>(row, "created_at")?)),
            );
            map.insert(
                "updatedAt".into(),
                Value::String(iso_naive(get::<NaiveDateTime>(row, "updated_at")?)),
            );
            map.insert(
                "reportId".into(),
                Value::String(get::<Uuid>(row, "report_id")?.to_string()),
            );
            map.insert(
                "adapterId".into(),
                Value::String(get::<Uuid>(row, "adapter_id")?.to_string()),
            );
            map.insert(
                "status".into(),
                Value::String(get::<String>(row, "status")?),
            );
            map.insert(
                "requestSha256".into(),
                Value::String(get::<String>(row, "request_sha256")?),
            );
            map.insert(
                "externalRef".into(),
                opt_get::<String>(row, "external_ref")?.map_or(Value::Null, Value::String),
            );
            map.insert(
                "responseCode".into(),
                opt_get::<i32>(row, "response_code")?.map_or(Value::Null, Value::from),
            );
            map.insert(
                "responseBody".into(),
                opt_get::<String>(row, "response_body")?.map_or(Value::Null, Value::String),
            );
            map.insert(
                "submittedAt".into(),
                opt_get::<NaiveDateTime>(row, "submitted_at")?
                    .map_or(Value::Null, |value| Value::String(iso_naive(value))),
            );
            map.insert(
                "errorMessage".into(),
                opt_get::<String>(row, "error_message")?.map_or(Value::Null, Value::String),
            );
            map.insert(
                "adapter".into(),
                json!({
                    "id": get::<Uuid>(row, "a_id")?,
                    "name": get::<String>(row, "a_name")?,
                    "kind": get::<String>(row, "a_kind")?,
                }),
            );
            Ok(Value::Object(map))
        })
        .collect::<Result<_, ApiError>>()?;
    ok(json!({ "submissions": submissions }))
}

/* ----------------------------------------------------------------- wrappers */

route_handler!(screenings_list, screenings_list_impl);
route_handler!(screenings_export, screenings_export_impl);
route_handler!(screenings_summary, screenings_summary_impl);
route_handler!(screenings_summary_export, screenings_summary_export_impl);
route_handler!(screening_detail, screening_detail_impl);
route_handler!(cases_list, cases_list_impl);
route_handler!(cases_export, cases_export_impl);
route_handler!(cases_summary, cases_summary_impl);
route_handler!(cases_summary_export, cases_summary_export_impl);
route_handler!(case_detail, case_detail_impl);
route_handler!(case_evidence, case_evidence_impl);
route_handler!(case_evidence_content, case_evidence_content_impl);
route_handler!(rules_list, rules_list_impl);
route_handler!(rules_export, rules_export_impl);
route_handler!(rules_summary, rules_summary_impl);
route_handler!(rules_summary_export, rules_summary_export_impl);
route_handler!(rule_detail, rule_detail_impl);
route_handler!(reporting_rules, reporting_rules_impl);
route_handler!(report_schemas, report_schemas_impl);
route_handler!(report_schema_detail, report_schema_detail_impl);
route_handler!(report_context_catalog, report_context_catalog_impl);
route_handler!(report_schema_template, report_schema_template_impl);
route_handler!(reporting_rule_bindings, reporting_rule_bindings_impl);
route_handler!(report_requirements, report_requirements_impl);
route_handler!(report_schema_defaults, report_schema_defaults_impl);
route_handler!(report_payload, report_payload_impl);
route_handler!(report_output_download, report_output_download_impl);
route_handler!(reports_list, reports_list_impl);
route_handler!(reports_export, reports_export_impl);
route_handler!(reports_summary, reports_summary_impl);
route_handler!(reports_summary_export, reports_summary_export_impl);
route_handler!(report_detail, report_detail_impl);
route_handler!(filing_adapters, filing_adapters_impl);
route_handler!(report_submissions, report_submissions_impl);

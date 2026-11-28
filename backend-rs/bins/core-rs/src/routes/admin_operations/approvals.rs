//! Admin approval-queue reads.
//!
//! Sources: `core-back/api/internal/admin.ts` (`/approvals`, `/approvals/:id`, the summaries and
//! exports) and `core-back/lib/approvalQueue.ts`.
//!
//! The domain filter, subject-type aliases (including the PascalCase/lowercase variants written by
//! older services), `expired` switch, list row shape and 24-hour/emergency summary counters follow
//! the TypeScript code. `subjectContext` covers the merchant/onboarding/finance/operations/security
//! subjects the console renders; an unmapped subject keeps the generic payload-diff view, exactly
//! like the TS `default` branch.

#![forbid(unsafe_code)]

use chrono::{Duration, Utc};
use ntex::web::types::Payload;
use ntex::web::{HttpRequest, HttpResponse};
use pg_db::{ColumnKind, ColumnMap, DateFilter, ListSpec, SortDirection};
use pg_domain_auth::Principal;
use serde_json::{json, Map, Value};

use pg_http::ApiError;

use crate::routes::common::json_ok;
use crate::routes::{Handler, HandlerFuture, MountedRoute, PrincipalGuard};
use crate::state::AppState;

use super::support::{
    age_hours, build_list, count_list, export_envelope, fetch_list, jsonb, list_envelope,
    query_string, require_confidential_aml, require_uuid_param, text, timestamp, ts_json,
    uuid_json,
};
use pg_http::{Authn, BodyRule, Channel, Policy};

const PENDING_STATES: &[&str] = &["DRAFT", "PENDING_REVIEW"];
const STATES: &[&str] = &[
    "DRAFT",
    "PENDING_REVIEW",
    "APPROVED",
    "EXECUTED",
    "REJECTED",
    "EXPIRED",
];
const MODES: &[&str] = &["STANDARD", "EMERGENCY_RATIFICATION"];

/// `APPROVAL_DOMAIN_SUBJECT_TYPES`, in the same order.
const DOMAIN_SUBJECTS: &[(&str, &[&str])] = &[
    ("ONBOARDING", &["JOIN_REQUEST", "KYB_DOCUMENT"]),
    (
        "MERCHANT",
        &["MERCHANT", "APPLICATION", "WALLET", "POS_TERMINAL"],
    ),
    (
        "FINANCE",
        &[
            "ADJUSTMENT",
            "CASHOUT_REQUEST",
            "COMMISSION_PROFILE",
            "VELOCITY_RULE",
            "GL_SHARD_REPAIR",
        ],
    ),
    (
        "COMPLIANCE",
        &[
            "AML_CASE",
            "AML_RULE",
            "REPORTING_RULE",
            "REPORTING_RULE_SCHEMA_BINDING",
            "REGULATORY_REPORT",
            "REGULATORY_REPORT_SCHEMA",
            "FILING_ADAPTER",
        ],
    ),
    ("OPERATIONS", &["OPERATOR_CASE"]),
    (
        "GATEWAY",
        &[
            "GATEWAY_VERSION",
            "GATEWAY",
            "CREDENTIAL_SET",
            "ROUTE_HEALTH_OVERRIDE",
        ],
    ),
    ("SECURITY", &["USER", "BACKUP_POLICY", "STORAGE_LEGAL_HOLD"]),
    ("SETTINGS", &["PLATFORM_SETTING"]),
];

/// Routes owned by this module.
#[must_use]
pub fn routes() -> Vec<MountedRoute> {
    vec![
        route(
            "/internal/admin/approvals",
            "core-back/api/internal/admin.ts:6892",
            &["approval:read"],
            list_handler,
        ),
        route(
            "/internal/admin/approvals/export",
            "core-back/api/internal/admin.ts:6951",
            &["approval:read"],
            export_handler,
        ),
        route(
            "/internal/admin/approvals/summary",
            "core-back/api/internal/admin.ts:7070",
            &["approval:read"],
            summary_handler,
        ),
        route(
            "/internal/admin/approvals/summary/export",
            "core-back/api/internal/admin.ts:7075",
            &["approval:read"],
            summary_export_handler,
        ),
        route(
            "/internal/admin/approvals/:id",
            "core-back/api/internal/admin.ts:7110",
            &["approval:read"],
            detail_handler,
        ),
    ]
}

fn route(
    path: &str,
    origin: &str,
    authorities: &[&str],
    handler: crate::routes::CustomHandler,
) -> MountedRoute {
    MountedRoute {
        policy: Policy::new("GET", path, Channel::Admin, Authn::Session, origin)
            .authorities(authorities)
            .body(BodyRule::None),
        handler: Handler::Custom(handler),
        guard: PrincipalGuard::Staff,
    }
}

// ---------------------------------------------------------------- aliases

/// `normalizeApprovalSubjectType` with the alias table from `approvalQueue.ts`.
#[must_use]
pub fn normalize_subject_type(value: &str) -> String {
    let normalized: String = value
        .trim()
        .chars()
        .map(|character| match character {
            ' ' | '-' => '_',
            other => other.to_ascii_uppercase(),
        })
        .collect();
    let flat = normalized.replace('_', "");
    let alias = match flat.as_str() {
        "JOINREQUEST" => Some("JOIN_REQUEST"),
        "KYBDOCUMENT" => Some("KYB_DOCUMENT"),
        "OPERATORCASE" => Some("OPERATOR_CASE"),
        "GATEWAYVERSION" => Some("GATEWAY_VERSION"),
        "AMLCASE" => Some("AML_CASE"),
        "AMLRULE" => Some("AML_RULE"),
        "REPORTINGRULE" => Some("REPORTING_RULE"),
        "REGULATORYREPORT" => Some("REGULATORY_REPORT"),
        "REGULATORYREPORTSCHEMA" => Some("REGULATORY_REPORT_SCHEMA"),
        "REPORTINGRULESCHEMABINDING" => Some("REPORTING_RULE_SCHEMA_BINDING"),
        "FILINGADAPTER" => Some("FILING_ADAPTER"),
        "PLATFORMSETTING" => Some("PLATFORM_SETTING"),
        "COMMISSIONPROFILE" => Some("COMMISSION_PROFILE"),
        "VELOCITYRULE" => Some("VELOCITY_RULE"),
        "CASHOUTREQUEST" => Some("CASHOUT_REQUEST"),
        "CREDENTIALSET" => Some("CREDENTIAL_SET"),
        "POSTERMINAL" => Some("POS_TERMINAL"),
        _ => None,
    };
    alias.unwrap_or(&normalized).to_owned()
}

fn pascal_case(normalized: &str) -> String {
    normalized
        .to_lowercase()
        .split('_')
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect()
}

/// `approvalSubjectTypeVariants`.
#[must_use]
pub fn subject_type_variants(value: &str) -> Vec<String> {
    let normalized = normalize_subject_type(value);
    if normalized.is_empty() {
        return Vec::new();
    }
    vec![
        normalized.clone(),
        pascal_case(&normalized),
        normalized.to_lowercase(),
    ]
}

/// `approvalDomain`.
#[must_use]
pub fn domain_of(subject_type: &str) -> String {
    let normalized = normalize_subject_type(subject_type);
    for (domain, subjects) in DOMAIN_SUBJECTS {
        if subjects.contains(&normalized.as_str()) {
            return (*domain).to_owned();
        }
    }
    "OTHER".to_owned()
}

/// `approvalChangeKind`.
fn change_kind(subject_type: &str, payload: &Value) -> String {
    match payload {
        Value::Array(_) => return "FIELD_EDIT".to_owned(),
        Value::Object(record) => {
            for key in ["kind", "type", "action", "decision"] {
                if let Some(Value::String(value)) = record.get(key) {
                    return value.to_ascii_uppercase();
                }
            }
            if record.get("patch").is_some_and(Value::is_array)
                || (record.get("field").is_some()
                    && (record.get("from").is_some() || record.get("to").is_some()))
            {
                return "FIELD_EDIT".to_owned();
            }
        }
        _ => {}
    }
    if normalize_subject_type(subject_type) == "MERCHANT" {
        "EDIT".to_owned()
    } else {
        "CHANGE".to_owned()
    }
}

fn expires_in_hours(value: Option<chrono::NaiveDateTime>, now: chrono::DateTime<Utc>) -> Value {
    value.map_or(Value::Null, |value| {
        let millis = (value - now.naive_utc()).num_milliseconds();
        let hours = (millis as f64 / 3_600_000.0).ceil();
        Value::from(hours as i64)
    })
}

// ---------------------------------------------------------------- list

fn columns() -> ColumnMap {
    ColumnMap::new()
        .with("id", "ar.id", ColumnKind::Uuid)
        .with("createdAt", "ar.created_at", ColumnKind::Timestamp)
        .with("updatedAt", "ar.updated_at", ColumnKind::Timestamp)
        .with("expiresAt", "ar.expires_at", ColumnKind::Timestamp)
        .with("state", "ar.state::text", ColumnKind::Text)
        .with("mode", "ar.mode::text", ColumnKind::Text)
        .with("subjectType", "ar.subject_type", ColumnKind::Text)
        .with("subjectId", "ar.subject_id", ColumnKind::Text)
        .with("subjectTypeFilter", "ar.subject_type", ColumnKind::Text)
        .with("makerUserId", "ar.maker_user_id", ColumnKind::Uuid)
        .with("checkerUserId", "ar.checker_user_id", ColumnKind::Uuid)
        .with("makerEmail", "maker.email", ColumnKind::Text)
        .with("checkerEmail", "checker.email", ColumnKind::Text)
}

fn spec() -> ListSpec {
    ListSpec::default()
        .with_search(&["subjectId", "subjectType", "makerEmail", "checkerEmail"])
        .with_in("state", "state")
        .with_in("mode", "mode")
        .with_equals("makerUserId", "makerUserId")
        .with_equals("checkerUserId", "checkerUserId")
        .with_date(DateFilter::new("createdAt", "createdAt"))
        .with_date(DateFilter::new("expiresAt", "expiresAt").with_keys("expiresFrom", "expiresTo"))
        .with_sortable("subjectType", "subjectType")
        .with_sortable("subjectId", "subjectId")
        .with_sortable("state", "state")
        .with_sortable("mode", "mode")
        .with_sortable("createdAt", "createdAt")
        .with_sortable("expiresAt", "expiresAt")
        .with_default_sort("createdAt", SortDirection::Desc)
        .with_default_page_size(20.0)
}

const FROM: &str = "approval_requests ar
    LEFT JOIN users maker ON maker.id = ar.maker_user_id
    LEFT JOIN users checker ON checker.id = ar.checker_user_id";

const PROJECTION: &str = "ar.id, ar.created_at, ar.updated_at, ar.subject_type, ar.subject_id,
    ar.state::text AS state, ar.mode::text AS mode, ar.base_version, ar.payload_diff_json,
    ar.maker_user_id, ar.checker_user_id, ar.maker_reason, ar.rejection_reason,
    ar.risk_acceptance_note, ar.expires_at, ar.ratify_due_at,
    maker.email AS maker_email, checker.email AS checker_email";

fn validate_filters(request: &HttpRequest) -> Result<(), ApiError> {
    for (key, allowed) in [("state", STATES), ("mode", MODES)] {
        if let Some(raw) = query_string(request, key) {
            let invalid = raw
                .split(',')
                .map(str::trim)
                .filter(|entry| !entry.is_empty())
                .find(|entry| !allowed.contains(entry));
            if let Some(invalid) = invalid {
                return Err(ApiError::new(
                    400,
                    "INVALID_FILTER",
                    format!("The '{key}' filter value '{invalid}' is invalid"),
                )
                .with_details(json!({ "allowed": allowed })));
            }
        }
    }
    Ok(())
}

fn approval_extra(
    request: &HttpRequest,
    built: &pg_db::BuiltListQuery,
) -> Result<super::support::ExtraFilter, ApiError> {
    use super::support::{ExtraBind, ExtraFilter};
    let mut conditions: Vec<String> = Vec::new();
    let mut binds: Vec<ExtraBind> = Vec::new();
    let mut start = built.binds.len() + 1;
    if let Some(raw) = query_string(request, "subjectType") {
        let values: Vec<String> = raw
            .split(',')
            .map(str::trim)
            .filter(|entry| !entry.is_empty())
            .flat_map(subject_type_variants)
            .collect();
        if !values.is_empty() {
            conditions.push(format!("ar.subject_type::text = ANY(${start}::text[])"));
            binds.push(ExtraBind::Texts(values));
            start += 1;
        }
    }
    if let Some(domain) = query_string(request, "domain") {
        let domain = domain.to_ascii_uppercase();
        if let Some((_, subjects)) = DOMAIN_SUBJECTS.iter().find(|(name, _)| *name == domain) {
            let values: Vec<String> = subjects
                .iter()
                .flat_map(|value| subject_type_variants(value))
                .collect();
            conditions.push(format!("ar.subject_type::text = ANY(${start}::text[])"));
            binds.push(ExtraBind::Texts(values));
            start += 1;
        }
    }
    match query_string(request, "expired").as_deref() {
        Some("true") => conditions.push("ar.expires_at < now()".to_owned()),
        Some("false") => {
            conditions.push("(ar.expires_at IS NULL OR ar.expires_at >= now())".to_owned())
        }
        _ => {}
    }
    let _ = start;
    Ok(ExtraFilter {
        sql: conditions.join(" AND "),
        binds,
    })
}

fn row(approval: &sqlx::postgres::PgRow) -> Value {
    let now = Utc::now();
    let subject_type = normalize_subject_type(&text(approval, "subject_type"));
    let payload = jsonb(approval, "payload_diff_json");
    let expires_at = timestamp(approval, "expires_at");
    json!({
        "id": uuid_json(approval, "id"),
        "subjectType": subject_type,
        "subjectId": text(approval, "subject_id"),
        "domain": domain_of(&text(approval, "subject_type")),
        "kind": change_kind(&subject_type, &payload),
        "state": text(approval, "state"),
        "mode": text(approval, "mode"),
        "baseVersion": super::support::int_json(approval, "base_version"),
        "makerUserId": uuid_json(approval, "maker_user_id"),
        "makerName": super::support::opt_text(approval, "maker_email").unwrap_or_default(),
        "checkerName": super::support::opt_text(approval, "checker_email").unwrap_or_default(),
        "makerReason": super::support::text_value(approval, "maker_reason"),
        "rejectionReason": super::support::text_value(approval, "rejection_reason"),
        "riskAcceptanceNote": super::support::text_value(approval, "risk_acceptance_note"),
        "payloadDiff": payload,
        "createdAt": ts_json(approval, "created_at"),
        "updatedAt": ts_json(approval, "updated_at"),
        "expiresAt": ts_json(approval, "expires_at"),
        "ratifyDueAt": ts_json(approval, "ratify_due_at"),
        "expired": expires_at.is_some_and(|value| value < now.naive_utc()),
        "ageHours": age_hours(timestamp(approval, "created_at"), now),
        "expiresInHours": expires_in_hours(expires_at, now),
    })
}

async fn list(
    state: &AppState,
    request: &HttpRequest,
    _principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    validate_filters(request)?;
    let built = build_list(request, &spec(), &columns())?;
    let extra = approval_extra(request, &built)?;
    let rows = fetch_list(&state.pools.main, &built, PROJECTION, FROM, Some(&extra)).await?;
    let total = count_list(&state.pools.main, &built, FROM, Some(&extra)).await?;
    let items: Vec<Value> = rows.iter().map(row).collect();
    let response = list_envelope("approvals", Value::Array(items), total, &built);
    Ok(super::support::with_cursor(
        response,
        &built,
        &rows,
        "created_at",
    ))
}

async fn export(
    state: &AppState,
    request: &HttpRequest,
    _principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    validate_filters(request)?;
    let built = build_list(request, &spec(), &columns())?;
    let extra = approval_extra(request, &built)?;
    let mut where_sql = built.where_sql.clone();
    if !extra.sql.trim().is_empty() {
        where_sql = if where_sql.is_empty() {
            format!("WHERE {}", extra.sql)
        } else {
            format!("{where_sql} AND {}", extra.sql)
        };
    }
    let sql = format!(
        "SELECT {PROJECTION} FROM {FROM} {where_sql} ORDER BY {} LIMIT 5000",
        built.order_by_sql
    );
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql));
    for bind in &built.binds {
        query = match bind {
            pg_db::SqlBind::Text(value) => query.bind(value.as_str()),
            pg_db::SqlBind::Bool(value) => query.bind(*value),
        };
    }
    for bind in &extra.binds {
        query = match bind {
            super::support::ExtraBind::Text(value) => query.bind(value.as_str()),
            super::support::ExtraBind::Texts(values) => query.bind(values.clone()),
        };
    }
    let rows = query
        .fetch_all(&state.pools.main)
        .await
        .map_err(super::support::database_error)?;
    let total = count_list(&state.pools.main, &built, FROM, Some(&extra))
        .await?
        .unwrap_or(0);
    let items: Vec<Value> = rows.iter().map(row).collect();
    Ok(export_envelope(
        "approvals",
        Value::Array(items),
        total,
        rows.len(),
    ))
}

// ---------------------------------------------------------------- summary

async fn summary_value(state: &AppState) -> Result<Value, ApiError> {
    let rows = sqlx::query(
        "SELECT subject_type, state::text AS state, mode::text AS mode, created_at, expires_at, ratify_due_at
         FROM approval_requests WHERE state::text = ANY($1::text[])",
    )
    .bind(PENDING_STATES)
    .fetch_all(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let now = Utc::now().naive_utc();
    let soon = now + Duration::hours(24);
    let mut by_state: std::collections::BTreeMap<String, i64> = std::collections::BTreeMap::new();
    let mut by_subject: std::collections::BTreeMap<String, i64> = std::collections::BTreeMap::new();
    let mut by_domain: std::collections::BTreeMap<String, i64> = std::collections::BTreeMap::new();
    let mut expired = 0i64;
    let mut expiring_soon = 0i64;
    let mut emergency_due = 0i64;
    let mut oldest_age = 0i64;
    for row in &rows {
        *by_state.entry(text(row, "state")).or_insert(0) += 1;
        let subject = normalize_subject_type(&text(row, "subject_type"));
        *by_subject.entry(subject.clone()).or_insert(0) += 1;
        *by_domain.entry(domain_of(&subject)).or_insert(0) += 1;
        let age = age_hours(timestamp(row, "created_at"), Utc::now());
        oldest_age = oldest_age.max(age);
        if let Some(expires) = timestamp(row, "expires_at") {
            if expires < now {
                expired += 1;
            } else if expires <= soon {
                expiring_soon += 1;
            }
        }
        if text(row, "mode") == "EMERGENCY_RATIFICATION"
            && timestamp(row, "ratify_due_at").is_some_and(|due| due <= now)
        {
            emergency_due += 1;
        }
    }
    let by_state: Map<String, Value> = by_state
        .into_iter()
        .map(|(key, value)| (key, Value::from(value)))
        .collect();
    let mut subjects: Vec<(String, i64)> = by_subject.into_iter().collect();
    subjects.sort_by_key(|entry| std::cmp::Reverse(entry.1));
    let mut domains: Vec<(String, i64)> = by_domain.into_iter().collect();
    domains.sort_by_key(|entry| std::cmp::Reverse(entry.1));
    Ok(json!({
        "totalPending": rows.len(),
        "byState": by_state,
        "bySubjectType": subjects.into_iter().map(|(subject_type, count)| json!({"subjectType": subject_type, "count": count})).collect::<Vec<_>>(),
        "byDomain": domains.into_iter().map(|(domain, count)| json!({"domain": domain, "count": count})).collect::<Vec<_>>(),
        "expired": expired,
        "expiringSoon": expiring_soon,
        "emergencyDue": emergency_due,
        "oldestAgeHours": oldest_age,
    }))
}

// ---------------------------------------------------------------- detail

fn check_blocked_reason(
    approval: &sqlx::postgres::PgRow,
    principal: Option<&Principal>,
    join_request_admin_maker: bool,
) -> Option<String> {
    let state = text(approval, "state");
    if !PENDING_STATES.contains(&state.as_str()) {
        return Some("APPROVAL_NOT_PENDING".to_owned());
    }
    let actor = principal
        .and_then(|principal| principal.user_id.clone())
        .unwrap_or_default();
    if text(approval, "maker_user_id") == actor {
        return Some("MAKER_CANNOT_CHECK".to_owned());
    }
    let subject = normalize_subject_type(&text(approval, "subject_type"));
    let role = principal
        .and_then(|principal| principal.role.clone())
        .unwrap_or_default();
    if subject == "JOIN_REQUEST" && join_request_admin_maker {
        return Some("ADMIN_ASSISTED_MAKER_CANNOT_CHECK".to_owned());
    }
    if subject == "MERCHANT" && role == "SUPPORT" {
        return Some("MERCHANT_CHECKER_DOMAIN_FORBIDDEN".to_owned());
    }
    if subject == "ADJUSTMENT" && role != "FINANCE" {
        return Some("ADJUSTMENT_CHECKER_DOMAIN_FORBIDDEN".to_owned());
    }
    if subject == "ROUTE_HEALTH_OVERRIDE"
        && !principal.is_some_and(|principal| {
            principal
                .authorities
                .iter()
                .any(|authority| authority == "*" || authority == "gateway:write")
        })
    {
        return Some("ROUTE_HEALTH_CHECKER_AUTHORITY_REQUIRED".to_owned());
    }
    None
}

async fn subject_context(
    state: &AppState,
    subject_type: &str,
    subject_id: &str,
) -> Result<Value, ApiError> {
    let subject = normalize_subject_type(subject_type);
    let sql = match subject.as_str() {
        "MERCHANT" => Some(
            "SELECT jsonb_build_object('contextType','MERCHANT','id',id,'legalName',legal_name,
                    'tradeName',trade_name,'displayName',display_name,'status',status::text,
                    'kybStatus',kyb_status::text,'riskTier',risk_tier::text) AS data
             FROM merchants WHERE id = $1",
        ),
        "JOIN_REQUEST" => Some(
            "SELECT jsonb_build_object('contextType','JOIN_REQUEST','id',jr.id,'status',jr.status::text,
                    'onboardingChannel',jr.onboarding_channel::text,'proposedRiskTier',jr.proposed_risk_tier::text,
                    'submittedAt',to_char(jr.submitted_at,'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
                    'slaDueAt',to_char(jr.sla_due_at,'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
                    'decision',jr.decision,
                    'merchant',jsonb_build_object('id',m.id,'tradeName',m.trade_name,'legalName',m.legal_name)) AS data
             FROM join_requests jr JOIN merchants m ON m.id = jr.merchant_id WHERE jr.id = $1",
        ),
        "ADJUSTMENT" => Some(
            "SELECT jsonb_build_object('kind','ADJUSTMENT','id',a.id,'type',a.type::text,
                    'amount',to_char(a.amount,'FM999999999999990.0000'),'state',a.state::text,
                    'reason',a.reason,'sourceAttemptId',a.source_attempt_id,'disputeId',a.dispute_id,
                    'targetGlAccount',jsonb_build_object('currency',ga.currency,'accountType',ga.account_type::text,
                        'ownerId',ga.owner_id)) AS data
             FROM adjustments a JOIN gl_accounts ga ON ga.id = a.target_gl_account_id WHERE a.id = $1",
        ),
        "OPERATOR_CASE" => Some(
            "SELECT jsonb_build_object('contextType','OPERATOR_CASE','id',oc.id,'kind',oc.kind::text,
                    'priority',oc.priority::text,'state',oc.state::text,
                    'slaDueAt',to_char(oc.sla_due_at,'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
                    'attemptId',oc.attempt_id,
                    'attempt',CASE WHEN pa.id IS NULL THEN NULL ELSE
                        jsonb_build_object('reference',pa.reference,'status',pa.status::text) END) AS data
             FROM operator_cases oc LEFT JOIN payment_attempts pa ON pa.id = oc.attempt_id WHERE oc.id = $1",
        ),
        "WALLET" => Some(
            "SELECT jsonb_build_object('contextType','WALLET','id',w.id,'merchantId',w.merchant_id,
                    'currency',w.currency,'status',w.status::text,'glAccountId',w.gl_account_id,'name',w.name,
                    'merchant',jsonb_build_object('id',m.id,'tradeName',m.trade_name,'legalName',m.legal_name,
                        'status',m.status::text)) AS data
             FROM wallets w JOIN merchants m ON m.id = w.merchant_id WHERE w.id = $1",
        ),
        "APPLICATION" => Some(
            "SELECT jsonb_build_object('contextType','APPLICATION','id',ap.id,'name',ap.name,
                    'merchantId',ap.merchant_id,'status',ap.status::text,'assignedWalletId',ap.assigned_wallet_id,
                    'expectedMonthlyVolume',ap.expected_monthly_volume,
                    'merchant',jsonb_build_object('id',m.id,'tradeName',m.trade_name,'legalName',m.legal_name,
                        'status',m.status::text)) AS data
             FROM applications ap JOIN merchants m ON m.id = ap.merchant_id WHERE ap.id = $1",
        ),
        "POS_TERMINAL" => Some(
            "SELECT jsonb_build_object('contextType','POS_TERMINAL','id',pt.id,'name',pt.name,
                    'location',pt.location,'status',pt.status::text,'applicationId',pt.application_id,
                    'application',jsonb_build_object('id',ap.id,'name',ap.name,'merchantId',ap.merchant_id,
                        'merchant',jsonb_build_object('id',m.id,'tradeName',m.trade_name,'legalName',m.legal_name))) AS data
             FROM pos_terminals pt JOIN applications ap ON ap.id = pt.application_id
             JOIN merchants m ON m.id = ap.merchant_id WHERE pt.id = $1",
        ),
        "GATEWAY_VERSION" => Some(
            "SELECT jsonb_build_object('contextType','GATEWAY_VERSION','id',gv.id,'versionNumber',gv.version_number,
                    'state',gv.state::text,'gatewayId',gv.gateway_id,
                    'gateway',jsonb_build_object('code',g.code,'name',g.name)) AS data
             FROM gateway_versions gv JOIN gateways g ON g.id = gv.gateway_id WHERE gv.id = $1",
        ),
        "COMMISSION_PROFILE" => Some(
            "SELECT jsonb_build_object('contextType','COMMISSION_PROFILE','id',cp.id,'railCode',cp.rail_code,
                    'calcType',cp.calc_type::text,'flatFee',to_char(cp.flat_fee,'FM999999999999990.0000'),
                    'percentageRate',to_char(cp.percentage_rate,'FM999999999999990.000000'),
                    'feeBearerDefault',cp.fee_bearer_default::text,
                    'merchantId',cp.merchant_id,'applicationId',cp.application_id,'version',cp.version) AS data
             FROM commission_profiles cp WHERE cp.id = $1",
        ),
        "VELOCITY_RULE" => Some(
            "SELECT jsonb_build_object('contextType','VELOCITY_RULE','id',v.id,'scopeType',v.scope_type::text,
                    'scopeValue',v.scope_value,'windowSeconds',v.window_seconds,'maxCount',v.max_count,
                    'maxAmount',to_char(v.max_amount,'FM999999999999990.0000'),'action',v.action::text,
                    'active',v.active,'version',v.version) AS data
             FROM velocity_rules v WHERE v.id = $1",
        ),
        "USER" => Some(
            "SELECT jsonb_build_object('contextType','USER','id',u.id,'email',u.email,'role',u.role::text,
                    'status',u.status::text,'isMaker',u.is_maker,'isChecker',u.is_checker,
                    'phone',u.phone,'invitedById',u.invited_by) AS data
             FROM users u WHERE u.id = $1",
        ),
        "ROUTE_HEALTH_OVERRIDE" => Some(
            "SELECT jsonb_build_object('contextType','ROUTE_HEALTH_OVERRIDE','id',rr.id,
                    'healthState',rr.health_state::text,'healthComputedState',rr.health_computed_state::text,
                    'healthComputedReason',rr.health_computed_reason,
                    'healthOverrideState',rr.health_override_state::text,
                    'healthOverrideReason',rr.health_override_reason,
                    'healthOverrideExpiresAt',to_char(rr.health_override_expires_at,'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
                    'rail',jsonb_build_object('code',r.code,'nameEn',r.name_en),
                    'gateway',jsonb_build_object('code',g.code,'name',g.name)) AS data
             FROM rail_routes rr JOIN rails r ON r.id = rr.rail_id JOIN gateways g ON g.id = rr.gateway_id
             WHERE rr.id = $1",
        ),
        "AML_CASE" => Some(
            "SELECT jsonb_build_object('contextType','AML_CASE','id',ac.id,'status',ac.status::text,
                    'severity',ac.severity::text,'triggerReason',ac.trigger_reason,
                    'slaDueAt',to_char(ac.sla_due_at,'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
                    'subjectType',ac.subject_type::text,'subjectId',ac.subject_id) AS data
             FROM aml_cases ac WHERE ac.id = $1",
        ),
        _ => None,
    };
    let Some(sql) = sql else {
        return Ok(Value::Null);
    };
    let row = sqlx::query(sql)
        .bind(super::support::uuid_bind(subject_id))
        .fetch_optional(&state.pools.main)
        .await
        .map_err(super::support::database_error)?;
    Ok(row.map_or(Value::Null, |row| jsonb(&row, "data")))
}

pub(super) async fn detail(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let id = require_uuid_param(
        super::support::last_path_segment(request).as_deref(),
        "APPROVAL_REQUEST_NOT_FOUND",
        "The approval request does not exist",
    )?;
    let Some(approval) = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {PROJECTION} FROM {FROM} WHERE ar.id = $1"
    )))
    .bind(super::support::uuid_bind(&id))
    .fetch_optional(&state.pools.main)
    .await
    .map_err(super::support::database_error)?
    else {
        return Err(ApiError::new(
            404,
            "APPROVAL_REQUEST_NOT_FOUND",
            "The approval request does not exist",
        ));
    };
    let subject_type = text(&approval, "subject_type");
    if normalize_subject_type(&subject_type) == "AML_CASE" {
        require_confidential_aml(principal)?;
    }
    let subject_id = text(&approval, "subject_id");
    let context = subject_context(state, &subject_type, &subject_id).await?;
    let join_request_admin_maker = if normalize_subject_type(&subject_type) == "JOIN_REQUEST" {
        sqlx::query(
            "SELECT onboarding_channel::text AS channel, submitted_by_user_id
             FROM join_requests WHERE id = $1",
        )
        .bind(super::support::uuid_bind(&subject_id))
        .fetch_optional(&state.pools.main)
        .await
        .map_err(super::support::database_error)?
        .is_some_and(|join| {
            text(&join, "channel") == "ADMIN_ASSISTED"
                && principal
                    .and_then(|principal| principal.user_id.as_deref())
                    .is_some_and(|user| uuid_json(&join, "submitted_by_user_id") == user)
        })
    } else {
        false
    };
    let blocked = check_blocked_reason(&approval, principal, join_request_admin_maker);
    let expired =
        timestamp(&approval, "expires_at").is_some_and(|value| value < Utc::now().naive_utc());
    let mut object = row(&approval);
    if let Some(map) = object.as_object_mut() {
        map.insert(
            "payloadDiff".to_owned(),
            jsonb(&approval, "payload_diff_json"),
        );
        map.insert(
            "makerReason".to_owned(),
            super::support::text_value(&approval, "maker_reason"),
        );
        map.insert(
            "rejectionReason".to_owned(),
            super::support::text_value(&approval, "rejection_reason"),
        );
        map.insert(
            "riskAcceptanceNote".to_owned(),
            super::support::text_value(&approval, "risk_acceptance_note"),
        );
        map.insert("subjectContext".to_owned(), context);
        map.insert("canCheck".to_owned(), Value::Bool(blocked.is_none()));
        map.insert(
            "checkBlockedReason".to_owned(),
            blocked.clone().map_or(Value::Null, Value::String),
        );
        map.insert(
            "canApprove".to_owned(),
            Value::Bool(blocked.is_none() && !expired),
        );
    }
    Ok(json!({ "approval": object }))
}

// ---------------------------------------------------------------- exports/summary handlers

fn list_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move { result_response(request, list(state, request, principal).await) })
}

fn export_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move { result_response(request, export(state, request, principal).await) })
}

fn summary_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    _principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move { result_response(request, summary_value(state).await) })
}

fn summary_export_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    _principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = summary_value(state).await.map(|mut value| {
            if let Some(object) = value.as_object_mut() {
                object.insert(
                    "exportedAt".to_owned(),
                    super::support::iso_required(Utc::now()),
                );
            }
            value
        });
        result_response(request, result)
    })
}

fn detail_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move { result_response(request, detail(state, request, principal).await) })
}

fn result_response(request: &HttpRequest, result: Result<Value, ApiError>) -> HttpResponse {
    match result {
        Ok(value) => json_ok(&value),
        Err(error) => crate::http::error_response(request, error),
    }
}

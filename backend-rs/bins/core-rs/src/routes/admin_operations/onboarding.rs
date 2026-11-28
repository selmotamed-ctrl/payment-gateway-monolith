//! Admin onboarding reads: join requests and KYB documents.
//!
//! Sources: `core-back/api/internal/admin.ts` (`/join-requests*`, `/kyb-documents*`). Lists apply
//! the same search/status/risk/reviewer/date filters, the draft-evidence exclusion, duplicate and
//! expiring switches and the 5,000-row export envelope. Changes to KYB bytes are never performed;
//! the document-content download needs the shared vault and stays in P4-T05.

#![forbid(unsafe_code)]

use chrono::{NaiveDate, Utc};
use ntex::web::types::Payload;
use ntex::web::{HttpRequest, HttpResponse};
use pg_db::{ColumnKind, ColumnMap, DateFilter, ListSpec, SortDirection};
use pg_domain_auth::Principal;
use serde_json::{json, Map, Value};
use sqlx::Row;

use pg_http::ApiError;

use crate::routes::common::json_ok;
use crate::routes::{Handler, HandlerFuture, MountedRoute, PrincipalGuard};
use crate::state::AppState;

use super::support::{
    build_list, count_always, date_json, export_envelope, fetch_list, jsonb, list_envelope,
    query_is_true, query_string, require_uuid_param, text, ts_json, uuid_json, uuid_value,
    ExtraBind, ExtraFilter,
};
use pg_http::{Authn, BodyRule, Channel, Policy};

const JOIN_CHECKLIST_KEYS: &[&str] = &[
    "Identity Verified",
    "Business Existence Verified",
    "Beneficial Owners Identified",
    "Screening Result Reviewed",
    "Category And Volume Consistent",
    "Payout Account Ownership Verified",
    "Risk Tier Assigned",
];
const JOIN_OPEN_STATUSES: &[&str] = &[
    "DRAFT",
    "SUBMITTED",
    "IN_REVIEW",
    "INFO_REQUESTED",
    "PENDING_CHECKER",
];
const KYB_REJECTION_REASONS: &[&str] = &[
    "BLURRY_OR_UNREADABLE",
    "EXPIRED_DOCUMENT",
    "WRONG_DOCUMENT_TYPE",
    "NAME_MISMATCH",
    "INCOMPLETE_DOCUMENT",
    "DUPLICATE_REUSE",
    "REPLACEMENT_REQUESTED",
    "OTHER",
];
const KYB_EXPIRY_WARNING_DAYS: i64 = 30;

/// Routes owned by this module.
#[must_use]
pub fn routes() -> Vec<MountedRoute> {
    vec![
        route(
            "/internal/admin/join-requests",
            "core-back/api/internal/admin.ts:2663",
            &["kyb:read", "compliance:read"],
            join_list_handler,
        ),
        route(
            "/internal/admin/join-requests/export",
            "core-back/api/internal/admin.ts:2685",
            &["kyb:read", "compliance:read"],
            join_export_handler,
        ),
        route(
            "/internal/admin/join-requests/summary",
            "core-back/api/internal/admin.ts:2794",
            &["kyb:read", "compliance:read"],
            join_summary_handler,
        ),
        route(
            "/internal/admin/join-requests/summary/export",
            "core-back/api/internal/admin.ts:2799",
            &["kyb:read", "compliance:read"],
            join_summary_export_handler,
        ),
        route(
            "/internal/admin/join-requests/:id",
            "core-back/api/internal/admin.ts:2824",
            &["kyb:read", "compliance:read"],
            join_detail_handler,
        ),
        route(
            "/internal/admin/kyb-documents",
            "core-back/api/internal/admin.ts:3939",
            &["kyb:read", "compliance:read"],
            kyb_list_handler,
        ),
        route(
            "/internal/admin/kyb-documents/export",
            "core-back/api/internal/admin.ts:4092",
            &["kyb:read", "compliance:read"],
            kyb_export_handler,
        ),
        route(
            "/internal/admin/kyb-documents/summary",
            "core-back/api/internal/admin.ts:4271",
            &["kyb:read", "compliance:read"],
            kyb_summary_handler,
        ),
        route(
            "/internal/admin/kyb-documents/summary/export",
            "core-back/api/internal/admin.ts:4276",
            &["kyb:read", "compliance:read"],
            kyb_summary_export_handler,
        ),
        route(
            "/internal/admin/kyb-documents/:id",
            "core-back/api/internal/admin.ts:4300",
            &["kyb:read", "compliance:read"],
            kyb_detail_handler,
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

// ---------------------------------------------------------------- shared helpers

fn days_until_expiry(expires_on: Option<NaiveDate>, now: NaiveDate) -> Option<i64> {
    expires_on.map(|date| (date - now).num_days())
}

fn expiry_state(expires_on: Option<NaiveDate>, now: NaiveDate) -> &'static str {
    match days_until_expiry(expires_on, now) {
        None => "NONE",
        Some(days) if days < 0 => "EXPIRED",
        Some(days) if days <= KYB_EXPIRY_WARNING_DAYS => "DUE_SOON",
        Some(_) => "VALID",
    }
}

fn kyb_actionable(
    status: &str,
    av_status: &str,
    expires_on: Option<NaiveDate>,
    now: NaiveDate,
) -> bool {
    status == "UPLOADED" && av_status == "CLEAN" && expiry_state(expires_on, now) != "EXPIRED"
}

/// Case timeline reader shared with the reconciliation/incident modules (`audit_log` shape).
pub(super) async fn audit_trail(
    state: &AppState,
    entity_type: &str,
    entity_id: &str,
    limit: i64,
) -> Result<Value, ApiError> {
    let rows = sqlx::query(
        "SELECT al.id, al.created_at, al.action, al.role, al.before_json, al.after_json,
                al.approval_request_id, u.id AS actor_id, u.email AS actor_email
         FROM audit_log al LEFT JOIN users u ON u.id = al.actor_id
         WHERE al.entity_type = $1 AND al.entity_id = $2
         ORDER BY al.created_at DESC LIMIT $3",
    )
    .bind(entity_type)
    .bind(entity_id)
    .bind(limit)
    .fetch_all(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    Ok(Value::Array(
        rows.iter()
            .map(|row| {
                json!({
                    "id": uuid_json(row, "id"),
                    "createdAt": ts_json(row, "created_at"),
                    "action": text(row, "action"),
                    "role": text(row, "role"),
                    "beforeJson": jsonb(row, "before_json"),
                    "afterJson": jsonb(row, "after_json"),
                    "approvalRequestId": uuid_json(row, "approval_request_id"),
                    "actor": if row.try_get::<Option<String>, _>("actor_id").ok().flatten().is_some() {
                        json!({"id": uuid_json(row, "actor_id"), "email": super::support::text_value(row, "actor_email")})
                    } else {
                        Value::Null
                    },
                })
            })
            .collect(),
    ))
}

// ---------------------------------------------------------------- join requests

fn join_columns() -> ColumnMap {
    ColumnMap::new()
        .with("id", "jr.id", ColumnKind::Uuid)
        .with("createdAt", "jr.created_at", ColumnKind::Timestamp)
        .with("status", "jr.status::text", ColumnKind::Text)
        .with("merchantId", "jr.merchant_id", ColumnKind::Uuid)
        .with(
            "proposedRiskTier",
            "jr.proposed_risk_tier::text",
            ColumnKind::Text,
        )
        .with(
            "onboardingChannel",
            "jr.onboarding_channel::text",
            ColumnKind::Text,
        )
        .with(
            "assignedReviewerId",
            "jr.assigned_reviewer_id",
            ColumnKind::Uuid,
        )
        .with("slaDueAt", "jr.sla_due_at", ColumnKind::Timestamp)
        .with("legalName", "m.legal_name", ColumnKind::Text)
        .with("tradeName", "m.trade_name", ColumnKind::Text)
        .with("contactEmail", "m.contact_email", ColumnKind::Text)
        .with("contactPhone", "m.contact_phone", ColumnKind::Text)
}

fn join_spec() -> ListSpec {
    ListSpec::default()
        .with_search(&["legalName", "tradeName", "contactEmail", "contactPhone"])
        .with_in("status", "status")
        .with_equals("merchantId", "merchantId")
        .with_equals("proposedRiskTier", "proposedRiskTier")
        .with_equals("onboardingChannel", "onboardingChannel")
        .with_equals("assignedReviewerId", "assignedReviewerId")
        .with_date(DateFilter::new("createdAt", "createdAt"))
        .with_date(DateFilter::new("slaDueAt", "slaDueAt").with_keys("dateFrom", "dateTo"))
        .with_sortable("status", "status")
        .with_sortable("submittedAt", "createdAt")
        .with_sortable("slaDueAt", "slaDueAt")
        .with_sortable("riskTier", "proposedRiskTier")
        .with_default_sort("createdAt", SortDirection::Desc)
}

const JOIN_FROM: &str = "join_requests jr JOIN merchants m ON m.id = jr.merchant_id";

const JOIN_PROJECTION: &str = "jr.id, jr.created_at, jr.updated_at, jr.merchant_id, jr.submitted_by_user_id,
    jr.status::text AS status, jr.onboarding_channel::text AS onboarding_channel, jr.submitted_at,
    jr.assigned_reviewer_id, jr.sla_due_at, jr.screening_id, jr.proposed_risk_tier::text AS proposed_risk_tier,
    jr.four_eyes_required, jr.four_eyes_reasons, jr.decision, jr.decision_reason_code, jr.decision_notes,
    jr.info_request_json, jr.profile_json, jr.review_checklist_json, jr.duplicate_flags_json,
    jr.sla_paused_at, jr.sla_remaining_seconds, jr.last_screened_at, jr.resubmission_of_id,
    jr.approval_request_id,
    jsonb_build_object('id', m.id, 'legalName', m.legal_name, 'tradeName', m.trade_name,
        'status', m.status::text, 'kybStatus', m.kyb_status::text, 'riskTier', m.risk_tier::text,
        'contactEmail', m.contact_email, 'contactPhone', m.contact_phone, 'country', m.country) AS merchant_json,
    reviewer.email AS reviewer_email";

const JOIN_DOCS_SUBQUERY: &str = "COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
        'id', kd.id, 'createdAt', to_char(kd.created_at,'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
        'updatedAt', to_char(kd.updated_at,'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
        'merchantId', kd.merchant_id, 'joinRequestId', kd.join_request_id,
        'subjectType', kd.subject_type::text, 'subjectId', kd.subject_id, 'docType', kd.doc_type::text,
        'originalFileName', kd.original_file_name, 'sha256', kd.sha256, 'mime', kd.mime,
        'sizeBytes', kd.size_bytes, 'avStatus', kd.av_status::text, 'status', kd.status::text,
        'reviewedById', kd.reviewed_by, 'reviewedAt', to_char(kd.reviewed_at,'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
        'expiresOn', to_char(kd.expires_on,'YYYY-MM-DD'),
        'rejectionReasonCode', kd.rejection_reason_code, 'reviewNotes', kd.review_notes,
        'duplicateJustification', kd.duplicate_justification,
        'statusChangedAt', to_char(kd.status_changed_at,'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
        'expiredAt', to_char(kd.expired_at,'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')
    ) ORDER BY kd.created_at DESC)
    FROM kyb_documents kd WHERE kd.join_request_id = jr.id
), '[]'::jsonb) AS documents_json";

fn join_row(row: &sqlx::postgres::PgRow) -> Value {
    let mut object = Map::new();
    object.insert("id".to_owned(), uuid_json(row, "id"));
    object.insert("createdAt".to_owned(), ts_json(row, "created_at"));
    object.insert("updatedAt".to_owned(), ts_json(row, "updated_at"));
    object.insert("merchantId".to_owned(), uuid_json(row, "merchant_id"));
    object.insert(
        "submittedByUserId".to_owned(),
        uuid_json(row, "submitted_by_user_id"),
    );
    object.insert("status".to_owned(), Value::String(text(row, "status")));
    object.insert(
        "onboardingChannel".to_owned(),
        Value::String(text(row, "onboarding_channel")),
    );
    object.insert(
        "submittedAt".to_owned(),
        if super::support::timestamp(row, "submitted_at").is_some() {
            ts_json(row, "submitted_at")
        } else {
            ts_json(row, "created_at")
        },
    );
    object.insert(
        "assignedReviewerId".to_owned(),
        uuid_json(row, "assigned_reviewer_id"),
    );
    object.insert("slaDueAt".to_owned(), ts_json(row, "sla_due_at"));
    object.insert("screeningId".to_owned(), uuid_json(row, "screening_id"));
    object.insert(
        "proposedRiskTier".to_owned(),
        Value::String(text(row, "proposed_risk_tier")),
    );
    object.insert(
        "fourEyesRequired".to_owned(),
        super::support::bool_json(row, "four_eyes_required"),
    );
    object.insert(
        "fourEyesReasons".to_owned(),
        jsonb(row, "four_eyes_reasons"),
    );
    object.insert(
        "decision".to_owned(),
        super::support::text_value(row, "decision"),
    );
    object.insert(
        "decisionReasonCode".to_owned(),
        super::support::text_value(row, "decision_reason_code"),
    );
    object.insert(
        "decisionNotes".to_owned(),
        super::support::text_value(row, "decision_notes"),
    );
    object.insert(
        "infoRequestJson".to_owned(),
        super::support::jsonb(row, "info_request_json"),
    );
    object.insert(
        "profileJson".to_owned(),
        super::support::jsonb(row, "profile_json"),
    );
    object.insert(
        "reviewChecklistJson".to_owned(),
        super::support::jsonb(row, "review_checklist_json"),
    );
    object.insert(
        "duplicateFlagsJson".to_owned(),
        super::support::jsonb(row, "duplicate_flags_json"),
    );
    object.insert("slaPausedAt".to_owned(), ts_json(row, "sla_paused_at"));
    object.insert(
        "slaRemainingSeconds".to_owned(),
        super::support::int_json(row, "sla_remaining_seconds"),
    );
    object.insert(
        "lastScreenedAt".to_owned(),
        ts_json(row, "last_screened_at"),
    );
    object.insert(
        "resubmissionOfId".to_owned(),
        uuid_json(row, "resubmission_of_id"),
    );
    object.insert(
        "approvalRequestId".to_owned(),
        uuid_json(row, "approval_request_id"),
    );
    let merchant = jsonb(row, "merchant_json");
    object.insert(
        "merchantName".to_owned(),
        merchant
            .get("tradeName")
            .and_then(Value::as_str)
            .map_or_else(String::new, str::to_owned)
            .into(),
    );
    object.insert("merchant".to_owned(), merchant);
    object.insert("kybDocuments".to_owned(), jsonb(row, "documents_json"));
    object.insert(
        "riskTier".to_owned(),
        Value::String(text(row, "proposed_risk_tier")),
    );
    object.insert(
        "reviewer".to_owned(),
        super::support::opt_text(row, "reviewer_email")
            .map_or(Value::String(String::new()), Value::String),
    );
    Value::Object(object)
}

async fn join_list(
    state: &AppState,
    request: &HttpRequest,
    _principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let built = build_list(request, &join_spec(), &join_columns())?;
    let projection = format!("{JOIN_PROJECTION}, {JOIN_DOCS_SUBQUERY}");
    let from =
        format!("{JOIN_FROM} LEFT JOIN users reviewer ON reviewer.id = jr.assigned_reviewer_id");
    let rows = fetch_list(&state.pools.main, &built, &projection, &from, None).await?;
    let total = count_always(&state.pools.main, &built, JOIN_FROM, None).await?;
    let items: Vec<Value> = rows.iter().map(join_row).collect();
    let mut response = list_envelope("joinRequests", Value::Array(items), Some(total), &built);
    response = super::support::with_cursor(response, &built, &rows, "created_at");
    Ok(response)
}

async fn join_export(
    state: &AppState,
    request: &HttpRequest,
    _principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let built = build_list(request, &join_spec(), &join_columns())?;
    let sql = format!(
        "SELECT jr.id, jr.merchant_id, m.trade_name, m.legal_name, jr.status::text AS status,
                jr.proposed_risk_tier::text AS proposed_risk_tier, jr.onboarding_channel::text AS onboarding_channel,
                jr.submitted_at, jr.created_at, jr.sla_due_at, jr.sla_paused_at,
                reviewer.email AS reviewer_email, jr.four_eyes_required, jr.decision, jr.decision_reason_code
         FROM {JOIN_FROM} LEFT JOIN users reviewer ON reviewer.id = jr.assigned_reviewer_id
         {} ORDER BY {} LIMIT 5000",
        built.where_sql, built.order_by_sql
    );
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql));
    for bind in &built.binds {
        query = match bind {
            pg_db::SqlBind::Text(value) => query.bind(value.as_str()),
            pg_db::SqlBind::Bool(value) => query.bind(*value),
        };
    }
    let rows = query
        .fetch_all(&state.pools.main)
        .await
        .map_err(super::support::database_error)?;
    let total = count_always(&state.pools.main, &built, JOIN_FROM, None).await?;
    Ok(export_envelope(
        "joinRequests",
        Value::Array(
            rows.iter()
                .map(|row| {
                    json!({
                        "id": uuid_json(row, "id"),
                        "merchantId": uuid_json(row, "merchant_id"),
                        "merchantName": super::support::opt_text(row, "trade_name").unwrap_or_default(),
                        "legalName": super::support::opt_text(row, "legal_name").unwrap_or_default(),
                        "status": text(row, "status"),
                        "riskTier": text(row, "proposed_risk_tier"),
                        "onboardingChannel": text(row, "onboarding_channel"),
                        "submittedAt": if super::support::timestamp(row, "submitted_at").is_some() { ts_json(row, "submitted_at") } else { ts_json(row, "created_at") },
                        "createdAt": ts_json(row, "created_at"),
                        "slaDueAt": ts_json(row, "sla_due_at"),
                        "slaPausedAt": ts_json(row, "sla_paused_at"),
                        "reviewer": super::support::opt_text(row, "reviewer_email").unwrap_or_default(),
                        "fourEyesRequired": super::support::bool_json(row, "four_eyes_required"),
                        "decision": super::support::text_value(row, "decision"),
                        "decisionReasonCode": super::support::text_value(row, "decision_reason_code"),
                    })
                })
                .collect(),
        ),
        total,
        rows.len(),
    ))
}

async fn join_summary_value(state: &AppState) -> Result<Value, ApiError> {
    let rows = sqlx::query(
        "SELECT status::text AS status, proposed_risk_tier::text AS risk_tier, sla_due_at, sla_paused_at,
                assigned_reviewer_id, four_eyes_required
         FROM join_requests",
    )
    .fetch_all(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let now = Utc::now().naive_utc();
    let soon = now + chrono::Duration::hours(24);
    let mut by_status: Map<String, Value> = Map::new();
    let mut by_risk: Map<String, Value> = Map::new();
    let mut overdue = 0i64;
    let mut due_soon = 0i64;
    let mut unassigned = 0i64;
    let mut pending_checker = 0i64;
    let mut four_eyes = 0i64;
    let mut open = 0i64;
    for row in &rows {
        let status = text(row, "status");
        let risk = text(row, "risk_tier");
        let count = by_status.get(&status).and_then(Value::as_i64).unwrap_or(0);
        by_status.insert(status.clone(), Value::from(count + 1));
        let count = by_risk.get(&risk).and_then(Value::as_i64).unwrap_or(0);
        by_risk.insert(risk, Value::from(count + 1));
        let is_open = JOIN_OPEN_STATUSES.contains(&status.as_str());
        if is_open {
            open += 1;
        }
        if is_open && super::support::timestamp(row, "sla_paused_at").is_none() {
            if let Some(due) = super::support::timestamp(row, "sla_due_at") {
                if due < now {
                    overdue += 1;
                } else if due <= soon {
                    due_soon += 1;
                }
            }
        }
        if status == "PENDING_CHECKER" {
            pending_checker += 1;
        }
        if is_open && uuid_json(row, "assigned_reviewer_id").is_null() {
            unassigned += 1;
        }
        if is_open && super::support::bool_value(row, "four_eyes_required") {
            four_eyes += 1;
        }
    }
    Ok(json!({
        "summary": {
            "total": rows.len(),
            "open": open,
            "submitted": by_status.get("SUBMITTED").cloned().unwrap_or(Value::from(0)),
            "inReview": by_status.get("IN_REVIEW").cloned().unwrap_or(Value::from(0)),
            "infoRequested": by_status.get("INFO_REQUESTED").cloned().unwrap_or(Value::from(0)),
            "pendingChecker": pending_checker,
            "approved": by_status.get("APPROVED").cloned().unwrap_or(Value::from(0)),
            "rejected": by_status.get("REJECTED").cloned().unwrap_or(Value::from(0)),
            "overdue": overdue,
            "dueSoon": due_soon,
            "unassigned": unassigned,
            "fourEyes": four_eyes,
            "byStatus": by_status,
            "byRisk": by_risk,
        }
    }))
}

pub(super) async fn join_detail(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let id = require_uuid_param(
        super::support::last_path_segment(request).as_deref(),
        "JOIN_REQUEST_NOT_FOUND",
        "The join request does not exist",
    )?;
    let row = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {JOIN_PROJECTION}, {JOIN_DOCS_SUBQUERY},
                submitter.email AS submitter_email
         FROM {JOIN_FROM}
         LEFT JOIN users reviewer ON reviewer.id = jr.assigned_reviewer_id
         LEFT JOIN users submitter ON submitter.id = jr.submitted_by_user_id
         WHERE jr.id = $1"
    )))
    .bind(super::support::uuid_bind(&id))
    .fetch_optional(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let Some(row) = row else {
        return Err(ApiError::new(
            404,
            "JOIN_REQUEST_NOT_FOUND",
            "The join request does not exist",
        ));
    };
    let merchant_id = uuid_json(&row, "merchant_id");
    let owners = sqlx::query(
        "SELECT id, full_name_ar, full_name_en, national_id_hash, date_of_birth, nationality,
                ownership_percent, role::text AS role, pep_declared, screening_status::text AS screening_status,
                active, created_at, updated_at
         FROM beneficial_owners WHERE merchant_id = $1::uuid
         ORDER BY active DESC, created_at ASC",
    )
    .bind(merchant_id.as_str().unwrap_or_default())
    .fetch_all(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let wallets = sqlx::query(
        "SELECT id, currency, status::text AS status, gl_account_id, name
         FROM wallets WHERE merchant_id = $1::uuid ORDER BY created_at ASC",
    )
    .bind(merchant_id.as_str().unwrap_or_default())
    .fetch_all(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let approval = match uuid_value(&row, "approval_request_id") {
        Some(approval_id) => sqlx::query(
            "SELECT id, subject_type, state::text AS state, mode::text AS mode, created_at,
                    expires_at, maker_user_id, checker_user_id
             FROM approval_requests WHERE id = $1",
        )
        .bind(super::support::uuid_bind(&approval_id))
        .fetch_optional(&state.pools.main)
        .await
        .map_err(super::support::database_error)?,
        None => None,
    };
    let screening_id = uuid_value(&row, "screening_id");
    let screening = match &screening_id {
        Some(screening_id) => {
            let screening_row = sqlx::query(
                "SELECT id, created_at, updated_at, subject_type::text AS subject_type, subject_id,
                        trigger::text AS trigger, provider_code, provider_request_ref, list_versions_json,
                        input_hash, result::text AS result, match_count, highest_score, requested_at, completed_at
                 FROM aml_screenings WHERE id = $1",
            )
            .bind(super::support::uuid_bind(screening_id))
            .fetch_optional(&state.pools.main)
            .await
            .map_err(super::support::database_error)?;
            let matches = sqlx::query(
                "SELECT id, created_at, updated_at, list_type::text AS list_type, list_name,
                        list_entry_ref, matched_name, score, attributes_json, disposition::text AS disposition,
                        disposition_by, disposition_notes, suppress_future, suppress_until
                 FROM aml_screening_matches WHERE screening_id = $1 ORDER BY created_at ASC",
            )
            .bind(super::support::uuid_bind(screening_id))
            .fetch_all(&state.pools.main)
            .await
            .map_err(super::support::database_error)?;
            let cases = sqlx::query(
                "SELECT id, status::text AS status, severity::text AS severity, trigger_reason
                 FROM aml_cases WHERE screening_id = $1 ORDER BY created_at DESC",
            )
            .bind(super::support::uuid_bind(screening_id))
            .fetch_all(&state.pools.main)
            .await
            .map_err(super::support::database_error)?;
            let confidential = principal.is_some_and(|principal| {
                matches!(principal.role.as_deref(), Some("COMPLIANCE" | "MLRO"))
                    || principal.authorities.iter().any(|authority| {
                        authority == "*" || authority == "aml:read" || authority == "aml:write"
                    })
            });
            screening_row.map(|screening_row| {
                json!({
                    "id": uuid_json(&screening_row, "id"),
                    "createdAt": ts_json(&screening_row, "created_at"),
                    "updatedAt": ts_json(&screening_row, "updated_at"),
                    "subjectType": text(&screening_row, "subject_type"),
                    "subjectId": text(&screening_row, "subject_id"),
                    "trigger": text(&screening_row, "trigger"),
                    "providerCode": text(&screening_row, "provider_code"),
                    "providerRequestRef": super::support::text_value(&screening_row, "provider_request_ref"),
                    "listVersionsJson": super::support::jsonb(&screening_row, "list_versions_json"),
                    "inputHash": text(&screening_row, "input_hash"),
                    "result": text(&screening_row, "result"),
                    "matchCount": super::support::int_json(&screening_row, "match_count"),
                    "highestScore": super::support::money(&screening_row, "highest_score"),
                    "requestedAt": ts_json(&screening_row, "requested_at"),
                    "completedAt": ts_json(&screening_row, "completed_at"),
                    "matches": matches.iter().map(|entry| json!({
                        "id": uuid_json(entry, "id"),
                        "createdAt": ts_json(entry, "created_at"),
                        "updatedAt": ts_json(entry, "updated_at"),
                        "listType": text(entry, "list_type"),
                        "listName": if confidential { super::support::text_value(entry, "list_name") } else { Value::String("[REDACTED]".to_owned()) },
                        "listEntryRef": if confidential { super::support::text_value(entry, "list_entry_ref") } else { Value::String("[REDACTED]".to_owned()) },
                        "matchedName": if confidential { super::support::text_value(entry, "matched_name") } else { Value::String("[REDACTED]".to_owned()) },
                        "score": super::support::money(entry, "score"),
                        "attributesJson": if confidential { super::support::jsonb(entry, "attributes_json") } else { json!({}) },
                        "disposition": text(entry, "disposition"),
                        "dispositionById": uuid_json(entry, "disposition_by"),
                        "dispositionNotes": if confidential { super::support::text_value(entry, "disposition_notes") } else { Value::Null },
                        "suppressFuture": super::support::bool_json(entry, "suppress_future"),
                        "suppressUntil": date_json(entry, "suppress_until"),
                    })).collect::<Vec<_>>(),
                    "amlCases": cases.iter().map(|entry| json!({
                        "id": uuid_json(entry, "id"),
                        "status": text(entry, "status"),
                        "severity": text(entry, "severity"),
                        "triggerReason": text(entry, "trigger_reason"),
                    })).collect::<Vec<_>>(),
                })
            })
        }
        None => None,
    };
    let required_setting = sqlx::query(
        "SELECT value_json FROM platform_settings WHERE key = 'onboarding.required_documents'
         ORDER BY version DESC LIMIT 1",
    )
    .fetch_optional(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let required_documents: Vec<String> = required_setting
        .as_ref()
        .and_then(|setting| {
            setting
                .try_get::<Option<sqlx::types::Json<Value>>, _>("value_json")
                .ok()
                .flatten()
        })
        .and_then(|value| match value.0 {
            Value::Object(map) => map.get("default").and_then(Value::as_array).map(|entries| {
                entries
                    .iter()
                    .map(|entry| entry.as_str().unwrap_or_default().to_owned())
                    .collect()
            }),
            _ => None,
        })
        .unwrap_or_else(|| {
            vec![
                "COMMERCIAL_REGISTRY".to_owned(),
                "TAX_CERTIFICATE".to_owned(),
                "BANK_LETTER".to_owned(),
                "PROOF_OF_ADDRESS".to_owned(),
            ]
        });
    let threshold_setting = sqlx::query(
        "SELECT value_json FROM platform_settings WHERE key = 'join_request.four_eyes_policy'
         ORDER BY version DESC LIMIT 1",
    )
    .fetch_optional(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let owner_threshold = threshold_setting
        .as_ref()
        .and_then(|setting| {
            setting
                .try_get::<Option<sqlx::types::Json<Value>>, _>("value_json")
                .ok()
                .flatten()
        })
        .and_then(|value| {
            value
                .0
                .get("ownerThresholdPercent")
                .or_else(|| value.0.get("owner_threshold_percent"))
                .and_then(Value::as_f64)
        })
        .filter(|value| *value > 0.0)
        .unwrap_or(25.0);
    let payout_bank_ready: bool = sqlx::query_scalar(
        "SELECT (payout_bank_details_json IS NOT NULL AND payout_bank_details_json <> 'null'::jsonb)
         FROM merchants WHERE id = $1::uuid",
    )
    .bind(merchant_id.as_str().unwrap_or_default())
    .fetch_optional(&state.pools.main)
    .await
    .map_err(super::support::database_error)?
    .unwrap_or(false);
    let audit = audit_trail(state, "JOIN_REQUEST", &id, 100).await?;
    let role = principal
        .and_then(|principal| principal.role.as_deref())
        .unwrap_or_default();
    let confidential = matches!(role, "COMPLIANCE" | "MLRO");
    let today = Utc::now().date_naive();
    let documents = jsonb(&row, "documents_json");
    let document_rows = documents.as_array().cloned().unwrap_or_default();
    let mut accepted_types = std::collections::BTreeSet::new();
    let mut expired_documents = Vec::new();
    for document in &document_rows {
        let status = document
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let doc_type = document
            .get("docType")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let expires = document
            .get("expiresOn")
            .and_then(Value::as_str)
            .and_then(|value| NaiveDate::parse_from_str(value, "%Y-%m-%d").ok());
        let expired = expires.is_some_and(|value| value < today);
        if status == "ACCEPTED" && !expired {
            accepted_types.insert(doc_type.to_owned());
        } else if matches!(status, "ACCEPTED" | "EXPIRED")
            && expired
            && required_documents
                .iter()
                .any(|required| required == doc_type)
            && !accepted_types.contains(doc_type)
        {
            if let Some(id) = document.get("id").and_then(Value::as_str) {
                expired_documents.push(id.to_owned());
            }
        }
    }
    let missing_documents: Vec<String> = required_documents
        .iter()
        .filter(|required| !accepted_types.contains(*required))
        .cloned()
        .collect();
    let mut owners_total = 0.0_f64;
    let mut owner_count = 0_usize;
    let mut has_controller = false;
    let mut owners_screened = true;
    for owner in &owners {
        if !super::support::bool_value(owner, "active") {
            continue;
        }
        owner_count += 1;
        owners_total += super::support::decimal(owner, "ownership_percent")
            .map(|value| value.to_string().parse::<f64>().unwrap_or_default())
            .unwrap_or_default();
        if text(owner, "role") == "CONTROLLER" {
            has_controller = true;
        }
        if !matches!(
            text(owner, "screening_status").as_str(),
            "CLEAR" | "POTENTIAL_MATCH"
        ) {
            owners_screened = false;
        }
    }
    let owners_ready = owner_count > 0 && (has_controller || owners_total >= owner_threshold);
    let screening_result = screening
        .as_ref()
        .and_then(|value| value.get("result"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let screening_matches = screening
        .as_ref()
        .and_then(|value| value.get("matches"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let true_matches = screening_matches
        .iter()
        .filter(|entry| entry.get("disposition").and_then(Value::as_str) == Some("TRUE_MATCH"))
        .count();
    let pending_matches = screening_matches
        .iter()
        .filter(|entry| entry.get("disposition").and_then(Value::as_str) == Some("UNREVIEWED"))
        .count();
    let open_aml_cases = screening
        .as_ref()
        .and_then(|value| value.get("amlCases"))
        .and_then(Value::as_array)
        .map(|cases| {
            cases
                .iter()
                .filter(|entry| {
                    !matches!(
                        entry.get("status").and_then(Value::as_str),
                        Some("RELEASED" | "REJECTED_VOID")
                    )
                })
                .count()
        })
        .unwrap_or(0);
    let screening_blocked = screening_result.is_none()
        || matches!(
            screening_result.as_deref(),
            Some("ERROR" | "CONFIRMED_MATCH")
        )
        || true_matches > 0
        || (screening_result.as_deref() == Some("POTENTIAL_MATCH") && pending_matches > 0)
        || open_aml_cases > 0
        || !owners_screened;
    let checklist = jsonb(&row, "review_checklist_json");
    let checklist_complete = JOIN_CHECKLIST_KEYS.iter().all(|key| {
        checklist
            .get(*key)
            .and_then(Value::as_bool)
            .unwrap_or(false)
    });
    let duplicate_flags = jsonb(&row, "duplicate_flags_json");
    let approval_pending = approval
        .as_ref()
        .is_some_and(|approval| text(approval, "state") == "PENDING_REVIEW");
    let mut blockers = Vec::new();
    if !missing_documents.is_empty() {
        blockers.push("MISSING_REQUIRED_DOCUMENTS");
    }
    if !expired_documents.is_empty() {
        blockers.push("EXPIRED_REQUIRED_DOCUMENTS");
    }
    if !owners_ready {
        blockers.push("BENEFICIAL_OWNERS_NOT_READY");
    }
    if !owners_screened {
        blockers.push("BENEFICIAL_OWNER_SCREENING_INCOMPLETE");
    }
    if screening_blocked {
        blockers.push("SCREENING_NOT_CLEAR");
    }
    if !checklist_complete {
        blockers.push("REVIEW_CHECKLIST_INCOMPLETE");
    }
    if !payout_bank_ready {
        blockers.push("PAYOUT_BANK_MISSING");
    }
    let readiness = json!({
        "ready": blockers.is_empty(),
        "blockers": blockers,
        "checklistComplete": checklist_complete,
        "requiredDocuments": required_documents,
        "acceptedDocuments": accepted_types,
        "missingDocuments": missing_documents,
        "expiredDocuments": expired_documents,
        "ownersTotal": owners_total,
        "ownerThreshold": owner_threshold,
        "ownersReady": owners_ready,
        "screeningResult": screening_result,
        "screeningBlocked": screening_blocked,
        "duplicateFlags": duplicate_flags,
        "approvalPending": approval_pending,
        "payoutBankReady": payout_bank_ready,
    });

    let mut join_request = join_row(&row);
    if let Some(object) = join_request.as_object_mut() {
        object.insert(
            "submittedBy".to_owned(),
            json!({"id": uuid_json(&row, "submitted_by_user_id"), "email": super::support::text_value(&row, "submitter_email")}),
        );
        object.insert(
            "assignedReviewer".to_owned(),
            json!({"id": uuid_json(&row, "assigned_reviewer_id"), "email": super::support::text_value(&row, "reviewer_email")}),
        );
        object.insert(
            "beneficialOwners".to_owned(),
            Value::Array(
                owners
                    .iter()
                    .map(|owner| {
                        json!({
                            "id": uuid_json(owner, "id"),
                            "createdAt": ts_json(owner, "created_at"),
                            "updatedAt": ts_json(owner, "updated_at"),
                            "fullNameAr": text(owner, "full_name_ar"),
                            "fullNameEn": super::support::text_value(owner, "full_name_en"),
                            "nationalIdHash": super::support::text_value(owner, "national_id_hash"),
                            "dateOfBirth": date_json(owner, "date_of_birth"),
                            "nationality": text(owner, "nationality"),
                            "ownershipPercent": super::support::money(owner, "ownership_percent"),
                            "role": text(owner, "role"),
                            "pepDeclared": super::support::bool_json(owner, "pep_declared"),
                            "screeningStatus": text(owner, "screening_status"),
                            "active": super::support::bool_json(owner, "active"),
                        })
                    })
                    .collect(),
            ),
        );
        object.insert("auditTrail".to_owned(), audit);
        object.insert("checklistKeys".to_owned(), json!(JOIN_CHECKLIST_KEYS));
        object.insert("amlDetailsRedacted".to_owned(), Value::Bool(!confidential));
        object.insert("readiness".to_owned(), readiness);
        object.insert("screening".to_owned(), screening.unwrap_or(Value::Null));
        object.insert(
            "approvalRequest".to_owned(),
            approval.as_ref().map_or(Value::Null, |approval| {
                json!({
                    "id": uuid_json(approval, "id"),
                    "subjectType": text(approval, "subject_type"),
                    "state": text(approval, "state"),
                    "mode": text(approval, "mode"),
                    "createdAt": ts_json(approval, "created_at"),
                    "expiresAt": ts_json(approval, "expires_at"),
                    "makerUserId": uuid_json(approval, "maker_user_id"),
                    "checkerUserId": uuid_json(approval, "checker_user_id"),
                })
            }),
        );
        if let Some(merchant) = object.get_mut("merchant").and_then(Value::as_object_mut) {
            merchant.insert(
                "wallets".to_owned(),
                Value::Array(
                    wallets
                        .iter()
                        .map(|wallet| {
                            json!({
                                "id": uuid_json(wallet, "id"),
                                "merchantId": merchant_id.clone(),
                                "currency": text(wallet, "currency"),
                                "status": text(wallet, "status"),
                                "glAccountId": uuid_json(wallet, "gl_account_id"),
                                "name": super::support::text_value(wallet, "name"),
                            })
                        })
                        .collect(),
                ),
            );
        }
    }
    Ok(json!({ "joinRequest": join_request }))
}

// ---------------------------------------------------------------- KYB documents

fn kyb_columns() -> ColumnMap {
    ColumnMap::new()
        .with("id", "kd.id", ColumnKind::Uuid)
        .with("createdAt", "kd.created_at", ColumnKind::Timestamp)
        .with("expiresOn", "kd.expires_on", ColumnKind::Timestamp)
        .with("status", "kd.status::text", ColumnKind::Text)
        .with("avStatus", "kd.av_status::text", ColumnKind::Text)
        .with("docType", "kd.doc_type::text", ColumnKind::Text)
        .with("subjectType", "kd.subject_type::text", ColumnKind::Text)
        .with("merchantId", "kd.merchant_id", ColumnKind::Uuid)
        .with("joinRequestId", "kd.join_request_id", ColumnKind::Uuid)
        .with("reviewedById", "kd.reviewed_by", ColumnKind::Uuid)
        .with("requestRef", "kd.join_request_id::text", ColumnKind::Text)
        .with("merchantName", "m.trade_name", ColumnKind::Text)
        .with("merchantLegalName", "m.legal_name", ColumnKind::Text)
        .with(
            "originalFileName",
            "kd.original_file_name",
            ColumnKind::Text,
        )
        .with("sha256", "kd.sha256", ColumnKind::Text)
        .with("merchantStatus", "m.status::text", ColumnKind::Text)
        .with("merchantKybStatus", "m.kyb_status::text", ColumnKind::Text)
        .with("email", "m.contact_email", ColumnKind::Text)
        .with("phone", "m.contact_phone", ColumnKind::Text)
        .with("joinStatus", "jr.status::text", ColumnKind::Text)
}

fn kyb_spec() -> ListSpec {
    ListSpec::default()
        .with_search(&[
            "merchantLegalName",
            "merchantName",
            "email",
            "phone",
            "originalFileName",
            "sha256",
        ])
        .with_contains("merchantName", &["merchantLegalName", "merchantName"])
        .with_contains("requestRef", &["requestRef"])
        .with_in("status", "status")
        .with_in("avStatus", "avStatus")
        .with_in("docType", "docType")
        .with_in("subjectType", "subjectType")
        .with_equals("merchantId", "merchantId")
        .with_equals("joinRequestId", "joinRequestId")
        .with_equals("reviewedById", "reviewedById")
        .with_date(
            DateFilter::new("createdAt", "createdAt").with_keys("uploadedFrom", "uploadedTo"),
        )
        .with_date(DateFilter::new("expiresOn", "expiresOn").with_keys("expiryFrom", "expiryTo"))
        .with_sortable("createdAt", "createdAt")
        .with_sortable("expiresOn", "expiresOn")
        .with_sortable("status", "status")
        .with_sortable("avStatus", "avStatus")
        .with_sortable("docType", "docType")
        .with_default_sort("createdAt", SortDirection::Desc)
}

const KYB_FROM: &str = "kyb_documents kd
    JOIN merchants m ON m.id = kd.merchant_id
    LEFT JOIN join_requests jr ON jr.id = kd.join_request_id
    LEFT JOIN users uploader ON uploader.id = kd.uploaded_by
    LEFT JOIN users reviewer ON reviewer.id = kd.reviewed_by";

const KYB_PROJECTION: &str =
    "kd.id, kd.created_at, kd.updated_at, kd.merchant_id, kd.join_request_id,
    kd.subject_type::text AS subject_type, kd.subject_id, kd.doc_type::text AS doc_type,
    kd.original_file_name, kd.mime, kd.size_bytes, kd.sha256, kd.av_status::text AS av_status,
    kd.status::text AS status, kd.uploaded_by, kd.reviewed_by, kd.reviewed_at, kd.expires_on,
    kd.rejection_reason_code, kd.review_notes, kd.duplicate_justification, kd.status_changed_at,
    kd.expired_at, kd.storage_object_id,
    m.trade_name AS merchant_name, m.legal_name AS merchant_legal_name,
    m.status::text AS merchant_status, m.kyb_status::text AS merchant_kyb_status,
    jr.status::text AS join_status,
    uploader.email AS uploader_email, reviewer.email AS reviewer_email";

fn kyb_extra(
    request: &HttpRequest,
    built: &pg_db::BuiltListQuery,
) -> Result<ExtraFilter, ApiError> {
    let mut conditions =
        vec!["(kd.join_request_id IS NULL OR jr.status::text <> 'DRAFT')".to_owned()];
    let mut binds = Vec::new();
    let start = built.binds.len() + 1;
    if let Some(raw) = query_string(request, "requestStatus") {
        let values: Vec<String> = raw
            .split(',')
            .map(str::trim)
            .filter(|entry| !entry.is_empty())
            .map(str::to_owned)
            .collect();
        if !values.is_empty() {
            conditions.push(format!("jr.status::text = ANY(${start}::text[])"));
            binds.push(ExtraBind::Texts(values));
        }
    }
    if query_is_true(request, "duplicateOnly") {
        conditions.push(
            "kd.sha256 IN (SELECT sha256 FROM kyb_documents GROUP BY sha256 HAVING COUNT(DISTINCT merchant_id) > 1)"
                .to_owned(),
        );
    }
    if query_is_true(request, "expiringSoon") {
        conditions.push(
            "kd.expires_on >= CURRENT_DATE AND kd.expires_on <= CURRENT_DATE + 30 AND kd.status::text IN ('UPLOADED','ACCEPTED')"
                .to_owned(),
        );
    }
    Ok(ExtraFilter {
        sql: conditions.join(" AND "),
        binds,
    })
}

fn kyb_row(row: &sqlx::postgres::PgRow, duplicates: &Map<String, Value>) -> Value {
    let now = Utc::now().date_naive();
    let expires = super::support::date(row, "expires_on");
    let sha = text(row, "sha256");
    let duplicate = duplicates.get(&sha).cloned().unwrap_or(Value::Null);
    let duplicate_document_count = duplicate
        .get("documentCount")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let duplicate_merchant_count = duplicate
        .get("otherMerchantCount")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let status = text(row, "status");
    let av_status = text(row, "av_status");
    let join_status = super::support::opt_text(row, "join_status");
    let actionable = kyb_actionable(&status, &av_status, expires, now)
        && join_status.as_deref().is_none_or(|status| {
            !["APPROVED", "REJECTED", "WITHDRAWN", "EXPIRED"].contains(&status)
        });
    json!({
        "id": uuid_json(row, "id"),
        "createdAt": ts_json(row, "created_at"),
        "updatedAt": ts_json(row, "updated_at"),
        "merchantId": uuid_json(row, "merchant_id"),
        "joinRequestId": uuid_json(row, "join_request_id"),
        "subjectType": text(row, "subject_type"),
        "subjectId": super::support::text_value(row, "subject_id"),
        "docType": text(row, "doc_type"),
        "originalFileName": super::support::text_value(row, "original_file_name"),
        "sha256": sha,
        "mime": text(row, "mime"),
        "sizeBytes": super::support::int_json(row, "size_bytes"),
        "avStatus": av_status,
        "status": status,
        "reviewedById": uuid_json(row, "reviewed_by"),
        "reviewedAt": ts_json(row, "reviewed_at"),
        "expiresOn": date_json(row, "expires_on"),
        "rejectionReasonCode": super::support::text_value(row, "rejection_reason_code"),
        "reviewNotes": super::support::text_value(row, "review_notes"),
        "duplicateJustification": super::support::text_value(row, "duplicate_justification"),
        "statusChangedAt": ts_json(row, "status_changed_at"),
        "expiredAt": ts_json(row, "expired_at"),
        "merchantName": super::support::opt_text(row, "merchant_name")
            .or_else(|| super::support::opt_text(row, "merchant_legal_name"))
            .unwrap_or_default(),
        "merchantLegalName": super::support::opt_text(row, "merchant_legal_name").unwrap_or_default(),
        "merchantStatus": super::support::text_value(row, "merchant_status"),
        "merchantKybStatus": super::support::text_value(row, "merchant_kyb_status"),
        "reviewer": super::support::opt_text(row, "reviewer_email").unwrap_or_default(),
        "uploader": super::support::opt_text(row, "uploader_email").unwrap_or_default(),
        "subjectName": Value::Null,
        "contentAvailable": row.try_get::<Option<uuid::Uuid>, _>("storage_object_id").ok().flatten().is_some(),
        "duplicateMerchantCount": duplicate_merchant_count,
        "duplicateDocumentCount": duplicate_document_count,
        "expiryState": expiry_state(expires, now),
        "daysUntilExpiry": days_until_expiry(expires, now),
        "canReview": actionable,
        "canRequestReplacement": false,
        "canRequestRevalidation": false,
        "openJoinRequest": super::support::opt_text(row, "join_request_id").map(|_| json!({"id": uuid_json(row, "join_request_id"), "status": super::support::opt_text(row, "join_status")})),
    })
}

async fn duplicate_map(
    state: &AppState,
    hashes: &[String],
) -> Result<Map<String, Value>, ApiError> {
    let mut map = Map::new();
    if hashes.is_empty() {
        return Ok(map);
    }
    let rows = sqlx::query(
        "SELECT sha256, count(*) AS document_count, count(DISTINCT merchant_id) AS merchant_count
         FROM kyb_documents WHERE sha256 = ANY($1::text[]) GROUP BY sha256",
    )
    .bind(hashes.to_vec())
    .fetch_all(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    for row in &rows {
        let merchant_count: i64 = row.try_get("merchant_count").unwrap_or_default();
        map.insert(
            text(row, "sha256"),
            json!({
                "documentCount": row.try_get::<i64, _>("document_count").unwrap_or_default(),
                "otherMerchantCount": (merchant_count - 1).max(0),
            }),
        );
    }
    Ok(map)
}

async fn kyb_list(
    state: &AppState,
    request: &HttpRequest,
    _principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let built = build_list(request, &kyb_spec(), &kyb_columns())?;
    let extra = kyb_extra(request, &built)?;
    let rows = fetch_list(
        &state.pools.main,
        &built,
        KYB_PROJECTION,
        KYB_FROM,
        Some(&extra),
    )
    .await?;
    let total = count_always(&state.pools.main, &built, KYB_FROM, Some(&extra)).await?;
    let hashes: Vec<String> = rows
        .iter()
        .map(|row| text(row, "sha256"))
        .filter(|hash| !hash.is_empty())
        .collect();
    let duplicates = duplicate_map(state, &hashes).await?;
    let items: Vec<Value> = rows.iter().map(|row| kyb_row(row, &duplicates)).collect();
    let mut response = list_envelope("kybDocuments", Value::Array(items), Some(total), &built);
    response = super::support::with_cursor(response, &built, &rows, "created_at");
    Ok(response)
}

async fn kyb_export(
    state: &AppState,
    request: &HttpRequest,
    _principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let built = build_list(request, &kyb_spec(), &kyb_columns())?;
    let extra = kyb_extra(request, &built)?;
    let mut where_sql = built.where_sql.clone();
    if !extra.sql.trim().is_empty() {
        where_sql = if where_sql.is_empty() {
            format!("WHERE {}", extra.sql)
        } else {
            format!("{where_sql} AND {}", extra.sql)
        };
    }
    let sql = format!(
        "SELECT {KYB_PROJECTION} FROM {KYB_FROM} {where_sql} ORDER BY {} LIMIT 5000",
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
            ExtraBind::Text(value) => query.bind(value.as_str()),
            ExtraBind::Texts(values) => query.bind(values.clone()),
        };
    }
    let rows = query
        .fetch_all(&state.pools.main)
        .await
        .map_err(super::support::database_error)?;
    let total = count_always(&state.pools.main, &built, KYB_FROM, Some(&extra)).await?;
    let now = Utc::now().date_naive();
    Ok(export_envelope(
        "documents",
        Value::Array(
            rows.iter()
                .map(|row| {
                    let expires = super::support::date(row, "expires_on");
                    json!({
                        "id": uuid_json(row, "id"),
                        "merchantId": uuid_json(row, "merchant_id"),
                        "merchantName": super::support::opt_text(row, "merchant_name")
                            .or_else(|| super::support::opt_text(row, "merchant_legal_name"))
                            .unwrap_or_default(),
                        "merchantLegalName": super::support::opt_text(row, "merchant_legal_name").unwrap_or_default(),
                        "merchantStatus": super::support::text_value(row, "merchant_status"),
                        "merchantKybStatus": super::support::text_value(row, "merchant_kyb_status"),
                        "joinRequestId": uuid_json(row, "join_request_id"),
                        "joinRequestStatus": super::support::text_value(row, "join_status"),
                        "subjectType": text(row, "subject_type"),
                        "subjectId": super::support::text_value(row, "subject_id"),
                        "docType": text(row, "doc_type"),
                        "originalFileName": super::support::text_value(row, "original_file_name"),
                        "mime": text(row, "mime"),
                        "sizeBytes": super::support::int_json(row, "size_bytes"),
                        "sha256": text(row, "sha256"),
                        "avStatus": text(row, "av_status"),
                        "status": text(row, "status"),
                        "expiresOn": date_json(row, "expires_on"),
                        "expiryState": expiry_state(expires, now),
                        "uploadedBy": super::support::opt_text(row, "uploader_email").unwrap_or_default(),
                        "reviewedBy": super::support::opt_text(row, "reviewer_email").unwrap_or_default(),
                        "reviewedAt": ts_json(row, "reviewed_at"),
                        "rejectionReasonCode": super::support::text_value(row, "rejection_reason_code"),
                        "createdAt": ts_json(row, "created_at"),
                    })
                })
                .collect(),
        ),
        total,
        rows.len(),
    ))
}

async fn kyb_summary_value(state: &AppState) -> Result<Value, ApiError> {
    let now = Utc::now().date_naive();
    let rows = sqlx::query(
        "SELECT kd.status::text AS status, kd.av_status::text AS av_status, kd.doc_type::text AS doc_type,
                kd.expires_on, kd.sha256
         FROM kyb_documents kd LEFT JOIN join_requests jr ON jr.id = kd.join_request_id
         WHERE kd.join_request_id IS NULL OR jr.status::text <> 'DRAFT'",
    )
    .fetch_all(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let duplicate_rows = sqlx::query(
        "SELECT sha256 FROM kyb_documents GROUP BY sha256 HAVING COUNT(DISTINCT merchant_id) > 1",
    )
    .fetch_all(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let duplicate_hashes: std::collections::BTreeSet<String> = duplicate_rows
        .iter()
        .map(|row| text(row, "sha256"))
        .collect();
    let mut by_status: Map<String, Value> = Map::new();
    let mut by_av: Map<String, Value> = Map::new();
    let mut by_doc: Map<String, Value> = Map::new();
    let mut expiring_soon = 0i64;
    let mut expired = 0i64;
    let mut duplicates = 0i64;
    for row in &rows {
        let status = text(row, "status");
        let av = text(row, "av_status");
        let doc = text(row, "doc_type");
        let count = by_status.get(&status).and_then(Value::as_i64).unwrap_or(0);
        by_status.insert(status, Value::from(count + 1));
        let count = by_av.get(&av).and_then(Value::as_i64).unwrap_or(0);
        by_av.insert(av, Value::from(count + 1));
        let count = by_doc.get(&doc).and_then(Value::as_i64).unwrap_or(0);
        by_doc.insert(doc, Value::from(count + 1));
        if duplicate_hashes.contains(&text(row, "sha256")) {
            duplicates += 1;
        }
        if let Some(expires) = super::support::date(row, "expires_on") {
            if expires < now {
                expired += 1;
            } else if (expires - now).num_days() <= KYB_EXPIRY_WARNING_DAYS {
                expiring_soon += 1;
            }
        }
    }
    Ok(json!({
        "summary": {
            "total": rows.len(),
            "pending": by_status.get("UPLOADED").cloned().unwrap_or(Value::from(0)),
            "accepted": by_status.get("ACCEPTED").cloned().unwrap_or(Value::from(0)),
            "rejected": by_status.get("REJECTED").cloned().unwrap_or(Value::from(0)),
            "expired": expired,
            "infected": by_av.get("INFECTED").cloned().unwrap_or(Value::from(0)),
            "scanning": by_av.get("PENDING").cloned().unwrap_or(Value::from(0)),
            "duplicates": duplicates,
            "expiringSoon": expiring_soon,
            "byStatus": by_status,
            "byAvStatus": by_av,
            "byDocType": by_doc,
        }
    }))
}

pub(super) async fn kyb_detail(
    state: &AppState,
    request: &HttpRequest,
    _principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let id = require_uuid_param(
        super::support::last_path_segment(request).as_deref(),
        "KYB_DOCUMENT_NOT_FOUND",
        "The KYB document does not exist",
    )?;
    let row = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {KYB_PROJECTION} FROM {KYB_FROM} WHERE kd.id = $1"
    )))
    .bind(super::support::uuid_bind(&id))
    .fetch_optional(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let Some(row) = row else {
        return Err(ApiError::new(
            404,
            "KYB_DOCUMENT_NOT_FOUND",
            "The KYB document does not exist",
        ));
    };
    let hashes = vec![text(&row, "sha256")];
    let duplicates = duplicate_map(state, &hashes).await?;
    let audit = audit_trail(state, "KYB_DOCUMENT", &id, 100).await?;
    let revalidations = sqlx::query(
        "SELECT id, doc_type::text AS doc_type, reason_code, message, status::text AS status,
                requested_at, due_at, fulfilled_at, resolution_notes
         FROM kyb_revalidation_requests WHERE document_id = $1 ORDER BY requested_at DESC",
    )
    .bind(super::support::uuid_bind(&id))
    .fetch_all(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let mut document = kyb_row(&row, &duplicates);
    if let Some(object) = document.as_object_mut() {
        object.insert(
            "openRevalidations".to_owned(),
            Value::Array(
                revalidations
                    .iter()
                    .map(|entry| {
                        json!({
                            "id": uuid_json(entry, "id"),
                            "docType": text(entry, "doc_type"),
                            "reasonCode": text(entry, "reason_code"),
                            "message": text(entry, "message"),
                            "status": text(entry, "status"),
                            "requestedAt": ts_json(entry, "requested_at"),
                            "dueAt": ts_json(entry, "due_at"),
                            "fulfilledAt": ts_json(entry, "fulfilled_at"),
                            "resolutionNotes": super::support::text_value(entry, "resolution_notes"),
                        })
                    })
                    .collect(),
            ),
        );
        object.insert("auditTrail".to_owned(), audit);
        object.insert("reviewReasonCodes".to_owned(), json!(KYB_REJECTION_REASONS));
    }
    Ok(json!({ "kybDocument": document }))
}

// ---------------------------------------------------------------- handlers

fn join_list_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move { result_response(request, join_list(state, request, principal).await) })
}

fn join_export_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move { result_response(request, join_export(state, request, principal).await) })
}

fn join_summary_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    _principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move { result_response(request, join_summary_value(state).await) })
}

fn join_summary_export_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    _principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = join_summary_value(state).await.map(|mut value| {
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

fn join_detail_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move { result_response(request, join_detail(state, request, principal).await) })
}

fn kyb_list_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move { result_response(request, kyb_list(state, request, principal).await) })
}

fn kyb_export_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move { result_response(request, kyb_export(state, request, principal).await) })
}

fn kyb_summary_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    _principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move { result_response(request, kyb_summary_value(state).await) })
}

fn kyb_summary_export_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    _principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = kyb_summary_value(state).await.map(|mut value| {
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

fn kyb_detail_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move { result_response(request, kyb_detail(state, request, principal).await) })
}

fn result_response(request: &HttpRequest, result: Result<Value, ApiError>) -> HttpResponse {
    match result {
        Ok(value) => json_ok(&value),
        Err(error) => crate::http::error_response(request, error),
    }
}

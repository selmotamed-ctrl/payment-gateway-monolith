//! Admin operator-case reads and the case-type catalog.
//!
//! Sources: `core-back/api/internal/admin.ts` (`/operator-cases*`) and
//! `core-back/lib/operatorCases/caseCatalog.ts`. The catalog is code-owned in TS and is reproduced
//! here with the same 66 types, defaults, confidentiality classes and action sets. The list applies
//! the same search/state/kind/case-type/priority/assignee/SLA filters and hides AML-confidential
//! cases from callers without `aml:read`/`aml:write`, COMPLIANCE or MLRO. A case detail additionally
//! refuses an AML case with `403 CASE_CONFIDENTIAL`.
//!
//! The `attempt`/`reconciliationItem` sub-objects carry the fields the case table and drawer need;
//! the 20-relation attempt include of the TS drawer is served by the dedicated attempt detail route,
//! so it is not duplicated here.

#![forbid(unsafe_code)]

use std::sync::OnceLock;

use chrono::{Datelike, Utc};
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
    age_hours, build_list, count_always, export_envelope, fetch_list, has_confidential_aml_access,
    list_envelope, money_opt, require_uuid_param, text, timestamp, ts_json, uuid_json, ExtraFilter,
};
use pg_http::{Authn, BodyRule, Channel, Policy};

const ATTEMPT_ACTIONS: &[&str] = &[
    "ACKNOWLEDGE",
    "OPEN_SOURCE",
    "INQUIRE",
    "MARK_SUCCEEDED",
    "MARK_FAILED",
    "CLOSE_CASE",
];
const RECON_ACTIONS: &[&str] = &["ACKNOWLEDGE", "OPEN_SOURCE", "CLOSE_CASE"];
const OPERATIONS_ACTIONS: &[&str] = &["ACKNOWLEDGE", "OPEN_SOURCE", "CLOSE_CASE"];
const LEDGER_ACTIONS: &[&str] = &["ACKNOWLEDGE", "OPEN_SOURCE", "CLOSE_CASE"];
const LEGACY_ACTIONS: &[&str] = &["ACKNOWLEDGE", "CLOSE_CASE"];

const RESOLUTION_CODES: &[&str] = &[
    "FIXED_AT_SOURCE",
    "FALSE_POSITIVE",
    "DUPLICATE",
    "ACCEPTED_RISK",
    "REFERRED",
    "NO_ACTION_REQUIRED",
    "SOURCE_CLEARED",
    "OTHER",
];

/// One code-owned case type.
#[derive(Debug, Clone, Copy)]
pub struct CaseDef {
    pub code: &'static str,
    pub group: &'static str,
    pub domain: &'static str,
    pub source: &'static str,
    pub subject_type: &'static str,
    pub priority: &'static str,
    pub sla_hours: i64,
    pub auto_clear: bool,
    pub confidentiality: &'static str,
    pub actions: &'static [&'static str],
}

fn base(
    code: &'static str,
    group: &'static str,
    domain: &'static str,
    source: &'static str,
    subject_type: &'static str,
) -> CaseDef {
    CaseDef {
        code,
        group,
        domain,
        source,
        subject_type,
        priority: if matches!(source, "PLATFORM_MONITOR" | "ROUTE_HEALTH") {
            "P2"
        } else {
            "P1"
        },
        sla_hours: 4,
        auto_clear: false,
        confidentiality: "NORMAL",
        actions: OPERATIONS_ACTIONS,
    }
}

/// The catalog definitions (`defs` in `caseCatalog.ts`).
#[must_use]
pub fn catalog_definitions() -> &'static [CaseDef] {
    static DEFINITIONS: OnceLock<Vec<CaseDef>> = OnceLock::new();
    DEFINITIONS.get_or_init(build_definitions)
}

fn build_definitions() -> Vec<CaseDef> {
    let mut defs = Vec::new();
    macro_rules! def {
        ($code:literal, $group:literal, $domain:literal, $source:literal, $subject:literal $(, $field:ident : $value:expr)*) => {
            defs.push(CaseDef {
                $($field: $value,)*
                ..base($code, $group, $domain, $source, $subject)
            });
        };
    }
    // Payment attempts / engine.
    def!("ATTEMPT_UNKNOWN", "PAYMENTS", "PAYMENTS", "ENGINE", "PAYMENT_ATTEMPT", actions: ATTEMPT_ACTIONS);
    def!("ATTEMPT_CONFLICT", "PAYMENTS", "PAYMENTS", "ENGINE", "PAYMENT_ATTEMPT", confidentiality: "CONFIDENTIAL", actions: ATTEMPT_ACTIONS);
    def!("ATTEMPT_LATE_SUCCESS", "PAYMENTS", "PAYMENTS", "ENGINE", "PAYMENT_ATTEMPT", priority: "P2", sla_hours: 24, actions: ATTEMPT_ACTIONS);
    def!("ATTEMPT_HELD", "PAYMENTS", "COMPLIANCE", "ENGINE", "PAYMENT_ATTEMPT", confidentiality: "AML", actions: ATTEMPT_ACTIONS);
    def!("ATTEMPT_MANUAL_REVIEW", "PAYMENTS", "PAYMENTS", "ENGINE", "PAYMENT_ATTEMPT", actions: ATTEMPT_ACTIONS);
    def!("ATTEMPT_INBOUND_FAILURE", "PAYMENTS", "PAYMENTS", "ENGINE", "PAYMENT_ATTEMPT", priority: "P2", sla_hours: 24, actions: ATTEMPT_ACTIONS);
    def!("ATTEMPT_SUSPENSE", "PAYMENTS", "FINANCE", "ENGINE", "PAYMENT_ATTEMPT", actions: ATTEMPT_ACTIONS);
    // Reconciliation.
    def!("RECON_AMOUNT_MISMATCH", "RECONCILIATION", "FINANCE", "RECONCILIATION", "RECONCILIATION_ITEM", priority: "P2", sla_hours: 24, actions: RECON_ACTIONS);
    def!("RECON_MISSING_AT_GATEWAY", "RECONCILIATION", "FINANCE", "RECONCILIATION", "RECONCILIATION_ITEM", priority: "P2", sla_hours: 24, actions: RECON_ACTIONS);
    def!("RECON_MISSING_LOCALLY", "RECONCILIATION", "FINANCE", "RECONCILIATION", "RECONCILIATION_ITEM", priority: "P2", sla_hours: 24, actions: RECON_ACTIONS);
    def!("RECON_DUPLICATE", "RECONCILIATION", "FINANCE", "RECONCILIATION", "RECONCILIATION_ITEM", priority: "P2", sla_hours: 24, actions: RECON_ACTIONS);
    def!("RECON_UNMATCHED_STATEMENT", "RECONCILIATION", "FINANCE", "RECONCILIATION", "RECONCILIATION_ITEM", priority: "P2", sla_hours: 24, actions: RECON_ACTIONS);
    def!("RECON_ITEM_EXCEPTION", "RECONCILIATION", "FINANCE", "RECONCILIATION", "RECONCILIATION_ITEM", priority: "P2", sla_hours: 24, actions: RECON_ACTIONS);
    def!("RECON_OVERFLOW", "RECONCILIATION", "FINANCE", "RECONCILIATION", "RECONCILIATION_RUN", priority: "P2", sla_hours: 24, actions: RECON_ACTIONS);
    // Platform monitor.
    def!("BACKUP_FAILED", "PLATFORM", "OPERATIONS", "PLATFORM_MONITOR", "BACKUP_TARGET", auto_clear: true);
    def!("BACKUP_DAEMON", "PLATFORM", "OPERATIONS", "PLATFORM_MONITOR", "BACKUP_DAEMON", auto_clear: true);
    def!("BACKUP_UNHEALTHY", "PLATFORM", "OPERATIONS", "PLATFORM_MONITOR", "BACKUP_DAEMON", auto_clear: true);
    def!("BACKUP_WAL_LAG", "PLATFORM", "OPERATIONS", "PLATFORM_MONITOR", "BACKUP_WAL", auto_clear: true);
    def!("BACKUP_STALE", "PLATFORM", "OPERATIONS", "PLATFORM_MONITOR", "BACKUP_TARGET", auto_clear: true);
    def!("BACKUP_DRILL_FAILED", "PLATFORM", "OPERATIONS", "PLATFORM_MONITOR", "BACKUP_DRILL", auto_clear: true);
    def!("BACKUP_DRILL_STALE", "PLATFORM", "OPERATIONS", "PLATFORM_MONITOR", "BACKUP_DRILL", priority: "P2", sla_hours: 24, auto_clear: true);
    def!("BACKUP_ALERT", "PLATFORM", "OPERATIONS", "PLATFORM_MONITOR", "BACKUP_DAEMON", auto_clear: true);
    def!("WORKER_STALE", "PLATFORM", "OPERATIONS", "PLATFORM_MONITOR", "WORKER", auto_clear: true);
    def!("CHECKPOINT_STALE", "PLATFORM", "FINANCE", "PLATFORM_MONITOR", "GL_ACCOUNT_SHARD", priority: "P2", sla_hours: 24, auto_clear: true);
    def!("OUTBOX_AGE", "PLATFORM", "OPERATIONS", "PLATFORM_MONITOR", "OUTBOX_TOPIC", auto_clear: true);
    def!("AUDIT_OUTBOX_AGE", "PLATFORM", "SECURITY", "PLATFORM_MONITOR", "AUDIT_OUTBOX", auto_clear: true);
    def!("BACKGROUND_JOB_AGE", "PLATFORM", "OPERATIONS", "PLATFORM_MONITOR", "BACKGROUND_JOB_QUEUE", auto_clear: true);
    def!("KYB_SCAN_BACKLOG", "PLATFORM", "COMPLIANCE", "PLATFORM_MONITOR", "KYB_SCAN", priority: "P2", sla_hours: 24, auto_clear: true, confidentiality: "CONFIDENTIAL");
    def!("JOURNAL_DEFAULT_ROWS", "PLATFORM", "FINANCE", "PLATFORM_MONITOR", "LEDGER", auto_clear: true);
    def!("CERT_EXPIRY", "PLATFORM", "SECURITY", "PLATFORM_MONITOR", "CERTIFICATE", auto_clear: true);
    def!("REDIS_UNREACHABLE", "PLATFORM", "OPERATIONS", "PLATFORM_MONITOR", "REDIS", priority: "P2", sla_hours: 24, auto_clear: true);
    def!("STALE_UNKNOWN_BACKLOG", "PLATFORM", "PAYMENTS", "PLATFORM_MONITOR", "PAYMENT_ATTEMPT", auto_clear: true);
    def!("REFUND_UNSCHEDULED", "PLATFORM", "FINANCE", "PLATFORM_MONITOR", "ADJUSTMENT", auto_clear: true);
    def!("OBJECT_STORAGE", "PLATFORM", "OPERATIONS", "PLATFORM_MONITOR", "OBJECT_STORAGE", auto_clear: true);
    def!("MONITOR_CHECK_FAILED", "PLATFORM", "OPERATIONS", "PLATFORM_MONITOR", "PLATFORM_CHECK", priority: "P2", sla_hours: 24, auto_clear: true);
    def!("PLATFORM_ALERT", "PLATFORM", "OPERATIONS", "PLATFORM_MONITOR", "PLATFORM_CHECK", auto_clear: true);
    def!("COMMUNICATION_UNCONFIGURED", "PLATFORM", "OPERATIONS", "PLATFORM_MONITOR", "COMMUNICATION_CHANNEL", auto_clear: true);
    // Route health.
    def!("ROUTE_HEALTH", "ROUTE_HEALTH", "GATEWAY", "ROUTE_HEALTH", "RAIL_ROUTE", auto_clear: true);
    def!("ROUTE_OVERRIDE", "ROUTE_HEALTH", "GATEWAY", "ROUTE_HEALTH", "RAIL_ROUTE", auto_clear: true);
    def!("ROUTE_OVERRIDE_REVIEW", "ROUTE_HEALTH", "GATEWAY", "ROUTE_HEALTH", "RAIL_ROUTE", priority: "P2", sla_hours: 24, auto_clear: true);
    def!("ROUTE_OVERRIDE_CONFLICT", "ROUTE_HEALTH", "GATEWAY", "ROUTE_HEALTH", "RAIL_ROUTE", priority: "P2", sla_hours: 24, auto_clear: true);
    // Deadlines.
    def!("REPORT_OVERDUE", "DEADLINES", "COMPLIANCE", "DEADLINE", "REGULATORY_REPORT", auto_clear: true, confidentiality: "CONFIDENTIAL");
    def!("AML_SLA_BREACH", "DEADLINES", "COMPLIANCE", "DEADLINE", "AML_CASE", confidentiality: "AML");
    def!("DISPUTE_EXPIRED", "DEADLINES", "FINANCE", "DEADLINE", "DISPUTE", priority: "P2", sla_hours: 24, confidentiality: "CONFIDENTIAL");
    def!("DISPUTE_RULING_OVERDUE", "DEADLINES", "FINANCE", "DEADLINE", "DISPUTE", priority: "P2", sla_hours: 24, confidentiality: "CONFIDENTIAL");
    def!("CASHOUT_SLA", "DEADLINES", "FINANCE", "DEADLINE", "CASHOUT", priority: "P2", sla_hours: 24);
    def!("EMERGENCY_UNRATIFIED", "DEADLINES", "COMPLIANCE", "DEADLINE", "APPROVAL_REQUEST", confidentiality: "CONFIDENTIAL");
    def!("EMERGENCY_LIFTED", "DEADLINES", "COMPLIANCE", "DEADLINE", "APPROVAL_REQUEST", confidentiality: "CONFIDENTIAL");
    // Credentials / KYB.
    def!(
        "CREDENTIAL_EXPIRING",
        "CREDENTIALS_KYB",
        "GATEWAY",
        "PLATFORM_MONITOR",
        "CREDENTIAL_SET"
    );
    def!(
        "CREDENTIAL_EXPIRED",
        "CREDENTIALS_KYB",
        "GATEWAY",
        "PLATFORM_MONITOR",
        "CREDENTIAL_SET"
    );
    def!(
        "CREDENTIAL_FAILING",
        "CREDENTIALS_KYB",
        "GATEWAY",
        "PLATFORM_MONITOR",
        "CREDENTIAL_SET"
    );
    def!("KYB_INFECTED", "CREDENTIALS_KYB", "COMPLIANCE", "KYB", "KYB_DOCUMENT", confidentiality: "CONFIDENTIAL");
    def!("KYB_SCAN_FAILED", "CREDENTIALS_KYB", "COMPLIANCE", "KYB", "KYB_DOCUMENT", priority: "P2", sla_hours: 24, confidentiality: "CONFIDENTIAL");
    // Ledger / consistency.
    def!("LEDGER_INVARIANT", "LEDGER", "FINANCE", "LEDGER", "LEDGER", actions: LEDGER_ACTIONS);
    def!("LEDGER_SHARD", "LEDGER", "FINANCE", "LEDGER", "GL_ACCOUNT_SHARD", actions: LEDGER_ACTIONS);
    def!("LEDGER_PARTITION", "LEDGER", "FINANCE", "LEDGER", "LEDGER", actions: LEDGER_ACTIONS);
    def!("COMMISSION_RECEIVABLE_AGED", "LEDGER", "FINANCE", "LEDGER", "MERCHANT", actions: LEDGER_ACTIONS);
    def!("LINK_SLOT_DRIFT", "LEDGER", "OPERATIONS", "LEDGER", "PAYMENT_LINK", priority: "P3", sla_hours: 72, actions: LEDGER_ACTIONS);
    def!("OUTBOX_PARKED", "LEDGER", "OPERATIONS", "LEDGER", "OUTBOX_TOPIC", actions: LEDGER_ACTIONS);
    def!("REFUND_INQUIRY", "LEDGER", "FINANCE", "LEDGER", "ADJUSTMENT", actions: LEDGER_ACTIONS);
    // Statements / audit / report scope.
    def!("STATEMENT_MISSING", "STATEMENTS", "FINANCE", "PLATFORM_MONITOR", "STATEMENT_SOURCE", priority: "P2", sla_hours: 24, auto_clear: true);
    def!("STATEMENT_SCHEDULE_INVALID", "STATEMENTS", "FINANCE", "PLATFORM_MONITOR", "STATEMENT_SOURCE", priority: "P3", sla_hours: 72, auto_clear: true);
    def!("AUDIT_ANCHOR_INVALID", "SECURITY", "SECURITY", "SECURITY", "AUDIT_CHAIN", confidentiality: "CONFIDENTIAL");
    def!("AUDIT_CHAIN_REWRITTEN", "SECURITY", "SECURITY", "SECURITY", "AUDIT_CHAIN", confidentiality: "CONFIDENTIAL");
    def!("AUDIT_CHAIN_BROKEN", "SECURITY", "SECURITY", "SECURITY", "AUDIT_CHAIN", confidentiality: "CONFIDENTIAL");
    def!("REPORT_SCOPE_VIOLATION", "SECURITY", "SECURITY", "SECURITY", "MERCHANT_REPORT", confidentiality: "CONFIDENTIAL");
    def!("LEGACY_UNCLASSIFIED", "LEGACY", "OPERATIONS", "LEGACY", "CASE", priority: "P3", sla_hours: 72, actions: LEGACY_ACTIONS);
    defs
}

/// A catalog definition by code.
#[must_use]
pub fn definition(code: &str) -> Option<&'static CaseDef> {
    catalog_definitions()
        .iter()
        .find(|entry| entry.code == code)
}

/// TS `caseTypeForSubjectKey` for rows written before the taxonomy columns existed.
#[must_use]
pub fn case_type_for(
    subject_key: &str,
    kind: &str,
    has_attempt: bool,
    has_reconciliation_item: bool,
    notes: &str,
) -> &'static CaseDef {
    let key = subject_key;
    let notes = notes.to_ascii_lowercase();
    let direct = [
        ("platform.backup:backup-failed", "BACKUP_FAILED"),
        ("platform.backup:backup-stale", "BACKUP_STALE"),
        ("platform.backup:daemon", "BACKUP_DAEMON"),
        ("platform.backup:unhealthy", "BACKUP_UNHEALTHY"),
        ("platform.backup:wal-lag", "BACKUP_WAL_LAG"),
        ("platform.backup:drill-failed", "BACKUP_DRILL_FAILED"),
        ("platform.backup:drill-stale", "BACKUP_DRILL_STALE"),
        ("platform.backup:", "BACKUP_ALERT"),
        ("platform.worker_stale", "WORKER_STALE"),
        ("platform.checkpoint_stale", "CHECKPOINT_STALE"),
        ("platform.outbox_age", "OUTBOX_AGE"),
        ("platform.audit_outbox_age", "AUDIT_OUTBOX_AGE"),
        ("platform.background_job_age", "BACKGROUND_JOB_AGE"),
        ("platform.kyb_scan_backlog", "KYB_SCAN_BACKLOG"),
        ("platform.journal_default_rows", "JOURNAL_DEFAULT_ROWS"),
        ("platform.cert_expiry", "CERT_EXPIRY"),
        ("platform.redis_unreachable", "REDIS_UNREACHABLE"),
        ("platform.stale_unknown", "STALE_UNKNOWN_BACKLOG"),
        ("platform.refund_unscheduled", "REFUND_UNSCHEDULED"),
        ("platform.object_storage", "OBJECT_STORAGE"),
        ("platform.communication", "COMMUNICATION_UNCONFIGURED"),
        ("platform.monitor_check_failed", "MONITOR_CHECK_FAILED"),
        ("platform.", "PLATFORM_ALERT"),
        ("report.overdue", "REPORT_OVERDUE"),
        ("aml.sla_breached", "AML_SLA_BREACH"),
        ("dispute.expired", "DISPUTE_EXPIRED"),
        ("dispute.ruling_overdue", "DISPUTE_RULING_OVERDUE"),
        ("cashout.sla", "CASHOUT_SLA"),
        ("emergency.unratified", "EMERGENCY_UNRATIFIED"),
        ("emergency.lifted", "EMERGENCY_LIFTED"),
        ("route.health.override_review", "ROUTE_OVERRIDE_REVIEW"),
        ("route.health.override_conflict", "ROUTE_OVERRIDE_CONFLICT"),
        ("route.health.override", "ROUTE_OVERRIDE"),
        ("route.health", "ROUTE_HEALTH"),
        ("credential.expiring", "CREDENTIAL_EXPIRING"),
        ("credential.expired", "CREDENTIAL_EXPIRED"),
        ("credential.failing", "CREDENTIAL_FAILING"),
        ("kyb-infected", "KYB_INFECTED"),
        ("kyb-scan-failed", "KYB_SCAN_FAILED"),
        ("ledger.invariant", "LEDGER_INVARIANT"),
        ("ledger.shard", "LEDGER_SHARD"),
        ("ledger.partition", "LEDGER_PARTITION"),
        ("commission.receivable.aged", "COMMISSION_RECEIVABLE_AGED"),
        ("link.slot_drift", "LINK_SLOT_DRIFT"),
        ("outbox.parked", "OUTBOX_PARKED"),
        ("refund.inquiry", "REFUND_INQUIRY"),
        ("statement.missing", "STATEMENT_MISSING"),
        ("statement.schedule_invalid", "STATEMENT_SCHEDULE_INVALID"),
        ("audit.anchor_invalid", "AUDIT_ANCHOR_INVALID"),
        ("audit.chain_rewritten", "AUDIT_CHAIN_REWRITTEN"),
        ("audit.chain_broken", "AUDIT_CHAIN_BROKEN"),
        ("merchant_report_scope", "REPORT_SCOPE_VIOLATION"),
        ("attempt.unknown", "ATTEMPT_UNKNOWN"),
        ("recon.overflow", "RECON_OVERFLOW"),
    ];
    for (prefix, code) in direct {
        if key.starts_with(prefix) {
            return definition(code).unwrap_or_else(legacy);
        }
    }
    if key.starts_with("recon.item") {
        let code = if notes.contains("duplicate") {
            "RECON_DUPLICATE"
        } else if notes.contains("missing at gateway") {
            "RECON_MISSING_AT_GATEWAY"
        } else if notes.contains("missing locally") || notes.contains("local only") {
            "RECON_MISSING_LOCALLY"
        } else if notes.contains("unmatched") || notes.contains("only in statement") {
            "RECON_UNMATCHED_STATEMENT"
        } else {
            "RECON_AMOUNT_MISMATCH"
        };
        return definition(code).unwrap_or_else(legacy);
    }
    let normalized_kind = kind.to_ascii_uppercase();
    if has_attempt {
        let code = match normalized_kind.as_str() {
            "CONFLICT" => "ATTEMPT_CONFLICT",
            "LATE_SUCCESS" => "ATTEMPT_LATE_SUCCESS",
            "HELD" => "ATTEMPT_HELD",
            "UNKNOWN" => "ATTEMPT_UNKNOWN",
            "MISMATCH" => "ATTEMPT_SUSPENSE",
            "UNMATCHED_STATEMENT" => "RECON_UNMATCHED_STATEMENT",
            _ => "ATTEMPT_MANUAL_REVIEW",
        };
        return definition(code).unwrap_or_else(legacy);
    }
    if has_reconciliation_item {
        return definition("RECON_ITEM_EXCEPTION").unwrap_or_else(legacy);
    }
    legacy()
}

fn legacy() -> &'static CaseDef {
    static LEGACY: CaseDef = CaseDef {
        code: "LEGACY_UNCLASSIFIED",
        group: "LEGACY",
        domain: "OPERATIONS",
        source: "LEGACY",
        subject_type: "CASE",
        priority: "P3",
        sla_hours: 72,
        auto_clear: false,
        confidentiality: "NORMAL",
        actions: LEGACY_ACTIONS,
    };
    definition("LEGACY_UNCLASSIFIED").unwrap_or(&LEGACY)
}

/// `caseReference`: `CASE-<year>-<5 digits>`.
#[must_use]
pub fn case_reference(case_number: i32, created_at: Option<chrono::NaiveDateTime>) -> String {
    let year = created_at.map_or(0, |value| value.year());
    format!("CASE-{year}-{case_number:05}")
}

/// One action definition (`ACTION_DEFINITIONS`).
#[must_use]
pub fn action_definitions() -> Value {
    json!({
        "ACKNOWLEDGE": {"code": "ACKNOWLEDGE", "labelKey": "operatorCase.action.ACKNOWLEDGE", "requiresApproval": false, "fields": ["notes"]},
        "OPEN_SOURCE": {"code": "OPEN_SOURCE", "labelKey": "operatorCase.action.OPEN_SOURCE", "requiresApproval": false},
        "INQUIRE": {"code": "INQUIRE", "labelKey": "operatorCase.action.INQUIRE", "requiresApproval": false, "fields": ["reason", "notes"]},
        "MARK_SUCCEEDED": {"code": "MARK_SUCCEEDED", "labelKey": "operatorCase.action.MARK_SUCCEEDED", "requiresApproval": true, "fields": ["providerReference", "settledAmount", "reason", "notes"]},
        "MARK_FAILED": {"code": "MARK_FAILED", "labelKey": "operatorCase.action.MARK_FAILED", "requiresApproval": true, "fields": ["reason", "notes"]},
        "CLOSE_CASE": {"code": "CLOSE_CASE", "labelKey": "operatorCase.action.CLOSE_CASE", "requiresApproval": true, "fields": ["resolutionCode", "reference", "reason", "notes"]},
    })
}

/// Routes owned by this module.
#[must_use]
pub fn routes() -> Vec<MountedRoute> {
    vec![
        route(
            "/internal/admin/operator-cases",
            "core-back/api/internal/admin.ts:11640",
            list_handler,
        ),
        route(
            "/internal/admin/operator-cases/export",
            "core-back/api/internal/admin.ts:11693",
            export_handler,
        ),
        route(
            "/internal/admin/operator-cases/summary",
            "core-back/api/internal/admin.ts:11829",
            summary_handler,
        ),
        route(
            "/internal/admin/operator-cases/summary/export",
            "core-back/api/internal/admin.ts:11834",
            summary_export_handler,
        ),
        route(
            "/internal/admin/operator-cases/catalog",
            "core-back/api/internal/admin.ts:12154",
            catalog_handler,
        ),
        route(
            "/internal/admin/operator-cases/:id",
            "core-back/api/internal/admin.ts:12174",
            detail_handler,
        ),
    ]
}

fn route(path: &str, origin: &str, handler: crate::routes::CustomHandler) -> MountedRoute {
    MountedRoute {
        policy: Policy::new("GET", path, Channel::Admin, Authn::Session, origin)
            .authorities(&["case:read", "operator:read"])
            .body(BodyRule::None),
        handler: Handler::Custom(handler),
        guard: PrincipalGuard::Staff,
    }
}

fn columns() -> ColumnMap {
    ColumnMap::new()
        .with("id", "oc.id", ColumnKind::Uuid)
        .with("idText", "oc.id::text", ColumnKind::Text)
        .with("caseType", "oc.case_type", ColumnKind::Text)
        .with("titleText", "oc.title_text", ColumnKind::Text)
        .with("summary", "oc.summary", ColumnKind::Text)
        .with("subjectLabel", "oc.subject_label", ColumnKind::Text)
        .with("reference", "pa.reference", ColumnKind::Text)
        .with(
            "providerReference",
            "pa.provider_reference",
            ColumnKind::Text,
        )
        .with("merchantTradeName", "m.trade_name", ColumnKind::Text)
        .with("merchantLegalName", "m.legal_name", ColumnKind::Text)
        .with("ourReference", "ri.our_reference", ColumnKind::Text)
        .with(
            "reconProviderReference",
            "ri.provider_reference",
            ColumnKind::Text,
        )
        .with("state", "oc.state::text", ColumnKind::Text)
        .with("kind", "oc.kind::text", ColumnKind::Text)
        .with("priority", "oc.priority::text", ColumnKind::Text)
        .with("assigneeUserId", "oc.assignee_user_id", ColumnKind::Uuid)
        .with("createdAt", "oc.created_at", ColumnKind::Timestamp)
        .with("slaDueAt", "oc.sla_due_at", ColumnKind::Timestamp)
}

fn spec() -> ListSpec {
    ListSpec::default()
        .with_search(&[
            "idText",
            "caseType",
            "titleText",
            "summary",
            "subjectLabel",
            "reference",
            "providerReference",
            "merchantTradeName",
            "merchantLegalName",
            "ourReference",
            "reconProviderReference",
        ])
        .with_contains(
            "caseRef",
            &[
                "idText",
                "reference",
                "ourReference",
                "reconProviderReference",
            ],
        )
        .with_contains("merchantName", &["merchantTradeName", "merchantLegalName"])
        .with_contains(
            "providerReference",
            &["providerReference", "reconProviderReference"],
        )
        .with_in("state", "state")
        .with_in("kind", "kind")
        .with_in("caseType", "caseType")
        .with_in("priority", "priority")
        .with_equals("assigneeUserId", "assigneeUserId")
        .with_date(DateFilter::new("createdAt", "createdAt"))
        .with_date(DateFilter::new("slaDueAt", "slaDueAt").with_keys("dateFrom", "dateTo"))
        .with_sortable("priority", "priority")
        .with_sortable("state", "state")
        .with_sortable("kind", "kind")
        .with_sortable("caseType", "caseType")
        .with_sortable("openedAt", "createdAt")
        .with_sortable("slaDueAt", "slaDueAt")
        .with_sortable("caseRef", "reference")
        .with_sortable("merchantName", "merchantTradeName")
        .with_default_sort("priority", SortDirection::Asc)
        .with_default_sort("createdAt", SortDirection::Desc)
}

const FROM: &str = "operator_cases oc
    LEFT JOIN payment_attempts pa ON pa.id = oc.attempt_id
    LEFT JOIN merchants m ON m.id = pa.merchant_id
    LEFT JOIN rails r ON r.id = pa.rail_id
    LEFT JOIN rail_routes rr ON rr.id = pa.route_id
    LEFT JOIN gateways g ON g.id = rr.gateway_id
    LEFT JOIN gateway_versions gv ON gv.id = pa.gateway_version_id
    LEFT JOIN gateway_settings gs ON gs.gateway_version_id = gv.id
    LEFT JOIN payment_links pl ON pl.id = pa.link_id
    LEFT JOIN reconciliation_items ri ON ri.id = oc.reconciliation_item_id
    LEFT JOIN users assignee ON assignee.id = oc.assignee_user_id
    LEFT JOIN users resolved_by ON resolved_by.id = oc.resolved_by_user_id
    LEFT JOIN approval_requests ap ON ap.id = oc.approval_request_id";

const PROJECTION: &str = "oc.*, oc.state::text AS state_text, oc.kind::text AS kind_text,
    oc.priority::text AS priority_text, pa.reference AS attempt_reference,
    pa.status::text AS attempt_status, pa.substatus AS attempt_substatus,
    pa.requested_amount, pa.total_charged_amount, pa.settled_amount, pa.currency,
    pa.provider_reference, pa.gateway_reference, pa.created_at AS attempt_created_at,
    pa.terminal_at, m.id AS merchant_id, m.trade_name, m.legal_name,
    m.status::text AS merchant_status, m.risk_tier::text AS merchant_risk_tier,
    pa.application_id, r.id AS rail_id, r.code AS rail_code, r.name_en AS rail_name_en,
    rr.id AS route_id, g.id AS gateway_id, g.code AS gateway_code, g.name AS gateway_name,
    COALESCE(gs.supports_status_check, false) AS supports_status_check,
    pl.id AS link_id, pl.key AS link_key, pl.state::text AS link_state,
    pl.use_count AS link_use_count, pl.confirmed_count AS link_confirmed_count,
    pl.active_locked_count AS link_active_locked_count, pl.infinite_use AS link_infinite_use,
    ri.id AS recon_id, ri.result::text AS recon_result, ri.our_reference,
    ri.provider_reference AS recon_provider_reference, ri.statement_amount, ri.statement_fee,
    assignee.email AS assignee_email, resolved_by.email AS resolved_by_email,
    ap.state::text AS approval_state, ap.id AS approval_id, ap.created_at AS approval_created_at,
    ap.subject_type AS approval_subject_type";

fn flatten(row: &sqlx::postgres::PgRow) -> Value {
    let case_number = row.try_get::<i32, _>("case_number").unwrap_or_default();
    let case_type_raw = super::support::opt_text(row, "case_type");
    let definition = case_type_raw
        .as_deref()
        .and_then(definition)
        .unwrap_or_else(|| {
            case_type_for(
                &super::support::opt_text(row, "subject_key").unwrap_or_default(),
                &text(row, "kind_text"),
                row.try_get::<Option<uuid::Uuid>, _>("attempt_id")
                    .ok()
                    .flatten()
                    .is_some(),
                row.try_get::<Option<uuid::Uuid>, _>("reconciliation_item_id")
                    .ok()
                    .flatten()
                    .is_some(),
                &super::support::opt_text(row, "summary").unwrap_or_default(),
            )
        });
    let attempt_status = super::support::opt_text(row, "attempt_status");
    let terminal_at = timestamp(row, "terminal_at");
    let supports = super::support::bool_value(row, "supports_status_check");
    let (eligible, reason) = inquiry_eligibility(
        Some(&text(row, "state_text")),
        attempt_status.as_deref(),
        terminal_at,
        supports,
    );
    let attempt_reference = super::support::opt_text(row, "attempt_reference");
    let our_reference = super::support::opt_text(row, "our_reference");
    let recon_provider = super::support::opt_text(row, "recon_provider_reference");
    let (subject_ref, subject_source) = if let Some(reference) = &attempt_reference {
        (reference.clone(), "ATTEMPT_REFERENCE")
    } else if let Some(reference) = &our_reference {
        (reference.clone(), "RECONCILIATION_OUR_REFERENCE")
    } else if let Some(reference) = &recon_provider {
        (reference.clone(), "RECONCILIATION_PROVIDER_REFERENCE")
    } else {
        (
            uuid_json(row, "id").as_str().unwrap_or_default().to_owned(),
            "CASE_ID",
        )
    };
    let created_at = timestamp(row, "created_at");
    let actions: Vec<Value> = definition
        .actions
        .iter()
        .filter(|action| {
            !matches!(**action, "INQUIRE" | "MARK_SUCCEEDED" | "MARK_FAILED")
                || attempt_reference.is_some()
        })
        .map(|action| {
            action_definitions()
                .get(*action)
                .cloned()
                .unwrap_or(Value::Null)
        })
        .collect();
    let mut object = Map::new();
    merge_object(
        &mut object,
        json!({
            "id": uuid_json(row, "id"),
            "caseId": uuid_json(row, "id"),
            "caseNumber": case_number,
            "caseRef": case_reference(case_number, created_at),
            "caseReference": case_reference(case_number, created_at),
            "caseReferenceSource": "CASE_NUMBER",
            "subjectRef": subject_ref,
            "subjectReferenceSource": subject_source,
            "caseType": definition.code,
            "caseTypeLabelKey": format!("operatorCase.type.{}", definition.code),
            "kind": text(row, "kind_text"),
            "caseGroup": definition.group,
            "domain": super::support::opt_text(row, "domain").unwrap_or_else(|| definition.domain.to_owned()),
            "source": super::support::opt_text(row, "source").unwrap_or_else(|| definition.source.to_owned()),
            "confidentiality": super::support::opt_text(row, "confidentiality").unwrap_or_else(|| definition.confidentiality.to_owned()),
            "titleKey": super::support::opt_text(row, "title_key").unwrap_or_else(|| format!("operatorCase.type.{}", definition.code)),
            "title": super::support::opt_text(row, "title_text").unwrap_or_default(),
            "titleText": super::support::opt_text(row, "title_text").unwrap_or_default(),
            "summary": super::support::opt_text(row, "summary").unwrap_or_default(),
            "detailsJson": super::support::jsonb_or_empty_object(row, "details_json"),
            "subjectType": super::support::opt_text(row, "subject_type").unwrap_or_else(|| definition.subject_type.to_owned()),
            "subjectId": super::support::text_value(row, "subject_id"),
            "subjectLabel": super::support::text_value(row, "subject_label"),
            "priority": text(row, "priority_text"),
            "state": text(row, "state_text"),
        }),
    );
    merge_object(
        &mut object,
        json!({
            "availableActions": actions,
            "resolutionCode": super::support::text_value(row, "resolution_code"),
            "resolutionSummary": super::support::text_value(row, "resolution_summary"),
            "resolutionNotes": super::support::text_value(row, "resolution_notes"),
            "resolvedAt": ts_json(row, "resolved_at"),
            "resolvedByEmail": super::support::text_value(row, "resolved_by_email"),
            "openedAt": ts_json(row, "created_at"),
            "slaDueAt": ts_json(row, "sla_due_at"),
            "ageHours": age_hours(created_at, Utc::now()),
            "merchantId": uuid_json(row, "merchant_id"),
            "merchantTradeName": super::support::opt_text(row, "trade_name").unwrap_or_default(),
            "merchantLegalName": super::support::opt_text(row, "legal_name").unwrap_or_default(),
            "merchantName": super::support::opt_text(row, "trade_name")
                .or_else(|| super::support::opt_text(row, "legal_name"))
                .unwrap_or_default(),
            "merchantStatus": super::support::text_value(row, "merchant_status"),
            "merchantRiskTier": super::support::text_value(row, "merchant_risk_tier"),
            "applicationId": uuid_json(row, "application_id"),
            "railId": uuid_json(row, "rail_id"),
            "railCode": super::support::opt_text(row, "rail_code").unwrap_or_default(),
            "railNameEn": super::support::opt_text(row, "rail_name_en").unwrap_or_default(),
            "gatewayId": uuid_json(row, "gateway_id"),
            "gatewayCode": super::support::opt_text(row, "gateway_code").unwrap_or_default(),
            "gatewayName": super::support::opt_text(row, "gateway_name").unwrap_or_default(),
            "routeId": uuid_json(row, "route_id"),
        }),
    );
    merge_object(
        &mut object,
        json!({
            "attemptId": uuid_json(row, "attempt_id"),
            "attemptReference": attempt_reference.clone(),
            "attemptStatus": attempt_status.clone(),
            "attemptSubstatus": super::support::text_value(row, "attempt_substatus"),
            "requestedAmount": money_opt(row, "requested_amount"),
            "chargedAmount": money_opt(row, "total_charged_amount"),
            "settledAmount": money_opt(row, "settled_amount"),
            "statementAmount": money_opt(row, "statement_amount"),
            "statementFee": money_opt(row, "statement_fee"),
            "currency": super::support::text_value(row, "currency"),
            "providerReference": super::support::opt_text(row, "provider_reference").or(recon_provider),
            "gatewayReference": super::support::text_value(row, "gateway_reference"),
            "linkSlot": if row.try_get::<Option<String>, _>("link_id").ok().flatten().is_some() {
                json!({
                    "id": uuid_json(row, "link_id"),
                    "key": text(row, "link_key"),
                    "state": super::support::text_value(row, "link_state"),
                    "useCount": super::support::int_json(row, "link_use_count"),
                    "confirmedCount": super::support::int_json(row, "link_confirmed_count"),
                    "activeLockedCount": super::support::int_json(row, "link_active_locked_count"),
                    "infiniteUse": super::support::bool_json(row, "link_infinite_use"),
                })
            } else {
                Value::Null
            },
            "reconciliationItemId": uuid_json(row, "reconciliation_item_id"),
            "reconciliationResult": super::support::text_value(row, "recon_result"),
            "approvalRequestId": uuid_json(row, "approval_request_id"),
            "approvalState": super::support::text_value(row, "approval_state"),
            "assigneeUserId": uuid_json(row, "assignee_user_id"),
            "assigneeEmail": super::support::text_value(row, "assignee_email"),
            "gatewaySupportsStatusCheck": supports,
            "inquiryEligibility": {"eligible": eligible, "reason": reason},
            "latestInquirySchedule": Value::Null,
        }),
    );
    merge_object(
        &mut object,
        json!({
            "attempt": if super::support::opt_text(row, "attempt_reference").is_some() {
                json!({
                    "id": uuid_json(row, "attempt_id"),
                    "reference": attempt_reference,
                    "status": attempt_status,
                    "substatus": super::support::text_value(row, "attempt_substatus"),
                    "requestedAmount": money_opt(row, "requested_amount"),
                    "totalChargedAmount": money_opt(row, "total_charged_amount"),
                    "settledAmount": money_opt(row, "settled_amount"),
                    "currency": super::support::text_value(row, "currency"),
                    "providerReference": super::support::text_value(row, "provider_reference"),
                    "gatewayReference": super::support::text_value(row, "gateway_reference"),
                    "createdAt": ts_json(row, "attempt_created_at"),
                    "terminalAt": ts_json(row, "terminal_at"),
                    "merchant": {
                        "id": uuid_json(row, "merchant_id"),
                        "tradeName": super::support::opt_text(row, "trade_name").unwrap_or_default(),
                        "legalName": super::support::opt_text(row, "legal_name").unwrap_or_default(),
                        "status": super::support::text_value(row, "merchant_status"),
                        "riskTier": super::support::text_value(row, "merchant_risk_tier"),
                    },
                    "rail": {
                        "id": uuid_json(row, "rail_id"),
                        "code": super::support::opt_text(row, "rail_code").unwrap_or_default(),
                        "nameEn": super::support::opt_text(row, "rail_name_en").unwrap_or_default(),
                    },
                    "route": {
                        "id": uuid_json(row, "route_id"),
                        "gateway": {
                            "id": uuid_json(row, "gateway_id"),
                            "code": super::support::opt_text(row, "gateway_code").unwrap_or_default(),
                            "name": super::support::opt_text(row, "gateway_name").unwrap_or_default(),
                        },
                    },
                    "link": if row.try_get::<Option<String>, _>("link_id").ok().flatten().is_some() {
                        json!({"id": uuid_json(row, "link_id"), "key": text(row, "link_key")})
                    } else {
                        Value::Null
                    },
                })
            } else {
                Value::Null
            },
        }),
    );
    merge_object(
        &mut object,
        json!({
            "reconciliationItem": if row.try_get::<Option<String>, _>("recon_id").ok().flatten().is_some() {
                json!({
                    "id": uuid_json(row, "recon_id"),
                    "result": super::support::text_value(row, "recon_result"),
                    "ourReference": super::support::opt_text(row, "our_reference").unwrap_or_default(),
                    "providerReference": super::support::opt_text(row, "recon_provider_reference").unwrap_or_default(),
                    "statementAmount": money_opt(row, "statement_amount"),
                    "statementFee": money_opt(row, "statement_fee"),
                })
            } else {
                Value::Null
            },
        }),
    );
    Value::Object(object)
}

fn merge_object(target: &mut Map<String, Value>, value: Value) {
    if let Value::Object(map) = value {
        target.extend(map);
    }
}

fn inquiry_eligibility(
    case_state: Option<&str>,
    attempt_status: Option<&str>,
    terminal_at: Option<chrono::NaiveDateTime>,
    supports_status_check: bool,
) -> (bool, String) {
    let case_state = case_state.unwrap_or_default().to_ascii_uppercase();
    if case_state == "RESOLVED" {
        return (false, "CASE_RESOLVED".to_owned());
    }
    if case_state == "PENDING_CHECKER" {
        return (false, "CASE_PENDING_CHECKER".to_owned());
    }
    let Some(status) = attempt_status else {
        return (false, "NO_ATTEMPT".to_owned());
    };
    if terminal_at.is_some() {
        return (false, "ATTEMPT_TERMINAL".to_owned());
    }
    if !matches!(
        status.to_ascii_uppercase().as_str(),
        "UNKNOWN" | "VERIFYING"
    ) {
        return (false, "ATTEMPT_NOT_INQUIRABLE".to_owned());
    }
    if !supports_status_check {
        return (false, "GATEWAY_HAS_NO_STATUS_INQUIRY".to_owned());
    }
    (true, "ELIGIBLE".to_owned())
}

fn visibility_extra(principal: Option<&Principal>, built: &pg_db::BuiltListQuery) -> ExtraFilter {
    let _ = built;
    if has_confidential_aml_access(principal) {
        ExtraFilter {
            sql: String::new(),
            binds: Vec::new(),
        }
    } else {
        ExtraFilter {
            sql: "oc.confidentiality <> 'AML'".to_owned(),
            binds: Vec::new(),
        }
    }
}

async fn list(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let built = build_list(request, &spec(), &columns())?;
    let extra = visibility_extra(principal, &built);
    let rows = fetch_list(&state.pools.main, &built, PROJECTION, FROM, Some(&extra)).await?;
    let total = count_always(&state.pools.main, &built, FROM, Some(&extra)).await?;
    let items: Vec<Value> = rows.iter().map(flatten).collect();
    let mut response = list_envelope("cases", Value::Array(items), Some(total), &built);
    response = super::support::with_cursor(response, &built, &rows, "created_at");
    Ok(response)
}

async fn export(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let built = build_list(request, &spec(), &columns())?;
    let extra = visibility_extra(principal, &built);
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
    let rows = query
        .fetch_all(&state.pools.main)
        .await
        .map_err(super::support::database_error)?;
    let total = count_always(&state.pools.main, &built, FROM, Some(&extra)).await?;
    let items: Vec<Value> = rows
        .iter()
        .map(|row| {
            let flattened = flatten(row);
            let eligibility = flattened
                .get("inquiryEligibility")
                .cloned()
                .unwrap_or(Value::Null);
            json!({
                "id": flattened.get("id").cloned().unwrap_or(Value::Null),
                "caseRef": flattened.get("caseRef").cloned().unwrap_or(Value::Null),
                "caseType": flattened.get("caseType").cloned().unwrap_or(Value::Null),
                "priority": flattened.get("priority").cloned().unwrap_or(Value::Null),
                "state": flattened.get("state").cloned().unwrap_or(Value::Null),
                "merchantName": flattened.get("merchantName").cloned().unwrap_or(Value::Null),
                "merchantStatus": flattened.get("merchantStatus").cloned().unwrap_or(Value::Null),
                "railCode": flattened.get("railCode").cloned().unwrap_or(Value::Null),
                "railName": flattened.get("railNameEn").cloned().unwrap_or(Value::Null),
                "gatewayCode": flattened.get("gatewayCode").cloned().unwrap_or(Value::Null),
                "gatewayName": flattened.get("gatewayName").cloned().unwrap_or(Value::Null),
                "attemptReference": flattened.get("attemptReference").cloned().unwrap_or(Value::Null),
                "attemptStatus": flattened.get("attemptStatus").cloned().unwrap_or(Value::Null),
                "amount": flattened.get("chargedAmount").cloned()
                    .filter(|value| !value.is_null())
                    .or_else(|| flattened.get("statementAmount").cloned())
                    .unwrap_or(Value::Null),
                "currency": flattened.get("currency").cloned().unwrap_or(Value::Null),
                "providerReference": flattened.get("providerReference").cloned().unwrap_or(Value::Null),
                "reconciliationResult": flattened.get("reconciliationResult").cloned().unwrap_or(Value::Null),
                "approvalState": flattened.get("approvalState").cloned().unwrap_or(Value::Null),
                "assigneeEmail": flattened.get("assigneeEmail").cloned().unwrap_or(Value::Null),
                "openedAt": flattened.get("openedAt").cloned().unwrap_or(Value::Null),
                "slaDueAt": flattened.get("slaDueAt").cloned().unwrap_or(Value::Null),
                "inquiryEligible": eligibility.get("eligible").cloned().unwrap_or(Value::Bool(false)),
                "inquiryReason": eligibility.get("reason").cloned().unwrap_or(Value::Null),
                "resolutionNotes": flattened.get("resolutionNotes").cloned().unwrap_or(Value::Null),
            })
        })
        .collect();
    Ok(export_envelope(
        "cases",
        Value::Array(items),
        total,
        rows.len(),
    ))
}

async fn summary_value(state: &AppState) -> Result<Value, ApiError> {
    let rows = sqlx::query(
        "SELECT state::text AS state, priority::text AS priority, sla_due_at, assignee_user_id
         FROM operator_cases",
    )
    .fetch_all(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let now = Utc::now().naive_utc();
    let mut by_state: Map<String, Value> = Map::new();
    let mut by_priority: Map<String, Value> = Map::new();
    let mut overdue = 0i64;
    let mut unassigned = 0i64;
    let mut p1_open = 0i64;
    for row in &rows {
        let state = text(row, "state");
        let priority = text(row, "priority");
        let count = by_state.get(&state).and_then(Value::as_i64).unwrap_or(0);
        by_state.insert(state.clone(), Value::from(count + 1));
        let count = by_priority
            .get(&priority)
            .and_then(Value::as_i64)
            .unwrap_or(0);
        by_priority.insert(priority.clone(), Value::from(count + 1));
        if uuid_json(row, "assignee_user_id").is_null() {
            unassigned += 1;
        }
        if state != "RESOLVED" && timestamp(row, "sla_due_at").is_some_and(|due| due < now) {
            overdue += 1;
        }
        if priority == "P1" && state != "RESOLVED" {
            p1_open += 1;
        }
    }
    Ok(json!({
        "summary": {
            "total": rows.len(),
            "open": by_state.get("OPEN").cloned().unwrap_or(Value::from(0)),
            "inProgress": by_state.get("IN_PROGRESS").cloned().unwrap_or(Value::from(0)),
            "pendingChecker": by_state.get("PENDING_CHECKER").cloned().unwrap_or(Value::from(0)),
            "resolved": by_state.get("RESOLVED").cloned().unwrap_or(Value::from(0)),
            "unassigned": unassigned,
            "overdue": overdue,
            "p1Open": p1_open,
            "byState": by_state,
            "byPriority": by_priority,
        }
    }))
}

pub(super) async fn detail(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let id = require_uuid_param(
        super::support::last_path_segment(request).as_deref(),
        "OPERATOR_CASE_NOT_FOUND",
        "The operator case does not exist",
    )?;
    let row = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {PROJECTION} FROM {FROM} WHERE oc.id = $1"
    )))
    .bind(super::support::uuid_bind(&id))
    .fetch_optional(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let Some(row) = row else {
        return Err(ApiError::new(
            404,
            "OPERATOR_CASE_NOT_FOUND",
            "The operator case does not exist",
        ));
    };
    if text(&row, "confidentiality") == "AML" && !has_confidential_aml_access(principal) {
        return Err(ApiError::new(
            403,
            "CASE_CONFIDENTIAL",
            "This case contains AML-confidential information",
        ));
    }
    let events = sqlx::query(
        "SELECT id, created_at, event_type, actor_type, actor_user_id, actor_email, summary, details_json
         FROM operator_case_events WHERE case_id = $1 ORDER BY created_at DESC LIMIT 200",
    )
    .bind(super::support::uuid_bind(&id))
    .fetch_all(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let links = sqlx::query(
        "SELECT id, created_at, link_type, target_id, label_key, label_text, metadata
         FROM operator_case_links WHERE case_id = $1 ORDER BY created_at ASC",
    )
    .bind(super::support::uuid_bind(&id))
    .fetch_all(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let inquiries = sqlx::query(
        "SELECT id, created_at, status::text AS status, source::text AS source, next_run_at, last_run_at,
                attempts, last_result, last_error, completed_at, cancelled_at
         FROM gateway_inquiry_schedules WHERE operator_case_id = $1 ORDER BY created_at DESC LIMIT 20",
    )
    .bind(super::support::uuid_bind(&id))
    .fetch_all(&state.pools.main)
    .await
    .map_err(super::support::database_error)?;
    let audit = super::onboarding::audit_trail(state, "OPERATOR_CASE", &id, 200).await?;
    let mut operator_case = flatten(&row);
    if let Some(object) = operator_case.as_object_mut() {
        object.insert(
            "events".to_owned(),
            Value::Array(
                events
                    .iter()
                    .map(|event| {
                        json!({
                            "id": uuid_json(event, "id"),
                            "createdAt": ts_json(event, "created_at"),
                            "eventType": text(event, "event_type"),
                            "actorType": text(event, "actor_type"),
                            "actorUserId": uuid_json(event, "actor_user_id"),
                            "actorEmail": super::support::text_value(event, "actor_email"),
                            "summary": text(event, "summary"),
                            "detailsJson": super::support::jsonb(event, "details_json"),
                        })
                    })
                    .collect(),
            ),
        );
        object.insert(
            "links".to_owned(),
            Value::Array(
                links
                    .iter()
                    .map(|link| {
                        json!({
                            "id": uuid_json(link, "id"),
                            "createdAt": ts_json(link, "created_at"),
                            "linkType": text(link, "link_type"),
                            "targetId": super::support::text_value(link, "target_id"),
                            "labelKey": super::support::text_value(link, "label_key"),
                            "labelText": super::support::text_value(link, "label_text"),
                            "metadata": super::support::jsonb(link, "metadata"),
                        })
                    })
                    .collect(),
            ),
        );
        object.insert(
            "inquirySchedules".to_owned(),
            Value::Array(
                inquiries
                    .iter()
                    .map(|schedule| {
                        json!({
                            "id": uuid_json(schedule, "id"),
                            "createdAt": ts_json(schedule, "created_at"),
                            "status": text(schedule, "status"),
                            "source": text(schedule, "source"),
                            "nextRunAt": ts_json(schedule, "next_run_at"),
                            "lastRunAt": ts_json(schedule, "last_run_at"),
                            "attempts": super::support::int_json(schedule, "attempts"),
                            "lastResult": super::support::text_value(schedule, "last_result"),
                            "lastError": super::support::text_value(schedule, "last_error"),
                            "completedAt": ts_json(schedule, "completed_at"),
                            "cancelledAt": ts_json(schedule, "cancelled_at"),
                        })
                    })
                    .collect(),
            ),
        );
        object.insert("auditTrail".to_owned(), audit);
    }
    Ok(json!({ "operatorCase": operator_case }))
}

async fn catalog(
    _state: &AppState,
    _request: &HttpRequest,
    _principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    Ok(json!({
        "types": catalog_definitions().iter().map(|definition| json!({
            "code": definition.code,
            "group": definition.group,
            "domain": definition.domain,
            "source": definition.source,
            "labelKey": format!("operatorCase.type.{}", definition.code),
            "defaultPriority": definition.priority,
            "defaultSlaHours": definition.sla_hours,
            "autoClear": definition.auto_clear,
            "subjectType": definition.subject_type,
            "actions": definition.actions,
        })).collect::<Vec<_>>(),
        "actions": action_definitions(),
        "resolutionCodes": RESOLUTION_CODES,
    }))
}

// ---------------------------------------------------------------- handlers

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

fn catalog_handler<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move { result_response(request, catalog(state, request, principal).await) })
}

fn result_response(request: &HttpRequest, result: Result<Value, ApiError>) -> HttpResponse {
    match result {
        Ok(value) => json_ok(&value),
        Err(error) => crate::http::error_response(request, error),
    }
}

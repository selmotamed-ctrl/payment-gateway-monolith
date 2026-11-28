//! Keyed operator cases and the system audit principal.
//!
//! Ports the parts of `core-back/lib/operatorCases/{caseCatalog,caseService}.ts`,
//! `core-back/engine/workers/automationCases.ts`,
//! `core-back/engine/ledger/ledgerAlerts.ts` and `core-back/lib/audit/writeAudit.ts` that the ported
//! workers need. The full case catalog (66 types, actions, resolution codes) stays with P6-T09; this
//! module owns the taxonomy fields the workers write and the two de-duplication rules:
//!
//! - one unresolved case per `(kind, subject_key)` (`operator_cases_open_subject_key_uniq`), and
//! - one unresolved case per `(kind, attempt_id)` when the caller asks for `dedupeOnAttempt`.
//!
//! Clearing records a terminal state (`SOURCE_CLEARED`) instead of the historical `[CLEARED]` note,
//! exactly like `clearKeyedCase`.

#![forbid(unsafe_code)]

use chrono::NaiveDateTime;
use pg_types::generated::enums::{OperatorCaseKind, OperatorCasePriority};
use serde_json::{json, Value};
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::db::{is_unique_violation, now_utc};
use crate::runtime::WorkerError;

/// `core-back/lib/systemAutomationUser.ts:15`. The canonical, disabled system principal.
pub const SYSTEM_AUTOMATION_EMAIL: &str = "system-drafter@payment-gateway.internal";

pub const LEDGER_INVARIANT_SUBJECT: &str = "ledger.invariant";

/// `ledgerAlerts.ts` `LEDGER_SUBJECT_KEYS.shard`.
#[must_use]
pub fn ledger_shard_subject_key(gl_account_id: &str, shard_id: i32) -> String {
    format!("ledger.shard:{gl_account_id}:{shard_id}")
}

/// `outboxWorkers.ts:398`.
#[must_use]
pub fn outbox_parked_subject_key(topic: &str) -> String {
    format!("outbox.parked:{topic}")
}

/// `StaleUnknownAttempts.ts:21`.
#[must_use]
pub fn unknown_attempt_subject_key(attempt_id: &str) -> String {
    format!("attempt.unknown:{attempt_id}")
}

/// `PlatformMonitorWorker.ts:76-79`.
pub const PLATFORM_SUBJECT_PREFIX: &str = "platform.";

#[must_use]
pub fn platform_subject_key(check_id: &str, finding_key: Option<&str>) -> String {
    match finding_key {
        Some(key) if !key.is_empty() => format!("{PLATFORM_SUBJECT_PREFIX}{check_id}:{key}"),
        _ => format!("{PLATFORM_SUBJECT_PREFIX}{check_id}"),
    }
}

/// The case kind (`OperatorCaseKind`), used as the queue bucket.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaseKind {
    Unknown,
    Held,
    Conflict,
    Mismatch,
    LateSuccess,
    ManualReview,
    UnmatchedStatement,
}

impl CaseKind {
    /// The generated `OperatorCaseKind` (bound directly, so the enum type is checked by sqlx).
    #[must_use]
    pub fn generated(self) -> OperatorCaseKind {
        match self {
            Self::Unknown => OperatorCaseKind::Unknown,
            Self::Held => OperatorCaseKind::Held,
            Self::Conflict => OperatorCaseKind::Conflict,
            Self::Mismatch => OperatorCaseKind::Mismatch,
            Self::LateSuccess => OperatorCaseKind::LateSuccess,
            Self::ManualReview => OperatorCaseKind::ManualReview,
            Self::UnmatchedStatement => OperatorCaseKind::UnmatchedStatement,
        }
    }

    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unknown => "UNKNOWN",
            Self::Held => "HELD",
            Self::Conflict => "CONFLICT",
            Self::Mismatch => "MISMATCH",
            Self::LateSuccess => "LATE_SUCCESS",
            Self::ManualReview => "MANUAL_REVIEW",
            Self::UnmatchedStatement => "UNMATCHED_STATEMENT",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum MonitorPriority {
    P1,
    P2,
    P3,
}

impl MonitorPriority {
    /// The generated `OperatorCasePriority`.
    #[must_use]
    pub fn generated(self) -> OperatorCasePriority {
        match self {
            Self::P1 => OperatorCasePriority::P1,
            Self::P2 => OperatorCasePriority::P2,
            Self::P3 => OperatorCasePriority::P3,
        }
    }

    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::P1 => "P1",
            Self::P2 => "P2",
            Self::P3 => "P3",
        }
    }

    /// `PrismaMonitorCaseSink`: P1 4 h, P2 24 h, P3 72 h by default.
    #[must_use]
    pub fn default_sla_hours(self) -> i64 {
        match self {
            Self::P1 => 4,
            Self::P2 => 24,
            Self::P3 => 72,
        }
    }
}

/// The condition taxonomy fields the workers write.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CaseTypeDefinition {
    pub code: &'static str,
    pub source: &'static str,
    pub domain: &'static str,
    pub confidentiality: &'static str,
    pub subject_type: &'static str,
}

impl CaseTypeDefinition {
    #[must_use]
    pub fn title_key(self) -> String {
        format!("operatorCase.type.{}", self.code)
    }

    /// The tail of the label key with underscores turned into spaces (`caseCatalog.ts:342`).
    #[must_use]
    pub fn default_title(self) -> String {
        self.code.replace('_', " ").to_lowercase()
    }
}

const fn def(
    code: &'static str,
    source: &'static str,
    domain: &'static str,
    confidentiality: &'static str,
    subject_type: &'static str,
) -> CaseTypeDefinition {
    CaseTypeDefinition {
        code,
        source,
        domain,
        confidentiality,
        subject_type,
    }
}

/// The subset of `caseCatalog.ts` a worker subject key can produce, in the same precedence order.
#[must_use]
pub fn case_type_for_subject(
    subject_key: &str,
    kind: Option<CaseKind>,
    has_attempt: bool,
    has_reconciliation_item: bool,
) -> CaseTypeDefinition {
    // Platform monitor / backup families.
    if subject_key.starts_with("platform.backup:backup-failed") {
        return def(
            "BACKUP_FAILED",
            "PLATFORM_MONITOR",
            "OPERATIONS",
            "NORMAL",
            "BACKUP_TARGET",
        );
    }
    if subject_key.starts_with("platform.backup:backup-stale") {
        return def(
            "BACKUP_STALE",
            "PLATFORM_MONITOR",
            "OPERATIONS",
            "NORMAL",
            "BACKUP_TARGET",
        );
    }
    if subject_key.starts_with("platform.backup:daemon") {
        return def(
            "BACKUP_DAEMON",
            "PLATFORM_MONITOR",
            "OPERATIONS",
            "NORMAL",
            "BACKUP_DAEMON",
        );
    }
    if subject_key.starts_with("platform.backup:unhealthy") {
        return def(
            "BACKUP_UNHEALTHY",
            "PLATFORM_MONITOR",
            "OPERATIONS",
            "NORMAL",
            "BACKUP_DAEMON",
        );
    }
    if subject_key.starts_with("platform.backup:wal-lag") {
        return def(
            "BACKUP_WAL_LAG",
            "PLATFORM_MONITOR",
            "OPERATIONS",
            "NORMAL",
            "BACKUP_WAL",
        );
    }
    if subject_key.starts_with("platform.backup:drill-failed") {
        return def(
            "BACKUP_DRILL_FAILED",
            "PLATFORM_MONITOR",
            "OPERATIONS",
            "NORMAL",
            "BACKUP_DRILL",
        );
    }
    if subject_key.starts_with("platform.backup:drill-stale") {
        return def(
            "BACKUP_DRILL_STALE",
            "PLATFORM_MONITOR",
            "OPERATIONS",
            "NORMAL",
            "BACKUP_DRILL",
        );
    }
    if subject_key.starts_with("platform.backup:") {
        return def(
            "BACKUP_ALERT",
            "PLATFORM_MONITOR",
            "OPERATIONS",
            "NORMAL",
            "BACKUP_DAEMON",
        );
    }
    if subject_key.starts_with("platform.worker_stale") {
        return def(
            "WORKER_STALE",
            "PLATFORM_MONITOR",
            "OPERATIONS",
            "NORMAL",
            "WORKER",
        );
    }
    if subject_key.starts_with("platform.checkpoint_stale") {
        return def(
            "CHECKPOINT_STALE",
            "PLATFORM_MONITOR",
            "FINANCE",
            "NORMAL",
            "GL_ACCOUNT_SHARD",
        );
    }
    if subject_key.starts_with("platform.outbox_age") {
        return def(
            "OUTBOX_AGE",
            "PLATFORM_MONITOR",
            "OPERATIONS",
            "NORMAL",
            "OUTBOX_TOPIC",
        );
    }
    if subject_key.starts_with("platform.audit_outbox_age") {
        return def(
            "AUDIT_OUTBOX_AGE",
            "PLATFORM_MONITOR",
            "SECURITY",
            "NORMAL",
            "AUDIT_OUTBOX",
        );
    }
    if subject_key.starts_with("platform.background_job_age") {
        return def(
            "BACKGROUND_JOB_AGE",
            "PLATFORM_MONITOR",
            "OPERATIONS",
            "NORMAL",
            "BACKGROUND_JOB_QUEUE",
        );
    }
    if subject_key.starts_with("platform.kyb_scan_backlog") {
        return def(
            "KYB_SCAN_BACKLOG",
            "PLATFORM_MONITOR",
            "COMPLIANCE",
            "CONFIDENTIAL",
            "KYB_SCAN",
        );
    }
    if subject_key.starts_with("platform.journal_default_rows") {
        return def(
            "JOURNAL_DEFAULT_ROWS",
            "PLATFORM_MONITOR",
            "FINANCE",
            "NORMAL",
            "LEDGER",
        );
    }
    if subject_key.starts_with("platform.cert_expiry") {
        return def(
            "CERT_EXPIRY",
            "PLATFORM_MONITOR",
            "SECURITY",
            "NORMAL",
            "CERTIFICATE",
        );
    }
    if subject_key.starts_with("platform.redis_unreachable") {
        return def(
            "REDIS_UNREACHABLE",
            "PLATFORM_MONITOR",
            "OPERATIONS",
            "NORMAL",
            "REDIS",
        );
    }
    if subject_key.starts_with("platform.stale_unknown") {
        return def(
            "STALE_UNKNOWN_BACKLOG",
            "PLATFORM_MONITOR",
            "PAYMENTS",
            "NORMAL",
            "PAYMENT_ATTEMPT",
        );
    }
    if subject_key.starts_with("platform.refund_unscheduled") {
        return def(
            "REFUND_UNSCHEDULED",
            "PLATFORM_MONITOR",
            "FINANCE",
            "NORMAL",
            "ADJUSTMENT",
        );
    }
    if subject_key.starts_with("platform.object_storage") {
        return def(
            "OBJECT_STORAGE",
            "PLATFORM_MONITOR",
            "OPERATIONS",
            "NORMAL",
            "OBJECT_STORAGE",
        );
    }
    if subject_key.starts_with("platform.communication") {
        return def(
            "COMMUNICATION_UNCONFIGURED",
            "PLATFORM_MONITOR",
            "OPERATIONS",
            "NORMAL",
            "COMMUNICATION_CHANNEL",
        );
    }
    if subject_key.starts_with("platform.monitor_check_failed") {
        return def(
            "MONITOR_CHECK_FAILED",
            "PLATFORM_MONITOR",
            "OPERATIONS",
            "NORMAL",
            "PLATFORM_CHECK",
        );
    }
    if subject_key.starts_with(PLATFORM_SUBJECT_PREFIX) {
        return def(
            "PLATFORM_ALERT",
            "PLATFORM_MONITOR",
            "OPERATIONS",
            "NORMAL",
            "PLATFORM_CHECK",
        );
    }

    // Deadlines / compliance.
    if subject_key.starts_with("report.overdue") {
        return def(
            "REPORT_OVERDUE",
            "DEADLINE",
            "COMPLIANCE",
            "CONFIDENTIAL",
            "REGULATORY_REPORT",
        );
    }
    if subject_key.starts_with("aml.sla_breached") {
        return def(
            "AML_SLA_BREACH",
            "DEADLINE",
            "COMPLIANCE",
            "AML",
            "AML_CASE",
        );
    }
    if subject_key.starts_with("dispute.expired") {
        return def(
            "DISPUTE_EXPIRED",
            "DEADLINE",
            "FINANCE",
            "CONFIDENTIAL",
            "DISPUTE",
        );
    }
    if subject_key.starts_with("dispute.ruling_overdue") {
        return def(
            "DISPUTE_RULING_OVERDUE",
            "DEADLINE",
            "FINANCE",
            "CONFIDENTIAL",
            "DISPUTE",
        );
    }
    if subject_key.starts_with("cashout.sla") {
        return def("CASHOUT_SLA", "DEADLINE", "FINANCE", "NORMAL", "CASHOUT");
    }
    if subject_key.starts_with("emergency.unratified") {
        return def(
            "EMERGENCY_UNRATIFIED",
            "DEADLINE",
            "COMPLIANCE",
            "CONFIDENTIAL",
            "APPROVAL_REQUEST",
        );
    }
    if subject_key.starts_with("emergency.lifted") {
        return def(
            "EMERGENCY_LIFTED",
            "DEADLINE",
            "COMPLIANCE",
            "CONFIDENTIAL",
            "APPROVAL_REQUEST",
        );
    }

    // Route health / credentials / KYB.
    if subject_key.starts_with("route.health.override_review") {
        return def(
            "ROUTE_OVERRIDE_REVIEW",
            "ROUTE_HEALTH",
            "GATEWAY",
            "NORMAL",
            "RAIL_ROUTE",
        );
    }
    if subject_key.starts_with("route.health.override_conflict") {
        return def(
            "ROUTE_OVERRIDE_CONFLICT",
            "ROUTE_HEALTH",
            "GATEWAY",
            "NORMAL",
            "RAIL_ROUTE",
        );
    }
    if subject_key.starts_with("route.health.override") {
        return def(
            "ROUTE_OVERRIDE",
            "ROUTE_HEALTH",
            "GATEWAY",
            "NORMAL",
            "RAIL_ROUTE",
        );
    }
    if subject_key.starts_with("route.health") {
        return def(
            "ROUTE_HEALTH",
            "ROUTE_HEALTH",
            "GATEWAY",
            "NORMAL",
            "RAIL_ROUTE",
        );
    }
    if subject_key.starts_with("credential.expiring") {
        return def(
            "CREDENTIAL_EXPIRING",
            "PLATFORM_MONITOR",
            "GATEWAY",
            "NORMAL",
            "CREDENTIAL_SET",
        );
    }
    if subject_key.starts_with("credential.expired") {
        return def(
            "CREDENTIAL_EXPIRED",
            "PLATFORM_MONITOR",
            "GATEWAY",
            "NORMAL",
            "CREDENTIAL_SET",
        );
    }
    if subject_key.starts_with("credential.failing") {
        return def(
            "CREDENTIAL_FAILING",
            "PLATFORM_MONITOR",
            "GATEWAY",
            "NORMAL",
            "CREDENTIAL_SET",
        );
    }
    if subject_key.starts_with("kyb-infected") {
        return def(
            "KYB_INFECTED",
            "KYB",
            "COMPLIANCE",
            "CONFIDENTIAL",
            "KYB_DOCUMENT",
        );
    }
    if subject_key.starts_with("kyb-scan-failed") {
        return def(
            "KYB_SCAN_FAILED",
            "KYB",
            "COMPLIANCE",
            "CONFIDENTIAL",
            "KYB_DOCUMENT",
        );
    }

    // Ledger / statements / security.
    if subject_key.starts_with("ledger.invariant") {
        return def("LEDGER_INVARIANT", "LEDGER", "FINANCE", "NORMAL", "LEDGER");
    }
    if subject_key.starts_with("ledger.shard") {
        return def(
            "LEDGER_SHARD",
            "LEDGER",
            "FINANCE",
            "NORMAL",
            "GL_ACCOUNT_SHARD",
        );
    }
    if subject_key.starts_with("ledger.partition") {
        return def("LEDGER_PARTITION", "LEDGER", "FINANCE", "NORMAL", "LEDGER");
    }
    if subject_key.starts_with("commission.receivable.aged") {
        return def(
            "COMMISSION_RECEIVABLE_AGED",
            "LEDGER",
            "FINANCE",
            "NORMAL",
            "MERCHANT",
        );
    }
    if subject_key.starts_with("link.slot_drift") {
        return def(
            "LINK_SLOT_DRIFT",
            "LEDGER",
            "OPERATIONS",
            "NORMAL",
            "PAYMENT_LINK",
        );
    }
    if subject_key.starts_with("outbox.parked") {
        return def(
            "OUTBOX_PARKED",
            "LEDGER",
            "OPERATIONS",
            "NORMAL",
            "OUTBOX_TOPIC",
        );
    }
    if subject_key.starts_with("refund.inquiry") {
        return def(
            "REFUND_INQUIRY",
            "LEDGER",
            "FINANCE",
            "NORMAL",
            "ADJUSTMENT",
        );
    }
    if subject_key.starts_with("statement.missing") {
        return def(
            "STATEMENT_MISSING",
            "PLATFORM_MONITOR",
            "FINANCE",
            "NORMAL",
            "STATEMENT_SOURCE",
        );
    }
    if subject_key.starts_with("statement.schedule_invalid") {
        return def(
            "STATEMENT_SCHEDULE_INVALID",
            "PLATFORM_MONITOR",
            "FINANCE",
            "NORMAL",
            "STATEMENT_SOURCE",
        );
    }
    if subject_key.starts_with("audit.anchor_invalid") {
        return def(
            "AUDIT_ANCHOR_INVALID",
            "SECURITY",
            "SECURITY",
            "CONFIDENTIAL",
            "AUDIT_CHAIN",
        );
    }
    if subject_key.starts_with("audit.chain_rewritten") {
        return def(
            "AUDIT_CHAIN_REWRITTEN",
            "SECURITY",
            "SECURITY",
            "CONFIDENTIAL",
            "AUDIT_CHAIN",
        );
    }
    if subject_key.starts_with("audit.chain_broken") {
        return def(
            "AUDIT_CHAIN_BROKEN",
            "SECURITY",
            "SECURITY",
            "CONFIDENTIAL",
            "AUDIT_CHAIN",
        );
    }
    if subject_key.starts_with("merchant_report_scope") {
        return def(
            "REPORT_SCOPE_VIOLATION",
            "SECURITY",
            "SECURITY",
            "CONFIDENTIAL",
            "MERCHANT_REPORT",
        );
    }
    if subject_key.starts_with("attempt.unknown") {
        return def(
            "ATTEMPT_UNKNOWN",
            "ENGINE",
            "PAYMENTS",
            "NORMAL",
            "PAYMENT_ATTEMPT",
        );
    }
    if subject_key.starts_with("recon.overflow") {
        return def(
            "RECON_OVERFLOW",
            "RECONCILIATION",
            "FINANCE",
            "NORMAL",
            "RECONCILIATION_RUN",
        );
    }
    if subject_key.starts_with("recon.item") {
        return def(
            "RECON_ITEM_EXCEPTION",
            "RECONCILIATION",
            "FINANCE",
            "NORMAL",
            "RECONCILIATION_ITEM",
        );
    }

    if has_attempt {
        return match kind {
            Some(CaseKind::Conflict) => def(
                "ATTEMPT_CONFLICT",
                "ENGINE",
                "PAYMENTS",
                "CONFIDENTIAL",
                "PAYMENT_ATTEMPT",
            ),
            Some(CaseKind::LateSuccess) => def(
                "ATTEMPT_LATE_SUCCESS",
                "ENGINE",
                "PAYMENTS",
                "NORMAL",
                "PAYMENT_ATTEMPT",
            ),
            Some(CaseKind::Held) => def(
                "ATTEMPT_HELD",
                "ENGINE",
                "COMPLIANCE",
                "AML",
                "PAYMENT_ATTEMPT",
            ),
            Some(CaseKind::Unknown) => def(
                "ATTEMPT_UNKNOWN",
                "ENGINE",
                "PAYMENTS",
                "NORMAL",
                "PAYMENT_ATTEMPT",
            ),
            Some(CaseKind::Mismatch) => def(
                "ATTEMPT_SUSPENSE",
                "ENGINE",
                "FINANCE",
                "NORMAL",
                "PAYMENT_ATTEMPT",
            ),
            Some(CaseKind::UnmatchedStatement) => def(
                "RECON_UNMATCHED_STATEMENT",
                "RECONCILIATION",
                "FINANCE",
                "NORMAL",
                "RECONCILIATION_ITEM",
            ),
            _ => def(
                "ATTEMPT_MANUAL_REVIEW",
                "ENGINE",
                "PAYMENTS",
                "NORMAL",
                "PAYMENT_ATTEMPT",
            ),
        };
    }
    if has_reconciliation_item {
        return def(
            "RECON_ITEM_EXCEPTION",
            "RECONCILIATION",
            "FINANCE",
            "NORMAL",
            "RECONCILIATION_ITEM",
        );
    }
    def(
        "LEGACY_UNCLASSIFIED",
        "LEGACY",
        "OPERATIONS",
        "NORMAL",
        "CASE",
    )
}

#[derive(Debug, Clone, PartialEq)]
pub struct CaseMetadata {
    pub case_type: CaseTypeDefinition,
    pub title_key: String,
    pub title_text: String,
    pub summary: String,
    pub details_json: Value,
    pub subject_id: Option<String>,
    pub subject_label: Option<String>,
}

fn uuid_like(value: &str) -> Option<String> {
    Uuid::parse_str(value).ok().map(|id| id.to_string())
}

/// `caseCatalog.ts:309-377` (`caseMetadata`), reduced to the fields the workers write.
#[must_use]
pub fn case_metadata(
    subject_key: Option<&str>,
    kind: Option<CaseKind>,
    has_attempt: bool,
    has_reconciliation_item: bool,
    detail: &str,
    title_override: Option<&str>,
) -> CaseMetadata {
    let notes = detail.trim().to_owned();
    let definition = case_type_for_subject(
        subject_key.unwrap_or_default(),
        kind,
        has_attempt,
        has_reconciliation_item,
    );
    let segments: Vec<&str> = subject_key
        .unwrap_or_default()
        .split(':')
        .filter(|segment| !segment.is_empty())
        .collect();
    let last = segments.last().copied();
    let before_last = segments
        .len()
        .checked_sub(2)
        .and_then(|index| segments.get(index).copied());
    let mut subject_id = last
        .and_then(uuid_like)
        .or_else(|| before_last.and_then(uuid_like));
    if definition.code.starts_with("BACKUP_") {
        let backup_key = segments
            .iter()
            .take(3)
            .copied()
            .collect::<Vec<_>>()
            .join(":");
        subject_id = if backup_key.is_empty() {
            last.map(str::to_owned)
        } else {
            Some(backup_key)
        };
    } else if definition.code == "LEDGER_SHARD" && segments.len() >= 2 {
        subject_id = segments.get(1).map(|segment| (*segment).to_owned());
    } else if definition.code == "RECON_OVERFLOW" {
        subject_id = last.map(str::to_owned);
    }
    let title = title_override
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            if definition.code.starts_with("BACKUP_") {
                let label = definition
                    .code
                    .rsplit('.')
                    .next()
                    .unwrap_or(definition.code);
                format!("{}: {}", label.to_lowercase(), last.unwrap_or("backup"))
            } else {
                definition.default_title()
            }
        });
    let subject_label = if definition.code.starts_with("BACKUP_") {
        last.map(str::to_owned)
    } else if definition.code == "REPORT_OVERDUE" {
        Some("Regulatory report".to_owned())
    } else {
        match definition.subject_type {
            "PAYMENT_ATTEMPT"
            | "RECONCILIATION_ITEM"
            | "RAIL_ROUTE"
            | "CREDENTIAL_SET"
            | "KYB_DOCUMENT"
            | "PLATFORM_CHECK" => None,
            _ => subject_id.clone(),
        }
    };
    let title_key = definition.title_key();
    CaseMetadata {
        case_type: definition,
        title_key,
        title_text: title,
        summary: notes.chars().take(4000).collect(),
        details_json: json!({
            "subjectKey": subject_key,
            "notes": notes.chars().take(4000).collect::<String>(),
            "kind": kind.map(CaseKind::as_str),
        }),
        subject_id,
        subject_label,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyedCaseResult {
    pub id: Option<Uuid>,
    pub created: bool,
}

/// Input of `openKeyedOperatorCase` (`automationCases.ts:34`).
#[derive(Debug, Clone)]
pub struct KeyedCaseInput<'a> {
    pub kind: CaseKind,
    pub priority: MonitorPriority,
    pub subject_key: &'a str,
    pub attempt_id: Option<Uuid>,
    pub reconciliation_item_id: Option<Uuid>,
    pub notes: &'a str,
    pub sla_hours: i64,
    pub now: NaiveDateTime,
    pub dedupe_on_attempt: bool,
    pub title: Option<&'a str>,
}

const OPEN_CASE_LOOKUP_SQL: &str = "SELECT id FROM operator_cases \
     WHERE kind = $1::\"OperatorCaseKind\" AND subject_key = $2 AND state <> 'RESOLVED' LIMIT 1";

const OPEN_CASE_BY_ATTEMPT_SQL: &str = "SELECT id FROM operator_cases \
     WHERE kind = $1::\"OperatorCaseKind\" AND attempt_id = $2::uuid AND state <> 'RESOLVED' LIMIT 1";

/// Opens a keyed case unless one is already unresolved. A concurrent raise is not an error.
pub async fn raise_keyed_case(
    conn: &mut PgConnection,
    input: &KeyedCaseInput<'_>,
) -> Result<KeyedCaseResult, WorkerError> {
    let kind = input.kind.as_str();
    if let Some(row) = sqlx::query(OPEN_CASE_LOOKUP_SQL)
        .bind(kind)
        .bind(input.subject_key)
        .fetch_optional(&mut *conn)
        .await
        .map_err(case_error)?
    {
        let id: Uuid = row.try_get("id").map_err(case_error)?;
        return Ok(KeyedCaseResult {
            id: Some(id),
            created: false,
        });
    }
    if input.dedupe_on_attempt {
        if let Some(attempt_id) = input.attempt_id {
            if let Some(row) = sqlx::query(OPEN_CASE_BY_ATTEMPT_SQL)
                .bind(kind)
                .bind(attempt_id)
                .fetch_optional(&mut *conn)
                .await
                .map_err(case_error)?
            {
                let id: Uuid = row.try_get("id").map_err(case_error)?;
                return Ok(KeyedCaseResult {
                    id: Some(id),
                    created: false,
                });
            }
        }
    }
    match insert_case(conn, input).await {
        Ok(id) => Ok(KeyedCaseResult {
            id: Some(id),
            created: true,
        }),
        Err(error) if is_unique_violation(&error) => Ok(KeyedCaseResult {
            id: None,
            created: false,
        }),
        Err(error) => Err(case_error(error)),
    }
}

/// An attempt-scoped case with no `subject_key` (the inbound-inbox failure path).
pub async fn raise_unkeyed_attempt_case(
    conn: &mut PgConnection,
    attempt_id: Option<Uuid>,
    kind: CaseKind,
    priority: MonitorPriority,
    sla_hours: i64,
    notes: &str,
    now: NaiveDateTime,
) -> Result<KeyedCaseResult, WorkerError> {
    let input = KeyedCaseInput {
        kind,
        priority,
        subject_key: "",
        attempt_id,
        reconciliation_item_id: None,
        notes,
        sla_hours,
        now,
        dedupe_on_attempt: false,
        title: None,
    };
    match insert_case(conn, &input).await {
        Ok(id) => Ok(KeyedCaseResult {
            id: Some(id),
            created: true,
        }),
        Err(error) if is_unique_violation(&error) => Ok(KeyedCaseResult {
            id: None,
            created: false,
        }),
        Err(error) => Err(case_error(error)),
    }
}

async fn insert_case(
    conn: &mut PgConnection,
    input: &KeyedCaseInput<'_>,
) -> Result<Uuid, sqlx::Error> {
    let metadata = case_metadata(
        Some(input.subject_key),
        Some(input.kind),
        input.attempt_id.is_some(),
        input.reconciliation_item_id.is_some(),
        input.notes,
        input.title,
    );
    let id = Uuid::now_v7();
    let sla_due_at = input.now + chrono::Duration::hours(input.sla_hours.max(1));
    let summary: String = input.notes.chars().take(1000).collect();
    sqlx::query(
        "INSERT INTO operator_cases (
            id, created_at, updated_at, kind, case_type, source, domain, confidentiality, title_key,
            title_text, summary, details_json, subject_type, subject_id, subject_label, subject_key,
            attempt_id, reconciliation_item_id, priority, sla_due_at, state, resolution_notes
         ) VALUES (
            $1, $2, $2, $3::\"OperatorCaseKind\", $4, $5, $6, $7, $8,
            $9, $10, $11::jsonb, $12, $13, $14, $15,
            $16, $17, $18::\"OperatorCasePriority\", $19, 'OPEN', $20
         )",
    )
    .bind(id)
    .bind(input.now)
    .bind(input.kind.as_str())
    .bind(metadata.case_type.code)
    .bind(metadata.case_type.source)
    .bind(metadata.case_type.domain)
    .bind(metadata.case_type.confidentiality)
    .bind(&metadata.title_key)
    .bind(&metadata.title_text)
    .bind(&metadata.summary)
    .bind(&metadata.details_json)
    .bind(metadata.case_type.subject_type)
    .bind(&metadata.subject_id)
    .bind(&metadata.subject_label)
    .bind(if input.subject_key.is_empty() {
        None
    } else {
        Some(input.subject_key)
    })
    .bind(input.attempt_id)
    .bind(input.reconciliation_item_id)
    .bind(input.priority.as_str())
    .bind(sla_due_at)
    .bind(&summary)
    .execute(&mut *conn)
    .await?;

    sqlx::query(
        "INSERT INTO operator_case_events (id, case_id, created_at, event_type, actor_type, summary, details_json)
         VALUES ($1, $2, $3, 'OPENED', 'SYSTEM', $4, $5::jsonb)",
    )
    .bind(Uuid::now_v7())
    .bind(id)
    .bind(input.now)
    .bind(&metadata.title_text)
    .bind(&metadata.details_json)
    .execute(&mut *conn)
    .await?;
    Ok(id)
}

/// `caseService.ts:73-113` (`clearKeyedCase`).
pub async fn clear_keyed_case(
    conn: &mut PgConnection,
    kind: CaseKind,
    subject_key: &str,
    detail: &str,
    now: NaiveDateTime,
) -> Result<bool, WorkerError> {
    let Some(row) = sqlx::query(OPEN_CASE_LOOKUP_SQL)
        .bind(kind.as_str())
        .bind(subject_key)
        .fetch_optional(&mut *conn)
        .await
        .map_err(case_error)?
    else {
        return Ok(false);
    };
    let id: Uuid = row.try_get("id").map_err(case_error)?;
    let summary: String = detail.chars().take(2000).collect();
    sqlx::query(
        "UPDATE operator_cases
            SET state = 'RESOLVED', resolved_at = $2, resolved_by_user_id = NULL,
                resolution_code = 'SOURCE_CLEARED', resolution_summary = $3, updated_at = $2
          WHERE id = $1",
    )
    .bind(id)
    .bind(now)
    .bind(&summary)
    .execute(&mut *conn)
    .await
    .map_err(case_error)?;
    sqlx::query(
        "INSERT INTO operator_case_events (id, case_id, created_at, event_type, actor_type, summary)
         VALUES ($1, $2, $3, 'SOURCE_CLEARED', 'SYSTEM', $4)",
    )
    .bind(Uuid::now_v7())
    .bind(id)
    .bind(now)
    .bind(&summary)
    .execute(&mut *conn)
    .await
    .map_err(case_error)?;
    Ok(true)
}

/// Appends a note to an unresolved case (`applyShardRepair` annotates the shard case).
pub async fn annotate_open_case(
    conn: &mut PgConnection,
    kind: CaseKind,
    subject_key: &str,
    note: &str,
    now: NaiveDateTime,
) -> Result<bool, WorkerError> {
    let Some(row) = sqlx::query(OPEN_CASE_LOOKUP_SQL)
        .bind(kind.as_str())
        .bind(subject_key)
        .fetch_optional(&mut *conn)
        .await
        .map_err(case_error)?
    else {
        return Ok(false);
    };
    let id: Uuid = row.try_get("id").map_err(case_error)?;
    let notes: Option<String> =
        sqlx::query_scalar("SELECT resolution_notes FROM operator_cases WHERE id = $1")
            .bind(id)
            .fetch_one(&mut *conn)
            .await
            .map_err(case_error)?;
    let merged = match notes {
        Some(existing) if !existing.is_empty() => format!("{existing}\n{note}"),
        _ => note.to_owned(),
    };
    let merged: String = merged.chars().take(4000).collect();
    sqlx::query("UPDATE operator_cases SET resolution_notes = $2, updated_at = $3 WHERE id = $1")
        .bind(id)
        .bind(&merged)
        .bind(now)
        .execute(&mut *conn)
        .await
        .map_err(case_error)?;
    Ok(true)
}

/// The canonical disabled system automation user, found or created by e-mail.
///
/// `ledgerAlerts.ts:71-104` (`ensureLedgerSystemActor`). The database assigns the UUID; the
/// historical `"SYSTEM_AUTOMATION"` string is never written to a UUID column.
pub async fn ensure_system_actor(conn: &mut PgConnection) -> Result<Uuid, WorkerError> {
    if let Some(id) = sqlx::query_scalar::<_, Uuid>("SELECT id FROM users WHERE email = $1 LIMIT 1")
        .bind(SYSTEM_AUTOMATION_EMAIL)
        .fetch_optional(&mut *conn)
        .await
        .map_err(case_error)?
    {
        return Ok(id);
    }
    let id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO users (id, created_at, updated_at, email, role, authorities_map, app_scope_ids,
                            is_maker, is_checker, mfa_required, status)
         VALUES ($1, now(), now(), $2, 'OPERATOR', '{}'::jsonb, '[]'::jsonb, false, false, false, 'DISABLED')
         ON CONFLICT (email) DO NOTHING",
    )
    .bind(id)
    .bind(SYSTEM_AUTOMATION_EMAIL)
    .execute(&mut *conn)
    .await
    .map_err(case_error)?;
    sqlx::query_scalar::<_, Uuid>("SELECT id FROM users WHERE email = $1 LIMIT 1")
        .bind(SYSTEM_AUTOMATION_EMAIL)
        .fetch_one(&mut *conn)
        .await
        .map_err(case_error)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SystemAudit {
    pub action: String,
    pub entity_type: String,
    pub entity_id: String,
    pub before: Value,
    pub after: Value,
}

impl SystemAudit {
    #[must_use]
    pub fn new(
        action: &str,
        entity_type: &str,
        entity_id: &str,
        before: Value,
        after: Value,
    ) -> Self {
        Self {
            action: action.to_owned(),
            entity_type: entity_type.to_owned(),
            entity_id: entity_id.to_owned(),
            before,
            after,
        }
    }
}

/// `writeSystemAudit` (`ledgerAlerts.ts:107`): one `audit_log` row as the system actor.
pub async fn write_system_audit(
    conn: &mut PgConnection,
    audit: &SystemAudit,
) -> Result<(), WorkerError> {
    let actor_id = ensure_system_actor(conn).await?;
    sqlx::query(
        "INSERT INTO audit_log (id, created_at, updated_at, actor_id, role, action, entity_type,
                                entity_id, before_json, after_json)
         VALUES ($1, now(), now(), $2, 'SYSTEM', $3, $4, $5, $6::jsonb, $7::jsonb)",
    )
    .bind(Uuid::now_v7())
    .bind(actor_id)
    .bind(&audit.action)
    .bind(&audit.entity_type)
    .bind(&audit.entity_id)
    .bind(&audit.before)
    .bind(&audit.after)
    .execute(&mut *conn)
    .await
    .map_err(case_error)?;
    Ok(())
}

/// `write_system_audit` in its own transaction (the TS `inTransaction` wrapper).
pub async fn write_system_audit_pool(
    pool: &sqlx::PgPool,
    audit: &SystemAudit,
) -> Result<(), WorkerError> {
    let mut tx = pool.begin().await.map_err(case_error)?;
    write_system_audit(&mut tx, audit).await?;
    tx.commit().await.map_err(case_error)?;
    Ok(())
}

/// The TS `raiseLedgerCase` (`ledgerAlerts.ts:30`): a P1 `MISMATCH` case per subject key, 4 h SLA.
pub async fn raise_ledger_case(
    conn: &mut PgConnection,
    subject_key: &str,
    notes: &str,
    now: NaiveDateTime,
) -> Result<KeyedCaseResult, WorkerError> {
    raise_keyed_case(
        conn,
        &KeyedCaseInput {
            kind: CaseKind::Mismatch,
            priority: MonitorPriority::P1,
            subject_key,
            attempt_id: None,
            reconciliation_item_id: None,
            notes,
            sla_hours: 4,
            now,
            dedupe_on_attempt: false,
            title: None,
        },
    )
    .await
}

fn case_error(error: sqlx::Error) -> WorkerError {
    WorkerError::Failed(format!("operator case: {error}"))
}

/// Convenience for the workers: `now` at the start of a tick.
#[must_use]
pub fn tick_now() -> NaiveDateTime {
    now_utc()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ledger_shard_subject_matches_typescript() {
        let gl = "018f0000-0000-7000-8000-000000000001";
        assert_eq!(
            ledger_shard_subject_key(gl, 3),
            format!("ledger.shard:{gl}:3")
        );
        let meta = case_metadata(
            Some(&ledger_shard_subject_key(gl, 3)),
            Some(CaseKind::Mismatch),
            false,
            false,
            "drift 1.0000",
            None,
        );
        assert_eq!(meta.case_type.code, "LEDGER_SHARD");
        assert_eq!(meta.case_type.source, "LEDGER");
        assert_eq!(meta.subject_id.as_deref(), Some(gl));
        assert_eq!(meta.title_key, "operatorCase.type.LEDGER_SHARD");
        assert_eq!(meta.summary, "drift 1.0000");
    }

    #[test]
    fn platform_subjects_map_to_their_families() {
        for (key, code, priority_source) in [
            (
                "platform.backup:backup-failed:local",
                "BACKUP_FAILED",
                "PLATFORM_MONITOR",
            ),
            (
                "platform.backup:backup-stale",
                "BACKUP_STALE",
                "PLATFORM_MONITOR",
            ),
            (
                "platform.backup:daemon",
                "BACKUP_DAEMON",
                "PLATFORM_MONITOR",
            ),
            (
                "platform.backup:unhealthy",
                "BACKUP_UNHEALTHY",
                "PLATFORM_MONITOR",
            ),
            (
                "platform.backup:wal-lag",
                "BACKUP_WAL_LAG",
                "PLATFORM_MONITOR",
            ),
            (
                "platform.backup:drill-failed",
                "BACKUP_DRILL_FAILED",
                "PLATFORM_MONITOR",
            ),
            (
                "platform.backup:drill-stale",
                "BACKUP_DRILL_STALE",
                "PLATFORM_MONITOR",
            ),
            (
                "platform.worker_stale:PollWorker",
                "WORKER_STALE",
                "PLATFORM_MONITOR",
            ),
            (
                "platform.checkpoint_stale:a:1",
                "CHECKPOINT_STALE",
                "PLATFORM_MONITOR",
            ),
            ("platform.outbox_age", "OUTBOX_AGE", "PLATFORM_MONITOR"),
            (
                "platform.audit_outbox_age",
                "AUDIT_OUTBOX_AGE",
                "PLATFORM_MONITOR",
            ),
            (
                "platform.background_job_age",
                "BACKGROUND_JOB_AGE",
                "PLATFORM_MONITOR",
            ),
            (
                "platform.kyb_scan_backlog",
                "KYB_SCAN_BACKLOG",
                "PLATFORM_MONITOR",
            ),
            (
                "platform.journal_default_rows",
                "JOURNAL_DEFAULT_ROWS",
                "PLATFORM_MONITOR",
            ),
            (
                "platform.cert_expiry:mtls_server",
                "CERT_EXPIRY",
                "PLATFORM_MONITOR",
            ),
            (
                "platform.redis_unreachable",
                "REDIS_UNREACHABLE",
                "PLATFORM_MONITOR",
            ),
            (
                "platform.stale_unknown",
                "STALE_UNKNOWN_BACKLOG",
                "PLATFORM_MONITOR",
            ),
            (
                "platform.refund_unscheduled",
                "REFUND_UNSCHEDULED",
                "PLATFORM_MONITOR",
            ),
            (
                "platform.object_storage:health",
                "OBJECT_STORAGE",
                "PLATFORM_MONITOR",
            ),
            (
                "platform.communication:email",
                "COMMUNICATION_UNCONFIGURED",
                "PLATFORM_MONITOR",
            ),
            (
                "platform.monitor_check_failed:backup",
                "MONITOR_CHECK_FAILED",
                "PLATFORM_MONITOR",
            ),
            (
                "platform.something_new",
                "PLATFORM_ALERT",
                "PLATFORM_MONITOR",
            ),
        ] {
            let meta = case_metadata(Some(key), None, false, false, "detail", None);
            assert_eq!(meta.case_type.code, code, "subject key {key}");
            assert_eq!(meta.case_type.source, priority_source, "subject key {key}");
        }
        let kyb = case_metadata(
            Some("platform.kyb_scan_backlog"),
            None,
            false,
            false,
            "2 pending",
            None,
        );
        assert_eq!(kyb.case_type.confidentiality, "CONFIDENTIAL");
    }

    #[test]
    fn backup_subject_id_keeps_three_segments() {
        let meta = case_metadata(
            Some("platform.backup:backup-failed:local-repo"),
            None,
            false,
            false,
            "backup 42 failed",
            None,
        );
        assert_eq!(meta.case_type.code, "BACKUP_FAILED");
        assert_eq!(
            meta.subject_id.as_deref(),
            Some("platform.backup:backup-failed:local-repo")
        );
        assert_eq!(meta.subject_label.as_deref(), Some("local-repo"));
    }

    #[test]
    fn outbox_and_unknown_subjects_are_taxonomised() {
        let outbox = case_metadata(
            Some(&outbox_parked_subject_key("attempt.transitioned")),
            Some(CaseKind::Mismatch),
            false,
            false,
            "parked 1 event after 10 failed deliveries",
            None,
        );
        assert_eq!(outbox.case_type.code, "OUTBOX_PARKED");
        let unknown = case_metadata(
            Some(&unknown_attempt_subject_key(
                "018f0000-0000-7000-8000-000000000002",
            )),
            Some(CaseKind::Unknown),
            false,
            false,
            "stale",
            None,
        );
        assert_eq!(unknown.case_type.code, "ATTEMPT_UNKNOWN");
        assert_eq!(
            unknown.subject_id.as_deref(),
            Some("018f0000-0000-7000-8000-000000000002")
        );
    }

    #[test]
    fn attempt_kind_fallbacks_match_the_catalog() {
        for (kind, code) in [
            (CaseKind::Conflict, "ATTEMPT_CONFLICT"),
            (CaseKind::LateSuccess, "ATTEMPT_LATE_SUCCESS"),
            (CaseKind::Held, "ATTEMPT_HELD"),
            (CaseKind::Unknown, "ATTEMPT_UNKNOWN"),
            (CaseKind::Mismatch, "ATTEMPT_SUSPENSE"),
            (CaseKind::ManualReview, "ATTEMPT_MANUAL_REVIEW"),
        ] {
            let meta = case_metadata(None, Some(kind), true, false, "notes", None);
            assert_eq!(meta.case_type.code, code);
        }
        let held = case_metadata(None, Some(CaseKind::Held), true, false, "held", None);
        assert_eq!(held.case_type.confidentiality, "AML");
        let legacy = case_metadata(None, None, false, false, "legacy", None);
        assert_eq!(legacy.case_type.code, "LEGACY_UNCLASSIFIED");
    }

    #[test]
    fn titles_and_notes_are_bounded() {
        let long = "x".repeat(5000);
        let meta = case_metadata(
            Some("ledger.shard:018f0000-0000-7000-8000-000000000001:1"),
            Some(CaseKind::Mismatch),
            false,
            false,
            &long,
            Some("  Custom title  "),
        );
        assert_eq!(meta.title_text, "Custom title");
        assert_eq!(meta.summary.chars().count(), 4000);
        assert_eq!(
            meta.details_json
                .get("notes")
                .and_then(Value::as_str)
                .map(|notes| notes.chars().count()),
            Some(4000)
        );
    }

    #[test]
    fn platform_subject_keys_have_the_documented_shape() {
        assert_eq!(
            platform_subject_key("backup", Some("wal-lag")),
            "platform.backup:wal-lag"
        );
        assert_eq!(platform_subject_key("backup", None), "platform.backup");
    }

    #[test]
    fn generated_enums_round_trip_with_the_text_form() {
        for kind in [
            CaseKind::Unknown,
            CaseKind::Held,
            CaseKind::Conflict,
            CaseKind::Mismatch,
            CaseKind::LateSuccess,
            CaseKind::ManualReview,
            CaseKind::UnmatchedStatement,
        ] {
            assert_eq!(kind.generated().as_str(), kind.as_str());
        }
        for priority in [
            MonitorPriority::P1,
            MonitorPriority::P2,
            MonitorPriority::P3,
        ] {
            assert_eq!(priority.generated().as_str(), priority.as_str());
        }
    }

    #[test]
    fn priority_slas_match_the_typescript_sink() {
        assert_eq!(MonitorPriority::P1.default_sla_hours(), 4);
        assert_eq!(MonitorPriority::P2.default_sla_hours(), 24);
        assert_eq!(MonitorPriority::P3.default_sla_hours(), 72);
    }
}

//! Row shaping, confidential payload decryption and object-storage reads for the AML admin GETs.
//!
//! The JSON key order of every mapper follows the TypeScript object literal so a byte-for-byte
//! parity diff stays meaningful. Timestamps use `Date#toISOString()` (three fraction digits, `Z`),
//! money uses `toFixed(4)` (`Money4`) and Prisma `Decimal` passthrough uses decimal.js `toString()`
//! (`DecimalJs`) — chapter 2 §12/§13.

#![forbid(unsafe_code)]

use std::collections::HashMap;

use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use serde_json::{json, Map, Value};
use sqlx::postgres::PgRow;
use sqlx::{PgPool, Postgres, Row, Type};
use uuid::Uuid;

use pg_crypto::vault::{EnvironmentKeyResolver, Vault};
use pg_http::ApiError;
use pg_objstore::{
    decrypt_pgos1, BlobStore, BucketTier, FsBlobStore, KekKeyring, ObjectCryptoMetadata,
    RemoteMtlsBlobStore, RemoteTlsConfig, StorageNamespace,
};
use pg_types::{DecimalJs, Money4};

/// `Date#toISOString()` for a `timestamp(3)` column (stored UTC, no zone).
pub(super) fn iso_naive(value: NaiveDateTime) -> String {
    value
        .and_utc()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// `Date#toISOString()` for a `timestamptz(3)` column.
pub(super) fn iso_utc(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// `@db.Date` → `new Date("<date>T00:00:00.000Z")`.
pub(super) fn iso_date(value: NaiveDate) -> String {
    value
        .and_hms_opt(0, 0, 0)
        .map(iso_naive)
        .unwrap_or_else(|| iso_naive(Utc::now().naive_utc()))
}

/// `approvalAgeHours`: max(0, floor((now - createdAt) / 3_600_000)).
pub(super) fn age_hours(created_at: NaiveDateTime, now: DateTime<Utc>) -> i64 {
    let delta = now.naive_utc() - created_at;
    (delta.num_milliseconds() / 3_600_000).max(0)
}

/// `money4`: null stays null.
pub(super) fn money4(value: Option<rust_decimal::Decimal>) -> Value {
    value.map_or(Value::Null, |value| {
        Value::String(Money4(value).to_string())
    })
}

/// `decimal.js.toString()` as the JSON string Prisma emits.
pub(super) fn decimal_js(value: rust_decimal::Decimal) -> Value {
    Value::String(DecimalJs(value).to_string())
}

/// `AML-<last 8 uppercase>`.
pub(super) fn case_ref(id: Uuid) -> String {
    format!("AML-{}", short_ref(id))
}

/// `RPT-<last 8 uppercase>`.
pub(super) fn report_ref(id: Uuid) -> String {
    format!("RPT-{}", short_ref(id))
}

fn short_ref(id: Uuid) -> String {
    let text = id.simple().to_string().to_ascii_uppercase();
    text[text.len().saturating_sub(8)..].to_owned()
}

/// Decode one column, mapping a type mismatch to the generic 500.
pub(super) fn get<'r, T>(row: &'r PgRow, name: &str) -> Result<T, ApiError>
where
    T: sqlx::Decode<'r, Postgres> + Type<Postgres>,
{
    row.try_get(name).map_err(|error| {
        tracing::error!(column = name, error = %error, "AML row could not be decoded");
        ApiError::server_error()
    })
}

pub(super) fn opt_get<'r, T>(row: &'r PgRow, name: &str) -> Result<Option<T>, ApiError>
where
    T: sqlx::Decode<'r, Postgres> + Type<Postgres>,
{
    get::<Option<T>>(row, name)
}

/* ------------------------------------------------------------ subject maps */

#[derive(Debug, Clone)]
pub(super) struct MerchantSubject {
    pub trade_name: String,
    pub status: String,
}

#[derive(Debug, Clone)]
pub(super) struct AttemptSubject {
    pub reference: String,
    pub status: String,
    pub total_charged_amount: rust_decimal::Decimal,
    pub currency: String,
    pub merchant_trade_name: Option<String>,
}

#[derive(Debug, Clone)]
pub(super) struct OwnerSubject {
    pub full_name_en: Option<String>,
    pub full_name_ar: String,
    pub merchant_trade_name: Option<String>,
}

#[derive(Debug, Default)]
pub(super) struct SubjectMaps {
    pub merchants: HashMap<String, MerchantSubject>,
    pub attempts: HashMap<String, AttemptSubject>,
    pub owners: HashMap<String, OwnerSubject>,
}

/// `amlCaseSubjectMaps`: one query per subject kind, only for the kinds present.
pub(super) async fn load_subject_maps(
    pool: &PgPool,
    subjects: &[(String, String)],
) -> Result<SubjectMaps, ApiError> {
    let mut merchant_ids: Vec<Uuid> = Vec::new();
    let mut attempt_ids: Vec<Uuid> = Vec::new();
    let mut owner_ids: Vec<Uuid> = Vec::new();
    for (subject_type, subject_id) in subjects {
        let Ok(id) = Uuid::parse_str(subject_id) else {
            continue;
        };
        match subject_type.as_str() {
            "MERCHANT" => merchant_ids.push(id),
            "PAYMENT_ATTEMPT" => attempt_ids.push(id),
            "BENEFICIAL_OWNER" => owner_ids.push(id),
            _ => {}
        }
    }
    merchant_ids.sort_unstable();
    merchant_ids.dedup();
    attempt_ids.sort_unstable();
    attempt_ids.dedup();
    owner_ids.sort_unstable();
    owner_ids.dedup();

    let mut maps = SubjectMaps::default();
    if !merchant_ids.is_empty() {
        let rows = sqlx::query(
            "SELECT id::text AS id, trade_name, status::text AS status \
             FROM merchants WHERE id = ANY($1::uuid[])",
        )
        .bind(&merchant_ids)
        .fetch_all(pool)
        .await
        .map_err(crate::routes::common::database_error)?;
        for row in rows {
            let id: String = get(&row, "id")?;
            maps.merchants.insert(
                id,
                MerchantSubject {
                    trade_name: get(&row, "trade_name")?,
                    status: get(&row, "status")?,
                },
            );
        }
    }
    if !attempt_ids.is_empty() {
        let rows = sqlx::query(
            "SELECT a.id::text AS id, a.reference, a.status::text AS status, \
                    a.total_charged_amount, a.currency::text AS currency, \
                    m.trade_name AS merchant_trade_name \
             FROM payment_attempts a LEFT JOIN merchants m ON m.id = a.merchant_id \
             WHERE a.id = ANY($1::uuid[])",
        )
        .bind(&attempt_ids)
        .fetch_all(pool)
        .await
        .map_err(crate::routes::common::database_error)?;
        for row in rows {
            let id: String = get(&row, "id")?;
            maps.attempts.insert(
                id,
                AttemptSubject {
                    reference: get(&row, "reference")?,
                    status: get(&row, "status")?,
                    total_charged_amount: get(&row, "total_charged_amount")?,
                    currency: get(&row, "currency")?,
                    merchant_trade_name: opt_get(&row, "merchant_trade_name")?,
                },
            );
        }
    }
    if !owner_ids.is_empty() {
        let rows = sqlx::query(
            "SELECT o.id::text AS id, o.full_name_en, o.full_name_ar, \
                    m.trade_name AS merchant_trade_name \
             FROM beneficial_owners o LEFT JOIN merchants m ON m.id = o.merchant_id \
             WHERE o.id = ANY($1::uuid[])",
        )
        .bind(&owner_ids)
        .fetch_all(pool)
        .await
        .map_err(crate::routes::common::database_error)?;
        for row in rows {
            let id: String = get(&row, "id")?;
            maps.owners.insert(
                id,
                OwnerSubject {
                    full_name_en: opt_get(&row, "full_name_en")?,
                    full_name_ar: get(&row, "full_name_ar")?,
                    merchant_trade_name: opt_get(&row, "merchant_trade_name")?,
                },
            );
        }
    }
    Ok(maps)
}

/// The subject name/merchant name/reference/status quartet shared by screening and case rows.
pub(super) struct SubjectView<'a> {
    pub name: String,
    pub reference: String,
    pub merchant_name: String,
    pub status: Option<String>,
    pub attempt: Option<&'a AttemptSubject>,
}

pub(super) fn subject_view<'a>(
    maps: &'a SubjectMaps,
    subject_type: &str,
    subject_id: &str,
) -> SubjectView<'a> {
    let merchant = maps.merchants.get(subject_id);
    let attempt = maps.attempts.get(subject_id);
    let owner = maps.owners.get(subject_id);
    let name = merchant
        .map(|row| row.trade_name.clone())
        .or_else(|| attempt.and_then(|row| row.merchant_trade_name.clone()))
        .or_else(|| {
            owner.and_then(|row| {
                row.full_name_en
                    .clone()
                    .or_else(|| Some(row.full_name_ar.clone()))
            })
        })
        .unwrap_or_else(|| subject_id.to_owned());
    let reference = attempt
        .map(|row| row.reference.clone())
        .unwrap_or_else(|| subject_id.to_owned());
    let merchant_name = merchant
        .map(|row| row.trade_name.clone())
        .or_else(|| attempt.and_then(|row| row.merchant_trade_name.clone()))
        .or_else(|| owner.and_then(|row| row.merchant_trade_name.clone()))
        .unwrap_or_default();
    let status = merchant
        .map(|row| row.status.clone())
        .or_else(|| attempt.map(|row| row.status.clone()));
    let _ = subject_type;
    SubjectView {
        name,
        reference,
        merchant_name,
        status,
        attempt,
    }
}

/* -------------------------------------------------------- screening shapes */

#[derive(Debug, Clone)]
pub(super) struct ScreeningMatchRow {
    pub id: Uuid,
    pub screening_id: Uuid,
    pub list_type: String,
    pub list_name: String,
    pub list_entry_ref: String,
    pub matched_name: String,
    pub score: rust_decimal::Decimal,
    pub attributes: Value,
    pub disposition: String,
    pub disposition_email: Option<String>,
    pub disposition_notes: Option<String>,
    pub suppress_future: bool,
    pub suppress_until: Option<NaiveDate>,
    pub created_at: NaiveDateTime,
}

/// Every match of the given screenings, grouped by screening id.
pub(super) async fn load_matches(
    pool: &PgPool,
    screening_ids: &[Uuid],
) -> Result<HashMap<Uuid, Vec<ScreeningMatchRow>>, ApiError> {
    let mut grouped: HashMap<Uuid, Vec<ScreeningMatchRow>> = HashMap::new();
    if screening_ids.is_empty() {
        return Ok(grouped);
    }
    let rows = sqlx::query(
        "SELECT m.id, m.screening_id, m.list_type::text AS list_type, m.list_name, m.list_entry_ref, \
                m.matched_name, m.score, m.attributes_json, m.disposition::text AS disposition, \
                u.email AS disposition_email, m.disposition_notes, m.suppress_future, m.suppress_until, \
                m.created_at \
         FROM aml_screening_matches m LEFT JOIN users u ON u.id = m.disposition_by \
         WHERE m.screening_id = ANY($1::uuid[]) ORDER BY m.created_at ASC, m.id ASC",
    )
    .bind(screening_ids)
    .fetch_all(pool)
    .await
    .map_err(crate::routes::common::database_error)?;
    for row in rows {
        let match_row = ScreeningMatchRow {
            id: get(&row, "id")?,
            screening_id: get(&row, "screening_id")?,
            list_type: get(&row, "list_type")?,
            list_name: get(&row, "list_name")?,
            list_entry_ref: get(&row, "list_entry_ref")?,
            matched_name: get(&row, "matched_name")?,
            score: get(&row, "score")?,
            attributes: get(&row, "attributes_json")?,
            disposition: get(&row, "disposition")?,
            disposition_email: opt_get(&row, "disposition_email")?,
            disposition_notes: opt_get(&row, "disposition_notes")?,
            suppress_future: get(&row, "suppress_future")?,
            suppress_until: opt_get(&row, "suppress_until")?,
            created_at: get(&row, "created_at")?,
        };
        grouped
            .entry(match_row.screening_id)
            .or_default()
            .push(match_row);
    }
    Ok(grouped)
}

/// `amlScreeningRow`.
#[derive(Debug, Clone)]
pub(super) struct ScreeningDb {
    pub id: Uuid,
    pub subject_type: String,
    pub subject_id: String,
    pub trigger: String,
    pub provider_code: String,
    pub provider_request_ref: Option<String>,
    pub list_versions: Value,
    pub result: String,
    pub match_count: i32,
    pub highest_score: Option<rust_decimal::Decimal>,
    pub requested_at: NaiveDateTime,
    pub completed_at: Option<NaiveDateTime>,
}

impl ScreeningDb {
    pub(super) fn from_row(row: &PgRow) -> Result<Self, ApiError> {
        Ok(Self {
            id: get(row, "id")?,
            subject_type: get(row, "subject_type")?,
            subject_id: get(row, "subject_id")?,
            trigger: get(row, "trigger")?,
            provider_code: get(row, "provider_code")?,
            provider_request_ref: opt_get(row, "provider_request_ref")?,
            list_versions: get(row, "list_versions_json")?,
            result: get(row, "result")?,
            match_count: get(row, "match_count")?,
            highest_score: opt_get(row, "highest_score")?,
            requested_at: get(row, "requested_at")?,
            completed_at: opt_get(row, "completed_at")?,
        })
    }
}

pub(super) fn screening_row(
    screening: &ScreeningDb,
    matches: &[ScreeningMatchRow],
    maps: &SubjectMaps,
    now: DateTime<Utc>,
) -> Value {
    let subject = subject_view(maps, &screening.subject_type, &screening.subject_id);
    let unresolved = matches
        .iter()
        .filter(|row| row.disposition == "UNREVIEWED")
        .count();
    let false_positive = matches
        .iter()
        .filter(|row| row.disposition == "FALSE_POSITIVE")
        .count();
    let true_match = matches
        .iter()
        .filter(|row| row.disposition == "TRUE_MATCH")
        .count();
    let escalated = matches
        .iter()
        .filter(|row| row.disposition == "ESCALATED")
        .count();
    let first_unresolved_id = matches
        .iter()
        .find(|row| row.disposition == "UNREVIEWED")
        .map(|row| row.id.to_string());
    let disposition = if unresolved == 0 && !matches.is_empty() {
        matches
            .first()
            .map(|row| Value::String(row.disposition.clone()))
            .unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    json!({
        "id": screening.id,
        "subjectType": screening.subject_type,
        "subjectId": screening.subject_id,
        "subjectName": subject.name,
        "subjectReference": subject.reference,
        "merchantName": subject.merchant_name,
        "provider": screening.provider_code,
        "providerRequestRef": screening.provider_request_ref,
        "trigger": screening.trigger,
        "lists": screening.list_versions,
        "result": screening.result,
        "score": money4(screening.highest_score),
        "matchCount": screening.match_count,
        "matchId": first_unresolved_id.map_or(Value::Null, Value::String),
        "disposition": disposition,
        "dispositionSummary": {
            "unreviewed": unresolved,
            "falsePositive": false_positive,
            "trueMatch": true_match,
            "escalated": escalated,
        },
        "requestedAt": iso_naive(screening.requested_at),
        "screenedAt": iso_naive(screening.requested_at),
        "completedAt": screening.completed_at.map(iso_naive),
        "ageHours": age_hours(screening.requested_at, now),
    })
}

/* ------------------------------------------------------------- case shapes */

pub(super) struct CaseDb {
    pub id: Uuid,
    pub subject_type: String,
    pub subject_id: String,
    pub trigger_reason: String,
    pub severity: String,
    pub severity_inputs: Value,
    pub screening_id: Option<Uuid>,
    pub rule_id: Option<Uuid>,
    pub rule_version: Option<i32>,
    pub hold_journal_entry_id: Option<Uuid>,
    pub regulatory_report_id: Option<String>,
    pub status: String,
    pub sla_due_at: Option<NaiveDateTime>,
    pub assigned_reviewer_id: Option<Uuid>,
    pub confidential: bool,
    pub reviewer_notes: Option<String>,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
}

impl CaseDb {
    pub(super) fn from_row(row: &PgRow) -> Result<Self, ApiError> {
        Ok(Self {
            id: get(row, "id")?,
            subject_type: get(row, "subject_type")?,
            subject_id: get(row, "subject_id")?,
            trigger_reason: get(row, "trigger_reason")?,
            severity: get(row, "severity")?,
            severity_inputs: get(row, "severity_inputs_json")?,
            screening_id: opt_get(row, "screening_id")?,
            rule_id: opt_get(row, "rule_id")?,
            rule_version: opt_get(row, "rule_version")?,
            hold_journal_entry_id: opt_get(row, "hold_journal_entry_id")?,
            regulatory_report_id: opt_get(row, "regulatory_report_id")?,
            status: get(row, "status")?,
            sla_due_at: opt_get(row, "sla_due_at")?,
            assigned_reviewer_id: opt_get(row, "assigned_reviewer_id")?,
            confidential: get(row, "confidential")?,
            reviewer_notes: opt_get(row, "reviewer_notes")?,
            created_at: get(row, "created_at")?,
            updated_at: get(row, "updated_at")?,
        })
    }
}

#[derive(Debug, Clone, Default)]
pub(super) struct RuleBrief {
    pub code: Option<String>,
    pub name: Option<String>,
}

#[derive(Debug, Clone)]
pub(super) struct ScreeningBrief {
    pub result: String,
    pub highest_score: Option<rust_decimal::Decimal>,
}

#[derive(Debug, Clone, Default)]
pub(super) struct CaseRelations {
    pub rules: HashMap<Uuid, RuleBrief>,
    pub screenings: HashMap<Uuid, ScreeningBrief>,
    pub reviewers: HashMap<Uuid, String>,
}

/// Batch-load the `rule` / `screening` / `assignedReviewer` includes of a case page.
pub(super) async fn load_case_relations(
    pool: &PgPool,
    cases: &[CaseDb],
) -> Result<CaseRelations, ApiError> {
    let mut rule_ids: Vec<Uuid> = cases.iter().filter_map(|row| row.rule_id).collect();
    rule_ids.sort_unstable();
    rule_ids.dedup();
    let mut screening_ids: Vec<Uuid> = cases.iter().filter_map(|row| row.screening_id).collect();
    screening_ids.sort_unstable();
    screening_ids.dedup();
    let mut reviewer_ids: Vec<Uuid> = cases
        .iter()
        .filter_map(|row| row.assigned_reviewer_id)
        .collect();
    reviewer_ids.sort_unstable();
    reviewer_ids.dedup();

    let mut relations = CaseRelations::default();
    if !rule_ids.is_empty() {
        let rows = sqlx::query("SELECT id, code, name FROM aml_rules WHERE id = ANY($1::uuid[])")
            .bind(&rule_ids)
            .fetch_all(pool)
            .await
            .map_err(crate::routes::common::database_error)?;
        for row in rows {
            relations.rules.insert(
                get(&row, "id")?,
                RuleBrief {
                    code: Some(get(&row, "code")?),
                    name: Some(get(&row, "name")?),
                },
            );
        }
    }
    if !screening_ids.is_empty() {
        let rows = sqlx::query(
            "SELECT id, result::text AS result, highest_score FROM aml_screenings WHERE id = ANY($1::uuid[])",
        )
        .bind(&screening_ids)
        .fetch_all(pool)
        .await
        .map_err(crate::routes::common::database_error)?;
        for row in rows {
            relations.screenings.insert(
                get(&row, "id")?,
                ScreeningBrief {
                    result: get(&row, "result")?,
                    highest_score: opt_get(&row, "highest_score")?,
                },
            );
        }
    }
    if !reviewer_ids.is_empty() {
        let rows = sqlx::query("SELECT id, email FROM users WHERE id = ANY($1::uuid[])")
            .bind(&reviewer_ids)
            .fetch_all(pool)
            .await
            .map_err(crate::routes::common::database_error)?;
        for row in rows {
            relations
                .reviewers
                .insert(get(&row, "id")?, get(&row, "email")?);
        }
    }
    Ok(relations)
}

/// `amlCaseListRow`.
pub(super) fn case_row(
    entry: &CaseDb,
    relations: &CaseRelations,
    maps: &SubjectMaps,
    now: DateTime<Utc>,
) -> Value {
    let subject = subject_view(maps, &entry.subject_type, &entry.subject_id);
    let rule = entry.rule_id.and_then(|id| relations.rules.get(&id));
    let screening = entry
        .screening_id
        .and_then(|id| relations.screenings.get(&id));
    let reviewer = entry
        .assigned_reviewer_id
        .and_then(|id| relations.reviewers.get(&id));
    let amount = subject
        .attempt
        .map(|attempt| money4(Some(attempt.total_charged_amount)));
    let currency = subject
        .attempt
        .map(|attempt| Value::String(attempt.currency.clone()))
        .unwrap_or(Value::Null);
    let overdue = entry.sla_due_at.is_some_and(|due| due < now.naive_utc());
    json!({
        "id": entry.id,
        "caseRef": case_ref(entry.id),
        "subjectType": entry.subject_type,
        "subjectId": entry.subject_id,
        "subjectName": subject.name,
        "subjectReference": subject.reference,
        "subjectStatus": subject.status,
        "merchantName": subject.merchant_name,
        "severity": entry.severity,
        "status": entry.status,
        "amount": amount.unwrap_or(Value::Null),
        "currency": currency,
        "ruleId": entry.rule_id,
        "ruleCode": rule.and_then(|rule| rule.code.clone()),
        "ruleName": rule.and_then(|rule| rule.name.clone()),
        "ruleVersion": entry.rule_version,
        "screeningId": entry.screening_id,
        "screeningResult": screening.map(|row| row.result.clone()),
        "screeningScore": screening.map(|row| money4(row.highest_score)).unwrap_or(Value::Null),
        "triggerReason": entry.trigger_reason,
        "severityInputs": entry.severity_inputs,
        "holdJournalEntryId": entry.hold_journal_entry_id,
        "regulatoryReportId": entry.regulatory_report_id,
        "assignedReviewerId": entry.assigned_reviewer_id,
        "assignedReviewerName": reviewer.cloned().unwrap_or_default(),
        "reviewerNotes": entry.reviewer_notes,
        "confidential": entry.confidential,
        "openedAt": iso_naive(entry.created_at),
        "createdAt": iso_naive(entry.created_at),
        "updatedAt": iso_naive(entry.updated_at),
        "slaDueAt": entry.sla_due_at.map(iso_naive),
        "ageHours": age_hours(entry.created_at, now),
        "slaOverdue": overdue,
    })
}

/* ------------------------------------------------------- regulatory shapes */

#[derive(Debug, Clone)]
pub(super) struct RegulatorySchemaDb {
    pub id: Uuid,
    pub authority: String,
    pub report_type: String,
    pub format: String,
    pub schema_code: String,
    pub report_code: String,
    pub name: String,
    pub version: i32,
    pub revision: i32,
    pub status: String,
    pub definition_sha256: Option<String>,
    pub mapping_sha256: Option<String>,
    pub template_sha256: Option<String>,
    pub cloned_from_schema_id: Option<Uuid>,
    pub compiled: Value,
    pub mapping: Value,
    pub sample_context: Option<Value>,
    pub notes: Option<String>,
    pub definition_text: Option<String>,
    pub template_object_id: Option<Uuid>,
    pub template_ciphertext: Option<String>,
    pub template_binding: Option<Value>,
    pub approval_request_id: Option<Uuid>,
    pub approved_at: Option<NaiveDateTime>,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
}

impl RegulatorySchemaDb {
    pub(super) fn from_row(row: &PgRow) -> Result<Self, ApiError> {
        Ok(Self {
            id: get(row, "id")?,
            authority: get(row, "authority")?,
            report_type: get(row, "report_type")?,
            format: get(row, "format")?,
            schema_code: get(row, "schema_code")?,
            report_code: get(row, "report_code")?,
            name: get(row, "name")?,
            version: get(row, "version")?,
            revision: get(row, "revision")?,
            status: get(row, "status")?,
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
            created_at: get(row, "created_at")?,
            updated_at: get(row, "updated_at")?,
        })
    }
}

/// The schema projection of every `SELECT` (the list and binding queries select the same columns).
pub(super) const SCHEMA_PROJECTION: &[&str] = &[
    "id",
    "authority",
    "report_type::text AS report_type",
    "format::text AS format",
    "schema_code",
    "report_code",
    "name",
    "version",
    "revision",
    "status::text AS status",
    "definition_sha256",
    "mapping_sha256",
    "template_sha256",
    "cloned_from_schema_id",
    "compiled_definition_json",
    "mapping_blueprint_json",
    "sample_context_json",
    "notes",
    "definition_text",
    "template_object_id",
    "template_ciphertext",
    "template_binding_json",
    "approval_request_id",
    "approved_at",
    "created_at",
    "updated_at",
];

pub(super) fn object_len(value: &Value, key: &str) -> Value {
    match value.as_object() {
        None => Value::Null,
        Some(object) => Value::from(
            object
                .get(key)
                .and_then(Value::as_object)
                .map_or(0, |map| map.len() as u64),
        ),
    }
}

/// `regulatorySchemaRow`.
pub(super) fn schema_row(schema: &RegulatorySchemaDb) -> Value {
    let root_element = schema
        .compiled
        .get("rootElement")
        .and_then(|root| root.get("name"))
        .cloned()
        .unwrap_or(Value::Null);
    json!({
        "id": schema.id,
        "authority": schema.authority,
        "reportType": schema.report_type,
        "format": schema.format,
        "schemaCode": schema.schema_code,
        "reportCode": schema.report_code,
        "name": schema.name,
        "version": schema.version,
        "status": schema.status,
        "definitionSha256": schema.definition_sha256,
        "mappingSha256": schema.mapping_sha256,
        "templateSha256": schema.template_sha256,
        "revision": schema.revision,
        "clonedFromSchemaId": schema.cloned_from_schema_id,
        "rootElement": root_element,
        "paths": object_len(&schema.compiled, "paths"),
        "codeLists": object_len(&schema.compiled, "codeLists"),
        "approvedAt": schema.approved_at.map(iso_naive),
        "approvalRequestId": schema.approval_request_id,
        "createdAt": iso_naive(schema.created_at),
        "updatedAt": iso_naive(schema.updated_at),
    })
}

#[derive(Debug, Clone)]
pub(super) struct ReportOutputRow {
    pub id: Uuid,
    pub format: String,
    pub revision: i32,
    pub schema_id: Option<Uuid>,
    pub schema_version: Option<i32>,
    pub validation_status: String,
    pub validation_errors: Option<Value>,
    pub content_sha256: String,
    pub generated_at: Option<NaiveDateTime>,
    pub submitted_at: Option<NaiveDateTime>,
    pub schema_code: Option<String>,
    pub schema_name: Option<String>,
    pub schema_status: Option<String>,
    /// True when the list select omitted the columns JS leaves `undefined` (and JSON drops).
    pub partial: bool,
}

/// `regulatoryReportOutputRow`.
pub(super) fn output_row(output: &ReportOutputRow) -> Value {
    let mut map = Map::new();
    if !output.partial {
        map.insert("id".into(), Value::String(output.id.to_string()));
    }
    map.insert("format".into(), Value::String(output.format.clone()));
    map.insert("revision".into(), Value::from(output.revision));
    if !output.partial {
        map.insert(
            "schemaId".into(),
            output
                .schema_id
                .map(|id| Value::String(id.to_string()))
                .unwrap_or(Value::Null),
        );
    }
    map.insert(
        "schemaVersion".into(),
        output.schema_version.map_or(Value::Null, Value::from),
    );
    map.insert(
        "schemaCode".into(),
        output
            .schema_code
            .clone()
            .map_or(Value::Null, Value::String),
    );
    map.insert(
        "schemaName".into(),
        output
            .schema_name
            .clone()
            .map_or(Value::Null, Value::String),
    );
    map.insert(
        "schemaStatus".into(),
        output
            .schema_status
            .clone()
            .map_or(Value::Null, Value::String),
    );
    map.insert(
        "validationStatus".into(),
        Value::String(output.validation_status.clone()),
    );
    map.insert(
        "validationErrors".into(),
        output.validation_errors.clone().unwrap_or(Value::Null),
    );
    map.insert(
        "contentSha256".into(),
        Value::String(output.content_sha256.clone()),
    );
    map.insert(
        "generatedAt".into(),
        output
            .generated_at
            .map(iso_naive)
            .map_or(Value::Null, Value::String),
    );
    map.insert(
        "submittedAt".into(),
        output
            .submitted_at
            .map(iso_naive)
            .map_or(Value::Null, Value::String),
    );
    Value::Object(map)
}

#[derive(Debug, Clone, Default)]
pub(super) struct AmlCaseBrief {
    pub status: Option<String>,
    pub severity: Option<String>,
    pub subject_id: Option<String>,
}

pub(super) struct ReportDb {
    pub id: Uuid,
    pub report_type: String,
    pub authority: String,
    pub subject_type: String,
    pub subject_id: String,
    pub aml_case_id: Option<Uuid>,
    pub status: String,
    pub submission_ref: Option<String>,
    pub submitted_at: Option<NaiveDateTime>,
    pub confidential: bool,
    pub approval_request_id: Option<Uuid>,
    pub due_at: Option<NaiveDateTime>,
    pub report_code: Option<String>,
    pub period_key: Option<String>,
    pub period_start: Option<NaiveDateTime>,
    pub period_end: Option<NaiveDateTime>,
    pub required_output_formats: Vec<String>,
    pub filing_channel: Option<String>,
    pub acknowledged_at: Option<NaiveDateTime>,
    pub rejection_reason: Option<String>,
    pub payload_sha256: String,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
}

impl ReportDb {
    pub(super) fn from_row(row: &PgRow) -> Result<Self, ApiError> {
        Ok(Self {
            id: get(row, "id")?,
            report_type: get(row, "report_type")?,
            authority: get(row, "authority")?,
            subject_type: get(row, "subject_type")?,
            subject_id: get(row, "subject_id")?,
            aml_case_id: opt_get(row, "aml_case_id")?,
            status: get(row, "status")?,
            submission_ref: opt_get(row, "submission_ref")?,
            submitted_at: opt_get(row, "submitted_at")?,
            confidential: get(row, "confidential")?,
            approval_request_id: opt_get(row, "approval_request_id")?,
            due_at: opt_get(row, "due_at")?,
            report_code: opt_get(row, "report_code")?,
            period_key: opt_get(row, "period_key")?,
            period_start: opt_get(row, "period_start")?,
            period_end: opt_get(row, "period_end")?,
            required_output_formats: get(row, "required_output_formats")?,
            filing_channel: opt_get(row, "filing_channel")?,
            acknowledged_at: opt_get(row, "acknowledged_at")?,
            rejection_reason: opt_get(row, "rejection_reason")?,
            payload_sha256: get(row, "payload_sha256")?,
            created_at: get(row, "created_at")?,
            updated_at: get(row, "updated_at")?,
        })
    }
}

pub(super) const REPORT_PROJECTION: &[&str] = &[
    "id",
    "report_type::text AS report_type",
    "authority",
    "subject_type",
    "subject_id",
    "aml_case_id",
    "status::text AS status",
    "submission_ref",
    "submitted_at",
    "confidential",
    "approval_request_id",
    "due_at",
    "report_code",
    "period_key",
    "period_start",
    "period_end",
    "required_output_formats::text[] AS required_output_formats",
    "filing_channel",
    "acknowledged_at",
    "rejection_reason",
    "payload_sha256",
    "created_at",
    "updated_at",
];

/// `regulatoryReportRow`.
pub(super) fn report_row(
    report: &ReportDb,
    case: Option<&AmlCaseBrief>,
    approval_state: Option<&str>,
    outputs: &[ReportOutputRow],
    subject_name_override: Option<&str>,
    now: DateTime<Utc>,
) -> Value {
    let subject_name = subject_name_override
        .map(str::to_owned)
        .or_else(|| case.and_then(|row| row.subject_id.clone()))
        .unwrap_or_else(|| report.subject_id.clone());
    let output_rows: Vec<Value> = outputs.iter().map(output_row).collect();
    json!({
        "id": report.id,
        "reportRef": report_ref(report.id),
        "reportType": report.report_type,
        "authority": report.authority,
        "status": report.status,
        "state": report.status,
        "subjectType": report.subject_type,
        "subjectId": report.subject_id,
        "amlCaseId": report.aml_case_id,
        "amlCaseStatus": case.and_then(|row| row.status.clone()),
        "amlCaseSeverity": case.and_then(|row| row.severity.clone()),
        "subjectName": subject_name,
        "periodStart": report.period_start.map(iso_naive),
        "periodEnd": report.period_end.map(iso_naive),
        "submissionRef": report.submission_ref,
        "reportCode": report.report_code,
        "periodKey": report.period_key,
        "dueAt": report.due_at.map(iso_naive),
        "requiredOutputFormats": report.required_output_formats,
        "filingChannel": report.filing_channel,
        "acknowledgedAt": report.acknowledged_at.map(iso_naive),
        "rejectionReason": report.rejection_reason,
        "outputs": output_rows,
        "payloadSha256": report.payload_sha256,
        "confidential": report.confidential,
        "approvalRequestId": report.approval_request_id,
        "approvalState": approval_state,
        "submittedAt": report.submitted_at.map(iso_naive),
        "createdAt": iso_naive(report.created_at),
        "updatedAt": iso_naive(report.updated_at),
        "ageHours": age_hours(report.created_at, now),
    })
}

/* ---------------------------------------------------------- filing adapters */

#[derive(Debug, Clone)]
pub(super) struct FilingAdapterDb {
    pub id: Uuid,
    pub name: String,
    pub authority: String,
    pub kind: String,
    pub status: String,
    pub endpoint_url: Option<String>,
    pub auth_header_name: Option<String>,
    pub has_secret: bool,
    pub timeout_seconds: i32,
    pub config: Option<Value>,
    pub last_used_at: Option<NaiveDateTime>,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
}

impl FilingAdapterDb {
    pub(super) fn from_row(row: &PgRow) -> Result<Self, ApiError> {
        Ok(Self {
            id: get(row, "id")?,
            name: get(row, "name")?,
            authority: get(row, "authority")?,
            kind: get(row, "kind")?,
            status: get(row, "status")?,
            endpoint_url: opt_get(row, "endpoint_url")?,
            auth_header_name: opt_get(row, "auth_header_name")?,
            has_secret: get::<Option<String>>(row, "auth_secret_ciphertext")?.is_some(),
            timeout_seconds: get(row, "timeout_seconds")?,
            config: opt_get(row, "config_json")?,
            last_used_at: opt_get(row, "last_used_at")?,
            created_at: get(row, "created_at")?,
            updated_at: get(row, "updated_at")?,
        })
    }
}

const SECRET_CONFIG_KEY: [&str; 7] = [
    "secret",
    "token",
    "password",
    "api_key",
    "authorization",
    "private_key",
    "credential",
];

fn is_secret_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    let compact = lower.replace(['-', '_'], "");
    SECRET_CONFIG_KEY.iter().any(|needle| {
        let normalized = needle.replace('_', "");
        compact.contains(&normalized) || lower.contains(needle)
    })
}

/// `redactConfigJson`: every object value under a secret-looking key becomes `"[redacted]"`.
pub(super) fn redact_config_json(value: &Value) -> Value {
    match value {
        Value::Array(entries) => Value::Array(entries.iter().map(redact_config_json).collect()),
        Value::Object(object) => {
            let mut map = Map::new();
            for (key, entry) in object {
                if is_secret_key(key) {
                    map.insert(key.clone(), Value::String("[redacted]".into()));
                } else {
                    map.insert(key.clone(), redact_config_json(entry));
                }
            }
            Value::Object(map)
        }
        other => other.clone(),
    }
}

/// `filingAdapterView`.
pub(super) fn filing_adapter_row(adapter: &FilingAdapterDb) -> Value {
    json!({
        "id": adapter.id,
        "name": adapter.name,
        "authority": adapter.authority,
        "kind": adapter.kind,
        "status": adapter.status,
        "endpointUrl": adapter.endpoint_url,
        "authHeaderName": adapter.auth_header_name,
        "hasSecret": adapter.has_secret,
        "timeoutSeconds": adapter.timeout_seconds,
        "configJson": adapter.config.clone().map(|value| redact_config_json(&value)),
        "lastUsedAt": adapter.last_used_at.map(iso_naive),
        "createdAt": iso_naive(adapter.created_at),
        "updatedAt": iso_naive(adapter.updated_at),
    })
}

/* ------------------------------------------------------------- vault/bytes */

/// `VaultContextCipher.decrypt` with the process key resolver (`KMS_KEYS_JSON`/`KMS_MASTER_KEY`).
fn vault() -> Vault<EnvironmentKeyResolver> {
    Vault::new(EnvironmentKeyResolver::from_process_env())
}

/// Decrypt a `VaultContextCipher` payload with the process key resolver.
pub(super) fn decrypt_vault(payload: &str) -> Result<String, String> {
    vault()
        .decrypt_secret(payload)
        .map_err(|error| error.to_string())
}

/// `readRegulatoryReportPayload`.
pub(super) fn read_payload(ciphertext: Option<&str>) -> Result<Value, ApiError> {
    let Some(ciphertext) = ciphertext else {
        return Ok(json!({}));
    };
    if let Ok(value) = serde_json::from_str::<Value>(ciphertext) {
        if value.is_object() {
            return Ok(value);
        }
    }
    let plain = vault().decrypt_secret(ciphertext).map_err(|error| {
        ApiError::new(
            409,
            "REPORT_PAYLOAD_UNREADABLE",
            "The stored report payload cannot be read",
        )
        .with_details(json!({ "reason": error.to_string() }))
    })?;
    match serde_json::from_str::<Value>(&plain) {
        Ok(value) if value.is_object() => Ok(value),
        _ => Err(ApiError::new(
            409,
            "REPORT_PAYLOAD_UNREADABLE",
            "The stored report payload cannot be read",
        )
        .with_details(json!({ "reason": "The decrypted report payload is not a JSON object" }))),
    }
}

/// Standard base64 with padding.
pub(super) fn base64_encode(bytes: &[u8]) -> String {
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

/// Standard base64 decode (padding optional, whitespace ignored).
pub(super) fn base64_decode(text: &str) -> Option<Vec<u8>> {
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

/// `contentDisposition` from `core-back/lib/contentDisposition.ts` (RFC 6266).
pub(super) fn content_disposition(kind: &str, file_name: Option<&str>, fallback: &str) -> String {
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

/* ------------------------------------------------------------ object reads */

#[derive(Debug, Clone)]
pub(super) struct StorageObjectDb {
    pub id: Uuid,
    pub bucket: String,
    pub namespace: String,
    pub storage_key: String,
    pub status: String,
    pub sha256_hex: String,
    pub byte_size: i64,
    pub chunk_size_bytes: i32,
    pub chunk_count: i32,
    pub detected_mime_type: String,
    pub original_filename: Option<String>,
    pub kek_key_version: i32,
    pub wrapped_dek: Vec<u8>,
    pub dek_nonce: Vec<u8>,
    pub stream_nonce_prefix: Vec<u8>,
    pub owner_merchant_id: Option<Uuid>,
    pub required_authority: String,
    pub confidentiality_tier: String,
    pub gc_claim_token: Option<Uuid>,
}

impl StorageObjectDb {
    pub(super) fn from_row(row: &PgRow) -> Result<Self, ApiError> {
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

pub(super) const STORAGE_OBJECT_PROJECTION: &str = "id, bucket::text AS bucket, namespace::text AS namespace, \
    storage_key, status::text AS status, sha256_hex, byte_size, chunk_size_bytes, chunk_count, \
    detected_mime_type, original_filename, kek_key_version, wrapped_dek, dek_nonce, \
    stream_nonce_prefix, owner_merchant_id, required_authority, confidentiality_tier, gc_claim_token";

fn namespace_from_text(value: &str) -> Option<StorageNamespace> {
    StorageNamespace::all()
        .into_iter()
        .find(|namespace| namespace.as_str() == value)
}

fn actor_authorities(principal: Option<&pg_domain_auth::Principal>) -> Vec<String> {
    principal
        .map(|principal| principal.authorities.clone())
        .unwrap_or_default()
}

/// Read a storage object the way `routeClient.readAuthorized` does: status gates, active holder
/// lock, namespace/row authority and pgos1 decryption, with an append-only access-log row for every
/// decision.
pub(super) async fn read_authorized_object(
    pool: &PgPool,
    principal: Option<&pg_domain_auth::Principal>,
    object_id: Uuid,
    holder_type: &str,
    holder_id: &str,
    ip_address: Option<&str>,
    request_id: Option<&str>,
) -> Result<(Vec<u8>, String, Option<String>), ApiError> {
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
    .map_err(crate::routes::common::database_error)?
    .ok_or_else(|| {
        ApiError::new(
            404,
            "STORAGE_OBJECT_NOT_FOUND",
            format!("Object {object_id} not found"),
        )
    })?;
    let object = StorageObjectDb::from_row(&row)?;
    let matching_locks: i64 = get(&row, "matching_locks")?;
    let authority_actor = actor_authorities(principal);

    let deny =
        |action: &'static str, status: u16, code: &'static str, message: String, reason: String| {
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
                    Some(&reason),
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
                format!("Object status is {}", object.status),
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
                format!("Object status is {}", object.status),
            )
            .await)
        }
        _ => {
            return Err(deny(
                "READ_DENIED_STATUS",
                409,
                "STORAGE_OBJECT_STAGING_NOT_READY",
                format!("Object {} is in {} state", object.id, object.status),
                format!("Object status is {}", object.status),
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
            "Object is being collected".to_owned(),
        )
        .await);
    }
    if matching_locks == 0 {
        return Err(deny(
            "READ_DENIED_HOLDER_MISMATCH",
            403,
            "STORAGE_ACCESS_DENIED",
            "Requested object is not bound to the specified domain record".to_owned(),
            format!(
                "Object {} is not locked by {holder_type}:{holder_id}",
                object.id
            ),
        )
        .await);
    }
    if let Some(owner) = object.owner_merchant_id {
        let principal_merchant = principal.and_then(|principal| principal.merchant_id.as_deref());
        if principal_merchant.is_some_and(|merchant| merchant != owner.to_string()) {
            return Err(deny(
                "READ_DENIED_TENANT_MISMATCH",
                403,
                "STORAGE_TENANT_MISMATCH",
                "Cross-tenant access to storage object is forbidden".to_owned(),
                format!("Actor merchant != object owner {owner}"),
            )
            .await);
        }
    }
    let has_super_admin = authority_actor
        .iter()
        .any(|authority| authority == "*" || authority == "system:storage:admin");
    let accepted: Vec<&str> = namespace_from_text(&object.namespace)
        .map(|namespace| namespace.policy().required_authorities.to_vec())
        .unwrap_or_default();
    let has_authority = has_super_admin
        || object.confidentiality_tier == "PUBLIC_BRAND"
        || accepted.iter().any(|authority| {
            authority_actor
                .iter()
                .any(|held| held.as_str() == *authority)
        })
        || authority_actor
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
            format!("Missing required authority: {}", object.required_authority),
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
        Some(bytes.len() as i64),
    )
    .await;
    Ok((bytes, object.detected_mime_type, object.original_filename))
}

/// Read a worker-owned object (`workerClient.readInternal`): status gates and decryption, no
/// holder lock or per-actor authority (the call site is trusted internal code).
pub(super) async fn read_internal_object(
    pool: &PgPool,
    object_id: Uuid,
) -> Result<Vec<u8>, ApiError> {
    let row = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {STORAGE_OBJECT_PROJECTION} FROM storage_objects WHERE id = $1"
    )))
    .bind(object_id)
    .fetch_optional(pool)
    .await
    .map_err(crate::routes::common::database_error)?
    .ok_or_else(|| {
        ApiError::new(
            404,
            "STORAGE_OBJECT_NOT_FOUND",
            format!("Object {object_id} not found"),
        )
    })?;
    let object = StorageObjectDb::from_row(&row)?;
    match object.status.as_str() {
        "ACTIVE" => {}
        "QUARANTINE_PENDING_AV" | "QUARANTINE_REJECTED" => {
            return Err(ApiError::new(
                423,
                "STORAGE_OBJECT_QUARANTINED",
                format!(
                    "Object {} cannot be downloaded while in {} state",
                    object.id, object.status
                ),
            ))
        }
        "PURGED" => {
            return Err(ApiError::new(
                409,
                "STORAGE_OBJECT_PURGED",
                format!("Object {} is in {} state", object.id, object.status),
            ))
        }
        _ => {
            return Err(ApiError::new(
                409,
                "STORAGE_OBJECT_STAGING_NOT_READY",
                format!("Object {} is in {} state", object.id, object.status),
            ))
        }
    }
    read_blob_bytes(&object).await.map_err(|error| {
        tracing::error!(object = %object.id, error = %error, "object-storage read failed");
        ApiError::new(
            503,
            "STORAGE_OBJECT_UNAVAILABLE",
            "The storage vault is unavailable",
        )
    })
}

fn actor_id(principal: Option<&pg_domain_auth::Principal>) -> String {
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
    .map_err(crate::routes::common::database_error)
}

async fn read_blob_bytes(object: &StorageObjectDb) -> Result<Vec<u8>, String> {
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

/* ------------------------------------------------------ shared projections */

/// Every screening/case list select uses this projection (`*` would also return the join columns).
pub(super) const SCREENING_PROJECTION: &[&str] = &[
    "id",
    "subject_type::text AS subject_type",
    "subject_id",
    "trigger::text AS trigger",
    "provider_code",
    "provider_request_ref",
    "list_versions_json",
    "result::text AS result",
    "match_count",
    "highest_score",
    "requested_at",
    "completed_at",
];

pub(super) const CASE_PROJECTION: &[&str] = &[
    "c.id",
    "c.subject_type::text AS subject_type",
    "c.subject_id",
    "c.trigger_reason",
    "c.severity::text AS severity",
    "c.severity_inputs_json",
    "c.screening_id",
    "c.rule_id",
    "c.rule_version",
    "c.hold_journal_entry_id",
    "c.regulatory_report_id",
    "c.status::text AS status",
    "c.sla_due_at",
    "c.assigned_reviewer_id",
    "c.confidential",
    "c.reviewer_notes",
    "c.created_at",
    "c.updated_at",
];

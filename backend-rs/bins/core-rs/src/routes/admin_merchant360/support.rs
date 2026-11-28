//! Shared helpers of the admin merchant-360 read routes.
//!
//! The resource modules stay close to the TypeScript handlers:
//!
//! - `core-back/api/internal/admin.ts` (`/merchants/export`, `/merchants/summary[/export]`,
//!   `/merchants/:id/summary/export` and the `:id` sub-lists at `:5792`-`:6303`), plus
//!   `/merchants/:id/{pending-changes,detail-changes}` (`:6790`, `:6850`);
//! - `core-back/api/internal/adminCommerce.ts:1545` (`/merchants/:id/beneficial-owners`).
//!
//! Reused from `admin_commerce` (not copied): query parsing, staff visibility flags, row readers,
//! `Money4`/`JsDate` formatting, `listQuery` condition mutators, the merchant summary serialiser
//! (through `merchants::list`/`merchants::detail`) and the wallet balance reader. What is local:
//! the export audit row (`writeAudit`), the merchant-360 redaction helpers (`merchantMoney`,
//! `merchantMaskedJson`, `redactDetailChange`), `naturalShardBalance`, the stats period/success
//! rate helpers and the operator-case inquiry eligibility predicate.

#![forbid(unsafe_code)]

use chrono::{Duration, NaiveDateTime, Utc};
use ntex::web::HttpRequest;
use pg_db::{BuiltListQuery, SqlBind};
use pg_domain_auth::Principal;
use pg_http::ApiError;
use rust_decimal::Decimal;
use serde_json::{json, Map, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::routes::admin_commerce::common;

/// Statuses that count as a successful payment (`merchantSuccessStatuses`).
pub const MERCHANT_SUCCESS_STATUSES: &[&str] =
    &["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED", "DISPUTED"];

/// `AML_OPEN_STATUSES` (`admin.ts:8113`).
pub const AML_OPEN_STATUSES: &[&str] = &["OPEN", "IN_REVIEW", "PENDING_CHECKER"];

/// `MERCHANT_OPEN_AML_STATUSES` (`admin.ts:4690`), used by the list/export filter.
pub const MERCHANT_OPEN_AML_STATUSES: &[&str] = &[
    "OPEN",
    "IN_REVIEW",
    "PENDING_CHECKER",
    "FROZEN",
    "ESCALATED_STR",
];

/// `MERCHANT_OPEN_JOIN_STATUSES` (`admin.ts:4689`).
pub const MERCHANT_OPEN_JOIN_STATUSES: &[&str] = &[
    "DRAFT",
    "SUBMITTED",
    "IN_REVIEW",
    "INFO_REQUESTED",
    "PENDING_CHECKER",
];

/// `merchantSensitiveHistoryFields` (`admin.ts:4841`).
pub const SENSITIVE_HISTORY_FIELDS: &[&str] = &[
    "legalName",
    "taxId",
    "registrationNo",
    "businessCategory",
    "riskTier",
    "kybStatus",
    "payoutBankDetailsJson",
    "commissionReceivableCeiling",
    "negativeBalanceCeiling",
    "contactEmail",
    "contactPhone",
    "suspensionReasonCode",
    "suspensionNotes",
    "closedReasonCode",
    "closedNotes",
];

/// Account types whose shard balances are already in the natural sign (debit-positive).
const DEBIT_POSITIVE_ACCOUNT_TYPES: &[&str] = &[
    "TREASURY",
    "GATEWAY_CLEARING",
    "COMMISSION_RECEIVABLE",
    "PROVIDER_FEE_EXPENSE",
    "GATEWAY_FEE_EXPENSE",
];

/// `idSchema`/`idParam`: a malformed path id is a `400 INVALID_BODY`, never a 500.
pub fn parse_uuid(raw: &str) -> Result<Uuid, ApiError> {
    Uuid::parse_str(raw.trim()).map_err(|_| {
        ApiError::new(400, "INVALID_BODY", "Invalid request data").with_details(json!([{
            "path": ["id"],
            "code": "invalid_string",
            "message": "must be a UUID",
        }]))
    })
}

/// The `:id` of `/internal/admin/merchants/:id/...` (the segment after `merchants`).
pub fn merchant_id(request: &HttpRequest) -> Result<String, ApiError> {
    let segments: Vec<&str> = request
        .path()
        .trim_end_matches('/')
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    let raw = segments
        .iter()
        .position(|segment| *segment == "merchants")
        .and_then(|index| segments.get(index + 1))
        .copied()
        .unwrap_or_default();
    parse_uuid(raw).map(|id| id.to_string())
}

/// `400 MERCHANT_NOT_FOUND`… actually `404 MERCHANT_NOT_FOUND` (`admin.ts:5599`).
pub fn merchant_not_found() -> ApiError {
    ApiError::new(404, "MERCHANT_NOT_FOUND", "The merchant does not exist")
}

/// The 403 the financial merchant sub-lists raise before reading rows.
pub fn financial_access_required(message: &str) -> ApiError {
    ApiError::new(403, "MERCHANT_FINANCIAL_ACCESS_REQUIRED", message)
}

/// Verify the merchant exists; returns the id (TS `findUnique({select:{id:true}})` + 404).
pub async fn require_merchant(pool: &PgPool, id: &str) -> Result<Uuid, ApiError> {
    let merchant = parse_uuid(id)?;
    let exists: Option<Uuid> = sqlx::query_scalar("SELECT id FROM merchants WHERE id = $1")
        .bind(merchant)
        .fetch_optional(pool)
        .await
        .map_err(common::database_error)?;
    exists.ok_or_else(merchant_not_found).map(|_| merchant)
}

/// Append `column = $n::uuid` for the merchant-owned merchant-360 lists.
pub fn scope_merchant(built: &mut BuiltListQuery, column: &str, merchant_id: &Uuid) {
    built.binds.push(SqlBind::Text(merchant_id.to_string()));
    let placeholder = built.binds.len();
    common::add_condition(built, &format!("{column} = ${placeholder}::uuid"));
}

/// Append `(a = $n::uuid OR b = $n::text)` (the adjustments ownership scope).
pub fn scope_merchant_or_owner(
    built: &mut BuiltListQuery,
    attempt_column: &str,
    owner_column: &str,
    merchant_id: &Uuid,
) {
    built.binds.push(SqlBind::Text(merchant_id.to_string()));
    let placeholder = built.binds.len();
    common::add_condition(
        built,
        &format!(
            "({attempt_column} = ${placeholder}::uuid OR {owner_column} = ${placeholder}::text)"
        ),
    );
}

/// `client.<model>.count(...)`: these TS handlers always count, even with `includeTotal=false`.
pub async fn count_rows(
    pool: &PgPool,
    built: &BuiltListQuery,
    from: &str,
) -> Result<i64, ApiError> {
    let sql = built.count_sql(from);
    let row = built
        .bind_count(&sql)
        .fetch_one(pool)
        .await
        .map_err(common::database_error)?;
    Ok(row.get::<i64, _>(0))
}

/// `naturalShardBalance` (`lib/storageEngine/shardBalances.ts:86`).
#[must_use]
pub fn natural_shard_balance(account_type: &str, stored: Decimal) -> Decimal {
    if stored.is_zero() {
        return Decimal::ZERO;
    }
    if DEBIT_POSITIVE_ACCOUNT_TYPES.contains(&account_type) {
        stored
    } else {
        -stored
    }
}

/// `merchantMoney`: `decimal(value).toFixed(4)`; a NULL column renders `"0.0000"` like the `_sum`
/// fallbacks instead of throwing the way `decimal(null)` would in TS.
#[must_use]
pub fn merchant_money(value: Option<Decimal>) -> Value {
    Value::String(pg_types::Money4(value.unwrap_or_default()).to_string())
}

/// `maskBankAccount` (`admin.ts:5775`).
#[must_use]
pub fn mask_bank_account(value: &Value) -> Value {
    let text = match value {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    };
    if text.chars().count() <= 4 {
        return Value::String(if text.is_empty() {
            String::new()
        } else {
            "****".to_owned()
        });
    }
    let tail: String = text
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    Value::String(format!("****{tail}"))
}

fn key_looks_financial(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    ["account", "iban", "number", "phone", "email"]
        .iter()
        .any(|needle| lower.contains(needle))
}

/// `merchantMaskedJson` (`admin.ts:5777`): financial-looking keys masked, scalars kept.
#[must_use]
pub fn masked_json(value: &Value) -> Value {
    let Value::Object(source) = value else {
        return json!({});
    };
    let mut result = Map::new();
    for (key, entry) in source {
        if key_looks_financial(key) {
            result.insert(key.clone(), mask_bank_account(entry));
        } else if matches!(
            entry,
            Value::String(_) | Value::Number(_) | Value::Bool(_) | Value::Null
        ) {
            result.insert(key.clone(), entry.clone());
        }
    }
    Value::Object(result)
}

/// `redactDetailChange` (`admin.ts:4849`): the detail-change row plus the actor e-mail and the
/// sensitive-field redaction.
#[must_use]
pub fn redact_detail_change(entry: &Value, can_sensitive: bool, can_aml: bool) -> Value {
    let field_name = entry
        .get("fieldName")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let field = field_name
        .trim_start_matches('/')
        .split('/')
        .next()
        .unwrap_or_default();
    let sensitive = SENSITIVE_HISTORY_FIELDS.contains(&field);
    let new_value = entry.get("newValue").and_then(Value::as_str).unwrap_or("");
    let aml_reason = field == "suspensionReasonCode" && new_value == "AML";
    let redact = (!can_sensitive && sensitive) || (aml_reason && !can_aml);

    let mut output = match entry {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    };
    let actor_email = entry
        .get("actor")
        .and_then(|actor| actor.get("email"))
        .cloned()
        .unwrap_or(Value::Null);
    output.insert("actorEmail".to_owned(), actor_email);
    if redact {
        output.insert(
            "oldValue".to_owned(),
            Value::String("[REDACTED]".to_owned()),
        );
        output.insert(
            "newValue".to_owned(),
            Value::String("[REDACTED]".to_owned()),
        );
    }
    output.insert("redacted".to_owned(), Value::Bool(redact));
    Value::Object(output)
}

/// `resolveReportingCurrency` (`lib/reportingCurrency.ts`): a three-letter code or `BASE_CURRENCY`.
#[must_use]
pub fn reporting_currency(query: &Map<String, Value>) -> String {
    if let Some(value) = common::query_text(query, "currency") {
        let upper = value.to_ascii_uppercase();
        if upper.len() == 3 && upper.bytes().all(|byte| byte.is_ascii_alphabetic()) {
            return upper;
        }
    }
    std::env::var("BASE_CURRENCY")
        .ok()
        .map(|value| value.trim().to_ascii_uppercase())
        .filter(|value| value.len() == 3 && value.bytes().all(|byte| byte.is_ascii_alphabetic()))
        .unwrap_or_else(|| "LYD".to_owned())
}

/// `merchantPeriodLabel` (`admin.ts:4878`) + `merchantStatsSince` (`:4872`).
#[must_use]
pub fn stats_period(query: &Map<String, Value>) -> (&'static str, i64) {
    let normalized = common::query_text(query, "period")
        .unwrap_or_else(|| "30d".to_owned())
        .to_ascii_lowercase();
    match normalized.as_str() {
        "24h" => ("24h", 1),
        "7d" => ("7d", 7),
        "90d" => ("90d", 90),
        _ => ("30d", 30),
    }
}

/// `new Date(Date.now() - days * 86_400_000)` in the database's `timestamp` representation.
#[must_use]
pub fn stats_since(days: i64, now: chrono::DateTime<Utc>) -> NaiveDateTime {
    now.naive_utc() - Duration::days(days)
}

/// `successRatePercent`: `Number(((succeeded / counted) * 100).toFixed(2))`.
#[must_use]
pub fn success_rate_percent(succeeded: i64, counted: i64) -> Value {
    if counted <= 0 {
        return json!(0);
    }
    let value = (succeeded as f64 / counted as f64) * 100.0;
    let rounded = (value * 100.0).round() / 100.0;
    pg_db::js_number_value(rounded)
}

/// `operatorCaseInquiryEligibility` (`lib/operatorCases.ts:36`) for a row without a case scope.
#[must_use]
pub fn inquiry_eligibility(
    attempt_status: Option<&str>,
    terminal: bool,
    supports_status_check: bool,
) -> (bool, &'static str) {
    let Some(attempt_status) = attempt_status.filter(|value| !value.is_empty()) else {
        return (false, "NO_ATTEMPT");
    };
    if terminal {
        return (false, "ATTEMPT_TERMINAL");
    }
    let status = attempt_status.to_ascii_uppercase();
    if !matches!(status.as_str(), "UNKNOWN" | "VERIFYING") {
        return (false, "ATTEMPT_NOT_INQUIRABLE");
    }
    if !supports_status_check {
        return (false, "GATEWAY_HAS_NO_STATUS_INQUIRY");
    }
    (true, "ELIGIBLE")
}

/// One `writeAudit({ data })` payload.
pub struct AuditEvent<'a> {
    pub action: &'a str,
    pub entity_type: &'a str,
    pub entity_id: &'a str,
    pub before: Value,
    pub after: Value,
}

/// `writeAudit`: the compatibility `audit_log` row and, when a dedicated audit database is
/// configured, the `audit_outbox` copy in one transaction.
pub async fn write_audit(
    pool: &PgPool,
    dedicated_audit_database: bool,
    principal: Option<&Principal>,
    event: AuditEvent<'_>,
) -> Result<(), ApiError> {
    let actor = principal
        .and_then(|principal| principal.user_id.as_deref())
        .and_then(|value| Uuid::parse_str(value).ok())
        .ok_or_else(ApiError::server_error)?;
    let role = principal
        .and_then(|principal| principal.role.clone())
        .unwrap_or_else(|| "UNKNOWN".to_owned());
    let id = pg_types::new_v7();
    let now = Utc::now().naive_utc();
    let mut tx = pool.begin().await.map_err(common::database_error)?;
    sqlx::query(
        "INSERT INTO audit_log (id, created_at, updated_at, actor_id, role, action,
                                entity_type, entity_id, before_json, after_json)
         VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6, $7, $8, $9::jsonb, $10::jsonb)",
    )
    .bind(id)
    .bind(now)
    .bind(now)
    .bind(actor)
    .bind(role.as_str())
    .bind(event.action)
    .bind(event.entity_type)
    .bind(event.entity_id)
    .bind(event.before.clone())
    .bind(event.after.clone())
    .execute(&mut *tx)
    .await
    .map_err(common::database_error)?;
    if dedicated_audit_database {
        sqlx::query(
            "INSERT INTO audit_outbox (id, actor_id, role, action, entity_type, entity_id,
                                       before_json, after_json, created_at)
             VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::timestamptz)",
        )
        .bind(id)
        .bind(actor)
        .bind(role.as_str())
        .bind(event.action)
        .bind(event.entity_type)
        .bind(event.entity_id)
        .bind(event.before)
        .bind(event.after)
        .bind(Utc::now())
        .execute(&mut *tx)
        .await
        .map_err(common::database_error)?;
    }
    tx.commit().await.map_err(common::database_error)?;
    Ok(())
}

/// `JSON.stringify(query)` for the export audit `filters` field.
#[must_use]
pub fn query_json(query: &Map<String, Value>) -> String {
    Value::Object(query.clone()).to_string()
}

/// The `checklist` query value filtered against the route's allow-list (`admin.ts:5558`).
#[must_use]
pub fn checklist(query: &Map<String, Value>, allowed: &[&str]) -> Vec<String> {
    common::query_raw(query, "checklist")
        .map(|raw| {
            raw.split(',')
                .map(str::trim)
                .filter(|entry| allowed.contains(entry))
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// Collect the cursor values of one row for the active keyset plan.
pub fn push_cursor(
    plan: &Option<pg_db::KeysetPlan>,
    created_at: NaiveDateTime,
    updated_at: Option<NaiveDateTime>,
    id: &str,
    output: &mut Vec<Vec<pg_db::CursorValue>>,
) {
    if let Some(plan) = plan {
        let values = common::cursor_values(plan, created_at, updated_at, id);
        if values.len() == plan.fields.len() {
            output.push(values);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuid_errors_are_invalid_body_like_the_ts_id_schema() {
        let error = parse_uuid("not-a-uuid").expect_err("invalid");
        assert_eq!(error.status, 400);
        assert_eq!(error.code, "INVALID_BODY");
        assert_eq!(error.message, "Invalid request data");
        assert!(error.details.is_some());
        let id = Uuid::new_v4();
        assert_eq!(parse_uuid(&id.to_string()).expect("uuid"), id);
    }

    #[test]
    fn natural_sign_flips_credit_normal_accounts() {
        assert_eq!(
            natural_shard_balance("MERCHANT_WALLET", Decimal::new(-2500, 2)),
            Decimal::new(2500, 2)
        );
        assert_eq!(
            natural_shard_balance("TREASURY", Decimal::new(-2500, 2)),
            Decimal::new(-2500, 2)
        );
        assert_eq!(
            natural_shard_balance("MERCHANT_WALLET", Decimal::ZERO),
            Decimal::ZERO
        );
    }

    #[test]
    fn masking_matches_the_merchant_drawer() {
        assert_eq!(
            masked_json(&json!({
                "iban": "LY000000000000000000",
                "bank": "Test Bank",
                "nested": { "a": 1 },
                "phone": "+218910000000",
            })),
            json!({
                "iban": "****0000",
                "bank": "Test Bank",
                "phone": "****0000",
            })
        );
        assert_eq!(masked_json(&json!("scalar")), json!({}));
        assert_eq!(
            mask_bank_account(&Value::String("12".to_owned())),
            Value::String("****".to_owned())
        );
        assert_eq!(
            mask_bank_account(&Value::String(String::new())),
            Value::String(String::new())
        );
    }

    #[test]
    fn detail_change_redaction_uses_the_field_and_aml_rules() {
        let entry = json!({
            "id": "0190f5c0-0000-7000-8000-000000000001",
            "fieldName": "/taxId",
            "oldValue": "OLD",
            "newValue": "NEW",
            "actor": { "email": "actor@example.test" },
        });
        let reader = redact_detail_change(&entry, false, false);
        assert_eq!(reader["oldValue"], "[REDACTED]");
        assert_eq!(reader["newValue"], "[REDACTED]");
        assert_eq!(reader["redacted"], true);
        assert_eq!(reader["actorEmail"], "actor@example.test");

        let compliance = redact_detail_change(&entry, true, true);
        assert_eq!(compliance["oldValue"], "OLD");
        assert_eq!(compliance["redacted"], false);

        let aml = json!({
            "fieldName": "/suspensionReasonCode",
            "oldValue": "X",
            "newValue": "AML",
        });
        assert_eq!(redact_detail_change(&aml, true, false)["redacted"], true);
        assert_eq!(redact_detail_change(&aml, true, true)["redacted"], false);
    }

    #[test]
    fn period_and_currency_follow_the_ts_helpers() {
        let mut query = Map::new();
        query.insert("period".to_owned(), Value::String("7d".to_owned()));
        assert_eq!(stats_period(&query), ("7d", 7));
        query.insert("period".to_owned(), Value::String("14d".to_owned()));
        assert_eq!(stats_period(&query), ("30d", 30));
        query.insert("period".to_owned(), Value::String("24H".to_owned()));
        assert_eq!(stats_period(&query), ("24h", 1));

        let mut query = Map::new();
        query.insert("currency".to_owned(), Value::String("usd".to_owned()));
        assert_eq!(reporting_currency(&query), "USD");
        query.insert("currency".to_owned(), Value::String("us".to_owned()));
        let fallback = std::env::var("BASE_CURRENCY").unwrap_or_else(|_| "LYD".to_owned());
        assert_eq!(reporting_currency(&query), fallback.to_ascii_uppercase());
    }

    #[test]
    fn success_rate_is_a_two_decimal_js_number() {
        assert_eq!(success_rate_percent(0, 0), json!(0));
        assert_eq!(success_rate_percent(1, 3), json!(33.33));
        assert_eq!(success_rate_percent(2, 3), json!(66.67));
        assert_eq!(success_rate_percent(4, 4), json!(100));
    }

    #[test]
    fn inquiry_eligibility_matches_the_ts_order() {
        assert_eq!(
            inquiry_eligibility(None, false, true),
            (false, "NO_ATTEMPT")
        );
        assert_eq!(
            inquiry_eligibility(Some("UNKNOWN"), true, true),
            (false, "ATTEMPT_TERMINAL")
        );
        assert_eq!(
            inquiry_eligibility(Some("SUCCEEDED"), false, true),
            (false, "ATTEMPT_NOT_INQUIRABLE")
        );
        assert_eq!(
            inquiry_eligibility(Some("VERIFYING"), false, false),
            (false, "GATEWAY_HAS_NO_STATUS_INQUIRY")
        );
        assert_eq!(
            inquiry_eligibility(Some("unknown"), false, true),
            (true, "ELIGIBLE")
        );
    }

    #[test]
    fn query_json_keeps_the_first_value_order() {
        let mut query = Map::new();
        query.insert("search".to_owned(), Value::String("acme".to_owned()));
        query.insert("page".to_owned(), Value::String("1".to_owned()));
        assert_eq!(query_json(&query), r#"{"search":"acme","page":"1"}"#);
    }
}

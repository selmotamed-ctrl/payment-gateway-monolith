//! Shared helpers for the admin system read routes (P4-T04).
//!
//! These helpers are deliberately thin and local: query-value parsing with the Express/scalar
//! semantics (`queryString` trims, first value wins), `enumListFilter`/`booleanFilter` from
//! `adminSliceHelpers.ts`, JavaScript date/number formatting and the small domain predicates the
//! dashboard uses. SQL stays in each route module next to the TS handler it ports.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;

use chrono::{DateTime, NaiveDateTime, Utc};
use pg_domain_auth::Principal;
use pg_http::ApiError;
use pg_types::{js_object_order, JsDate};
use rust_decimal::Decimal;
use serde_json::{json, Value};
use uuid::Uuid;

/// The write-only Platform Setting secret mask (`settingsWrite.ts`).
pub const SECRET_MASK: &str = "••••";

/// The checkout payer-help Platform Setting key.
pub const CHECKOUT_SUPPORT_KEY: &str = "checkout.support_config";

/// The cross-cutting dashboard/lookup/search read floor (`admin.ts:1205-1219`).
pub const STAFF_READ_AUTHORITIES: &[&str] = &[
    "merchant:read",
    "finance:read",
    "gateway:read",
    "case:read",
    "operator:read",
    "kyb:read",
    "compliance:read",
    "aml:read",
    "security:read",
    "reconciliation:read",
    "approval:read",
    "cashout:read",
    "dispute:read",
    "attempt:read",
];

/// The wildcard-safe replacement for `requireAuthorities` (OR semantics, staff-only wildcard).
pub fn require_authorities(principal: &Principal, required: &[&str]) -> Result<(), ApiError> {
    if required.is_empty() {
        return Ok(());
    }
    let wildcard = principal.authorities.iter().any(|held| held == "*")
        && principal.kind == pg_domain_auth::PrincipalKind::Session;
    let allowed = required
        .iter()
        .any(|authority| principal.authorities.iter().any(|held| held == authority));
    if wildcard || allowed {
        return Ok(());
    }
    Err(ApiError::new(
        403,
        "AUTHORITY_REQUIRED",
        "The principal lacks the required authority",
    )
    .with_details(json!({ "required": required })))
}

/// `QueryRecord` with Express scalar semantics: first value wins, values trimmed on read.
#[derive(Debug, Clone, Default)]
pub struct Params {
    values: BTreeMap<String, String>,
}

impl Params {
    #[must_use]
    pub fn parse(raw: &str) -> Self {
        let mut values = BTreeMap::new();
        for (key, value) in url::form_urlencoded::parse(raw.as_bytes()) {
            values.entry(key.into_owned()).or_insert(value.into_owned());
        }
        Self { values }
    }

    #[must_use]
    pub fn get(&self, key: &str) -> Option<&str> {
        self.values.get(key).map(String::as_str)
    }

    /// `queryString`: trimmed and empty becomes absent.
    #[must_use]
    pub fn string(&self, key: &str) -> Option<String> {
        self.get(key)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    }

    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.values.keys().map(String::as_str)
    }
}

/// Express `req.query` shape (`Map<String, Value>`) for the pg-db list builder.
#[must_use]
pub fn raw_query(request: &ntex::web::HttpRequest) -> serde_json::Map<String, Value> {
    let params = Params::parse(request.query_string());
    let mut raw = serde_json::Map::new();
    for key in params.keys() {
        if let Some(value) = params.string(key) {
            raw.insert(key.to_owned(), Value::String(value));
        }
    }
    raw
}

/// Append a `searchClause`-shaped OR to a built list query.
///
/// Text columns use `ILIKE '%value%'`; a value that parses as a UUID also matches the listed uuid
/// columns exactly. With no text column and no uuid match the clause is `FALSE` (TS uses
/// `{id: {in: []}}`), so a search never degrades into "match everything".
pub fn append_search(
    built: &mut pg_db::BuiltListQuery,
    text_columns: &[&str],
    uuid_columns: &[&str],
    search: &str,
) {
    let mut parts: Vec<String> = Vec::new();
    if !text_columns.is_empty() {
        built
            .binds
            .push(pg_db::SqlBind::Text(format!("%{search}%")));
        let placeholder = format!("${}::text", built.binds.len());
        for column in text_columns {
            parts.push(format!("{column} ILIKE {placeholder}"));
        }
    }
    if let Ok(uuid) = Uuid::parse_str(search.trim()) {
        for column in uuid_columns {
            built.binds.push(pg_db::SqlBind::Text(uuid.to_string()));
            parts.push(format!("{column} = ${}::uuid", built.binds.len()));
        }
    }
    let clause = if parts.is_empty() {
        "FALSE".to_owned()
    } else {
        format!("({})", parts.join(" OR "))
    };
    append_clause(built, &clause);
}

/// Append `column IN (values...)` with text binds to a built list query.
pub fn append_in_text(built: &mut pg_db::BuiltListQuery, column: &str, values: &[String]) {
    if values.is_empty() {
        append_clause(built, "FALSE");
        return;
    }
    let mut placeholders = Vec::with_capacity(values.len());
    for value in values {
        built.binds.push(pg_db::SqlBind::Text(value.clone()));
        placeholders.push(format!("${}::text", built.binds.len()));
    }
    append_clause(built, &format!("{column} IN ({})", placeholders.join(", ")));
}

/// Append a bind-free clause to a built list query.
pub fn append_clause(built: &mut pg_db::BuiltListQuery, clause: &str) {
    if built.where_sql.is_empty() {
        built.where_sql = format!("WHERE {clause}");
    } else {
        built.where_sql = format!("{} AND {clause}", built.where_sql);
    }
}

fn invalid_filter(name: &str, allowed: &[&str], unknown: &[String]) -> ApiError {
    ApiError::new(
        400,
        "INVALID_FILTER",
        format!("The '{name}' filter is invalid"),
    )
    .with_details(json!({ "allowed": allowed, "unknown": unknown }))
}

/// `enumListFilter`: comma separated values, every member must be allowed.
pub fn enum_list_filter(
    params: &Params,
    key: &str,
    allowed: &[&str],
) -> Result<Option<Vec<String>>, ApiError> {
    let Some(raw) = params.string(key) else {
        return Ok(None);
    };
    let values: Vec<String> = raw
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(str::to_owned)
        .collect();
    let unknown: Vec<String> = values
        .iter()
        .filter(|entry| !allowed.contains(&entry.as_str()))
        .cloned()
        .collect();
    if values.is_empty() || !unknown.is_empty() {
        return Err(invalid_filter(key, allowed, &unknown));
    }
    Ok(Some(values))
}

/// `booleanFilter`: only `true`/`false` are accepted.
pub fn boolean_filter(params: &Params, key: &str) -> Result<Option<bool>, ApiError> {
    let Some(raw) = params.string(key) else {
        return Ok(None);
    };
    match raw.as_str() {
        "true" => Ok(Some(true)),
        "false" => Ok(Some(false)),
        _ => Err(invalid_filter(key, &[], &[])),
    }
}

/// `invalid_body`: the zod-shaped 400 the handlers raise for a bad query/param.
#[must_use]
pub fn invalid_body(path: &[&str], code: &str, message: &str) -> ApiError {
    ApiError::new(400, "INVALID_BODY", "Invalid request data").with_details(json!([{
        "path": path,
        "code": code,
        "message": message,
    }]))
}

/// `parseOrThrow(idSchema, params)`: 400 INVALID_BODY rather than a 404 for a malformed UUID.
pub fn require_uuid(raw: &str, path: &str) -> Result<Uuid, ApiError> {
    Uuid::parse_str(raw.trim()).map_err(|_| invalid_body(&[path], "invalid_format", "Invalid UUID"))
}

/// The last path segment (route params are not modelled by the P3 dispatcher yet).
#[must_use]
pub fn last_path_segment(path: &str) -> &str {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or_default()
}

/// `Date#toISOString()` for a `timestamp(3)` column.
#[must_use]
pub fn iso(date: NaiveDateTime) -> String {
    JsDate(DateTime::<Utc>::from_naive_utc_and_offset(date, Utc)).to_iso_string()
}

#[must_use]
pub fn iso_or_null(date: Option<NaiveDateTime>) -> Value {
    date.map_or(Value::Null, |value| Value::String(iso(value)))
}

/// `Date#toISOString()` for a `timestamptz(3)` column.
#[must_use]
pub fn iso_tz(date: DateTime<Utc>) -> String {
    JsDate(date).to_iso_string()
}

#[must_use]
pub fn iso_tz_or_null(date: Option<DateTime<Utc>>) -> Value {
    date.map_or(Value::Null, |value| Value::String(iso_tz(value)))
}

/// `JSON.stringify(Date)` of the current instant.
#[must_use]
pub fn now_iso(now: DateTime<Utc>) -> String {
    iso_tz(now)
}

/// A jsonb value with the JS object key order applied before it is re-serialised.
#[must_use]
pub fn js_json(value: Value) -> Value {
    js_object_order(&value)
}

/// `Decimal.toFixed(4)`.
#[must_use]
pub fn fixed_4(value: Decimal) -> String {
    pg_types::Money4(value).to_fixed_4()
}

/// `Number(x).toFixed(2)` as a JSON number (`successRatePercent`).
#[must_use]
pub fn success_rate_percent(succeeded: i64, counted: i64) -> Value {
    if counted <= 0 {
        return json!(0);
    }
    let value = (succeeded as f64 / counted as f64) * 100.0;
    let rounded = (value * 100.0).round() / 100.0;
    pg_db::js_number_value(rounded)
}

/// `Number((matched / items) * 100).toFixed(4)`.
#[must_use]
pub fn rate_fixed_4(part: i64, total: i64) -> String {
    if total <= 0 {
        return "0.0000".to_owned();
    }
    let value = Decimal::from(part) / Decimal::from(total) * Decimal::from(100);
    fixed_4(value.round_dp(4))
}

/// `merchantPeriodLabel`.
#[must_use]
pub fn period_label(raw: Option<&str>) -> &'static str {
    match raw.unwrap_or("30d").to_lowercase().as_str() {
        "24h" => "24h",
        "7d" => "7d",
        "90d" => "90d",
        _ => "30d",
    }
}

/// `merchantStatsSince`: days of history for the period label.
#[must_use]
pub fn period_days(period: &str) -> i64 {
    match period {
        "24h" => 1,
        "7d" => 7,
        "90d" => 90,
        _ => 30,
    }
}

/// `resolveReportingCurrency`: a requested ISO code or `BASE_CURRENCY` (default `LYD`).
#[must_use]
pub fn resolve_reporting_currency(raw: Option<&str>) -> String {
    let value = raw.unwrap_or_default().trim().to_ascii_uppercase();
    if value.len() == 3 && value.bytes().all(|byte| byte.is_ascii_uppercase()) {
        return value;
    }
    let base = std::env::var("BASE_CURRENCY").unwrap_or_default();
    let base = base.trim().to_ascii_uppercase();
    if base.len() == 3 && base.bytes().all(|byte| byte.is_ascii_uppercase()) {
        base
    } else {
        "LYD".to_owned()
    }
}

/// `isSuccessAttemptStatus` (see `lib/attemptOutcomes.ts`).
#[must_use]
pub fn is_success_status(status: &str) -> bool {
    matches!(
        status.to_ascii_uppercase().as_str(),
        "SUCCEEDED" | "PARTIALLY_REFUNDED" | "REFUNDED" | "DISPUTED"
    )
}

/// `isProblematicAttemptStatus`.
#[must_use]
pub fn is_problematic_status(status: &str) -> bool {
    matches!(status.to_ascii_uppercase().as_str(), "FAILED" | "UNKNOWN")
}

/// `approvalDomain` with the alias normalisation of `approvalQueue.ts`.
#[must_use]
pub fn approval_domain(subject_type: &str) -> &'static str {
    let normalized = normalize_approval_subject_type(subject_type);
    const DOMAINS: &[(&str, &[&str])] = &[
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
    for (domain, types) in DOMAINS {
        if types.contains(&normalized.as_str()) {
            return domain;
        }
    }
    "OTHER"
}

/// `normalizeApprovalSubjectType`.
#[must_use]
pub fn normalize_approval_subject_type(value: &str) -> String {
    let normalized: String = value
        .trim()
        .chars()
        .map(|character| {
            if character.is_whitespace() || character == '-' {
                '_'
            } else {
                character
            }
        })
        .collect::<String>()
        .to_ascii_uppercase();
    let compact = normalized.replace('_', "");
    match compact.as_str() {
        "JOINREQUEST" => "JOIN_REQUEST",
        "KYBDOCUMENT" => "KYB_DOCUMENT",
        "OPERATORCASE" => "OPERATOR_CASE",
        "GATEWAYVERSION" => "GATEWAY_VERSION",
        "AMLCASE" => "AML_CASE",
        "AMLRULE" => "AML_RULE",
        "REPORTINGRULE" => "REPORTING_RULE",
        "REGULATORYREPORT" => "REGULATORY_REPORT",
        "REGULATORYREPORTSCHEMA" => "REGULATORY_REPORT_SCHEMA",
        "REPORTINGRULESCHEMABINDING" => "REPORTING_RULE_SCHEMA_BINDING",
        "FILINGADAPTER" => "FILING_ADAPTER",
        "PLATFORMSETTING" => "PLATFORM_SETTING",
        "COMMISSIONPROFILE" => "COMMISSION_PROFILE",
        "VELOCITYRULE" => "VELOCITY_RULE",
        "CASHOUTREQUEST" => "CASHOUT_REQUEST",
        "CREDENTIALSET" => "CREDENTIAL_SET",
        "POSTERMINAL" => "POS_TERMINAL",
        _ => return normalized,
    }
    .to_owned()
}

/// `effectiveRouteHealth`: an unexpired override wins over the computed state.
#[must_use]
pub fn effective_health(
    computed: &str,
    health_state: &str,
    override_state: Option<&str>,
    override_expires_at: Option<NaiveDateTime>,
    now: NaiveDateTime,
) -> String {
    if let Some(override_state) = override_state {
        let active = override_expires_at.is_none_or(|expires| expires > now);
        if active {
            return override_state.to_owned();
        }
    }
    if computed.is_empty() {
        health_state.to_owned()
    } else {
        computed.to_owned()
    }
}

/// `approvalAgeHours`: whole hours, never negative.
#[must_use]
pub fn approval_age_hours(created_at: NaiveDateTime, now: NaiveDateTime) -> i64 {
    ((now - created_at).num_seconds() / 3_600).max(0)
}

/// `extractTemplateVariables`: `{{ name }}` occurrences in order, de-duplicated by the caller.
#[must_use]
pub fn extract_template_variables(template: &str) -> Vec<String> {
    let mut variables = Vec::new();
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            break;
        };
        let name = after[..end].trim();
        if !name.is_empty()
            && name.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '.' | '_')
            })
        {
            variables.push(name.to_owned());
        }
        rest = &after[end + 2..];
    }
    variables
}

/// `Number(value ?? default) || default`, then trunc/clamp (used by `limit`).
#[must_use]
pub fn js_limit(raw: Option<&str>, default: f64, minimum: f64, maximum: f64) -> i64 {
    let parsed = raw.and_then(pg_db::js_number);
    let value = match parsed {
        Some(value) if value != 0.0 && value.is_finite() => value,
        _ => default,
    };
    value.trunc().clamp(minimum, maximum) as i64
}

/// `Number(...)` for the object-storage `z.coerce.number().int()` fields.
pub fn coerce_int(
    raw: Option<&str>,
    default: i64,
    minimum: i64,
    maximum: i64,
    name: &str,
) -> Result<i64, ApiError> {
    let Some(raw) = raw else {
        return Ok(default);
    };
    let trimmed = raw.trim();
    let value = if trimmed.is_empty() {
        0.0
    } else {
        trimmed.parse::<f64>().map_err(|_| {
            invalid_body(
                &["query", name],
                "invalid_type",
                "Expected number, received string",
            )
        })?
    };
    if !value.is_finite() || value.fract() != 0.0 {
        return Err(invalid_body(
            &["query", name],
            "invalid_type",
            "Expected an integer",
        ));
    }
    let value = value as i64;
    if value < minimum || value > maximum {
        return Err(invalid_body(
            &["query", name],
            "too_small",
            "The value is outside the allowed range",
        ));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_values_trim_and_first_wins() {
        let params = Params::parse("search=%20abc%20&x=1&x=2&empty=");
        assert_eq!(params.string("search").as_deref(), Some("abc"));
        assert_eq!(params.get("x"), Some("1"));
        assert_eq!(params.string("empty"), None);
    }

    #[test]
    fn enum_filters_reject_unknown_and_empty_lists() {
        let params = Params::parse("status=OPEN,IN_PROGRESS");
        assert_eq!(
            enum_list_filter(&params, "status", &["OPEN", "IN_PROGRESS"]).expect("valid"),
            Some(vec!["OPEN".to_owned(), "IN_PROGRESS".to_owned()])
        );
        let params = Params::parse("status=OPEN,NOPE");
        let error = enum_list_filter(&params, "status", &["OPEN"]).expect_err("unknown");
        assert_eq!(error.status, 400);
        assert_eq!(error.code, "INVALID_FILTER");
        assert_eq!(
            error
                .details
                .as_ref()
                .and_then(|value| value.get("unknown")),
            Some(&json!(["NOPE"]))
        );
        let params = Params::parse("status=%20,%20");
        assert_eq!(
            enum_list_filter(&params, "status", &["OPEN"])
                .expect_err("empty")
                .code,
            "INVALID_FILTER"
        );
    }

    #[test]
    fn period_and_currency_follow_the_ts_helpers() {
        assert_eq!(period_label(Some("24H")), "24h");
        assert_eq!(period_label(Some("8d")), "30d");
        assert_eq!(period_days("90d"), 90);
        assert_eq!(resolve_reporting_currency(Some(" usd ")), "USD");
        assert_eq!(resolve_reporting_currency(Some("US")), "LYD");
        assert_eq!(resolve_reporting_currency(None), "LYD");
    }

    #[test]
    fn success_rate_is_a_two_decimal_js_number() {
        assert_eq!(success_rate_percent(0, 0), json!(0));
        assert_eq!(success_rate_percent(1, 3), json!(33.33));
        assert_eq!(success_rate_percent(2, 3), json!(66.67));
        assert_eq!(rate_fixed_4(1, 3), "33.3333");
        assert_eq!(rate_fixed_4(0, 0), "0.0000");
    }

    #[test]
    fn template_variables_match_the_ts_pattern() {
        assert_eq!(
            extract_template_variables("Hi {{name}}, code {{ code }} and {{bad-name}}"),
            vec!["name".to_owned(), "code".to_owned()]
        );
        assert!(extract_template_variables("no variables").is_empty());
    }

    #[test]
    fn approval_domains_match_the_ts_table() {
        assert_eq!(approval_domain("JoinRequest"), "ONBOARDING");
        assert_eq!(approval_domain("POS_TERMINAL"), "MERCHANT");
        assert_eq!(approval_domain("cashout-request"), "FINANCE");
        assert_eq!(approval_domain("UNKNOWN_THING"), "OTHER");
    }

    #[test]
    fn effective_health_prefers_an_unexpired_override() {
        let now = NaiveDateTime::parse_from_str("2026-11-28T12:00:00", "%Y-%m-%dT%H:%M:%S")
            .expect("date");
        let later = NaiveDateTime::parse_from_str("2026-11-28T13:00:00", "%Y-%m-%dT%H:%M:%S")
            .expect("date");
        let earlier = NaiveDateTime::parse_from_str("2026-11-28T11:00:00", "%Y-%m-%dT%H:%M:%S")
            .expect("date");
        assert_eq!(
            effective_health("HEALTHY", "HEALTHY", Some("DEGRADED"), Some(later), now),
            "DEGRADED"
        );
        assert_eq!(
            effective_health("HEALTHY", "HEALTHY", Some("DEGRADED"), Some(earlier), now),
            "HEALTHY"
        );
        assert_eq!(
            effective_health("HEALTHY", "HEALTHY", Some("DEGRADED"), None, now),
            "DEGRADED"
        );
    }

    #[test]
    fn js_limit_follows_number_or_default() {
        assert_eq!(js_limit(None, 50.0, 1.0, 100.0), 50);
        assert_eq!(js_limit(Some("0"), 50.0, 1.0, 100.0), 50);
        assert_eq!(js_limit(Some("abc"), 50.0, 1.0, 100.0), 50);
        assert_eq!(js_limit(Some("-3"), 50.0, 1.0, 100.0), 1);
        assert_eq!(js_limit(Some("500"), 50.0, 1.0, 100.0), 100);
    }

    #[test]
    fn dates_have_three_fraction_digits() {
        let date = NaiveDateTime::parse_from_str("2026-11-28T10:20:30.1", "%Y-%m-%dT%H:%M:%S%.f")
            .expect("date");
        assert_eq!(iso(date), "2026-11-28T10:20:30.100Z");
        assert_eq!(iso_or_null(None), Value::Null);
    }

    #[test]
    fn jsonb_objects_use_js_key_order() {
        let value = json!({"b": 1, "2": true, "1": false});
        let ordered = js_json(value);
        let keys: Vec<&String> = ordered.as_object().expect("object").keys().collect();
        assert_eq!(keys, vec!["1", "2", "b"]);
    }
}

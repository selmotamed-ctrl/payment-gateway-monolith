//! `GET /internal/admin/transactions` and `GET /internal/admin/attempts/:id`.
//!
//! **Not mounted here:** `routes/admin_operations/attempts.rs` owns the TypeScript routes and their
//! policies. This module keeps the same list/detail contract as a private implementation so the
//! `admin_commerce` DB tests can exercise it; the policy registry must not contain a duplicate.
//!
//! Port of `core-back/api/internal/adminOperations.ts:105` (`/transactions`) and `:538`
//! (`/attempts/:id`), including `buildAttemptDetail` (`:383`) and the support redaction set
//! (`:358-376`).
//!
//! `/attempts/:id` is the transaction detail the admin console opens from the list; TS keeps the
//! legacy `attempt` key with every scalar column and adds the separated relations beside it.

#![forbid(unsafe_code)]

use pg_db::{
    build_list_query, count_unless_skipped, ColumnKind, ColumnMap, DateFilter, ListSpec,
    RangeFilter, RangeKind, SortDirection,
};
use pg_domain_auth::Principal;
use pg_http::ApiError;
use serde_json::{json, Map, Value};
use sqlx::PgPool;
use uuid::Uuid;

use super::common::{self, MerchantRef};

const LIST_FROM: &str = "payment_attempts pa \
     JOIN merchants m ON m.id = pa.merchant_id \
     JOIN applications ap ON ap.id = pa.application_id \
     JOIN rails r ON r.id = pa.rail_id \
     JOIN rail_routes rt ON rt.id = pa.route_id \
     JOIN gateways g ON g.id = rt.gateway_id \
     LEFT JOIN gateway_settings gs ON gs.gateway_version_id = pa.gateway_version_id";

const LIST_COLUMNS: &[&str] = &[
    "pa.id AS id",
    "pa.created_at AS created_at",
    "pa.status::text AS status",
    "pa.terminal_at AS terminal_at",
    "pa.requested_amount AS requested_amount",
    "pa.currency::text AS currency",
    "pa.reference AS reference",
    "pa.gateway_reference AS gateway_reference",
    "pa.provider_reference AS provider_reference",
    "pa.network_reference AS network_reference",
    "pa.merchant_id AS merchant_id",
    "pa.application_id AS application_id",
    "pa.rail_id AS rail_id",
    "pa.ledger_entry_id AS ledger_entry_id",
    "m.id AS m_id",
    "m.legal_name AS m_legal_name",
    "m.trade_name AS m_trade_name",
    "ap.id AS ap_id",
    "ap.name AS ap_name",
    "r.id AS r_id",
    "r.code AS r_code",
    "r.name_en AS r_name_en",
    "rt.gateway_id AS gateway_id",
    "g.id AS g_id",
    "g.code AS g_code",
    "g.name AS g_name",
    "gs.supports_status_check AS supports_status_check",
    "EXISTS (SELECT 1 FROM operator_cases oc WHERE oc.attempt_id = pa.id \
      AND oc.state::text <> 'RESOLVED') AS has_open_case",
];

const ATTEMPT_STATUSES: &[&str] = &[
    "CREATED",
    "INITIATING",
    "AWAITING_CUSTOMER",
    "AUTHORIZING",
    "VERIFYING",
    "UNKNOWN",
    "SUCCEEDED",
    "FAILED",
    "EXPIRED",
    "CANCELLED",
    "BLOCKED",
    "PARTIALLY_REFUNDED",
    "REFUNDED",
    "DISPUTED",
];

const ATTEMPT_REDACTED_FIELDS: &[&str] = &[
    "amounts",
    "providerReference",
    "networkReference",
    "gatewayReference",
    "ledgerEntryId",
];

const SUPPORT_HIDDEN_ATTEMPT_COLUMNS: &[&str] = &[
    "requestedAmount",
    "surchargeAmount",
    "totalChargedAmount",
    "settledAmount",
    "gatewayFeeAmount",
    "platformCommissionAmount",
    "netMerchantAmount",
    "providerReference",
    "networkReference",
    "gatewayReference",
    "gatewayAmountWire",
    "ledgerEntryId",
];

#[cfg(test)]
const MONEY_COLUMNS: &[&str] = &[
    "requestedAmount",
    "surchargeAmount",
    "totalChargedAmount",
    "settledAmount",
    "gatewayFeeAmount",
    "platformCommissionAmount",
    "netMerchantAmount",
];

/// Every scalar column of `PaymentAttempt` except `contextCiphertext` (never leaves the API).
const ATTEMPT_COLUMNS: &[&str] = &[
    "pa.id AS id",
    "pa.created_at AS created_at",
    "pa.updated_at AS updated_at",
    "pa.reference AS reference",
    "pa.idempotency_key AS idempotency_key",
    "pa.link_id AS link_id",
    "pa.attempt_group_id AS attempt_group_id",
    "pa.application_id AS application_id",
    "pa.merchant_id AS merchant_id",
    "pa.rail_id AS rail_id",
    "pa.route_id AS route_id",
    "pa.credential_set_id AS credential_set_id",
    "pa.gateway_version_id AS gateway_version_id",
    "pa.commission_profile_id AS commission_profile_id",
    "pa.env::text AS env",
    "pa.mode AS mode",
    "pa.sub_mode AS sub_mode",
    "pa.status::text AS status",
    "pa.substatus AS substatus",
    "pa.gateway_reference AS gateway_reference",
    "pa.provider_reference AS provider_reference",
    "pa.network_reference AS network_reference",
    "pa.requested_amount AS requested_amount",
    "pa.surcharge_amount AS surcharge_amount",
    "pa.total_charged_amount AS total_charged_amount",
    "pa.gateway_amount_wire AS gateway_amount_wire",
    "pa.settled_amount AS settled_amount",
    "pa.gateway_fee_amount AS gateway_fee_amount",
    "pa.platform_commission_amount AS platform_commission_amount",
    "pa.net_merchant_amount AS net_merchant_amount",
    "pa.fee_bearer::text AS fee_bearer",
    "pa.settlement_target::text AS settlement_target",
    "pa.wallet_id AS wallet_id",
    "pa.wallet_gl_account_id AS wallet_gl_account_id",
    "pa.currency::text AS currency",
    "pa.customer_fields_masked AS customer_fields_masked",
    "pa.public_outputs AS public_outputs",
    "pa.point_of_no_return AS point_of_no_return",
    "pa.otp_attempts AS otp_attempts",
    "pa.last_otp_sent_at AS last_otp_sent_at",
    "pa.client_ip AS client_ip",
    "pa.user_agent AS user_agent",
    "pa.expires_at AS expires_at",
    "pa.grace_expires_at AS grace_expires_at",
    "pa.next_check_at AS next_check_at",
    "pa.ledger_entry_id AS ledger_entry_id",
    "pa.terminal_at AS terminal_at",
    "pa.first_terminal_at AS first_terminal_at",
    "pa.first_unknown_at AS first_unknown_at",
    "pa.canonical_error AS canonical_error",
];

const DETAIL_FROM: &str = "payment_attempts pa \
     JOIN merchants m ON m.id = pa.merchant_id \
     JOIN applications ap ON ap.id = pa.application_id \
     LEFT JOIN rails r ON r.id = pa.rail_id \
     LEFT JOIN rail_routes rt ON rt.id = pa.route_id \
     LEFT JOIN gateways g ON g.id = rt.gateway_id \
     LEFT JOIN gateway_settings gs ON gs.gateway_version_id = pa.gateway_version_id \
     LEFT JOIN payment_links l ON l.id = pa.link_id";

const DETAIL_RELATION_COLUMNS: &[&str] = &[
    "m.id AS m_id",
    "m.legal_name AS m_legal_name",
    "m.trade_name AS m_trade_name",
    "ap.id AS ap_id",
    "ap.name AS ap_name",
    "ap.status::text AS ap_status",
    "r.id AS r_id",
    "r.code AS r_code",
    "r.name_en AS r_name_en",
    "r.name_ar AS r_name_ar",
    "rt.gateway_id AS gateway_id",
    "g.id AS g_id",
    "g.code AS g_code",
    "g.name AS g_name",
    "gs.supports_status_check AS supports_status_check",
    "l.id AS link_id_ref",
    "l.key AS link_key",
];

fn list_columns() -> ColumnMap {
    ColumnMap::new()
        .with("createdAt", "pa.created_at", ColumnKind::Timestamp)
        .with("updatedAt", "pa.updated_at", ColumnKind::Timestamp)
        .with("statusFilter", "pa.status::text", ColumnKind::Text)
        .with("status", "pa.status", ColumnKind::Text)
        .with(
            "requestedAmount",
            "pa.requested_amount",
            ColumnKind::Decimal,
        )
        .with("id", "pa.id", ColumnKind::Uuid)
}

fn list_spec() -> ListSpec {
    ListSpec::default()
        .with_date(DateFilter::new("createdAt", "createdAt"))
        .with_range(RangeFilter::new(
            "amount",
            "requestedAmount",
            RangeKind::Decimal,
        ))
        .with_sortable("createdAt", "createdAt")
        .with_sortable("status", "status")
        .with_sortable("requestedAmount", "requestedAmount")
        .with_default_sort("createdAt", SortDirection::Desc)
        .with_default_page_size(25.0)
}

/// `operatorCaseInquiryEligibility` (`lib/operatorCases.ts:36`) for a list row (no case scope).
fn inquiry_eligibility(
    attempt_status: &str,
    terminal: bool,
    supports_status_check: bool,
) -> (bool, &'static str) {
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

fn is_canonical_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    value.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                *byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

fn decimal_filter_error(query: &Map<String, Value>, key: &str) -> Result<(), ApiError> {
    if let Some(raw) = common::query_text(query, key) {
        if !matches_decimal_query(&raw) {
            return Err(ApiError::new(
                400,
                "INVALID_FILTER",
                format!("The '{key}' filter is invalid"),
            ));
        }
    }
    Ok(())
}

/// `^-?\d{1,18}(\.\d{1,8})?$`.
fn matches_decimal_query(value: &str) -> bool {
    let body = value.strip_prefix('-').unwrap_or(value);
    let mut parts = body.split('.');
    let Some(integer) = parts.next() else {
        return false;
    };
    if integer.is_empty()
        || integer.len() > 18
        || !integer.bytes().all(|byte| byte.is_ascii_digit())
    {
        return false;
    }
    match parts.next() {
        None => true,
        Some(fraction) => {
            parts.next().is_none()
                && !fraction.is_empty()
                && fraction.len() <= 8
                && fraction.bytes().all(|byte| byte.is_ascii_digit())
        }
    }
}

/// `GET /internal/admin/transactions`.
pub async fn list(
    pool: &PgPool,
    principal: Option<&Principal>,
    query_string: &str,
) -> Result<Value, ApiError> {
    let query = common::parse_query(query_string);
    let flags = common::flags(principal);
    let support = flags.support;

    let statuses = enum_list(&query, "status", ATTEMPT_STATUSES)?;
    let rail_ids = uuid_list(&query, "railId")?;
    let gateway_ids = uuid_list(&query, "gatewayId")?;
    let merchant_ids = uuid_list(&query, "merchantId")?;
    let application_ids = uuid_list(&query, "applicationId")?;
    let currency = common::query_text(&query, "currency");
    if let Some(currency) = currency.as_deref() {
        if currency.len() != 3 || !currency.bytes().all(|byte| byte.is_ascii_alphabetic()) {
            return Err(ApiError::new(
                400,
                "INVALID_FILTER",
                "The 'currency' filter is invalid",
            ));
        }
    }
    decimal_filter_error(&query, "amountMin")?;
    decimal_filter_error(&query, "amountMax")?;

    let mut built =
        build_list_query(&query, &list_spec(), &list_columns()).map_err(common::list_error)?;
    if let Some(statuses) = statuses {
        common::add_in(&mut built, "pa.status::text", "text", &statuses);
    }
    if let Some(ids) = rail_ids {
        common::add_in(&mut built, "pa.rail_id", "uuid", &ids);
    }
    if let Some(ids) = gateway_ids {
        common::add_in(&mut built, "rt.gateway_id", "uuid", &ids);
    }
    if let Some(ids) = merchant_ids {
        common::add_in(&mut built, "pa.merchant_id", "uuid", &ids);
    }
    if let Some(ids) = application_ids {
        common::add_in(&mut built, "pa.application_id", "uuid", &ids);
    }
    if let Some(currency) = currency {
        common::add_equals(
            &mut built,
            "pa.currency::text",
            "text",
            &currency.to_ascii_uppercase(),
        );
    }
    if let Some(search) = common::query_text(&query, "search") {
        add_transaction_search(&mut built, &search, support);
    }

    let sql = built.select_sql(LIST_FROM, LIST_COLUMNS);
    let rows = built
        .bind_rows(&sql)
        .fetch_all(pool)
        .await
        .map_err(common::database_error)?;
    let total = count_unless_skipped(&built, LIST_FROM, pool)
        .await
        .map_err(common::list_error)?;

    let mut output = Vec::with_capacity(rows.len());
    let mut cursor_rows: Vec<Vec<pg_db::CursorValue>> = Vec::new();
    for row in &rows {
        let id = common::uuid_text(row, "id")?;
        let status = common::text(row, "status")?;
        let terminal_at = common::opt_naive(row, "terminal_at")?;
        let supports = common::opt_bool(row, "supports_status_check")?.unwrap_or(false);
        let (eligible, reason) = inquiry_eligibility(&status, terminal_at.is_some(), supports);
        let value = json!({
            "id": id,
            "createdAt": common::iso_naive(common::naive(row, "created_at")?),
            "status": status,
            "requestedAmount": if support {
                Value::Null
            } else {
                common::money4_zero(Some(common::decimal(row, "requested_amount")?))
            },
            "currency": common::text(row, "currency")?,
            "merchantId": common::uuid_text(row, "merchant_id")?,
            "merchant": MerchantRef::from_row(row, "m_id", "m_legal_name", "m_trade_name")?.to_json(),
            "applicationId": common::uuid_text(row, "application_id")?,
            "application": { "id": common::uuid_text(row, "ap_id")?, "name": common::text(row, "ap_name")? },
            "railId": common::uuid_text(row, "rail_id")?,
            "rail": {
                "id": common::uuid_text(row, "r_id")?,
                "code": common::text(row, "r_code")?,
                "nameEn": common::text(row, "r_name_en")?,
            },
            "gatewayId": common::uuid_text(row, "gateway_id")?,
            "gateway": {
                "id": common::uuid_text(row, "g_id")?,
                "code": common::text(row, "g_code")?,
                "name": common::text(row, "g_name")?,
            },
            "reference": common::text(row, "reference")?,
            "gatewayReference": if support { Value::Null } else { common::opt_text(row, "gateway_reference")?.map_or(Value::Null, Value::String) },
            "providerReference": if support { Value::Null } else { common::opt_text(row, "provider_reference")?.map_or(Value::Null, Value::String) },
            "networkReference": if support { Value::Null } else { common::opt_text(row, "network_reference")?.map_or(Value::Null, Value::String) },
            "ledgerEntryId": if support { Value::Null } else { common::opt_uuid_text(row, "ledger_entry_id")?.map_or(Value::Null, Value::String) },
            "hasOpenCase": common::bool_of(row, "has_open_case")?,
            "inquiryEligible": eligible,
            "redactedFields": if support { json!(ATTEMPT_REDACTED_FIELDS) } else { Value::Array(Vec::new()) },
            "_inquiryReason": reason,
        });
        let mut value = match value {
            Value::Object(map) => map,
            _ => Map::new(),
        };
        // The reason is only used to build `inquiryEligible`; TS does not expose it on list rows.
        value.remove("_inquiryReason");
        let created_at = common::naive(row, "created_at")?;
        if let Some(plan) = &built.keyset {
            let values = common::cursor_values(plan, created_at, None, &id);
            if values.len() == plan.fields.len() {
                cursor_rows.push(values);
            }
        }
        output.push(Value::Object(value));
    }

    let mut response = match pg_db::list_response(
        "transactions",
        Value::Array(output),
        total,
        &built,
        &cursor_rows,
    ) {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    response.insert(
        "redactedFields".to_owned(),
        if support {
            json!(ATTEMPT_REDACTED_FIELDS)
        } else {
            Value::Array(Vec::new())
        },
    );
    Ok(Value::Object(response))
}

/// TS search clause: `OR (ILIKE texts…, id = uuid)`.
fn add_transaction_search(built: &mut pg_db::BuiltListQuery, search: &str, support: bool) {
    let mut columns: Vec<&str> = vec!["pa.reference"];
    if !support {
        columns.push("pa.gateway_reference");
        columns.push("pa.provider_reference");
        columns.push("pa.network_reference");
    }
    built
        .binds
        .push(pg_db::SqlBind::Text(format!("%{search}%")));
    let placeholder = built.binds.len();
    let mut clauses: Vec<String> = columns
        .iter()
        .map(|column| format!("{column} ILIKE ${placeholder}::text"))
        .collect();
    if is_canonical_uuid(search) {
        built.binds.push(pg_db::SqlBind::Text(search.to_owned()));
        let id_placeholder = built.binds.len();
        clauses.push(format!("pa.id = ${id_placeholder}::uuid"));
    }
    common::add_condition(built, &format!("({})", clauses.join(" OR ")));
}

/// `enumListFilter`: comma-separated, unknown members are a 400.
fn enum_list(
    query: &Map<String, Value>,
    key: &str,
    allowed: &[&str],
) -> Result<Option<Vec<String>>, ApiError> {
    let Some(raw) = common::query_text(query, key) else {
        return Ok(None);
    };
    let values: Vec<String> = raw
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(str::to_owned)
        .collect();
    let unknown: Vec<&str> = values
        .iter()
        .map(String::as_str)
        .filter(|entry| !allowed.contains(entry))
        .collect();
    if values.is_empty() || !unknown.is_empty() {
        return Err(ApiError::new(
            400,
            "INVALID_FILTER",
            format!("The '{key}' filter is invalid"),
        )
        .with_details(json!({ "allowed": allowed, "unknown": unknown })));
    }
    Ok(Some(values))
}

/// `uuidListFilter`: comma-separated UUIDs.
fn uuid_list(query: &Map<String, Value>, key: &str) -> Result<Option<Vec<String>>, ApiError> {
    let Some(raw) = common::query_text(query, key) else {
        return Ok(None);
    };
    let values: Vec<String> = raw
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(str::to_owned)
        .collect();
    if values.is_empty() || values.iter().any(|entry| Uuid::parse_str(entry).is_err()) {
        return Err(ApiError::new(
            400,
            "INVALID_FILTER",
            format!("The '{key}' filter is invalid"),
        ));
    }
    Ok(Some(values))
}

/// `GET /internal/admin/attempts/:id`.
pub async fn attempt_detail(
    pool: &PgPool,
    principal: Option<&Principal>,
    id: &str,
) -> Result<Value, ApiError> {
    let attempt_id = Uuid::parse_str(id).map_err(|_| attempt_not_found())?;
    let flags = common::flags(principal);
    let support = flags.support;

    let sql = format!(
        "SELECT {}, {} FROM {DETAIL_FROM} WHERE pa.id = $1",
        ATTEMPT_COLUMNS.join(", "),
        DETAIL_RELATION_COLUMNS.join(", ")
    );
    let row = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()))
        .bind(attempt_id)
        .fetch_optional(pool)
        .await
        .map_err(common::database_error)?
        .ok_or_else(attempt_not_found)?;

    let attempt_group_id = common::uuid_text(&row, "attempt_group_id")?;
    let supports = common::opt_bool(&row, "supports_status_check")?.unwrap_or(false);
    let status = common::text(&row, "status")?;
    let terminal_at = common::opt_naive(&row, "terminal_at")?;
    let (eligible, reason) = inquiry_eligibility(&status, terminal_at.is_some(), supports);

    let mut attempt = Map::new();
    attempt.insert(
        "id".to_owned(),
        Value::String(common::uuid_text(&row, "id")?),
    );
    attempt.insert(
        "createdAt".to_owned(),
        Value::String(common::iso_naive(common::naive(&row, "created_at")?)),
    );
    attempt.insert(
        "updatedAt".to_owned(),
        Value::String(common::iso_naive(common::naive(&row, "updated_at")?)),
    );
    attempt.insert(
        "reference".to_owned(),
        Value::String(common::text(&row, "reference")?),
    );
    attempt.insert(
        "idempotencyKey".to_owned(),
        common::opt_text(&row, "idempotency_key")?.map_or(Value::Null, Value::String),
    );
    for (field, column) in [
        ("linkId", "link_id"),
        ("attemptGroupId", "attempt_group_id"),
        ("applicationId", "application_id"),
        ("merchantId", "merchant_id"),
        ("railId", "rail_id"),
        ("routeId", "route_id"),
        ("credentialSetId", "credential_set_id"),
        ("gatewayVersionId", "gateway_version_id"),
        ("commissionProfileId", "commission_profile_id"),
    ] {
        attempt.insert(
            field.to_owned(),
            Value::String(common::uuid_text(&row, column)?),
        );
    }
    attempt.insert("env".to_owned(), Value::String(common::text(&row, "env")?));
    attempt.insert(
        "mode".to_owned(),
        Value::String(common::text(&row, "mode")?),
    );
    attempt.insert(
        "subMode".to_owned(),
        common::opt_text(&row, "sub_mode")?.map_or(Value::Null, Value::String),
    );
    attempt.insert("status".to_owned(), Value::String(status.clone()));
    attempt.insert(
        "substatus".to_owned(),
        common::opt_text(&row, "substatus")?.map_or(Value::Null, Value::String),
    );
    for (field, column) in [
        ("gatewayReference", "gateway_reference"),
        ("providerReference", "provider_reference"),
        ("networkReference", "network_reference"),
    ] {
        attempt.insert(
            field.to_owned(),
            common::opt_text(&row, column)?.map_or(Value::Null, Value::String),
        );
    }

    let money = |column: &str, nullable: bool| -> Result<Value, ApiError> {
        if nullable {
            Ok(common::money4_opt(common::opt_decimal(&row, column)?))
        } else {
            Ok(common::money4_zero(Some(common::decimal(&row, column)?)))
        }
    };
    attempt.insert(
        "requestedAmount".to_owned(),
        money("requested_amount", false)?,
    );
    attempt.insert(
        "surchargeAmount".to_owned(),
        money("surcharge_amount", false)?,
    );
    attempt.insert(
        "totalChargedAmount".to_owned(),
        money("total_charged_amount", false)?,
    );
    attempt.insert(
        "gatewayAmountWire".to_owned(),
        common::opt_text(&row, "gateway_amount_wire")?.map_or(Value::Null, Value::String),
    );
    attempt.insert("settledAmount".to_owned(), money("settled_amount", true)?);
    attempt.insert(
        "gatewayFeeAmount".to_owned(),
        money("gateway_fee_amount", true)?,
    );
    attempt.insert(
        "platformCommissionAmount".to_owned(),
        money("platform_commission_amount", false)?,
    );
    attempt.insert(
        "netMerchantAmount".to_owned(),
        money("net_merchant_amount", false)?,
    );
    attempt.insert(
        "feeBearer".to_owned(),
        Value::String(common::text(&row, "fee_bearer")?),
    );
    attempt.insert(
        "settlementTarget".to_owned(),
        Value::String(common::text(&row, "settlement_target")?),
    );
    attempt.insert(
        "walletId".to_owned(),
        common::opt_uuid_text(&row, "wallet_id")?.map_or(Value::Null, Value::String),
    );
    attempt.insert(
        "walletGlAccountId".to_owned(),
        common::opt_uuid_text(&row, "wallet_gl_account_id")?.map_or(Value::Null, Value::String),
    );
    attempt.insert(
        "currency".to_owned(),
        Value::String(common::text(&row, "currency")?),
    );
    attempt.insert(
        "customerFieldsMasked".to_owned(),
        common::json_value(&row, "customer_fields_masked")?,
    );
    attempt.insert(
        "publicOutputs".to_owned(),
        common::opt_json(&row, "public_outputs")?.unwrap_or(Value::Null),
    );
    attempt.insert(
        "pointOfNoReturn".to_owned(),
        Value::Bool(common::bool_of(&row, "point_of_no_return")?),
    );
    attempt.insert(
        "otpAttempts".to_owned(),
        Value::from(common::i32_of(&row, "otp_attempts")?),
    );
    attempt.insert(
        "lastOtpSentAt".to_owned(),
        common::iso_value(common::opt_naive(&row, "last_otp_sent_at")?),
    );
    attempt.insert(
        "clientIp".to_owned(),
        common::opt_text(&row, "client_ip")?.map_or(Value::Null, Value::String),
    );
    attempt.insert(
        "userAgent".to_owned(),
        common::opt_text(&row, "user_agent")?.map_or(Value::Null, Value::String),
    );
    attempt.insert(
        "expiresAt".to_owned(),
        common::iso_value(Some(common::naive(&row, "expires_at")?)),
    );
    attempt.insert(
        "graceExpiresAt".to_owned(),
        common::iso_value(Some(common::naive(&row, "grace_expires_at")?)),
    );
    attempt.insert(
        "nextCheckAt".to_owned(),
        common::iso_value(common::opt_naive(&row, "next_check_at")?),
    );
    attempt.insert(
        "ledgerEntryId".to_owned(),
        common::opt_uuid_text(&row, "ledger_entry_id")?.map_or(Value::Null, Value::String),
    );
    attempt.insert("terminalAt".to_owned(), common::iso_value(terminal_at));
    attempt.insert(
        "firstTerminalAt".to_owned(),
        common::iso_value(common::opt_naive(&row, "first_terminal_at")?),
    );
    attempt.insert(
        "firstUnknownAt".to_owned(),
        common::iso_value(common::opt_naive(&row, "first_unknown_at")?),
    );
    attempt.insert(
        "canonicalError".to_owned(),
        common::opt_text(&row, "canonical_error")?.map_or(Value::Null, Value::String),
    );
    attempt.insert(
        "link".to_owned(),
        json!({
            "id": common::opt_uuid_text(&row, "link_id_ref")?,
            "key": common::opt_text(&row, "link_key")?,
        }),
    );

    if support {
        for column in SUPPORT_HIDDEN_ATTEMPT_COLUMNS {
            if let Some(value) = attempt.get_mut(*column) {
                *value = Value::Null;
            }
        }
    }

    let merchant = MerchantRef::from_row(&row, "m_id", "m_legal_name", "m_trade_name")?;
    let application = json!({
        "id": common::uuid_text(&row, "ap_id")?,
        "name": common::text(&row, "ap_name")?,
        "status": common::text(&row, "ap_status")?,
    });
    let rail = json!({
        "id": common::uuid_text(&row, "r_id")?,
        "code": common::text(&row, "r_code")?,
        "nameEn": common::text(&row, "r_name_en")?,
        "nameAr": common::text(&row, "r_name_ar")?,
    });
    let gateway = json!({
        "id": common::uuid_text(&row, "g_id")?,
        "code": common::text(&row, "g_code")?,
        "name": common::text(&row, "g_name")?,
    });

    let step_logs = load_step_logs(pool, attempt_id).await?;
    let inbound_events = load_inbound_events(pool, attempt_id).await?;
    let group = load_attempt_group(pool, &attempt_group_id, support).await?;
    let operator_cases = load_operator_cases(pool, attempt_id).await?;
    let disputes = load_disputes(pool, attempt_id, support).await?;
    let adjustments = load_adjustments(pool, attempt_id, support).await?;

    let mut response = Map::new();
    response.insert("attempt".to_owned(), Value::Object(attempt));
    response.insert("merchant".to_owned(), merchant.to_json());
    response.insert("application".to_owned(), application);
    response.insert("rail".to_owned(), rail);
    response.insert("gateway".to_owned(), gateway);
    response.insert(
        "gatewaySupportsStatusCheck".to_owned(),
        Value::Bool(supports),
    );
    response.insert(
        "inquiryEligibility".to_owned(),
        json!({ "eligible": eligible, "reason": reason }),
    );
    response.insert("stepLogs".to_owned(), Value::Array(step_logs));
    response.insert("inboundEvents".to_owned(), Value::Array(inbound_events));
    response.insert("attemptGroup".to_owned(), group);
    response.insert("operatorCases".to_owned(), Value::Array(operator_cases));
    response.insert("disputes".to_owned(), Value::Array(disputes));
    response.insert("adjustments".to_owned(), Value::Array(adjustments));
    response.insert(
        "redactedFields".to_owned(),
        if support {
            json!(ATTEMPT_REDACTED_FIELDS)
        } else {
            Value::Array(Vec::new())
        },
    );
    Ok(Value::Object(response))
}

fn attempt_not_found() -> ApiError {
    ApiError::new(
        404,
        "PAYMENT_ATTEMPT_NOT_FOUND",
        "The payment attempt does not exist",
    )
}

async fn load_step_logs(pool: &PgPool, attempt_id: Uuid) -> Result<Vec<Value>, ApiError> {
    const STEP_RESPONSE_LIMIT: usize = 16 * 1024;
    let rows = sqlx::query(
        "SELECT id, created_at, phase, step_id, step_order, redacted_request_json, \
         redacted_response_text, http_status, duration_ms, outcome \
         FROM attempt_step_logs WHERE attempt_id = $1 \
         ORDER BY step_order ASC, created_at ASC LIMIT 500",
    )
    .bind(attempt_id)
    .fetch_all(pool)
    .await
    .map_err(common::database_error)?;
    rows.iter()
        .map(|row| {
            let response_text = common::text(row, "redacted_response_text")?;
            let truncated: String = response_text.chars().take(STEP_RESPONSE_LIMIT).collect();
            Ok(json!({
                "id": common::uuid_text(row, "id")?,
                "createdAt": common::iso_naive(common::naive(row, "created_at")?),
                "phase": common::text(row, "phase")?,
                "stepId": common::opt_uuid_text(row, "step_id")?,
                "stepOrder": common::i32_of(row, "step_order")?,
                "redactedRequestJson": pg_crypto::redact_payload(
                    &common::json_value(row, "redacted_request_json")?,
                    &[],
                ),
                "redactedResponseText": pg_crypto::redact_text(&truncated, &[]),
                "httpStatus": common::opt_i32(row, "http_status")?,
                "durationMs": common::opt_i32(row, "duration_ms")?,
                "outcome": common::text(row, "outcome")?,
            }))
        })
        .collect()
}

async fn load_inbound_events(pool: &PgPool, attempt_id: Uuid) -> Result<Vec<Value>, ApiError> {
    let rows = sqlx::query(
        "SELECT e.id, e.received_at, e.gateway_id, e.channel_id, e.env, e.source_ip, \
         e.verified, e.verification_error, e.attempt_id, e.processed_at, e.processing_result, \
         e.dedupe_key, g.id AS g_id, g.code AS g_code, g.name AS g_name \
         FROM inbound_events e JOIN gateways g ON g.id = e.gateway_id \
         WHERE e.attempt_id = $1 ORDER BY e.received_at DESC LIMIT 50",
    )
    .bind(attempt_id)
    .fetch_all(pool)
    .await
    .map_err(common::database_error)?;
    rows.iter()
        .map(|row| {
            Ok(json!({
                "id": common::uuid_text(row, "id")?,
                "receivedAt": common::iso_naive(common::naive(row, "received_at")?),
                "gatewayId": common::uuid_text(row, "gateway_id")?,
                "gateway": {
                    "id": common::uuid_text(row, "g_id")?,
                    "code": common::text(row, "g_code")?,
                    "name": common::text(row, "g_name")?,
                },
                "channelId": common::uuid_text(row, "channel_id")?,
                "env": common::text(row, "env")?,
                "sourceIp": common::text(row, "source_ip")?,
                "verified": common::bool_of(row, "verified")?,
                "verificationError": common::opt_text(row, "verification_error")?,
                "attemptId": common::opt_uuid_text(row, "attempt_id")?,
                "processedAt": common::iso_value(common::opt_naive(row, "processed_at")?),
                "processingResult": common::opt_text(row, "processing_result")?,
                "dedupeKey": common::text(row, "dedupe_key")?,
            }))
        })
        .collect()
}

async fn load_attempt_group(
    pool: &PgPool,
    group_id: &str,
    support: bool,
) -> Result<Value, ApiError> {
    let group = sqlx::query("SELECT id, success_count FROM attempt_groups WHERE id = $1")
        .bind(Uuid::parse_str(group_id).map_err(|_| attempt_not_found())?)
        .fetch_optional(pool)
        .await
        .map_err(common::database_error)?;
    let Some(group) = group else {
        return Ok(Value::Null);
    };
    let rows = sqlx::query(
        "SELECT pa.id, pa.status::text AS status, pa.rail_id, rt.gateway_id, \
         pa.requested_amount, pa.created_at \
         FROM payment_attempts pa JOIN rail_routes rt ON rt.id = pa.route_id \
         WHERE pa.attempt_group_id = $1 ORDER BY pa.created_at DESC LIMIT 25",
    )
    .bind(Uuid::parse_str(group_id).map_err(|_| attempt_not_found())?)
    .fetch_all(pool)
    .await
    .map_err(common::database_error)?;
    let mut attempts = Vec::with_capacity(rows.len());
    for row in &rows {
        attempts.push(json!({
            "id": common::uuid_text(row, "id")?,
            "status": common::text(row, "status")?,
            "railId": common::uuid_text(row, "rail_id")?,
            "gatewayId": common::uuid_text(row, "gateway_id")?,
            "requestedAmount": if support {
                Value::Null
            } else {
                common::money4_zero(Some(common::decimal(row, "requested_amount")?))
            },
            "createdAt": common::iso_naive(common::naive(row, "created_at")?),
        }));
    }
    Ok(json!({
        "id": common::uuid_text(&group, "id")?,
        "successCount": common::i32_of(&group, "success_count")?,
        "attempts": attempts,
    }))
}

async fn load_operator_cases(pool: &PgPool, attempt_id: Uuid) -> Result<Vec<Value>, ApiError> {
    let rows = sqlx::query(
        "SELECT id, kind::text AS kind, state::text AS state, priority::text AS priority, sla_due_at \
         FROM operator_cases WHERE attempt_id = $1 ORDER BY created_at DESC LIMIT 25",
    )
    .bind(attempt_id)
    .fetch_all(pool)
    .await
    .map_err(common::database_error)?;
    rows.iter()
        .map(|row| {
            Ok(json!({
                "id": common::uuid_text(row, "id")?,
                "kind": common::text(row, "kind")?,
                "state": common::text(row, "state")?,
                "priority": common::text(row, "priority")?,
                "slaDueAt": common::iso_value(Some(common::naive(row, "sla_due_at")?)),
            }))
        })
        .collect()
}

async fn load_disputes(
    pool: &PgPool,
    attempt_id: Uuid,
    support: bool,
) -> Result<Vec<Value>, ApiError> {
    let rows = sqlx::query(
        "SELECT id, status::text AS status, amount, reason_code, created_at \
         FROM disputes WHERE attempt_id = $1 ORDER BY created_at DESC LIMIT 25",
    )
    .bind(attempt_id)
    .fetch_all(pool)
    .await
    .map_err(common::database_error)?;
    rows.iter()
        .map(|row| {
            Ok(json!({
                "id": common::uuid_text(row, "id")?,
                "status": common::text(row, "status")?,
                "disputedAmount": if support {
                    Value::Null
                } else {
                    common::money4_zero(Some(common::decimal(row, "amount")?))
                },
                "reasonCode": common::opt_text(row, "reason_code")?,
                "createdAt": common::iso_naive(common::naive(row, "created_at")?),
            }))
        })
        .collect()
}

async fn load_adjustments(
    pool: &PgPool,
    attempt_id: Uuid,
    support: bool,
) -> Result<Vec<Value>, ApiError> {
    let rows = sqlx::query(
        "SELECT id, type::text AS type, state::text AS state, amount, created_at, journal_entry_id \
         FROM adjustments WHERE source_attempt_id = $1 ORDER BY created_at DESC LIMIT 25",
    )
    .bind(attempt_id)
    .fetch_all(pool)
    .await
    .map_err(common::database_error)?;
    rows.iter()
        .map(|row| {
            Ok(json!({
                "id": common::uuid_text(row, "id")?,
                "type": common::text(row, "type")?,
                "state": common::text(row, "state")?,
                "amount": if support {
                    Value::Null
                } else {
                    common::money4_zero(Some(common::decimal(row, "amount")?))
                },
                "createdAt": common::iso_naive(common::naive(row, "created_at")?),
                "journalEntryId": if support {
                    Value::Null
                } else {
                    common::opt_uuid_text(row, "journal_entry_id")?.map_or(Value::Null, Value::String)
                },
            }))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inquiry_eligibility_matches_the_ts_order() {
        assert_eq!(
            inquiry_eligibility("UNKNOWN", true, true),
            (false, "ATTEMPT_TERMINAL")
        );
        assert_eq!(
            inquiry_eligibility("SUCCEEDED", false, true),
            (false, "ATTEMPT_NOT_INQUIRABLE")
        );
        assert_eq!(
            inquiry_eligibility("VERIFYING", false, false),
            (false, "GATEWAY_HAS_NO_STATUS_INQUIRY")
        );
        assert_eq!(
            inquiry_eligibility("unknown", false, true),
            (true, "ELIGIBLE")
        );
    }

    #[test]
    fn decimal_filters_accept_the_ts_grammar() {
        assert!(matches_decimal_query("0"));
        assert!(matches_decimal_query("-123.45678901"));
        assert!(!matches_decimal_query("1e5"));
        assert!(!matches_decimal_query(".5"));
        assert!(!matches_decimal_query("1234567890123456789"));
        assert!(!matches_decimal_query("1.123456789"));
    }

    #[test]
    fn uuid_detection_is_canonical_only() {
        assert!(is_canonical_uuid("0190f5c0-0000-7000-8000-000000000001"));
        assert!(!is_canonical_uuid("0190f5c0000070008000000000000001"));
        assert!(!is_canonical_uuid("nope"));
    }

    #[test]
    fn enum_and_uuid_lists_reject_empty_and_unknown() {
        let map = common::parse_query("status=UNKNOWN&railId=not-a-uuid");
        assert!(enum_list(&map, "status", ATTEMPT_STATUSES).is_ok());
        assert!(uuid_list(&map, "railId").is_err());
        let map = common::parse_query("status=BOGUS");
        assert!(enum_list(&map, "status", ATTEMPT_STATUSES).is_err());
        let map = common::parse_query("status=,");
        assert!(enum_list(&map, "status", ATTEMPT_STATUSES).is_err());
    }

    #[test]
    fn support_redaction_lists_match_ts() {
        assert!(SUPPORT_HIDDEN_ATTEMPT_COLUMNS.contains(&"gatewayAmountWire"));
        assert_eq!(MONEY_COLUMNS.len(), 7);
        for column in MONEY_COLUMNS {
            assert!(SUPPORT_HIDDEN_ATTEMPT_COLUMNS.contains(column));
        }
    }
}

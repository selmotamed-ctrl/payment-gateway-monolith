//! The merchant-360 sub-lists: transactions, applications, wallets, cash-outs, disputes,
//! adjustments, notifications and audit events.
//!
//! Ports `core-back/api/internal/admin.ts:5792` (`/merchants/:id/transactions`), `:5905`
//! (`applications`), `:5969` (`wallets`), `:6038` (`cashouts`), `:6092` (`disputes`), `:6150`
//! (`adjustments`), `:6209` (`notifications`) and `:6246` (`audit-events`).
//!
//! Contract notes that are easy to get wrong:
//!
//! - every route checks the merchant first (`404 MERCHANT_NOT_FOUND`); cash-outs, disputes and
//!   adjustments then refuse a caller without financial access
//!   (`403 MERCHANT_FINANCIAL_ACCESS_REQUIRED`);
//! - the support role sees amounts and provider references redacted, and a caller without financial
//!   access loses the fee/net fields (each row lists `redactedFields`);
//! - these handlers always run their `count()`, so `includeTotal=false` does **not** make `total`
//!   null (unlike `countUnlessSkipped` elsewhere);
//! - `disputes` reaches the merchant through the attempt, `adjustments` through either the source
//!   attempt or the target GL account owner, and the dispute adjustment is resolved through
//!   `adjustments.dispute_id` (the reverse of `disputes.adjustment_id`, which is a plain text
//!   pointer);
//! - money is `Money4`; a NULL optional amount renders `"0.0000"` (`merchantMoney` never throws in
//!   this port).

#![forbid(unsafe_code)]

use pg_db::{ColumnKind, ColumnMap, DateFilter, ListSpec, RangeFilter, RangeKind, SortDirection};
use pg_domain_auth::Principal;
use pg_http::ApiError;
use serde_json::{json, Value};
use sqlx::postgres::PgRow;
use sqlx::PgPool;

use crate::routes::admin_commerce::{common, wallets};

use super::support;

// ------------------------------------------------------------------ transactions

const TRANSACTIONS_FROM: &str = "payment_attempts pa \
     LEFT JOIN applications ap ON ap.id = pa.application_id \
     LEFT JOIN rails r ON r.id = pa.rail_id \
     LEFT JOIN rail_routes rt ON rt.id = pa.route_id \
     LEFT JOIN gateways g ON g.id = rt.gateway_id \
     LEFT JOIN gateway_settings gs ON gs.gateway_version_id = pa.gateway_version_id \
     LEFT JOIN payment_links pl ON pl.id = pa.link_id";

const TRANSACTIONS_COLUMNS: &[&str] = &[
    "pa.id AS id",
    "pa.reference AS reference",
    "pa.created_at AS created_at",
    "pa.updated_at AS updated_at",
    "pa.terminal_at AS terminal_at",
    "pa.status::text AS status",
    "pa.substatus AS substatus",
    "pa.env::text AS env",
    "pa.mode AS mode",
    "pa.sub_mode AS sub_mode",
    "pa.currency::text AS currency",
    "pa.requested_amount AS requested_amount",
    "pa.surcharge_amount AS surcharge_amount",
    "pa.total_charged_amount AS total_charged_amount",
    "pa.settled_amount AS settled_amount",
    "pa.gateway_fee_amount AS gateway_fee_amount",
    "pa.platform_commission_amount AS platform_commission_amount",
    "pa.net_merchant_amount AS net_merchant_amount",
    "pa.provider_reference AS provider_reference",
    "pa.network_reference AS network_reference",
    "pa.gateway_reference AS gateway_reference",
    "pa.ledger_entry_id AS ledger_entry_id",
    "ap.id AS app_id",
    "ap.name AS app_name",
    "r.id AS rail_id",
    "r.code AS rail_code",
    "r.name_en AS rail_name_en",
    "g.id AS gateway_id",
    "g.code AS gateway_code",
    "g.name AS gateway_name",
    "gs.supports_status_check AS supports_status_check",
    "pl.id AS link_id",
    "pl.key AS link_key",
];

fn transactions_columns() -> ColumnMap {
    ColumnMap::new()
        .with("id", "pa.id", ColumnKind::Uuid)
        .with("createdAt", "pa.created_at", ColumnKind::Timestamp)
        .with("updatedAt", "pa.updated_at", ColumnKind::Timestamp)
        .with("terminalAt", "pa.terminal_at", ColumnKind::Timestamp)
        .with("statusFilter", "pa.status::text", ColumnKind::Text)
        .with("status", "pa.status", ColumnKind::Text)
        .with("envFilter", "pa.env::text", ColumnKind::Text)
        .with("applicationId", "pa.application_id", ColumnKind::Uuid)
        .with("railId", "pa.rail_id", ColumnKind::Uuid)
        .with("reference", "pa.reference", ColumnKind::Text)
        .with(
            "providerReference",
            "pa.provider_reference",
            ColumnKind::Text,
        )
        .with("networkReference", "pa.network_reference", ColumnKind::Text)
        .with("gatewayReference", "pa.gateway_reference", ColumnKind::Text)
        .with(
            "totalChargedAmount",
            "pa.total_charged_amount",
            ColumnKind::Decimal,
        )
}

fn transactions_spec(support: bool) -> ListSpec {
    let search: &[&str] = if support {
        &["reference"]
    } else {
        &[
            "reference",
            "providerReference",
            "networkReference",
            "gatewayReference",
        ]
    };
    ListSpec::default()
        .with_search(search)
        .with_in("status", "statusFilter")
        .with_in("env", "envFilter")
        .with_in("applicationId", "applicationId")
        .with_in("railId", "railId")
        .with_date(DateFilter::new("createdAt", "createdAt"))
        .with_date(
            DateFilter::new("terminalAt", "terminalAt").with_keys("terminalFrom", "terminalTo"),
        )
        .with_range(RangeFilter::new(
            "amount",
            "totalChargedAmount",
            RangeKind::Decimal,
        ))
        .with_sortable("reference", "reference")
        .with_sortable("status", "status")
        .with_sortable("createdAt", "createdAt")
        .with_sortable("terminalAt", "terminalAt")
        .with_sortable("totalChargedAmount", "totalChargedAmount")
        .with_default_sort("createdAt", SortDirection::Desc)
        .with_default_page_size(10.0)
}

fn transaction_row(row: &PgRow, flags: &common::Flags) -> Result<Value, ApiError> {
    let support = flags.support;
    let status = common::text(row, "status")?;
    let terminal_at = common::opt_naive(row, "terminal_at")?;
    let supports = common::opt_bool(row, "supports_status_check")?.unwrap_or(false);
    let (eligible, reason) =
        support::inquiry_eligibility(Some(&status), terminal_at.is_some(), supports);
    let money = |column: &str| -> Result<Value, ApiError> {
        if support {
            Ok(Value::Null)
        } else {
            Ok(support::merchant_money(common::opt_decimal(row, column)?))
        }
    };
    let fee = |column: &str| -> Result<Value, ApiError> {
        if support || !flags.can_financial {
            Ok(Value::Null)
        } else {
            Ok(support::merchant_money(common::opt_decimal(row, column)?))
        }
    };
    let redacted = if support {
        json!([
            "amounts",
            "fees",
            "net",
            "providerReference",
            "networkReference",
            "gatewayReference",
            "link",
            "ledgerEntryId"
        ])
    } else if flags.can_financial {
        Value::Array(Vec::new())
    } else {
        json!([
            "settledAmount",
            "gatewayFeeAmount",
            "platformCommissionAmount",
            "netMerchantAmount"
        ])
    };
    let application = if common::opt_uuid_text(row, "app_id")?.is_some() {
        json!({
            "id": common::uuid_text(row, "app_id")?,
            "name": common::text(row, "app_name")?,
        })
    } else {
        Value::Null
    };
    let rail = if common::opt_uuid_text(row, "rail_id")?.is_some() {
        json!({
            "id": common::uuid_text(row, "rail_id")?,
            "code": common::text(row, "rail_code")?,
            "nameEn": common::text(row, "rail_name_en")?,
        })
    } else {
        Value::Null
    };
    let gateway = if common::opt_uuid_text(row, "gateway_id")?.is_some() {
        json!({
            "id": common::uuid_text(row, "gateway_id")?,
            "code": common::text(row, "gateway_code")?,
            "name": common::text(row, "gateway_name")?,
        })
    } else {
        Value::Null
    };
    let link = if support {
        Value::Null
    } else if common::opt_uuid_text(row, "link_id")?.is_some() {
        json!({
            "id": common::uuid_text(row, "link_id")?,
            "key": common::text(row, "link_key")?,
        })
    } else {
        Value::Null
    };
    Ok(json!({
        "id": common::uuid_text(row, "id")?,
        "reference": common::text(row, "reference")?,
        "createdAt": common::iso_naive(common::naive(row, "created_at")?),
        "updatedAt": common::iso_naive(common::naive(row, "updated_at")?),
        "terminalAt": common::iso_value(terminal_at),
        "status": status,
        "substatus": common::opt_text(row, "substatus")?,
        "env": common::text(row, "env")?,
        "mode": common::text(row, "mode")?,
        "subMode": common::opt_text(row, "sub_mode")?,
        "currency": common::text(row, "currency")?,
        "application": application,
        "rail": rail,
        "gateway": gateway,
        "link": link,
        "ledgerEntryId": if support {
            Value::Null
        } else {
            common::opt_uuid_text(row, "ledger_entry_id")?.map_or(Value::Null, Value::String)
        },
        "providerReference": if support {
            Value::Null
        } else {
            common::opt_text(row, "provider_reference")?.map_or(Value::Null, Value::String)
        },
        "networkReference": if support {
            Value::Null
        } else {
            common::opt_text(row, "network_reference")?.map_or(Value::Null, Value::String)
        },
        "gatewayReference": if support {
            Value::Null
        } else {
            common::opt_text(row, "gateway_reference")?.map_or(Value::Null, Value::String)
        },
        "requestedAmount": money("requested_amount")?,
        "surchargeAmount": money("surcharge_amount")?,
        "totalChargedAmount": money("total_charged_amount")?,
        "settledAmount": fee("settled_amount")?,
        "gatewayFeeAmount": fee("gateway_fee_amount")?,
        "platformCommissionAmount": fee("platform_commission_amount")?,
        "netMerchantAmount": fee("net_merchant_amount")?,
        "operatorCases": Value::Array(Vec::new()),
        "inquiryEligible": eligible,
        "inquiryEligibilityReason": reason,
        "redactedFields": redacted,
    }))
}

/// `operatorCases {select:…, orderBy: createdAt desc, take: 3}` for a page of attempts.
async fn load_operator_cases(
    pool: &PgPool,
    attempt_ids: &[String],
) -> Result<std::collections::BTreeMap<String, Vec<Value>>, ApiError> {
    let mut map: std::collections::BTreeMap<String, Vec<Value>> = std::collections::BTreeMap::new();
    if attempt_ids.is_empty() {
        return Ok(map);
    }
    let rows = sqlx::query(
        "SELECT attempt_id, id, kind::text AS kind, state::text AS state, priority::text AS priority, \
         sla_due_at FROM ( \
             SELECT oc.attempt_id, oc.id, oc.kind, oc.state, oc.priority, oc.sla_due_at, \
                    row_number() OVER (PARTITION BY oc.attempt_id ORDER BY oc.created_at DESC) AS rn \
             FROM operator_cases oc WHERE oc.attempt_id = ANY($1::uuid[]) \
         ) t WHERE rn <= 3 ORDER BY attempt_id, rn",
    )
    .bind(common::uuid_values(attempt_ids))
    .fetch_all(pool)
    .await
    .map_err(common::database_error)?;
    for row in &rows {
        map.entry(common::uuid_text(row, "attempt_id")?)
            .or_default()
            .push(json!({
                "id": common::uuid_text(row, "id")?,
                "kind": common::text(row, "kind")?,
                "state": common::text(row, "state")?,
                "priority": common::text(row, "priority")?,
                "slaDueAt": common::iso_value(common::opt_naive(row, "sla_due_at")?),
            }));
    }
    Ok(map)
}

/// `GET /internal/admin/merchants/:id/transactions`.
pub async fn transactions(
    pool: &PgPool,
    principal: Option<&Principal>,
    id: &str,
    query_string: &str,
) -> Result<Value, ApiError> {
    let merchant_id = support::require_merchant(pool, id).await?;
    let flags = common::flags(principal);
    let query = common::parse_query(query_string);
    let mut built = pg_db::build_list_query(
        &query,
        &transactions_spec(flags.support),
        &transactions_columns(),
    )
    .map_err(common::list_error)?;
    support::scope_merchant(&mut built, "pa.merchant_id", &merchant_id);

    let sql = built.select_sql(TRANSACTIONS_FROM, TRANSACTIONS_COLUMNS);
    let rows = built
        .bind_rows(&sql)
        .fetch_all(pool)
        .await
        .map_err(common::database_error)?;
    let total = support::count_rows(pool, &built, TRANSACTIONS_FROM).await?;

    let attempt_ids: Vec<String> = rows
        .iter()
        .map(|row| common::uuid_text(row, "id"))
        .collect::<Result<_, _>>()?;
    let cases = load_operator_cases(pool, &attempt_ids).await?;

    let mut items = Vec::with_capacity(rows.len());
    let mut cursor_rows: Vec<Vec<pg_db::CursorValue>> = Vec::new();
    for row in &rows {
        let mut value = transaction_row(row, &flags)?;
        let id = common::uuid_text(row, "id")?;
        if let Some(entries) = cases.get(&id) {
            value["operatorCases"] = Value::Array(entries.clone());
        }
        items.push(value);
        support::push_cursor(
            &built.keyset,
            common::naive(row, "created_at")?,
            Some(common::naive(row, "updated_at")?),
            &id,
            &mut cursor_rows,
        );
    }

    let mut response = pg_db::list_response(
        "transactions",
        Value::Array(items),
        Some(total),
        &built,
        &cursor_rows,
    );
    response["redactedFields"] = if flags.support {
        json!(["financialFields", "providerReferences"])
    } else {
        Value::Array(Vec::new())
    };
    Ok(response)
}

// ------------------------------------------------------------------ applications

const APPLICATIONS_FROM: &str =
    "applications a LEFT JOIN wallets aw ON aw.id = a.assigned_wallet_id";

const APPLICATIONS_COLUMNS: &[&str] = &[
    "a.id AS id",
    "a.name AS name",
    "a.status::text AS status",
    "a.expected_monthly_volume AS expected_monthly_volume",
    "a.rail_whitelist AS rail_whitelist",
    "a.redirect_domain_allowlist AS redirect_domain_allowlist",
    "a.created_at AS created_at",
    "aw.id AS wallet_id",
    "aw.currency::text AS wallet_currency",
    "aw.status::text AS wallet_status",
    "(SELECT count(*) FROM access_tokens t WHERE t.application_id = a.id) AS access_token_count",
    "(SELECT count(*) FROM payment_links l WHERE l.application_id = a.id) AS payment_link_count",
    "(SELECT count(*) FROM pos_terminals p WHERE p.application_id = a.id) AS pos_terminal_count",
];

fn applications_columns() -> ColumnMap {
    ColumnMap::new()
        .with("id", "a.id", ColumnKind::Uuid)
        .with("idSearch", "a.id::text", ColumnKind::Text)
        .with("name", "a.name", ColumnKind::Text)
        .with("statusFilter", "a.status::text", ColumnKind::Text)
        .with("status", "a.status", ColumnKind::Text)
        .with("walletId", "a.assigned_wallet_id", ColumnKind::Uuid)
        .with("createdAt", "a.created_at", ColumnKind::Timestamp)
        .with(
            "expectedMonthlyVolume",
            "a.expected_monthly_volume",
            ColumnKind::Decimal,
        )
}

fn applications_spec() -> ListSpec {
    ListSpec::default()
        .with_search(&["name", "idSearch"])
        .with_in("status", "statusFilter")
        .with_equals("walletId", "walletId")
        .with_date(DateFilter::new("createdAt", "createdAt"))
        .with_sortable("name", "name")
        .with_sortable("status", "status")
        .with_sortable("createdAt", "createdAt")
        .with_sortable("expectedMonthlyVolume", "expectedMonthlyVolume")
        .with_default_sort("createdAt", SortDirection::Desc)
        .with_default_page_size(10.0)
}

fn json_array(value: &Value) -> Vec<Value> {
    value.as_array().cloned().unwrap_or_default()
}

/// `GET /internal/admin/merchants/:id/applications`.
pub async fn applications(
    pool: &PgPool,
    principal: Option<&Principal>,
    id: &str,
    query_string: &str,
) -> Result<Value, ApiError> {
    let merchant_id = support::require_merchant(pool, id).await?;
    let flags = common::flags(principal);
    let query = common::parse_query(query_string);
    let mut built = pg_db::build_list_query(&query, &applications_spec(), &applications_columns())
        .map_err(common::list_error)?;
    support::scope_merchant(&mut built, "a.merchant_id", &merchant_id);

    let sql = built.select_sql(APPLICATIONS_FROM, APPLICATIONS_COLUMNS);
    let rows = built
        .bind_rows(&sql)
        .fetch_all(pool)
        .await
        .map_err(common::database_error)?;
    let total = support::count_rows(pool, &built, APPLICATIONS_FROM).await?;

    let mut items = Vec::with_capacity(rows.len());
    let mut cursor_rows: Vec<Vec<pg_db::CursorValue>> = Vec::new();
    for row in &rows {
        let whitelist = common::opt_json(row, "rail_whitelist")?;
        let (mode, count, whitelist_value) = match whitelist {
            None => ("ALL", 0_i64, Value::Null),
            Some(Value::Null) => ("ALL", 0, Value::Null),
            Some(Value::Array(entries)) => {
                let length = entries.len() as i64;
                (
                    if entries.is_empty() { "NONE" } else { "LIST" },
                    length,
                    Value::Array(entries),
                )
            }
            Some(_) => ("ALL", 0, Value::Null),
        };
        let redirects = common::opt_json(row, "redirect_domain_allowlist")?
            .map(|value| json_array(&value))
            .unwrap_or_default();
        let wallet = if common::opt_uuid_text(row, "wallet_id")?.is_some() {
            json!({
                "id": common::uuid_text(row, "wallet_id")?,
                "currency": common::text(row, "wallet_currency")?,
                "status": common::text(row, "wallet_status")?,
            })
        } else {
            Value::Null
        };
        let id = common::uuid_text(row, "id")?;
        items.push(json!({
            "id": id,
            "name": common::text(row, "name")?,
            "status": common::text(row, "status")?,
            "expectedMonthlyVolume": if flags.support {
                Value::Null
            } else {
                support::merchant_money(Some(common::decimal(row, "expected_monthly_volume")?))
            },
            "assignedWallet": wallet,
            "accessTokenCount": common::i64_of(row, "access_token_count")?,
            "paymentLinkCount": common::i64_of(row, "payment_link_count")?,
            "posTerminalCount": common::i64_of(row, "pos_terminal_count")?,
            "railWhitelistMode": mode,
            "railWhitelistCount": count,
            "railWhitelist": whitelist_value,
            "redirectDomainCount": redirects.len() as i64,
            "redirectDomains": if flags.can_sensitive {
                Value::Array(redirects)
            } else {
                Value::Array(Vec::new())
            },
            "createdAt": common::iso_naive(common::naive(row, "created_at")?),
            "redactedFields": if flags.support {
                json!(["expectedMonthlyVolume"])
            } else {
                Value::Array(Vec::new())
            },
        }));
        support::push_cursor(
            &built.keyset,
            common::naive(row, "created_at")?,
            None,
            &id,
            &mut cursor_rows,
        );
    }

    Ok(pg_db::list_response(
        "applications",
        Value::Array(items),
        Some(total),
        &built,
        &cursor_rows,
    ))
}

// ------------------------------------------------------------------ wallets

const WALLETS_FROM: &str = "wallets w";

const WALLETS_COLUMNS: &[&str] = &[
    "w.id AS id",
    "w.currency::text AS currency",
    "w.status::text AS status",
    "w.gl_account_id AS gl_account_id",
    "w.created_at AS created_at",
    "(SELECT count(*) FROM applications a WHERE a.assigned_wallet_id = w.id) AS application_count",
    "(SELECT count(*) FROM payment_links l WHERE l.wallet_id = w.id) AS payment_link_count",
    "(SELECT count(*) FROM cashout_requests c WHERE c.wallet_id = w.id) AS cashout_count",
];

fn wallets_columns() -> ColumnMap {
    ColumnMap::new()
        .with("id", "w.id", ColumnKind::Uuid)
        .with("idSearch", "w.id::text", ColumnKind::Text)
        .with("glSearch", "w.gl_account_id::text", ColumnKind::Text)
        .with("statusFilter", "w.status::text", ColumnKind::Text)
        .with("status", "w.status", ColumnKind::Text)
        .with("currency", "w.currency::text", ColumnKind::Text)
        .with("createdAt", "w.created_at", ColumnKind::Timestamp)
}

fn wallets_spec() -> ListSpec {
    ListSpec::default()
        .with_search(&["idSearch", "glSearch"])
        .with_in("status", "statusFilter")
        .with_in("currency", "currency")
        .with_date(DateFilter::new("createdAt", "createdAt"))
        .with_sortable("currency", "currency")
        .with_sortable("status", "status")
        .with_sortable("createdAt", "createdAt")
        .with_default_sort("createdAt", SortDirection::Asc)
        .with_default_page_size(10.0)
}

/// `loadAccountCheckpointSummary`: the sum of the shard checkpoints, keyed by account.
async fn checkpoint_sums(
    pool: &PgPool,
    account_ids: &[String],
) -> Result<std::collections::BTreeMap<String, rust_decimal::Decimal>, ApiError> {
    let mut map = std::collections::BTreeMap::new();
    if account_ids.is_empty() {
        return Ok(map);
    }
    let rows = sqlx::query(
        "SELECT gl_account_id, COALESCE(sum(checkpoint_balance), 0) AS checkpoint \
         FROM gl_shard_checkpoints WHERE gl_account_id = ANY($1::uuid[]) GROUP BY gl_account_id",
    )
    .bind(common::uuid_values(account_ids))
    .fetch_all(pool)
    .await
    .map_err(common::database_error)?;
    for row in &rows {
        map.insert(
            common::uuid_text(row, "gl_account_id")?,
            common::decimal(row, "checkpoint")?,
        );
    }
    Ok(map)
}

/// `cashoutRequest.groupBy({by: ["walletId"]})` for the page's wallets.
async fn pending_cashout_counts(
    pool: &PgPool,
    wallet_ids: &[String],
) -> Result<std::collections::BTreeMap<String, i64>, ApiError> {
    let mut map = std::collections::BTreeMap::new();
    if wallet_ids.is_empty() {
        return Ok(map);
    }
    let rows = sqlx::query(
        "SELECT wallet_id, count(*) AS count FROM cashout_requests \
         WHERE wallet_id = ANY($1::uuid[]) AND state::text IN ('PENDING', 'PROCESSING') \
         GROUP BY wallet_id",
    )
    .bind(common::uuid_values(wallet_ids))
    .fetch_all(pool)
    .await
    .map_err(common::database_error)?;
    for row in &rows {
        map.insert(
            common::uuid_text(row, "wallet_id")?,
            common::i64_of(row, "count")?,
        );
    }
    Ok(map)
}

/// `GET /internal/admin/merchants/:id/wallets`.
pub async fn wallets_list(
    pool: &PgPool,
    principal: Option<&Principal>,
    id: &str,
    query_string: &str,
) -> Result<Value, ApiError> {
    let merchant_id = support::require_merchant(pool, id).await?;
    let flags = common::flags(principal);
    let query = common::parse_query(query_string);
    let mut built = pg_db::build_list_query(&query, &wallets_spec(), &wallets_columns())
        .map_err(common::list_error)?;
    support::scope_merchant(&mut built, "w.merchant_id", &merchant_id);

    let sql = built.select_sql(WALLETS_FROM, WALLETS_COLUMNS);
    let rows = built
        .bind_rows(&sql)
        .fetch_all(pool)
        .await
        .map_err(common::database_error)?;
    let total = support::count_rows(pool, &built, WALLETS_FROM).await?;

    let wallet_ids: Vec<String> = rows
        .iter()
        .map(|row| common::uuid_text(row, "id"))
        .collect::<Result<_, _>>()?;
    let account_ids: Vec<String> = rows
        .iter()
        .map(|row| common::uuid_text(row, "gl_account_id"))
        .collect::<Result<_, _>>()?;

    let balances = if flags.can_financial {
        Some(wallets::merchant_wallet_balance(pool, &merchant_id.to_string()).await?)
    } else {
        None
    };
    let balance_by_wallet: std::collections::BTreeMap<String, String> = balances
        .as_ref()
        .and_then(|value| value.get("wallets"))
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    Some((
                        entry.get("id")?.as_str()?.to_owned(),
                        entry.get("balance")?.as_str()?.to_owned(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default();
    let checkpoints = if flags.can_financial {
        checkpoint_sums(pool, &account_ids).await?
    } else {
        std::collections::BTreeMap::new()
    };
    let pending = if flags.can_financial {
        pending_cashout_counts(pool, &wallet_ids).await?
    } else {
        std::collections::BTreeMap::new()
    };

    let mut items = Vec::with_capacity(rows.len());
    let mut cursor_rows: Vec<Vec<pg_db::CursorValue>> = Vec::new();
    for row in &rows {
        let id = common::uuid_text(row, "id")?;
        let gl_account = common::uuid_text(row, "gl_account_id")?;
        let checkpoint = checkpoints
            .get(&gl_account)
            .copied()
            .map(|stored| support::natural_shard_balance("MERCHANT_WALLET", stored))
            .unwrap_or_default();
        items.push(json!({
            "id": id,
            "currency": common::text(row, "currency")?,
            "status": common::text(row, "status")?,
            "glAccountId": gl_account,
            "balance": if flags.can_financial {
                Value::String(balance_by_wallet.get(&id).cloned().unwrap_or_else(|| "0.0000".to_owned()))
            } else {
                Value::Null
            },
            "checkpointBalance": if flags.can_financial {
                Value::String(pg_types::Money4(checkpoint).to_string())
            } else {
                Value::Null
            },
            "applicationCount": common::i64_of(row, "application_count")?,
            "paymentLinkCount": common::i64_of(row, "payment_link_count")?,
            "cashoutCount": common::i64_of(row, "cashout_count")?,
            "pendingCashoutCount": pending.get(&id).copied().unwrap_or(0),
            "createdAt": common::iso_naive(common::naive(row, "created_at")?),
            "redactedFields": if flags.can_financial {
                Value::Array(Vec::new())
            } else {
                json!(["balance", "checkpointBalance"])
            },
        }));
        support::push_cursor(
            &built.keyset,
            common::naive(row, "created_at")?,
            None,
            &id,
            &mut cursor_rows,
        );
    }

    Ok(pg_db::list_response(
        "wallets",
        Value::Array(items),
        Some(total),
        &built,
        &cursor_rows,
    ))
}

// ------------------------------------------------------------------ cash-outs

const CASHOUTS_FROM: &str = "cashout_requests c \
     JOIN wallets w ON w.id = c.wallet_id \
     LEFT JOIN adjustments adj ON adj.id = c.adjustment_id";

const CASHOUTS_COLUMNS: &[&str] = &[
    "c.id AS id",
    "c.amount AS amount",
    "c.state::text AS state",
    "c.destination_bank_json AS destination_bank_json",
    "c.adjustment_id AS adjustment_id",
    "c.created_at AS created_at",
    "w.id AS wallet_id",
    "w.currency::text AS wallet_currency",
    "w.status::text AS wallet_status",
    "adj.id AS adjustment_ref_id",
    "adj.state::text AS adjustment_state",
    "adj.journal_entry_id AS adjustment_journal_entry_id",
];

fn cashouts_columns() -> ColumnMap {
    ColumnMap::new()
        .with("id", "c.id", ColumnKind::Uuid)
        .with("idSearch", "c.id::text", ColumnKind::Text)
        .with(
            "adjustmentSearch",
            "c.adjustment_id::text",
            ColumnKind::Text,
        )
        .with("stateFilter", "c.state::text", ColumnKind::Text)
        .with("state", "c.state", ColumnKind::Text)
        .with("walletId", "c.wallet_id", ColumnKind::Uuid)
        .with("createdAt", "c.created_at", ColumnKind::Timestamp)
        .with("amount", "c.amount", ColumnKind::Decimal)
}

fn cashouts_spec() -> ListSpec {
    ListSpec::default()
        .with_search(&["idSearch", "adjustmentSearch"])
        .with_in("state", "stateFilter")
        .with_in("walletId", "walletId")
        .with_date(DateFilter::new("createdAt", "createdAt"))
        .with_range(RangeFilter::new("amount", "amount", RangeKind::Decimal))
        .with_sortable("amount", "amount")
        .with_sortable("state", "state")
        .with_sortable("createdAt", "createdAt")
        .with_default_sort("createdAt", SortDirection::Desc)
        .with_default_page_size(10.0)
}

/// `GET /internal/admin/merchants/:id/cashouts`.
pub async fn cashouts(
    pool: &PgPool,
    principal: Option<&Principal>,
    id: &str,
    query_string: &str,
) -> Result<Value, ApiError> {
    let merchant_id = support::require_merchant(pool, id).await?;
    let flags = common::flags(principal);
    if !flags.can_financial {
        return Err(support::financial_access_required(
            "Financial access is required to view cash-outs",
        ));
    }
    let query = common::parse_query(query_string);
    let mut built = pg_db::build_list_query(&query, &cashouts_spec(), &cashouts_columns())
        .map_err(common::list_error)?;
    support::scope_merchant(&mut built, "c.merchant_id", &merchant_id);

    let sql = built.select_sql(CASHOUTS_FROM, CASHOUTS_COLUMNS);
    let rows = built
        .bind_rows(&sql)
        .fetch_all(pool)
        .await
        .map_err(common::database_error)?;
    let total = support::count_rows(pool, &built, CASHOUTS_FROM).await?;

    let mut items = Vec::with_capacity(rows.len());
    let mut cursor_rows: Vec<Vec<pg_db::CursorValue>> = Vec::new();
    for row in &rows {
        let adjustment = if common::opt_uuid_text(row, "adjustment_ref_id")?.is_some() {
            json!({
                "id": common::uuid_text(row, "adjustment_ref_id")?,
                "state": common::text(row, "adjustment_state")?,
                "journalEntryId": common::opt_uuid_text(row, "adjustment_journal_entry_id")?
                    .map_or(Value::Null, Value::String),
            })
        } else {
            Value::Null
        };
        let id = common::uuid_text(row, "id")?;
        items.push(json!({
            "id": id,
            "amount": support::merchant_money(Some(common::decimal(row, "amount")?)),
            "currency": common::text(row, "wallet_currency")?,
            "state": common::text(row, "state")?,
            "wallet": {
                "id": common::uuid_text(row, "wallet_id")?,
                "currency": common::text(row, "wallet_currency")?,
                "status": common::text(row, "wallet_status")?,
            },
            "destination": support::masked_json(&common::json_value(row, "destination_bank_json")?),
            "adjustmentId": common::opt_uuid_text(row, "adjustment_id")?
                .map_or(Value::Null, Value::String),
            "adjustment": adjustment,
            "createdAt": common::iso_naive(common::naive(row, "created_at")?),
        }));
        support::push_cursor(
            &built.keyset,
            common::naive(row, "created_at")?,
            None,
            &id,
            &mut cursor_rows,
        );
    }

    Ok(pg_db::list_response(
        "cashouts",
        Value::Array(items),
        Some(total),
        &built,
        &cursor_rows,
    ))
}

// ------------------------------------------------------------------ disputes

const DISPUTES_FROM: &str = "disputes d \
     JOIN payment_attempts pa ON pa.id = d.attempt_id \
     JOIN gateways g ON g.id = d.gateway_id \
     JOIN rails r ON r.id = d.rail_id \
     LEFT JOIN adjustments adj ON adj.dispute_id = d.id";

const DISPUTES_COLUMNS: &[&str] = &[
    "d.id AS id",
    "d.external_dispute_ref AS external_dispute_ref",
    "d.source::text AS source",
    "d.reason_code AS reason_code",
    "d.amount AS amount",
    "d.currency::text AS currency",
    "d.status::text AS status",
    "d.opened_at AS opened_at",
    "d.evidence_due_at AS evidence_due_at",
    "d.outcome_at AS outcome_at",
    "d.adjustment_id AS adjustment_id",
    "pa.id AS attempt_id",
    "pa.reference AS attempt_reference",
    "pa.status::text AS attempt_status",
    "g.id AS gateway_id",
    "g.code AS gateway_code",
    "g.name AS gateway_name",
    "r.id AS rail_id",
    "r.code AS rail_code",
    "r.name_en AS rail_name_en",
    "adj.id AS adjustment_ref_id",
    "adj.state::text AS adjustment_state",
    "adj.journal_entry_id AS adjustment_journal_entry_id",
];

fn disputes_columns() -> ColumnMap {
    ColumnMap::new()
        .with("id", "d.id", ColumnKind::Uuid)
        .with("idSearch", "d.id::text", ColumnKind::Text)
        .with(
            "externalDisputeRef",
            "d.external_dispute_ref",
            ColumnKind::Text,
        )
        .with("attemptReference", "pa.reference", ColumnKind::Text)
        .with("statusFilter", "d.status::text", ColumnKind::Text)
        .with("status", "d.status", ColumnKind::Text)
        .with("railId", "d.rail_id", ColumnKind::Uuid)
        .with("openedAt", "d.opened_at", ColumnKind::Timestamp)
        .with("evidenceDueAt", "d.evidence_due_at", ColumnKind::Timestamp)
        .with("amount", "d.amount", ColumnKind::Decimal)
}

fn disputes_spec() -> ListSpec {
    ListSpec::default()
        .with_search(&["idSearch", "externalDisputeRef", "attemptReference"])
        .with_in("status", "statusFilter")
        .with_in("railId", "railId")
        .with_date(DateFilter::new("openedAt", "openedAt").with_keys("openedFrom", "openedTo"))
        .with_date(DateFilter::new("evidenceDueAt", "evidenceDueAt").with_keys("dueFrom", "dueTo"))
        .with_range(RangeFilter::new("amount", "amount", RangeKind::Decimal))
        .with_sortable("amount", "amount")
        .with_sortable("status", "status")
        .with_sortable("openedAt", "openedAt")
        .with_sortable("evidenceDueAt", "evidenceDueAt")
        .with_default_sort("openedAt", SortDirection::Desc)
        .with_default_page_size(10.0)
}

fn adjustment_ref(row: &PgRow) -> Result<Value, ApiError> {
    if common::opt_uuid_text(row, "adjustment_ref_id")?.is_none() {
        return Ok(Value::Null);
    }
    Ok(json!({
        "id": common::uuid_text(row, "adjustment_ref_id")?,
        "state": common::text(row, "adjustment_state")?,
        "journalEntryId": common::opt_uuid_text(row, "adjustment_journal_entry_id")?
            .map_or(Value::Null, Value::String),
    }))
}

/// `GET /internal/admin/merchants/:id/disputes`.
pub async fn disputes(
    pool: &PgPool,
    principal: Option<&Principal>,
    id: &str,
    query_string: &str,
) -> Result<Value, ApiError> {
    let merchant_id = support::require_merchant(pool, id).await?;
    let flags = common::flags(principal);
    if !flags.can_financial {
        return Err(support::financial_access_required(
            "Financial access is required to view disputes",
        ));
    }
    let query = common::parse_query(query_string);
    let mut built = pg_db::build_list_query(&query, &disputes_spec(), &disputes_columns())
        .map_err(common::list_error)?;
    support::scope_merchant(&mut built, "pa.merchant_id", &merchant_id);

    let sql = built.select_sql(DISPUTES_FROM, DISPUTES_COLUMNS);
    let rows = built
        .bind_rows(&sql)
        .fetch_all(pool)
        .await
        .map_err(common::database_error)?;
    let total = support::count_rows(pool, &built, DISPUTES_FROM).await?;

    let mut items = Vec::with_capacity(rows.len());
    for row in &rows {
        items.push(json!({
            "id": common::uuid_text(row, "id")?,
            "externalDisputeRef": common::text(row, "external_dispute_ref")?,
            "source": common::text(row, "source")?,
            "reasonCode": common::opt_text(row, "reason_code")?,
            "amount": support::merchant_money(Some(common::decimal(row, "amount")?)),
            "currency": common::text(row, "currency")?,
            "status": common::text(row, "status")?,
            "openedAt": common::iso_naive(common::naive(row, "opened_at")?),
            "evidenceDueAt": common::iso_value(common::opt_naive(row, "evidence_due_at")?),
            "outcomeAt": common::iso_value(common::opt_naive(row, "outcome_at")?),
            "adjustmentId": common::opt_text(row, "adjustment_id")?,
            "attempt": {
                "id": common::uuid_text(row, "attempt_id")?,
                "reference": common::text(row, "attempt_reference")?,
                "status": common::text(row, "attempt_status")?,
            },
            "gateway": {
                "id": common::uuid_text(row, "gateway_id")?,
                "code": common::text(row, "gateway_code")?,
                "name": common::text(row, "gateway_name")?,
            },
            "rail": {
                "id": common::uuid_text(row, "rail_id")?,
                "code": common::text(row, "rail_code")?,
                "nameEn": common::text(row, "rail_name_en")?,
            },
            "adjustment": adjustment_ref(row)?,
        }));
    }

    Ok(pg_db::list_response(
        "disputes",
        Value::Array(items),
        Some(total),
        &built,
        &[],
    ))
}

// ------------------------------------------------------------------ adjustments

const ADJUSTMENTS_FROM: &str = "adjustments aj \
     LEFT JOIN payment_attempts pa ON pa.id = aj.source_attempt_id \
     JOIN gl_accounts tgt ON tgt.id = aj.target_gl_account_id \
     LEFT JOIN disputes d ON d.id = aj.dispute_id";

const ADJUSTMENTS_COLUMNS: &[&str] = &[
    "aj.id AS id",
    "aj.type::text AS type",
    "aj.amount AS amount",
    "aj.reverse_commission AS reverse_commission",
    "aj.reason AS reason",
    "aj.external_dispute_ref AS external_dispute_ref",
    "aj.provider_refund_ref AS provider_refund_ref",
    "aj.state::text AS state",
    "aj.journal_entry_id AS journal_entry_id",
    "aj.created_at AS created_at",
    "tgt.id AS target_id",
    "tgt.account_type::text AS target_account_type",
    "tgt.currency::text AS target_currency",
    "tgt.owner_id AS target_owner_id",
    "pa.id AS source_id",
    "pa.reference AS source_reference",
    "pa.status::text AS source_status",
    "pa.currency::text AS source_currency",
    "d.id AS dispute_id",
    "d.external_dispute_ref AS dispute_external_ref",
    "d.status::text AS dispute_status",
];

fn adjustments_columns() -> ColumnMap {
    ColumnMap::new()
        .with("id", "aj.id", ColumnKind::Uuid)
        .with("idSearch", "aj.id::text", ColumnKind::Text)
        .with("reason", "aj.reason", ColumnKind::Text)
        .with(
            "externalDisputeRef",
            "aj.external_dispute_ref",
            ColumnKind::Text,
        )
        .with(
            "providerRefundRef",
            "aj.provider_refund_ref",
            ColumnKind::Text,
        )
        .with("sourceReference", "pa.reference", ColumnKind::Text)
        .with("typeFilter", "aj.type::text", ColumnKind::Text)
        .with("type", "aj.type", ColumnKind::Text)
        .with("stateFilter", "aj.state::text", ColumnKind::Text)
        .with("state", "aj.state", ColumnKind::Text)
        .with("createdAt", "aj.created_at", ColumnKind::Timestamp)
        .with("amount", "aj.amount", ColumnKind::Decimal)
}

fn adjustments_spec() -> ListSpec {
    ListSpec::default()
        .with_search(&[
            "idSearch",
            "reason",
            "externalDisputeRef",
            "providerRefundRef",
            "sourceReference",
        ])
        .with_in("type", "typeFilter")
        .with_in("state", "stateFilter")
        .with_date(DateFilter::new("createdAt", "createdAt"))
        .with_range(RangeFilter::new("amount", "amount", RangeKind::Decimal))
        .with_sortable("amount", "amount")
        .with_sortable("type", "type")
        .with_sortable("state", "state")
        .with_sortable("createdAt", "createdAt")
        .with_default_sort("createdAt", SortDirection::Desc)
        .with_default_page_size(10.0)
}

/// `GET /internal/admin/merchants/:id/adjustments`.
pub async fn adjustments(
    pool: &PgPool,
    principal: Option<&Principal>,
    id: &str,
    query_string: &str,
) -> Result<Value, ApiError> {
    let merchant_id = support::require_merchant(pool, id).await?;
    let flags = common::flags(principal);
    if !flags.can_financial {
        return Err(support::financial_access_required(
            "Financial access is required to view adjustments",
        ));
    }
    let query = common::parse_query(query_string);
    let mut built = pg_db::build_list_query(&query, &adjustments_spec(), &adjustments_columns())
        .map_err(common::list_error)?;
    support::scope_merchant_or_owner(&mut built, "pa.merchant_id", "tgt.owner_id", &merchant_id);

    let sql = built.select_sql(ADJUSTMENTS_FROM, ADJUSTMENTS_COLUMNS);
    let rows = built
        .bind_rows(&sql)
        .fetch_all(pool)
        .await
        .map_err(common::database_error)?;
    let total = support::count_rows(pool, &built, ADJUSTMENTS_FROM).await?;

    let mut items = Vec::with_capacity(rows.len());
    let mut cursor_rows: Vec<Vec<pg_db::CursorValue>> = Vec::new();
    for row in &rows {
        let source = if common::opt_uuid_text(row, "source_id")?.is_some() {
            json!({
                "id": common::uuid_text(row, "source_id")?,
                "reference": common::text(row, "source_reference")?,
                "status": common::text(row, "source_status")?,
                "currency": common::text(row, "source_currency")?,
            })
        } else {
            Value::Null
        };
        let dispute = if common::opt_uuid_text(row, "dispute_id")?.is_some() {
            json!({
                "id": common::uuid_text(row, "dispute_id")?,
                "externalDisputeRef": common::text(row, "dispute_external_ref")?,
                "status": common::text(row, "dispute_status")?,
            })
        } else {
            Value::Null
        };
        let currency = common::opt_text(row, "source_currency")?
            .unwrap_or_else(|| common::text(row, "target_currency").unwrap_or_default());
        let id = common::uuid_text(row, "id")?;
        items.push(json!({
            "id": id,
            "type": common::text(row, "type")?,
            "amount": support::merchant_money(Some(common::decimal(row, "amount")?)),
            "reverseCommission": common::bool_of(row, "reverse_commission")?,
            "reason": common::text(row, "reason")?,
            "externalDisputeRef": common::opt_text(row, "external_dispute_ref")?,
            "providerRefundRef": common::opt_text(row, "provider_refund_ref")?,
            "state": common::text(row, "state")?,
            "journalEntryId": common::opt_uuid_text(row, "journal_entry_id")?
                .map_or(Value::Null, Value::String),
            "createdAt": common::iso_naive(common::naive(row, "created_at")?),
            "targetGlAccount": {
                "id": common::uuid_text(row, "target_id")?,
                "accountType": common::text(row, "target_account_type")?,
                "currency": common::text(row, "target_currency")?,
                "ownerId": common::opt_text(row, "target_owner_id")?,
            },
            "sourceAttempt": source,
            "dispute": dispute,
            "currency": currency,
        }));
        support::push_cursor(
            &built.keyset,
            common::naive(row, "created_at")?,
            None,
            &id,
            &mut cursor_rows,
        );
    }

    Ok(pg_db::list_response(
        "adjustments",
        Value::Array(items),
        Some(total),
        &built,
        &cursor_rows,
    ))
}

// ------------------------------------------------------------------ notifications

const NOTIFICATIONS_FROM: &str = "notifications n";

const NOTIFICATIONS_COLUMNS: &[&str] = &[
    "n.id AS id",
    "n.template_code AS template_code",
    "n.channel::text AS channel",
    "n.lang::text AS lang",
    "n.status::text AS status",
    "n.attempts AS attempts",
    "n.address_masked AS address_masked",
    "n.next_attempt_at AS next_attempt_at",
    "n.created_at AS created_at",
];

fn notifications_columns() -> ColumnMap {
    ColumnMap::new()
        .with("id", "n.id", ColumnKind::Uuid)
        .with("templateCode", "n.template_code", ColumnKind::Text)
        .with("templateCodeFilter", "n.template_code", ColumnKind::Text)
        .with("addressMasked", "n.address_masked", ColumnKind::Text)
        .with("statusFilter", "n.status::text", ColumnKind::Text)
        .with("status", "n.status", ColumnKind::Text)
        .with("channelFilter", "n.channel::text", ColumnKind::Text)
        .with("channel", "n.channel", ColumnKind::Text)
        .with("langFilter", "n.lang::text", ColumnKind::Text)
        .with("attempts", "n.attempts", ColumnKind::Integer)
        .with("createdAt", "n.created_at", ColumnKind::Timestamp)
}

fn notifications_spec() -> ListSpec {
    ListSpec::default()
        .with_search(&["templateCode", "addressMasked"])
        .with_in("status", "statusFilter")
        .with_in("channel", "channelFilter")
        .with_in("lang", "langFilter")
        .with_in("templateCode", "templateCodeFilter")
        .with_date(DateFilter::new("createdAt", "createdAt"))
        .with_sortable("templateCode", "templateCode")
        .with_sortable("status", "status")
        .with_sortable("channel", "channel")
        .with_sortable("attempts", "attempts")
        .with_sortable("createdAt", "createdAt")
        .with_default_sort("createdAt", SortDirection::Desc)
        .with_default_page_size(10.0)
}

/// `GET /internal/admin/merchants/:id/notifications`.
pub async fn notifications(
    pool: &PgPool,
    _principal: Option<&Principal>,
    id: &str,
    query_string: &str,
) -> Result<Value, ApiError> {
    let merchant_id = support::require_merchant(pool, id).await?;
    let query = common::parse_query(query_string);
    let mut built =
        pg_db::build_list_query(&query, &notifications_spec(), &notifications_columns())
            .map_err(common::list_error)?;
    support::scope_merchant(&mut built, "n.recipient_merchant_id", &merchant_id);

    let sql = built.select_sql(NOTIFICATIONS_FROM, NOTIFICATIONS_COLUMNS);
    let rows = built
        .bind_rows(&sql)
        .fetch_all(pool)
        .await
        .map_err(common::database_error)?;
    let total = support::count_rows(pool, &built, NOTIFICATIONS_FROM).await?;

    let mut items = Vec::with_capacity(rows.len());
    let mut cursor_rows: Vec<Vec<pg_db::CursorValue>> = Vec::new();
    for row in &rows {
        let id = common::uuid_text(row, "id")?;
        items.push(json!({
            "id": id,
            "templateCode": common::text(row, "template_code")?,
            "channel": common::text(row, "channel")?,
            "lang": common::text(row, "lang")?,
            "status": common::text(row, "status")?,
            "attempts": common::i32_of(row, "attempts")?,
            "addressMasked": common::text(row, "address_masked")?,
            "nextAttemptAt": common::iso_value(common::opt_naive(row, "next_attempt_at")?),
            "createdAt": common::iso_naive(common::naive(row, "created_at")?),
        }));
        support::push_cursor(
            &built.keyset,
            common::naive(row, "created_at")?,
            None,
            &id,
            &mut cursor_rows,
        );
    }

    Ok(pg_db::list_response(
        "notifications",
        Value::Array(items),
        Some(total),
        &built,
        &cursor_rows,
    ))
}

// ------------------------------------------------------------------ audit events

const AUDIT_FROM: &str = "audit_log a LEFT JOIN users u ON u.id = a.actor_id";

const AUDIT_COLUMNS: &[&str] = &[
    "a.id AS id",
    "a.action AS action",
    "a.role AS role",
    "a.entity_type AS entity_type",
    "a.entity_id AS entity_id",
    "a.approval_request_id AS approval_request_id",
    "a.before_json AS before_json",
    "a.after_json AS after_json",
    "a.created_at AS created_at",
    "u.email AS actor_email",
];

fn audit_columns() -> ColumnMap {
    ColumnMap::new()
        .with("id", "a.id", ColumnKind::Uuid)
        .with("action", "a.action", ColumnKind::Text)
        .with("role", "a.role", ColumnKind::Text)
        .with("actorEmail", "u.email", ColumnKind::Text)
        .with("createdAt", "a.created_at", ColumnKind::Timestamp)
}

fn audit_spec() -> ListSpec {
    ListSpec::default()
        .with_search(&["action", "role", "actorEmail"])
        .with_in("action", "action")
        .with_in("role", "role")
        .with_date(DateFilter::new("createdAt", "createdAt"))
        .with_sortable("action", "action")
        .with_sortable("role", "role")
        .with_sortable("createdAt", "createdAt")
        .with_default_sort("createdAt", SortDirection::Desc)
        .with_default_page_size(10.0)
}

/// `GET /internal/admin/merchants/:id/audit-events`.
pub async fn audit_events(
    pool: &PgPool,
    principal: Option<&Principal>,
    id: &str,
    query_string: &str,
) -> Result<Value, ApiError> {
    let merchant_id = support::require_merchant(pool, id).await?;
    let flags = common::flags(principal);
    let query = common::parse_query(query_string);
    let mut built = pg_db::build_list_query(&query, &audit_spec(), &audit_columns())
        .map_err(common::list_error)?;
    built
        .binds
        .push(pg_db::SqlBind::Text("MERCHANT".to_owned()));
    let entity_type = built.binds.len();
    built
        .binds
        .push(pg_db::SqlBind::Text(merchant_id.to_string()));
    let entity_id = built.binds.len();
    common::add_condition(
        &mut built,
        &format!("a.entity_type = ${entity_type}::text AND a.entity_id = ${entity_id}::text"),
    );

    let sql = built.select_sql(AUDIT_FROM, AUDIT_COLUMNS);
    let rows = built
        .bind_rows(&sql)
        .fetch_all(pool)
        .await
        .map_err(common::database_error)?;
    let total = support::count_rows(pool, &built, AUDIT_FROM).await?;

    let mut items = Vec::with_capacity(rows.len());
    let mut cursor_rows: Vec<Vec<pg_db::CursorValue>> = Vec::new();
    for row in &rows {
        let id = common::uuid_text(row, "id")?;
        items.push(json!({
            "id": id,
            "action": common::text(row, "action")?,
            "role": common::text(row, "role")?,
            "entityType": common::text(row, "entity_type")?,
            "entityId": common::text(row, "entity_id")?,
            "actorEmail": common::opt_text(row, "actor_email")?.map_or(Value::Null, Value::String),
            "approvalRequestId": common::opt_uuid_text(row, "approval_request_id")?
                .map_or(Value::Null, Value::String),
            "before": if flags.can_sensitive {
                common::json_value(row, "before_json")?
            } else {
                Value::Null
            },
            "after": if flags.can_sensitive {
                common::json_value(row, "after_json")?
            } else {
                Value::Null
            },
            "createdAt": common::iso_naive(common::naive(row, "created_at")?),
            "redacted": !flags.can_sensitive,
        }));
        support::push_cursor(
            &built.keyset,
            common::naive(row, "created_at")?,
            None,
            &id,
            &mut cursor_rows,
        );
    }

    Ok(pg_db::list_response(
        "auditEvents",
        Value::Array(items),
        Some(total),
        &built,
        &cursor_rows,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transaction_search_narrows_for_support() {
        assert_eq!(transactions_spec(true).search, vec!["reference".to_owned()]);
        assert!(transactions_spec(false)
            .search
            .contains(&"providerReference".to_owned()));
    }

    #[test]
    fn list_specs_use_the_ts_query_keys() {
        let disputes = disputes_spec();
        assert!(disputes
            .dates
            .iter()
            .any(|date| date.from_key() == "openedFrom" && date.to_key() == "openedTo"));
        assert!(disputes
            .dates
            .iter()
            .any(|date| date.from_key() == "dueFrom" && date.to_key() == "dueTo"));

        let cashouts = cashouts_spec();
        assert_eq!(cashouts.in_.get("state"), Some(&"stateFilter".to_owned()));
        assert_eq!(cashouts.ranges.len(), 1);

        let notifications = notifications_spec();
        assert_eq!(
            notifications.in_.get("templateCode"),
            Some(&"templateCodeFilter".to_owned())
        );
        assert_eq!(
            notifications.sortable.get("templateCode"),
            Some(&"templateCode".to_owned())
        );
    }

    #[test]
    fn column_maps_keep_enum_sorts_and_text_filters_apart() {
        let columns = adjustments_columns();
        assert_eq!(
            columns.get("typeFilter").map(|column| column.sql.as_str()),
            Some("aj.type::text")
        );
        assert_eq!(
            columns.get("type").map(|column| column.sql.as_str()),
            Some("aj.type")
        );
        let wallets = wallets_columns();
        assert_eq!(
            wallets.get("id").map(|column| column.kind),
            Some(ColumnKind::Uuid)
        );
    }

    #[test]
    fn json_arrays_keep_the_stored_entries() {
        assert_eq!(
            json_array(&json!(["a", 1, true])),
            vec![json!("a"), json!(1), json!(true)]
        );
        assert!(json_array(&json!({"a": 1})).is_empty());
    }

    #[test]
    fn default_page_sizes_match_the_ts_routes() {
        assert_eq!(transactions_spec(false).default_page_size, Some(10.0));
        assert_eq!(applications_spec().default_page_size, Some(10.0));
        assert_eq!(wallets_spec().default_page_size, Some(10.0));
        assert_eq!(cashouts_spec().default_page_size, Some(10.0));
        assert_eq!(disputes_spec().default_page_size, Some(10.0));
        assert_eq!(adjustments_spec().default_page_size, Some(10.0));
        assert_eq!(notifications_spec().default_page_size, Some(10.0));
        assert_eq!(audit_spec().default_page_size, Some(10.0));
    }
}

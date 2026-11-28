//! `GET /internal/admin/wallets` and `GET /internal/admin/wallets/:id`.
//!
//! Port of `core-back/api/internal/adminCommerce.ts:278` (`/wallets`) and `:367` (`/wallets/:id`),
//! plus the wallet halves shared with the merchant detail page: `serializeWalletRow` (`:234`),
//! `loadLiveAccountBalances`/`loadAccountCheckpointSummary` (`lib/storageEngine/shardBalances.ts`)
//! and `merchantWalletBalance` (`lib/merchantOps.ts:189`).
//!
//! Sign rule kept from TS: the GL account is credit-natural, the shard checkpoint is stored
//! debit-positive, and every wallet view shows the natural sign. `-0.0000` is normalised to
//! `0.0000`.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;

use chrono::NaiveDateTime;
use pg_db::{
    build_list_query, count_unless_skipped, ColumnKind, ColumnMap, DateFilter, ListSpec,
    SortDirection,
};
use pg_domain_auth::Principal;
use pg_http::ApiError;
use rust_decimal::Decimal;
use serde_json::{json, Map, Value};
use sqlx::PgPool;
use uuid::Uuid;

use super::common::{self, Flags, MerchantRef};

const FROM: &str = "wallets w JOIN merchants m ON m.id = w.merchant_id";

const COLUMNS: &[&str] = &[
    "w.id AS id",
    "w.merchant_id AS merchant_id",
    "w.currency::text AS currency",
    "w.status::text AS status",
    "w.gl_account_id AS gl_account_id",
    "w.created_at AS created_at",
    "m.id AS m_id",
    "m.legal_name AS m_legal_name",
    "m.trade_name AS m_trade_name",
    "(SELECT count(*) FROM applications a WHERE a.assigned_wallet_id = w.id) AS application_count",
    "(SELECT count(*) FROM payment_links l WHERE l.wallet_id = w.id) AS payment_link_count",
];

const WALLET_STATUSES: &[&str] = &["PENDING", "ACTIVE", "FROZEN", "CLOSED"];

struct WalletRow {
    id: String,
    merchant_id: String,
    currency: String,
    status: String,
    gl_account_id: String,
    created_at: NaiveDateTime,
    merchant: MerchantRef,
    application_count: i64,
    payment_link_count: i64,
}

impl WalletRow {
    fn from_row(row: &sqlx::postgres::PgRow) -> Result<Self, ApiError> {
        Ok(Self {
            id: common::uuid_text(row, "id")?,
            merchant_id: common::uuid_text(row, "merchant_id")?,
            currency: common::text(row, "currency")?,
            status: common::text(row, "status")?,
            gl_account_id: common::uuid_text(row, "gl_account_id")?,
            created_at: common::naive(row, "created_at")?,
            merchant: MerchantRef::from_row(row, "m_id", "m_legal_name", "m_trade_name")?,
            application_count: common::i64_of(row, "application_count")?,
            payment_link_count: common::i64_of(row, "payment_link_count")?,
        })
    }

    /// `serializeWalletRow`.
    fn to_json(
        &self,
        flags: &Flags,
        live_balance: Option<Decimal>,
        pending_cashouts: i64,
        stored_checkpoint: Option<Decimal>,
    ) -> Value {
        let mut out = Map::new();
        out.insert("id".to_owned(), Value::String(self.id.clone()));
        out.insert(
            "merchantId".to_owned(),
            Value::String(self.merchant_id.clone()),
        );
        out.insert("merchant".to_owned(), self.merchant.to_json());
        out.insert("currency".to_owned(), Value::String(self.currency.clone()));
        out.insert("status".to_owned(), Value::String(self.status.clone()));
        out.insert(
            "glAccountId".to_owned(),
            Value::String(self.gl_account_id.clone()),
        );
        out.insert(
            "liveBalance".to_owned(),
            if flags.can_financial {
                common::money4_zero(live_balance)
            } else {
                Value::Null
            },
        );
        out.insert(
            "checkpointBalance".to_owned(),
            if flags.can_financial {
                Value::String(wallet_natural_balance(
                    stored_checkpoint.unwrap_or_default(),
                ))
            } else {
                Value::Null
            },
        );
        out.insert(
            "applicationCount".to_owned(),
            Value::from(self.application_count),
        );
        out.insert(
            "paymentLinkCount".to_owned(),
            Value::from(self.payment_link_count),
        );
        out.insert(
            "pendingCashoutCount".to_owned(),
            Value::from(pending_cashouts),
        );
        out.insert(
            "createdAt".to_owned(),
            Value::String(common::iso_naive(self.created_at)),
        );
        out.insert(
            "redactedFields".to_owned(),
            if flags.can_financial {
                Value::Array(Vec::new())
            } else {
                json!(["liveBalance", "checkpointBalance"])
            },
        );
        Value::Object(out)
    }
}

fn columns() -> ColumnMap {
    ColumnMap::new()
        .with("id", "w.id", ColumnKind::Uuid)
        .with("glAccountId", "w.gl_account_id::text", ColumnKind::Text)
        .with("merchant.legalName", "m.legal_name", ColumnKind::Text)
        .with("merchant.tradeName", "m.trade_name", ColumnKind::Text)
        .with("statusFilter", "w.status::text", ColumnKind::Text)
        .with("status", "w.status", ColumnKind::Text)
        .with("currency", "w.currency::text", ColumnKind::Text)
        .with("merchantId", "w.merchant_id", ColumnKind::Uuid)
        .with("createdAt", "w.created_at", ColumnKind::Timestamp)
        .with("updatedAt", "w.updated_at", ColumnKind::Timestamp)
}

fn spec() -> ListSpec {
    ListSpec::default()
        .with_search(&[
            "id",
            "glAccountId",
            "merchant.legalName",
            "merchant.tradeName",
        ])
        .with_in("status", "statusFilter")
        .with_in("currency", "currency")
        .with_equals("merchantId", "merchantId")
        .with_date(DateFilter::new("createdAt", "createdAt"))
        .with_sortable("currency", "currency")
        .with_sortable("status", "status")
        .with_sortable("createdAt", "createdAt")
        .with_default_sort("createdAt", SortDirection::Desc)
        .with_default_page_size(25.0)
}

/// The DEBIT_POSITIVE list of `InvariantVerifier.ts:41` (every other account is credit-natural).
fn debit_positive(account_type: &str) -> bool {
    matches!(
        account_type,
        "TREASURY"
            | "GATEWAY_CLEARING"
            | "COMMISSION_RECEIVABLE"
            | "PROVIDER_FEE_EXPENSE"
            | "GATEWAY_FEE_EXPENSE"
    )
}

/// `walletNaturalBalance`: stored debit-positive sum → natural (credit-positive) sign.
#[must_use]
pub fn wallet_natural_balance(stored_debit_positive: Decimal) -> String {
    let natural = if stored_debit_positive.is_zero() {
        Decimal::ZERO
    } else {
        -stored_debit_positive
    };
    pg_types::Money4(natural).to_string()
}

/// `loadLiveAccountBalances`, keyed by account id, natural sign.
async fn live_balances(
    pool: &PgPool,
    account_ids: &[String],
) -> Result<BTreeMap<String, Decimal>, ApiError> {
    let mut map = BTreeMap::new();
    if account_ids.is_empty() {
        return Ok(map);
    }
    let rows = sqlx::query(
        "SELECT g.id AS id, g.account_type::text AS account_type, \
         COALESCE(s.total, 0) AS total \
         FROM gl_accounts g LEFT JOIN ( \
             SELECT gl_account_id, sum(current_balance) AS total \
             FROM gl_account_shards WHERE gl_account_id = ANY($1::uuid[]) \
             GROUP BY gl_account_id \
         ) s ON s.gl_account_id = g.id \
         WHERE g.id = ANY($1::uuid[])",
    )
    .bind(common::uuid_values(account_ids))
    .fetch_all(pool)
    .await
    .map_err(common::database_error)?;
    for row in &rows {
        let account_type = common::text(row, "account_type")?;
        let stored: Decimal = common::decimal(row, "total")?;
        let natural = if debit_positive(&account_type) {
            stored
        } else {
            -stored
        };
        map.insert(common::uuid_text(row, "id")?, natural);
    }
    Ok(map)
}

struct CheckpointSummary {
    checkpoint_balance: Decimal,
    checkpoint_at: Option<chrono::DateTime<chrono::Utc>>,
    pending_lines: String,
}

/// `loadAccountCheckpointSummary`: sum of the shard checkpoints (debit-positive).
async fn checkpoint_summaries(
    pool: &PgPool,
    account_ids: &[String],
) -> Result<BTreeMap<String, CheckpointSummary>, ApiError> {
    let mut map = BTreeMap::new();
    if account_ids.is_empty() {
        return Ok(map);
    }
    let rows = sqlx::query(
        "SELECT s.gl_account_id AS id, \
         COALESCE(sum(c.checkpoint_balance), 0) AS checkpoint_balance, \
         min(c.checkpoint_at) AS checkpoint_at, \
         COALESCE(sum(s.line_seq - COALESCE(c.checkpoint_seq, 0)), 0)::text AS pending_lines \
         FROM gl_account_shards s \
         LEFT JOIN gl_shard_checkpoints c \
           ON c.gl_account_id = s.gl_account_id AND c.shard_id = s.shard_id \
         WHERE s.gl_account_id = ANY($1::uuid[]) \
         GROUP BY s.gl_account_id",
    )
    .bind(common::uuid_values(account_ids))
    .fetch_all(pool)
    .await
    .map_err(common::database_error)?;
    for row in &rows {
        map.insert(
            common::uuid_text(row, "id")?,
            CheckpointSummary {
                checkpoint_balance: common::decimal(row, "checkpoint_balance")?,
                checkpoint_at: common::opt_timestamptz(row, "checkpoint_at")?,
                pending_lines: common::text(row, "pending_lines")?,
            },
        );
    }
    Ok(map)
}

async fn pending_cashout_counts(
    pool: &PgPool,
    wallet_ids: &[String],
) -> Result<BTreeMap<String, i64>, ApiError> {
    let mut map = BTreeMap::new();
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

/// `GET /internal/admin/wallets`.
pub async fn list(
    pool: &PgPool,
    principal: Option<&Principal>,
    query_string: &str,
) -> Result<Value, ApiError> {
    let query = common::parse_query(query_string);
    let flags = common::flags(principal);
    common::assert_enum_filter(&query, "status", WALLET_STATUSES)?;
    common::assert_uuid_filter(&query, "merchantId")?;
    let built = build_list_query(&query, &spec(), &columns()).map_err(common::list_error)?;

    let sql = built.select_sql(FROM, COLUMNS);
    let rows = built
        .bind_rows(&sql)
        .fetch_all(pool)
        .await
        .map_err(common::database_error)?;
    let total = count_unless_skipped(&built, FROM, pool)
        .await
        .map_err(common::list_error)?;

    let wallets: Vec<WalletRow> = rows
        .iter()
        .map(WalletRow::from_row)
        .collect::<Result<_, _>>()?;
    let wallet_ids: Vec<String> = wallets.iter().map(|wallet| wallet.id.clone()).collect();
    let account_ids: Vec<String> = wallets
        .iter()
        .map(|wallet| wallet.gl_account_id.clone())
        .collect();
    let pending = pending_cashout_counts(pool, &wallet_ids).await?;
    let (live, checkpoints) = if flags.can_financial {
        (
            live_balances(pool, &account_ids).await?,
            checkpoint_summaries(pool, &account_ids).await?,
        )
    } else {
        (BTreeMap::new(), BTreeMap::new())
    };

    let mut output = Vec::with_capacity(wallets.len());
    let mut cursor_rows: Vec<Vec<pg_db::CursorValue>> = Vec::new();
    for wallet in &wallets {
        let checkpoint = checkpoints.get(&wallet.gl_account_id);
        output.push(wallet.to_json(
            &flags,
            live.get(&wallet.gl_account_id).copied(),
            pending.get(&wallet.id).copied().unwrap_or(0),
            checkpoint.map(|summary| summary.checkpoint_balance),
        ));
        if let Some(plan) = &built.keyset {
            let values = common::cursor_values(plan, wallet.created_at, None, &wallet.id);
            if values.len() == plan.fields.len() {
                cursor_rows.push(values);
            }
        }
    }

    Ok(pg_db::list_response(
        "wallets",
        Value::Array(output),
        total,
        &built,
        &cursor_rows,
    ))
}

/// `GET /internal/admin/wallets/:id`.
pub async fn detail(
    pool: &PgPool,
    principal: Option<&Principal>,
    id: &str,
) -> Result<Value, ApiError> {
    let wallet_id = parse_uuid(id)?;
    let flags = common::flags(principal);

    let sql = format!("SELECT {} FROM {FROM} WHERE w.id = $1", COLUMNS.join(", "));
    let row = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()))
        .bind(wallet_id)
        .fetch_optional(pool)
        .await
        .map_err(common::database_error)?
        .ok_or_else(|| ApiError::new(404, "WALLET_NOT_FOUND", "The wallet does not exist"))?;
    let wallet = WalletRow::from_row(&row)?;

    let gl_row = sqlx::query(
        "SELECT id, account_type::text AS account_type, currency::text AS currency, \
         shard_count::int AS shard_count, shard_scaled_at \
         FROM gl_accounts WHERE id = $1",
    )
    .bind(
        Uuid::parse_str(&wallet.gl_account_id)
            .map_err(|_| ApiError::new(404, "WALLET_NOT_FOUND", "The wallet does not exist"))?,
    )
    .fetch_optional(pool)
    .await
    .map_err(common::database_error)?
    .ok_or_else(|| ApiError::new(404, "WALLET_NOT_FOUND", "The wallet does not exist"))?;

    let pending = pending_cashout_counts(pool, std::slice::from_ref(&wallet.id)).await?;
    let account_ids = vec![wallet.gl_account_id.clone()];
    let (live, checkpoints) = if flags.can_financial {
        (
            live_balances(pool, &account_ids).await?,
            checkpoint_summaries(pool, &account_ids).await?,
        )
    } else {
        (BTreeMap::new(), BTreeMap::new())
    };
    let checkpoint = checkpoints.get(&wallet.gl_account_id);

    let mut base = match wallet.to_json(
        &flags,
        live.get(&wallet.gl_account_id).copied(),
        pending.get(&wallet.id).copied().unwrap_or(0),
        checkpoint.map(|summary| summary.checkpoint_balance),
    ) {
        Value::Object(map) => map,
        _ => Map::new(),
    };

    base.insert(
        "glAccount".to_owned(),
        json!({
            "id": common::uuid_text(&gl_row, "id")?,
            "accountType": common::text(&gl_row, "account_type")?,
            "currency": common::text(&gl_row, "currency")?,
            "checkpointBalance": if flags.can_financial {
                Value::String(wallet_natural_balance(
                    checkpoint.map(|summary| summary.checkpoint_balance).unwrap_or_default(),
                ))
            } else {
                Value::Null
            },
            "checkpointAt": if flags.can_financial {
                common::iso_utc_value(checkpoint.and_then(|summary| summary.checkpoint_at))
            } else {
                Value::Null
            },
            "shardCount": common::i32_of(&gl_row, "shard_count")?,
            "shardScaledAt": common::iso_utc_value(common::opt_timestamptz(&gl_row, "shard_scaled_at")?),
            "pendingLines": if flags.can_financial {
                checkpoint.map_or(Value::String("0".to_owned()), |summary| {
                    Value::String(summary.pending_lines.clone())
                })
            } else {
                Value::Null
            },
        }),
    );

    let shards = if flags.can_financial {
        load_shards(pool, &wallet.gl_account_id).await?
    } else {
        Vec::new()
    };
    base.insert("shards".to_owned(), Value::Array(shards));
    base.insert(
        "applications".to_owned(),
        Value::Array(load_applications(pool, wallet_id).await?),
    );
    let cashouts = if flags.can_financial {
        load_cashouts(pool, wallet_id, &wallet.currency).await?
    } else {
        Vec::new()
    };
    base.insert("cashouts".to_owned(), Value::Array(cashouts));
    base.insert(
        "pendingApprovals".to_owned(),
        Value::Array(load_pending_approvals(pool, &wallet.id).await?),
    );
    base.insert(
        "redactedFields".to_owned(),
        if flags.can_financial {
            Value::Array(Vec::new())
        } else {
            json!([
                "liveBalance",
                "checkpointBalance",
                "shards",
                "cashouts",
                "statementLines"
            ])
        },
    );

    Ok(json!({ "wallet": Value::Object(base) }))
}

/// `merchantWalletBalance` (`lib/merchantOps.ts:189`), used by the merchant detail page.
pub async fn merchant_wallet_balance(pool: &PgPool, merchant_id: &str) -> Result<Value, ApiError> {
    let merchant_id = Uuid::parse_str(merchant_id)
        .map_err(|_| ApiError::new(404, "MERCHANT_NOT_FOUND", "The merchant does not exist"))?;
    let rows = sqlx::query(
        "SELECT id, currency::text AS currency, status::text AS status, gl_account_id \
         FROM wallets WHERE merchant_id = $1 ORDER BY created_at ASC",
    )
    .bind(merchant_id)
    .fetch_all(pool)
    .await
    .map_err(common::database_error)?;
    if rows.is_empty() {
        return Ok(json!({ "balance": "0.0000", "byCurrency": [], "wallets": [] }));
    }

    let mut wallets: Vec<(String, String, String, String, String)> = Vec::with_capacity(rows.len());
    let mut account_ids = Vec::with_capacity(rows.len());
    for row in &rows {
        let id = common::uuid_text(row, "id")?;
        let currency = common::text(row, "currency")?;
        let status = common::text(row, "status")?;
        let gl_account = common::uuid_text(row, "gl_account_id")?;
        account_ids.push(gl_account.clone());
        wallets.push((id.clone(), id, currency, status, gl_account));
    }
    let live = live_balances(pool, &account_ids).await?;

    let mut total = Decimal::ZERO;
    let mut by_currency: Vec<(String, Decimal)> = Vec::new();
    let mut wallet_rows = Vec::with_capacity(wallets.len());
    for (id, wallet_id, currency, status, gl_account) in &wallets {
        let balance = live.get(gl_account).copied().unwrap_or_default();
        total += balance;
        match by_currency.iter_mut().find(|(code, _)| code == currency) {
            Some((_, sum)) => *sum += balance,
            None => by_currency.push((currency.clone(), balance)),
        }
        wallet_rows.push(json!({
            "id": id,
            "walletId": wallet_id,
            "currency": currency,
            "status": status,
            "balance": pg_types::Money4(balance).to_string(),
        }));
    }

    Ok(json!({
        "balance": pg_types::Money4(total).to_string(),
        "byCurrency": by_currency
            .into_iter()
            .map(|(currency, balance)| json!({
                "currency": currency,
                "balance": pg_types::Money4(balance).to_string(),
            }))
            .collect::<Vec<_>>(),
        "wallets": wallet_rows,
    }))
}

async fn load_shards(pool: &PgPool, gl_account_id: &str) -> Result<Vec<Value>, ApiError> {
    let rows = sqlx::query(
        "SELECT s.shard_id::int AS shard_id, s.current_balance, s.line_seq, s.updated_at, \
         COALESCE(c.checkpoint_seq, 0) AS checkpoint_seq, c.checkpoint_at \
         FROM gl_account_shards s \
         LEFT JOIN gl_shard_checkpoints c \
           ON c.gl_account_id = s.gl_account_id AND c.shard_id = s.shard_id \
         WHERE s.gl_account_id = $1::uuid ORDER BY s.shard_id ASC",
    )
    .bind(gl_account_id)
    .fetch_all(pool)
    .await
    .map_err(common::database_error)?;
    rows.iter()
        .map(|row| {
            let line_seq = common::i64_of(row, "line_seq")?;
            let checkpoint_seq = common::i64_of(row, "checkpoint_seq")?;
            Ok(json!({
                "shardId": common::i32_of(row, "shard_id")?,
                "currentBalance": common::money4_zero(Some(common::decimal(row, "current_balance")?)),
                "lineSeq": line_seq.to_string(),
                "checkpointSeq": checkpoint_seq.to_string(),
                "checkpointAt": common::iso_utc_value(common::opt_timestamptz(row, "checkpoint_at")?),
                "pendingLines": (line_seq - checkpoint_seq).to_string(),
                "updatedAt": common::iso_utc(common::timestamptz(row, "updated_at")?),
            }))
        })
        .collect()
}

async fn load_applications(pool: &PgPool, wallet_id: Uuid) -> Result<Vec<Value>, ApiError> {
    let rows = sqlx::query(
        "SELECT id, name, status::text AS status FROM applications \
         WHERE assigned_wallet_id = $1 ORDER BY created_at DESC LIMIT 50",
    )
    .bind(wallet_id)
    .fetch_all(pool)
    .await
    .map_err(common::database_error)?;
    rows.iter()
        .map(|row| {
            Ok(json!({
                "id": common::uuid_text(row, "id")?,
                "name": common::text(row, "name")?,
                "status": common::text(row, "status")?,
            }))
        })
        .collect()
}

async fn load_cashouts(
    pool: &PgPool,
    wallet_id: Uuid,
    currency: &str,
) -> Result<Vec<Value>, ApiError> {
    let rows = sqlx::query(
        "SELECT id, state::text AS state, amount, created_at FROM cashout_requests \
         WHERE wallet_id = $1 ORDER BY created_at DESC LIMIT 10",
    )
    .bind(wallet_id)
    .fetch_all(pool)
    .await
    .map_err(common::database_error)?;
    rows.iter()
        .map(|row| {
            Ok(json!({
                "id": common::uuid_text(row, "id")?,
                "state": common::text(row, "state")?,
                "amount": common::money4_zero(Some(common::decimal(row, "amount")?)),
                "currency": currency,
                "createdAt": common::iso_naive(common::naive(row, "created_at")?),
            }))
        })
        .collect()
}

async fn load_pending_approvals(pool: &PgPool, wallet_id: &str) -> Result<Vec<Value>, ApiError> {
    let variants = common::subject_variants("WALLET");
    let rows = sqlx::query(
        "SELECT id, state::text AS state, payload_diff_json, maker_reason, created_at \
         FROM approval_requests WHERE subject_type = ANY($1::text[]) AND subject_id = $2 \
         AND state::text IN ('DRAFT', 'PENDING_REVIEW') ORDER BY created_at DESC LIMIT 10",
    )
    .bind(&variants)
    .bind(wallet_id)
    .fetch_all(pool)
    .await
    .map_err(common::database_error)?;
    rows.iter()
        .map(|row| {
            Ok(json!({
                "id": common::uuid_text(row, "id")?,
                "state": common::text(row, "state")?,
                "payloadDiffJson": common::json_value(row, "payload_diff_json")?,
                "makerReason": common::opt_text(row, "maker_reason")?,
                "createdAt": common::iso_naive(common::naive(row, "created_at")?),
            }))
        })
        .collect()
}

fn parse_uuid(raw: &str) -> Result<Uuid, ApiError> {
    Uuid::parse_str(raw).map_err(|_| {
        ApiError::new(400, "INVALID_BODY", "Invalid request data").with_details(
            json!([{ "path": ["id"], "code": "invalid_string", "message": "must be a UUID" }]),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn natural_balance_inverts_the_stored_credit_liability() {
        assert_eq!(wallet_natural_balance(Decimal::new(-250_000, 4)), "25.0000");
        assert_eq!(wallet_natural_balance(Decimal::new(250_000, 4)), "-25.0000");
        assert_eq!(wallet_natural_balance(Decimal::ZERO), "0.0000");
    }

    #[test]
    fn wallet_filters_use_the_enum_text_cast() {
        let columns = columns();
        assert_eq!(
            columns
                .get("statusFilter")
                .map(|column| column.sql.as_str()),
            Some("w.status::text")
        );
        assert_eq!(
            columns.get("status").map(|column| column.sql.as_str()),
            Some("w.status")
        );
        assert_eq!(spec().default_page_size, Some(25.0));
    }
}

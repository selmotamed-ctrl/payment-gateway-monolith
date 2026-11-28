//! Catalogue reads: payment links, POS terminals, API access tokens and brand assets.
//!
//! Port of `core-back/api/internal/adminCommerce.ts:1242` (`/payment-links`), `:1359`
//! (`/pos-terminals`), `:1137` (`/access-tokens`) and `core-back/api/internal/admin.ts:16841`
//! (`/assets`, `/assets/:id`).
//!
//! None of these resources has a detail GET in TS; the list row is the complete serialised object
//! and the application detail embeds the same shapes.

#![forbid(unsafe_code)]

use pg_db::{
    build_list_query, count_unless_skipped, ColumnKind, ColumnMap, DateFilter, ListSpec,
    RangeFilter, RangeKind, SortDirection,
};
use pg_domain_auth::Principal;
use pg_http::ApiError;
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use super::common;
use super::models::{
    AssetRow, PaymentLinkRow, PosTerminalRow, TokenRow, ACCESS_TOKEN_COLUMNS, ASSET_COLUMNS,
    PAYMENT_LINK_COLUMNS, PAYMENT_LINK_FROM, POS_TERMINAL_COLUMNS, POS_TERMINAL_FROM,
};

const PAYMENT_LINK_STATES: &[&str] = &["PENDING", "COMPLETED", "EXPIRED", "CANCELLED"];
const POS_STATUSES: &[&str] = &["ACTIVE", "INACTIVE", "BLOCKED"];
const ACCESS_TOKEN_STATUSES: &[&str] = &["ACTIVE", "REVOKED", "EXPIRED"];
const TOKEN_ENVIRONMENTS: &[&str] = &["LIVE", "SANDBOX"];

const TOKEN_FROM: &str = "access_tokens t \
     JOIN applications ap ON ap.id = t.application_id \
     JOIN merchants m ON m.id = t.merchant_id";

// ---------------------------------------------------------------- payment links

fn payment_link_columns() -> ColumnMap {
    ColumnMap::new()
        .with("key", "l.key", ColumnKind::Text)
        .with("stateFilter", "l.state::text", ColumnKind::Text)
        .with("state", "l.state", ColumnKind::Text)
        .with("currency", "l.currency::text", ColumnKind::Text)
        .with("merchantId", "a.merchant_id", ColumnKind::Uuid)
        .with("applicationId", "l.application_id", ColumnKind::Uuid)
        .with("walletId", "l.wallet_id", ColumnKind::Uuid)
        .with("createdAt", "l.created_at", ColumnKind::Timestamp)
        .with("updatedAt", "l.updated_at", ColumnKind::Timestamp)
        .with("amount", "l.amount", ColumnKind::Decimal)
        .with("expiresAt", "l.expires_at", ColumnKind::Timestamp)
        .with("id", "l.id", ColumnKind::Uuid)
}

fn payment_link_spec() -> ListSpec {
    ListSpec::default()
        .with_search(&["key"])
        .with_in("state", "stateFilter")
        .with_in("currency", "currency")
        .with_equals("merchantId", "merchantId")
        .with_equals("applicationId", "applicationId")
        .with_equals("walletId", "walletId")
        .with_date(DateFilter::new("createdAt", "createdAt"))
        .with_range(RangeFilter::new("amount", "amount", RangeKind::Decimal))
        .with_sortable("createdAt", "createdAt")
        .with_sortable("amount", "amount")
        .with_sortable("state", "state")
        .with_sortable("expiresAt", "expiresAt")
        .with_default_sort("createdAt", SortDirection::Desc)
        .with_default_page_size(25.0)
}

/// `GET /internal/admin/payment-links`.
pub async fn payment_links(
    pool: &PgPool,
    _principal: Option<&Principal>,
    query_string: &str,
) -> Result<Value, ApiError> {
    let query = common::parse_query(query_string);
    common::assert_enum_filter(&query, "state", PAYMENT_LINK_STATES)?;
    common::assert_uuid_filter(&query, "merchantId")?;
    common::assert_uuid_filter(&query, "applicationId")?;
    common::assert_uuid_filter(&query, "walletId")?;
    let built = build_list_query(&query, &payment_link_spec(), &payment_link_columns())
        .map_err(common::list_error)?;
    let sql = built.select_sql(PAYMENT_LINK_FROM, PAYMENT_LINK_COLUMNS);
    let rows = built
        .bind_rows(&sql)
        .fetch_all(pool)
        .await
        .map_err(common::database_error)?;
    let total = count_unless_skipped(&built, PAYMENT_LINK_FROM, pool)
        .await
        .map_err(common::list_error)?;

    let mut output = Vec::with_capacity(rows.len());
    let mut cursor_rows: Vec<Vec<pg_db::CursorValue>> = Vec::new();
    for row in &rows {
        let link = PaymentLinkRow::from_row(row)?;
        output.push(link.to_json());
        if let Some(plan) = &built.keyset {
            let values = common::cursor_values(plan, link.created_at, None, &link.id);
            if values.len() == plan.fields.len() {
                cursor_rows.push(values);
            }
        }
    }
    Ok(pg_db::list_response(
        "paymentLinks",
        Value::Array(output),
        total,
        &built,
        &cursor_rows,
    ))
}

// ---------------------------------------------------------------- POS terminals

fn pos_columns() -> ColumnMap {
    ColumnMap::new()
        .with("name", "p.name", ColumnKind::Text)
        .with("location", "p.location", ColumnKind::Text)
        .with("id", "p.id::text", ColumnKind::Text)
        .with("application.name", "a.name", ColumnKind::Text)
        .with("statusFilter", "p.status::text", ColumnKind::Text)
        .with("status", "p.status", ColumnKind::Text)
        .with("merchantId", "a.merchant_id", ColumnKind::Uuid)
        .with("applicationId", "p.application_id", ColumnKind::Uuid)
        .with("createdAt", "p.created_at", ColumnKind::Timestamp)
        .with("updatedAt", "p.updated_at", ColumnKind::Timestamp)
}

fn pos_spec() -> ListSpec {
    ListSpec::default()
        .with_search(&["name", "location", "id", "application.name"])
        .with_in("status", "statusFilter")
        .with_equals("merchantId", "merchantId")
        .with_equals("applicationId", "applicationId")
        .with_date(DateFilter::new("createdAt", "createdAt"))
        .with_sortable("name", "name")
        .with_sortable("status", "status")
        .with_sortable("createdAt", "createdAt")
        .with_default_sort("createdAt", SortDirection::Desc)
        .with_default_page_size(25.0)
}

/// `GET /internal/admin/pos-terminals`.
pub async fn pos_terminals(
    pool: &PgPool,
    _principal: Option<&Principal>,
    query_string: &str,
) -> Result<Value, ApiError> {
    let query = common::parse_query(query_string);
    common::assert_enum_filter(&query, "status", POS_STATUSES)?;
    common::assert_uuid_filter(&query, "merchantId")?;
    common::assert_uuid_filter(&query, "applicationId")?;
    let built =
        build_list_query(&query, &pos_spec(), &pos_columns()).map_err(common::list_error)?;
    let sql = built.select_sql(POS_TERMINAL_FROM, POS_TERMINAL_COLUMNS);
    let rows = built
        .bind_rows(&sql)
        .fetch_all(pool)
        .await
        .map_err(common::database_error)?;
    let total = count_unless_skipped(&built, POS_TERMINAL_FROM, pool)
        .await
        .map_err(common::list_error)?;

    let mut output = Vec::with_capacity(rows.len());
    let mut cursor_rows: Vec<Vec<pg_db::CursorValue>> = Vec::new();
    for row in &rows {
        let terminal = PosTerminalRow::from_row(row)?;
        output.push(terminal.to_json());
        if let Some(plan) = &built.keyset {
            let values = common::cursor_values(plan, terminal.created_at, None, &terminal.id);
            if values.len() == plan.fields.len() {
                cursor_rows.push(values);
            }
        }
    }
    Ok(pg_db::list_response(
        "posTerminals",
        Value::Array(output),
        total,
        &built,
        &cursor_rows,
    ))
}

// ---------------------------------------------------------------- access tokens

fn token_columns() -> ColumnMap {
    ColumnMap::new()
        .with("name", "t.name", ColumnKind::Text)
        .with("lastFour", "t.last_four", ColumnKind::Text)
        .with("application.name", "ap.name", ColumnKind::Text)
        .with("merchant.legalName", "m.legal_name", ColumnKind::Text)
        .with("merchant.tradeName", "m.trade_name", ColumnKind::Text)
        .with("applicationId", "t.application_id", ColumnKind::Uuid)
        .with("merchantId", "t.merchant_id", ColumnKind::Uuid)
        .with("envFilter", "t.env::text", ColumnKind::Text)
        .with(
            "ipWhitelistEnabled",
            "t.ip_whitelist_enabled",
            ColumnKind::Bool,
        )
        .with("createdAt", "t.created_at", ColumnKind::Timestamp)
        .with("updatedAt", "t.updated_at", ColumnKind::Timestamp)
        .with("lastUsedAt", "t.last_used_at", ColumnKind::Timestamp)
        .with("expiresAt", "t.expires_at", ColumnKind::Timestamp)
        .with("id", "t.id", ColumnKind::Uuid)
}

fn token_spec() -> ListSpec {
    ListSpec::default()
        .with_search(&[
            "name",
            "lastFour",
            "application.name",
            "merchant.legalName",
            "merchant.tradeName",
        ])
        .with_equals("applicationId", "applicationId")
        .with_equals("merchantId", "merchantId")
        .with_in("env", "envFilter")
        .with_boolean("ipWhitelistEnabled", "ipWhitelistEnabled")
        .with_date(DateFilter::new("createdAt", "createdAt"))
        .with_date(DateFilter::new("lastUsedAt", "lastUsedAt"))
        .with_date(DateFilter::new("expiresAt", "expiresAt"))
        .with_sortable("name", "name")
        .with_sortable("lastFour", "lastFour")
        .with_sortable("createdAt", "createdAt")
        .with_sortable("lastUsedAt", "lastUsedAt")
        .with_sortable("expiresAt", "expiresAt")
        .with_default_sort("createdAt", SortDirection::Desc)
        .with_default_page_size(25.0)
}

/// `accessTokenStatusWhere` as an appended SQL clause.
fn access_token_status_clause(query: &serde_json::Map<String, Value>) -> Option<String> {
    let statuses = pg_db::list_query::csv(common::query_raw(query, "status"));
    if statuses.is_empty() {
        return None;
    }
    let clauses: Vec<String> = statuses
        .iter()
        .map(|status| match status.as_str() {
            "REVOKED" => "t.revoked_at IS NOT NULL".to_owned(),
            "EXPIRED" => {
                "t.revoked_at IS NULL AND t.expires_at IS NOT NULL AND t.expires_at <= now()"
                    .to_owned()
            }
            _ => {
                "t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())".to_owned()
            }
        })
        .collect();
    if clauses.len() == 1 {
        Some(clauses[0].clone())
    } else {
        Some(format!("({})", clauses.join(" OR ")))
    }
}

/// `GET /internal/admin/access-tokens`.
pub async fn access_tokens(
    pool: &PgPool,
    _principal: Option<&Principal>,
    query_string: &str,
) -> Result<Value, ApiError> {
    let query = common::parse_query(query_string);
    common::assert_enum_filter(&query, "status", ACCESS_TOKEN_STATUSES)?;
    common::assert_enum_filter(&query, "env", TOKEN_ENVIRONMENTS)?;
    common::assert_uuid_filter(&query, "applicationId")?;
    common::assert_uuid_filter(&query, "merchantId")?;
    if let Some(raw) = common::query_raw(&query, "ipWhitelistEnabled") {
        if !raw.is_empty() && raw != "true" && raw != "false" {
            return Err(ApiError::new(
                400,
                "INVALID_FILTER",
                "ipWhitelistEnabled must be true or false",
            ));
        }
    }
    let mut built =
        build_list_query(&query, &token_spec(), &token_columns()).map_err(common::list_error)?;
    if let Some(clause) = access_token_status_clause(&query) {
        common::add_condition(&mut built, &clause);
    }

    let sql = built.select_sql(TOKEN_FROM, ACCESS_TOKEN_COLUMNS);
    let rows = built
        .bind_rows(&sql)
        .fetch_all(pool)
        .await
        .map_err(common::database_error)?;
    let total = count_unless_skipped(&built, TOKEN_FROM, pool)
        .await
        .map_err(common::list_error)?;

    let mut tokens: Vec<TokenRow> = rows
        .iter()
        .map(TokenRow::from_row)
        .collect::<Result<_, _>>()?;
    let ids: Vec<String> = tokens.iter().map(|token| token.id.clone()).collect();
    let cidrs = super::applications::load_token_ips(pool, &ids).await?;
    for token in &mut tokens {
        if let Some(values) = cidrs.get(&token.id) {
            token.cidrs = values.clone();
        }
    }

    let now = chrono::Utc::now().naive_utc();
    let mut output = Vec::with_capacity(tokens.len());
    let mut cursor_rows: Vec<Vec<pg_db::CursorValue>> = Vec::new();
    for token in &tokens {
        output.push(token.to_json(now));
    }
    if let Some(plan) = &built.keyset {
        for token in &tokens {
            let values = common::cursor_values(plan, token.created_at, None, &token.id);
            if values.len() == plan.fields.len() {
                cursor_rows.push(values);
            }
        }
    }

    Ok(pg_db::list_response(
        "accessTokens",
        Value::Array(output),
        total,
        &built,
        &cursor_rows,
    ))
}

// ---------------------------------------------------------------- assets

/// `GET /internal/admin/assets`: the whole table ordered by name (`admin.ts:16841`).
pub async fn assets(pool: &PgPool) -> Result<Value, ApiError> {
    let sql = format!(
        "SELECT {} FROM assets ORDER BY name ASC",
        ASSET_COLUMNS.join(", ")
    );
    let rows = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()))
        .fetch_all(pool)
        .await
        .map_err(common::database_error)?;
    let mut output = Vec::with_capacity(rows.len());
    for row in &rows {
        output.push(AssetRow::from_row(row)?.to_json());
    }
    Ok(json!({ "assets": output }))
}

/// `GET /internal/admin/assets/:id`.
pub async fn asset_detail(pool: &PgPool, id: &str) -> Result<Value, ApiError> {
    let asset_id = Uuid::parse_str(id)
        .map_err(|_| ApiError::new(404, "ASSET_NOT_FOUND", "The asset does not exist"))?;
    let sql = format!(
        "SELECT {} FROM assets WHERE id = $1",
        ASSET_COLUMNS.join(", ")
    );
    let row = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()))
        .bind(asset_id)
        .fetch_optional(pool)
        .await
        .map_err(common::database_error)?
        .ok_or_else(|| ApiError::new(404, "ASSET_NOT_FOUND", "The asset does not exist"))?;
    Ok(json!({ "asset": AssetRow::from_row(&row)?.to_json() }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query(pairs: &[(&str, &str)]) -> serde_json::Map<String, Value> {
        let raw = pairs
            .iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect::<Vec<_>>()
            .join("&");
        common::parse_query(&raw)
    }

    #[test]
    fn token_status_filter_uses_the_computed_clauses() {
        assert_eq!(access_token_status_clause(&query(&[])), None);
        assert_eq!(
            access_token_status_clause(&query(&[("status", "REVOKED")])),
            Some("t.revoked_at IS NOT NULL".to_owned())
        );
        assert_eq!(
            access_token_status_clause(&query(&[("status", "REVOKED,ACTIVE")])),
            Some(
                "(t.revoked_at IS NOT NULL OR t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now()))"
                    .to_owned()
            )
        );
    }

    #[test]
    fn filters_and_sorts_are_declared() {
        assert_eq!(PAYMENT_LINK_STATES.len(), 4);
        assert_eq!(POS_STATUSES.len(), 3);
        assert_eq!(ACCESS_TOKEN_STATUSES.len(), 3);
        assert!(token_columns().contains("envFilter"));
        assert!(!token_columns().contains("env"));
        assert!(payment_link_columns().contains("stateFilter"));
        assert!(pos_columns().contains("application.name"));
    }
}

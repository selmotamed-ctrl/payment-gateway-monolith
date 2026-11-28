//! `GET /internal/admin/applications` and `GET /internal/admin/applications/:id`.
//!
//! Port of `core-back/api/internal/adminCommerce.ts:740` and `:827`, including
//! `applicationListSelect` (`:617`), the token/allowlist summary (`:646-731`) and
//! `serializeApplicationRow` (`:652`).
//!
//! The detail route reproduces a TS quirk on purpose: `tokenActiveCount` and friends are computed
//! from the first 100 tokens (the ones the detail embeds), while `accessTokenCount` is the full
//! relation count.

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
use super::models::{
    PaymentLinkRow, PosTerminalRow, TokenRow, ACCESS_TOKEN_BASE_COLUMNS,
    ACCESS_TOKEN_NULL_RELATIONS, PAYMENT_LINK_COLUMNS, PAYMENT_LINK_FROM, POS_TERMINAL_COLUMNS,
    POS_TERMINAL_FROM,
};

const FROM: &str = "applications a \
     JOIN merchants m ON m.id = a.merchant_id \
     LEFT JOIN wallets aw ON aw.id = a.assigned_wallet_id";

const COLUMNS: &[&str] = &[
    "a.id AS id",
    "a.name AS name",
    "a.merchant_id AS merchant_id",
    "a.status::text AS status",
    "a.assigned_wallet_id AS assigned_wallet_id",
    "a.expected_monthly_volume AS expected_monthly_volume",
    "a.rail_whitelist AS rail_whitelist",
    "a.redirect_domain_allowlist AS redirect_domain_allowlist",
    "a.created_at AS created_at",
    "a.updated_at AS updated_at",
    "m.id AS m_id",
    "m.legal_name AS m_legal_name",
    "m.trade_name AS m_trade_name",
    "aw.id AS aw_id",
    "aw.currency::text AS aw_currency",
    "aw.status::text AS aw_status",
    "(SELECT count(*) FROM access_tokens t WHERE t.application_id = a.id) AS access_token_count",
    "(SELECT count(*) FROM payment_links l WHERE l.application_id = a.id) AS payment_link_count",
    "(SELECT count(*) FROM pos_terminals p WHERE p.application_id = a.id) AS pos_terminal_count",
];

const APPLICATION_STATUSES: &[&str] = &["DRAFT", "PENDING", "ACTIVE", "SUSPENDED", "CLOSED"];

/// `ApplicationTokenStats` (`adminCommerce.ts:636`).
#[derive(Debug, Clone, Copy, Default)]
struct TokenStats {
    active: i64,
    revoked: i64,
    expired: i64,
    ip_restricted: i64,
    cidrs: i64,
}

struct ApplicationRow {
    id: String,
    name: String,
    merchant_id: String,
    status: String,
    assigned_wallet_id: String,
    expected_monthly_volume: Decimal,
    rail_whitelist: Option<Value>,
    redirect_domain_allowlist: Option<Value>,
    created_at: NaiveDateTime,
    updated_at: NaiveDateTime,
    merchant: MerchantRef,
    assigned_wallet: Option<(String, String, String)>,
    access_token_count: i64,
    payment_link_count: i64,
    pos_terminal_count: i64,
}

impl ApplicationRow {
    fn from_row(row: &sqlx::postgres::PgRow) -> Result<Self, ApiError> {
        let assigned_wallet = match common::opt_uuid_text(row, "aw_id")? {
            Some(id) => Some((
                id,
                common::opt_text(row, "aw_currency")?.unwrap_or_default(),
                common::opt_text(row, "aw_status")?.unwrap_or_default(),
            )),
            None => None,
        };
        Ok(Self {
            id: common::uuid_text(row, "id")?,
            name: common::text(row, "name")?,
            merchant_id: common::uuid_text(row, "merchant_id")?,
            status: common::text(row, "status")?,
            assigned_wallet_id: common::uuid_text(row, "assigned_wallet_id")?,
            expected_monthly_volume: common::decimal(row, "expected_monthly_volume")?,
            rail_whitelist: common::opt_json(row, "rail_whitelist")?,
            redirect_domain_allowlist: common::opt_json(row, "redirect_domain_allowlist")?,
            created_at: common::naive(row, "created_at")?,
            updated_at: common::naive(row, "updated_at")?,
            merchant: MerchantRef::from_row(row, "m_id", "m_legal_name", "m_trade_name")?,
            assigned_wallet,
            access_token_count: common::i64_of(row, "access_token_count")?,
            payment_link_count: common::i64_of(row, "payment_link_count")?,
            pos_terminal_count: common::i64_of(row, "pos_terminal_count")?,
        })
    }

    /// `serializeApplicationRow`.
    fn to_json(&self, flags: &Flags, token_stats: TokenStats) -> Value {
        let rail_whitelist = self.rail_whitelist.as_ref().and_then(common::string_list);
        let redirect_domains = self
            .redirect_domain_allowlist
            .as_ref()
            .and_then(common::string_list)
            .unwrap_or_default();
        let mut redacted: Vec<Value> = Vec::new();
        if flags.support {
            redacted.push(Value::String("expectedMonthlyVolume".to_owned()));
        }
        if !flags.can_sensitive {
            redacted.push(Value::String("redirectDomains".to_owned()));
        }

        let mut out = Map::new();
        out.insert("id".to_owned(), Value::String(self.id.clone()));
        out.insert("name".to_owned(), Value::String(self.name.clone()));
        out.insert(
            "merchantId".to_owned(),
            Value::String(self.merchant_id.clone()),
        );
        out.insert("merchant".to_owned(), self.merchant.to_json());
        out.insert("status".to_owned(), Value::String(self.status.clone()));
        out.insert(
            "assignedWalletId".to_owned(),
            Value::String(self.assigned_wallet_id.clone()),
        );
        out.insert(
            "assignedWallet".to_owned(),
            self.assigned_wallet.as_ref().map_or(Value::Null, |(id, currency, status)| {
                json!({ "id": id, "currency": currency, "status": status })
            }),
        );
        out.insert(
            "expectedMonthlyVolume".to_owned(),
            if flags.support {
                Value::Null
            } else {
                common::money4_zero(Some(self.expected_monthly_volume))
            },
        );
        out.insert(
            "railWhitelist".to_owned(),
            rail_whitelist.as_ref().map_or(Value::Null, |rails| {
                Value::Array(rails.iter().cloned().map(Value::String).collect())
            }),
        );
        out.insert(
            "railWhitelistMode".to_owned(),
            Value::String(
                match rail_whitelist.as_ref().map(Vec::len) {
                    None => "ALL",
                    Some(0) => "NONE",
                    Some(_) => "LIST",
                }
                .to_owned(),
            ),
        );
        out.insert(
            "railWhitelistCount".to_owned(),
            Value::from(rail_whitelist.as_ref().map_or(0, Vec::len)),
        );
        out.insert(
            "redirectDomains".to_owned(),
            if flags.can_sensitive {
                Value::Array(redirect_domains.into_iter().map(Value::String).collect())
            } else {
                Value::Array(Vec::new())
            },
        );
        out.insert(
            "accessTokenCount".to_owned(),
            Value::from(self.access_token_count),
        );
        out.insert(
            "tokenActiveCount".to_owned(),
            Value::from(token_stats.active),
        );
        out.insert(
            "tokenRevokedCount".to_owned(),
            Value::from(token_stats.revoked),
        );
        out.insert(
            "tokenExpiredCount".to_owned(),
            Value::from(token_stats.expired),
        );
        out.insert(
            "tokenIpRestrictedCount".to_owned(),
            Value::from(token_stats.ip_restricted),
        );
        out.insert("tokenCidrCount".to_owned(), Value::from(token_stats.cidrs));
        out.insert(
            "paymentLinkCount".to_owned(),
            Value::from(self.payment_link_count),
        );
        out.insert(
            "posTerminalCount".to_owned(),
            Value::from(self.pos_terminal_count),
        );
        out.insert(
            "createdAt".to_owned(),
            Value::String(common::iso_naive(self.created_at)),
        );
        out.insert(
            "updatedAt".to_owned(),
            Value::String(common::iso_naive(self.updated_at)),
        );
        out.insert("redactedFields".to_owned(), Value::Array(redacted));
        Value::Object(out)
    }
}

fn columns() -> ColumnMap {
    ColumnMap::new()
        .with("name", "a.name", ColumnKind::Text)
        .with("id", "a.id::text", ColumnKind::Text)
        .with("merchant.legalName", "m.legal_name", ColumnKind::Text)
        .with("merchant.tradeName", "m.trade_name", ColumnKind::Text)
        .with("statusFilter", "a.status::text", ColumnKind::Text)
        .with("status", "a.status", ColumnKind::Text)
        .with("merchantId", "a.merchant_id", ColumnKind::Uuid)
        .with("walletId", "a.assigned_wallet_id", ColumnKind::Uuid)
        .with("createdAt", "a.created_at", ColumnKind::Timestamp)
        .with("updatedAt", "a.updated_at", ColumnKind::Timestamp)
        .with(
            "expectedMonthlyVolume",
            "a.expected_monthly_volume",
            ColumnKind::Decimal,
        )
}

fn spec() -> ListSpec {
    ListSpec::default()
        .with_search(&["name", "id", "merchant.legalName", "merchant.tradeName"])
        .with_in("status", "statusFilter")
        .with_equals("merchantId", "merchantId")
        .with_equals("walletId", "walletId")
        .with_date(DateFilter::new("createdAt", "createdAt"))
        .with_sortable("name", "name")
        .with_sortable("status", "status")
        .with_sortable("createdAt", "createdAt")
        .with_sortable("expectedMonthlyVolume", "expectedMonthlyVolume")
        .with_default_sort("createdAt", SortDirection::Desc)
        .with_default_page_size(25.0)
}

async fn load_token_stats(
    pool: &PgPool,
    application_ids: &[String],
) -> Result<BTreeMap<String, TokenStats>, ApiError> {
    let mut map = BTreeMap::new();
    if application_ids.is_empty() {
        return Ok(map);
    }
    let rows = sqlx::query(
        "SELECT t.application_id AS application_id, \
         count(*) FILTER (WHERE t.revoked_at IS NOT NULL) AS revoked, \
         count(*) FILTER (WHERE t.revoked_at IS NULL AND t.expires_at IS NOT NULL \
           AND t.expires_at <= now()) AS expired, \
         count(*) FILTER (WHERE t.revoked_at IS NULL \
           AND (t.expires_at IS NULL OR t.expires_at > now())) AS active, \
         count(*) FILTER (WHERE t.ip_whitelist_enabled) AS ip_restricted, \
         COALESCE(sum(CASE WHEN t.ip_whitelist_enabled \
           THEN (SELECT count(*) FROM access_token_ips ip WHERE ip.token_id = t.id) \
           ELSE 0 END), 0)::bigint AS cidrs \
         FROM access_tokens t WHERE t.application_id = ANY($1::uuid[]) \
         GROUP BY t.application_id",
    )
    .bind(common::uuid_values(application_ids))
    .fetch_all(pool)
    .await
    .map_err(common::database_error)?;
    for row in &rows {
        map.insert(
            common::uuid_text(row, "application_id")?,
            TokenStats {
                active: common::i64_of(row, "active")?,
                revoked: common::i64_of(row, "revoked")?,
                expired: common::i64_of(row, "expired")?,
                ip_restricted: common::i64_of(row, "ip_restricted")?,
                cidrs: common::i64_of(row, "cidrs")?,
            },
        );
    }
    Ok(map)
}

fn token_stats_of(tokens: &[TokenRow], now: NaiveDateTime) -> TokenStats {
    let mut stats = TokenStats::default();
    for token in tokens {
        match super::models::token_status(token.revoked_at, token.expires_at, now) {
            "REVOKED" => stats.revoked += 1,
            "EXPIRED" => stats.expired += 1,
            _ => stats.active += 1,
        }
        if token.ip_whitelist_enabled {
            stats.ip_restricted += 1;
            stats.cidrs += token.cidrs.len() as i64;
        }
    }
    stats
}

/// `GET /internal/admin/applications`.
pub async fn list(
    pool: &PgPool,
    principal: Option<&Principal>,
    query_string: &str,
) -> Result<Value, ApiError> {
    let query = common::parse_query(query_string);
    let flags = common::flags(principal);
    common::assert_enum_filter(&query, "status", APPLICATION_STATUSES)?;
    common::assert_uuid_filter(&query, "merchantId")?;
    common::assert_uuid_filter(&query, "walletId")?;
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

    let applications: Vec<ApplicationRow> = rows
        .iter()
        .map(ApplicationRow::from_row)
        .collect::<Result<_, _>>()?;
    let ids: Vec<String> = applications
        .iter()
        .map(|application| application.id.clone())
        .collect();
    let stats = load_token_stats(pool, &ids).await?;

    let mut output = Vec::with_capacity(applications.len());
    let mut cursor_rows: Vec<Vec<pg_db::CursorValue>> = Vec::new();
    for application in &applications {
        output.push(application.to_json(
            &flags,
            stats.get(&application.id).copied().unwrap_or_default(),
        ));
        if let Some(plan) = &built.keyset {
            let values = common::cursor_values(
                plan,
                application.created_at,
                Some(application.updated_at),
                &application.id,
            );
            if values.len() == plan.fields.len() {
                cursor_rows.push(values);
            }
        }
    }

    Ok(pg_db::list_response(
        "applications",
        Value::Array(output),
        total,
        &built,
        &cursor_rows,
    ))
}

/// `GET /internal/admin/applications/:id`.
pub async fn detail(
    pool: &PgPool,
    principal: Option<&Principal>,
    id: &str,
) -> Result<Value, ApiError> {
    let application_id = Uuid::parse_str(id).map_err(|_| {
        ApiError::new(400, "INVALID_BODY", "Invalid request data").with_details(
            json!([{ "path": ["id"], "code": "invalid_string", "message": "must be a UUID" }]),
        )
    })?;
    let flags = common::flags(principal);
    let sql = format!("SELECT {} FROM {FROM} WHERE a.id = $1", COLUMNS.join(", "));
    let row = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()))
        .bind(application_id)
        .fetch_optional(pool)
        .await
        .map_err(common::database_error)?
        .ok_or_else(|| {
            ApiError::new(
                404,
                "APPLICATION_NOT_FOUND",
                "The application does not exist",
            )
        })?;
    let application = ApplicationRow::from_row(&row)?;

    let tokens = load_tokens(pool, application_id).await?;
    let stats = token_stats_of(&tokens, chrono::Utc::now().naive_utc());
    let mut base = match application.to_json(&flags, stats) {
        Value::Object(map) => map,
        _ => Map::new(),
    };

    let now = chrono::Utc::now().naive_utc();
    base.insert(
        "accessTokens".to_owned(),
        Value::Array(tokens.iter().map(|token| token.to_json(now)).collect()),
    );
    base.insert(
        "paymentLinks".to_owned(),
        Value::Array(load_payment_links(pool, application_id).await?),
    );
    base.insert(
        "posTerminals".to_owned(),
        Value::Array(load_pos_terminals(pool, application_id).await?),
    );
    base.insert(
        "pendingApprovals".to_owned(),
        Value::Array(load_pending_approvals(pool, &application.id).await?),
    );

    Ok(json!({ "application": Value::Object(base) }))
}

async fn load_tokens(pool: &PgPool, application_id: Uuid) -> Result<Vec<TokenRow>, ApiError> {
    let sql = format!(
        "SELECT {}, {} FROM access_tokens t \
         WHERE t.application_id = $1 ORDER BY t.created_at DESC LIMIT 100",
        ACCESS_TOKEN_BASE_COLUMNS.join(", "),
        ACCESS_TOKEN_NULL_RELATIONS.join(", ")
    );
    let rows = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()))
        .bind(application_id)
        .fetch_all(pool)
        .await
        .map_err(common::database_error)?;
    let mut tokens = rows
        .iter()
        .map(TokenRow::from_row)
        .collect::<Result<Vec<_>, _>>()?;
    let ids: Vec<String> = tokens.iter().map(|token| token.id.clone()).collect();
    let cidrs = load_token_ips(pool, &ids).await?;
    for token in &mut tokens {
        if let Some(values) = cidrs.get(&token.id) {
            token.cidrs = values.clone();
        }
    }
    Ok(tokens)
}

/// Token IP allow-list rows grouped per token (ordered for deterministic payloads).
pub async fn load_token_ips(
    pool: &PgPool,
    token_ids: &[String],
) -> Result<BTreeMap<String, Vec<String>>, ApiError> {
    let mut map: BTreeMap<String, Vec<String>> = BTreeMap::new();
    if token_ids.is_empty() {
        return Ok(map);
    }
    let rows = sqlx::query(
        "SELECT token_id, cidr FROM access_token_ips \
         WHERE token_id = ANY($1::uuid[]) ORDER BY token_id, cidr",
    )
    .bind(common::uuid_values(token_ids))
    .fetch_all(pool)
    .await
    .map_err(common::database_error)?;
    for row in &rows {
        map.entry(common::uuid_text(row, "token_id")?)
            .or_default()
            .push(common::text(row, "cidr")?);
    }
    Ok(map)
}

async fn load_payment_links(pool: &PgPool, application_id: Uuid) -> Result<Vec<Value>, ApiError> {
    let sql = format!(
        "SELECT {} FROM {PAYMENT_LINK_FROM} WHERE l.application_id = $1 \
         ORDER BY l.created_at DESC LIMIT 25",
        PAYMENT_LINK_COLUMNS.join(", ")
    );
    let rows = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()))
        .bind(application_id)
        .fetch_all(pool)
        .await
        .map_err(common::database_error)?;
    rows.iter()
        .map(|row| PaymentLinkRow::from_row(row).map(|link| link.to_json()))
        .collect()
}

async fn load_pos_terminals(pool: &PgPool, application_id: Uuid) -> Result<Vec<Value>, ApiError> {
    let sql = format!(
        "SELECT {} FROM {POS_TERMINAL_FROM} WHERE p.application_id = $1 \
         ORDER BY p.created_at DESC LIMIT 25",
        POS_TERMINAL_COLUMNS.join(", ")
    );
    let rows = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()))
        .bind(application_id)
        .fetch_all(pool)
        .await
        .map_err(common::database_error)?;
    rows.iter()
        .map(|row| PosTerminalRow::from_row(row).map(|terminal| terminal.to_json()))
        .collect()
}

async fn load_pending_approvals(
    pool: &PgPool,
    application_id: &str,
) -> Result<Vec<Value>, ApiError> {
    let variants = common::subject_variants("APPLICATION");
    let rows = sqlx::query(
        "SELECT id, state::text AS state, payload_diff_json, maker_reason, created_at \
         FROM approval_requests WHERE subject_type = ANY($1::text[]) AND subject_id = $2 \
         AND state::text IN ('DRAFT', 'PENDING_REVIEW') ORDER BY created_at DESC LIMIT 10",
    )
    .bind(&variants)
    .bind(application_id)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whitelist_modes_follow_the_ts_branching() {
        assert_eq!(APPLICATION_STATUSES.len(), 5);
        let columns = columns();
        assert_eq!(
            columns
                .get("statusFilter")
                .map(|column| column.sql.as_str()),
            Some("a.status::text")
        );
        assert_eq!(
            columns.get("walletId").map(|column| column.sql.as_str()),
            Some("a.assigned_wallet_id")
        );
    }

    #[test]
    fn token_stats_count_status_precedence() {
        let now = chrono::NaiveDate::from_ymd_opt(2026, 1, 1)
            .and_then(|date| date.and_hms_opt(0, 0, 0))
            .expect("date");
        let token = |revoked: bool, expires: Option<chrono::NaiveDateTime>| TokenRow {
            id: "id".to_owned(),
            name: "n".to_owned(),
            last_four: "1234".to_owned(),
            scopes: json!([]),
            env: "LIVE".to_owned(),
            ip_whitelist_enabled: true,
            cidrs: vec!["10.0.0.0/8".to_owned()],
            merchant_id: None,
            application_id: None,
            application: None,
            merchant: None,
            last_used_at: None,
            expires_at: expires,
            revoked_at: revoked.then_some(now),
            created_at: now,
        };
        let stats = token_stats_of(
            &[
                token(false, None),
                token(false, Some(now - chrono::Duration::seconds(1))),
                token(true, Some(now - chrono::Duration::seconds(1))),
            ],
            now,
        );
        assert_eq!((stats.active, stats.expired, stats.revoked), (1, 1, 1));
        assert_eq!((stats.ip_restricted, stats.cidrs), (3, 3));
    }
}

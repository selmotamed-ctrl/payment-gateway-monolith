//! Row types shared by more than one commerce list/detail handler.
//!
//! The field order of every `to_json` mirrors the TS object literal so the payload key order
//! matches `JSON.stringify` (`adminCommerce.ts:807`, `:1222`, `:1340`, `admin.ts:16843`).

#![forbid(unsafe_code)]

use chrono::NaiveDateTime;
use pg_http::ApiError;
use rust_decimal::Decimal;
use serde_json::{json, Map, Value};
use sqlx::postgres::PgRow;

use super::common::{self, MerchantRef};

/// `paymentLinkSelect` + its application/merchant joins.
pub const PAYMENT_LINK_FROM: &str = "payment_links l \
     JOIN applications a ON a.id = l.application_id \
     JOIN merchants m ON m.id = a.merchant_id";

/// `paymentLinkSelect` columns (`adminCommerce.ts:1201`).
pub const PAYMENT_LINK_COLUMNS: &[&str] = &[
    "l.id AS id",
    "l.key AS key",
    "l.application_id AS application_id",
    "a.name AS application_name",
    "m.id AS m_id",
    "m.legal_name AS m_legal_name",
    "m.trade_name AS m_trade_name",
    "l.wallet_id AS wallet_id",
    "l.amount AS amount",
    "l.currency::text AS currency",
    "l.fee_bearer::text AS fee_bearer",
    "l.infinite_use AS infinite_use",
    "l.use_count AS use_count",
    "l.confirmed_count AS confirmed_count",
    "l.active_locked_count AS active_locked_count",
    "l.state::text AS state",
    "l.redirect_url AS redirect_url",
    "l.expires_at AS expires_at",
    "l.created_at AS created_at",
];

/// One payment link row.
#[derive(Debug, Clone)]
pub struct PaymentLinkRow {
    pub id: String,
    pub key: String,
    pub application_id: String,
    pub application_name: String,
    pub merchant: MerchantRef,
    pub wallet_id: String,
    pub amount: Decimal,
    pub currency: String,
    pub fee_bearer: String,
    pub infinite_use: bool,
    pub use_count: i32,
    pub confirmed_count: i32,
    pub active_locked_count: i32,
    pub state: String,
    pub redirect_url: Option<String>,
    pub expires_at: Option<NaiveDateTime>,
    pub created_at: NaiveDateTime,
}

impl PaymentLinkRow {
    pub fn from_row(row: &PgRow) -> Result<Self, ApiError> {
        Ok(Self {
            id: common::uuid_text(row, "id")?,
            key: common::text(row, "key")?,
            application_id: common::uuid_text(row, "application_id")?,
            application_name: common::text(row, "application_name")?,
            merchant: MerchantRef::from_row(row, "m_id", "m_legal_name", "m_trade_name")?,
            wallet_id: common::uuid_text(row, "wallet_id")?,
            amount: common::decimal(row, "amount")?,
            currency: common::text(row, "currency")?,
            fee_bearer: common::text(row, "fee_bearer")?,
            infinite_use: common::bool_of(row, "infinite_use")?,
            use_count: common::i32_of(row, "use_count")?,
            confirmed_count: common::i32_of(row, "confirmed_count")?,
            active_locked_count: common::i32_of(row, "active_locked_count")?,
            state: common::text(row, "state")?,
            redirect_url: common::opt_text(row, "redirect_url")?,
            expires_at: common::opt_naive(row, "expires_at")?,
            created_at: common::naive(row, "created_at")?,
        })
    }

    /// `serializePaymentLink`.
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "key": self.key,
            "applicationId": self.application_id,
            "application": { "id": self.application_id, "name": self.application_name },
            "merchant": self.merchant.to_json(),
            "walletId": self.wallet_id,
            "amount": common::money4_zero(Some(self.amount)),
            "currency": self.currency,
            "feeBearer": self.fee_bearer,
            "infiniteUse": self.infinite_use,
            "useCount": self.use_count,
            "confirmedCount": self.confirmed_count,
            "activeLockedCount": self.active_locked_count,
            "state": self.state,
            "redirectUrl": self.redirect_url,
            "expiresAt": common::iso_value(self.expires_at),
            "createdAt": common::iso_naive(self.created_at),
        })
    }
}

/// `posTerminalSelect` + its application/merchant joins and per-terminal screen aggregate.
pub const POS_TERMINAL_FROM: &str = "pos_terminals p \
     JOIN applications a ON a.id = p.application_id \
     JOIN merchants m ON m.id = a.merchant_id \
     LEFT JOIN LATERAL ( \
         SELECT count(*) AS screen_count, max(s.last_active_at) AS last_active_at \
         FROM pos_screens s WHERE s.pos_id = p.id \
     ) sc ON TRUE";

/// `posTerminalSelect` columns (`adminCommerce.ts:1326`).
pub const POS_TERMINAL_COLUMNS: &[&str] = &[
    "p.id AS id",
    "p.name AS name",
    "p.location AS location",
    "p.application_id AS application_id",
    "a.name AS application_name",
    "m.id AS m_id",
    "m.legal_name AS m_legal_name",
    "m.trade_name AS m_trade_name",
    "p.status::text AS status",
    "sc.screen_count AS screen_count",
    "sc.last_active_at AS last_active_at",
    "p.created_at AS created_at",
];

/// One POS terminal row.
#[derive(Debug, Clone)]
pub struct PosTerminalRow {
    pub id: String,
    pub name: String,
    pub location: Option<String>,
    pub application_id: String,
    pub application_name: String,
    pub merchant: MerchantRef,
    pub status: String,
    pub screen_count: i64,
    pub last_active_at: Option<NaiveDateTime>,
    pub created_at: NaiveDateTime,
}

impl PosTerminalRow {
    pub fn from_row(row: &PgRow) -> Result<Self, ApiError> {
        Ok(Self {
            id: common::uuid_text(row, "id")?,
            name: common::text(row, "name")?,
            location: common::opt_text(row, "location")?,
            application_id: common::uuid_text(row, "application_id")?,
            application_name: common::text(row, "application_name")?,
            merchant: MerchantRef::from_row(row, "m_id", "m_legal_name", "m_trade_name")?,
            status: common::text(row, "status")?,
            screen_count: common::i64_of(row, "screen_count")?,
            last_active_at: common::opt_naive(row, "last_active_at")?,
            created_at: common::naive(row, "created_at")?,
        })
    }

    /// `serializePosTerminal`.
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "name": self.name,
            "location": self.location,
            "applicationId": self.application_id,
            "application": { "id": self.application_id, "name": self.application_name },
            "merchant": self.merchant.to_json(),
            "status": self.status,
            "screenCount": self.screen_count,
            "lastActiveAt": common::iso_value(self.last_active_at),
            "createdAt": common::iso_naive(self.created_at),
        })
    }
}

/// The token columns without the application/merchant joins (used by the application detail,
/// where TS does not select those relations and `serializeToken` returns null for both).
pub const ACCESS_TOKEN_BASE_COLUMNS: &[&str] = &[
    "t.id AS id",
    "t.name AS name",
    "t.last_four AS last_four",
    "t.scopes AS scopes",
    "t.env::text AS env",
    "t.ip_whitelist_enabled AS ip_whitelist_enabled",
    "t.last_used_at AS last_used_at",
    "t.expires_at AS expires_at",
    "t.revoked_at AS revoked_at",
    "t.created_at AS created_at",
    "t.merchant_id AS merchant_id",
    "t.application_id AS application_id",
];

/// `accessTokenListSelect` columns, with the application/merchant joins of the global list.
pub const ACCESS_TOKEN_COLUMNS: &[&str] = &[
    "t.id AS id",
    "t.name AS name",
    "t.last_four AS last_four",
    "t.scopes AS scopes",
    "t.env::text AS env",
    "t.ip_whitelist_enabled AS ip_whitelist_enabled",
    "t.last_used_at AS last_used_at",
    "t.expires_at AS expires_at",
    "t.revoked_at AS revoked_at",
    "t.created_at AS created_at",
    "t.merchant_id AS merchant_id",
    "t.application_id AS application_id",
    "ap.id AS ap_id",
    "ap.name AS ap_name",
    "m.id AS m_id",
    "m.legal_name AS m_legal_name",
    "m.trade_name AS m_trade_name",
];

/// NULL relation aliases for the application-detail token query (no joins there).
pub const ACCESS_TOKEN_NULL_RELATIONS: &[&str] = &[
    "NULL::uuid AS ap_id",
    "NULL::text AS ap_name",
    "NULL::uuid AS m_id",
    "NULL::text AS m_legal_name",
    "NULL::text AS m_trade_name",
];

/// One API access token row (never the token hash).
#[derive(Debug, Clone)]
pub struct TokenRow {
    pub id: String,
    pub name: String,
    pub last_four: String,
    pub scopes: Value,
    pub env: String,
    pub ip_whitelist_enabled: bool,
    pub cidrs: Vec<String>,
    pub merchant_id: Option<String>,
    pub application_id: Option<String>,
    pub application: Option<(String, String)>,
    pub merchant: Option<MerchantRef>,
    pub last_used_at: Option<NaiveDateTime>,
    pub expires_at: Option<NaiveDateTime>,
    pub revoked_at: Option<NaiveDateTime>,
    pub created_at: NaiveDateTime,
}

/// `tokenStatus` (`adminCommerce.ts:646`).
#[must_use]
pub fn token_status(
    revoked_at: Option<NaiveDateTime>,
    expires_at: Option<NaiveDateTime>,
    now: NaiveDateTime,
) -> &'static str {
    if revoked_at.is_some() {
        "REVOKED"
    } else if expires_at.is_some_and(|expires| expires <= now) {
        "EXPIRED"
    } else {
        "ACTIVE"
    }
}

impl TokenRow {
    pub fn from_row(row: &PgRow) -> Result<Self, ApiError> {
        let application = match common::opt_uuid_text(row, "ap_id")? {
            Some(id) => Some((id, common::opt_text(row, "ap_name")?.unwrap_or_default())),
            None => None,
        };
        let merchant = match common::opt_uuid_text(row, "m_id")? {
            Some(_) => Some(MerchantRef::from_row(
                row,
                "m_id",
                "m_legal_name",
                "m_trade_name",
            )?),
            None => None,
        };
        Ok(Self {
            id: common::uuid_text(row, "id")?,
            name: common::text(row, "name")?,
            last_four: common::text(row, "last_four")?,
            scopes: common::json_value(row, "scopes")?,
            env: common::text(row, "env")?,
            ip_whitelist_enabled: common::bool_of(row, "ip_whitelist_enabled")?,
            cidrs: Vec::new(),
            merchant_id: common::opt_uuid_text(row, "merchant_id")?,
            application_id: common::opt_uuid_text(row, "application_id")?,
            application,
            merchant,
            last_used_at: common::opt_naive(row, "last_used_at")?,
            expires_at: common::opt_naive(row, "expires_at")?,
            revoked_at: common::opt_naive(row, "revoked_at")?,
            created_at: common::naive(row, "created_at")?,
        })
    }

    #[must_use]
    pub fn with_cidrs(mut self, cidrs: Vec<String>) -> Self {
        self.cidrs = cidrs;
        self
    }

    /// `serializeToken` (`adminCommerce.ts:807`).
    #[must_use]
    pub fn to_json(&self, now: NaiveDateTime) -> Value {
        let mut out = Map::new();
        out.insert("id".to_owned(), Value::String(self.id.clone()));
        out.insert("name".to_owned(), Value::String(self.name.clone()));
        out.insert("lastFour".to_owned(), Value::String(self.last_four.clone()));
        out.insert(
            "scopes".to_owned(),
            Value::Array(
                common::string_list(&self.scopes)
                    .unwrap_or_default()
                    .into_iter()
                    .map(Value::String)
                    .collect(),
            ),
        );
        out.insert("env".to_owned(), Value::String(self.env.clone()));
        out.insert(
            "ipWhitelistEnabled".to_owned(),
            Value::Bool(self.ip_whitelist_enabled),
        );
        out.insert(
            "cidrs".to_owned(),
            Value::Array(self.cidrs.iter().cloned().map(Value::String).collect()),
        );
        out.insert("ipCount".to_owned(), Value::from(self.cidrs.len()));
        out.insert(
            "merchantId".to_owned(),
            self.merchant_id.clone().map_or(Value::Null, Value::String),
        );
        out.insert(
            "applicationId".to_owned(),
            self.application_id
                .clone()
                .map_or(Value::Null, Value::String),
        );
        out.insert(
            "application".to_owned(),
            self.application
                .as_ref()
                .map_or(Value::Null, |(id, name)| json!({ "id": id, "name": name })),
        );
        out.insert(
            "merchant".to_owned(),
            self.merchant
                .as_ref()
                .map_or(Value::Null, MerchantRef::to_json),
        );
        out.insert(
            "lastUsedAt".to_owned(),
            common::iso_value(self.last_used_at),
        );
        out.insert("expiresAt".to_owned(), common::iso_value(self.expires_at));
        out.insert("revokedAt".to_owned(), common::iso_value(self.revoked_at));
        out.insert(
            "status".to_owned(),
            Value::String(token_status(self.revoked_at, self.expires_at, now).to_owned()),
        );
        out.insert(
            "createdAt".to_owned(),
            Value::String(common::iso_naive(self.created_at)),
        );
        Value::Object(out)
    }
}

/// `asset` columns (`admin.ts:16841` returns the whole model).
pub const ASSET_COLUMNS: &[&str] = &[
    "id",
    "created_at",
    "updated_at",
    "name",
    "mime::text AS mime",
    "size_bytes",
    "storage_key",
    "storage_object_id",
    "sha256",
];

/// One brand asset row.
#[derive(Debug, Clone)]
pub struct AssetRow {
    pub id: String,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
    pub name: String,
    pub mime: String,
    pub size_bytes: i32,
    pub storage_key: String,
    pub storage_object_id: Option<String>,
    pub sha256: String,
}

impl AssetRow {
    pub fn from_row(row: &PgRow) -> Result<Self, ApiError> {
        Ok(Self {
            id: common::uuid_text(row, "id")?,
            created_at: common::naive(row, "created_at")?,
            updated_at: common::naive(row, "updated_at")?,
            name: common::text(row, "name")?,
            mime: common::text(row, "mime")?,
            size_bytes: common::i32_of(row, "size_bytes")?,
            storage_key: common::text(row, "storage_key")?,
            storage_object_id: common::opt_uuid_text(row, "storage_object_id")?,
            sha256: common::text(row, "sha256")?,
        })
    }

    /// The Prisma model as JSON (`mime` is the enum name, as Prisma serialises it).
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "createdAt": common::iso_naive(self.created_at),
            "updatedAt": common::iso_naive(self.updated_at),
            "name": self.name,
            "mime": self.mime,
            "sizeBytes": self.size_bytes,
            "storageKey": self.storage_key,
            "storageObjectId": self.storage_object_id,
            "sha256": self.sha256,
        })
    }
}

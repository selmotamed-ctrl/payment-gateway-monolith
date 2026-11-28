//! Report Studio autocomplete sources.
//!
//! Port of `core-back/engine/reportStudio/autocompleteProviders.ts` and of the route at
//! `core-back/api/internal/adminReportEngine.ts:1992`.
//!
//! The provider map below is the host allow-list: a `sourceKey` that is not one of these ten
//! entries is `404 AUTOCOMPLETE_SOURCE_NOT_FOUND`, exactly like
//! `host.autocompleteProviders[sourceKey]` in the TS handler. Each provider declares its
//! `requiredAuthority`; the route accepts that authority or `security:write`.
//!
//! Deviations (documented, not invented output):
//!
//! - `dependent` is parsed from the query string; malformed JSON is ignored like the TS
//!   `try/catch`. A well-formed but non-UUID `merchantId`/`applicationIds` value returns
//!   `400 INVALID_BODY` instead of reaching PostgreSQL as a `::uuid` cast (the TS raw query would
//!   answer 500); an invalid value can never widen a merchant scope.
//! - `limit` is clamped to `1..=50` (the TS `Math.min(Number(...) || 20, 50)` would forward a
//!   negative or fractional value to `LIMIT`).
//! - The LIKE term strips `%` and `_` and is bound as one value, like the TS `like()` helper.
//! - The read-only executor is the main pool (P3-T02's replica router is not wired in this shell).

#![forbid(unsafe_code)]

use pg_http::ApiError;
use serde_json::{json, Value};
use sqlx::postgres::{PgPool, Postgres};
use sqlx::{QueryBuilder, Row};
use uuid::Uuid;

use super::model::Actor;

/// One host autocomplete source.
#[derive(Debug, Clone, Copy)]
pub struct Provider {
    pub source_key: &'static str,
    pub required_authority: &'static str,
}

/// The host `autocompleteProviders` allow-list, in `autocompleteProviders.ts` order.
pub const PROVIDERS: &[Provider] = &[
    Provider {
        source_key: "merchants",
        required_authority: "merchant:read",
    },
    Provider {
        source_key: "applications",
        required_authority: "merchant:read",
    },
    Provider {
        source_key: "payment_links",
        required_authority: "merchant:read",
    },
    Provider {
        source_key: "pos_terminals",
        required_authority: "merchant:read",
    },
    Provider {
        source_key: "gateways",
        required_authority: "gateway:read",
    },
    Provider {
        source_key: "payment_rails",
        required_authority: "gateway:read",
    },
    Provider {
        source_key: "gl_accounts",
        required_authority: "finance:read",
    },
    Provider {
        source_key: "currencies",
        required_authority: "finance:read",
    },
    Provider {
        source_key: "staff_users",
        required_authority: "security:read",
    },
    Provider {
        source_key: "aml_cases",
        required_authority: "aml:read",
    },
];

/// `host.autocompleteProviders[sourceKey]`.
#[must_use]
pub fn provider(source_key: &str) -> Option<&'static Provider> {
    PROVIDERS
        .iter()
        .find(|provider| provider.source_key == source_key)
}

/// `applicationIdsOf`: a non-empty list of string ids, or `None` (unrestricted).
///
/// # Errors
/// `400 INVALID_BODY` for a value that is not a UUID (the TS cast would fail with a 500).
pub fn application_ids(value: Option<&Value>) -> Result<Option<Vec<Uuid>>, ApiError> {
    let Some(values) = value.and_then(Value::as_array).filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    let mut ids = Vec::with_capacity(values.len());
    for value in values {
        let Some(text) = value.as_str() else {
            continue;
        };
        ids.push(Uuid::parse_str(text).map_err(|_| {
            ApiError::new(
                400,
                "INVALID_BODY",
                "applicationIds must contain UUID values",
            )
        })?);
    }
    Ok((!ids.is_empty()).then_some(ids))
}

/// The `dependent` query value the providers read.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Dependent {
    pub merchant_id: Option<Uuid>,
    pub application_ids: Option<Vec<Uuid>>,
}

impl Dependent {
    /// Parse `?dependent=<json>`.
    ///
    /// # Errors
    /// `400 INVALID_BODY` for a non-UUID `merchantId` or `applicationIds` entry.
    pub fn parse(raw: Option<&str>) -> Result<Self, ApiError> {
        let Some(raw) = raw else {
            return Ok(Self::default());
        };
        let Ok(value) = serde_json::from_str::<Value>(raw) else {
            return Ok(Self::default());
        };
        let Some(object) = value.as_object() else {
            return Ok(Self::default());
        };
        let merchant_id = match object.get("merchantId").and_then(Value::as_str) {
            Some(text) => Some(
                Uuid::parse_str(text)
                    .map_err(|_| ApiError::new(400, "INVALID_BODY", "merchantId must be a UUID"))?,
            ),
            None => None,
        };
        Ok(Self {
            merchant_id,
            application_ids: application_ids(object.get("applicationIds"))?,
        })
    }
}

/// `like()`: trim, drop the SQL wildcards, wrap in `%`.
#[must_use]
pub fn like_term(query: &str) -> String {
    format!("%{}%", query.trim().replace(['%', '_'], ""))
}

/// `Math.min(Number(query.limit ?? 20) || 20, 50)` clamped to a positive integer.
#[must_use]
pub fn limit_of(raw: Option<&str>) -> i64 {
    let value = raw
        .and_then(|text| text.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value != 0.0)
        .unwrap_or(20.0);
    #[allow(clippy::cast_possible_truncation)]
    let clamped = value.clamp(1.0, 50.0) as i64;
    clamped.max(1)
}

/// `hasConfidentialAmlAccess` of `autocompleteProviders.ts`.
#[must_use]
pub fn confidential_aml(actor: Actor<'_>) -> bool {
    matches!(actor.role, "MLRO" | "COMPLIANCE")
        || (actor.has("aml:read") && actor.has("compliance:read"))
}

/// Run one provider's `search`.
///
/// # Errors
/// A database failure, or the invalid `dependent` value checks of [`Dependent::parse`].
pub async fn search(
    pool: &PgPool,
    provider: &Provider,
    query: &str,
    limit: i64,
    dependent: &Dependent,
    actor: Actor<'_>,
) -> Result<Vec<Value>, ApiError> {
    let pattern = like_term(query);
    match provider.source_key {
        "merchants" => merchants(pool, &pattern, limit).await,
        "applications" => applications(pool, &pattern, limit, dependent).await,
        "payment_links" => payment_links(pool, &pattern, limit, dependent).await,
        "pos_terminals" => pos_terminals(pool, &pattern, limit, dependent).await,
        "gateways" => gateways(pool, &pattern, limit).await,
        "payment_rails" => payment_rails(pool, &pattern, limit).await,
        "gl_accounts" => gl_accounts(pool, &pattern, limit).await,
        "currencies" => Ok(currencies()),
        "staff_users" => staff_users(pool, &pattern, limit).await,
        "aml_cases" => aml_cases(pool, &pattern, limit, actor).await,
        _ => Ok(Vec::new()),
    }
}

fn database(error: sqlx::Error) -> ApiError {
    super::common::database_error(error)
}

fn text(row: &sqlx::postgres::PgRow, column: &str) -> Result<String, sqlx::Error> {
    row.try_get(column)
}

fn optional_text(row: &sqlx::postgres::PgRow, column: &str) -> Result<Option<String>, sqlx::Error> {
    row.try_get(column)
}

fn push_scope(builder: &mut QueryBuilder<Postgres>, column: &str, dependent: &Dependent) {
    if let Some(merchant_id) = dependent.merchant_id {
        builder
            .push(" AND ")
            .push(column)
            .push(" = ")
            .push_bind(merchant_id);
    }
    if let Some(application_ids) = &dependent.application_ids {
        builder
            .push(" AND id = ANY(")
            .push_bind(application_ids.clone())
            .push(")");
    }
}

async fn merchants(pool: &PgPool, pattern: &str, limit: i64) -> Result<Vec<Value>, ApiError> {
    let rows = sqlx::query(
        "SELECT id, legal_name, trade_name, status::text AS status FROM merchants \
          WHERE legal_name ILIKE $1 OR trade_name ILIKE $1 \
          ORDER BY trade_name ASC LIMIT $2",
    )
    .bind(pattern)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(database)?;
    rows.iter()
        .map(|row| {
            let legal: String = text(row, "legal_name")?;
            let trade: Option<String> = optional_text(row, "trade_name")?;
            Ok(json!({
                "value": row.try_get::<Uuid, _>("id")?,
                "label": trade.clone().filter(|value| !value.is_empty()).unwrap_or_else(|| legal.clone()),
                "sublabel": legal,
                "badge": text(row, "status")?,
            }))
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(database)
}

async fn applications(
    pool: &PgPool,
    pattern: &str,
    limit: i64,
    dependent: &Dependent,
) -> Result<Vec<Value>, ApiError> {
    let mut builder = QueryBuilder::new(
        "SELECT id, name, merchant_id, status::text AS status FROM applications WHERE name ILIKE ",
    );
    builder.push_bind(pattern.to_owned());
    push_scope(&mut builder, "merchant_id", dependent);
    builder.push(" ORDER BY name ASC LIMIT ").push_bind(limit);
    let rows = builder.build().fetch_all(pool).await.map_err(database)?;
    rows.iter()
        .map(|row| {
            Ok(json!({
                "value": row.try_get::<Uuid, _>("id")?,
                "label": text(row, "name")?,
                "sublabel": row.try_get::<Uuid, _>("merchant_id")?,
                "badge": text(row, "status")?,
            }))
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(database)
}

async fn payment_links(
    pool: &PgPool,
    pattern: &str,
    limit: i64,
    dependent: &Dependent,
) -> Result<Vec<Value>, ApiError> {
    let mut builder = QueryBuilder::new(
        "SELECT pl.id, pl.key, a.merchant_id, pl.state::text AS state \
           FROM payment_links pl JOIN applications a ON a.id = pl.application_id \
          WHERE pl.key ILIKE ",
    );
    builder.push_bind(pattern.to_owned());
    if let Some(merchant_id) = dependent.merchant_id {
        builder.push(" AND a.merchant_id = ").push_bind(merchant_id);
    }
    if let Some(application_ids) = &dependent.application_ids {
        builder
            .push(" AND a.id = ANY(")
            .push_bind(application_ids.clone())
            .push(")");
    }
    builder
        .push(" ORDER BY pl.created_at DESC LIMIT ")
        .push_bind(limit);
    let rows = builder.build().fetch_all(pool).await.map_err(database)?;
    rows.iter()
        .map(|row| {
            Ok(json!({
                "value": row.try_get::<Uuid, _>("id")?,
                "label": text(row, "key")?,
                "sublabel": row.try_get::<Uuid, _>("merchant_id")?,
                "badge": text(row, "state")?,
            }))
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(database)
}

async fn pos_terminals(
    pool: &PgPool,
    pattern: &str,
    limit: i64,
    dependent: &Dependent,
) -> Result<Vec<Value>, ApiError> {
    let mut builder = QueryBuilder::new(
        "SELECT pt.id, pt.name, a.merchant_id, pt.status::text AS status \
           FROM pos_terminals pt JOIN applications a ON a.id = pt.application_id \
          WHERE pt.name ILIKE ",
    );
    builder.push_bind(pattern.to_owned());
    if let Some(merchant_id) = dependent.merchant_id {
        builder.push(" AND a.merchant_id = ").push_bind(merchant_id);
    }
    if let Some(application_ids) = &dependent.application_ids {
        builder
            .push(" AND a.id = ANY(")
            .push_bind(application_ids.clone())
            .push(")");
    }
    builder
        .push(" ORDER BY pt.name ASC LIMIT ")
        .push_bind(limit);
    let rows = builder.build().fetch_all(pool).await.map_err(database)?;
    rows.iter()
        .map(|row| {
            Ok(json!({
                "value": row.try_get::<Uuid, _>("id")?,
                "label": text(row, "name")?,
                "sublabel": row.try_get::<Uuid, _>("merchant_id")?,
                "badge": text(row, "status")?,
            }))
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(database)
}

async fn gateways(pool: &PgPool, pattern: &str, limit: i64) -> Result<Vec<Value>, ApiError> {
    let rows = sqlx::query(
        "SELECT id, code, name, status::text AS status FROM gateways \
          WHERE code ILIKE $1 OR name ILIKE $1 ORDER BY name ASC LIMIT $2",
    )
    .bind(pattern)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(database)?;
    rows.iter()
        .map(|row| {
            let name = text(row, "name")?;
            let code = text(row, "code")?;
            Ok(json!({
                "value": row.try_get::<Uuid, _>("id")?,
                "label": format!("{name} ({code})"),
                "badge": text(row, "status")?,
            }))
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(database)
}

async fn payment_rails(pool: &PgPool, pattern: &str, limit: i64) -> Result<Vec<Value>, ApiError> {
    let rows = sqlx::query(
        "SELECT id, code, name_en, name_ar, collection_mode::text AS collection_mode FROM rails \
          WHERE code ILIKE $1 OR name_en ILIKE $1 OR name_ar ILIKE $1 \
          ORDER BY code ASC LIMIT $2",
    )
    .bind(pattern)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(database)?;
    rows.iter()
        .map(|row| {
            let name_en = text(row, "name_en")?;
            let code = text(row, "code")?;
            Ok(json!({
                "value": row.try_get::<Uuid, _>("id")?,
                "label": format!("{name_en} ({code})"),
                "sublabel": optional_text(row, "name_ar")?.unwrap_or_default(),
                "badge": text(row, "collection_mode")?,
            }))
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(database)
}

async fn gl_accounts(pool: &PgPool, pattern: &str, limit: i64) -> Result<Vec<Value>, ApiError> {
    let rows = sqlx::query(
        "SELECT id, account_type::text AS account_type, owner_id, currency FROM gl_accounts \
          WHERE account_type::text ILIKE $1 OR owner_id::text ILIKE $1 OR id::text ILIKE $1 \
          ORDER BY account_type ASC LIMIT $2",
    )
    .bind(pattern)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(database)?;
    rows.iter()
        .map(|row| {
            let id: Uuid = row.try_get("id")?;
            let account_type = text(row, "account_type")?;
            Ok(json!({
                "value": id,
                "label": format!("{account_type} — {}", &id.to_string()[..8]),
                "sublabel": optional_text(row, "owner_id")?.unwrap_or_default(),
                "badge": text(row, "currency")?,
            }))
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(database)
}

fn currencies() -> Vec<Value> {
    vec![
        json!({"value": "LYD", "label": "LYD — Libyan Dinar (1000 Dirhams)", "badge": "DEFAULT"}),
        json!({"value": "USD", "label": "USD — US Dollar", "badge": "FX"}),
        json!({"value": "EUR", "label": "EUR — Euro", "badge": "FX"}),
    ]
}

async fn staff_users(pool: &PgPool, pattern: &str, limit: i64) -> Result<Vec<Value>, ApiError> {
    let rows = sqlx::query(
        "SELECT id, email, role::text AS role FROM users \
          WHERE merchant_id IS NULL AND email ILIKE $1 ORDER BY email ASC LIMIT $2",
    )
    .bind(pattern)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(database)?;
    rows.iter()
        .map(|row| {
            Ok(json!({
                "value": row.try_get::<Uuid, _>("id")?,
                "label": text(row, "email")?,
                "badge": text(row, "role")?,
            }))
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(database)
}

async fn aml_cases(
    pool: &PgPool,
    pattern: &str,
    limit: i64,
    actor: Actor<'_>,
) -> Result<Vec<Value>, ApiError> {
    if !confidential_aml(actor) {
        return Ok(Vec::new());
    }
    let rows = sqlx::query(
        "SELECT id, subject_type, severity::text AS severity, status::text AS status \
           FROM aml_cases WHERE id::text ILIKE $1 ORDER BY created_at DESC LIMIT $2",
    )
    .bind(pattern)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(database)?;
    rows.iter()
        .map(|row| {
            let id: Uuid = row.try_get("id")?;
            Ok(json!({
                "value": id,
                "label": format!("Case {} ({})", &id.to_string()[..8], text(row, "subject_type")?),
                "sublabel": text(row, "severity")?,
                "badge": text(row, "status")?,
            }))
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(database)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_allow_list_is_the_host_provider_map() {
        assert_eq!(PROVIDERS.len(), 10);
        for key in [
            "merchants",
            "applications",
            "payment_links",
            "pos_terminals",
            "gateways",
            "payment_rails",
            "gl_accounts",
            "currencies",
            "staff_users",
            "aml_cases",
        ] {
            assert!(provider(key).is_some(), "{key}");
        }
        assert!(provider("applications_v2").is_none());
        assert_eq!(
            provider("aml_cases").map(|entry| entry.required_authority),
            Some("aml:read")
        );
        assert_eq!(
            provider("merchants").map(|entry| entry.required_authority),
            Some("merchant:read")
        );
    }

    #[test]
    fn the_like_term_strips_wildcards() {
        assert_eq!(like_term("  acme  "), "%acme%");
        assert_eq!(like_term("a%b_c"), "%abc%");
        assert_eq!(like_term("%_"), "%%");
        assert_eq!(like_term(""), "%%");
    }

    #[test]
    fn limits_match_the_ts_cap() {
        assert_eq!(limit_of(None), 20);
        assert_eq!(limit_of(Some("5")), 5);
        assert_eq!(limit_of(Some("0")), 20);
        assert_eq!(limit_of(Some("abc")), 20);
        assert_eq!(limit_of(Some("500")), 50);
        assert_eq!(limit_of(Some("-4")), 1);
        assert_eq!(limit_of(Some("20.9")), 20);
    }

    #[test]
    fn dependent_json_is_tolerant_and_typed() {
        let empty = Dependent::parse(None).expect("none");
        assert_eq!(empty, Dependent::default());
        let malformed = Dependent::parse(Some("not-json")).expect("tolerated");
        assert_eq!(malformed, Dependent::default());
        let parsed = Dependent::parse(Some(
            r#"{"merchantId":"0f8fad5b-d9cb-469f-a165-70867728950e","applicationIds":["0f8fad5b-d9cb-469f-a165-70867728950e"]}"#,
        ))
        .expect("valid");
        assert!(parsed.merchant_id.is_some());
        assert_eq!(parsed.application_ids.as_ref().map(Vec::len), Some(1));
        assert!(Dependent::parse(Some(r#"{"merchantId":"not-a-uuid"}"#)).is_err());
        assert!(Dependent::parse(Some(r#"{"applicationIds":["nope"]}"#)).is_err());
        assert_eq!(
            application_ids(Some(&json!("not-an-array"))).expect("ignored"),
            None
        );
    }

    #[test]
    fn confidential_aml_needs_a_role_or_both_authorities() {
        let compliance = ["report:review".to_owned()];
        assert!(confidential_aml(Actor {
            role: "COMPLIANCE",
            authorities: &compliance
        }));
        assert!(confidential_aml(Actor {
            role: "FINANCE",
            authorities: &["aml:read".to_owned(), "compliance:read".to_owned()]
        }));
        assert!(!confidential_aml(Actor {
            role: "FINANCE",
            authorities: &["aml:read".to_owned()]
        }));
        // The TS rule is role OR both authorities, so SUPPORT with both still reads AML names.
        assert!(confidential_aml(Actor {
            role: "SUPPORT",
            authorities: &["aml:read".to_owned(), "compliance:read".to_owned()]
        }));
        assert!(!confidential_aml(Actor {
            role: "SUPPORT",
            authorities: &["aml:read".to_owned()]
        }));
    }
}

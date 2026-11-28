//! Small shared helpers for the domain route modules (P4+).
//!
//! These are deliberately thin: query parsing, JSON responses, pagination, principal ids and
//! money formatting. SQL stays in each route module so a reviewer can compare it with the TS file.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;

use ntex::http::StatusCode;
use ntex::web::HttpResponse;
use pg_domain_auth::{Principal, PrincipalKind};
use rust_decimal::Decimal;
use serde_json::Value;
use uuid::Uuid;

use crate::http::{parse_json_body, read_payload};
use pg_http::ApiError;

/// Parsed query-string values (first value wins, like Express `req.query` for scalar reads).
#[derive(Debug, Clone, Default)]
pub struct Query {
    values: BTreeMap<String, String>,
}

impl Query {
    #[must_use]
    pub fn parse(raw: &str) -> Self {
        let values = url::form_urlencoded::parse(raw.as_bytes())
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();
        Self { values }
    }

    #[must_use]
    pub fn get(&self, key: &str) -> Option<&str> {
        self.values.get(key).map(String::as_str)
    }

    #[must_use]
    pub fn non_empty(&self, key: &str) -> Option<&str> {
        self.get(key).filter(|value| !value.is_empty())
    }

    pub fn required(&self, key: &str) -> Result<&str, ApiError> {
        self.non_empty(key)
            .ok_or_else(|| ApiError::new(400, "INVALID_BODY", format!("{key} is required")))
    }

    pub fn uuid(&self, key: &str) -> Result<Option<Uuid>, ApiError> {
        match self.non_empty(key) {
            None => Ok(None),
            Some(raw) => Uuid::parse_str(raw)
                .map(Some)
                .map_err(|_| ApiError::new(400, "INVALID_BODY", format!("{key} must be a UUID"))),
        }
    }

    #[must_use]
    pub fn bool(&self, key: &str) -> Option<bool> {
        match self.non_empty(key)?.to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" => Some(true),
            "false" | "0" | "no" => Some(false),
            _ => None,
        }
    }

    pub fn u32_or(&self, key: &str, default: u32) -> Result<u32, ApiError> {
        match self.non_empty(key) {
            None => Ok(default),
            Some(raw) => raw.parse::<u32>().map_err(|_| {
                ApiError::new(400, "INVALID_BODY", format!("{key} must be an integer"))
            }),
        }
    }

    pub fn i64_opt(&self, key: &str) -> Result<Option<i64>, ApiError> {
        match self.non_empty(key) {
            None => Ok(None),
            Some(raw) => raw.parse::<i64>().map(Some).map_err(|_| {
                ApiError::new(400, "INVALID_BODY", format!("{key} must be an integer"))
            }),
        }
    }

    #[must_use]
    pub fn filter(&self, key: &str) -> Option<String> {
        self.non_empty(key).map(str::to_owned)
    }
}

/// Read an optional JSON body, with the caller's parser limit.
pub async fn json_body(payload: ntex::web::types::Payload, limit: u64) -> Result<Value, ApiError> {
    let bytes = read_payload(payload, limit).await?;
    if bytes.is_empty() {
        return Ok(Value::Null);
    }
    parse_json_body(&bytes)
}

/// A JSON response with the standard content type.
#[must_use]
pub fn json_response(status: StatusCode, value: &Value) -> HttpResponse {
    HttpResponse::builder(status)
        .content_type("application/json; charset=utf-8")
        .body(value.to_string())
}

#[must_use]
pub fn json_ok(value: &Value) -> HttpResponse {
    json_response(StatusCode::OK, value)
}

#[must_use]
pub fn no_content() -> HttpResponse {
    HttpResponse::NoContent().build()
}

#[must_use]
pub fn principal_id(principal: Option<&Principal>) -> Option<&str> {
    principal.and_then(|principal| principal.user_id.as_deref())
}

#[must_use]
pub fn principal_merchant_id(principal: Option<&Principal>) -> Option<&str> {
    principal.and_then(|principal| principal.merchant_id.as_deref())
}

/// The merchant id a merchant-channel route is scoped to, or `MERCHANT_SCOPE_REQUIRED`.
pub fn require_merchant_scope(principal: Option<&Principal>) -> Result<&str, ApiError> {
    let principal = principal.ok_or_else(|| {
        ApiError::new(
            401,
            "AUTH_REQUIRED",
            "A bearer token is required for this endpoint",
        )
    })?;
    principal.merchant_id.as_deref().ok_or_else(|| {
        ApiError::new(
            403,
            "MERCHANT_PRINCIPAL_REQUIRED",
            "A merchant principal is required",
        )
    })
}

#[must_use]
pub fn is_staff(principal: &Principal) -> bool {
    principal.kind == PrincipalKind::Session
}

/// `page`/`pageSize` as `(page, limit)` with the edge caps.
pub fn pagination(query: &Query, default_size: u32) -> (u32, u32) {
    let page = query.u32_or("page", 1).unwrap_or(1).max(1);
    let size = query
        .u32_or("pageSize", default_size)
        .unwrap_or(default_size)
        .clamp(1, 200);
    (page, size)
}

/// `Money4`: four fixed decimals, null as `0.0000`.
#[must_use]
pub fn money4(value: Option<Decimal>) -> String {
    pg_types::Money4(value.unwrap_or_default()).to_string()
}

/// Map a sqlx failure to the TS error envelope.
#[must_use]
pub fn database_error(error: sqlx::Error) -> ApiError {
    crate::auth::db_error(pg_db::DbError::from(error))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_parses_and_validates() {
        let query = Query::parse("page=2&pageSize=50&active=true&id=not-a-uuid");
        assert_eq!(query.get("page"), Some("2"));
        assert_eq!(query.bool("active"), Some(true));
        assert!(query.uuid("id").is_err());
        assert_eq!(pagination(&query, 20), (2, 50));
    }

    #[test]
    fn money_is_four_places() {
        assert_eq!(money4(None), "0.0000");
        assert_eq!(money4(Some(Decimal::new(5, 0))), "5.0000");
    }
}

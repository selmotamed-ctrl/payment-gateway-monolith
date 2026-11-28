//! Global search read route (`POST /internal/admin/search`, P4-T06).
//!
//! Port of the handler at `core-back/api/internal/admin.ts:1226` and of
//! `executeGlobalSearch` (`core-back/lib/globalSearch.ts:1732`).
//!
//! Request contract (`globalSearchRequestSchema`, `globalSearch.ts:1702`):
//!
//! - `query`: a string, trimmed, 2..=120 characters;
//! - `types`: an optional array of registered search types (1..=64 characters each);
//! - `limit`: an optional integer, 1..=10, default 5;
//! - no unknown keys (strict object).
//!
//! Every staff request needs one of `STAFF_READ_AUTHORITIES` (OR semantics, like
//! `requireAuthorities`). The response is the flat port shape of `pg-search`:
//! `{query, items, total, partial}` where each item is
//! `{provider, id, title, subtitle?, reference?, status?, merchantId?, operatorCaseId?, meta?, score,
//! timestamp_ms}` ranked globally by `pg_search::rank_and_slice`.
//!
//! Deviations of this slice (reported with the implementation):
//!
//! - The TS response is grouped (`{query, groups:[{type,items,truncated}], total, tookMs, partial}`).
//!   The port uses the `pg-search` flat item list and a global limit instead of one group per
//!   provider (the crate documents this shape).
//! - Providers run sequentially against the main pool (the TS `Promise.allSettled` runs them in
//!   parallel through the replica router; P3-T02 is not wired here).
//! - `partial` is true when a provider query fails, and also when the caller explicitly asked for
//!   a type whose SQL is not ported yet (`types:[…]` or a `type:` alias). Types are executed in
//!   the TS registration order.
//! - The audit provider is not ported (the `AuditStorePort` is a later slice); its absence does
//!   not mark a default search partial.
//! - Money in result labels is formatted from `rust_decimal` with two decimals, never through a
//!   float (the TS helper goes through `Number(value).toFixed(2)`).
//! - The search term and the results are never logged.

#![forbid(unsafe_code)]

mod providers;

#[cfg(test)]
mod tests;

use std::collections::BTreeSet;

use ntex::web::types::Payload;
use ntex::web::HttpRequest;
use pg_domain_auth::Principal;
use pg_http::limits::json_limit_for;
use pg_http::{ApiError, Authn, BodyRule, Channel, Policy, RateClass};
use pg_search::{parse_query_with_limit, search_response, SearchType};
use serde_json::{json, Value};

use super::common;
use super::{Handler, HandlerFuture, MountedRoute, PrincipalGuard};
use crate::state::AppState;

/// `STAFF_READ_AUTHORITIES` of `admin.ts:1209`.
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

/// The actor view the provider gates read.
#[derive(Debug, Clone, Copy)]
pub struct Actor<'a> {
    pub role: &'a str,
    pub authorities: &'a [String],
}

impl Actor<'_> {
    /// `hasAuthority` (staff wildcard included).
    #[must_use]
    pub fn has(&self, authority: &str) -> bool {
        self.authorities
            .iter()
            .any(|held| held == "*" || held == authority)
    }

    /// `hasAnyAuthority`.
    #[must_use]
    pub fn has_any(&self, authorities: &[&str]) -> bool {
        authorities.iter().any(|authority| self.has(authority))
    }
}

/// Routes owned by this module.
#[must_use]
pub fn routes() -> Vec<MountedRoute> {
    vec![MountedRoute {
        policy: Policy::new(
            "POST",
            "/internal/admin/search",
            Channel::Admin,
            Authn::Session,
            "core-back/api/internal/admin.ts:1226",
        )
        .authorities(STAFF_READ_AUTHORITIES)
        .rate_class(RateClass::Search)
        .body(BodyRule::Json {
            limit: pg_http::limits::MAX_JSON_BODY_BYTES_DEFAULT,
        }),
        handler: Handler::Custom(search),
        guard: PrincipalGuard::Staff,
    }]
}

/// The validated request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchBody {
    pub query: String,
    pub types: Option<Vec<String>>,
    pub limit: u32,
}

fn invalid(path: &str, code: &str, message: impl Into<String>) -> ApiError {
    ApiError::new(400, "INVALID_BODY", "Invalid request data").with_details(json!([{
        "path": [path],
        "code": code,
        "message": message.into(),
    }]))
}

/// `parseOrThrow(globalSearchRequestSchema, body)`.
///
/// # Errors
/// `400 INVALID_BODY` with the zod-shaped issue list.
pub fn parse_body(body: &Value) -> Result<SearchBody, ApiError> {
    let Some(object) = body.as_object() else {
        return Err(invalid(
            "<root>",
            "invalid_type",
            format!("Expected object, received {}", json_type(body)),
        ));
    };
    for key in object.keys() {
        if !matches!(key.as_str(), "query" | "types" | "limit") {
            return Err(
                ApiError::new(400, "INVALID_BODY", "Invalid request data").with_details(json!([{
                    "path": [],
                    "code": "unrecognized_keys",
                    "message": format!("Unrecognized key(s) in object: '{key}'"),
                }])),
            );
        }
    }
    let Some(query_value) = object.get("query") else {
        return Err(invalid("query", "invalid_type", "Required"));
    };
    let Some(query_raw) = query_value.as_str() else {
        return Err(invalid(
            "query",
            "invalid_type",
            "Expected string, received a non-string value",
        ));
    };
    let query = query_raw.trim();
    if query.chars().count() < pg_search::MIN_QUERY_CHARS {
        return Err(invalid(
            "query",
            "too_small",
            "Query must be at least 2 characters",
        ));
    }
    if query.chars().count() > pg_search::MAX_QUERY_CHARS {
        return Err(invalid(
            "query",
            "too_big",
            "Query must be at most 120 characters",
        ));
    }
    let types = match object.get("types") {
        None => None,
        Some(Value::Array(values)) => {
            let mut types = Vec::with_capacity(values.len());
            for (index, value) in values.iter().enumerate() {
                let Some(text) = value.as_str() else {
                    return Err(invalid(
                        &format!("types.{index}"),
                        "invalid_type",
                        "Expected string",
                    ));
                };
                if text.is_empty() || text.chars().count() > 64 {
                    return Err(invalid(
                        &format!("types.{index}"),
                        "invalid_string",
                        "The type must be 1 to 64 characters",
                    ));
                }
                types.push(text.to_owned());
            }
            Some(types)
        }
        Some(_) => {
            return Err(invalid(
                "types",
                "invalid_type",
                "Expected an array of search types",
            ));
        }
    };
    let limit = match object.get("limit") {
        None => pg_search::DEFAULT_LIMIT,
        Some(value) => {
            let Some(number) = value.as_i64() else {
                return Err(invalid("limit", "invalid_type", "Expected an integer"));
            };
            if number < i64::from(1) {
                return Err(invalid(
                    "limit",
                    "too_small",
                    "The result limit must be at least 1",
                ));
            }
            if number > i64::from(pg_search::CONTRACT_LIMIT_MAX) {
                return Err(invalid(
                    "limit",
                    "too_big",
                    "The result limit must be at most 10",
                ));
            }
            u32::try_from(number).unwrap_or(pg_search::DEFAULT_LIMIT)
        }
    };
    Ok(SearchBody {
        query: query.to_owned(),
        types,
        limit,
    })
}

fn json_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// Resolve the requested types (unknown names are refused like the TS registry check).
fn resolve_types(body: &SearchBody) -> Result<Option<BTreeSet<SearchType>>, ApiError> {
    let Some(types) = &body.types else {
        return Ok(None);
    };
    let mut resolved = BTreeSet::new();
    let mut unknown: Vec<&str> = Vec::new();
    for requested in types {
        match SearchType::from_wire(requested) {
            Some(search_type) => {
                resolved.insert(search_type);
            }
            None => unknown.push(requested),
        }
    }
    if !unknown.is_empty() {
        return Err(ApiError::new(
            400,
            "SEARCH_TYPE_UNSUPPORTED",
            "The search request contains an unsupported record type",
        )
        .with_details(json!({ "types": unknown })));
    }
    Ok(Some(resolved))
}

fn staff(principal: Option<&Principal>) -> Result<&Principal, ApiError> {
    let principal = principal.ok_or_else(|| {
        ApiError::new(
            401,
            "AUTH_REQUIRED",
            "A bearer token is required for this endpoint",
        )
    })?;
    principal.require_staff().map_err(crate::auth::api_error)?;
    Ok(principal)
}

fn actor(principal: &Principal) -> Actor<'_> {
    Actor {
        role: principal.role.as_deref().unwrap_or("UNKNOWN"),
        authorities: &principal.authorities,
    }
}

/// `POST /internal/admin/search`.
pub fn search<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        match search_inner(state, request, principal, payload).await {
            Ok(value) => common::json_ok(&value),
            Err(error) => crate::http::error_response(request, error),
        }
    })
}

async fn search_inner(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
    payload: Payload,
) -> Result<Value, ApiError> {
    let principal = staff(principal)?;
    principal
        .require_authorities(STAFF_READ_AUTHORITIES)
        .map_err(crate::auth::api_error)?;
    let body = common::json_body(payload, json_limit_for(request.path())).await?;
    let parsed_body = parse_body(&body)?;
    let requested = resolve_types(&parsed_body)?;
    let parsed = parse_query_with_limit(&parsed_body.query, parsed_body.limit)
        .map_err(|error| ApiError::new(error.status(), error.code(), error.to_string()))?;

    // `type:`/`is:`/`kind:` aliases narrow the allowed set; an unknown alias is ignored.
    let mut explicit_scope = requested.is_some();
    let mut allowed = requested;
    if !parsed.scoped_type_aliases.is_empty() {
        let mut alias_matched: BTreeSet<SearchType> = BTreeSet::new();
        for alias in &parsed.scoped_type_aliases {
            alias_matched.extend(SearchType::resolve_alias(alias));
        }
        if !alias_matched.is_empty() {
            explicit_scope = true;
            allowed = Some(match allowed {
                Some(current) => current.intersection(&alias_matched).copied().collect(),
                None => alias_matched,
            });
        }
    }

    let actor = actor(principal);
    let take = i64::from(parsed_body.limit) * 3;
    let mut candidates = Vec::new();
    let mut partial = false;
    for provider in pg_search::all_ordered() {
        if let Some(allowed) = &allowed {
            if !allowed.contains(provider) {
                continue;
            }
        }
        if !providers::can_access(*provider, actor) {
            continue;
        }
        if !providers::implemented(*provider) {
            if explicit_scope {
                partial = true;
            }
            continue;
        }
        match providers::run(&state.pools.main, *provider, &parsed, actor, take).await {
            Ok(mut found) => candidates.append(&mut found),
            Err(error) => {
                partial = true;
                tracing::warn!(
                    provider = %provider,
                    error = %error,
                    "global search provider failed"
                );
            }
        }
    }
    let response = search_response(&parsed, &candidates, partial);
    Ok(response_json(&response))
}

/// The TS result field names (`SearchResultItem`) with the port's score and timestamp.
fn ranked_json(ranked: &pg_search::RankedHit) -> Value {
    let mut item = serde_json::Map::new();
    item.insert("provider".to_owned(), json!(ranked.provider.as_str()));
    item.insert("id".to_owned(), json!(ranked.hit.id));
    item.insert("title".to_owned(), json!(ranked.hit.title));
    if let Some(subtitle) = &ranked.hit.subtitle {
        item.insert("subtitle".to_owned(), json!(subtitle));
    }
    if let Some(reference) = &ranked.hit.reference {
        item.insert("reference".to_owned(), json!(reference));
    }
    if let Some(status) = &ranked.hit.status {
        item.insert("status".to_owned(), json!(status));
    }
    if let Some(merchant_id) = &ranked.hit.merchant_id {
        item.insert("merchantId".to_owned(), json!(merchant_id));
    }
    if let Some(case_id) = &ranked.hit.operator_case_id {
        item.insert("operatorCaseId".to_owned(), json!(case_id));
    }
    if !ranked.hit.meta.is_empty() {
        if let Ok(meta) = serde_json::to_value(&ranked.hit.meta) {
            item.insert("meta".to_owned(), meta);
        }
    }
    item.insert("score".to_owned(), json!(ranked.score));
    item.insert("timestampMs".to_owned(), json!(ranked.timestamp_ms));
    Value::Object(item)
}

/// `{query, items, total, partial}` with TS camelCase item fields.
fn response_json(response: &pg_search::SearchResponse) -> Value {
    let items: Vec<Value> = response.items.iter().map(ranked_json).collect();
    json!({
        "query": response.query,
        "items": items,
        "total": response.total,
        "partial": response.partial,
    })
}

#[cfg(test)]
mod unit {
    use super::*;

    #[test]
    fn the_body_contract_matches_the_ts_schema() {
        let body = parse_body(&json!({"query": "  acme  "})).expect("valid");
        assert_eq!(body.query, "acme");
        assert_eq!(body.limit, 5);
        assert!(body.types.is_none());

        let body = parse_body(&json!({"query": "acme", "types": ["merchant"], "limit": 3}))
            .expect("valid");
        assert_eq!(body.types.as_deref(), Some(&["merchant".to_owned()][..]));
        assert_eq!(body.limit, 3);

        assert_eq!(
            parse_body(&json!({"query": "a"})).expect_err("short").code,
            "INVALID_BODY"
        );
        assert_eq!(
            parse_body(&json!({"query": "  "})).expect_err("blank").code,
            "INVALID_BODY"
        );
        assert_eq!(
            parse_body(&json!({"query": "a".repeat(121)}))
                .expect_err("long")
                .code,
            "INVALID_BODY"
        );
        assert_eq!(
            parse_body(&json!({"query": "acme", "limit": 0}))
                .expect_err("limit 0")
                .code,
            "INVALID_BODY"
        );
        assert_eq!(
            parse_body(&json!({"query": "acme", "limit": 11}))
                .expect_err("limit 11")
                .code,
            "INVALID_BODY"
        );
        assert_eq!(
            parse_body(&json!({"query": "acme", "limit": 2.5}))
                .expect_err("float")
                .code,
            "INVALID_BODY"
        );
        let unknown = parse_body(&json!({"query": "acme", "extra": 1})).expect_err("strict");
        assert_eq!(
            unknown.details.expect("details")[0]["code"],
            "unrecognized_keys"
        );
        assert_eq!(
            parse_body(&json!({"query": "acme", "types": "merchant"}))
                .expect_err("types")
                .code,
            "INVALID_BODY"
        );
        assert_eq!(
            parse_body(&json!({"types": ["merchant"]}))
                .expect_err("missing query")
                .code,
            "INVALID_BODY"
        );
        assert_eq!(
            parse_body(&json!("acme")).expect_err("not object").code,
            "INVALID_BODY"
        );
    }

    #[test]
    fn unknown_types_are_refused_with_the_ts_code() {
        let body =
            parse_body(&json!({"query": "acme", "types": ["merchant", "voucher"]})).expect("shape");
        let error = resolve_types(&body).expect_err("unsupported");
        assert_eq!(error.status, 400);
        assert_eq!(error.code, "SEARCH_TYPE_UNSUPPORTED");
        assert_eq!(error.details.expect("details")["types"][0], "voucher");

        let body = parse_body(&json!({"query": "acme", "types": ["merchant", "payment_attempt"]}))
            .expect("shape");
        let types = resolve_types(&body).expect("known").expect("some");
        assert_eq!(types.len(), 2);
        assert!(types.contains(&SearchType::Merchant));

        let body = parse_body(&json!({"query": "acme", "types": []})).expect("shape");
        let types = resolve_types(&body).expect("known").expect("some");
        assert!(types.is_empty(), "an explicit empty list requests nothing");
    }

    #[test]
    fn the_response_items_use_the_ts_field_names() {
        let mut hit = pg_search::SearchHit::new("id-1", "ACME")
            .with_merchant("merchant-1")
            .with_reference("REF-1")
            .with_status("ACTIVE")
            .with_meta("count", pg_search::MetaValue::Integer(2));
        hit.operator_case_id = Some("case-1".to_owned());
        let ranked = pg_search::RankedHit {
            provider: SearchType::Merchant,
            hit,
            score: 900,
            timestamp_ms: 1_700_000_000_000,
        };
        let response = pg_search::SearchResponse::new("acme", vec![ranked], false);
        let wire = response_json(&response);
        assert_eq!(wire["items"][0]["provider"], "merchant");
        assert_eq!(wire["items"][0]["merchantId"], "merchant-1");
        assert_eq!(wire["items"][0]["operatorCaseId"], "case-1");
        assert_eq!(wire["items"][0]["timestampMs"], 1_700_000_000_000_i64);
        assert_eq!(wire["items"][0]["meta"]["count"], 2);
        assert!(wire["items"][0].get("merchant_id").is_none());
        assert_eq!(wire["total"], 1);
        assert_eq!(wire["partial"], false);
    }

    #[test]
    fn the_route_is_a_search_rated_staff_post() {
        let routes = routes();
        assert_eq!(routes.len(), 1);
        let route = &routes[0];
        assert_eq!(route.policy.method, "POST");
        assert_eq!(route.policy.path, "/internal/admin/search");
        assert_eq!(route.policy.channel, pg_http::Channel::Admin);
        assert_eq!(route.policy.rate_class, RateClass::Search);
        assert_eq!(route.guard, PrincipalGuard::Staff);
        assert_eq!(route.policy.authorities.len(), STAFF_READ_AUTHORITIES.len());
    }
}

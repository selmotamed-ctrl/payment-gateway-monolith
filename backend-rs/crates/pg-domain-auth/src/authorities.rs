//! The closed merchant authority catalogue, its legacy aliases, the implications of the coarse
//! grants and the portal (UI) projection.
//!
//! Port of `core-back/lib/auth/merchantAuthorities.ts` and the merchant half of
//! `core-back/lib/auth/uiAuthorities.ts:100-158`.
//!
//! The catalogue is **closed**: `authoritiesMap` values and client-supplied API-token scopes are
//! validated against it, and unknown strings or the wildcard `*` are rejected. Core enforces the
//! catalogue on every merchant route; the edges and the portal only project it.
//!
//! Implications (`effectiveMerchantAuthorities`, `merchantAuthorities.ts:85-112`) are ported as-is:
//!
//! - An API token holds exactly its normalised scopes plus `link:read` when it holds `link:write`.
//! - `merchant:write` implies the operational set, and for `MERCHANT_ADMIN` also the privileged set
//!   and `report_engine:author`.
//! - `merchant:read` or `link:write` implies `link:read`, `payment:read`, `cashout:read` and
//!   `report_engine:run`.
//! - `*` is dropped for merchant principals.

#![forbid(unsafe_code)]

use std::collections::BTreeSet;

use serde_json::Value;

use crate::error::AuthError;

/// The 17 merchant authorities (`MERCHANT_AUTHORITY_CATALOGUE`).
pub const MERCHANT_AUTHORITY_CATALOGUE: [&str; 17] = [
    // Coarse authorities issued at registration (kept for compatibility).
    "merchant:read",
    "merchant:write",
    "link:write",
    "payment:read",
    // Fine-grained authorities for the sensitive routes.
    "link:read",
    "wallet:create",
    "application:manage",
    "pos:manage",
    "onboarding:write",
    "dispute:respond",
    "cashout:read",
    "cashout:request",
    "user:manage",
    "token:manage",
    "credential:manage",
    "report_engine:run",
    "report_engine:author",
];

/// The scopes an API token can carry (`API_TOKEN_SCOPE_CATALOGUE`).
pub const API_TOKEN_SCOPE_CATALOGUE: [&str; 3] = ["link:write", "link:read", "payment:read"];

/// Legacy token scopes documented before the catalogue was closed, mapped to the canonical scope.
pub const TOKEN_SCOPE_ALIASES: [(&str, &str); 6] = [
    ("links:create", "link:write"),
    ("links:write", "link:write"),
    ("links:cancel", "link:write"),
    ("links:read", "link:read"),
    ("payments:read", "payment:read"),
    ("payments:write", "payment:read"),
];

/// Privileged authorities, implied only for a `MERCHANT_ADMIN` holding `merchant:write`.
pub const PRIVILEGED_MERCHANT_AUTHORITIES: [&str; 4] = [
    "user:manage",
    "token:manage",
    "credential:manage",
    "cashout:request",
];

/// The operational set implied by `merchant:write`.
pub const IMPLIED_BY_MERCHANT_WRITE: [&str; 8] = [
    "link:write",
    "wallet:create",
    "application:manage",
    "pos:manage",
    "onboarding:write",
    "dispute:respond",
    "cashout:read",
    "report_engine:run",
];

// The projection slices are separate items because indexing/unsizing an array literal is not const
// on the pinned toolchain.
const UI_APPLICATION_MANAGE: &[&str] = &["applications.read", "webhooks.manage"];
const UI_MERCHANT_READ: &[&str] = &[
    "stats.read",
    "wallets.read",
    "statements.read",
    "applications.read",
    "links.read",
    "payments.read",
    "cashout.read",
];
const UI_MERCHANT_WRITE: &[&str] = &[
    "stats.read",
    "wallets.read",
    "statements.read",
    "statements.export",
    "applications.read",
    "applications.edit_descriptive",
    "applications.propose_sensitive",
    "merchants.read",
    "merchants.edit_descriptive",
    "merchants.propose_sensitive",
    "links.read",
    "links.create",
    "links.cancel",
    "payments.read",
    "payments.export",
    "cashout.read",
    "cashout.request",
    "pos.manage",
    "pos.operate",
    "tokens.read",
    "tokens.create",
    "tokens.revoke",
    "credentials.manage",
    "users.manage",
];
const UI_LINK_WRITE: &[&str] = &["links.read", "links.create", "links.cancel"];
const UI_PAYMENT_READ: &[&str] = &["payments.read", "payments.export", "stats.read"];
const UI_REPORT_ENGINE_RUN: &[&str] = &["reports.run"];
const UI_REPORT_ENGINE_AUTHOR: &[&str] = &["reports.studio", "reports.run", "reports.draft"];

/// The portal projection of the merchant authorities (`MERCHANT_UI_PROJECTION`).
pub const MERCHANT_UI_PROJECTION: &[(&str, &[&str])] = &[
    // Webhook endpoint management (AUTO-34); the screen itself also needs `applications.read`.
    ("application:manage", UI_APPLICATION_MANAGE),
    ("merchant:read", UI_MERCHANT_READ),
    ("merchant:write", UI_MERCHANT_WRITE),
    ("link:write", UI_LINK_WRITE),
    ("payment:read", UI_PAYMENT_READ),
    ("report_engine:run", UI_REPORT_ENGINE_RUN),
    ("report_engine:author", UI_REPORT_ENGINE_AUTHOR),
];

/// How the principal authenticated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrincipalKind {
    Session,
    ApiToken,
}

/// The slice of the principal the authority rules read (`Pick<Principal, "kind"|"role"|"authorities">`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MerchantPrincipal {
    pub kind: PrincipalKind,
    pub role: String,
    pub authorities: Vec<String>,
}

impl MerchantPrincipal {
    /// A merchant user session.
    #[must_use]
    pub fn session(role: impl Into<String>, authorities: Vec<String>) -> Self {
        Self {
            kind: PrincipalKind::Session,
            role: role.into(),
            authorities,
        }
    }

    /// A merchant API token (authorities are the token scopes).
    #[must_use]
    pub fn api_token(scopes: Vec<String>) -> Self {
        Self {
            kind: PrincipalKind::ApiToken,
            role: "MERCHANT_API".to_owned(),
            authorities: scopes,
        }
    }

    /// A `MERCHANT_ADMIN` session holding `merchant:write`.
    #[must_use]
    pub fn admin() -> Self {
        Self::session("MERCHANT_ADMIN", vec!["merchant:write".to_owned()])
    }
}

/// True for the two coarse grants a merchant user is registered with.
#[must_use]
pub fn is_coarse_authority(authority: &str) -> bool {
    matches!(authority, "merchant:read" | "merchant:write")
}

/// `normalizeTokenScopes`: map legacy aliases to the canonical scope and de-duplicate.
#[must_use]
pub fn expand_legacy<I, S>(scopes: I) -> Vec<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for scope in scopes {
        let scope = scope.as_ref();
        let canonical = TOKEN_SCOPE_ALIASES
            .iter()
            .find(|(alias, _)| *alias == scope)
            .map_or(scope, |(_, canonical)| *canonical);
        if seen.insert(canonical.to_owned()) {
            out.push(canonical.to_owned());
        }
    }
    out
}

/// `normalizeTokenScopes` under the TS name.
#[must_use]
pub fn normalize_token_scopes<I, S>(scopes: I) -> Vec<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    expand_legacy(scopes)
}

/// `effectiveMerchantAuthorities`: the stored authorities plus every implication of the coarse
/// grants, with the wildcard dropped.
#[must_use]
pub fn effective_merchant_authorities(principal: &MerchantPrincipal) -> BTreeSet<String> {
    let source = if principal.kind == PrincipalKind::ApiToken {
        expand_legacy(principal.authorities.iter())
    } else {
        principal.authorities.clone()
    };
    let mut held: BTreeSet<String> = source
        .into_iter()
        .filter(|authority| authority != "*")
        .collect();
    if principal.kind == PrincipalKind::ApiToken {
        if held.contains("link:write") {
            held.insert("link:read".to_owned());
        }
        return held;
    }
    if held.contains("merchant:write") {
        for implied in IMPLIED_BY_MERCHANT_WRITE {
            held.insert(implied.to_owned());
        }
        if principal.role == "MERCHANT_ADMIN" {
            for privileged in PRIVILEGED_MERCHANT_AUTHORITIES {
                held.insert(privileged.to_owned());
            }
            held.insert("report_engine:author".to_owned());
        }
    }
    if held.contains("merchant:read") || held.contains("link:write") {
        for implied in [
            "link:read",
            "payment:read",
            "cashout:read",
            "report_engine:run",
        ] {
            held.insert(implied.to_owned());
        }
    }
    held
}

/// `hasMerchantAuthority`: OR semantics over the required list, deny by default.
#[must_use]
pub fn has_authority(principal: &MerchantPrincipal, required: &[&str]) -> bool {
    let held = effective_merchant_authorities(principal);
    required.iter().any(|authority| held.contains(*authority))
}

/// `assertMerchantAuthority`: `403 AUTHORITY_REQUIRED` when nothing in `required` is held.
pub fn assert_authority(principal: &MerchantPrincipal, required: &[&str]) -> Result<(), AuthError> {
    if has_authority(principal, required) {
        Ok(())
    } else {
        Err(AuthError::authority_required(required))
    }
}

/// `assertKnownMerchantAuthorities`: reject unknown strings and the wildcard.
pub fn assert_known_authorities(requested: &[String]) -> Result<(), AuthError> {
    let unknown: Vec<String> = requested
        .iter()
        .filter(|authority| !MERCHANT_AUTHORITY_CATALOGUE.contains(&authority.as_str()))
        .cloned()
        .collect();
    if unknown.is_empty() {
        Ok(())
    } else {
        Err(AuthError::unknown_authority(&unknown))
    }
}

/// `assertKnownTokenScopes`: normalise the aliases first, then check the closed scope list.
pub fn assert_known_token_scopes(requested: &[String]) -> Result<(), AuthError> {
    let unknown: Vec<String> = expand_legacy(requested.iter())
        .into_iter()
        .filter(|scope| !API_TOKEN_SCOPE_CATALOGUE.contains(&scope.as_str()))
        .collect();
    if unknown.is_empty() {
        Ok(())
    } else {
        Err(AuthError::unknown_token_scope(
            &unknown,
            &API_TOKEN_SCOPE_CATALOGUE,
        ))
    }
}

/// `assertGrantableMerchantAuthorities`: no self-escalation.
pub fn assert_grantable_authorities(
    principal: &MerchantPrincipal,
    requested: &[String],
) -> Result<(), AuthError> {
    let held = effective_merchant_authorities(principal);
    let excess: Vec<String> = requested
        .iter()
        .filter(|authority| !held.contains(*authority))
        .cloned()
        .collect();
    if excess.is_empty() {
        Ok(())
    } else {
        Err(AuthError::authority_escalation_forbidden(&excess))
    }
}

/// `assertGrantableMerchantRole`: only a `MERCHANT_ADMIN` grants `MERCHANT_ADMIN`.
pub fn assert_grantable_role(principal_role: &str, requested_role: &str) -> Result<(), AuthError> {
    if requested_role == "MERCHANT_ADMIN" && principal_role != "MERCHANT_ADMIN" {
        return Err(AuthError::role_escalation_forbidden());
    }
    Ok(())
}

/// `parseAuthorities`: accept a JSON array of strings or an object whose `true` keys are granted
/// (`authDoubleCheck.ts:43-53`). Empty strings and `false` entries are dropped.
///
/// A non-string array entry is stringified; only numbers, bools and `null` can appear in an
/// `authorities_map` column in practice, where JS `String(entry)` and serde agree.
#[must_use]
pub fn parse_authorities(value: &Value) -> Vec<String> {
    match value {
        Value::Array(entries) => entries
            .iter()
            .map(|entry| match entry {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            })
            .filter(|entry| !entry.is_empty())
            .collect(),
        Value::Object(map) => map
            .iter()
            .filter(|(_, enabled)| enabled.as_bool() == Some(true))
            .map(|(authority, _)| authority.clone())
            .collect(),
        _ => Vec::new(),
    }
}

/// `buildMerchantUiAuthoritiesMap`: the raw authority plus every projected UI key, as `true`.
///
/// The returned map keeps insertion order (serde_json `preserve_order`), matching the JS object that
/// the portal stores in `userInfo.authoritiesMap`.
#[must_use]
pub fn build_ui_authorities_map(authorities: &[String]) -> serde_json::Map<String, Value> {
    let mut map = serde_json::Map::new();
    for authority in authorities {
        map.insert(authority.clone(), Value::Bool(true));
        if let Some((_, projected)) = MERCHANT_UI_PROJECTION
            .iter()
            .find(|(source, _)| *source == authority.as_str())
        {
            for ui_authority in *projected {
                map.insert((*ui_authority).to_owned(), Value::Bool(true));
            }
        }
    }
    map
}

/// The UI keys a backend authority projects on (`MERCHANT_UI_PROJECTION`), empty when it has none.
#[must_use]
pub fn ui_projection(authority: &str) -> &'static [&'static str] {
    MERCHANT_UI_PROJECTION
        .iter()
        .find(|(source, _)| *source == authority)
        .map_or(&[] as &[&str], |(_, projected)| *projected)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn catalogue_is_the_seventeen_ts_strings_in_order() {
        assert_eq!(MERCHANT_AUTHORITY_CATALOGUE.len(), 17);
        assert_eq!(MERCHANT_AUTHORITY_CATALOGUE[0], "merchant:read");
        assert_eq!(MERCHANT_AUTHORITY_CATALOGUE[3], "payment:read");
        assert_eq!(MERCHANT_AUTHORITY_CATALOGUE[16], "report_engine:author");
        // No duplicates.
        let unique: BTreeSet<&str> = MERCHANT_AUTHORITY_CATALOGUE.iter().copied().collect();
        assert_eq!(unique.len(), 17);
        assert!(MERCHANT_AUTHORITY_CATALOGUE.contains(&"report_engine:run"));
    }

    #[test]
    fn legacy_scopes_normalise_and_deduplicate() {
        assert_eq!(
            expand_legacy(strings(&[
                "links:create",
                "links:write",
                "link:write",
                "payments:read"
            ])),
            strings(&["link:write", "payment:read"])
        );
        assert_eq!(
            normalize_token_scopes(strings(&["links:read", "payments:write"])),
            strings(&["link:read", "payment:read"])
        );
        assert_eq!(
            expand_legacy(strings(&["payment:read", "link:write"])),
            strings(&["payment:read", "link:write"])
        );
    }

    #[test]
    fn merchant_write_expands_for_an_admin() {
        let held = effective_merchant_authorities(&MerchantPrincipal::admin());
        for authority in [
            "merchant:write",
            "link:write",
            "wallet:create",
            "application:manage",
            "pos:manage",
            "onboarding:write",
            "dispute:respond",
            "cashout:read",
            "report_engine:run",
            "user:manage",
            "token:manage",
            "credential:manage",
            "cashout:request",
            "report_engine:author",
            "link:read",
            "payment:read",
        ] {
            assert!(held.contains(authority), "admin should hold {authority}");
        }
        assert!(!held.contains("merchant:read"));
    }

    #[test]
    fn merchant_write_does_not_grant_privileged_authorities_to_an_operator() {
        let operator =
            MerchantPrincipal::session("MERCHANT_OPERATOR", strings(&["merchant:write"]));
        let held = effective_merchant_authorities(&operator);
        assert!(held.contains("link:write"));
        assert!(!held.contains("user:manage"));
        assert!(!held.contains("token:manage"));
        assert!(!held.contains("credential:manage"));
        assert!(!held.contains("cashout:request"));
        assert!(!held.contains("report_engine:author"));
    }

    #[test]
    fn coarse_read_grants_the_screen_authorities_core_enforces() {
        let viewer = MerchantPrincipal::session("MERCHANT_VIEWER", strings(&["merchant:read"]));
        let held = effective_merchant_authorities(&viewer);
        for authority in [
            "link:read",
            "payment:read",
            "cashout:read",
            "report_engine:run",
        ] {
            assert!(held.contains(authority));
        }
        // `merchant:read` is not `merchant:write`.
        assert!(!held.contains("link:write"));
        assert!(!held.contains("wallet:create"));
    }

    #[test]
    fn wildcard_is_dropped_for_merchant_principals() {
        let principal = MerchantPrincipal::session("MERCHANT_ADMIN", strings(&["*"]));
        assert!(effective_merchant_authorities(&principal).is_empty());
        assert!(!has_authority(&principal, &["link:write"]));
    }

    #[test]
    fn api_token_holds_exactly_its_scopes() {
        let token = MerchantPrincipal::api_token(strings(&["links:create"]));
        assert_eq!(
            effective_merchant_authorities(&token),
            ["link:read".to_owned(), "link:write".to_owned()]
                .into_iter()
                .collect::<BTreeSet<_>>()
        );
        let read_only = MerchantPrincipal::api_token(strings(&["payment:read"]));
        let held = effective_merchant_authorities(&read_only);
        assert!(held.contains("payment:read"));
        assert!(!held.contains("link:read"));
        assert!(!held.contains("merchant:read"));
        // An API token never gains the merchant-write implications.
        let write = MerchantPrincipal::api_token(strings(&["link:write"]));
        assert!(!effective_merchant_authorities(&write).contains("wallet:create"));
    }

    #[test]
    fn has_authority_uses_or_semantics_and_denies_by_default() {
        let admin = MerchantPrincipal::admin();
        assert!(has_authority(&admin, &["link:write", "user:manage"]));
        assert!(!has_authority(&admin, &["merchant:approve"]));
        assert!(!has_authority(&admin, &[]));
        assert_eq!(
            assert_authority(&admin, &["merchant:approve"])
                .expect_err("denied")
                .code,
            "AUTHORITY_REQUIRED"
        );
    }

    #[test]
    fn unknown_authorities_and_scopes_are_rejected() {
        assert!(assert_known_authorities(&strings(&["link:write", "report_engine:run"])).is_ok());
        let error = assert_known_authorities(&strings(&["link:write", "*", "merchant:approve"]))
            .expect_err("unknown");
        assert_eq!(error.code, "UNKNOWN_AUTHORITY");
        assert_eq!(error.status, 400);
        let details = error.details.unwrap_or_default();
        assert_eq!(
            details["unknown"],
            serde_json::json!(["*", "merchant:approve"])
        );

        // Legacy aliases are accepted because they normalise onto a known scope.
        assert!(assert_known_token_scopes(&strings(&["links:cancel"])).is_ok());
        let error =
            assert_known_token_scopes(&strings(&["wallet:create"])).expect_err("not a token scope");
        assert_eq!(error.code, "UNKNOWN_TOKEN_SCOPE");
        assert_eq!(
            error.details.unwrap_or_default()["allowed"],
            serde_json::json!(["link:write", "link:read", "payment:read"])
        );
    }

    #[test]
    fn escalation_is_refused() {
        let operator =
            MerchantPrincipal::session("MERCHANT_OPERATOR", strings(&["merchant:write"]));
        assert!(assert_grantable_authorities(&operator, &strings(&["link:write"])).is_ok());
        let error = assert_grantable_authorities(&operator, &strings(&["user:manage"]))
            .expect_err("escalation");
        assert_eq!(error.code, "AUTHORITY_ESCALATION_FORBIDDEN");
        assert_eq!(
            error.details.unwrap_or_default()["authorities"],
            serde_json::json!(["user:manage"])
        );

        assert!(assert_grantable_role("MERCHANT_ADMIN", "MERCHANT_ADMIN").is_ok());
        assert!(assert_grantable_role("MERCHANT_OPERATOR", "MERCHANT_OPERATOR").is_ok());
        assert_eq!(
            assert_grantable_role("MERCHANT_OPERATOR", "MERCHANT_ADMIN")
                .expect_err("role escalation")
                .code,
            "ROLE_ESCALATION_FORBIDDEN"
        );
    }

    #[test]
    fn parse_authorities_accepts_arrays_and_enabled_maps() {
        let array = serde_json::json!(["merchant:read", "", "link:write", 3]);
        assert_eq!(
            parse_authorities(&array),
            strings(&["merchant:read", "link:write", "3"])
        );
        let map = serde_json::json!({ "merchant:read": true, "merchant:write": false });
        assert_eq!(parse_authorities(&map), strings(&["merchant:read"]));
        assert!(parse_authorities(&serde_json::json!(null)).is_empty());
        assert!(parse_authorities(&serde_json::json!("merchant:read")).is_empty());
    }

    #[test]
    fn ui_projection_matches_the_merchant_map() {
        assert_eq!(
            ui_projection("link:write"),
            &["links.read", "links.create", "links.cancel"]
        );
        assert_eq!(
            ui_projection("merchant:read"),
            &[
                "stats.read",
                "wallets.read",
                "statements.read",
                "applications.read",
                "links.read",
                "payments.read",
                "cashout.read",
            ]
        );
        assert!(ui_projection("wallet:create").is_empty());

        let map = build_ui_authorities_map(&strings(&["link:write"]));
        assert_eq!(map.get("link:write"), Some(&Value::Bool(true)));
        assert_eq!(map.get("links.create"), Some(&Value::Bool(true)));
        assert_eq!(map.get("links.cancel"), Some(&Value::Bool(true)));
        assert_eq!(map.len(), 4);
        // Insertion order: the raw authority first, then its projection in table order.
        let keys: Vec<&String> = map.keys().collect();
        assert_eq!(keys[0], "link:write");
        assert_eq!(keys[1], "links.read");
    }

    #[test]
    fn projection_never_grants_a_raw_authority() {
        // Presentation only: a projected key must not be mistaken for a backend authority.
        let map = build_ui_authorities_map(&strings(&["report_engine:author"]));
        assert_eq!(map.get("reports.studio"), Some(&Value::Bool(true)));
        assert!(assert_known_authorities(&strings(&["reports.studio"])).is_err());
    }
}

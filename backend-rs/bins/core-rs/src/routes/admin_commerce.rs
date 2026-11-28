//! Admin commerce read routes (P4-T04 chunk): merchants, applications, wallets, payment links,
//! POS terminals, API access tokens and brand assets, plus a private test-only implementation of
//! the transaction list/detail contract (its routes are mounted by `admin_operations`).
//!
//! # Rows implemented here
//!
//! | Method | Path | TS origin | Authority (OR) |
//! | :--- | :--- | :--- | :--- |
//! | GET | `/internal/admin/merchants` | `admin.ts:5253` | `merchant:read` |
//! | GET | `/internal/admin/merchants/:id` | `admin.ts:5597` | `merchant:read` |
//! | GET | `/internal/admin/applications` | `adminCommerce.ts:740` | `merchant:read` |
//! | GET | `/internal/admin/applications/:id` | `adminCommerce.ts:827` | `merchant:read` |
//! | GET | `/internal/admin/wallets` | `adminCommerce.ts:278` | `merchant:read` |
//! | GET | `/internal/admin/wallets/:id` | `adminCommerce.ts:367` | `merchant:read` |
//! | GET | `/internal/admin/payment-links` | `adminCommerce.ts:1242` | `merchant:read` |
//! | GET | `/internal/admin/pos-terminals` | `adminCommerce.ts:1359` | `merchant:read` |
//! | GET | `/internal/admin/access-tokens` | `adminCommerce.ts:1137` | `merchant:read` |
//! | GET | `/internal/admin/assets` | `admin.ts:16841` | `gateway:read` |
//! | GET | `/internal/admin/assets/:id` | `admin.ts:16847` | `gateway:read` |
//!
//! Payment links, POS terminals and access tokens have no detail GET in TS, so their list row is
//! the complete serialised object and no extra route is invented.
//!
//! `GET /internal/admin/transactions` and `GET /internal/admin/attempts/:id` are implemented in
//! `routes/admin_operations/attempts.rs`, which owns their policies; `admin_commerce::transactions`
//! keeps a private, test-only implementation of the same TS contract so this chunk's parity tests
//! can compare it without registering a duplicate route.
//!
//! # Inventory not in this chunk
//!
//! Summaries and exports (`/wallets/summary`, `/applications/summary`, `/access-tokens/summary`,
//! `/merchants/export`, `/merchants/summary[/export]`, `/merchants/:id/summary/export`,
//! `/transactions/summary[/export]`), the wallet statement and audit trail
//! (`/wallets/:id/statement`, `/wallets/:id/audit-events`), the merchant 360 sub-lists
//! (`/merchants/:id/{transactions,applications,wallets,cashouts,disputes,adjustments,
//! notifications,audit-events,stats,pending-changes,detail-changes,beneficial-owners}`), inbound
//! events, gateway health, the asset bytes route (`/assets/:id/content`) and every write route are
//! owned by later P4/P7 chunks.
//!
//! # Routing note
//!
//! `routes::find` resolves `:id` policies with its pattern matcher; the handlers also read the last
//! path segment so a direct call (tests, future dispatchers) behaves the same.

#![forbid(unsafe_code)]

pub mod applications;
pub mod catalog;
pub mod common;
#[cfg(test)]
pub mod db_tests;
pub mod merchants;
pub mod models;
#[cfg(test)]
pub mod test_support;
pub mod transactions;
pub mod wallets;

use ntex::web::types::Payload;
use ntex::web::HttpRequest;
use pg_domain_auth::Principal;
use pg_http::{ApiError, Authn, BodyRule, Channel, Policy};
use serde_json::Value;

use super::{Handler, HandlerFuture, MountedRoute, PrincipalGuard};
use crate::state::AppState;

/// Routes owned by this module.
#[must_use]
pub fn routes() -> Vec<MountedRoute> {
    vec![
        route(
            "GET",
            "/internal/admin/merchants",
            &["merchant:read"],
            "core-back/api/internal/admin.ts:5253",
            handle_merchants_list,
        ),
        route(
            "GET",
            "/internal/admin/merchants/:id",
            &["merchant:read"],
            "core-back/api/internal/admin.ts:5597",
            handle_merchant_detail,
        ),
        route(
            "GET",
            "/internal/admin/applications",
            &["merchant:read"],
            "core-back/api/internal/adminCommerce.ts:740",
            handle_applications_list,
        ),
        route(
            "GET",
            "/internal/admin/applications/:id",
            &["merchant:read"],
            "core-back/api/internal/adminCommerce.ts:827",
            handle_application_detail,
        ),
        route(
            "GET",
            "/internal/admin/wallets",
            &["merchant:read"],
            "core-back/api/internal/adminCommerce.ts:278",
            handle_wallets_list,
        ),
        route(
            "GET",
            "/internal/admin/wallets/:id",
            &["merchant:read"],
            "core-back/api/internal/adminCommerce.ts:367",
            handle_wallet_detail,
        ),
        route(
            "GET",
            "/internal/admin/payment-links",
            &["merchant:read"],
            "core-back/api/internal/adminCommerce.ts:1242",
            handle_payment_links,
        ),
        route(
            "GET",
            "/internal/admin/pos-terminals",
            &["merchant:read"],
            "core-back/api/internal/adminCommerce.ts:1359",
            handle_pos_terminals,
        ),
        route(
            "GET",
            "/internal/admin/access-tokens",
            &["merchant:read"],
            "core-back/api/internal/adminCommerce.ts:1137",
            handle_access_tokens,
        ),
        route(
            "GET",
            "/internal/admin/assets",
            &["gateway:read"],
            "core-back/api/internal/admin.ts:16841",
            handle_assets,
        ),
        route(
            "GET",
            "/internal/admin/assets/:id",
            &["gateway:read"],
            "core-back/api/internal/admin.ts:16847",
            handle_asset_detail,
        ),
    ]
}

fn route(
    method: &str,
    path: &str,
    authorities: &[&str],
    ts_origin: &str,
    handler: super::CustomHandler,
) -> MountedRoute {
    MountedRoute {
        policy: Policy::new(method, path, Channel::Admin, Authn::Session, ts_origin)
            .authorities(authorities)
            .body(BodyRule::None),
        handler: Handler::Custom(handler),
        guard: PrincipalGuard::Staff,
    }
}

/// The last path segment (the `:id` of a detail route).
fn path_id(request: &HttpRequest) -> &str {
    request
        .path()
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or_default()
}

macro_rules! route_handler {
    ($name:ident, $inner:path) => {
        fn $name<'a>(
            state: &'a AppState,
            request: &'a HttpRequest,
            principal: Option<&'a Principal>,
            _payload: Payload,
        ) -> HandlerFuture<'a> {
            Box::pin(async move {
                match $inner(state, request, principal).await {
                    Ok(value) => super::common::json_ok(&value),
                    Err(error) => crate::http::error_response(request, error),
                }
            })
        }
    };
}

macro_rules! list_route {
    ($name:ident, $module:ident) => {
        async fn $name(
            state: &AppState,
            request: &HttpRequest,
            principal: Option<&Principal>,
        ) -> Result<Value, ApiError> {
            $module::list(&state.pools.main, principal, request.query_string()).await
        }
    };
}

list_route!(merchants_list, merchants);
list_route!(applications_list, applications);
list_route!(wallets_list, wallets);

async fn merchant_detail(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    merchants::detail(&state.pools.main, principal, path_id(request)).await
}

async fn application_detail(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    applications::detail(&state.pools.main, principal, path_id(request)).await
}

async fn wallet_detail(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    wallets::detail(&state.pools.main, principal, path_id(request)).await
}

async fn payment_links(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    catalog::payment_links(&state.pools.main, principal, request.query_string()).await
}

async fn pos_terminals(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    catalog::pos_terminals(&state.pools.main, principal, request.query_string()).await
}

async fn access_tokens(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    catalog::access_tokens(&state.pools.main, principal, request.query_string()).await
}

async fn assets(
    state: &AppState,
    _request: &HttpRequest,
    _principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    catalog::assets(&state.pools.main).await
}

async fn asset_detail(
    state: &AppState,
    request: &HttpRequest,
    _principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    catalog::asset_detail(&state.pools.main, path_id(request)).await
}

route_handler!(handle_merchants_list, merchants_list);
route_handler!(handle_merchant_detail, merchant_detail);
route_handler!(handle_applications_list, applications_list);
route_handler!(handle_application_detail, application_detail);
route_handler!(handle_wallets_list, wallets_list);
route_handler!(handle_wallet_detail, wallet_detail);
route_handler!(handle_payment_links, payment_links);
route_handler!(handle_pos_terminals, pos_terminals);
route_handler!(handle_access_tokens, access_tokens);
route_handler!(handle_assets, assets);
route_handler!(handle_asset_detail, asset_detail);

#[cfg(test)]
mod tests {
    use super::*;
    use pg_domain_auth::PrincipalKind;

    fn staff(authorities: &[&str]) -> Principal {
        Principal {
            kind: PrincipalKind::Session,
            user_id: Some("0190f5c0-0000-7000-8000-000000000001".to_owned()),
            role: Some("OPERATOR".to_owned()),
            merchant_id: None,
            application_id: None,
            authorities: authorities
                .iter()
                .map(|value| (*value).to_owned())
                .collect(),
            scopes: Vec::new(),
            token_id: None,
            token_plane: None,
            session_jti: None,
            session_exp: None,
            session_channel: Some(pg_domain_auth::Channel::Admin),
            app_scope_ids: Vec::new(),
        }
    }

    #[test]
    fn every_route_is_an_admin_staff_session_with_no_body() {
        let routes = routes();
        assert_eq!(routes.len(), 11);
        for route in &routes {
            assert_eq!(route.policy.method, "GET");
            assert_eq!(route.policy.channel, Channel::Admin);
            assert_eq!(route.policy.authn, Authn::Session);
            assert_eq!(route.policy.body, BodyRule::None);
            assert_eq!(route.guard, PrincipalGuard::Staff);
            assert!(!route.policy.authorities.is_empty(), "{}", route.key());
            assert!(!route.policy.ts_origin.trim().is_empty());
            assert!(matches!(route.handler, Handler::Custom(_)));
        }
    }

    #[test]
    fn route_keys_are_unique() {
        let mut keys: Vec<String> = routes().into_iter().map(|route| route.key()).collect();
        keys.sort();
        let count = keys.len();
        keys.dedup();
        assert_eq!(keys.len(), count);
    }

    #[test]
    fn authorities_are_or_semantics_and_match_the_ts_handlers() {
        // `/transactions` is mounted by `admin_operations`; assert the same TS authority set there.
        let transactions = crate::routes::admin_operations::routes()
            .into_iter()
            .find(|route| route.policy.path == "/internal/admin/transactions")
            .expect("transactions");
        assert_eq!(
            transactions.policy.authorities,
            vec![
                "attempt:read".to_owned(),
                "merchant:read".to_owned(),
                "finance:read".to_owned()
            ]
        );
        let finance = staff(&["finance:read"]);
        assert!(finance
            .require_authorities(
                &transactions
                    .policy
                    .authorities
                    .iter()
                    .map(String::as_str)
                    .collect::<Vec<_>>()
            )
            .is_ok());
        let nobody = staff(&["gateway:read"]);
        let error = nobody
            .require_authorities(
                &transactions
                    .policy
                    .authorities
                    .iter()
                    .map(String::as_str)
                    .collect::<Vec<_>>(),
            )
            .expect_err("no authority");
        assert_eq!(error.status, 403);
        assert_eq!(error.code, "AUTHORITY_REQUIRED");

        let assets = routes()
            .into_iter()
            .find(|route| route.policy.path == "/internal/admin/assets")
            .expect("assets");
        assert_eq!(assets.policy.authorities, vec!["gateway:read".to_owned()]);
        assert!(staff(&["gateway:read"])
            .require_authorities(&["gateway:read"])
            .is_ok());
        assert!(staff(&["merchant:read"])
            .require_authorities(&["gateway:read"])
            .is_err());
    }

    #[test]
    fn detail_routes_carry_the_id_placeholder() {
        let routes = routes();
        for path in [
            "/internal/admin/merchants/:id",
            "/internal/admin/applications/:id",
            "/internal/admin/wallets/:id",
            "/internal/admin/assets/:id",
        ] {
            assert!(
                routes.iter().any(|route| route.policy.path == path),
                "{path} is not mounted"
            );
        }
    }
}

//! Wave-5 read routes: admin_merchant360.
//!
//! The merchant-360 read surface behind `/merchants` and `/merchants/:id`: the list export, the
//! portfolio summary, the per-merchant summary export and the twelve `:id` aggregates (transactions,
//! applications, wallets, cash-outs, disputes, adjustments, notifications, audit events, stats,
//! pending changes, detail changes and beneficial owners).
//!
//! | Method | Path | TS origin | Authority (OR) |
//! | :--- | :--- | :--- | :--- |
//! | GET | `/internal/admin/merchants/export` | `core-back/api/internal/admin.ts:5346` | `merchant:read` |
//! | GET | `/internal/admin/merchants/summary` | `admin.ts:5492` | `merchant:read` |
//! | GET | `/internal/admin/merchants/summary/export` | `admin.ts:5497` | `merchant:read` |
//! | GET | `/internal/admin/merchants/:id/summary/export` | `admin.ts:5522` | `merchant:read` |
//! | GET | `/internal/admin/merchants/:id/transactions` | `admin.ts:5792` | `merchant:read` |
//! | GET | `/internal/admin/merchants/:id/applications` | `admin.ts:5905` | `merchant:read` |
//! | GET | `/internal/admin/merchants/:id/wallets` | `admin.ts:5969` | `merchant:read` |
//! | GET | `/internal/admin/merchants/:id/cashouts` | `admin.ts:6038` | `merchant:read` |
//! | GET | `/internal/admin/merchants/:id/disputes` | `admin.ts:6092` | `merchant:read` |
//! | GET | `/internal/admin/merchants/:id/adjustments` | `admin.ts:6150` | `merchant:read` |
//! | GET | `/internal/admin/merchants/:id/notifications` | `admin.ts:6209` | `merchant:read` |
//! | GET | `/internal/admin/merchants/:id/audit-events` | `admin.ts:6246` | `merchant:read` |
//! | GET | `/internal/admin/merchants/:id/stats` | `admin.ts:6303` | `merchant:read` |
//! | GET | `/internal/admin/merchants/:id/pending-changes` | `admin.ts:6790` | `merchant:read` |
//! | GET | `/internal/admin/merchants/:id/detail-changes` | `admin.ts:6850` | `merchant:read` |
//! | GET | `/internal/admin/merchants/:id/beneficial-owners` | `adminCommerce.ts:1545` | `merchant:read`, `kyb:read`, `kyb:write` |
//!
//! Every route is an admin staff session route with no request body. The merchant list and the
//! `/merchants/:id` detail stay in `admin_commerce`; their serialisers are reused here through
//! `merchants::list`/`merchants::detail` rather than copied.

#![forbid(unsafe_code)]

pub mod changes;
#[cfg(test)]
pub mod db_tests;
pub mod lists;
pub mod merchant_exports;
pub mod stats;
pub mod support;

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
            "/internal/admin/merchants/export",
            "core-back/api/internal/admin.ts:5346",
            &["merchant:read"],
            handle_merchants_export,
        ),
        route(
            "/internal/admin/merchants/summary",
            "core-back/api/internal/admin.ts:5492",
            &["merchant:read"],
            handle_merchants_summary,
        ),
        route(
            "/internal/admin/merchants/summary/export",
            "core-back/api/internal/admin.ts:5497",
            &["merchant:read"],
            handle_merchants_summary_export,
        ),
        route(
            "/internal/admin/merchants/:id/summary/export",
            "core-back/api/internal/admin.ts:5522",
            &["merchant:read"],
            handle_merchant_summary_export,
        ),
        route(
            "/internal/admin/merchants/:id/transactions",
            "core-back/api/internal/admin.ts:5792",
            &["merchant:read"],
            handle_merchant_transactions,
        ),
        route(
            "/internal/admin/merchants/:id/applications",
            "core-back/api/internal/admin.ts:5905",
            &["merchant:read"],
            handle_merchant_applications,
        ),
        route(
            "/internal/admin/merchants/:id/wallets",
            "core-back/api/internal/admin.ts:5969",
            &["merchant:read"],
            handle_merchant_wallets,
        ),
        route(
            "/internal/admin/merchants/:id/cashouts",
            "core-back/api/internal/admin.ts:6038",
            &["merchant:read"],
            handle_merchant_cashouts,
        ),
        route(
            "/internal/admin/merchants/:id/disputes",
            "core-back/api/internal/admin.ts:6092",
            &["merchant:read"],
            handle_merchant_disputes,
        ),
        route(
            "/internal/admin/merchants/:id/adjustments",
            "core-back/api/internal/admin.ts:6150",
            &["merchant:read"],
            handle_merchant_adjustments,
        ),
        route(
            "/internal/admin/merchants/:id/notifications",
            "core-back/api/internal/admin.ts:6209",
            &["merchant:read"],
            handle_merchant_notifications,
        ),
        route(
            "/internal/admin/merchants/:id/audit-events",
            "core-back/api/internal/admin.ts:6246",
            &["merchant:read"],
            handle_merchant_audit_events,
        ),
        route(
            "/internal/admin/merchants/:id/stats",
            "core-back/api/internal/admin.ts:6303",
            &["merchant:read"],
            handle_merchant_stats,
        ),
        route(
            "/internal/admin/merchants/:id/pending-changes",
            "core-back/api/internal/admin.ts:6790",
            &["merchant:read"],
            handle_merchant_pending_changes,
        ),
        route(
            "/internal/admin/merchants/:id/detail-changes",
            "core-back/api/internal/admin.ts:6850",
            &["merchant:read"],
            handle_merchant_detail_changes,
        ),
        route(
            "/internal/admin/merchants/:id/beneficial-owners",
            "core-back/api/internal/adminCommerce.ts:1545",
            &["merchant:read", "kyb:read", "kyb:write"],
            handle_merchant_beneficial_owners,
        ),
    ]
}

fn route(
    path: &str,
    origin: &str,
    authorities: &[&str],
    handler: super::CustomHandler,
) -> MountedRoute {
    MountedRoute {
        policy: Policy::new("GET", path, Channel::Admin, Authn::Session, origin)
            .authorities(authorities)
            .body(BodyRule::None),
        handler: Handler::Custom(handler),
        guard: PrincipalGuard::Staff,
    }
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

async fn merchants_export(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    merchant_exports::export_merchants(
        &state.pools.main,
        state.pools.audit.is_some(),
        principal,
        request.query_string(),
    )
    .await
}

async fn merchants_summary(
    state: &AppState,
    _request: &HttpRequest,
    _principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    merchant_exports::summary(&state.pools.main).await
}

async fn merchants_summary_export(
    state: &AppState,
    _request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    merchant_exports::summary_export(&state.pools.main, state.pools.audit.is_some(), principal)
        .await
}

async fn merchant_summary_export(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let id = support::merchant_id(request)?;
    merchant_exports::merchant_summary_export(
        &state.pools.main,
        state.pools.audit.is_some(),
        principal,
        &id,
        request.query_string(),
    )
    .await
}

async fn merchant_transactions(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let id = support::merchant_id(request)?;
    lists::transactions(&state.pools.main, principal, &id, request.query_string()).await
}

async fn merchant_applications(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let id = support::merchant_id(request)?;
    lists::applications(&state.pools.main, principal, &id, request.query_string()).await
}

async fn merchant_wallets(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let id = support::merchant_id(request)?;
    lists::wallets_list(&state.pools.main, principal, &id, request.query_string()).await
}

async fn merchant_cashouts(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let id = support::merchant_id(request)?;
    lists::cashouts(&state.pools.main, principal, &id, request.query_string()).await
}

async fn merchant_disputes(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let id = support::merchant_id(request)?;
    lists::disputes(&state.pools.main, principal, &id, request.query_string()).await
}

async fn merchant_adjustments(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let id = support::merchant_id(request)?;
    lists::adjustments(&state.pools.main, principal, &id, request.query_string()).await
}

async fn merchant_notifications(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let id = support::merchant_id(request)?;
    lists::notifications(&state.pools.main, principal, &id, request.query_string()).await
}

async fn merchant_audit_events(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let id = support::merchant_id(request)?;
    lists::audit_events(&state.pools.main, principal, &id, request.query_string()).await
}

async fn merchant_stats(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let id = support::merchant_id(request)?;
    stats::stats(&state.pools.main, principal, &id, request.query_string()).await
}

async fn merchant_pending_changes(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let id = support::merchant_id(request)?;
    changes::pending_changes(&state.pools.main, principal, &id).await
}

async fn merchant_detail_changes(
    state: &AppState,
    request: &HttpRequest,
    principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let id = support::merchant_id(request)?;
    changes::detail_changes(&state.pools.main, principal, &id, request.query_string()).await
}

async fn merchant_beneficial_owners(
    state: &AppState,
    request: &HttpRequest,
    _principal: Option<&Principal>,
) -> Result<Value, ApiError> {
    let id = support::merchant_id(request)?;
    changes::beneficial_owners(&state.pools.main, &id).await
}

route_handler!(handle_merchants_export, merchants_export);
route_handler!(handle_merchants_summary, merchants_summary);
route_handler!(handle_merchants_summary_export, merchants_summary_export);
route_handler!(handle_merchant_summary_export, merchant_summary_export);
route_handler!(handle_merchant_transactions, merchant_transactions);
route_handler!(handle_merchant_applications, merchant_applications);
route_handler!(handle_merchant_wallets, merchant_wallets);
route_handler!(handle_merchant_cashouts, merchant_cashouts);
route_handler!(handle_merchant_disputes, merchant_disputes);
route_handler!(handle_merchant_adjustments, merchant_adjustments);
route_handler!(handle_merchant_notifications, merchant_notifications);
route_handler!(handle_merchant_audit_events, merchant_audit_events);
route_handler!(handle_merchant_stats, merchant_stats);
route_handler!(handle_merchant_pending_changes, merchant_pending_changes);
route_handler!(handle_merchant_detail_changes, merchant_detail_changes);
route_handler!(
    handle_merchant_beneficial_owners,
    merchant_beneficial_owners
);

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

    fn inventory() -> Vec<(&'static str, &'static str, Vec<&'static str>)> {
        vec![
            (
                "/internal/admin/merchants/export",
                "core-back/api/internal/admin.ts:5346",
                vec!["merchant:read"],
            ),
            (
                "/internal/admin/merchants/summary",
                "core-back/api/internal/admin.ts:5492",
                vec!["merchant:read"],
            ),
            (
                "/internal/admin/merchants/summary/export",
                "core-back/api/internal/admin.ts:5497",
                vec!["merchant:read"],
            ),
            (
                "/internal/admin/merchants/:id/summary/export",
                "core-back/api/internal/admin.ts:5522",
                vec!["merchant:read"],
            ),
            (
                "/internal/admin/merchants/:id/transactions",
                "core-back/api/internal/admin.ts:5792",
                vec!["merchant:read"],
            ),
            (
                "/internal/admin/merchants/:id/applications",
                "core-back/api/internal/admin.ts:5905",
                vec!["merchant:read"],
            ),
            (
                "/internal/admin/merchants/:id/wallets",
                "core-back/api/internal/admin.ts:5969",
                vec!["merchant:read"],
            ),
            (
                "/internal/admin/merchants/:id/cashouts",
                "core-back/api/internal/admin.ts:6038",
                vec!["merchant:read"],
            ),
            (
                "/internal/admin/merchants/:id/disputes",
                "core-back/api/internal/admin.ts:6092",
                vec!["merchant:read"],
            ),
            (
                "/internal/admin/merchants/:id/adjustments",
                "core-back/api/internal/admin.ts:6150",
                vec!["merchant:read"],
            ),
            (
                "/internal/admin/merchants/:id/notifications",
                "core-back/api/internal/admin.ts:6209",
                vec!["merchant:read"],
            ),
            (
                "/internal/admin/merchants/:id/audit-events",
                "core-back/api/internal/admin.ts:6246",
                vec!["merchant:read"],
            ),
            (
                "/internal/admin/merchants/:id/stats",
                "core-back/api/internal/admin.ts:6303",
                vec!["merchant:read"],
            ),
            (
                "/internal/admin/merchants/:id/pending-changes",
                "core-back/api/internal/admin.ts:6790",
                vec!["merchant:read"],
            ),
            (
                "/internal/admin/merchants/:id/detail-changes",
                "core-back/api/internal/admin.ts:6850",
                vec!["merchant:read"],
            ),
            (
                "/internal/admin/merchants/:id/beneficial-owners",
                "core-back/api/internal/adminCommerce.ts:1545",
                vec!["merchant:read", "kyb:read", "kyb:write"],
            ),
        ]
    }

    #[test]
    fn all_sixteen_routes_are_mounted() {
        assert_eq!(routes().len(), 16);
        assert_eq!(inventory().len(), 16);
    }

    #[test]
    fn every_route_is_an_admin_staff_session_with_no_body() {
        for route in routes() {
            assert_eq!(route.policy.method, "GET", "{}", route.key());
            assert_eq!(route.policy.channel, Channel::Admin, "{}", route.key());
            assert_eq!(route.policy.authn, Authn::Session, "{}", route.key());
            assert_eq!(route.policy.body, BodyRule::None, "{}", route.key());
            assert_eq!(route.guard, PrincipalGuard::Staff, "{}", route.key());
            assert!(!route.policy.authorities.is_empty(), "{}", route.key());
            assert!(matches!(route.handler, Handler::Custom(_)));
        }
    }

    #[test]
    fn paths_authorities_and_ts_origins_match_the_inventory() {
        let routes = routes();
        for (path, origin, authorities) in inventory() {
            let route = routes
                .iter()
                .find(|route| route.policy.path == path)
                .unwrap_or_else(|| panic!("{path} is not mounted"));
            assert_eq!(route.policy.ts_origin, origin, "{path}");
            assert_eq!(
                route.policy.authorities,
                authorities
                    .iter()
                    .map(|value| (*value).to_owned())
                    .collect::<Vec<_>>(),
                "{path}"
            );
        }
        let mut keys: Vec<String> = routes.iter().map(MountedRoute::key).collect();
        keys.sort();
        let count = keys.len();
        keys.dedup();
        assert_eq!(keys.len(), count);
    }

    #[test]
    fn authorities_are_or_semantics() {
        for route in routes() {
            let allowed: Vec<&str> = route
                .policy
                .authorities
                .iter()
                .map(String::as_str)
                .collect();
            assert!(
                staff(&["merchant:read"])
                    .require_authorities(&allowed)
                    .is_ok(),
                "{}",
                route.key()
            );
            assert!(
                staff(&["gateway:read"])
                    .require_authorities(&allowed)
                    .is_err(),
                "{}",
                route.key()
            );
            let error = staff(&["gateway:read"])
                .require_authorities(&allowed)
                .expect_err("no authority");
            assert_eq!(error.status, 403);
            assert_eq!(error.code, "AUTHORITY_REQUIRED");
        }

        let owners = routes()
            .into_iter()
            .find(|route| route.policy.path == "/internal/admin/merchants/:id/beneficial-owners")
            .expect("beneficial owners");
        let allowed: Vec<&str> = owners
            .policy
            .authorities
            .iter()
            .map(String::as_str)
            .collect();
        assert!(staff(&["kyb:read"]).require_authorities(&allowed).is_ok());
        assert!(staff(&["kyb:write"]).require_authorities(&allowed).is_ok());
        assert!(staff(&["merchant:read"])
            .require_authorities(&allowed)
            .is_ok());

        let summary = routes()
            .into_iter()
            .find(|route| route.policy.path == "/internal/admin/merchants/summary")
            .expect("summary");
        assert_eq!(summary.policy.authorities, vec!["merchant:read".to_owned()]);
        assert!(staff(&["kyb:read"])
            .require_authorities(&["merchant:read"])
            .is_err());
    }

    #[test]
    fn merchant_id_reads_the_segment_after_merchants() {
        use ntex::http::Method;
        use ntex::web::test::TestRequest;
        let id = "0190f5c0-0000-7000-8000-000000000001";
        let request = TestRequest::default()
            .method(Method::GET)
            .uri(&format!("/internal/admin/merchants/{id}/summary/export"))
            .to_http_request();
        assert_eq!(support::merchant_id(&request).expect("id"), id);

        let trailing = TestRequest::default()
            .method(Method::GET)
            .uri(&format!("/internal/admin/merchants/{id}/transactions/"))
            .to_http_request();
        assert_eq!(support::merchant_id(&trailing).expect("id"), id);

        let error = support::merchant_id(
            &TestRequest::default()
                .method(Method::GET)
                .uri("/internal/admin/merchants/export")
                .to_http_request(),
        )
        .expect_err("export is not an id");
        assert_eq!(error.status, 400);
        assert_eq!(error.code, "INVALID_BODY");
    }
}

//! The mounted route table, its policies and the exported policy document (P3-T10).
//!
//! Every mounted route is declared once in [`mounted_routes`] with a [`Policy`]. The dispatcher
//! only serves paths present here, so a handler cannot exist without a policy. `routes export`
//! writes `routes-policy.json`, and `routes check` refuses a document that names a route the binary
//! does not mount (or omits one it does).
//!
//! P4+ adds the domain route modules under `routes/{merchant,checkout,admin}/…`; each of them must
//! register its policies here before a handler is reachable.

#![forbid(unsafe_code)]

pub mod admin_academy;
pub mod admin_aml;
pub mod admin_commerce;
pub mod admin_extras;
pub mod admin_gateways;
pub mod admin_ledger;
pub mod admin_merchant360;
pub mod admin_operations;
pub mod admin_report_engine;
pub mod admin_system;
pub mod auth;
pub mod checkout;
pub mod common;
pub mod health;
pub mod merchant;
pub mod sandbox;
pub mod search;

use std::future::Future;
use std::pin::Pin;

use ntex::web::types::Payload;
use ntex::web::HttpRequest;
use ntex::web::HttpResponse;
use pg_domain_auth::Principal;
use pg_http::request_id::REQUEST_ID_HEADER;
use pg_http::{ApiError, Authn, BodyRule, Channel, Policy, RateClass, RouteRegistry};

use crate::state::AppState;

/// Which principal a route requires after authentication.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrincipalGuard {
    None,
    Staff,
    Merchant,
}

/// A domain route handler. Modules under this directory return one of these; the dispatcher
/// passes the request, the authenticated principal and the (not yet read) payload.
pub type HandlerFuture<'a> = Pin<Box<dyn Future<Output = HttpResponse> + 'a>>;

/// Function pointer for a domain handler. The body is moved in so the handler can choose to read
/// it (with [`crate::http::read_payload`]) or ignore it.
pub type CustomHandler =
    for<'a> fn(&'a AppState, &'a HttpRequest, Option<&'a Principal>, Payload) -> HandlerFuture<'a>;

/// The handler behind a mounted route.
#[derive(Debug, Clone, Copy)]
pub enum Handler {
    Health,
    ChannelHealth,
    AuthMe,
    Custom(CustomHandler),
}

/// One mounted route.
#[derive(Debug, Clone)]
pub struct MountedRoute {
    pub policy: Policy,
    pub handler: Handler,
    pub guard: PrincipalGuard,
}

impl MountedRoute {
    #[must_use]
    pub fn key(&self) -> String {
        self.policy.key()
    }
}

/// Every route this binary mounts.
///
/// `ts_origin` is the exact TypeScript location so the parity harness can diff behaviour.
#[must_use]
pub fn mounted_routes() -> Vec<MountedRoute> {
    let mut routes = vec![
        MountedRoute {
            // `GET /health` needs a valid client certificate but no CN check (chapter 2 §1).
            policy: Policy::new(
                "GET",
                "/health",
                Channel::Internal,
                Authn::None,
                "core-back/index.ts:111",
            )
            .rate_class(RateClass::Default)
            .body(BodyRule::None),
            handler: Handler::Health,
            guard: PrincipalGuard::None,
        },
        MountedRoute {
            policy: Policy::new(
                "GET",
                "/internal/admin/health",
                Channel::Admin,
                Authn::None,
                "core-back/api/internal/admin.ts:245",
            )
            .body(BodyRule::None),
            handler: Handler::ChannelHealth,
            guard: PrincipalGuard::None,
        },
        MountedRoute {
            policy: Policy::new(
                "GET",
                "/internal/merchant/health",
                Channel::Merchant,
                Authn::None,
                "core-back/api/internal/merchant.ts:87",
            )
            .body(BodyRule::None),
            handler: Handler::ChannelHealth,
            guard: PrincipalGuard::None,
        },
        MountedRoute {
            policy: Policy::new(
                "GET",
                "/internal/checkout/health",
                Channel::Checkout,
                Authn::None,
                "core-back/api/internal/checkout.ts:42",
            )
            .body(BodyRule::None),
            handler: Handler::ChannelHealth,
            guard: PrincipalGuard::None,
        },
        MountedRoute {
            // P3 probe for the session double check. TS registers the admin `auth/me` before
            // `requireAuthentication` (static metadata); this Rust route authenticates so the
            // double check is exercised on a mounted route. DEV note in bins/core-rs/README.md.
            policy: Policy::new(
                "GET",
                "/internal/admin/auth/me",
                Channel::Admin,
                Authn::Session,
                "core-back/api/internal/admin.ts:1104",
            )
            .body(BodyRule::None),
            handler: Handler::AuthMe,
            guard: PrincipalGuard::Staff,
        },
    ];
    routes.extend(merchant::routes());
    routes.extend(checkout::routes());
    routes.extend(admin_commerce::routes());
    routes.extend(admin_ledger::routes());
    routes.extend(admin_operations::routes());
    routes.extend(admin_system::routes());
    routes.extend(admin_aml::routes());
    routes.extend(admin_report_engine::routes());
    routes.extend(admin_academy::routes());
    routes.extend(admin_gateways::routes());
    routes.extend(admin_merchant360::routes());
    routes.extend(admin_extras::routes());
    routes.extend(sandbox::routes());
    routes.extend(search::routes());
    routes
}

/// Does a policy path template match a concrete request path?
///
/// Templates use the TypeScript/Express `:name` segment syntax (`/pay/:linkKey/logs/:attemptId`).
/// A parameter matches exactly one non-empty segment; every other segment must be equal. The
/// inventory has no catch-all (`*`) paths, so this deliberately does not implement one: an
/// unmounted wildcard must keep answering `501`/`404` rather than falling through to a handler.
#[must_use]
pub fn path_matches(template: &str, path: &str) -> bool {
    let mut template_segments = template.split('/');
    let mut path_segments = path.split('/');
    loop {
        match (template_segments.next(), path_segments.next()) {
            (Some(template_segment), Some(path_segment)) => {
                if template_segment.starts_with(':') {
                    if template_segment.len() == 1 || path_segment.is_empty() {
                        return false;
                    }
                } else if template_segment != path_segment {
                    return false;
                }
            }
            (None, None) => return true,
            _ => return false,
        }
    }
}

/// Find a mounted route by method and request path.
///
/// A static path always wins over a template with the same segment count (for example
/// `/internal/admin/merchants/export` over `/internal/admin/merchants/:id`), then the first
/// matching template in mount order is used. Handlers extract and validate their own parameters,
/// so an invalid id reaches the handler and answers the same 404 as the TypeScript route.
///
/// The table is built once per process: the dispatcher calls this for every request, and the
/// route list is immutable after startup.
#[must_use]
pub fn find(method: &str, path: &str) -> Option<MountedRoute> {
    static TABLE: std::sync::OnceLock<Vec<MountedRoute>> = std::sync::OnceLock::new();
    let routes = TABLE.get_or_init(mounted_routes);
    routes
        .iter()
        .find(|route| route.policy.method.eq_ignore_ascii_case(method) && route.policy.path == path)
        .or_else(|| {
            routes.iter().find(|route| {
                route.policy.method.eq_ignore_ascii_case(method)
                    && path_matches(&route.policy.path, path)
            })
        })
        .cloned()
}

/// The channel name of a route policy (for the channel-health body).
#[must_use]
pub fn channel_name(channel: Channel) -> &'static str {
    match channel {
        Channel::Admin => "admin",
        Channel::Merchant => "merchant",
        Channel::Checkout => "checkout",
        Channel::Sandbox => "sandbox",
        Channel::Internal => "internal",
        Channel::Public => "public",
    }
}

/// Authorise a request against its policy: authentication, then the channel principal guard.
///
/// Returns the principal when the policy required one.
pub async fn authorize(
    state: &AppState,
    route: &MountedRoute,
    request: &HttpRequest,
) -> Result<Option<pg_domain_auth::Principal>, ApiError> {
    let principal = match route.policy.authn {
        Authn::None => None,
        Authn::Session | Authn::ApiToken | Authn::SessionOrApiToken => {
            let principal = state
                .auth
                .authenticate(request.headers(), chrono::Utc::now())
                .await?;
            if route.policy.authn == Authn::ApiToken
                && principal.kind != pg_domain_auth::PrincipalKind::ApiToken
            {
                return Err(ApiError::new(
                    401,
                    "AUTH_REQUIRED",
                    "An API token is required for this endpoint",
                ));
            }
            Some(principal)
        }
    };
    if let Some(principal) = &principal {
        match route.guard {
            PrincipalGuard::None => {}
            PrincipalGuard::Staff => {
                principal.require_staff().map_err(crate::auth::api_error)?;
            }
            PrincipalGuard::Merchant => {
                principal
                    .require_merchant()
                    .map_err(crate::auth::api_error)?;
            }
        }
        principal
            .require_authorities(
                &route
                    .policy
                    .authorities
                    .iter()
                    .map(String::as_str)
                    .collect::<Vec<_>>(),
            )
            .map_err(crate::auth::api_error)?;
    }
    Ok(principal)
}

/// Build the registry (used by `routes export` and the policy tests).
pub fn registry() -> Result<RouteRegistry, pg_http::policy::RegistryError> {
    let mut registry = RouteRegistry::new();
    for route in mounted_routes() {
        registry.register(route.policy)?;
    }
    Ok(registry)
}

/// `routes export` output.
pub fn export_json() -> Result<String, String> {
    registry()
        .and_then(|registry| {
            registry
                .to_json()
                .map_err(|error| pg_http::policy::RegistryError::Duplicate(error.to_string()))
        })
        .map_err(|error| error.to_string())
}

/// A row of `routes-policy.json`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct ExportedPolicy {
    #[serde(rename = "method")]
    pub method: String,
    #[serde(rename = "path")]
    pub path: String,
    #[serde(rename = "tsOrigin")]
    pub ts_origin: String,
}

/// Check that a `routes-policy.json` document names exactly the mounted routes.
///
/// Fails on an unknown route (a policy that no handler serves), a missing route (a handler without
/// a policy) and a duplicate entry. This is the CI gate of P3-T10.
pub fn check_policy_document(json: &str) -> Result<(), String> {
    let entries: Vec<ExportedPolicy> = serde_json::from_str(json)
        .map_err(|error| format!("routes-policy.json is invalid: {error}"))?;
    let mounted: std::collections::BTreeSet<String> =
        mounted_routes().iter().map(MountedRoute::key).collect();
    let mut seen = std::collections::BTreeSet::new();
    for entry in &entries {
        let key = format!("{} {}", entry.method.to_ascii_uppercase(), entry.path);
        if !mounted.contains(&key) {
            return Err(format!("routes-policy.json names an unknown route: {key}"));
        }
        if !seen.insert(key.clone()) {
            return Err(format!(
                "routes-policy.json contains a duplicate route: {key}"
            ));
        }
        if entry.ts_origin.trim().is_empty() {
            return Err(format!("routes-policy.json route has no tsOrigin: {key}"));
        }
    }
    let missing: Vec<String> = mounted.difference(&seen).cloned().collect();
    if !missing.is_empty() {
        return Err(format!(
            "routes-policy.json is missing mounted route(s): {}",
            missing.join(", ")
        ));
    }
    Ok(())
}

/// The committed policy document, embedded so the binary always carries its own contract.
pub const COMMITTED_POLICY: &str = include_str!("../../routes-policy.json");

/// Header name used by the shell (kept next to the route table so it cannot drift).
pub const X_REQUEST_ID: &str = REQUEST_ID_HEADER;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_mounted_route_has_a_policy_and_an_origin() {
        let routes = mounted_routes();
        assert!(!routes.is_empty());
        for route in &routes {
            assert!(!route.policy.ts_origin.trim().is_empty(), "{}", route.key());
            assert_eq!(
                route.policy.method,
                route.policy.method.to_ascii_uppercase()
            );
            assert!(route.policy.path.starts_with('/'));
        }
    }

    #[test]
    fn registry_rejects_duplicates() {
        let registry = registry().expect("unique routes");
        assert_eq!(registry.policies().len(), mounted_routes().len());
    }

    #[test]
    fn committed_policy_document_is_current() {
        let exported = export_json().expect("export");
        check_policy_document(&exported).expect("self-consistent");
        check_policy_document(COMMITTED_POLICY)
            .expect("routes-policy.json must be regenerated with `core-rs routes export`");
        let committed: serde_json::Value = serde_json::from_str(COMMITTED_POLICY).expect("json");
        let generated: serde_json::Value = serde_json::from_str(&exported).expect("json");
        assert_eq!(
            committed, generated,
            "committed routes-policy.json is stale"
        );
    }

    #[test]
    fn unknown_and_missing_routes_are_refused() {
        let unknown = r#"[{"method":"GET","path":"/nope","tsOrigin":"x"}]"#;
        assert!(check_policy_document(unknown)
            .expect_err("unknown")
            .contains("unknown route"));
        assert!(check_policy_document("[]")
            .expect_err("missing")
            .contains("missing mounted route"));
        assert!(check_policy_document("not json")
            .expect_err("invalid")
            .contains("invalid"));
    }

    #[test]
    fn dispatch_table_finds_the_mounted_routes() {
        assert!(matches!(
            find("GET", "/health").map(|route| route.handler),
            Some(Handler::Health)
        ));
        assert_eq!(
            find("GET", "/internal/admin/auth/me").map(|route| route.guard),
            Some(PrincipalGuard::Staff)
        );
        assert!(find("POST", "/health").is_none());
        assert!(find("GET", "/internal/admin/not-a-real-route").is_none());
    }

    #[test]
    fn path_templates_match_one_segment_per_parameter() {
        assert!(path_matches(
            "/internal/admin/merchants/:id",
            "/internal/admin/merchants/abc"
        ));
        assert!(!path_matches(
            "/internal/admin/merchants/:id",
            "/internal/admin/merchants"
        ));
        assert!(!path_matches(
            "/internal/admin/merchants/:id",
            "/internal/admin/merchants/abc/extra"
        ));
        assert!(!path_matches(
            "/internal/admin/merchants/:id",
            "/internal/admin/merchants/"
        ));
        assert!(path_matches(
            "/internal/checkout/pay/:linkKey/logs/:attemptId",
            "/internal/checkout/pay/pl_1/logs/pa_2"
        ));
        assert!(!path_matches("/health", "/health/"));
        assert!(!path_matches("/a/:", "/a/x"));
    }

    #[test]
    fn dynamic_routes_are_reachable_and_static_routes_win() {
        // A template route resolves without an exact entry.
        let dynamic = find(
            "GET",
            "/internal/admin/merchants/0b7f8f36-5f4e-4f1d-9d6f-6a3f0e1d2c3b",
        )
        .expect("dynamic merchant route");
        assert_eq!(dynamic.policy.path, "/internal/admin/merchants/:id");
        // `/disputes/export` also matches `/disputes/:id`; the static route must win.
        let export = find("GET", "/internal/admin/disputes/export").expect("export route");
        assert_eq!(export.policy.path, "/internal/admin/disputes/export");
        // Method still gates the lookup.
        assert!(find("POST", "/internal/admin/merchants/abc").is_none());
    }
}

//! Wave-5 read routes: the admin "extras" that no family module owns.
//!
//! This module mounts the remaining `GET /internal/admin/**` handlers from the route inventory that
//! are not part of a family module:
//!
//! - the four file-bytes downloads (catalog asset, KYB document, dispute evidence and reconciliation
//!   statement) backed by the shared object-storage vault;
//! - the inbound provider event list and its redacted detail;
//! - the backup daemon overview and the local backup catalog;
//! - the gateway/rail/route/inquiry/user/settings collection exports and their summary exports;
//! - the dashboard recent-activity export and the per-gateway health read.
//!
//! Every route keeps the TypeScript policy (`Channel::Admin`, `Authn::Session`, `PrincipalGuard::Staff`,
//! the exact authority list and `tsOrigin`), the list/export envelopes and the audit rows the TS
//! export handlers write. Routes declared with a `:param` policy are reached through the dispatcher
//! template matcher; the CSV/JSON exports are exact paths.
//!
//! Not mounted here on purpose: the merchant-360 routes (`admin_merchant360`), the sandbox routes
//! (`sandbox`) and `/report-engine/**` (`report_engine_extras`).

#![forbid(unsafe_code)]

mod backup_client;
mod backups;
mod content;
mod gateways;
mod inbound;
mod platform;
mod storage;
mod support;

#[cfg(test)]
mod tests;

use ntex::web::types::Payload;
use ntex::web::HttpRequest;
use pg_domain_auth::Principal;

use pg_http::{Authn, BodyRule, Channel, Policy};

use super::{CustomHandler, Handler, HandlerFuture, MountedRoute, PrincipalGuard};
use crate::state::AppState;

/// Wrap a `Result<Value, ApiError>` handler in the mounted-route contract.
macro_rules! json_handler {
    ($name:ident, $inner:path) => {
        fn $name<'a>(
            state: &'a AppState,
            request: &'a HttpRequest,
            principal: Option<&'a Principal>,
            _payload: Payload,
        ) -> HandlerFuture<'a> {
            Box::pin(async move {
                match $inner(state, request, principal).await {
                    Ok(value) => crate::routes::common::json_ok(&value),
                    Err(error) => crate::http::error_response(request, error),
                }
            })
        }
    };
}

json_handler!(inbound_list, inbound::list);
json_handler!(inbound_detail, inbound::detail);
json_handler!(backups_overview, backups::overview);
json_handler!(backups_catalog, backups::catalog);
json_handler!(gateway_health, gateways::gateway_health);
json_handler!(gateways_export, gateways::gateways_export);
json_handler!(gateways_summary_export, gateways::gateways_summary_export);
json_handler!(rails_export, gateways::rails_export);
json_handler!(rails_summary_export, gateways::rails_summary_export);
json_handler!(routes_export, gateways::routes_export);
json_handler!(routes_summary_export, gateways::routes_summary_export);
json_handler!(inquiry_summary_export, gateways::inquiry_summary_export);
json_handler!(users_export, platform::users_export);
json_handler!(users_summary_export, platform::users_summary_export);
json_handler!(recent_activity_export, platform::recent_activity_export);
json_handler!(settings_export, platform::settings_export);
json_handler!(settings_summary_export, platform::settings_summary_export);
json_handler!(
    checkout_support_summary_export,
    platform::checkout_support_summary_export
);

fn asset_content<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(content::asset_content(state, request, principal))
}

fn kyb_content<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(content::kyb_content(state, request, principal))
}

fn dispute_attachment_content<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(content::dispute_attachment_content(
        state, request, principal,
    ))
}

fn reconciliation_statement<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: Payload,
) -> HandlerFuture<'a> {
    Box::pin(content::reconciliation_statement(state, request, principal))
}

fn route(
    path: &str,
    ts_origin: &str,
    authorities: &[&str],
    handler: CustomHandler,
) -> MountedRoute {
    MountedRoute {
        policy: Policy::new("GET", path, Channel::Admin, Authn::Session, ts_origin)
            .authorities(authorities)
            .body(BodyRule::None),
        handler: Handler::Custom(handler),
        guard: PrincipalGuard::Staff,
    }
}

/// Routes owned by this module.
#[must_use]
pub fn routes() -> Vec<MountedRoute> {
    vec![
        route(
            "/internal/admin/assets/:id/content",
            "core-back/api/internal/admin.ts:16982",
            &["gateway:read"],
            asset_content,
        ),
        route(
            "/internal/admin/kyb-documents/:id/content",
            "core-back/api/internal/admin.ts:3418",
            &["kyb:read", "compliance:read"],
            kyb_content,
        ),
        route(
            "/internal/admin/disputes/:id/attachments/:attachmentId/content",
            "core-back/api/internal/admin.ts:18001",
            &["dispute:read"],
            dispute_attachment_content,
        ),
        route(
            "/internal/admin/reconciliation/runs/:id/statement",
            "core-back/api/internal/admin.ts:17426",
            &["reconciliation:read"],
            reconciliation_statement,
        ),
        route(
            "/internal/admin/inbound-events",
            "core-back/api/internal/adminOperations.ts:266",
            &["attempt:read", "case:read"],
            inbound_list,
        ),
        route(
            "/internal/admin/inbound-events/:id",
            "core-back/api/internal/adminOperations.ts:336",
            &["attempt:read", "case:read"],
            inbound_detail,
        ),
        route(
            "/internal/admin/system/backups/overview",
            "core-back/api/internal/backups.ts:236",
            &["security:read", "gateway:read"],
            backups_overview,
        ),
        route(
            "/internal/admin/system/backups/catalog",
            "core-back/api/internal/backups.ts:580",
            &["security:read", "gateway:read"],
            backups_catalog,
        ),
        route(
            "/internal/admin/gateways/:id/health",
            "core-back/api/internal/adminOperations.ts:554",
            &["gateway:read"],
            gateway_health,
        ),
        route(
            "/internal/admin/gateways/export",
            "core-back/api/internal/admin.ts:13064",
            &["gateway:read"],
            gateways_export,
        ),
        route(
            "/internal/admin/gateways/summary/export",
            "core-back/api/internal/admin.ts:13188",
            &["gateway:read"],
            gateways_summary_export,
        ),
        route(
            "/internal/admin/rails/export",
            "core-back/api/internal/admin.ts:15910",
            &["gateway:read"],
            rails_export,
        ),
        route(
            "/internal/admin/rails/summary/export",
            "core-back/api/internal/admin.ts:16022",
            &["gateway:read"],
            rails_summary_export,
        ),
        route(
            "/internal/admin/routes/export",
            "core-back/api/internal/admin.ts:16338",
            &["gateway:read"],
            routes_export,
        ),
        route(
            "/internal/admin/routes/summary/export",
            "core-back/api/internal/admin.ts:16432",
            &["gateway:read"],
            routes_summary_export,
        ),
        route(
            "/internal/admin/gateway-inquiries/summary/export",
            "core-back/api/internal/admin.ts:11952",
            &["case:read", "operator:read"],
            inquiry_summary_export,
        ),
        route(
            "/internal/admin/users/export",
            "core-back/api/internal/admin.ts:1689",
            &["user:read", "security:read"],
            users_export,
        ),
        route(
            "/internal/admin/users/summary/export",
            "core-back/api/internal/admin.ts:1780",
            &["user:read", "security:read"],
            users_summary_export,
        ),
        route(
            "/internal/admin/stats/recent-activity/export",
            "core-back/api/internal/admin.ts:1277",
            &["security:read"],
            recent_activity_export,
        ),
        route(
            "/internal/admin/settings/export",
            "core-back/api/internal/admin.ts:20477",
            &["settings:read"],
            settings_export,
        ),
        route(
            "/internal/admin/settings/summary/export",
            "core-back/api/internal/admin.ts:20548",
            &["settings:read"],
            settings_summary_export,
        ),
        route(
            "/internal/admin/settings/checkout-support/summary/export",
            "core-back/api/internal/admin.ts:19858",
            &["settings:read"],
            checkout_support_summary_export,
        ),
    ]
}

/// The number of routes this module mounts (asserted by the tests and the hand-off report).
pub const ROUTE_COUNT: usize = 22;

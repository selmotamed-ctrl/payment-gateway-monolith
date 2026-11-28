//! The merchant edge route table.
//!
//! Port of `merchant-back/api/**` registration order. `GET /health` plus the 105 API routes of
//! `backend-rs/tests/golden-vectors/route-inventory/edge-routes.json` (`service:
//! "merchant-back"`), plus the `/sandbox/*` wildcard the inventory cannot enumerate.
//!
//! Registration order matters exactly like Express: every static path is declared before a
//! dynamic pattern that could shadow it (the report-engine chrome/migration routes).

#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::sync::LazyLock;

use pg_upstream::CoreMethod;

use crate::contract::{
    core_application_create_schema, core_application_patch_schema, core_beneficial_owner_schema,
    core_cashout_create_schema, core_credential_set_create_schema,
    core_credential_set_update_schema, core_email_resend_schema, core_email_verify_schema,
    core_google_exchange_schema, core_google_schema, core_invitation_accept_schema,
    core_join_request_schema, core_link_create_schema, core_login_schema, core_mfa_resend_schema,
    core_mfa_schema, core_onboarding_submit_schema, core_password_forgot_schema,
    core_password_reset_schema, core_pos_terminal_create_schema, core_pos_terminal_patch_schema,
    core_register_schema, core_token_create_schema, core_token_ips_schema, core_user_create_schema,
    core_user_patch_by_id_schema, core_verify_identity_schema, core_wallet_create_schema,
    to_core_application_create, to_core_application_patch, to_core_cashout_create,
    to_core_credential_set_create, to_core_credential_set_update, to_core_pos_terminal_create,
    to_core_user_create, to_core_user_patch_by_id, to_core_wallet_create,
};
use crate::forward::{capture, ForwardSpec, PathTemplate};
use crate::schemas;

/// The middleware a route lives behind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteGroup {
    Public,
    Auth,
    Onboarding,
    Protected,
    External,
}

/// Special handlers that are not a plain proxy.
#[derive(Debug, Clone)]
pub enum Action {
    Health,
    Forward(ForwardSpec),
    Logout,
    GoogleCallback,
    BulkUsers,
    TokenCreate(ForwardSpec),
    KybDocument,
    DisputeEvidence,
    DisputeAttachment,
    SandboxUpload,
    SandboxProxy,
    PosStream {
        path: PathTemplate,
        params: crate::validate::Schema,
    },
    AttachmentContent {
        path: PathTemplate,
        params: crate::validate::Schema,
    },
}

/// One registered route.
#[derive(Debug, Clone)]
pub struct RouteDef {
    pub method: &'static str,
    pub pattern: &'static str,
    pub template: PathTemplate,
    pub group: RouteGroup,
    pub action: Action,
}

impl RouteDef {
    fn new(method: &'static str, pattern: &'static str, group: RouteGroup, action: Action) -> Self {
        Self {
            method,
            pattern,
            template: PathTemplate::parse(pattern),
            group,
            action,
        }
    }
}

/// The body policy of one request, derived from the matched route.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyPolicy {
    None,
    /// Buffered JSON with a byte cap.
    Json(u64),
    /// Multipart with the merchant upload budget.
    Multipart,
}

/// The report-engine sandbox mirror keeps the 24 MiB core JSON budget.
pub const REPORT_ENGINE_JSON_LIMIT: u64 = 24 * 1024 * 1024;

/// All routes, in Express registration order.
pub static ROUTES: LazyLock<Vec<RouteDef>> = LazyLock::new(build_routes);

/// Match a request path/method; the first matching registration wins.
#[must_use]
pub fn match_route(
    method: &str,
    path: &str,
) -> Option<(&'static RouteDef, BTreeMap<String, String>)> {
    for route in ROUTES.iter() {
        if route.action_is_sandbox() && route.template.matches_prefix(path) {
            let mut params = BTreeMap::new();
            let _ = capture(&route.template, path, &mut params);
            return Some((route, params));
        }
        // Express answers HEAD with the GET handler.
        let method_matches = route.method == method || (method == "HEAD" && route.method == "GET");
        if !method_matches {
            continue;
        }
        let mut params = BTreeMap::new();
        if capture(&route.template, path, &mut params) {
            return Some((route, params));
        }
    }
    None
}

impl RouteDef {
    fn action_is_sandbox(&self) -> bool {
        matches!(self.action, Action::SandboxProxy)
    }
}

fn forward(spec: ForwardSpec) -> Action {
    Action::Forward(spec)
}

/// The route table.
#[allow(clippy::too_many_lines, clippy::vec_init_then_push)]
fn build_routes() -> Vec<RouteDef> {
    use schemas as s;
    use RouteGroup::{Auth, External, Onboarding, Protected, Public};

    let mut routes = Vec::new();

    routes.push(RouteDef::new("GET", "/health", Public, Action::Health));

    // ---------------------------------------------------------------- auth
    routes.push(RouteDef::new(
        "POST",
        "/api/v1/merchant/auth/logout",
        Auth,
        Action::Logout,
    ));
    routes.push(RouteDef::new(
        "POST",
        "/api/v1/merchant/auth/register",
        Auth,
        forward(
            ForwardSpec::new(
                CoreMethod::Post,
                "/api/v1/merchant/auth/register",
                "/internal/merchant/auth/register",
            )
            .body(s::register_schema())
            .core_schema(core_register_schema())
            .public_route()
            .status(201),
        ),
    ));
    routes.push(RouteDef::new(
        "POST",
        "/api/v1/merchant/auth/verify-identity",
        Auth,
        forward(
            ForwardSpec::new(
                CoreMethod::Post,
                "/api/v1/merchant/auth/verify-identity",
                "/internal/merchant/auth/verify-identity",
            )
            .body(s::verify_identity_schema())
            .core_schema(core_verify_identity_schema())
            .public_route(),
        ),
    ));
    routes.push(RouteDef::new(
        "POST",
        "/api/v1/merchant/auth/accept-invitation",
        Auth,
        forward(
            ForwardSpec::new(
                CoreMethod::Post,
                "/api/v1/merchant/auth/accept-invitation",
                "/internal/merchant/auth/accept-invitation",
            )
            .body(s::accept_invitation_schema())
            .core_schema(core_invitation_accept_schema())
            .public_route(),
        ),
    ));
    routes.push(RouteDef::new(
        "POST",
        "/api/v1/merchant/auth/login",
        Auth,
        forward(
            ForwardSpec::new(
                CoreMethod::Post,
                "/api/v1/merchant/auth/login",
                "/internal/merchant/auth/login",
            )
            .body(s::login_schema())
            .core_schema(core_login_schema())
            .public_route()
            .capture_cookie(),
        ),
    ));
    routes.push(RouteDef::new(
        "POST",
        "/api/v1/merchant/auth/google/start",
        Auth,
        forward(
            ForwardSpec::new(
                CoreMethod::Post,
                "/api/v1/merchant/auth/google/start",
                "/internal/merchant/auth/google/start",
            )
            .body(s::google_start_schema())
            .core_schema(core_google_schema())
            .public_route(),
        ),
    ));
    routes.push(RouteDef::new(
        "POST",
        "/api/v1/merchant/auth/google",
        Auth,
        forward(
            ForwardSpec::new(
                CoreMethod::Post,
                "/api/v1/merchant/auth/google",
                "/internal/merchant/auth/google",
            )
            .body(s::google_start_schema())
            .core_schema(core_google_schema())
            .public_route(),
        ),
    ));
    routes.push(RouteDef::new(
        "GET",
        "/api/v1/merchant/auth/google/callback",
        Auth,
        Action::GoogleCallback,
    ));
    routes.push(RouteDef::new(
        "POST",
        "/api/v1/merchant/auth/google/exchange",
        Auth,
        forward(
            ForwardSpec::new(
                CoreMethod::Post,
                "/api/v1/merchant/auth/google/exchange",
                "/internal/merchant/auth/google/exchange",
            )
            .body(s::google_exchange_schema())
            .core_schema(core_google_exchange_schema())
            .public_route()
            .capture_cookie(),
        ),
    ));
    routes.push(RouteDef::new(
        "POST",
        "/api/v1/merchant/auth/email/verify",
        Auth,
        forward(
            ForwardSpec::new(
                CoreMethod::Post,
                "/api/v1/merchant/auth/email/verify",
                "/internal/merchant/auth/email/verify",
            )
            .body(s::email_verify_schema())
            .core_schema(core_email_verify_schema())
            .public_route(),
        ),
    ));
    routes.push(RouteDef::new(
        "POST",
        "/api/v1/merchant/auth/email/resend",
        Auth,
        forward(
            ForwardSpec::new(
                CoreMethod::Post,
                "/api/v1/merchant/auth/email/resend",
                "/internal/merchant/auth/email/resend",
            )
            .body(s::email_resend_schema())
            .core_schema(core_email_resend_schema())
            .public_route()
            .status(202),
        ),
    ));
    routes.push(RouteDef::new(
        "POST",
        "/api/v1/merchant/auth/password/forgot",
        Auth,
        forward(
            ForwardSpec::new(
                CoreMethod::Post,
                "/api/v1/merchant/auth/password/forgot",
                "/internal/merchant/auth/password/forgot",
            )
            .body(s::password_forgot_schema())
            .core_schema(core_password_forgot_schema())
            .public_route()
            .status(202),
        ),
    ));
    routes.push(RouteDef::new(
        "POST",
        "/api/v1/merchant/auth/password/reset",
        Auth,
        forward(
            ForwardSpec::new(
                CoreMethod::Post,
                "/api/v1/merchant/auth/password/reset",
                "/internal/merchant/auth/password/reset",
            )
            .body(s::password_reset_schema())
            .core_schema(core_password_reset_schema())
            .public_route(),
        ),
    ));
    routes.push(RouteDef::new(
        "GET",
        "/api/v1/merchant/auth/me",
        Auth,
        forward(
            ForwardSpec::new(
                CoreMethod::Get,
                "/api/v1/merchant/auth/me",
                "/internal/merchant/auth/me",
            )
            .public_route(),
        ),
    ));
    routes.push(RouteDef::new(
        "POST",
        "/api/v1/merchant/auth/mfa/verify",
        Auth,
        forward(
            ForwardSpec::new(
                CoreMethod::Post,
                "/api/v1/merchant/auth/mfa/verify",
                "/internal/merchant/auth/mfa/verify",
            )
            .body(s::mfa_schema())
            .core_schema(core_mfa_schema())
            .public_route()
            .capture_cookie(),
        ),
    ));
    routes.push(RouteDef::new(
        "POST",
        "/api/v1/merchant/auth/mfa/resend",
        Auth,
        forward(
            ForwardSpec::new(
                CoreMethod::Post,
                "/api/v1/merchant/auth/mfa/resend",
                "/internal/merchant/auth/mfa/resend",
            )
            .body(s::mfa_resend_schema())
            .core_schema(core_mfa_resend_schema())
            .public_route(),
        ),
    ));

    // ----------------------------------------------------------- onboarding
    routes.push(RouteDef::new(
        "GET",
        "/api/v1/merchant/onboarding/join-request",
        Onboarding,
        forward(ForwardSpec::new(
            CoreMethod::Get,
            "/api/v1/merchant/onboarding/join-request",
            "/internal/merchant/onboarding/join-request",
        )),
    ));
    routes.push(RouteDef::new(
        "PUT",
        "/api/v1/merchant/onboarding/join-request",
        Onboarding,
        forward(
            ForwardSpec::new(
                CoreMethod::Put,
                "/api/v1/merchant/onboarding/join-request",
                "/internal/merchant/onboarding/join-request",
            )
            .body(s::join_request_schema())
            .core_schema(core_join_request_schema()),
        ),
    ));
    routes.push(RouteDef::new(
        "POST",
        "/api/v1/merchant/onboarding/join-request/withdraw",
        Onboarding,
        forward(
            ForwardSpec::new(
                CoreMethod::Post,
                "/api/v1/merchant/onboarding/join-request/withdraw",
                "/internal/merchant/onboarding/join-request/withdraw",
            )
            .body(s::withdraw_schema())
            .core_schema(s::withdraw_schema()),
        ),
    ));
    routes.push(RouteDef::new(
        "GET",
        "/api/v1/merchant/onboarding/kyb-revalidations",
        Onboarding,
        forward(ForwardSpec::new(
            CoreMethod::Get,
            "/api/v1/merchant/onboarding/kyb-revalidations",
            "/internal/merchant/onboarding/kyb-revalidations",
        )),
    ));
    routes.push(RouteDef::new(
        "POST",
        "/api/v1/merchant/onboarding/kyb-documents",
        Onboarding,
        Action::KybDocument,
    ));
    routes.push(RouteDef::new(
        "GET",
        "/api/v1/merchant/onboarding/beneficial-owners",
        Onboarding,
        forward(ForwardSpec::new(
            CoreMethod::Get,
            "/api/v1/merchant/onboarding/beneficial-owners",
            "/internal/merchant/onboarding/beneficial-owners",
        )),
    ));
    routes.push(RouteDef::new(
        "POST",
        "/api/v1/merchant/onboarding/beneficial-owners",
        Onboarding,
        forward(
            ForwardSpec::new(
                CoreMethod::Post,
                "/api/v1/merchant/onboarding/beneficial-owners",
                "/internal/merchant/onboarding/beneficial-owners",
            )
            .body(s::beneficial_owner_schema())
            .core_schema(core_beneficial_owner_schema())
            .status(201),
        ),
    ));
    routes.push(RouteDef::new(
        "DELETE",
        "/api/v1/merchant/onboarding/beneficial-owners/:id",
        Onboarding,
        forward(
            ForwardSpec::new(
                CoreMethod::Delete,
                "/api/v1/merchant/onboarding/beneficial-owners/:id",
                "/internal/merchant/onboarding/beneficial-owners/:id",
            )
            .params(s::id_params_schema()),
        ),
    ));
    routes.push(RouteDef::new(
        "POST",
        "/api/v1/merchant/onboarding/submit",
        Onboarding,
        forward(
            ForwardSpec::new(
                CoreMethod::Post,
                "/api/v1/merchant/onboarding/submit",
                "/internal/merchant/onboarding/submit",
            )
            .body(s::onboarding_submit_schema())
            .core_schema(core_onboarding_submit_schema()),
        ),
    ));

    // -------------------------------------------------------------- wallets
    routes.push(RouteDef::new(
        "GET",
        "/api/v1/merchant/wallets",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Get,
                "/api/v1/merchant/wallets",
                "/internal/merchant/wallets",
            )
            .query(s::list_query_schema()),
        ),
    ));
    routes.push(RouteDef::new(
        "POST",
        "/api/v1/merchant/wallets",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Post,
                "/api/v1/merchant/wallets",
                "/internal/merchant/wallets",
            )
            .body(s::wallet_create_schema())
            .mapper(to_core_wallet_create)
            .core_schema(core_wallet_create_schema())
            .status(201),
        ),
    ));
    routes.push(RouteDef::new(
        "GET",
        "/api/v1/merchant/wallets/:id/balance",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Get,
                "/api/v1/merchant/wallets/:id/balance",
                "/internal/merchant/wallets/:id/balance",
            )
            .params(s::wallet_params_schema()),
        ),
    ));
    routes.push(RouteDef::new(
        "GET",
        "/api/v1/merchant/wallets/:id/statements",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Get,
                "/api/v1/merchant/wallets/:id/statements",
                "/internal/merchant/wallets/:id/statements",
            )
            .params(s::wallet_params_schema())
            .query(s::statement_query_schema()),
        ),
    ));
    routes.push(RouteDef::new(
        "GET",
        "/api/v1/merchant/wallets/:id/statements/:month/export",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Get,
                "/api/v1/merchant/wallets/:id/statements/:month/export",
                "/internal/merchant/wallets/:id/statements/:month/export",
            )
            .params(s::wallet_month_params_schema()),
        ),
    ));
    routes.push(RouteDef::new(
        "GET",
        "/api/v1/merchant/wallets/:id",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Get,
                "/api/v1/merchant/wallets/:id",
                "/internal/merchant/wallets/:id",
            )
            .params(s::wallet_params_schema()),
        ),
    ));

    // --------------------------------------------------------- applications
    routes.push(RouteDef::new(
        "GET",
        "/api/v1/merchant/applications",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Get,
                "/api/v1/merchant/applications",
                "/internal/merchant/applications",
            )
            .query(s::list_query_schema()),
        ),
    ));
    routes.push(RouteDef::new(
        "POST",
        "/api/v1/merchant/applications",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Post,
                "/api/v1/merchant/applications",
                "/internal/merchant/applications",
            )
            .body(s::application_create_schema())
            .mapper(to_core_application_create)
            .core_schema(core_application_create_schema())
            .status(201),
        ),
    ));
    routes.push(RouteDef::new(
        "PATCH",
        "/api/v1/merchant/applications/:id",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Patch,
                "/api/v1/merchant/applications/:id",
                "/internal/merchant/applications/:id",
            )
            .params(s::wallet_params_schema())
            .body(s::application_patch_schema())
            .mapper(to_core_application_patch)
            .core_schema(core_application_patch_schema())
            .relay(),
        ),
    ));
    routes.push(RouteDef::new(
        "GET",
        "/api/v1/merchant/applications/:id",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Get,
                "/api/v1/merchant/applications/:id",
                "/internal/merchant/applications/:id",
            )
            .params(s::wallet_params_schema()),
        ),
    ));

    // ---------------------------------------------------------------- links
    routes.push(RouteDef::new(
        "GET",
        "/api/v1/merchant/links",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Get,
                "/api/v1/merchant/links",
                "/internal/merchant/links",
            )
            .query(s::link_list_query_schema()),
        ),
    ));
    routes.push(RouteDef::new(
        "POST",
        "/api/v1/merchant/links",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Post,
                "/api/v1/merchant/links",
                "/internal/merchant/links",
            )
            .body(s::link_create_schema())
            .core_schema(core_link_create_schema())
            .status(201),
        ),
    ));
    routes.push(RouteDef::new(
        "GET",
        "/api/v1/merchant/links/:id",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Get,
                "/api/v1/merchant/links/:id",
                "/internal/merchant/links/:id",
            )
            .params(s::wallet_params_schema()),
        ),
    ));
    routes.push(RouteDef::new(
        "POST",
        "/api/v1/merchant/links/:id/cancel",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Post,
                "/api/v1/merchant/links/:id/cancel",
                "/internal/merchant/links/:id/cancel",
            )
            .params(s::wallet_params_schema())
            .body(s::cancel_schema()),
        ),
    ));
    routes.push(RouteDef::new(
        "GET",
        "/api/v1/merchant/links/:id/attempts",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Get,
                "/api/v1/merchant/links/:id/attempts",
                "/internal/merchant/links/:id/attempts",
            )
            .params(s::wallet_params_schema()),
        ),
    ));

    // ------------------------------------------------------------------ POS
    routes.push(RouteDef::new(
        "GET",
        "/api/v1/merchant/pos/terminals",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Get,
                "/api/v1/merchant/pos/terminals",
                "/internal/merchant/pos/terminals",
            )
            .query(s::list_query_schema()),
        ),
    ));
    routes.push(RouteDef::new(
        "POST",
        "/api/v1/merchant/pos/terminals",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Post,
                "/api/v1/merchant/pos/terminals",
                "/internal/merchant/pos/terminals",
            )
            .body(s::terminal_create_schema())
            .mapper(to_core_pos_terminal_create)
            .core_schema(core_pos_terminal_create_schema())
            .status(201),
        ),
    ));
    routes.push(RouteDef::new(
        "PATCH",
        "/api/v1/merchant/pos/terminals/:id",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Patch,
                "/api/v1/merchant/pos/terminals/:id",
                "/internal/merchant/pos/terminals/:id",
            )
            .params(s::wallet_params_schema())
            .body(s::terminal_patch_schema())
            .core_schema(core_pos_terminal_patch_schema()),
        ),
    ));
    routes.push(RouteDef::new(
        "POST",
        "/api/v1/merchant/pos/terminals/:id/screens",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Post,
                "/api/v1/merchant/pos/terminals/:id/screens",
                "/internal/merchant/pos/terminals/:id/screens",
            )
            .params(s::wallet_params_schema())
            .body(s::screen_create_schema())
            .status(201),
        ),
    ));
    routes.push(RouteDef::new(
        "GET",
        "/api/v1/merchant/pos/screens/:screenCode/stream",
        Protected,
        Action::PosStream {
            path: PathTemplate::parse("/internal/merchant/pos/screens/:screenCode/stream"),
            params: s::screen_params_schema(),
        },
    ));
    routes.push(RouteDef::new(
        "GET",
        "/api/v1/merchant/pos/terminals/:id",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Get,
                "/api/v1/merchant/pos/terminals/:id",
                "/internal/merchant/pos/terminals/:id",
            )
            .params(s::wallet_params_schema()),
        ),
    ));

    // ------------------------------------------------------------- payments
    routes.push(RouteDef::new(
        "GET",
        "/api/v1/merchant/payments",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Get,
                "/api/v1/merchant/payments",
                "/internal/merchant/payments",
            )
            .query(s::payment_query_schema()),
        ),
    ));

    // ------------------------------------------------------------- disputes
    routes.push(RouteDef::new(
        "GET",
        "/api/v1/merchant/disputes",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Get,
                "/api/v1/merchant/disputes",
                "/internal/merchant/disputes",
            )
            .query(s::dispute_query_schema()),
        ),
    ));
    routes.push(RouteDef::new(
        "POST",
        "/api/v1/merchant/disputes/:id/evidence",
        Protected,
        Action::DisputeEvidence,
    ));
    routes.push(RouteDef::new(
        "GET",
        "/api/v1/merchant/disputes/:id/attachments",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Get,
                "/api/v1/merchant/disputes/:id/attachments",
                "/internal/merchant/disputes/:id/attachments",
            )
            .params(s::wallet_params_schema()),
        ),
    ));
    routes.push(RouteDef::new(
        "POST",
        "/api/v1/merchant/disputes/:id/attachments",
        Protected,
        Action::DisputeAttachment,
    ));
    routes.push(RouteDef::new(
        "GET",
        "/api/v1/merchant/disputes/:id/attachments/:attachmentId/content",
        Protected,
        Action::AttachmentContent {
            path: PathTemplate::parse(
                "/internal/merchant/disputes/:id/attachments/:attachmentId/content",
            ),
            params: s::attachment_params_schema(),
        },
    ));
    routes.push(RouteDef::new(
        "DELETE",
        "/api/v1/merchant/disputes/:id/attachments/:attachmentId",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Delete,
                "/api/v1/merchant/disputes/:id/attachments/:attachmentId",
                "/internal/merchant/disputes/:id/attachments/:attachmentId",
            )
            .params(s::attachment_params_schema()),
        ),
    ));
    routes.push(RouteDef::new(
        "GET",
        "/api/v1/merchant/disputes/:id",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Get,
                "/api/v1/merchant/disputes/:id",
                "/internal/merchant/disputes/:id",
            )
            .params(s::wallet_params_schema()),
        ),
    ));

    // ------------------------------------------------------------- cash-outs
    routes.push(RouteDef::new(
        "GET",
        "/api/v1/merchant/cashouts",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Get,
                "/api/v1/merchant/cashouts",
                "/internal/merchant/cashouts",
            )
            .query(s::cashout_query_schema()),
        ),
    ));
    routes.push(RouteDef::new(
        "POST",
        "/api/v1/merchant/cashouts",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Post,
                "/api/v1/merchant/cashouts",
                "/internal/merchant/cashouts",
            )
            .body(s::cashout_create_schema())
            .mapper(to_core_cashout_create)
            .core_schema(core_cashout_create_schema())
            .idempotency_header()
            .status(201),
        ),
    ));

    // ---------------------------------------------------------------- tokens
    routes.push(RouteDef::new(
        "GET",
        "/api/v1/merchant/tokens",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Get,
                "/api/v1/merchant/tokens",
                "/internal/merchant/tokens",
            )
            .query(s::list_query_schema()),
        ),
    ));
    routes.push(RouteDef::new(
        "POST",
        "/api/v1/merchant/tokens",
        Protected,
        Action::TokenCreate(
            ForwardSpec::new(
                CoreMethod::Post,
                "/api/v1/merchant/tokens",
                "/internal/merchant/tokens",
            )
            .core_schema(core_token_create_schema())
            .status(201),
        ),
    ));
    routes.push(RouteDef::new(
        "PUT",
        "/api/v1/merchant/tokens/:id/ips",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Put,
                "/api/v1/merchant/tokens/:id/ips",
                "/internal/merchant/tokens/:id/ips",
            )
            .params(s::wallet_params_schema())
            .body(s::token_ips_schema())
            .enrich(s::validate_token_ips)
            .core_schema(core_token_ips_schema()),
        ),
    ));
    routes.push(RouteDef::new(
        "DELETE",
        "/api/v1/merchant/tokens/:id",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Delete,
                "/api/v1/merchant/tokens/:id",
                "/internal/merchant/tokens/:id",
            )
            .params(s::wallet_params_schema()),
        ),
    ));

    // -------------------------------------------------------- credential sets
    routes.push(RouteDef::new(
        "GET",
        "/api/v1/merchant/credential-sets",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Get,
                "/api/v1/merchant/credential-sets",
                "/internal/merchant/credential-sets",
            )
            .query(s::list_query_schema()),
        ),
    ));
    routes.push(RouteDef::new(
        "POST",
        "/api/v1/merchant/credential-sets",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Post,
                "/api/v1/merchant/credential-sets",
                "/internal/merchant/credential-sets",
            )
            .body(s::credential_create_schema())
            .mapper(to_core_credential_set_create)
            .core_schema(core_credential_set_create_schema())
            .status(201),
        ),
    ));
    routes.push(RouteDef::new(
        "PUT",
        "/api/v1/merchant/credential-sets/:id",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Put,
                "/api/v1/merchant/credential-sets/:id",
                "/internal/merchant/credential-sets/:id",
            )
            .params(s::wallet_params_schema())
            .body(s::credential_update_schema())
            .mapper(to_core_credential_set_update)
            .core_schema(core_credential_set_update_schema()),
        ),
    ));
    routes.push(RouteDef::new(
        "GET",
        "/api/v1/merchant/credential-sets/:id",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Get,
                "/api/v1/merchant/credential-sets/:id",
                "/internal/merchant/credential-sets/:id",
            )
            .params(s::wallet_params_schema()),
        ),
    ));

    // ----------------------------------------------------------------- users
    routes.push(RouteDef::new(
        "GET",
        "/api/v1/merchant/users",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Get,
                "/api/v1/merchant/users",
                "/internal/merchant/users",
            )
            .query(s::list_query_schema()),
        ),
    ));
    routes.push(RouteDef::new(
        "POST",
        "/api/v1/merchant/users",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Post,
                "/api/v1/merchant/users",
                "/internal/merchant/users",
            )
            .body(s::user_create_schema())
            .mapper(to_core_user_create)
            .core_schema(core_user_create_schema())
            .status(201),
        ),
    ));
    routes.push(RouteDef::new(
        "PATCH",
        "/api/v1/merchant/users",
        Protected,
        Action::BulkUsers,
    ));
    routes.push(RouteDef::new(
        "PATCH",
        "/api/v1/merchant/users/:id",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Patch,
                "/api/v1/merchant/users/:id",
                "/internal/merchant/users/:id",
            )
            .params(s::wallet_params_schema())
            .body(s::user_patch_schema())
            .mapper(to_core_user_patch_by_id)
            .core_schema(core_user_patch_by_id_schema()),
        ),
    ));

    // ----------------------------------------------------------------- stats
    routes.push(RouteDef::new(
        "GET",
        "/api/v1/merchant/stats/overview",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Get,
                "/api/v1/merchant/stats/overview",
                "/internal/merchant/stats/overview",
            )
            .query(s::stats_overview_query_schema()),
        ),
    ));

    // -------------------------------------------------------------- webhooks
    routes.push(RouteDef::new(
        "GET",
        "/api/v1/merchant/webhooks/event-types",
        Protected,
        forward(ForwardSpec::new(
            CoreMethod::Get,
            "/api/v1/merchant/webhooks/event-types",
            "/internal/merchant/webhooks/event-types",
        )),
    ));
    routes.push(RouteDef::new(
        "GET",
        "/api/v1/merchant/webhooks/endpoints",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Get,
                "/api/v1/merchant/webhooks/endpoints",
                "/internal/merchant/webhooks/endpoints",
            )
            .query(s::webhook_endpoints_query_schema()),
        ),
    ));
    routes.push(RouteDef::new(
        "POST",
        "/api/v1/merchant/webhooks/endpoints",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Post,
                "/api/v1/merchant/webhooks/endpoints",
                "/internal/merchant/webhooks/endpoints",
            )
            .body(s::webhook_endpoint_create_schema())
            .status(201),
        ),
    ));
    routes.push(RouteDef::new(
        "PATCH",
        "/api/v1/merchant/webhooks/endpoints/:id",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Patch,
                "/api/v1/merchant/webhooks/endpoints/:id",
                "/internal/merchant/webhooks/endpoints/:id",
            )
            .params(s::wallet_params_schema())
            .body(s::webhook_endpoint_patch_schema()),
        ),
    ));
    routes.push(RouteDef::new(
        "POST",
        "/api/v1/merchant/webhooks/endpoints/:id/rotate-secret",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Post,
                "/api/v1/merchant/webhooks/endpoints/:id/rotate-secret",
                "/internal/merchant/webhooks/endpoints/:id/rotate-secret",
            )
            .params(s::wallet_params_schema())
            .body(crate::validate::Schema::empty_strict()),
        ),
    ));
    routes.push(RouteDef::new(
        "POST",
        "/api/v1/merchant/webhooks/endpoints/:id/test",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Post,
                "/api/v1/merchant/webhooks/endpoints/:id/test",
                "/internal/merchant/webhooks/endpoints/:id/test",
            )
            .params(s::wallet_params_schema())
            .body(crate::validate::Schema::empty_strict())
            .status(202),
        ),
    ));
    routes.push(RouteDef::new(
        "GET",
        "/api/v1/merchant/webhooks/deliveries",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Get,
                "/api/v1/merchant/webhooks/deliveries",
                "/internal/merchant/webhooks/deliveries",
            )
            .query(s::webhook_deliveries_query_schema()),
        ),
    ));
    routes.push(RouteDef::new(
        "POST",
        "/api/v1/merchant/webhooks/deliveries/:id/redeliver",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Post,
                "/api/v1/merchant/webhooks/deliveries/:id/redeliver",
                "/internal/merchant/webhooks/deliveries/:id/redeliver",
            )
            .params(s::wallet_params_schema())
            .body(crate::validate::Schema::empty_strict())
            .status(202),
        ),
    ));

    // --------------------------------------------------------- report engine
    routes.push(RouteDef::new(
        "GET",
        "/api/v1/merchant/report-engine/catalog",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Get,
                "/api/v1/merchant/report-engine/catalog",
                "/internal/merchant/report-engine/catalog",
            )
            .query(s::report_catalog_query_schema()),
        ),
    ));
    routes.push(RouteDef::new(
        "GET",
        "/api/v1/merchant/report-engine/autocomplete/:sourceKey",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Get,
                "/api/v1/merchant/report-engine/autocomplete/:sourceKey",
                "/internal/merchant/report-engine/autocomplete/:sourceKey",
            )
            .params(s::report_source_params_schema())
            .query(s::report_autocomplete_query_schema()),
        ),
    ));
    routes.push(RouteDef::new(
        "POST",
        "/api/v1/merchant/report-engine/catalog/:code/execute",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Post,
                "/api/v1/merchant/report-engine/catalog/:code/execute",
                "/internal/merchant/report-engine/catalog/:code/execute",
            )
            .params(s::report_code_params_schema())
            .body(s::report_execute_body_schema()),
        ),
    ));
    routes.push(RouteDef::new(
        "GET",
        "/api/v1/merchant/report-engine/studio/transcript",
        Protected,
        forward(ForwardSpec::new(
            CoreMethod::Get,
            "/api/v1/merchant/report-engine/studio/transcript",
            "/internal/merchant/report-engine/studio/transcript",
        )),
    ));
    routes.push(RouteDef::new(
        "POST",
        "/api/v1/merchant/report-engine/studio/verify",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Post,
                "/api/v1/merchant/report-engine/studio/verify",
                "/internal/merchant/report-engine/studio/verify",
            )
            .body(s::report_studio_body_schema()),
        ),
    ));
    routes.push(RouteDef::new(
        "POST",
        "/api/v1/merchant/report-engine/studio/preview",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Post,
                "/api/v1/merchant/report-engine/studio/preview",
                "/internal/merchant/report-engine/studio/preview",
            )
            .body(s::report_preview_body_schema()),
        ),
    ));
    routes.push(RouteDef::new(
        "POST",
        "/api/v1/merchant/report-engine/studio/specs",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Post,
                "/api/v1/merchant/report-engine/studio/specs",
                "/internal/merchant/report-engine/studio/specs",
            )
            .body(s::report_spec_publish_body_schema())
            .status(201),
        ),
    ));
    routes.push(RouteDef::new(
        "GET",
        "/api/v1/merchant/report-engine/studio/specs",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Get,
                "/api/v1/merchant/report-engine/studio/specs",
                "/internal/merchant/report-engine/studio/specs",
            )
            .query(s::report_specs_query_schema()),
        ),
    ));
    routes.push(RouteDef::new(
        "GET",
        "/api/v1/merchant/report-engine/studio/specs/:id",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Get,
                "/api/v1/merchant/report-engine/studio/specs/:id",
                "/internal/merchant/report-engine/studio/specs/:id",
            )
            .params(s::uuid_params_schema()),
        ),
    ));
    routes.push(RouteDef::new(
        "POST",
        "/api/v1/merchant/report-engine/studio/specs/:id/publish",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Post,
                "/api/v1/merchant/report-engine/studio/specs/:id/publish",
                "/internal/merchant/report-engine/studio/specs/:id/publish",
            )
            .params(s::uuid_params_schema())
            .body(crate::validate::Schema::empty_strict()),
        ),
    ));
    routes.push(RouteDef::new(
        "POST",
        "/api/v1/merchant/report-engine/studio/specs/:id/archive",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Post,
                "/api/v1/merchant/report-engine/studio/specs/:id/archive",
                "/internal/merchant/report-engine/studio/specs/:id/archive",
            )
            .params(s::uuid_params_schema())
            .body(crate::validate::Schema::empty_strict()),
        ),
    ));
    routes.push(RouteDef::new(
        "GET",
        "/api/v1/merchant/report-engine/studio/usage",
        Protected,
        forward(ForwardSpec::new(
            CoreMethod::Get,
            "/api/v1/merchant/report-engine/studio/usage",
            "/internal/merchant/report-engine/studio/usage",
        )),
    ));
    routes.push(RouteDef::new(
        "POST",
        "/api/v1/merchant/report-engine/studio/templates/:code/clone",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Post,
                "/api/v1/merchant/report-engine/studio/templates/:code/clone",
                "/internal/merchant/report-engine/studio/templates/:code/clone",
            )
            .params(s::report_code_params_schema())
            .body(s::report_clone_body_schema())
            .status(201),
        ),
    ));
    routes.push(RouteDef::new(
        "GET",
        "/api/v1/merchant/report-engine/studio/chrome",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Get,
                "/api/v1/merchant/report-engine/studio/chrome",
                "/internal/merchant/report-engine/studio/chrome",
            )
            .query(s::report_chrome_query_schema()),
        ),
    ));
    routes.push(RouteDef::new(
        "GET",
        "/api/v1/merchant/report-engine/studio/chrome/transcript",
        Protected,
        forward(ForwardSpec::new(
            CoreMethod::Get,
            "/api/v1/merchant/report-engine/studio/chrome/transcript",
            "/internal/merchant/report-engine/studio/chrome/transcript",
        )),
    ));
    routes.push(RouteDef::new(
        "GET",
        "/api/v1/merchant/report-engine/studio/chrome/needs-migration",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Get,
                "/api/v1/merchant/report-engine/studio/chrome/needs-migration",
                "/internal/merchant/report-engine/studio/chrome/needs-migration",
            )
            .query(s::report_needs_migration_query_schema()),
        ),
    ));
    routes.push(RouteDef::new(
        "GET",
        "/api/v1/merchant/report-engine/studio/chrome/:id",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Get,
                "/api/v1/merchant/report-engine/studio/chrome/:id",
                "/internal/merchant/report-engine/studio/chrome/:id",
            )
            .params(s::uuid_params_schema()),
        ),
    ));
    routes.push(RouteDef::new(
        "POST",
        "/api/v1/merchant/report-engine/studio/chrome",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Post,
                "/api/v1/merchant/report-engine/studio/chrome",
                "/internal/merchant/report-engine/studio/chrome",
            )
            .body(s::report_chrome_body_schema())
            .status(201),
        ),
    ));
    routes.push(RouteDef::new(
        "POST",
        "/api/v1/merchant/report-engine/studio/chrome/:id/archive",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Post,
                "/api/v1/merchant/report-engine/studio/chrome/:id/archive",
                "/internal/merchant/report-engine/studio/chrome/:id/archive",
            )
            .params(s::uuid_params_schema())
            .body(crate::validate::Schema::empty_strict()),
        ),
    ));
    routes.push(RouteDef::new(
        "POST",
        "/api/v1/merchant/report-engine/studio/chrome/:id/set-default",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Post,
                "/api/v1/merchant/report-engine/studio/chrome/:id/set-default",
                "/internal/merchant/report-engine/studio/chrome/:id/set-default",
            )
            .params(s::uuid_params_schema())
            .body(s::report_set_default_schema()),
        ),
    ));
    routes.push(RouteDef::new(
        "GET",
        "/api/v1/merchant/report-engine/studio/chrome/:id/migration-prompt",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Get,
                "/api/v1/merchant/report-engine/studio/chrome/:id/migration-prompt",
                "/internal/merchant/report-engine/studio/chrome/:id/migration-prompt",
            )
            .params(s::uuid_params_schema()),
        ),
    ));
    routes.push(RouteDef::new(
        "GET",
        "/api/v1/merchant/report-engine/studio/needs-migration",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Get,
                "/api/v1/merchant/report-engine/studio/needs-migration",
                "/internal/merchant/report-engine/studio/needs-migration",
            )
            .query(s::report_needs_migration_query_schema()),
        ),
    ));
    routes.push(RouteDef::new(
        "GET",
        "/api/v1/merchant/report-engine/studio/specs/:id/migration-prompt",
        Protected,
        forward(
            ForwardSpec::new(
                CoreMethod::Get,
                "/api/v1/merchant/report-engine/studio/specs/:id/migration-prompt",
                "/internal/merchant/report-engine/studio/specs/:id/migration-prompt",
            )
            .params(s::uuid_params_schema()),
        ),
    ));

    // --------------------------------------------------------------- sandbox
    routes.push(RouteDef::new(
        "POST",
        "/api/v1/merchant/sandbox/mirror/disputes/:id/attachments",
        Protected,
        Action::SandboxUpload,
    ));
    routes.push(RouteDef::new(
        "*",
        "/api/v1/merchant/sandbox/{*rest}",
        Protected,
        Action::SandboxProxy,
    ));

    // -------------------------------------------------------------- external
    routes.push(RouteDef::new(
        "POST",
        "/api/v1/external/links",
        External,
        forward(
            ForwardSpec::new(
                CoreMethod::Post,
                "/api/v1/external/links",
                "/internal/merchant/external/links",
            )
            .body(s::external_link_create_schema())
            .core_schema(core_link_create_schema())
            .status(201),
        ),
    ));
    routes.push(RouteDef::new(
        "GET",
        "/api/v1/external/links/:key",
        External,
        forward(
            ForwardSpec::new(
                CoreMethod::Get,
                "/api/v1/external/links/:key",
                "/internal/merchant/external/links/:key",
            )
            .params(s::external_key_params_schema()),
        ),
    ));
    routes.push(RouteDef::new(
        "POST",
        "/api/v1/external/links/:key/cancel",
        External,
        forward(
            ForwardSpec::new(
                CoreMethod::Post,
                "/api/v1/external/links/:key/cancel",
                "/internal/merchant/external/links/:key/cancel",
            )
            .params(s::external_key_params_schema())
            .body(s::cancel_schema()),
        ),
    ));
    routes.push(RouteDef::new(
        "GET",
        "/api/v1/external/payments/:reference",
        External,
        forward(
            ForwardSpec::new(
                CoreMethod::Get,
                "/api/v1/external/payments/:reference",
                "/internal/merchant/external/payments/:reference",
            )
            .params(s::external_reference_params_schema()),
        ),
    ));

    routes
}

/// The body policy of a matched route.
#[must_use]
pub fn body_policy(route: &RouteDef, path: &str, config: &crate::config::EdgeConfig) -> BodyPolicy {
    match &route.action {
        Action::Health | Action::PosStream { .. } | Action::AttachmentContent { .. } => {
            BodyPolicy::None
        }
        Action::KybDocument
        | Action::DisputeEvidence
        | Action::DisputeAttachment
        | Action::SandboxUpload => BodyPolicy::Multipart,
        Action::SandboxProxy => {
            if path.starts_with("/api/v1/merchant/sandbox/mirror/report-engine") {
                BodyPolicy::Json(REPORT_ENGINE_JSON_LIMIT)
            } else {
                BodyPolicy::Json(config.max_json_body_bytes)
            }
        }
        Action::Forward(spec) => {
            if matches!(spec.method, CoreMethod::Get | CoreMethod::Head) {
                BodyPolicy::None
            } else {
                BodyPolicy::Json(config.max_json_body_bytes)
            }
        }
        Action::Logout | Action::GoogleCallback | Action::BulkUsers | Action::TokenCreate(_) => {
            BodyPolicy::Json(config.max_json_body_bytes)
        }
    }
}

/// Whether a route path is the sandbox mirror report-engine namespace (24 MiB JSON parser).
#[must_use]
pub fn is_mirror_report_engine(path: &str) -> bool {
    path == "/api/v1/merchant/sandbox/mirror/report-engine"
        || path.starts_with("/api/v1/merchant/sandbox/mirror/report-engine/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_inventory_route_is_registered() {
        // The 105 API routes of the route inventory plus `/health`; the sandbox wildcard is the
        // only path the inventory cannot enumerate.
        assert_eq!(ROUTES.len(), 107);
        let api = ROUTES
            .iter()
            .filter(|route| route.pattern.starts_with("/api/v1"))
            .count();
        assert_eq!(api, 106);
    }

    #[test]
    fn route_group_counts_match_the_documentation() {
        let count = |group: RouteGroup| ROUTES.iter().filter(|route| route.group == group).count();
        assert_eq!(count(RouteGroup::Public), 1);
        assert_eq!(count(RouteGroup::Auth), 16);
        assert_eq!(count(RouteGroup::Onboarding), 9);
        assert_eq!(count(RouteGroup::External), 4);
        // 76 forwarded protected routes + the `/sandbox/{*rest}` wildcard.
        assert_eq!(count(RouteGroup::Protected), 77);
        assert_eq!(ROUTES.iter().filter(|route| route.method == "*").count(), 1);
    }

    #[test]
    fn static_report_engine_routes_win_over_dynamic_ids() {
        let (route, _) = match_route(
            "GET",
            "/api/v1/merchant/report-engine/studio/chrome/needs-migration",
        )
        .expect("route");
        assert_eq!(
            route.pattern,
            "/api/v1/merchant/report-engine/studio/chrome/needs-migration"
        );
        let (route, _) = match_route(
            "GET",
            "/api/v1/merchant/report-engine/studio/chrome/11111111-1111-4111-8111-111111111111",
        )
        .expect("route");
        assert_eq!(
            route.pattern,
            "/api/v1/merchant/report-engine/studio/chrome/:id"
        );
        // No shadowing between registrations: a static route must not be captured by an earlier
        // dynamic pattern.
        for (index, route) in ROUTES.iter().enumerate() {
            if route.pattern.contains(':') || route.pattern.contains("{*rest}") {
                continue;
            }
            for earlier in ROUTES.iter().take(index) {
                if earlier.method != route.method || !earlier.pattern.contains(':') {
                    continue;
                }
                let mut params = BTreeMap::new();
                assert!(
                    !capture(&earlier.template, route.pattern, &mut params),
                    "{} {} shadows {}",
                    earlier.method,
                    earlier.pattern,
                    route.pattern
                );
            }
        }
    }

    #[test]
    fn params_are_decoded_and_re_encoded() {
        let (route, params) = match_route(
            "GET",
            "/api/v1/merchant/wallets/wal_1/statements/2026-11/export",
        )
        .expect("route");
        assert_eq!(
            route.pattern,
            "/api/v1/merchant/wallets/:id/statements/:month/export"
        );
        assert_eq!(params.get("id").map(String::as_str), Some("wal_1"));
        assert_eq!(params.get("month").map(String::as_str), Some("2026-11"));

        let template = PathTemplate::parse("/internal/merchant/wallets/:id");
        let mut values = BTreeMap::new();
        values.insert("id".to_owned(), "a b/c".to_owned());
        assert_eq!(
            template.render(&values),
            "/internal/merchant/wallets/a%20b%2Fc"
        );
    }

    #[test]
    fn the_sandbox_wildcard_covers_every_subpath_and_method() {
        for (method, path) in [
            ("GET", "/api/v1/merchant/sandbox/overview"),
            ("POST", "/api/v1/merchant/sandbox/seed-demo"),
            ("PUT", "/api/v1/merchant/sandbox/wallets/wal_1"),
            ("GET", "/api/v1/merchant/sandbox"),
        ] {
            let (route, _) = match_route(method, path).expect(path);
            assert!(matches!(route.action, Action::SandboxProxy), "{path}");
        }
        // `/sandboxx` is not the sandbox namespace.
        assert!(match_route("GET", "/api/v1/merchant/sandboxx").is_none());
    }

    #[test]
    fn body_policies_follow_the_express_parsers() {
        let config = crate::config::EdgeConfig::for_embedding(
            vec!["https://core.test".to_owned()],
            Some(vec!["https://sandbox.core.test".to_owned()]),
        );
        let policy = |method: &str, path: &str| {
            let (route, _) = match_route(method, path).expect(path);
            body_policy(route, path, &config)
        };
        assert_eq!(policy("GET", "/api/v1/merchant/wallets"), BodyPolicy::None);
        assert_eq!(
            policy("POST", "/api/v1/merchant/wallets"),
            BodyPolicy::Json(config.max_json_body_bytes)
        );
        assert_eq!(
            policy(
                "POST",
                "/api/v1/merchant/sandbox/mirror/report-engine/catalog/x/execute"
            ),
            BodyPolicy::Json(REPORT_ENGINE_JSON_LIMIT)
        );
        assert_eq!(
            policy("POST", "/api/v1/merchant/sandbox/mirror/wallets"),
            BodyPolicy::Json(config.max_json_body_bytes)
        );
        assert_eq!(
            policy("POST", "/api/v1/merchant/sandbox/seed-demo"),
            BodyPolicy::Json(config.max_json_body_bytes)
        );
        assert_eq!(
            policy("POST", "/api/v1/merchant/onboarding/kyb-documents"),
            BodyPolicy::Multipart
        );
        assert_eq!(
            policy("POST", "/api/v1/merchant/disputes/dis_1/evidence"),
            BodyPolicy::Multipart
        );
        assert_eq!(
            policy("GET", "/api/v1/merchant/pos/screens/SCREEN1/stream"),
            BodyPolicy::None
        );
        assert!(is_mirror_report_engine(
            "/api/v1/merchant/sandbox/mirror/report-engine"
        ));
        assert!(is_mirror_report_engine(
            "/api/v1/merchant/sandbox/mirror/report-engine/catalog"
        ));
        assert!(!is_mirror_report_engine(
            "/api/v1/merchant/sandbox/mirror/report-engineer"
        ));
    }

    #[test]
    fn head_is_answered_by_the_get_route() {
        assert!(match_route("HEAD", "/health").is_some());
        assert!(match_route("HEAD", "/api/v1/merchant/wallets").is_some());
        assert!(match_route("HEAD", "/api/v1/merchant/wallets/wal_1").is_some());
    }

    #[test]
    fn unknown_routes_do_not_match() {
        assert!(match_route("GET", "/api/v1/merchant/nope").is_none());
        assert!(match_route("POST", "/api/v1/merchant/wallets").is_some());
        assert!(match_route("DELETE", "/api/v1/merchant/wallets").is_none());
        assert!(match_route("GET", "/health").is_some());
        assert!(match_route("POST", "/health").is_none());
    }

    #[test]
    fn every_inventory_entry_matches_the_table() {
        // Guards against a typo in a pattern: each route's own pattern must match itself with the
        // documented method (the sandbox wildcard excepted).
        for route in ROUTES.iter() {
            if route.action_is_sandbox() {
                continue;
            }
            assert!(
                match_route(route.method, route.pattern).is_some(),
                "{} {} does not match itself",
                route.method,
                route.pattern
            );
        }
    }
}

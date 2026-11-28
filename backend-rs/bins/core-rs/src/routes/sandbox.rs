//! Sandbox control-plane read routes (wave 5).
//!
//! Port of the `GET /internal/sandbox/**` handlers in
//! `core-back/api/internal/sandboxControl.ts` (37 distinct paths; the inventory lists
//! `GET /internal/sandbox/admin/merchants` twice because the TS router registers a paginated and a
//! later, unreachable simple list on the same path — Express serves the first one, which is the only
//! route mounted here).
//!
//! The router in TS is mounted on `/internal/sandbox` with, in order:
//!
//! 1. `requireAuthentication` → [`pg_http::Authn::Session`] on every policy;
//! 2. `isSandboxPlane()` → [`support::ensure_plane`] answers `403 SANDBOX_PLANE_REQUIRED` on the
//!    Live core;
//! 3. `assertSandboxControlAccess` → [`support::assert_control_access`] (staff pass; a merchant
//!    principal needs one of `merchant:read`, `merchant:write`, `payment:read`, `link:read`).
//!
//! ## Route families
//!
//! | Family | Module | Count |
//! | :--- | :--- | :--- |
//! | Merchant Studio + merchant overview/wallet/payment | [`merchant`] | 19 |
//! | Staff overview/merchants/audits | [`admin`] | 6 |
//! | Fake Rails accounts/clearing + staff control center | [`fake_rails`] | 12 |
//!
//! ## Deliberate deviations (the coordinator owns `DEVIATIONS.md`)
//!
//! - **DEV-SANDBOX-01:** a non-decimal list range (`amountMin=abc`) answers `400 INVALID_FILTER`;
//!   Prisma's `Decimal` constructor throws a 500 for the same input.
//! - **DEV-SANDBOX-02:** a staff `?merchantId=` that is not a UUID answers
//!   `400 SANDBOX_MERCHANT_REQUIRED` instead of Prisma's 500.
//! - **DEV-SANDBOX-03:** the Fake Rails control client is local to this module (GET only) and
//!   plain HTTP/1.1, like [`crate::routes::checkout`]'s private client; the write helpers arrive with
//!   the P7 write routes.
//! - **DEV-SANDBOX-04:** a malformed `:walletId`/`:attemptId`/`:tokenId` answers the route's 404
//!   (`SANDBOX_WALLET_NOT_FOUND`, `PAYMENT_ATTEMPT_NOT_FOUND`, `SANDBOX_TOKEN_NOT_FOUND`);
//!   `:merchantId`/`:applicationId`/`:linkId` use the TS `parseOrThrow`/`findFirst` behaviour (400
//!   `INVALID_BODY` for a malformed admin path id, 404 for a malformed merchant-scoped id). Prisma
//!   raises a 500 for an invalid uuid bind in the merchant-scoped handlers.
//! - **DEV-SANDBOX-05:** the `checkpoint` figures apply the TS `sandboxNatural("MERCHANT_WALLET", …)`
//!   sign (credit-normal wallets read positive in credit) exactly like the Live handler.
//!
//! ## Not implemented
//!
//! Only the GET surface is mounted. The TS router also declares 31 write routes (seed/reset,
//! wallet balance, refunds, disputes, cash-outs, Fake Rails account edits, scenario presets, resets,
//! webhook replay); they stay `501 NOT_IMPLEMENTED_ROUTE` until P7. Every handler here reads the real
//! database or the Fake Rails control plane; nothing is fabricated.

#![forbid(unsafe_code)]

pub mod admin;
pub mod control;
pub mod fake_rails;
pub mod fields;
pub mod merchant;
pub mod support;

#[cfg(test)]
mod tests;

use pg_http::{Authn, BodyRule, Channel, Policy};

use super::{Handler, MountedRoute, PrincipalGuard};

/// One Sandbox read route: `Channel::Sandbox`, session auth, no static authority list (the handler
/// applies the router-level `assertSandboxControlAccess` check) and no body.
fn route(path: &str, origin: &str, handler: super::CustomHandler) -> MountedRoute {
    MountedRoute {
        policy: Policy::new("GET", path, Channel::Sandbox, Authn::Session, origin)
            .body(BodyRule::None),
        handler: Handler::Custom(handler),
        guard: PrincipalGuard::None,
    }
}

/// Routes owned by this module.
#[must_use]
pub fn routes() -> Vec<MountedRoute> {
    let mut routes = Vec::new();
    routes.extend(merchant::routes());
    routes.extend(admin::routes());
    routes.extend(fake_rails::routes());
    routes
}

/// The TS origin of the router-level middleware (`sandboxControl.ts:33-70`), used by the module doc
/// and the tests that pin the guard order.
pub const ROUTER_ORIGIN: &str = "core-back/api/internal/sandboxControl.ts:33";

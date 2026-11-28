//! P4-T04 admin operations read routes.
//!
//! This module ports the TypeScript handlers that the admin console uses for operational review:
//!
//! | Resource | Module | TypeScript source |
//! | :--- | :--- | :--- |
//! | transactions, attempts | [`attempts`] | `core-back/api/internal/adminOperations.ts` |
//! | adjustments, cash-outs | [`finance`] | `core-back/api/internal/admin.ts` |
//! | approvals | [`approvals`] | `core-back/api/internal/admin.ts`, `lib/approvalQueue.ts` |
//! | disputes | [`disputes`] | `core-back/api/internal/admin.ts` |
//! | reconciliation | [`reconciliation`] | `core-back/api/internal/admin.ts` |
//! | join requests, KYB documents | [`onboarding`] | `core-back/api/internal/admin.ts` |
//! | incidents | [`incidents`] | `core-back/api/internal/admin.ts` |
//! | operator cases | [`operator_cases`] | `core-back/api/internal/admin.ts`, `lib/operatorCases` |
//!
//! Every route is declared with `Policy::new("GET", path, Channel::Admin, Authn::Session, ts_origin)`,
//! the exact TypeScript authority list, the `Staff` principal guard and `Handler::Custom`. Reads are
//! parameterised SQL on `state.pools.main`; no statement interpolates a client value. Exports are
//! read-only JSON envelopes with `take: 5000`, `total`, `exported` and `truncated`; they never write
//! an audit row from this module (the TS audit write is a P7-T0x side effect and the user asked for
//! read-only exports).
//!
//! Confidential AML data never reaches a caller without a compliance role or `aml:read`/`aml:write`:
//! operator cases hide AML rows from lists and answer `403 CASE_CONFIDENTIAL` on detail, approval
//! detail answers `403 AML_CONFIDENTIAL_ROLE_REQUIRED` for an AML subject, and incidents require the
//! same confidential gate on every route.
//!
//! Dynamic detail routes use the shared `:id` template matcher and handlers validate their own
//! parameters (`requireUuidParam` semantics: an invalid id is the resource's 404). The exact-path
//! dispatcher remains the fast path, so a static sibling always wins over a template.
//!
//! Known scope split: the three byte downloads that need the object-storage SDK
//! (`/kyb-documents/:id/content`, `/reconciliation/runs/:id/statement`,
//! `/disputes/:id/attachments/:attachmentId/content`) belong to P4-T05 and are not mounted here.

#![forbid(unsafe_code)]

mod approvals;
mod attempts;
mod disputes;
mod finance;
mod incidents;
mod onboarding;
mod operator_cases;
mod reconciliation;
mod support;

use super::MountedRoute;

/// Routes owned by this module.
#[must_use]
pub fn routes() -> Vec<MountedRoute> {
    let mut routes = Vec::new();
    routes.extend(attempts::routes());
    routes.extend(finance::routes());
    routes.extend(approvals::routes());
    routes.extend(disputes::routes());
    routes.extend(reconciliation::routes());
    routes.extend(onboarding::routes());
    routes.extend(incidents::routes());
    routes.extend(operator_cases::routes());
    routes
}

#[cfg(test)]
mod tests;

//! Payment flow: attempt statuses, the state machine, flow phases, the guard pipeline, visible
//! rails and link slots.
//!
//! Port of the pure parts of `core-back/engine/flow/**`,
//! `core-back/engine/guards/AttemptGuardPipeline.ts`, `core-back/engine/runtime/slotStore.ts`,
//! `core-back/lib/attemptOutcomes.ts` and `core-back/prisma/syntheticSeeder/lifecycle.ts`, per
//! chapter 2 §15 of the Rust/ntex port plan.
//!
//! | Module | TypeScript source |
//! | :--- | :--- |
//! | [`status`] | `prisma` `AttemptStatus`, `lib/attemptOutcomes.ts`, dashboard `attemptsCounted` |
//! | [`transition`] | `DynamicRailEngine.ts:285-314` (`ALLOWED_TRANSITIONS`, `finalizeGuardFor`), `lifecycle.ts` |
//! | [`phase`] | `DynamicRailEngine.ts:230,326-331`, `specSchema.ts:36`, Prisma `CanonicalStatus` |
//! | [`guards`] | `AttemptGuardPipeline.ts:34,351-868` |
//! | [`visible_rails`] | `VisibleRailsResolver.ts:288-323`, `routeHealth/decision.ts:128-138` |
//! | [`slots`] | `runtime/slotStore.ts`, `attempt_groups_single_success` |
//!
//! Everything here is pure: the engine's IO (attempt repository, step executor, ledger, outbox) is a
//! caller concern, so the state machine, the guard order, the dashboard rule and the slot predicates
//! can be parity-tested without a database.
//!
//! ## Recorded deviations
//!
//! - `DEV`: terminal refusals answer `ATTEMPT_TERMINAL` from [`transition::effective_status_transition`]
//!   (the TS `transition()` throws `INVALID_ATTEMPT_TRANSITION`; only its callback and finalize
//!   guards throw `ATTEMPT_TERMINAL`). [`transition::is_allowed`] is available where the verbatim
//!   engine answer is needed.
//! - `DEV`: [`slots::SlotDecision::commit_group`] pre-checks `attempt_groups_single_success` and
//!   answers `409 ATTEMPT_GROUP_ALREADY_SUCCEEDED`; TS lets the database CHECK fail the commit.
//! - `DEV`: route ordering reproduces the `WEIGHTED` strategy only (see [`visible_rails`]).

#![forbid(unsafe_code)]

pub mod error;
pub mod guards;
pub mod phase;
pub mod slots;
pub mod status;
pub mod transition;
pub mod visible_rails;

pub use error::{codes, FlowError, FlowErrorEnvelope};
pub use guards::{
    aml_block_code, block_codes, customer_messages, screening_match_block_code,
    velocity_reject_code, AllowedOutcome, GuardDecision, GuardStage,
};
pub use phase::{
    is_success_status, CanonicalStepStatus, ClientAction, FlowPhase, TRUSTED_SUCCESS_STATUSES,
};
pub use slots::{
    guard_slot_available, slot_reservation_id, AttemptGroupState, LinkSlotState, LinkState,
    SlotDecision, SlotUnavailable,
};
pub use status::{
    counted_outcomes, excluded_outcomes, success_rate, success_rate_f64, terminal_outcomes,
    AttemptSubstatus, PaymentStatus, SuccessRateClass, TERMINAL_SUBSTATUS_AML_VOID,
};
pub use transition::{
    effective_status_transition, finalize_guard, is_allowed, is_allowed_including_governance,
    refuse_finalize, FinalizeGuard, Transition, ALLOWED_TRANSITIONS, GOVERNANCE_TRANSITIONS,
};
pub use visible_rails::{
    canary_selected, resolve_visible_routes, ExcludedRoute, ExclusionReason, RailCandidate,
    RouteHealth, RouteStatus, VisibleRailsPolicy, VisibleRoute, VisibleRoutes,
};

#[cfg(test)]
mod tests {
    use super::*;

    /// The main lifecycle a successful OTP payment walks, then a refund, then a chargeback — every
    /// step through the pure decision and the slot rules.
    #[test]
    fn successful_payment_then_refund_then_dispute() {
        let mut link = LinkSlotState::single(1);
        let group = AttemptGroupState::new("link-1", "fingerprint-1");

        // Reserve the slot at attempt creation.
        let reservation = SlotDecision::reserve(&link, "link-1", "attempt-1");
        assert!(reservation.succeeded());
        link.active_locked_count = 1;

        // Walk the status machine.
        let path = [
            PaymentStatus::Created,
            PaymentStatus::Initiating,
            PaymentStatus::AwaitingCustomer,
            PaymentStatus::Authorizing,
            PaymentStatus::Verifying,
            PaymentStatus::Succeeded,
        ];
        for pair in path.windows(2) {
            assert_eq!(
                effective_status_transition(pair[0], pair[1]),
                Ok(Transition::Allowed),
                "{} → {}",
                pair[0],
                pair[1]
            );
        }
        assert!(PaymentStatus::Succeeded.is_counted_for_success_rate());
        assert_eq!(
            success_rate(1, 1),
            Some(rust_decimal::Decimal::new(10000, 2))
        );

        // Commit the slot and the group success.
        assert_eq!(
            SlotDecision::commit_group(&link, &group),
            SlotDecision::Committed {
                state: LinkState::Completed
            }
        );

        // Refund, then a chargeback on the refunded attempt.
        assert_eq!(
            effective_status_transition(PaymentStatus::Succeeded, PaymentStatus::Refunded),
            Ok(Transition::Allowed)
        );
        assert_eq!(
            effective_status_transition(PaymentStatus::Refunded, PaymentStatus::Disputed)
                .expect_err("REFUNDED is final"),
            FlowError::terminal_cannot_finalize("REFUNDED")
        );
        assert_eq!(
            effective_status_transition(PaymentStatus::Succeeded, PaymentStatus::Disputed),
            Ok(Transition::Allowed)
        );
        // The account still counts as a success (a dispute is not a processing failure).
        assert!(PaymentStatus::Disputed.is_success_for_rate());
        assert!(!PaymentStatus::Disputed.releases_slot());
    }

    /// The guard refuses a second payment on a single-use link with the TS customer message, and a
    /// degraded route only enters the visible set for its canary cohort.
    #[test]
    fn guard_and_visible_rails_agree_on_the_refusal() {
        let mut link = LinkSlotState::single(1);
        link.active_locked_count = 1;
        let blocked = GuardDecision::block(
            block_codes::PAYMENT_LINK_SLOT_UNAVAILABLE,
            "The payment link has no available slot",
        );
        assert!(!SlotDecision::reserve(&link, "link-1", "attempt-2").succeeded());
        assert_eq!(
            blocked.customer_message_code(),
            customer_messages::PAYMENT_IN_PROGRESS
        );

        let policy = VisibleRailsPolicy {
            min_healthy: None,
            canary_percent: 20,
        };
        let candidates = vec![
            RailCandidate {
                health: RouteHealth::Degraded,
                canary: canary_selected("route-d", Some("link-1"), policy.canary_percent),
                ..RailCandidate::active("route-d")
            },
            RailCandidate::active("route-h"),
        ];
        let visible = resolve_visible_routes(&candidates, policy);
        assert!(visible.route_ids().contains(&"route-h"));
        // The degraded route is only present when the cohort hash put the link in the canary.
        let degraded_visible = visible.route_ids().contains(&"route-d");
        assert_eq!(
            degraded_visible,
            canary_selected("route-d", Some("link-1"), policy.canary_percent)
        );
        if degraded_visible {
            assert_eq!(visible.routes[0].route_id, "route-d");
        }
    }
}

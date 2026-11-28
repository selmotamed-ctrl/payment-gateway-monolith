//! The attempt state machine.
//!
//! Port of `ALLOWED_TRANSITIONS` (`core-back/engine/flow/DynamicRailEngine.ts:295-314`), the
//! governance edges of `finalizeAmlAttempt` in
//! `core-back/engine/governance/GovernanceExecution.ts`, the re-finalise guard `finalizeGuardFor`
//! (`DynamicRailEngine.ts:285-293`) and the tested mirror in
//! `core-back/prisma/syntheticSeeder/lifecycle.ts:15-59`.
//!
//! `ALLOWED_TRANSITIONS` is not exported by the engine, so `lifecycle.ts` restates it and
//! `core-back/test/synthetic-seeder-realism.test.ts:286` fails when the two drift apart. This crate
//! restates it a third time; the golden test below is the full table, and the TS mirror is the
//! authority for any change.
//!
//! ## Error codes
//!
//! `DynamicRailEngine.transition()` throws `INVALID_ATTEMPT_TRANSITION` for every edge outside the
//! table, while the callback path (`:607,610`) and the finalize path (`:1167,1172`) throw
//! `ATTEMPT_TERMINAL` for `CANCELLED`/`BLOCKED`. [`effective_status_transition`] follows the
//! requested split instead: an attempt that is already terminal and cannot move answers
//! `ATTEMPT_TERMINAL`, a non-terminal attempt with no such edge answers
//! `INVALID_ATTEMPT_TRANSITION`. Callers that must reproduce the engine verbatim use
//! [`crate::transition::is_allowed`] plus the error they choose; the difference is recorded as a
//! deviation for `DEVIATIONS.md`.

#![forbid(unsafe_code)]

use crate::error::FlowError;
use crate::status::PaymentStatus;

/// `ALLOWED_TRANSITIONS`: the edges the dynamic rail engine may take.
///
/// `status == next` is always accepted by `transition()` before the table is consulted, so
/// self-edges only appear where the engine has a reason to write the same status again.
pub const ALLOWED_TRANSITIONS: [(PaymentStatus, &[PaymentStatus]); 14] = [
    (
        PaymentStatus::Created,
        &[
            PaymentStatus::Initiating,
            PaymentStatus::AwaitingCustomer,
            PaymentStatus::Verifying,
            PaymentStatus::Blocked,
            PaymentStatus::Cancelled,
            PaymentStatus::Expired,
            PaymentStatus::Failed,
        ],
    ),
    (
        PaymentStatus::Initiating,
        &[
            PaymentStatus::AwaitingCustomer,
            PaymentStatus::Verifying,
            PaymentStatus::Failed,
            PaymentStatus::Blocked,
            PaymentStatus::Cancelled,
            PaymentStatus::Expired,
            PaymentStatus::Unknown,
        ],
    ),
    (
        PaymentStatus::AwaitingCustomer,
        &[
            PaymentStatus::Authorizing,
            PaymentStatus::AwaitingCustomer,
            PaymentStatus::Verifying,
            PaymentStatus::Failed,
            PaymentStatus::Cancelled,
            PaymentStatus::Expired,
            PaymentStatus::Blocked,
            PaymentStatus::Unknown,
        ],
    ),
    (
        PaymentStatus::Authorizing,
        &[
            PaymentStatus::Verifying,
            PaymentStatus::Succeeded,
            PaymentStatus::Failed,
            PaymentStatus::Unknown,
            PaymentStatus::AwaitingCustomer,
        ],
    ),
    (
        PaymentStatus::Verifying,
        &[
            PaymentStatus::Verifying,
            PaymentStatus::Succeeded,
            PaymentStatus::Failed,
            PaymentStatus::Unknown,
            PaymentStatus::AwaitingCustomer,
        ],
    ),
    (
        PaymentStatus::Unknown,
        &[
            PaymentStatus::Verifying,
            PaymentStatus::Succeeded,
            PaymentStatus::Failed,
            PaymentStatus::Unknown,
        ],
    ),
    (
        PaymentStatus::Succeeded,
        &[
            PaymentStatus::PartiallyRefunded,
            PaymentStatus::Refunded,
            PaymentStatus::Disputed,
        ],
    ),
    (PaymentStatus::Failed, &[PaymentStatus::Succeeded]),
    (PaymentStatus::Expired, &[PaymentStatus::Succeeded]),
    (PaymentStatus::Cancelled, &[]),
    (PaymentStatus::Blocked, &[]),
    (
        PaymentStatus::PartiallyRefunded,
        &[
            PaymentStatus::PartiallyRefunded,
            PaymentStatus::Refunded,
            PaymentStatus::Disputed,
        ],
    ),
    (PaymentStatus::Refunded, &[]),
    (
        PaymentStatus::Disputed,
        &[PaymentStatus::PartiallyRefunded, PaymentStatus::Refunded],
    ),
];

/// `GOVERNANCE_TRANSITIONS`: the edges the AML case executor takes outside the dynamic engine.
///
/// A held `CREATED` attempt is moved straight to `SUCCEEDED` (release) or `FAILED` (void) by
/// `GovernanceExecution.finalizeAmlAttempt`.
pub const GOVERNANCE_TRANSITIONS: [(PaymentStatus, &[PaymentStatus]); 1] = [(
    PaymentStatus::Created,
    &[PaymentStatus::Succeeded, PaymentStatus::Failed],
)];

/// `ATTEMPT_TRANSITIONS[from].includes(to)`.
#[must_use]
pub fn is_allowed(from: PaymentStatus, to: PaymentStatus) -> bool {
    ALLOWED_TRANSITIONS
        .iter()
        .find(|(status, _)| *status == from)
        .is_some_and(|(_, allowed)| allowed.contains(&to))
}

/// `isAllowedTransition` from the seeder mirror: the engine table plus the governance edges.
#[must_use]
pub fn is_allowed_including_governance(from: PaymentStatus, to: PaymentStatus) -> bool {
    is_allowed(from, to)
        || GOVERNANCE_TRANSITIONS
            .iter()
            .find(|(status, _)| *status == from)
            .is_some_and(|(_, allowed)| allowed.contains(&to))
}

/// The outcome of a requested transition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transition {
    /// The table has this edge.
    Allowed,
    /// `next == current`: `transition()` accepts it without consulting the table.
    Idempotent,
}

/// `effective_status_transition`: the transition decision for the main lifecycle, with the error
/// codes of [`crate::error::codes`].
///
/// - `current == next` → [`Transition::Idempotent`] (the engine short-circuits this case).
/// - an edge of `ALLOWED_TRANSITIONS` or `GOVERNANCE_TRANSITIONS` → [`Transition::Allowed`].
/// - a terminal current status (one of the eight `terminal_outcomes`) → `409 ATTEMPT_TERMINAL`.
/// - any other missing edge → `409 INVALID_ATTEMPT_TRANSITION`.
pub fn effective_status_transition(
    current: PaymentStatus,
    next: PaymentStatus,
) -> Result<Transition, FlowError> {
    if current == next {
        return Ok(Transition::Idempotent);
    }
    if is_allowed_including_governance(current, next) {
        return Ok(Transition::Allowed);
    }
    if current.is_terminal() {
        return Err(FlowError::terminal_cannot_finalize(current.as_str()));
    }
    Err(FlowError::invalid_transition(
        current.as_str(),
        next.as_str(),
    ))
}

/// `finalizeGuardFor`: how a finalize signal is treated for the current status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FinalizeGuard {
    /// The attempt may be finalised.
    Allow,
    /// The attempt already settled: a duplicate success is a no-op.
    Idempotent,
    /// The attempt ended without a payment and cannot be resurrected.
    Refuse,
}

/// Port of `finalizeGuardFor` (`DynamicRailEngine.ts:285-293`).
///
/// `SUCCEEDED`, `PARTIALLY_REFUNDED`, `REFUNDED` and `DISPUTED` are idempotent; `CANCELLED` and
/// `BLOCKED` are refused; everything else (including `FAILED` and `EXPIRED`, where a late success is
/// recovered) is allowed.
#[must_use]
pub fn finalize_guard(status: PaymentStatus) -> FinalizeGuard {
    match status {
        PaymentStatus::Succeeded
        | PaymentStatus::PartiallyRefunded
        | PaymentStatus::Refunded
        | PaymentStatus::Disputed => FinalizeGuard::Idempotent,
        PaymentStatus::Cancelled | PaymentStatus::Blocked => FinalizeGuard::Refuse,
        _ => FinalizeGuard::Allow,
    }
}

/// The `ATTEMPT_TERMINAL` error a refused finalize throws.
pub fn refuse_finalize(status: PaymentStatus) -> Result<FinalizeGuard, FlowError> {
    match finalize_guard(status) {
        FinalizeGuard::Refuse => Err(FlowError::terminal_cannot_finalize(status.as_str())),
        allowed => Ok(allowed),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed(current: PaymentStatus) -> &'static [PaymentStatus] {
        ALLOWED_TRANSITIONS
            .iter()
            .find(|(status, _)| *status == current)
            .map(|(_, allowed)| *allowed)
            .expect("every status has an entry")
    }

    /// Golden vector of the full table (`DynamicRailEngine.ts:295-314`).
    #[test]
    fn table_matches_the_engine_golden_vector() {
        use PaymentStatus::*;
        assert_eq!(
            allowed(Created),
            &[
                Initiating,
                AwaitingCustomer,
                Verifying,
                Blocked,
                Cancelled,
                Expired,
                Failed
            ]
        );
        assert_eq!(
            allowed(Initiating),
            &[
                AwaitingCustomer,
                Verifying,
                Failed,
                Blocked,
                Cancelled,
                Expired,
                Unknown
            ]
        );
        assert_eq!(
            allowed(AwaitingCustomer),
            &[
                Authorizing,
                AwaitingCustomer,
                Verifying,
                Failed,
                Cancelled,
                Expired,
                Blocked,
                Unknown
            ]
        );
        assert_eq!(
            allowed(Authorizing),
            &[Verifying, Succeeded, Failed, Unknown, AwaitingCustomer]
        );
        assert_eq!(
            allowed(Verifying),
            &[Verifying, Succeeded, Failed, Unknown, AwaitingCustomer]
        );
        assert_eq!(allowed(Unknown), &[Verifying, Succeeded, Failed, Unknown]);
        assert_eq!(allowed(Succeeded), &[PartiallyRefunded, Refunded, Disputed]);
        assert_eq!(allowed(Failed), &[Succeeded]);
        assert_eq!(allowed(Expired), &[Succeeded]);
        assert!(allowed(Cancelled).is_empty());
        assert!(allowed(Blocked).is_empty());
        assert_eq!(
            allowed(PartiallyRefunded),
            &[PartiallyRefunded, Refunded, Disputed]
        );
        assert!(allowed(Refunded).is_empty());
        assert_eq!(allowed(Disputed), &[PartiallyRefunded, Refunded]);
        // All 14 statuses are present exactly once.
        assert_eq!(ALLOWED_TRANSITIONS.len(), PaymentStatus::ALL.len());
        for status in PaymentStatus::ALL {
            assert_eq!(
                ALLOWED_TRANSITIONS
                    .iter()
                    .filter(|(entry, _)| *entry == status)
                    .count(),
                1
            );
        }
        // Every target is a real status and no self-edge appears where the engine does not need one.
        for (_, targets) in ALLOWED_TRANSITIONS {
            for target in targets {
                assert!(PaymentStatus::ALL.contains(target));
            }
        }
        assert!(!allowed(Created).contains(&Created));
    }

    #[test]
    fn governance_edge_is_held_attempt_release_and_void() {
        assert!(is_allowed_including_governance(
            PaymentStatus::Created,
            PaymentStatus::Succeeded
        ));
        assert!(is_allowed_including_governance(
            PaymentStatus::Created,
            PaymentStatus::Failed
        ));
        // The engine table has CREATED → FAILED but not CREATED → SUCCEEDED; the governance release
        // is the only way a held attempt reaches SUCCEEDED without the engine.
        assert!(!is_allowed(
            PaymentStatus::Created,
            PaymentStatus::Succeeded
        ));
        assert!(is_allowed(PaymentStatus::Created, PaymentStatus::Failed));
        // Only `CREATED` has governance edges (the held attempt).
        assert_eq!(GOVERNANCE_TRANSITIONS.len(), 1);
        assert_eq!(GOVERNANCE_TRANSITIONS[0].0, PaymentStatus::Created);
        assert_eq!(
            GOVERNANCE_TRANSITIONS[0].1,
            &[PaymentStatus::Succeeded, PaymentStatus::Failed]
        );
    }

    #[test]
    fn main_lifecycle_path_is_walkable() {
        use PaymentStatus::*;
        let path = [
            Created,
            Initiating,
            AwaitingCustomer,
            Authorizing,
            Verifying,
            Succeeded,
        ];
        for pair in path.windows(2) {
            assert!(
                is_allowed(pair[0], pair[1]),
                "{:?} → {:?}",
                pair[0],
                pair[1]
            );
        }
        // Refund and dispute states.
        assert_eq!(
            effective_status_transition(Succeeded, Refunded),
            Ok(Transition::Allowed)
        );
        assert_eq!(
            effective_status_transition(Refunded, PartiallyRefunded),
            Err(FlowError::terminal_cannot_finalize("REFUNDED"))
        );
        assert_eq!(
            effective_status_transition(Disputed, Refunded),
            Ok(Transition::Allowed)
        );
        assert_eq!(
            effective_status_transition(PartiallyRefunded, Disputed),
            Ok(Transition::Allowed)
        );
        // A late success is recovered from FAILED and EXPIRED.
        assert_eq!(
            effective_status_transition(Failed, Succeeded),
            Ok(Transition::Allowed)
        );
        assert_eq!(
            effective_status_transition(Expired, Succeeded),
            Ok(Transition::Allowed)
        );
    }

    #[test]
    fn same_status_is_idempotent_before_the_table() {
        // REFUNDED has no outgoing edges but a self-write is still accepted by `transition()`.
        assert_eq!(
            effective_status_transition(PaymentStatus::Refunded, PaymentStatus::Refunded),
            Ok(Transition::Idempotent)
        );
        // And so is a status that is not even in the table's self list.
        assert_eq!(
            effective_status_transition(PaymentStatus::Blocked, PaymentStatus::Blocked),
            Ok(Transition::Idempotent)
        );
    }

    #[test]
    fn illegal_non_terminal_edges_are_invalid_transitions() {
        // `CREATED → SUCCEEDED` is the governance release, so use an edge neither table has.
        let error =
            effective_status_transition(PaymentStatus::Created, PaymentStatus::PartiallyRefunded)
                .expect_err("illegal");
        assert_eq!(error.code, "INVALID_ATTEMPT_TRANSITION");
        assert_eq!(error.status, 409);
        assert_eq!(
            error.message,
            "Attempt cannot transition from CREATED to PARTIALLY_REFUNDED"
        );
        // Backwards movement is refused too.
        assert_eq!(
            effective_status_transition(PaymentStatus::Verifying, PaymentStatus::Created)
                .expect_err("backwards")
                .code,
            "INVALID_ATTEMPT_TRANSITION"
        );
        // The governance release is accepted by the effective table.
        assert_eq!(
            effective_status_transition(PaymentStatus::Created, PaymentStatus::Succeeded),
            Ok(Transition::Allowed)
        );
    }

    #[test]
    fn terminal_states_answer_attempt_terminal() {
        for status in crate::status::terminal_outcomes() {
            // Pick a target the status cannot reach.
            let target = if status == PaymentStatus::Succeeded {
                PaymentStatus::Created
            } else {
                PaymentStatus::Initiating
            };
            let error = effective_status_transition(status, target).expect_err("terminal");
            assert_eq!(error.code, "ATTEMPT_TERMINAL", "{status} → {target}");
            assert_eq!(error.status, 409);
        }
        // CANCELLED/BLOCKED keep the engine's wording.
        assert_eq!(
            effective_status_transition(PaymentStatus::Cancelled, PaymentStatus::Succeeded)
                .expect_err("cancelled")
                .message,
            "The attempt is CANCELLED and can no longer be finalized"
        );
    }

    #[test]
    fn finalize_guard_matches_the_engine() {
        use PaymentStatus::*;
        for status in [Succeeded, PartiallyRefunded, Refunded, Disputed] {
            assert_eq!(
                finalize_guard(status),
                FinalizeGuard::Idempotent,
                "{status}"
            );
        }
        for status in [Cancelled, Blocked] {
            assert_eq!(finalize_guard(status), FinalizeGuard::Refuse, "{status}");
            assert_eq!(
                refuse_finalize(status).expect_err("refused").code,
                "ATTEMPT_TERMINAL"
            );
        }
        // FAILED and EXPIRED stay recoverable; the unpaid in-flight states are allowed too.
        for status in [
            Failed,
            Expired,
            Created,
            Initiating,
            AwaitingCustomer,
            Authorizing,
            Verifying,
            Unknown,
        ] {
            assert_eq!(finalize_guard(status), FinalizeGuard::Allow, "{status}");
            assert_eq!(refuse_finalize(status), Ok(FinalizeGuard::Allow));
        }
    }
}

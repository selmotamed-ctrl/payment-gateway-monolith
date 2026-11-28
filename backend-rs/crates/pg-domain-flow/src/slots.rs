//! Link slot reservation/commit and the attempt-group single-success rule.
//!
//! Port of `core-back/engine/runtime/slotStore.ts:14-146` (`PrismaSlotReservationStore`), the slot
//! checks of `core-back/engine/guards/AttemptGuardPipeline.ts:464-490,710` and the
//! `attempt_groups_single_success` CHECK constraint (`core-back/prisma/schema.prisma`,
//! `CHECK (success_count <= 1)`).
//!
//! The TS implementation does the whole decision in SQL so the row lock and the counter update
//! cannot interleave:
//!
//! ```sql
//! -- reserve
//! SELECT id FROM payment_links
//!  WHERE id = $1::uuid
//!    AND (infinite_use = true OR confirmed_count + active_locked_count < use_count)
//!  FOR UPDATE;
//! UPDATE payment_links SET active_locked_count = active_locked_count + 1, updated_at = now()
//!  WHERE id = $1::uuid
//!    AND (infinite_use = true OR confirmed_count + active_locked_count < use_count);
//!
//! -- commit (the conditional update is the atomic decision)
//! UPDATE payment_links
//!    SET state = CASE WHEN infinite_use = false AND confirmed_count + 1 >= use_count
//!                     THEN 'COMPLETED' ELSE state END,
//!        confirmed_count = confirmed_count + 1,
//!        active_locked_count = GREATEST(0, active_locked_count - 1),
//!        updated_at = now()
//!  WHERE id = $1::uuid
//!    AND (infinite_use = true OR confirmed_count + 1 <= use_count);
//! ```
//!
//! This module is the pure predicate both statements encode, so the repository layer and the parity
//! tests share one definition. An excess settlement is **real money without a slot**: it is routed
//! to `SUSPENSE` with an automatic refund draft and a P1 case, never reported as a clean success
//! (`slotStore.ts:155-202`).

#![forbid(unsafe_code)]

use crate::error::FlowError;

/// `PaymentLinkState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum LinkState {
    Pending,
    Completed,
    Expired,
    Cancelled,
}

impl LinkState {
    /// The Prisma enum name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "PENDING",
            Self::Completed => "COMPLETED",
            Self::Expired => "EXPIRED",
            Self::Cancelled => "CANCELLED",
        }
    }
}

/// The counters of one `payment_links` row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LinkSlotState {
    pub infinite_use: bool,
    pub use_count: u32,
    pub confirmed_count: u32,
    pub active_locked_count: u32,
    pub state: LinkState,
}

impl LinkSlotState {
    /// A single-use, unused link in `PENDING`.
    #[must_use]
    pub fn single(use_count: u32) -> Self {
        Self {
            infinite_use: false,
            use_count,
            confirmed_count: 0,
            active_locked_count: 0,
            state: LinkState::Pending,
        }
    }

    /// An unlimited link.
    #[must_use]
    pub fn unlimited() -> Self {
        Self {
            infinite_use: true,
            use_count: 1,
            confirmed_count: 0,
            active_locked_count: 0,
            state: LinkState::Pending,
        }
    }

    /// `infinite_use = true OR confirmed_count + active_locked_count < use_count`.
    #[must_use]
    pub fn has_free_slot(&self) -> bool {
        self.infinite_use
            || self
                .confirmed_count
                .saturating_add(self.active_locked_count)
                < self.use_count
    }

    /// `infinite_use = true OR confirmed_count + 1 <= use_count`.
    #[must_use]
    pub fn can_commit(&self) -> bool {
        self.infinite_use || self.confirmed_count.saturating_add(1) <= self.use_count
    }

    /// `GREATEST(0, active_locked_count - 1)` after a release.
    #[must_use]
    pub fn released_locked_count(&self) -> u32 {
        self.active_locked_count.saturating_sub(1)
    }

    /// The state after a commit: `COMPLETED` when the last slot of a finite link is taken.
    #[must_use]
    pub fn state_after_commit(&self) -> LinkState {
        if !self.infinite_use && self.confirmed_count.saturating_add(1) >= self.use_count {
            LinkState::Completed
        } else {
            self.state
        }
    }
}

/// One attempt group (`attempt_groups`): unique `(link_id, customer_fingerprint)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttemptGroupState {
    pub link_id: String,
    /// `sha256hex` of the joined non-empty `deviceFingerprint:phone:ip` parts, computed by the
    /// caller (`AttemptGuardPipeline.ts:962-965`); this crate does not hash.
    pub customer_fingerprint: String,
    /// `success_count`; the database CHECK is `success_count <= 1`.
    pub success_count: u32,
}

impl AttemptGroupState {
    /// A group that has not settled yet.
    #[must_use]
    pub fn new(link_id: impl Into<String>, customer_fingerprint: impl Into<String>) -> Self {
        Self {
            link_id: link_id.into(),
            customer_fingerprint: customer_fingerprint.into(),
            success_count: 0,
        }
    }

    /// True when the group already holds its one allowed success.
    #[must_use]
    pub fn already_succeeded(&self) -> bool {
        self.success_count >= 1
    }
}

/// Why a slot action was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlotUnavailable {
    /// `confirmed_count + active_locked_count >= use_count`.
    LinkFull,
    /// The attempt group already recorded a success (`attempt_groups_single_success`).
    GroupAlreadySucceeded,
}

/// The answer of a reserve/commit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SlotDecision {
    /// The slot is reserved; the reservation id is `"{linkId}:{attemptId}"`.
    Reserved { reservation_id: String },
    /// The reservation became a confirmed slot; `state` is the link state after the write.
    Committed { state: LinkState },
    /// The settlement is real but the link has no slot: route it to SUSPENSE.
    Suspense,
    /// Refused before any write.
    Unavailable { reason: SlotUnavailable },
}

impl SlotDecision {
    /// `reserveSlot`: the guard's slot check plus the reservation id.
    ///
    /// The caller must already hold the link row lock (`SELECT … FOR UPDATE`) when it runs the
    /// update; this predicate is what the `WHERE` clause evaluates.
    #[must_use]
    pub fn reserve(link: &LinkSlotState, link_id: &str, attempt_id: &str) -> Self {
        if !link.has_free_slot() {
            return Self::Unavailable {
                reason: SlotUnavailable::LinkFull,
            };
        }
        Self::Reserved {
            reservation_id: slot_reservation_id(link_id, attempt_id),
        }
    }

    /// `commitSlot` without the group rule.
    #[must_use]
    pub fn commit(link: &LinkSlotState) -> Self {
        if !link.can_commit() {
            return Self::Suspense;
        }
        Self::Committed {
            state: link.state_after_commit(),
        }
    }

    /// `commitSlot` plus the attempt-group rule.
    ///
    /// TS has no application-level group guard: the second success violates the
    /// `attempt_groups_single_success` CHECK at commit time and surfaces as a database error. This
    /// pre-check turns it into a deterministic `409 ATTEMPT_GROUP_ALREADY_SUCCEEDED` before any
    /// money is posted (recorded deviation).
    #[must_use]
    pub fn commit_group(link: &LinkSlotState, group: &AttemptGroupState) -> Self {
        if group.already_succeeded() {
            return Self::Unavailable {
                reason: SlotUnavailable::GroupAlreadySucceeded,
            };
        }
        Self::commit(link)
    }

    /// The error a refused decision throws, or `None` for a usable decision.
    #[must_use]
    pub fn error(&self, link_id: &str, fingerprint: &str) -> Option<FlowError> {
        match self {
            Self::Unavailable {
                reason: SlotUnavailable::LinkFull,
            } => Some(FlowError::slot_unavailable()),
            Self::Unavailable {
                reason: SlotUnavailable::GroupAlreadySucceeded,
            } => Some(FlowError::attempt_group_already_succeeded(
                link_id,
                fingerprint,
            )),
            _ => None,
        }
    }

    /// True for `Reserved` and `Committed`.
    #[must_use]
    pub fn succeeded(&self) -> bool {
        matches!(self, Self::Reserved { .. } | Self::Committed { .. })
    }
}

/// The reservation key: `` `${linkId}:${attempt.id}` `` (`slotStore.ts:70`).
#[must_use]
pub fn slot_reservation_id(link_id: &str, attempt_id: &str) -> String {
    format!("{link_id}:{attempt_id}")
}

/// The guard's slot branch (`AttemptGuardPipeline.ts:464-490`): refuse to create the attempt at all.
#[must_use]
pub fn guard_slot_available(link: &LinkSlotState) -> bool {
    link.has_free_slot()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_use_link_takes_exactly_one_slot() {
        let mut link = LinkSlotState::single(1);
        assert!(guard_slot_available(&link));
        let decision = SlotDecision::reserve(&link, "link-1", "attempt-1");
        assert_eq!(
            decision,
            SlotDecision::Reserved {
                reservation_id: "link-1:attempt-1".to_owned()
            }
        );
        // The reservation is now in flight: the next attempt is refused.
        link.active_locked_count = 1;
        assert_eq!(
            SlotDecision::reserve(&link, "link-1", "attempt-2"),
            SlotDecision::Unavailable {
                reason: SlotUnavailable::LinkFull
            }
        );
        assert_eq!(
            SlotDecision::reserve(&link, "link-1", "attempt-2")
                .error("link-1", "fp")
                .expect("error")
                .code,
            "PAYMENT_LINK_SLOT_UNAVAILABLE"
        );
    }

    #[test]
    fn confirmed_plus_locked_must_stay_below_use_count() {
        let mut link = LinkSlotState::single(3);
        link.confirmed_count = 1;
        link.active_locked_count = 1;
        assert!(link.has_free_slot());
        link.active_locked_count = 2;
        // 1 + 2 == 3 → full.
        assert!(!link.has_free_slot());
    }

    #[test]
    fn unlimited_links_never_run_out() {
        let mut link = LinkSlotState::unlimited();
        link.confirmed_count = 1_000_000;
        link.active_locked_count = 500;
        assert!(link.has_free_slot());
        assert!(link.can_commit());
        assert_eq!(
            SlotDecision::commit(&link),
            SlotDecision::Committed {
                state: LinkState::Pending
            }
        );
    }

    #[test]
    fn commit_completes_a_finite_link_on_its_last_slot() {
        let mut link = LinkSlotState::single(2);
        assert_eq!(
            SlotDecision::commit(&link),
            SlotDecision::Committed {
                state: LinkState::Pending
            }
        );
        link.confirmed_count = 1;
        assert_eq!(
            SlotDecision::commit(&link),
            SlotDecision::Committed {
                state: LinkState::Completed
            }
        );
        // A third settlement has no slot: SUSPENSE, never a clean success.
        link.confirmed_count = 2;
        assert_eq!(SlotDecision::commit(&link), SlotDecision::Suspense);
    }

    #[test]
    fn release_floors_at_zero() {
        let mut link = LinkSlotState::single(1);
        link.active_locked_count = 1;
        assert_eq!(link.released_locked_count(), 0);
        link.active_locked_count = 0;
        assert_eq!(link.released_locked_count(), 0);
        link.active_locked_count = 4;
        assert_eq!(link.released_locked_count(), 3);
    }

    #[test]
    fn attempt_group_allows_one_success() {
        let link = LinkSlotState::unlimited();
        let mut group = AttemptGroupState::new("link-1", "fp-1");
        assert!(!group.already_succeeded());
        assert_eq!(
            SlotDecision::commit_group(&link, &group),
            SlotDecision::Committed {
                state: LinkState::Pending
            }
        );
        group.success_count = 1;
        assert!(group.already_succeeded());
        let decision = SlotDecision::commit_group(&link, &group);
        assert_eq!(
            decision,
            SlotDecision::Unavailable {
                reason: SlotUnavailable::GroupAlreadySucceeded
            }
        );
        let error = decision.error("link-1", "fp-1").expect("error");
        assert_eq!(error.code, "ATTEMPT_GROUP_ALREADY_SUCCEEDED");
        assert_eq!(error.status, 409);
        assert_eq!(
            error.details,
            Some(crate::error::FlowErrorDetails::AttemptGroup {
                constraint: "attempt_groups_single_success".to_owned(),
                link_id: "link-1".to_owned(),
                customer_fingerprint: "fp-1".to_owned(),
            })
        );
        // Two successes in the counter would already be a CHECK violation; still refused.
        group.success_count = 2;
        assert!(!SlotDecision::commit_group(&link, &group).succeeded());
    }

    #[test]
    fn reservation_key_matches_the_ts_template() {
        assert_eq!(slot_reservation_id("l", "a"), "l:a");
        assert_eq!(
            slot_reservation_id(
                "0190a5c4-0000-7000-8000-000000000001",
                "0190a5c4-0000-7000-8000-000000000002"
            ),
            "0190a5c4-0000-7000-8000-000000000001:0190a5c4-0000-7000-8000-000000000002"
        );
    }

    #[test]
    fn reservation_without_a_link_id_is_a_failure_elsewhere() {
        // `slotStore.ts:47` throws SLOT_RESERVATION_FAILED when the attempt has no link; the pure
        // predicate cannot know, so the repository raises it.
        assert_eq!(
            FlowError::reservation_failed().code,
            "SLOT_RESERVATION_FAILED"
        );
    }

    #[test]
    fn link_states_round_trip() {
        for (state, name) in [
            (LinkState::Pending, "PENDING"),
            (LinkState::Completed, "COMPLETED"),
            (LinkState::Expired, "EXPIRED"),
            (LinkState::Cancelled, "CANCELLED"),
        ] {
            assert_eq!(state.as_str(), name);
            assert_eq!(
                serde_json::to_string(&state).expect("json"),
                format!("\"{name}\"")
            );
        }
    }
}

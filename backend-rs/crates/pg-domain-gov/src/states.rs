//! AML, adjustment, chargeback, dispute and cash-out state machines.
//!
//! Ports the enums of `core-back/prisma/schema.prisma` (`AmlCaseStatus`, `AdjustmentType`,
//! `AdjustmentState`, `DisputeStatus`, `CashoutState`) and the terminal-state rules of
//! `core-back/engine/governance/GovernanceExecution.ts`:
//!
//! - `executeAmlCaseResolution` (`:1928-2010`): `RELEASED` and `REJECTED_VOID` are final; the
//!   action maps to `RELEASED | REJECTED_VOID | ESCALATED_STR | FROZEN`;
//! - cash-out (`:3261-3345`): `PENDING | PROCESSING` are open, `COMPLETE | SUBTRACTED | REJECTED`
//!   are terminal, repeating the same decision is idempotent and the opposite decision conflicts
//!   with `CASHOUT_STATE_INVALID`;
//! - `disputeOutcomeOf` (`:1633-1641`): `WON` wins, `LOST` and `EXPIRED` lose, everything else has
//!   no outcome yet;
//! - chargeback intake (`engine/workers/BackgroundJobHandlers.ts:359`): the chargeback is capped to
//!   the unrefunded settled amount.

#![forbid(unsafe_code)]

use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

/// `AmlCaseStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AmlCaseStatus {
    Open,
    InReview,
    PendingChecker,
    Released,
    RejectedVoid,
    Frozen,
    EscalatedStr,
}

impl AmlCaseStatus {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Open => "OPEN",
            Self::InReview => "IN_REVIEW",
            Self::PendingChecker => "PENDING_CHECKER",
            Self::Released => "RELEASED",
            Self::RejectedVoid => "REJECTED_VOID",
            Self::Frozen => "FROZEN",
            Self::EscalatedStr => "ESCALATED_STR",
        }
    }

    /// `RELEASED` and `REJECTED_VOID` are final: a second approval answers
    /// `SKIPPED / AML_CASE_ALREADY_RESOLVED`.
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Released | Self::RejectedVoid)
    }

    /// The statuses the cash-out route treats as an open AML hold (`CASHOUT_AML_HOLD`).
    #[must_use]
    pub const fn blocks_payout(self) -> bool {
        !self.is_terminal()
    }
}

/// The four AML case decisions of `amlActionOf`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AmlCaseAction {
    Hold,
    Release,
    Reject,
    Escalate,
}

impl AmlCaseAction {
    /// `amlActionOf`: unknown or missing actions default to `RELEASE`, exactly like the TS.
    #[must_use]
    pub fn parse_wire(value: Option<&str>) -> Self {
        match value
            .unwrap_or("RELEASE")
            .trim()
            .to_ascii_uppercase()
            .as_str()
        {
            "HOLD" => Self::Hold,
            "REJECT" => Self::Reject,
            "ESCALATE" => Self::Escalate,
            _ => Self::Release,
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Hold => "HOLD",
            Self::Release => "RELEASE",
            Self::Reject => "REJECT",
            Self::Escalate => "ESCALATE",
        }
    }

    #[must_use]
    pub const fn target_status(self) -> AmlCaseStatus {
        match self {
            Self::Hold => AmlCaseStatus::Frozen,
            Self::Release => AmlCaseStatus::Released,
            Self::Reject => AmlCaseStatus::RejectedVoid,
            Self::Escalate => AmlCaseStatus::EscalatedStr,
        }
    }

    /// Only release/void are final and claim the case with one conditional update.
    #[must_use]
    pub const fn resolves_the_case(self) -> bool {
        matches!(self, Self::Release | Self::Reject)
    }
}

/// `AdjustmentType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AdjustmentType {
    Chargeback,
    Refund,
    ManualCredit,
    ManualDebit,
    Correction,
    CashoutSubtraction,
}

impl AdjustmentType {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Chargeback => "CHARGEBACK",
            Self::Refund => "REFUND",
            Self::ManualCredit => "MANUAL_CREDIT",
            Self::ManualDebit => "MANUAL_DEBIT",
            Self::Correction => "CORRECTION",
            Self::CashoutSubtraction => "CASHOUT_SUBTRACTION",
        }
    }

    #[must_use]
    pub const fn is_chargeback(self) -> bool {
        matches!(self, Self::Chargeback)
    }
}

/// `AdjustmentState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AdjustmentState {
    Draft,
    PendingReview,
    Approved,
    Executing,
    Executed,
    Rejected,
}

impl AdjustmentState {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "DRAFT",
            Self::PendingReview => "PENDING_REVIEW",
            Self::Approved => "APPROVED",
            Self::Executing => "EXECUTING",
            Self::Executed => "EXECUTED",
            Self::Rejected => "REJECTED",
        }
    }

    /// `EXECUTED` and `REJECTED` are final; a retried refund is idempotent through this state.
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Executed | Self::Rejected)
    }

    /// The adjustment can still move money (or fail while trying).
    #[must_use]
    pub const fn is_open(self) -> bool {
        matches!(
            self,
            Self::Draft | Self::PendingReview | Self::Approved | Self::Executing
        )
    }
}

/// `DisputeStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DisputeStatus {
    Opened,
    EvidenceRequested,
    EvidenceSubmitted,
    Won,
    Lost,
    Expired,
    Withdrawn,
}

impl DisputeStatus {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Opened => "OPENED",
            Self::EvidenceRequested => "EVIDENCE_REQUESTED",
            Self::EvidenceSubmitted => "EVIDENCE_SUBMITTED",
            Self::Won => "WON",
            Self::Lost => "LOST",
            Self::Expired => "EXPIRED",
            Self::Withdrawn => "WITHDRAWN",
        }
    }

    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Won | Self::Lost | Self::Expired | Self::Withdrawn
        )
    }

    /// `DISPUTE_NOT_ACCEPTING_EVIDENCE`: evidence is accepted in `OPENED` and `EVIDENCE_REQUESTED`.
    #[must_use]
    pub const fn is_accepting_evidence(self) -> bool {
        matches!(self, Self::Opened | Self::EvidenceRequested)
    }

    /// `disputeOutcomeOf`.
    #[must_use]
    pub const fn outcome(self) -> Option<ChargebackOutcome> {
        match self {
            Self::Won => Some(ChargebackOutcome::Won),
            Self::Lost | Self::Expired => Some(ChargebackOutcome::Lost),
            _ => None,
        }
    }
}

/// The chargeback outcome the ledger template reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ChargebackOutcome {
    Won,
    Lost,
}

impl ChargebackOutcome {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Won => "WON",
            Self::Lost => "LOST",
        }
    }
}

/// Caps a chargeback to the unrefunded settled amount (never negative).
#[must_use]
pub fn cap_chargeback(amount: Decimal, unrefunded: Decimal) -> Decimal {
    let ceiling = if unrefunded < Decimal::ZERO {
        Decimal::ZERO
    } else {
        unrefunded
    };
    if amount < Decimal::ZERO {
        Decimal::ZERO
    } else if amount > ceiling {
        ceiling
    } else {
        amount
    }
}

/// `CashoutState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CashoutState {
    Pending,
    Rejected,
    Processing,
    Complete,
    Subtracted,
}

impl CashoutState {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "PENDING",
            Self::Rejected => "REJECTED",
            Self::Processing => "PROCESSING",
            Self::Complete => "COMPLETE",
            Self::Subtracted => "SUBTRACTED",
        }
    }

    #[must_use]
    pub const fn is_open(self) -> bool {
        matches!(self, Self::Pending | Self::Processing)
    }

    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Rejected | Self::Complete | Self::Subtracted)
    }
}

impl std::fmt::Display for CashoutState {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// The staff decision on a cash-out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CashoutDecision {
    Approve,
    Reject,
}

impl CashoutDecision {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Approve => "APPROVE",
            Self::Reject => "REJECT",
        }
    }

    #[must_use]
    pub const fn verb(self) -> &'static str {
        match self {
            Self::Approve => "approved",
            Self::Reject => "rejected",
        }
    }
}

/// The pure cash-out transition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CashoutTransition {
    /// Apply the target state with one conditional `UPDATE ... WHERE state IN (open)`.
    Applied { state: CashoutState },
    /// The same decision already happened; answer an idempotent `SKIPPED`.
    Idempotent { reason: &'static str },
    /// The opposite decision already happened; answer `409 CASHOUT_STATE_INVALID`.
    Conflict { state: CashoutState },
}

/// `PENDING | PROCESSING -> COMPLETE` on approval, `-> REJECTED` on rejection.
#[must_use]
pub fn transition_cashout(current: CashoutState, decision: CashoutDecision) -> CashoutTransition {
    match (current, decision) {
        (CashoutState::Rejected, CashoutDecision::Reject) => CashoutTransition::Idempotent {
            reason: "CASHOUT_ALREADY_REJECTED",
        },
        (CashoutState::Complete | CashoutState::Subtracted, CashoutDecision::Approve) => {
            CashoutTransition::Idempotent {
                reason: "CASHOUT_ALREADY_EXECUTED",
            }
        }
        (state, CashoutDecision::Approve) if state.is_open() => CashoutTransition::Applied {
            state: CashoutState::Complete,
        },
        (state, CashoutDecision::Reject) if state.is_open() => CashoutTransition::Applied {
            state: CashoutState::Rejected,
        },
        (state, _) => CashoutTransition::Conflict { state },
    }
}

#[cfg(test)]
mod tests {
    use rust_decimal::Decimal;

    use super::*;

    #[test]
    fn aml_actions_and_terminal_states() {
        assert_eq!(AmlCaseAction::parse_wire(None), AmlCaseAction::Release);
        assert_eq!(
            AmlCaseAction::parse_wire(Some(" reject ")),
            AmlCaseAction::Reject
        );
        assert_eq!(
            AmlCaseAction::parse_wire(Some("nonsense")),
            AmlCaseAction::Release
        );
        assert_eq!(
            AmlCaseAction::Release.target_status(),
            AmlCaseStatus::Released
        );
        assert_eq!(
            AmlCaseAction::Reject.target_status(),
            AmlCaseStatus::RejectedVoid
        );
        assert_eq!(
            AmlCaseAction::Escalate.target_status(),
            AmlCaseStatus::EscalatedStr
        );
        assert_eq!(AmlCaseAction::Hold.target_status(), AmlCaseStatus::Frozen);
        assert!(AmlCaseAction::Release.resolves_the_case());
        assert!(!AmlCaseAction::Escalate.resolves_the_case());

        assert!(AmlCaseStatus::Released.is_terminal());
        assert!(AmlCaseStatus::RejectedVoid.is_terminal());
        assert!(!AmlCaseStatus::EscalatedStr.is_terminal());
        assert!(AmlCaseStatus::PendingChecker.blocks_payout());
        assert!(!AmlCaseStatus::Released.blocks_payout());
    }

    #[test]
    fn dispute_outcomes_match_the_ts_helper() {
        assert_eq!(DisputeStatus::Won.outcome(), Some(ChargebackOutcome::Won));
        assert_eq!(DisputeStatus::Lost.outcome(), Some(ChargebackOutcome::Lost));
        assert_eq!(
            DisputeStatus::Expired.outcome(),
            Some(ChargebackOutcome::Lost)
        );
        assert_eq!(DisputeStatus::Withdrawn.outcome(), None);
        assert_eq!(DisputeStatus::EvidenceSubmitted.outcome(), None);
        assert!(DisputeStatus::Opened.is_accepting_evidence());
        assert!(DisputeStatus::EvidenceRequested.is_accepting_evidence());
        assert!(!DisputeStatus::EvidenceSubmitted.is_accepting_evidence());
        assert!(DisputeStatus::Withdrawn.is_terminal());
        assert!(!DisputeStatus::Opened.is_terminal());
    }

    #[test]
    fn chargeback_is_capped_to_the_unrefunded_amount() {
        let amount = Decimal::new(12_000, 2); // 120.00
        let unrefunded = Decimal::new(8_000, 2); // 80.00
        assert_eq!(cap_chargeback(amount, unrefunded), unrefunded);
        assert_eq!(cap_chargeback(unrefunded, amount), unrefunded);
        assert_eq!(cap_chargeback(amount, Decimal::ZERO), Decimal::ZERO);
        assert_eq!(cap_chargeback(amount, Decimal::new(-5, 2)), Decimal::ZERO);
    }

    #[test]
    fn cashout_state_machine() {
        assert_eq!(
            transition_cashout(CashoutState::Pending, CashoutDecision::Approve),
            CashoutTransition::Applied {
                state: CashoutState::Complete
            }
        );
        assert_eq!(
            transition_cashout(CashoutState::Processing, CashoutDecision::Reject),
            CashoutTransition::Applied {
                state: CashoutState::Rejected
            }
        );
        assert_eq!(
            transition_cashout(CashoutState::Complete, CashoutDecision::Approve),
            CashoutTransition::Idempotent {
                reason: "CASHOUT_ALREADY_EXECUTED"
            }
        );
        assert_eq!(
            transition_cashout(CashoutState::Subtracted, CashoutDecision::Approve),
            CashoutTransition::Idempotent {
                reason: "CASHOUT_ALREADY_EXECUTED"
            }
        );
        assert_eq!(
            transition_cashout(CashoutState::Rejected, CashoutDecision::Reject),
            CashoutTransition::Idempotent {
                reason: "CASHOUT_ALREADY_REJECTED"
            }
        );
        assert_eq!(
            transition_cashout(CashoutState::Complete, CashoutDecision::Reject),
            CashoutTransition::Conflict {
                state: CashoutState::Complete
            }
        );
        assert_eq!(
            transition_cashout(CashoutState::Rejected, CashoutDecision::Approve),
            CashoutTransition::Conflict {
                state: CashoutState::Rejected
            }
        );
        assert!(CashoutState::Pending.is_open());
        assert!(CashoutState::Rejected.is_terminal());
    }

    #[test]
    fn adjustment_terminality() {
        assert!(AdjustmentState::Executed.is_terminal());
        assert!(AdjustmentState::Rejected.is_terminal());
        assert!(!AdjustmentState::Executing.is_terminal());
        assert!(AdjustmentState::Executing.is_open());
        assert!(!AdjustmentState::Rejected.is_open());
        assert!(AdjustmentType::Chargeback.is_chargeback());
        assert!(!AdjustmentType::Refund.is_chargeback());
    }
}

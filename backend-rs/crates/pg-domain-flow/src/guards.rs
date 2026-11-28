//! The attempt-creation guard pipeline: ordered stages and the decision.
//!
//! Port of `core-back/engine/guards/AttemptGuardPipeline.ts:351-868` (`AttemptGuardPipeline.guard`)
//! and the `GuardOutcome` union at `:34`.
//!
//! The guard is the transaction that reserves the link slot and creates the attempt (design §9.1
//! rule 2): velocity, watch list and AML rules run **inside** it, so a rejected payment leaves a
//! terminal `BLOCKED` attempt behind and a held payment leaves its substatus for the case executor.
//! This module enumerates the stages in the order the TS method performs them; the IO of each stage
//! belongs to the repository layer.

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};

/// One ordered stage of `AttemptGuardPipeline.guard`.
///
/// The discriminants are the order of execution and must not be reordered: the cheap pre-checks
/// come before the screening provider, and the slot counter is incremented only after every rule
/// passed (`:710`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum GuardStage {
    /// `:359-391` — a replay of `(link, idempotency key)` returns the existing attempt.
    IdempotentReplay,
    /// `:393` — `lockLinkByKey` takes the link row lock.
    LinkLock,
    /// `:397-402` — the link must be `PENDING` and not expired.
    LinkState,
    /// `:405-411` — `assertCommerceActive`: suspended application, frozen wallet, POS state.
    CommerceStatus,
    /// `:414-417` — the merchant of the application/link exists.
    MerchantResolution,
    /// `:422` — the pinned route (or the resolved active+healthy one).
    RouteResolution,
    /// `:423` — surcharge, total charged, commission, net and gateway fee.
    AmountResolution,
    /// `:425-430` — `resolveSettlementTarget`.
    SettlementTarget,
    /// `:432-462` — merchant posture (KYB, limits, ownership) decided before any slot is taken.
    MerchantPosture,
    /// `:464-490` — `infinite_use || confirmed_count + active_locked_count < use_count`.
    LinkSlot,
    /// `:495-524` — a merchant wallet paying its own link (`SELF_PAYMENT_POLICY`).
    SelfPayment,
    /// `:529` — publish the watch list before the hot-path screen runs.
    WatchlistPublish,
    /// `:531-571` — hot-path screening, fail closed on an unavailable provider.
    HotPathScreening,
    /// `:572-602` — a confirmed sanctions match is a block.
    SanctionsConfirmedMatch,
    /// `:604-647` — velocity rules: `REJECT` blocks, `FLAG` continues.
    VelocityRules,
    /// `:649-708` — AML rules: `BLOCK` here, `HOLD`/`CASE_ONLY`/`FLAG` later.
    AmlRules,
    /// `:710` — `updateLinkSlotCount(tx, link.id, 1)`.
    SlotReserve,
    /// `:711` — the `(link, customer_fingerprint)` attempt group upsert.
    AttemptGroup,
    /// `:725-767` — create the attempt as `CREATED` with the pinned configuration.
    AttemptCreate,
    /// `:769-791` — the AML case for rule hits or screening matches.
    AmlCaseOpen,
    /// `:801-811` — a held attempt gets `substatus = AML_HOLD`; nothing is escrowed yet (GAP-015).
    HoldSubstatus,
    /// `:813-827` — `ATTEMPT_GUARD_EVALUATED` audit row when the caller is a user.
    GuardAudit,
}

impl GuardStage {
    /// Every stage, in execution order.
    pub const ALL: [Self; 22] = [
        Self::IdempotentReplay,
        Self::LinkLock,
        Self::LinkState,
        Self::CommerceStatus,
        Self::MerchantResolution,
        Self::RouteResolution,
        Self::AmountResolution,
        Self::SettlementTarget,
        Self::MerchantPosture,
        Self::LinkSlot,
        Self::SelfPayment,
        Self::WatchlistPublish,
        Self::HotPathScreening,
        Self::SanctionsConfirmedMatch,
        Self::VelocityRules,
        Self::AmlRules,
        Self::SlotReserve,
        Self::AttemptGroup,
        Self::AttemptCreate,
        Self::AmlCaseOpen,
        Self::HoldSubstatus,
        Self::GuardAudit,
    ];

    /// The stage name used in logs and error details.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::IdempotentReplay => "IDEMPOTENT_REPLAY",
            Self::LinkLock => "LINK_LOCK",
            Self::LinkState => "LINK_STATE",
            Self::CommerceStatus => "COMMERCE_STATUS",
            Self::MerchantResolution => "MERCHANT_RESOLUTION",
            Self::RouteResolution => "ROUTE_RESOLUTION",
            Self::AmountResolution => "AMOUNT_RESOLUTION",
            Self::SettlementTarget => "SETTLEMENT_TARGET",
            Self::MerchantPosture => "MERCHANT_POSTURE",
            Self::LinkSlot => "LINK_SLOT",
            Self::SelfPayment => "SELF_PAYMENT",
            Self::WatchlistPublish => "WATCHLIST_PUBLISH",
            Self::HotPathScreening => "HOT_PATH_SCREENING",
            Self::SanctionsConfirmedMatch => "SANCTIONS_CONFIRMED_MATCH",
            Self::VelocityRules => "VELOCITY_RULES",
            Self::AmlRules => "AML_RULES",
            Self::SlotReserve => "SLOT_RESERVE",
            Self::AttemptGroup => "ATTEMPT_GROUP",
            Self::AttemptCreate => "ATTEMPT_CREATE",
            Self::AmlCaseOpen => "AML_CASE_OPEN",
            Self::HoldSubstatus => "HOLD_SUBSTATUS",
            Self::GuardAudit => "GUARD_AUDIT",
        }
    }

    /// Zero-based position in [`Self::ALL`].
    #[must_use]
    pub fn ordinal(self) -> usize {
        Self::ALL
            .iter()
            .position(|stage| *stage == self)
            .unwrap_or(Self::ALL.len())
    }

    /// True for the stages that run before the screening provider is called.
    #[must_use]
    pub fn is_pre_screening(self) -> bool {
        self.ordinal() < Self::WatchlistPublish.ordinal()
    }

    /// True for the stages that write evidence (slot counter, attempt, case, substatus, audit).
    #[must_use]
    pub fn writes(self) -> bool {
        self.ordinal() >= Self::SlotReserve.ordinal()
    }
}

/// The TS `GuardOutcome` union.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AllowedOutcome {
    /// No rule hit.
    Allow,
    /// A velocity rule flagged the payment; it continues.
    Flag,
    /// An AML rule held the payment; the money is escrowed after a verified capture.
    Hold,
    /// An AML case was opened but the payment continues.
    CaseOnly,
}

impl AllowedOutcome {
    /// The TS union name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Allow => "ALLOW",
            Self::Flag => "FLAG",
            Self::Hold => "HOLD",
            Self::CaseOnly => "CASE_ONLY",
        }
    }

    /// A held attempt reserves the slot until its case is decided.
    #[must_use]
    pub fn hold_required(self) -> bool {
        self == Self::Hold
    }
}

/// Why an attempt was refused (the `reason` strings `blockDecision` is called with).
pub mod block_codes {
    /// `:472` — the link has no free slot; customer message `PAYMENT_IN_PROGRESS`.
    pub const PAYMENT_LINK_SLOT_UNAVAILABLE: &str = "PAYMENT_LINK_SLOT_UNAVAILABLE";
    /// `:505` — a merchant wallet paying its own link under `SELF_PAYMENT_POLICY = BLOCK`.
    pub const SELF_PAYMENT_NOT_ALLOWED: &str = "SELF_PAYMENT_NOT_ALLOWED";
    /// `:551` — the screening provider was unavailable and the policy is fail-closed.
    pub const SCREENING_UNAVAILABLE: &str = "SCREENING_UNAVAILABLE";
    /// `:584` — a confirmed sanctions match; the full code is `SCREENING_CONFIRMED_MATCH:<list>`.
    pub const SCREENING_CONFIRMED_MATCH: &str = "SCREENING_CONFIRMED_MATCH";
    /// `:629` — a velocity `REJECT`; the full code is `VELOCITY_REJECT:<ruleId>`.
    pub const VELOCITY_REJECT: &str = "VELOCITY_REJECT";
    /// `:690` — an AML `BLOCK`; the full code is `AML_BLOCK:<ruleCode>`.
    pub const AML_BLOCK: &str = "AML_BLOCK";
}

/// The `customerMessageCode` values of the guard (`:114,450,478,...`).
pub mod customer_messages {
    /// The payment continues.
    pub const OK: &str = "OK";
    /// Generic refusal message.
    pub const PAYMENT_CANNOT_BE_PROCESSED: &str = "PAYMENT_CANNOT_BE_PROCESSED";
    /// Another payment is already using the link slot.
    pub const PAYMENT_IN_PROGRESS: &str = "PAYMENT_IN_PROGRESS";
    /// The payment is held for review.
    pub const PAYMENT_UNDER_REVIEW: &str = "PAYMENT_UNDER_REVIEW";
}

/// `SCREENING_CONFIRMED_MATCH:<listType>`.
#[must_use]
pub fn screening_match_block_code(list_type: &str) -> String {
    format!("{}:{list_type}", block_codes::SCREENING_CONFIRMED_MATCH)
}

/// `VELOCITY_REJECT:<ruleId>`.
#[must_use]
pub fn velocity_reject_code(rule_id: &str) -> String {
    format!("{}:{rule_id}", block_codes::VELOCITY_REJECT)
}

/// `AML_BLOCK:<ruleCode>`.
#[must_use]
pub fn aml_block_code(rule_code: &str) -> String {
    format!("{}:{rule_code}", block_codes::AML_BLOCK)
}

/// The guard's answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GuardDecision {
    /// The attempt was created (or replayed); `outcome` says whether a rule flagged or held it.
    Allow { outcome: AllowedOutcome },
    /// The payment was refused; the code is the `reason` the TS stores on the terminal attempt.
    Block { code: String, message: String },
}

impl GuardDecision {
    /// `ALLOW`.
    #[must_use]
    pub fn allow() -> Self {
        Self::Allow {
            outcome: AllowedOutcome::Allow,
        }
    }

    /// A non-blocking rule outcome.
    #[must_use]
    pub fn allow_with(outcome: AllowedOutcome) -> Self {
        Self::Allow { outcome }
    }

    /// A refusal with the guard's reason code.
    #[must_use]
    pub fn block(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Block {
            code: code.into(),
            message: message.into(),
        }
    }

    /// True for every `Allow` decision.
    #[must_use]
    pub fn is_allowed(&self) -> bool {
        matches!(self, Self::Allow { .. })
    }

    /// The `customerMessageCode` of the TS decision (`:114`).
    #[must_use]
    pub fn customer_message_code(&self) -> &'static str {
        match self {
            Self::Allow { outcome } => match outcome {
                AllowedOutcome::Allow | AllowedOutcome::Flag => customer_messages::OK,
                AllowedOutcome::Hold | AllowedOutcome::CaseOnly => {
                    customer_messages::PAYMENT_UNDER_REVIEW
                }
            },
            Self::Block { code, .. } => {
                if code == block_codes::PAYMENT_LINK_SLOT_UNAVAILABLE {
                    customer_messages::PAYMENT_IN_PROGRESS
                } else {
                    customer_messages::PAYMENT_CANNOT_BE_PROCESSED
                }
            }
        }
    }

    /// The `holdRequired` flag: only a `HOLD` outcome requires the escrow after capture.
    #[must_use]
    pub fn hold_required(&self) -> bool {
        matches!(
            self,
            Self::Allow {
                outcome: AllowedOutcome::Hold
            }
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stages_are_ordered_and_named() {
        assert_eq!(GuardStage::ALL.len(), 22);
        for (index, stage) in GuardStage::ALL.into_iter().enumerate() {
            assert_eq!(stage.ordinal(), index);
            // The serialised name is the same SCREAMING_SNAKE name as `as_str`.
            assert_eq!(
                serde_json::to_string(&stage).expect("json"),
                format!("\"{}\"", stage.as_str())
            );
        }
        assert_eq!(GuardStage::ALL[0], GuardStage::IdempotentReplay);
        assert_eq!(GuardStage::LinkLock.as_str(), "LINK_LOCK");
        assert_eq!(GuardStage::ALL[9].as_str(), "LINK_SLOT");
        assert_eq!(GuardStage::ALL[21].as_str(), "GUARD_AUDIT");
        // The slot counter is only written after every rule passed.
        assert!(GuardStage::SelfPayment.ordinal() < GuardStage::SlotReserve.ordinal());
        assert!(GuardStage::AmlRules.ordinal() < GuardStage::SlotReserve.ordinal());
        assert!(GuardStage::HotPathScreening.ordinal() < GuardStage::VelocityRules.ordinal());
        // The last stage is the audit row.
        assert_eq!(
            GuardStage::ALL.last().copied(),
            Some(GuardStage::GuardAudit)
        );
    }

    #[test]
    fn stage_groups() {
        for stage in [
            GuardStage::IdempotentReplay,
            GuardStage::LinkLock,
            GuardStage::LinkState,
            GuardStage::CommerceStatus,
            GuardStage::MerchantPosture,
            GuardStage::LinkSlot,
            GuardStage::SelfPayment,
        ] {
            assert!(stage.is_pre_screening(), "{stage:?}");
        }
        assert!(!GuardStage::WatchlistPublish.is_pre_screening());
        assert!(!GuardStage::AmlRules.is_pre_screening());
        for stage in [
            GuardStage::SlotReserve,
            GuardStage::AttemptGroup,
            GuardStage::AttemptCreate,
            GuardStage::AmlCaseOpen,
            GuardStage::HoldSubstatus,
            GuardStage::GuardAudit,
        ] {
            assert!(stage.writes(), "{stage:?}");
        }
        for stage in [
            GuardStage::IdempotentReplay,
            GuardStage::LinkLock,
            GuardStage::LinkState,
            GuardStage::VelocityRules,
            GuardStage::AmlRules,
        ] {
            assert!(!stage.writes(), "{stage:?}");
        }
    }

    #[test]
    fn block_codes_keep_their_parameter_suffix() {
        assert_eq!(
            screening_match_block_code("SANCTIONS"),
            "SCREENING_CONFIRMED_MATCH:SANCTIONS"
        );
        assert_eq!(velocity_reject_code("rule-1"), "VELOCITY_REJECT:rule-1");
        assert_eq!(aml_block_code("STRUCTURING"), "AML_BLOCK:STRUCTURING");
    }

    #[test]
    fn decisions_and_customer_messages() {
        assert!(GuardDecision::allow().is_allowed());
        assert_eq!(GuardDecision::allow().customer_message_code(), "OK");
        assert_eq!(
            GuardDecision::allow_with(AllowedOutcome::Flag).customer_message_code(),
            "OK"
        );
        let hold = GuardDecision::allow_with(AllowedOutcome::Hold);
        assert!(hold.hold_required());
        assert_eq!(hold.customer_message_code(), "PAYMENT_UNDER_REVIEW");
        assert_eq!(
            GuardDecision::allow_with(AllowedOutcome::CaseOnly).customer_message_code(),
            "PAYMENT_UNDER_REVIEW"
        );
        assert!(!GuardDecision::allow_with(AllowedOutcome::CaseOnly).hold_required());

        let blocked = GuardDecision::block(block_codes::PAYMENT_LINK_SLOT_UNAVAILABLE, "no slot");
        assert!(!blocked.is_allowed());
        assert!(!blocked.hold_required());
        assert_eq!(blocked.customer_message_code(), "PAYMENT_IN_PROGRESS");
        assert_eq!(
            GuardDecision::block(aml_block_code("STRUCTURING"), "aml").customer_message_code(),
            "PAYMENT_CANNOT_BE_PROCESSED"
        );
        assert_eq!(
            GuardDecision::block(block_codes::SELF_PAYMENT_NOT_ALLOWED, "self")
                .customer_message_code(),
            "PAYMENT_CANNOT_BE_PROCESSED"
        );
    }

    #[test]
    fn allowed_outcomes_round_trip() {
        for outcome in [
            AllowedOutcome::Allow,
            AllowedOutcome::Flag,
            AllowedOutcome::Hold,
            AllowedOutcome::CaseOnly,
        ] {
            let json = serde_json::to_string(&outcome).expect("json");
            assert_eq!(json, format!("\"{}\"", outcome.as_str()));
            assert_eq!(outcome == AllowedOutcome::Hold, outcome.hold_required());
        }
    }
}

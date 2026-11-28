//! Attempt statuses, substatuses and the dashboard success-rate rule.
//!
//! Port of `core-back/prisma/schema.prisma` (`enum AttemptStatus`),
//! `core-back/lib/attemptOutcomes.ts` and the dashboard aggregate in
//! `core-back/api/internal/admin.ts` (`attemptsCounted`).
//!
//! The Prisma column `PaymentAttempt.substatus` is free text (`String?`), so
//! [`AttemptSubstatus`] is a closed list of the values the engine writes plus
//! [`AttemptSubstatus::Other`] for anything an operator or an older build stored.

#![forbid(unsafe_code)]

use rust_decimal::prelude::ToPrimitive as _;
use rust_decimal::{Decimal, RoundingStrategy};
use serde::{Deserialize, Serialize};

/// The 14 `AttemptStatus` values, in Prisma declaration order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PaymentStatus {
    Created,
    Initiating,
    AwaitingCustomer,
    Authorizing,
    Verifying,
    Unknown,
    Succeeded,
    Failed,
    Expired,
    Cancelled,
    Blocked,
    PartiallyRefunded,
    Refunded,
    Disputed,
}

impl PaymentStatus {
    /// Every status, in Prisma order.
    pub const ALL: [Self; 14] = [
        Self::Created,
        Self::Initiating,
        Self::AwaitingCustomer,
        Self::Authorizing,
        Self::Verifying,
        Self::Unknown,
        Self::Succeeded,
        Self::Failed,
        Self::Expired,
        Self::Cancelled,
        Self::Blocked,
        Self::PartiallyRefunded,
        Self::Refunded,
        Self::Disputed,
    ];

    /// The Prisma enum name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Created => "CREATED",
            Self::Initiating => "INITIATING",
            Self::AwaitingCustomer => "AWAITING_CUSTOMER",
            Self::Authorizing => "AUTHORIZING",
            Self::Verifying => "VERIFYING",
            Self::Unknown => "UNKNOWN",
            Self::Succeeded => "SUCCEEDED",
            Self::Failed => "FAILED",
            Self::Expired => "EXPIRED",
            Self::Cancelled => "CANCELLED",
            Self::Blocked => "BLOCKED",
            Self::PartiallyRefunded => "PARTIALLY_REFUNDED",
            Self::Refunded => "REFUNDED",
            Self::Disputed => "DISPUTED",
        }
    }

    /// Parse the Prisma enum name (case sensitive, like the database).
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        Some(match raw {
            "CREATED" => Self::Created,
            "INITIATING" => Self::Initiating,
            "AWAITING_CUSTOMER" => Self::AwaitingCustomer,
            "AUTHORIZING" => Self::Authorizing,
            "VERIFYING" => Self::Verifying,
            "UNKNOWN" => Self::Unknown,
            "SUCCEEDED" => Self::Succeeded,
            "FAILED" => Self::Failed,
            "EXPIRED" => Self::Expired,
            "CANCELLED" => Self::Cancelled,
            "BLOCKED" => Self::Blocked,
            "PARTIALLY_REFUNDED" => Self::PartiallyRefunded,
            "REFUNDED" => Self::Refunded,
            "DISPUTED" => Self::Disputed,
            _ => return None,
        })
    }

    /// `TERMINAL_STATUSES` (`prisma/syntheticSeeder/lifecycle.ts:40`): the eight statuses that set
    /// `terminal_at`.
    #[must_use]
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Succeeded
                | Self::Failed
                | Self::Expired
                | Self::Cancelled
                | Self::Blocked
                | Self::PartiallyRefunded
                | Self::Refunded
                | Self::Disputed
        )
    }

    /// The success statuses of the dashboard rule (`merchantSuccessStatuses`).
    ///
    /// A later refund or dispute does not turn the original processing result into a failure.
    #[must_use]
    pub fn is_success_for_rate(self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::PartiallyRefunded | Self::Refunded | Self::Disputed
        )
    }

    /// The problematic statuses (`problematicAttemptStatuses`): a processing outcome that is not a
    /// success.
    #[must_use]
    pub fn is_problematic_for_rate(self) -> bool {
        matches!(self, Self::Failed | Self::Unknown)
    }

    /// True when the status enters the success-rate denominator: success or processing failure.
    /// Pending/in-flight attempts and deliberate/no-processing outcomes are excluded.
    #[must_use]
    pub fn is_counted_for_success_rate(self) -> bool {
        self.is_success_for_rate() || self.is_problematic_for_rate()
    }

    /// `IN_FLIGHT_STATUSES` (`lifecycle.ts:39`).
    #[must_use]
    pub fn is_in_flight(self) -> bool {
        matches!(
            self,
            Self::Created
                | Self::Initiating
                | Self::AwaitingCustomer
                | Self::Authorizing
                | Self::Verifying
                | Self::Unknown
        )
    }

    /// `SETTLED_STATUSES`: the attempt reached `SUCCEEDED` at some point, so money is held.
    #[must_use]
    pub fn holds_money(self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::PartiallyRefunded | Self::Refunded | Self::Disputed
        )
    }

    /// `SLOT_RELEASING_STATUSES` (`TERMINAL_RELEASING_STATES`): a terminal non-success releases the
    /// reserved link slot.
    #[must_use]
    pub fn releases_slot(self) -> bool {
        matches!(
            self,
            Self::Failed | Self::Expired | Self::Cancelled | Self::Blocked
        )
    }

    /// `isSuccessAttemptStatus`: case-insensitive over the success set (the TS accepts `unknown` and
    /// upper-cases it).
    #[must_use]
    pub fn is_success_str(value: &str) -> bool {
        Self::parse(&value.to_ascii_uppercase()).is_some_and(Self::is_success_for_rate)
    }

    /// `isAttemptCounted`: case-insensitive over the denominator set.
    #[must_use]
    pub fn is_counted_str(value: &str) -> bool {
        Self::parse(&value.to_ascii_uppercase()).is_some_and(Self::is_counted_for_success_rate)
    }
}

/// How one status contributes to the dashboard success rate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SuccessRateClass {
    /// A processed payment (`SUCCEEDED`, `PARTIALLY_REFUNDED`, `REFUNDED`, `DISPUTED`).
    Success,
    /// A processing failure or an unresolved result (`FAILED`, `UNKNOWN`).
    Problematic,
    /// Pending/in-flight or deliberately ended without processing.
    Excluded,
}

impl PaymentStatus {
    /// The dashboard classification (`attemptOutcomes.ts`).
    #[must_use]
    pub fn success_rate_class(self) -> SuccessRateClass {
        if self.is_success_for_rate() {
            SuccessRateClass::Success
        } else if self.is_problematic_for_rate() {
            SuccessRateClass::Problematic
        } else {
            SuccessRateClass::Excluded
        }
    }
}

/// The terminal outcomes: the eight statuses that end an attempt.
///
/// Source of truth: `prisma/syntheticSeeder/lifecycle.ts:40` (`TERMINAL_STATUSES`), which the engine
/// and the seeder share.
#[must_use]
pub fn terminal_outcomes() -> [PaymentStatus; 8] {
    [
        PaymentStatus::Succeeded,
        PaymentStatus::Failed,
        PaymentStatus::Expired,
        PaymentStatus::Cancelled,
        PaymentStatus::Blocked,
        PaymentStatus::Refunded,
        PaymentStatus::PartiallyRefunded,
        PaymentStatus::Disputed,
    ]
}

/// The statuses that count toward the success rate: `successes + FAILED + UNKNOWN`.
#[must_use]
pub fn counted_outcomes() -> [PaymentStatus; 6] {
    [
        PaymentStatus::Succeeded,
        PaymentStatus::PartiallyRefunded,
        PaymentStatus::Refunded,
        PaymentStatus::Disputed,
        PaymentStatus::Failed,
        PaymentStatus::Unknown,
    ]
}

/// The statuses the dashboard excludes from the denominator.
#[must_use]
pub fn excluded_outcomes() -> [PaymentStatus; 8] {
    [
        PaymentStatus::Created,
        PaymentStatus::Initiating,
        PaymentStatus::AwaitingCustomer,
        PaymentStatus::Authorizing,
        PaymentStatus::Verifying,
        PaymentStatus::Cancelled,
        PaymentStatus::Expired,
        PaymentStatus::Blocked,
    ]
}

/// `successRatePercent` as an exact decimal: `succeeded / counted * 100`, two decimal places,
/// half away from zero (the rounding JS `toFixed(2)` applies to a positive rate).
///
/// Returns `None` when `counted` is 0. The TS helper returns `0` in that case so the card can show
/// `0%`; the caller renders the zero, and `None` keeps "no data" distinguishable from "0 %".
#[must_use]
pub fn success_rate(succeeded: u32, counted: u32) -> Option<Decimal> {
    if counted == 0 {
        return None;
    }
    let succeeded = Decimal::from(succeeded);
    let counted = Decimal::from(counted);
    let percentage = succeeded
        .checked_div(counted)?
        .checked_mul(Decimal::from(100))?;
    Some(percentage.round_dp_with_strategy(2, RoundingStrategy::MidpointAwayFromZero))
}

/// The percentage as an `f64`, only for chart payloads (never for money).
#[must_use]
pub fn success_rate_f64(succeeded: u32, counted: u32) -> Option<f64> {
    success_rate(succeeded, counted)?.to_f64()
}

/// The `AML_VOID` substatus (`AML_VOID_SUBSTATUS`, `DynamicRailEngine.ts:278`), kept next to the
/// status vocabulary it belongs to.
pub const TERMINAL_SUBSTATUS_AML_VOID: &str = "AML_VOID";

/// The known `payment_attempts.substatus` values.
///
/// Prisma stores free text (`String?`), so [`Self::Other`] keeps unknown values intact. Serialization
/// is [`Self::as_str`] (the repository writes that string); serde is deliberately not derived on the
/// mixed closed/open enum.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum AttemptSubstatus {
    /// Set by the guard pipeline when an AML rule holds the payment (`AML_HOLD_SUBSTATUS`).
    AmlHold,
    /// Set by the AML case executor when a held attempt is rejected (`AML_VOID_SUBSTATUS`).
    AmlVoid,
    /// Set on a settlement routed to SUSPENSE because the slot was already used.
    SuspenseSettlement,
    /// Set while a finalize is in progress.
    Finalizing,
    /// Manual resolution: the operator settled the attempt.
    OperatorResolvedSucceeded,
    /// Manual resolution: the operator failed the attempt.
    OperatorResolvedFailed,
    /// Any other stored value (free-text column).
    Other(String),
}

impl AttemptSubstatus {
    /// The value written to `payment_attempts.substatus`.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::AmlHold => "AML_HOLD",
            Self::AmlVoid => "AML_VOID",
            Self::SuspenseSettlement => "SUSPENSE_SETTLEMENT",
            Self::Finalizing => "FINALIZING",
            Self::OperatorResolvedSucceeded => "OPERATOR_RESOLVED_SUCCEEDED",
            Self::OperatorResolvedFailed => "OPERATOR_RESOLVED_FAILED",
            Self::Other(value) => value,
        }
    }

    /// Parse a stored value into the closed list.
    #[must_use]
    pub fn parse(raw: &str) -> Self {
        match raw {
            "AML_HOLD" => Self::AmlHold,
            "AML_VOID" => Self::AmlVoid,
            "SUSPENSE_SETTLEMENT" => Self::SuspenseSettlement,
            "FINALIZING" => Self::Finalizing,
            "OPERATOR_RESOLVED_SUCCEEDED" => Self::OperatorResolvedSucceeded,
            "OPERATOR_RESOLVED_FAILED" => Self::OperatorResolvedFailed,
            other => Self::Other(other.to_owned()),
        }
    }

    /// True for the substatuses that hold or void money for an AML case.
    #[must_use]
    pub fn is_aml(&self) -> bool {
        matches!(self, Self::AmlHold | Self::AmlVoid)
    }
}

impl std::fmt::Display for PaymentStatus {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl std::fmt::Display for AttemptSubstatus {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    #[test]
    fn prisma_names_round_trip() {
        assert_eq!(PaymentStatus::ALL.len(), 14);
        for status in PaymentStatus::ALL {
            assert_eq!(PaymentStatus::parse(status.as_str()), Some(status));
            let json = serde_json::to_string(&status).expect("json");
            assert_eq!(json, format!("\"{}\"", status.as_str()));
            let back: PaymentStatus = serde_json::from_str(&json).expect("back");
            assert_eq!(back, status);
        }
        assert_eq!(PaymentStatus::parse("created"), None);
        assert_eq!(PaymentStatus::parse("SUCCESS"), None);
    }

    #[test]
    fn terminal_and_in_flight_partition_the_statuses() {
        let terminal: Vec<PaymentStatus> = PaymentStatus::ALL
            .into_iter()
            .filter(|status| status.is_terminal())
            .collect();
        assert_eq!(terminal.len(), 8);
        for status in PaymentStatus::ALL {
            assert_ne!(
                status.is_terminal(),
                status.is_in_flight(),
                "{} must be exactly one of terminal/in-flight",
                status
            );
        }
        assert!(PaymentStatus::Unknown.is_in_flight());
        assert!(!PaymentStatus::Unknown.is_terminal());
        assert!(PaymentStatus::Disputed.is_terminal());
    }

    #[test]
    fn terminal_outcomes_are_the_lifecycle_set() {
        let listed = terminal_outcomes();
        assert_eq!(listed.len(), 8);
        for status in listed {
            assert!(status.is_terminal());
        }
        // Every terminal status is listed exactly once.
        for status in PaymentStatus::ALL {
            assert_eq!(
                listed.iter().filter(|entry| **entry == status).count(),
                usize::from(status.is_terminal())
            );
        }
        assert_eq!(TERMINAL_SUBSTATUS_AML_VOID, "AML_VOID");
    }

    #[test]
    fn success_rate_sets_match_the_dashboard_rule() {
        let success = [
            PaymentStatus::Succeeded,
            PaymentStatus::PartiallyRefunded,
            PaymentStatus::Refunded,
            PaymentStatus::Disputed,
        ];
        let problematic = [PaymentStatus::Failed, PaymentStatus::Unknown];
        let excluded = [
            PaymentStatus::Created,
            PaymentStatus::Initiating,
            PaymentStatus::AwaitingCustomer,
            PaymentStatus::Authorizing,
            PaymentStatus::Verifying,
            PaymentStatus::Cancelled,
            PaymentStatus::Expired,
            PaymentStatus::Blocked,
        ];
        assert_eq!(counted_outcomes().len(), success.len() + problematic.len());
        assert_eq!(excluded_outcomes(), excluded);
        for status in success {
            assert_eq!(status.success_rate_class(), SuccessRateClass::Success);
            assert!(status.is_counted_for_success_rate());
        }
        for status in problematic {
            assert_eq!(status.success_rate_class(), SuccessRateClass::Problematic);
            assert!(status.is_counted_for_success_rate());
        }
        for status in excluded {
            assert_eq!(status.success_rate_class(), SuccessRateClass::Excluded);
            assert!(!status.is_counted_for_success_rate());
        }
        // Counted + excluded covers all 14 statuses.
        let counted = counted_outcomes()
            .into_iter()
            .filter(|status| status.is_counted_for_success_rate())
            .count();
        assert_eq!(counted + excluded_outcomes().len(), 14);
    }

    #[test]
    fn pending_attempts_never_lower_the_rate() {
        // A link with 3 processed payments and 100 abandoned/pending attempts is still 100 %.
        let succeeded = 3;
        let counted = 3;
        assert_eq!(
            success_rate(succeeded, counted),
            Some(Decimal::from_str("100.00").expect("decimal"))
        );
    }

    #[test]
    fn success_rate_rounds_to_two_places_like_tofixed() {
        // The live API values recorded on 2026-11-16.
        assert_eq!(
            success_rate(464, 951),
            Some(Decimal::from_str("48.79").expect("decimal"))
        );
        assert_eq!(
            success_rate(1793, 2629),
            Some(Decimal::from_str("68.20").expect("decimal"))
        );
        assert_eq!(
            success_rate(3714, 5108),
            Some(Decimal::from_str("72.71").expect("decimal"))
        );
        // 1/8 = 12.5 % keeps both places; 1/3 = 33.33 %.
        assert_eq!(
            success_rate(1, 8),
            Some(Decimal::from_str("12.50").expect("decimal"))
        );
        assert_eq!(
            success_rate(1, 3),
            Some(Decimal::from_str("33.33").expect("decimal"))
        );
        // Half away from zero: 0.125 % → 0.13.
        assert_eq!(
            success_rate(1, 800),
            Some(Decimal::from_str("0.13").expect("decimal"))
        );
        assert_eq!(
            success_rate(1, 801),
            Some(Decimal::from_str("0.12").expect("decimal"))
        );
        // No counted attempts → the caller renders 0 %.
        assert_eq!(success_rate(0, 0), None);
        assert_eq!(success_rate(5, 0), None);
        assert_eq!(success_rate_f64(0, 5), Some(0.0));
    }

    #[test]
    fn string_helpers_are_case_insensitive() {
        assert!(PaymentStatus::is_success_str("succeeded"));
        assert!(PaymentStatus::is_success_str("DISPUTED"));
        assert!(!PaymentStatus::is_success_str("blocked"));
        assert!(PaymentStatus::is_counted_str("unknown"));
        assert!(PaymentStatus::is_counted_str("FAILED"));
        assert!(!PaymentStatus::is_counted_str("expired"));
        assert!(!PaymentStatus::is_counted_str(""));
    }

    #[test]
    fn money_and_slot_predicates() {
        assert!(PaymentStatus::Succeeded.holds_money());
        assert!(PaymentStatus::Refunded.holds_money());
        assert!(!PaymentStatus::Failed.holds_money());
        // Only a terminal non-success releases the reserved slot.
        assert!(PaymentStatus::Failed.releases_slot());
        assert!(PaymentStatus::Blocked.releases_slot());
        assert!(!PaymentStatus::Succeeded.releases_slot());
        assert!(!PaymentStatus::Disputed.releases_slot());
        assert!(!PaymentStatus::Created.releases_slot());
    }

    #[test]
    fn substatuses_round_trip_and_keep_unknown_values() {
        for value in [
            AttemptSubstatus::AmlHold,
            AttemptSubstatus::AmlVoid,
            AttemptSubstatus::SuspenseSettlement,
            AttemptSubstatus::Finalizing,
            AttemptSubstatus::OperatorResolvedSucceeded,
            AttemptSubstatus::OperatorResolvedFailed,
        ] {
            assert_eq!(AttemptSubstatus::parse(value.as_str()), value);
        }
        assert_eq!(AttemptSubstatus::parse("AML_HOLD").as_str(), "AML_HOLD");
        assert_eq!(AttemptSubstatus::AmlHold.to_string(), "AML_HOLD");
        assert_eq!(
            AttemptSubstatus::parse("LEGACY_REASON"),
            AttemptSubstatus::Other("LEGACY_REASON".to_owned())
        );
        assert_eq!(
            AttemptSubstatus::parse("LEGACY_REASON").as_str(),
            "LEGACY_REASON"
        );
        assert!(AttemptSubstatus::AmlHold.is_aml());
        assert!(AttemptSubstatus::AmlVoid.is_aml());
        assert!(!AttemptSubstatus::SuspenseSettlement.is_aml());
    }
}

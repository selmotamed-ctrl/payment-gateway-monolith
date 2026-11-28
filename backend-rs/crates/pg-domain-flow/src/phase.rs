//! Flow phases, step outcomes and client actions.
//!
//! Port of `core-back/engine/flow/DynamicRailEngine.ts:230` (`FlowPhase`), the `CanonicalStatus`
//! enum of `core-back/prisma/schema.prisma`, `successStatus()` (`DynamicRailEngine.ts:326-331`) and
//! the `AdapterClientAction` union, plus the phase vocabulary of
//! `core-back/engine/specImporter/specSchema.ts:36` and `core-back/engine/runtime/flowProvider.ts`.
//!
//! Phase coverage (chapter 2 §15):
//!
//! | Phase | Executor |
//! | :--- | :--- |
//! | `PRE_INITIATE`, `INITIATE`, `SUBMIT`, `VERIFY`, `REFUND`, `VOID` | `executePhase` |
//! | `CREDENTIAL_CHECK` | the credential-check entry point (`platform.ts:622`, route-health probes) |
//! | `CANCEL`, `CAPTURE`, `SETTLEMENT_FETCH` | **no executor** (parity; E-F07) |

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};

/// The flow phases the engine executes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum FlowPhase {
    PreInitiate,
    Initiate,
    Submit,
    Verify,
    /// Declared in the phase type; the engine has no CANCEL executor (parity).
    Cancel,
    Refund,
    Void,
    /// Read-only credential probe (`flowProvider.getCredentialCheckSteps`).
    CredentialCheck,
}

impl FlowPhase {
    /// Every phase of the flow vocabulary.
    pub const ALL: [Self; 8] = [
        Self::PreInitiate,
        Self::Initiate,
        Self::Submit,
        Self::Verify,
        Self::Cancel,
        Self::Refund,
        Self::Void,
        Self::CredentialCheck,
    ];

    /// The phase name as it appears in a flow blueprint.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PreInitiate => "PRE_INITIATE",
            Self::Initiate => "INITIATE",
            Self::Submit => "SUBMIT",
            Self::Verify => "VERIFY",
            Self::Cancel => "CANCEL",
            Self::Refund => "REFUND",
            Self::Void => "VOID",
            Self::CredentialCheck => "CREDENTIAL_CHECK",
        }
    }

    /// Parse a blueprint phase name.
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|phase| phase.as_str() == raw)
    }

    /// True when the phase must not move money: `VERIFY` is read-only, and
    /// `CREDENTIAL_CHECK` is a probe. `MOVES_MONEY` steps are allowed in the others.
    #[must_use]
    pub fn is_read_only(self) -> bool {
        matches!(self, Self::Verify | Self::CredentialCheck)
    }

    /// True when the engine has an executor for the phase (chapter 2 §15).
    #[must_use]
    pub fn has_executor(self) -> bool {
        !matches!(self, Self::Cancel)
    }
}

/// The `CanonicalStatus` a step maps its response onto (`status_rules`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CanonicalStepStatus {
    AwaitingCustomer,
    Verifying,
    Succeeded,
    Failed,
    Unknown,
}

impl CanonicalStepStatus {
    /// Every canonical status.
    pub const ALL: [Self; 5] = [
        Self::AwaitingCustomer,
        Self::Verifying,
        Self::Succeeded,
        Self::Failed,
        Self::Unknown,
    ];

    /// The Prisma enum name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AwaitingCustomer => "AWAITING_CUSTOMER",
            Self::Verifying => "VERIFYING",
            Self::Succeeded => "SUCCEEDED",
            Self::Failed => "FAILED",
            Self::Unknown => "UNKNOWN",
        }
    }

    /// Parse the Prisma enum name.
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|status| status.as_str() == raw)
    }

    /// The payment status this outcome persists when the attempt is written.
    #[must_use]
    pub fn payment_status(self) -> crate::status::PaymentStatus {
        use crate::status::PaymentStatus;
        match self {
            Self::AwaitingCustomer => PaymentStatus::AwaitingCustomer,
            Self::Verifying => PaymentStatus::Verifying,
            Self::Succeeded => PaymentStatus::Succeeded,
            Self::Failed => PaymentStatus::Failed,
            Self::Unknown => PaymentStatus::Unknown,
        }
    }
}

/// The action the payer's browser must take next (`AdapterClientAction`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ClientAction {
    /// Ask the payer for the OTP on the checkout page.
    ShowOtpForm,
    /// Send the browser to the gateway.
    HttpRedirect,
    /// Render the gateway's embedded widget.
    RenderEmbedded,
    /// Show a QR code or a payment code.
    ShowQrOrCode,
    /// Show a push/transfer instruction and wait for the payer.
    ShowPushOrTransfer,
}

impl ClientAction {
    /// Every action.
    pub const ALL: [Self; 5] = [
        Self::ShowOtpForm,
        Self::HttpRedirect,
        Self::RenderEmbedded,
        Self::ShowQrOrCode,
        Self::ShowPushOrTransfer,
    ];

    /// The wire name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ShowOtpForm => "SHOW_OTP_FORM",
            Self::HttpRedirect => "HTTP_REDIRECT",
            Self::RenderEmbedded => "RENDER_EMBEDDED",
            Self::ShowQrOrCode => "SHOW_QR_OR_CODE",
            Self::ShowPushOrTransfer => "SHOW_PUSH_OR_TRANSFER",
        }
    }

    /// Parse the wire name.
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|action| action.as_str() == raw)
    }
}

/// The gateway statuses that mean "the payment succeeded" (`successStatus`).
///
/// This is only the status word; `trustedSuccess` additionally requires the reference, the amount
/// within the route tolerance, the currency and the environment (chapter 2 §15).
pub const TRUSTED_SUCCESS_STATUSES: [&str; 6] = [
    "SUCCESS",
    "SUCCEEDED",
    "PAID",
    "CAPTURED",
    "CONFIRMED",
    "APPROVED",
];

/// `successStatus(value)`: case-insensitive membership of [`TRUSTED_SUCCESS_STATUSES`].
#[must_use]
pub fn is_success_status(value: &str) -> bool {
    let upper = value.to_ascii_uppercase();
    TRUSTED_SUCCESS_STATUSES.contains(&upper.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::status::PaymentStatus;

    #[test]
    fn phases_round_trip() {
        assert_eq!(FlowPhase::ALL.len(), 8);
        for phase in FlowPhase::ALL {
            assert_eq!(FlowPhase::parse(phase.as_str()), Some(phase));
            let json = serde_json::to_string(&phase).expect("json");
            assert_eq!(json, format!("\"{}\"", phase.as_str()));
        }
        assert_eq!(FlowPhase::parse("PRE-INITIATE"), None);
        assert_eq!(FlowPhase::PreInitiate.as_str(), "PRE_INITIATE");
    }

    #[test]
    fn phase_capabilities_match_the_chapter() {
        assert!(FlowPhase::Verify.is_read_only());
        assert!(FlowPhase::CredentialCheck.is_read_only());
        assert!(!FlowPhase::Submit.is_read_only());
        assert!(!FlowPhase::Refund.is_read_only());
        // CANCEL is the one phase in the type with no executor.
        assert!(!FlowPhase::Cancel.has_executor());
        for phase in FlowPhase::ALL {
            if phase != FlowPhase::Cancel {
                assert!(phase.has_executor(), "{phase:?}");
            }
        }
    }

    #[test]
    fn canonical_statuses_map_onto_payment_statuses() {
        assert_eq!(
            CanonicalStepStatus::AwaitingCustomer.payment_status(),
            PaymentStatus::AwaitingCustomer
        );
        assert_eq!(
            CanonicalStepStatus::Verifying.payment_status(),
            PaymentStatus::Verifying
        );
        assert_eq!(
            CanonicalStepStatus::Succeeded.payment_status(),
            PaymentStatus::Succeeded
        );
        assert_eq!(
            CanonicalStepStatus::Failed.payment_status(),
            PaymentStatus::Failed
        );
        assert_eq!(
            CanonicalStepStatus::Unknown.payment_status(),
            PaymentStatus::Unknown
        );
        for status in CanonicalStepStatus::ALL {
            assert_eq!(CanonicalStepStatus::parse(status.as_str()), Some(status));
            assert_eq!(status.payment_status().as_str(), status.as_str());
        }
    }

    #[test]
    fn client_actions_round_trip() {
        for action in ClientAction::ALL {
            assert_eq!(ClientAction::parse(action.as_str()), Some(action));
        }
        assert_eq!(ClientAction::ShowOtpForm.as_str(), "SHOW_OTP_FORM");
        assert_eq!(
            ClientAction::parse("SHOW_PUSH_OR_TRANSFER"),
            Some(ClientAction::ShowPushOrTransfer)
        );
        assert_eq!(ClientAction::parse("SHOW_CARD_FORM"), None);
    }

    #[test]
    fn success_status_words_are_case_insensitive() {
        for status in TRUSTED_SUCCESS_STATUSES {
            assert!(is_success_status(status));
            assert!(is_success_status(&status.to_lowercase()));
        }
        for status in ["FAILED", "DECLINED", "PENDING", "UNKNOWN", ""] {
            assert!(!is_success_status(status));
        }
    }
}

//! Flow errors: illegal transitions, terminal refusals, slot conflicts.
//!
//! Port of the `engineError(...)` / `ApiError(...)` throws of
//! `core-back/engine/flow/DynamicRailEngine.ts`, `engine/runtime/slotStore.ts` and
//! `engine/guards/AttemptGuardPipeline.ts`.
//!
//! The error carries the `{code,message,details?}` shape of `pg-http::ApiError`, but the details are
//! a typed [`FlowErrorDetails`] because this crate does not depend on `serde_json`; the HTTP layer
//! serialises the enum into the envelope. Domain crates never depend on the HTTP crate, hence
//! [`FlowError::to_envelope`] rather than a direct conversion.

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};

/// The `code` strings the flow layer throws.
pub mod codes {
    /// `409` — `DynamicRailEngine.transition` refused the edge (`DynamicRailEngine.ts:801-807`).
    pub const INVALID_ATTEMPT_TRANSITION: &str = "INVALID_ATTEMPT_TRANSITION";
    /// `409` — the attempt is in a state that can no longer be changed by this signal.
    pub const ATTEMPT_TERMINAL: &str = "ATTEMPT_TERMINAL";
    /// `409` — the compare-and-set lost a race (`ATTEMPT_STATE_CONFLICT`).
    pub const ATTEMPT_STATE_CONFLICT: &str = "ATTEMPT_STATE_CONFLICT";
    /// `404` — the attempt id does not exist.
    pub const ATTEMPT_NOT_FOUND: &str = "ATTEMPT_NOT_FOUND";
    /// `409` — the link has no free slot (`slotStore.ts:68`).
    pub const PAYMENT_LINK_SLOT_UNAVAILABLE: &str = "PAYMENT_LINK_SLOT_UNAVAILABLE";
    /// `409` — the reservation could not be bound to a link (`slotStore.ts:47`).
    pub const SLOT_RESERVATION_FAILED: &str = "SLOT_RESERVATION_FAILED";
    /// `409` — Rust-side pre-check of the `attempt_groups_single_success` CHECK constraint.
    pub const ATTEMPT_GROUP_ALREADY_SUCCEEDED: &str = "ATTEMPT_GROUP_ALREADY_SUCCEEDED";
    /// `409` — the link is not `PENDING` (`AttemptGuardPipeline.ts:397`).
    pub const PAYMENT_LINK_NOT_AVAILABLE: &str = "PAYMENT_LINK_NOT_AVAILABLE";
    /// `409` — the link expired (`AttemptGuardPipeline.ts:400`).
    pub const PAYMENT_LINK_EXPIRED: &str = "PAYMENT_LINK_EXPIRED";
    /// `404` — the link key is unknown (`AttemptGuardPipeline.ts:394`).
    pub const PAYMENT_LINK_NOT_FOUND: &str = "PAYMENT_LINK_NOT_FOUND";
    /// `404` — the merchant of the link is missing (`AttemptGuardPipeline.ts:415`).
    pub const MERCHANT_NOT_FOUND: &str = "MERCHANT_NOT_FOUND";
    /// `404` — the rail code is unknown (`AttemptGuardPipeline.ts:905`).
    pub const RAIL_NOT_FOUND: &str = "RAIL_NOT_FOUND";
}

/// The `details` payload of a flow error, serialised by the HTTP layer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FlowErrorDetails {
    /// `ATTEMPT_STATE_CONFLICT`: the status the write expected and the one it found.
    StateConflict { expected: String, observed: String },
    /// `ATTEMPT_GROUP_ALREADY_SUCCEEDED`: the database constraint and the group identity.
    AttemptGroup {
        constraint: String,
        link_id: String,
        customer_fingerprint: String,
    },
}

/// The `{code,message,details?}` body the core error handler renders.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FlowErrorEnvelope {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<FlowErrorDetails>,
}

/// One refusal from the flow layer.
#[derive(Debug, Clone, PartialEq)]
pub struct FlowError {
    pub status: u16,
    pub code: &'static str,
    pub message: String,
    pub details: Option<FlowErrorDetails>,
}

impl FlowError {
    #[must_use]
    pub fn new(status: u16, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            details: None,
        }
    }

    #[must_use]
    pub fn with_details(mut self, details: FlowErrorDetails) -> Self {
        self.details = Some(details);
        self
    }

    #[must_use]
    pub fn to_envelope(&self) -> FlowErrorEnvelope {
        FlowErrorEnvelope {
            code: self.code.to_owned(),
            message: self.message.clone(),
            details: self.details.clone(),
        }
    }

    /// `INVALID_ATTEMPT_TRANSITION`, the message `DynamicRailEngine.transition` throws verbatim.
    #[must_use]
    pub fn invalid_transition(from: &str, to: &str) -> Self {
        Self::new(
            409,
            codes::INVALID_ATTEMPT_TRANSITION,
            format!("Attempt cannot transition from {from} to {to}"),
        )
    }

    /// `ATTEMPT_TERMINAL` with the callback wording (`DynamicRailEngine.ts:607`).
    #[must_use]
    pub fn terminal_contradicting_callback(status: &str) -> Self {
        Self::new(
            409,
            codes::ATTEMPT_TERMINAL,
            format!("The attempt is {status}; a contradicting callback cannot change it"),
        )
    }

    /// `ATTEMPT_TERMINAL` with the finalize wording (`DynamicRailEngine.ts:610,1167`).
    #[must_use]
    pub fn terminal_cannot_finalize(status: &str) -> Self {
        Self::new(
            409,
            codes::ATTEMPT_TERMINAL,
            format!("The attempt is {status} and can no longer be finalized"),
        )
    }

    /// `ATTEMPT_TERMINAL` for an attempt voided by its AML case (`DynamicRailEngine.ts:1172`).
    #[must_use]
    pub fn terminal_aml_void() -> Self {
        Self::new(
            409,
            codes::ATTEMPT_TERMINAL,
            "The attempt was voided by its AML case and can no longer be finalized",
        )
    }

    /// `409 ATTEMPT_STATE_CONFLICT`: the conditional write found another status.
    #[must_use]
    pub fn state_conflict(expected: &str, observed: &str) -> Self {
        Self::new(
            409,
            codes::ATTEMPT_STATE_CONFLICT,
            format!("The attempt is no longer {expected} (it is {observed})"),
        )
        .with_details(FlowErrorDetails::StateConflict {
            expected: expected.to_owned(),
            observed: observed.to_owned(),
        })
    }

    /// `404 ATTEMPT_NOT_FOUND`.
    #[must_use]
    pub fn attempt_not_found(attempt_id: &str) -> Self {
        Self::new(
            404,
            codes::ATTEMPT_NOT_FOUND,
            format!("Attempt '{attempt_id}' does not exist"),
        )
    }

    /// `409 PAYMENT_LINK_SLOT_UNAVAILABLE`.
    #[must_use]
    pub fn slot_unavailable() -> Self {
        Self::new(
            409,
            codes::PAYMENT_LINK_SLOT_UNAVAILABLE,
            "The payment link has no available slot",
        )
    }

    /// `409 SLOT_RESERVATION_FAILED`.
    #[must_use]
    pub fn reservation_failed() -> Self {
        Self::new(
            409,
            codes::SLOT_RESERVATION_FAILED,
            "The attempt is not bound to a payment link",
        )
    }

    /// `409 ATTEMPT_GROUP_ALREADY_SUCCEEDED`: the group already holds its one success.
    #[must_use]
    pub fn attempt_group_already_succeeded(link_id: &str, customer_fingerprint: &str) -> Self {
        Self::new(
            409,
            codes::ATTEMPT_GROUP_ALREADY_SUCCEEDED,
            "This payer already settled this payment link; an attempt group allows one success",
        )
        .with_details(FlowErrorDetails::AttemptGroup {
            constraint: "attempt_groups_single_success".to_owned(),
            link_id: link_id.to_owned(),
            customer_fingerprint: customer_fingerprint.to_owned(),
        })
    }

    /// `409 PAYMENT_LINK_NOT_AVAILABLE`.
    #[must_use]
    pub fn link_not_available() -> Self {
        Self::new(
            409,
            codes::PAYMENT_LINK_NOT_AVAILABLE,
            "Payment link is not available",
        )
    }

    /// `409 PAYMENT_LINK_EXPIRED`.
    #[must_use]
    pub fn link_expired() -> Self {
        Self::new(409, codes::PAYMENT_LINK_EXPIRED, "Payment link has expired")
    }

    /// `404 PAYMENT_LINK_NOT_FOUND`.
    #[must_use]
    pub fn link_not_found() -> Self {
        Self::new(404, codes::PAYMENT_LINK_NOT_FOUND, "Payment link not found")
    }

    /// `404 MERCHANT_NOT_FOUND`.
    #[must_use]
    pub fn merchant_not_found() -> Self {
        Self::new(
            404,
            codes::MERCHANT_NOT_FOUND,
            "Payment link merchant not found",
        )
    }

    /// `404 RAIL_NOT_FOUND`.
    #[must_use]
    pub fn rail_not_found() -> Self {
        Self::new(404, codes::RAIL_NOT_FOUND, "Payment rail not found")
    }
}

impl std::fmt::Display for FlowError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{} {}: {}", self.status, self.code, self.message)
    }
}

impl std::error::Error for FlowError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transition_error_message_matches_the_engine() {
        let error = FlowError::invalid_transition("CREATED", "SUCCEEDED");
        assert_eq!(error.status, 409);
        assert_eq!(error.code, "INVALID_ATTEMPT_TRANSITION");
        assert_eq!(
            error.message,
            "Attempt cannot transition from CREATED to SUCCEEDED"
        );
        assert!(error.details.is_none());
        assert_eq!(
            error.to_envelope().code,
            "INVALID_ATTEMPT_TRANSITION".to_owned()
        );
    }

    #[test]
    fn terminal_messages_match_the_engine_strings() {
        assert_eq!(
            FlowError::terminal_contradicting_callback("CANCELLED").message,
            "The attempt is CANCELLED; a contradicting callback cannot change it"
        );
        assert_eq!(
            FlowError::terminal_cannot_finalize("BLOCKED").message,
            "The attempt is BLOCKED and can no longer be finalized"
        );
        assert_eq!(
            FlowError::terminal_aml_void().message,
            "The attempt was voided by its AML case and can no longer be finalized"
        );
        assert_eq!(FlowError::terminal_aml_void().status, 409);
    }

    #[test]
    fn state_conflict_carries_both_statuses() {
        let error = FlowError::state_conflict("AUTHORIZING", "SUCCEEDED");
        assert_eq!(error.code, "ATTEMPT_STATE_CONFLICT");
        assert_eq!(
            error.details,
            Some(FlowErrorDetails::StateConflict {
                expected: "AUTHORIZING".to_owned(),
                observed: "SUCCEEDED".to_owned(),
            })
        );
    }

    #[test]
    fn group_conflict_names_the_constraint() {
        let error = FlowError::attempt_group_already_succeeded("link-1", "abc");
        assert_eq!(error.code, "ATTEMPT_GROUP_ALREADY_SUCCEEDED");
        assert_eq!(error.status, 409);
        assert_eq!(
            error.details,
            Some(FlowErrorDetails::AttemptGroup {
                constraint: "attempt_groups_single_success".to_owned(),
                link_id: "link-1".to_owned(),
                customer_fingerprint: "abc".to_owned(),
            })
        );
    }

    #[test]
    fn not_found_codes_are_404() {
        assert_eq!(FlowError::attempt_not_found("a").status, 404);
        assert_eq!(FlowError::link_not_found().code, "PAYMENT_LINK_NOT_FOUND");
        assert_eq!(FlowError::merchant_not_found().status, 404);
        assert_eq!(
            FlowError::rail_not_found().message,
            "Payment rail not found"
        );
        assert_eq!(FlowError::slot_unavailable().status, 409);
        assert_eq!(
            FlowError::reservation_failed().code,
            "SLOT_RESERVATION_FAILED"
        );
        assert_eq!(FlowError::link_expired().code, "PAYMENT_LINK_EXPIRED");
        assert_eq!(
            FlowError::link_not_available().code,
            "PAYMENT_LINK_NOT_AVAILABLE"
        );
    }
}

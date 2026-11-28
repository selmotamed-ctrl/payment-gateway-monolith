//! Errors of the flow engine.
//!
//! Port of `engineError(...)` / `ApiError(...)` throws of
//! `core-back/engine/flow/DynamicRailEngine.ts`, `engine/flow/StepExecutor.ts`,
//! `engine/specImporter/specValidator.ts` and `engine/runtime/slotStore.ts`.
//!
//! The shape is the `{status, code, message, details?}` envelope of `pg-http::ApiError`; the domain
//! crate never depends on the HTTP crate, so the HTTP layer converts [`EngineError`] into its own
//! responder. `code` is an owned `String` because the spec importer and the store adapters emit
//! dynamic codes; every engine code is a `&'static str` in [`codes`].

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};

use crate::ports::StoreError;

/// The stable error codes of the flow engine and the step executor.
pub mod codes {
    // ---- rail engine ---------------------------------------------------------------------
    pub const ATTEMPT_NOT_FOUND: &str = "ATTEMPT_NOT_FOUND";
    pub const INVALID_ATTEMPT_TRANSITION: &str = "INVALID_ATTEMPT_TRANSITION";
    pub const ATTEMPT_STATE_CONFLICT: &str = "ATTEMPT_STATE_CONFLICT";
    pub const ATTEMPT_TERMINAL: &str = "ATTEMPT_TERMINAL";
    pub const ATTEMPT_FINALIZE_CONFLICT: &str = "ATTEMPT_FINALIZE_CONFLICT";
    pub const ATTEMPT_NOT_CANCELLABLE: &str = "ATTEMPT_NOT_CANCELLABLE";
    pub const POINT_OF_NO_RETURN: &str = "POINT_OF_NO_RETURN";
    pub const SLOT_RESERVATION_FAILED: &str = "SLOT_RESERVATION_FAILED";
    pub const PAYMENT_LINK_SLOT_UNAVAILABLE: &str = "PAYMENT_LINK_SLOT_UNAVAILABLE";
    pub const ATTEMPT_GROUP_ALREADY_SUCCEEDED: &str = "ATTEMPT_GROUP_ALREADY_SUCCEEDED";
    pub const INVALID_REFUND_AMOUNT: &str = "INVALID_REFUND_AMOUNT";
    pub const REFUND_AMOUNT_EXCEEDED: &str = "REFUND_AMOUNT_EXCEEDED";
    pub const TRUSTED_SUCCESS_FACTS_FAILED: &str = "TRUSTED_SUCCESS_FACTS_FAILED";
    pub const CONFLICTING_TRUSTED_SIGNALS: &str = "CONFLICTING_TRUSTED_SIGNALS";
    pub const CALLBACK_VERIFIER_MISSING: &str = "CALLBACK_VERIFIER_MISSING";
    pub const CALLBACK_VERIFICATION_FAILED: &str = "CALLBACK_VERIFICATION_FAILED";
    pub const CALLBACK_ENVIRONMENT_MISMATCH: &str = "CALLBACK_ENVIRONMENT_MISMATCH";
    pub const AML_HOLD_ESCROW_UNSUPPORTED: &str = "AML_HOLD_ESCROW_UNSUPPORTED";
    pub const COMMISSION_NOT_RESOLVED: &str = "COMMISSION_NOT_RESOLVED";
    pub const NO_VISIBLE_ROUTE: &str = "NO_VISIBLE_ROUTE";
    pub const ROUTE_NOT_VISIBLE: &str = "ROUTE_NOT_VISIBLE";
    pub const SLOT_ALREADY_SETTLED_SUSPENSE: &str = "SLOT_ALREADY_SETTLED_SUSPENSE";

    // ---- step executor -------------------------------------------------------------------
    pub const STEP_REQUEST_INVALID: &str = "STEP_REQUEST_INVALID";
    pub const STEP_ASSERTION_FAILED: &str = "STEP_ASSERTION_FAILED";
    pub const VERIFY_MONEY_STEP_FORBIDDEN: &str = "VERIFY_MONEY_STEP_FORBIDDEN";
    pub const UNKNOWN_STEP_TYPE: &str = "UNKNOWN_STEP_TYPE";
    pub const UNKNOWN_COMPUTE_OPERATION: &str = "UNKNOWN_COMPUTE_OPERATION";
    pub const MISSING_COMPUTE_DEFINITION: &str = "MISSING_COMPUTE_DEFINITION";
    pub const MISSING_RENDER_DEFINITION: &str = "MISSING_RENDER_DEFINITION";
    pub const MISSING_BRANCH_DEFINITION: &str = "MISSING_BRANCH_DEFINITION";
    pub const MISSING_STEP_URL: &str = "MISSING_STEP_URL";
    pub const INVALID_WAIT_DURATION: &str = "INVALID_WAIT_DURATION";
    pub const IDEMPOTENCY_KEY_NAME_MISSING: &str = "IDEMPOTENCY_KEY_NAME_MISSING";
    pub const IDEMPOTENCY_SOURCE_TEMPLATE_MISSING: &str = "IDEMPOTENCY_SOURCE_TEMPLATE_MISSING";
    pub const CRYPTO_PROFILE_REQUIRED: &str = "CRYPTO_PROFILE_REQUIRED";
    pub const CRYPTO_PROFILE_RESOLVER_MISSING: &str = "CRYPTO_PROFILE_RESOLVER_MISSING";
    pub const CRYPTO_PROFILE_NOT_FOUND: &str = "CRYPTO_PROFILE_NOT_FOUND";
    pub const MONEY_OUTPUT_FLOAT_FORBIDDEN: &str = "MONEY_OUTPUT_FLOAT_FORBIDDEN";
    pub const INVALID_MONEY_VALUE: &str = "INVALID_MONEY_VALUE";
    pub const JSON_DEPTH_EXCEEDED: &str = "JSON_DEPTH_EXCEEDED";
    pub const INVALID_GATEWAY_JSON: &str = "INVALID_GATEWAY_JSON";
    pub const XML_ENTITY_BLOCKED: &str = "XML_ENTITY_BLOCKED";
    pub const GATEWAY_REDIRECT_BLOCKED: &str = "GATEWAY_REDIRECT_BLOCKED";
    pub const RESPONSE_TOO_LARGE: &str = "RESPONSE_TOO_LARGE";
    pub const SSRF_PRIVATE_ADDRESS_BLOCKED: &str = "SSRF_PRIVATE_ADDRESS_BLOCKED";
    pub const HEADER_INJECTION_BLOCKED: &str = "HEADER_INJECTION_BLOCKED";
    pub const INVALID_URL: &str = "INVALID_URL";
    pub const INVALID_URL_PATH: &str = "INVALID_URL_PATH";
    pub const INVALID_FINAL_URL: &str = "INVALID_FINAL_URL";
    pub const INSECURE_URL_BLOCKED: &str = "INSECURE_URL_BLOCKED";
    pub const URL_USERINFO_BLOCKED: &str = "URL_USERINFO_BLOCKED";
    pub const URL_FRAGMENT_BLOCKED: &str = "URL_FRAGMENT_BLOCKED";
    pub const URL_PATH_TRAVERSAL_BLOCKED: &str = "INVALID_URL_PATH";
    pub const MISSING_URL_PARAMETER: &str = "MISSING_URL_PARAMETER";
    pub const HOST_NOT_ALLOWED: &str = "HOST_NOT_ALLOWED";
    pub const HOST_ALLOWLIST_EMPTY: &str = "HOST_ALLOWLIST_EMPTY";
    pub const INVALID_STATUS_PATTERN: &str = "INVALID_STATUS_PATTERN";
    pub const INVALID_PATH: &str = "INVALID_PATH";
    pub const PROTOTYPE_POLLUTION_BLOCKED: &str = "PROTOTYPE_POLLUTION_BLOCKED";
    pub const INVALID_TARGET: &str = "INVALID_TARGET";

    // ---- spec importer -------------------------------------------------------------------
    pub const SPEC_INVALID: &str = "SPEC_INVALID";
    pub const FLOW_NOT_FOUND: &str = "FLOW_NOT_FOUND";
}

/// The engine failure. `details` is optional JSON for the HTTP envelope.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EngineError {
    pub status: u16,
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

impl EngineError {
    #[must_use]
    pub fn new(status: u16, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code: code.to_owned(),
            message: message.into(),
            details: None,
        }
    }

    #[must_use]
    pub fn with_code(status: u16, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            status,
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }

    #[must_use]
    pub fn with_details(mut self, details: serde_json::Value) -> Self {
        self.details = Some(details);
        self
    }

    /// `404 ATTEMPT_NOT_FOUND`, verbatim TS message.
    #[must_use]
    pub fn attempt_not_found(attempt_id: &str) -> Self {
        Self::new(
            404,
            codes::ATTEMPT_NOT_FOUND,
            format!("Attempt '{attempt_id}' does not exist"),
        )
    }

    /// `409 INVALID_ATTEMPT_TRANSITION`.
    #[must_use]
    pub fn invalid_transition(from: &str, to: &str) -> Self {
        Self::new(
            409,
            codes::INVALID_ATTEMPT_TRANSITION,
            format!("Attempt cannot transition from {from} to {to}"),
        )
    }

    /// `409 ATTEMPT_TERMINAL` with the finalize wording.
    #[must_use]
    pub fn terminal_cannot_finalize(status: &str) -> Self {
        Self::new(
            409,
            codes::ATTEMPT_TERMINAL,
            format!("The attempt is {status} and can no longer be finalized"),
        )
    }

    /// `409 ATTEMPT_TERMINAL` with the contradicting-callback wording.
    #[must_use]
    pub fn terminal_contradicting_callback(status: &str) -> Self {
        Self::new(
            409,
            codes::ATTEMPT_TERMINAL,
            format!("The attempt is {status}; a contradicting callback cannot change it"),
        )
    }

    /// `409 ATTEMPT_TERMINAL` for an attempt voided by its AML case.
    #[must_use]
    pub fn terminal_aml_void() -> Self {
        Self::new(
            409,
            codes::ATTEMPT_TERMINAL,
            "The attempt was voided by its AML case and can no longer be finalized",
        )
    }

    /// `409 ATTEMPT_STATE_CONFLICT` for a lost compare-and-set.
    #[must_use]
    pub fn state_conflict(expected: &str, observed: &str) -> Self {
        Self::new(
            409,
            codes::ATTEMPT_STATE_CONFLICT,
            format!("The attempt is no longer {expected} (it is {observed})"),
        )
        .with_details(serde_json::json!({ "expected": expected, "observed": observed }))
    }

    /// `409 SLOT_RESERVATION_FAILED`.
    #[must_use]
    pub fn reservation_failed(message: impl Into<String>) -> Self {
        Self::new(409, codes::SLOT_RESERVATION_FAILED, message)
    }

    /// `400` for a step that cannot be built or executed as written.
    #[must_use]
    pub fn step(status: u16, code: &'static str, message: impl Into<String>) -> Self {
        Self::new(status, code, message)
    }

    /// The code a test or an adapter can assert without importing [`codes`].
    #[must_use]
    pub fn is_code(&self, code: &str) -> bool {
        self.code == code
    }
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{} {}: {}", self.status, self.code, self.message)
    }
}

impl std::error::Error for EngineError {}

impl From<pg_domain_flow::FlowError> for EngineError {
    fn from(error: pg_domain_flow::FlowError) -> Self {
        let details = error
            .details
            .map(|details| serde_json::to_value(details).unwrap_or(serde_json::Value::Null));
        Self {
            status: error.status,
            code: error.code.to_owned(),
            message: error.message,
            details,
        }
    }
}

impl From<StoreError> for EngineError {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::NotFound(what) => Self::with_code(404, codes::ATTEMPT_NOT_FOUND, what),
            StoreError::StateConflict { expected, observed } => {
                Self::state_conflict(&expected, &observed)
            }
            StoreError::Unsupported(feature) => Self::with_code(
                501,
                "STORE_UNSUPPORTED",
                format!("The flow store does not support {feature}"),
            ),
            StoreError::Backend(message) => Self::with_code(500, "STORE_FAILURE", message),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_messages_match_the_ts_strings() {
        assert_eq!(
            EngineError::invalid_transition("CREATED", "SUCCEEDED").message,
            "Attempt cannot transition from CREATED to SUCCEEDED"
        );
        assert_eq!(
            EngineError::terminal_cannot_finalize("BLOCKED").message,
            "The attempt is BLOCKED and can no longer be finalized"
        );
        assert_eq!(
            EngineError::terminal_contradicting_callback("REFUNDED").message,
            "The attempt is REFUNDED; a contradicting callback cannot change it"
        );
        assert_eq!(
            EngineError::terminal_aml_void().message,
            "The attempt was voided by its AML case and can no longer be finalized"
        );
        assert_eq!(EngineError::attempt_not_found("a1").status, 404);
    }

    #[test]
    fn flow_error_conversion_keeps_status_code_and_details() {
        let flow = pg_domain_flow::FlowError::attempt_group_already_succeeded("link-1", "fp");
        let error: EngineError = flow.into();
        assert_eq!(error.status, 409);
        assert_eq!(error.code, "ATTEMPT_GROUP_ALREADY_SUCCEEDED");
        assert!(error.details.is_some());
    }

    #[test]
    fn store_conflict_conversion_carries_both_statuses() {
        let error: EngineError = StoreError::StateConflict {
            expected: "AUTHORIZING".to_owned(),
            observed: "SUCCEEDED".to_owned(),
        }
        .into();
        assert_eq!(error.code, "ATTEMPT_STATE_CONFLICT");
        let details = error.details.expect("details");
        assert_eq!(details["expected"], "AUTHORIZING");
        assert_eq!(details["observed"], "SUCCEEDED");
    }
}

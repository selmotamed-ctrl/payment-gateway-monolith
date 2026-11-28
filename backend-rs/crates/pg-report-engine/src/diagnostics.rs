//! Verifier diagnostics.
//!
//! Port of `core-back/lib/reportEngineSdk/types/diagnostics.ts` plus the diagnostic codes used
//! by the Layer 1-5 verifiers (`SpecStructuralValidator`, `SpecReferenceValidator`,
//! `QuerySafetyAndOptValidator`, `MerchantScopeValidator`, `AuthorityInferenceEngine`).
//!
//! Wire parity: the TS field is `aiFixHint`; the Rust field is [`ReportDiagnostic::hint`] and
//! serialises as `aiFixHint`.

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};

/// `ReportDiagnosticSeverity`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
}

impl Severity {
    /// The wire value (`"error"` / `"warning"`).
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::Warning => "warning",
        }
    }
}

/// `ReportDiagnosticLayer` (1 = structure, 2 = query safety, 3 = authority, 4 = assets,
/// 5 = execution).
pub const LAYER_STRUCTURE: u8 = 1;
/// Query safety and optimisation.
pub const LAYER_QUERY: u8 = 2;
/// Authority / access inference.
pub const LAYER_AUTHORITY: u8 = 3;
/// Assets and comparison bundles.
pub const LAYER_ASSETS: u8 = 4;
/// Dry-run execution.
pub const LAYER_EXECUTION: u8 = 5;

/// A verifier or migration diagnostic. One per problem, never deduplicated by the engine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReportDiagnostic {
    /// 1..5 ([`LAYER_STRUCTURE`] ... [`LAYER_EXECUTION`]).
    pub layer: u8,
    pub severity: Severity,
    /// Path into the spec, e.g. `sections[2](kpis).cards[0].value_field`.
    pub path: String,
    /// Stable machine code, one of [`codes`].
    pub code: String,
    pub message: String,
    /// `aiFixHint` on the wire.
    #[serde(rename = "aiFixHint", default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

impl ReportDiagnostic {
    /// An error diagnostic.
    #[must_use]
    pub fn error(
        layer: u8,
        path: impl Into<String>,
        code: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            layer,
            severity: Severity::Error,
            path: path.into(),
            code: code.into(),
            message: message.into(),
            hint: None,
        }
    }

    /// A warning diagnostic.
    #[must_use]
    pub fn warning(
        layer: u8,
        path: impl Into<String>,
        code: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            layer,
            severity: Severity::Warning,
            path: path.into(),
            code: code.into(),
            message: message.into(),
            hint: None,
        }
    }

    /// Attach the AI repair hint (`aiFixHint`).
    #[must_use]
    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    /// True when this diagnostic blocks verification.
    #[must_use]
    pub fn is_error(&self) -> bool {
        self.severity == Severity::Error
    }
}

/// The diagnostic codes this crate can emit. Where the TS verifier already defines a code the
/// constant is identical; the extra `MERCHANT_SCOPE_VIOLATION` / `UNKNOWN_DATASET` /
/// `UNKNOWN_FIELD` codes cover the execution guard and the compact reference checks.
pub mod codes {
    // Layer 1: structure and references.
    pub const DUPLICATE_DATASET_ID: &str = "DUPLICATE_DATASET_ID";
    pub const DUPLICATE_SECTION_ID: &str = "DUPLICATE_SECTION_ID";
    /// Generic alias for an unknown dataset. The reference verifier emits the more specific TS
    /// codes below (`UNKNOWN_SECTION_DATASET`, `UNKNOWN_TRANSFORM_DATASET`,
    /// `UNKNOWN_VISIBILITY_DATASET`); tooling may fold them into this code.
    pub const UNKNOWN_DATASET: &str = "UNKNOWN_DATASET";
    /// Generic alias for an unknown field; the verifier emits `UNKNOWN_SECTION_FIELD`.
    pub const UNKNOWN_FIELD: &str = "UNKNOWN_FIELD";
    pub const UNKNOWN_SECTION_DATASET: &str = "UNKNOWN_SECTION_DATASET";
    pub const UNKNOWN_SECTION_FIELD: &str = "UNKNOWN_SECTION_FIELD";
    pub const UNKNOWN_TRANSFORM_DATASET: &str = "UNKNOWN_TRANSFORM_DATASET";
    pub const UNKNOWN_VISIBILITY_DATASET: &str = "UNKNOWN_VISIBILITY_DATASET";
    pub const UNSUPPORTED_TEMPLATE_TOKEN: &str = "UNSUPPORTED_TEMPLATE_TOKEN";
    pub const INVALID_IDENTIFIER: &str = "INVALID_IDENTIFIER";
    pub const INVALID_SECTION_ID: &str = "INVALID_SECTION_ID";
    pub const LIMIT_EXCEEDED: &str = "LIMIT_EXCEEDED";
    pub const MISSING_SPEC_VERSION: &str = "MISSING_SPEC_VERSION";
    pub const SPEC_KIND_INVALID: &str = "SPEC_KIND_INVALID";

    // Layer 2: query safety, model eligibility and merchant isolation.
    pub const MODEL_NOT_REPORTABLE: &str = "MODEL_NOT_REPORTABLE";
    pub const UNKNOWN_MODEL: &str = "UNKNOWN_MODEL";
    pub const MERCHANT_SCOPE_VIOLATION: &str = "MERCHANT_SCOPE_VIOLATION";
    pub const MERCHANT_SCOPE_INPUT_MISSING: &str = "MERCHANT_SCOPE_INPUT_MISSING";
    pub const MERCHANT_SCOPE_INPUT_INVALID: &str = "MERCHANT_SCOPE_INPUT_INVALID";
    pub const MERCHANT_EXTRA_MERCHANT_INPUT_FORBIDDEN: &str =
        "MERCHANT_EXTRA_MERCHANT_INPUT_FORBIDDEN";
    pub const MERCHANT_AUTOCOMPLETE_SOURCE_NOT_ALLOWED: &str =
        "MERCHANT_AUTOCOMPLETE_SOURCE_NOT_ALLOWED";
    pub const MERCHANT_CONFIDENTIAL_DOMAIN_FORBIDDEN: &str =
        "MERCHANT_CONFIDENTIAL_DOMAIN_FORBIDDEN";
    pub const MERCHANT_MODEL_OUT_OF_SCOPE: &str = "MERCHANT_MODEL_OUT_OF_SCOPE";

    // Layer 3: authority inference.
    pub const SUGGESTED_ACCESS_CONFLICT: &str = "SUGGESTED_ACCESS_CONFLICT";
    pub const SUGGESTED_AUTHORITY_NOT_REQUIRED: &str = "SUGGESTED_AUTHORITY_NOT_REQUIRED";
    pub const ZERO_NATURAL_ROLE_INTERSECTION: &str = "ZERO_NATURAL_ROLE_INTERSECTION";
    pub const UNKNOWN_SUGGESTED_ROLE: &str = "UNKNOWN_SUGGESTED_ROLE";
    pub const UNKNOWN_SUGGESTED_AUTHORITY: &str = "UNKNOWN_SUGGESTED_AUTHORITY";

    // Layer 4: assets.
    pub const UNKNOWN_IMAGE_ASSET: &str = "UNKNOWN_IMAGE_ASSET";
    pub const UNKNOWN_COMPARISON_ASSET: &str = "UNKNOWN_COMPARISON_ASSET";

    // Chrome selection.
    pub const SPECIFIC_CHROME_CODE: &str = "SPECIFIC_CHROME_CODE";
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostic_serialises_the_ts_shape() {
        let diagnostic = ReportDiagnostic::error(
            LAYER_STRUCTURE,
            "datasets[0].dataset_id",
            codes::DUPLICATE_DATASET_ID,
            "Dataset id \"daily\" is used more than once.",
        )
        .with_hint("Give every dataset a unique dataset_id.");
        let value = serde_json::to_value(&diagnostic).expect("diagnostic serialises");
        assert_eq!(value["layer"], 1);
        assert_eq!(value["severity"], "error");
        assert_eq!(value["code"], "DUPLICATE_DATASET_ID");
        assert_eq!(
            value["aiFixHint"],
            "Give every dataset a unique dataset_id."
        );
        assert!(value.get("hint").is_none());
    }

    #[test]
    fn omitted_hint_is_absent_from_the_wire() {
        let diagnostic = ReportDiagnostic::warning(
            LAYER_AUTHORITY,
            "suggested_access.roles",
            codes::UNKNOWN_SUGGESTED_ROLE,
            "x",
        );
        let value = serde_json::to_value(&diagnostic).expect("diagnostic serialises");
        assert!(value.get("aiFixHint").is_none());
        assert!(!diagnostic.is_error());
    }
}

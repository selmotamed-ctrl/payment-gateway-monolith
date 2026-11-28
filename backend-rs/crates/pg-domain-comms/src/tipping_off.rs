//! The no-tipping-off guard and confidential-case classification.
//!
//! Port of `core-back/engine/compliance/tippingOff.ts`:
//!
//! - `extractTemplateVariables` / `containsAmlVariable`: the `{{var}}` scan and the AML marker
//!   pattern (implemented without a regex crate);
//! - `assertNoTippingOff`: an `INTERNAL` template passes; every other class may not reference AML
//!   variables, code `TIPPING_OFF_TEMPLATE_REJECTED`;
//! - `redactAmlPayload`: drop sensitive keys for non-`INTERNAL` classes.
//!
//! Case-level rule: `lib/operatorCases/caseCatalog.ts` marks `ATTEMPT_HELD` and `AML_SLA_BREACH`
//! `confidentiality: "AML"`. A notification about such a case is never allowed to reach a merchant
//! or customer, even when the template itself is clean; the refusal is
//! `TIPPING_OFF_AML_CASE_CONFIDENTIAL` (this grouping is derived from the case catalogue, not a
//! separate TS function).
//!
//! Faithful quirk: when a template contains at least one well-formed placeholder, the TS guard
//! tests only the placeholder names and never the surrounding prose. [`contains_aml_variable`]
//! reproduces that; [`contains_aml_marker`] exposes the raw-text test for callers that want the
//! stricter rule.

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::template::{extract_template_variables, ConfidentialityClass};

/// Who receives the message. `Staff` is the internal audience.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Audience {
    Staff,
    Merchant,
    Customer,
}

impl Audience {
    #[must_use]
    pub const fn is_external(self) -> bool {
        matches!(self, Self::Merchant | Self::Customer)
    }
}

/// `CaseConfidentiality` of `lib/operatorCases/caseCatalog.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CaseConfidentiality {
    Normal,
    Confidential,
    Aml,
}

impl CaseConfidentiality {
    /// The confidentiality of a known case type. Unknown/`None` is [`Self::Normal`].
    #[must_use]
    pub fn of_case_type(case_type: Option<&str>) -> Self {
        match case_type.map(str::trim).unwrap_or("") {
            "ATTEMPT_HELD" | "AML_SLA_BREACH" => Self::Aml,
            "ATTEMPT_CONFLICT"
            | "REPORT_OVERDUE"
            | "KYB_SCAN_BACKLOG"
            | "KYB_INFECTED"
            | "KYB_SCAN_FAILED"
            | "DISPUTE_EXPIRED"
            | "DISPUTE_RULING_OVERDUE"
            | "EMERGENCY_UNRATIFIED"
            | "EMERGENCY_LIFTED"
            | "AUDIT_ANCHOR_INVALID"
            | "AUDIT_CHAIN_REWRITTEN"
            | "AUDIT_CHAIN_BROKEN"
            | "REPORT_SCOPE_VIOLATION" => Self::Confidential,
            _ => Self::Normal,
        }
    }

    #[must_use]
    pub const fn is_aml(self) -> bool {
        matches!(self, Self::Aml)
    }
}

/// The recipient context of one notification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NotificationContext<'a> {
    pub audience: Audience,
    /// The case the message is about (`operatorCase.caseType`), when there is one.
    pub case_type: Option<&'a str>,
}

impl<'a> NotificationContext<'a> {
    #[must_use]
    pub const fn new(audience: Audience, case_type: Option<&'a str>) -> Self {
        Self {
            audience,
            case_type,
        }
    }

    #[must_use]
    pub fn case_confidentiality(&self) -> CaseConfidentiality {
        CaseConfidentiality::of_case_type(self.case_type)
    }
}

/// The template being delivered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TemplateView<'a> {
    pub code: Option<&'a str>,
    pub subject_template: Option<&'a str>,
    pub body_template: &'a str,
    pub confidentiality: ConfidentialityClass,
}

impl<'a> TemplateView<'a> {
    #[must_use]
    pub const fn new(body_template: &'a str, confidentiality: ConfidentialityClass) -> Self {
        Self {
            code: None,
            subject_template: None,
            body_template,
            confidentiality,
        }
    }

    #[must_use]
    pub const fn with_subject(mut self, subject_template: &'a str) -> Self {
        self.subject_template = Some(subject_template);
        self
    }

    #[must_use]
    pub const fn with_code(mut self, code: &'a str) -> Self {
        self.code = Some(code);
        self
    }
}

/// Why a notification is refused.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TippingOffRefusal {
    /// A non-`INTERNAL` template references an AML variable (the TS rule).
    TemplateReferencesAml {
        code: Option<String>,
        confidentiality: ConfidentialityClass,
    },
    /// The message is about an AML-confidential case and the audience is external.
    AmlCaseConfidential { case_type: Option<String> },
}

impl TippingOffRefusal {
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::TemplateReferencesAml { .. } => "TIPPING_OFF_TEMPLATE_REJECTED",
            Self::AmlCaseConfidential { .. } => "TIPPING_OFF_AML_CASE_CONFIDENTIAL",
        }
    }

    #[must_use]
    pub fn message(&self) -> String {
        match self {
            Self::TemplateReferencesAml {
                code,
                confidentiality,
            } => format!(
                "Template {} of class {} may not reference AML variables",
                code.as_deref().unwrap_or("unknown"),
                confidentiality.as_str()
            ),
            Self::AmlCaseConfidential { case_type } => format!(
                "A {} case is AML-confidential; a merchant or customer must not be told about it",
                case_type.as_deref().unwrap_or("AML")
            ),
        }
    }
}

/// `assertNoTippingOff`: the template-level rule only.
pub fn assert_no_tipping_off(template: &TemplateView<'_>) -> Result<(), TippingOffRefusal> {
    if template.confidentiality.is_internal() {
        return Ok(());
    }
    let subject = template.subject_template.unwrap_or("");
    if contains_aml_variable(subject) || contains_aml_variable(template.body_template) {
        return Err(TippingOffRefusal::TemplateReferencesAml {
            code: template.code.map(str::to_owned),
            confidentiality: template.confidentiality,
        });
    }
    Ok(())
}

/// The full guard: the template rule, then the case-confidentiality rule for an external audience.
pub fn evaluate(
    context: &NotificationContext<'_>,
    template: &TemplateView<'_>,
) -> Result<(), TippingOffRefusal> {
    assert_no_tipping_off(template)?;
    if !template.confidentiality.is_internal()
        && context.audience.is_external()
        && context.case_confidentiality().is_aml()
    {
        return Err(TippingOffRefusal::AmlCaseConfidential {
            case_type: context.case_type.map(str::to_owned),
        });
    }
    Ok(())
}

/// `isConfidentialTemplateClass`.
#[must_use]
pub const fn is_confidential_template_class(class: ConfidentialityClass) -> bool {
    class.is_internal()
}

/// `containsAmlVariable`: test the placeholder names when there are any, else the raw text.
#[must_use]
pub fn contains_aml_variable(template: &str) -> bool {
    let variables = extract_template_variables(template);
    if variables.is_empty() {
        return contains_aml_marker(template);
    }
    variables
        .iter()
        .any(|variable| contains_aml_marker(variable))
}

/// The raw-text AML marker test of `AML_VARIABLE_PATTERN` (case-insensitive).
#[must_use]
pub fn contains_aml_marker(text: &str) -> bool {
    let lowered = text.to_lowercase();
    if lowered.contains("sanction") || lowered.contains("structuring") {
        return true;
    }
    let joined = [
        (
            "aml",
            ["case", "screen", "rule", "report", "match"].as_slice(),
        ),
        ("pep", ["flag"].as_slice()),
        ("str", ["draft"].as_slice()),
        ("watch", ["list"].as_slice()),
        ("screening", ["result"].as_slice()),
        ("confirmed", ["match"].as_slice()),
        ("potential", ["match"].as_slice()),
    ];
    joined.iter().any(|(prefix, suffixes)| {
        suffixes
            .iter()
            .any(|suffix| contains_with_optional_separator(&lowered, prefix, suffix))
    })
}

/// `prefix [_.-]? suffix` (the optional separator of the TS pattern).
fn contains_with_optional_separator(haystack: &str, prefix: &str, suffix: &str) -> bool {
    let bytes = haystack.as_bytes();
    let prefix = prefix.as_bytes();
    let suffix = suffix.as_bytes();
    if prefix.is_empty() || suffix.is_empty() || bytes.len() < prefix.len() + suffix.len() {
        return false;
    }
    for start in 0..=bytes.len() - prefix.len() {
        if &bytes[start..start + prefix.len()] != prefix {
            continue;
        }
        let mut cursor = start + prefix.len();
        if cursor < bytes.len() && matches!(bytes[cursor], b'_' | b'.' | b'-') {
            cursor += 1;
        }
        if cursor + suffix.len() <= bytes.len() && &bytes[cursor..cursor + suffix.len()] == suffix {
            return true;
        }
    }
    false
}

/// Keys `redactAmlPayload` removes from a non-`INTERNAL` payload.
#[must_use]
pub fn is_sensitive_aml_key(key: &str) -> bool {
    let lowered = key.to_lowercase();
    [
        "aml",
        "sanction",
        "pep",
        "screening",
        "watchlist",
        "watch_list",
        "case_reason",
        "risk_score",
        "internal_note",
        "investigation",
    ]
    .iter()
    .any(|marker| lowered.contains(marker))
}

/// `redactAmlPayload`: an `INTERNAL` payload is returned unchanged.
#[must_use]
pub fn redact_aml_payload(
    payload: &Map<String, Value>,
    class: ConfidentialityClass,
) -> Map<String, Value> {
    if class.is_internal() {
        return payload.clone();
    }
    payload
        .iter()
        .filter(|(key, _)| !is_sensitive_aml_key(key))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn internal(body: &'static str) -> TemplateView<'static> {
        TemplateView::new(body, ConfidentialityClass::Internal)
    }

    #[test]
    fn aml_markers_match_the_ts_pattern() {
        for marker in [
            "aml_case_id",
            "amlCaseId",
            "aml.case",
            "aml-case",
            "sanctions_hit",
            "pep_flag",
            "pep-flag",
            "str_draft",
            "watch_list",
            "watchlist",
            "structuring",
            "screening_result",
            "confirmed_match",
            "potential_match",
        ] {
            assert!(contains_aml_marker(marker), "{marker}");
        }
        for clean in ["amount", "merchant_id", "watched", "amlet", "pep"] {
            assert!(!contains_aml_marker(clean), "{clean}");
        }
    }

    #[test]
    fn the_variable_first_quirk_is_reproduced() {
        // The TS guard tests only placeholder names when there are any, so AML prose next to a
        // clean placeholder slips through the template-level check.
        assert!(!contains_aml_variable(
            "Your sanctions review for {{reference}} is complete"
        ));
        assert!(contains_aml_variable("{{aml_case_id}}"));
        assert!(contains_aml_variable("{{sanctions_hit}}"));
        // `aml_status` does not match `aml[_.-]?(case|screen|rule|report|match)`.
        assert!(!contains_aml_variable("{{aml_status}}"));
        // With no placeholder the raw text is tested.
        assert!(contains_aml_variable("Your sanctions review is complete"));
    }

    #[test]
    fn internal_templates_pass_and_external_aml_templates_do_not() {
        assert!(assert_no_tipping_off(&internal("AML case {{aml_case_id}}")).is_ok());

        let merchant_template = TemplateView::new(
            "Your payment is held under review {{aml_case_id}}",
            ConfidentialityClass::Merchant,
        )
        .with_code("ATTEMPT_HELD");
        let refusal = assert_no_tipping_off(&merchant_template).expect_err("AML variable");
        assert_eq!(refusal.code(), "TIPPING_OFF_TEMPLATE_REJECTED");
        assert!(refusal.message().contains("ATTEMPT_HELD"));

        let clean = TemplateView::new("Your payment settled", ConfidentialityClass::Merchant);
        assert!(assert_no_tipping_off(&clean).is_ok());
    }

    #[test]
    fn aml_confidential_cases_never_reach_a_merchant() {
        let template = TemplateView::new("A case was updated", ConfidentialityClass::Merchant);
        let context = NotificationContext::new(Audience::Merchant, Some("ATTEMPT_HELD"));
        let refusal = evaluate(&context, &template).expect_err("AML case");
        assert_eq!(refusal.code(), "TIPPING_OFF_AML_CASE_CONFIDENTIAL");
        assert_eq!(
            refusal,
            TippingOffRefusal::AmlCaseConfidential {
                case_type: Some("ATTEMPT_HELD".to_owned())
            }
        );

        // The same case may notify staff…
        let staff = NotificationContext::new(Audience::Staff, Some("ATTEMPT_HELD"));
        assert!(evaluate(&staff, &template).is_ok());
        // …and a confidential (non-AML) case keeps the TS behaviour (allowed).
        let confidential = NotificationContext::new(Audience::Customer, Some("DISPUTE_EXPIRED"));
        assert!(evaluate(&confidential, &template).is_ok());
        // An internal template is always allowed.
        assert!(evaluate(&context, &internal("{{aml_case_id}}")).is_ok());
    }

    #[test]
    fn case_confidentiality_map_matches_the_case_catalogue() {
        assert_eq!(
            CaseConfidentiality::of_case_type(Some("AML_SLA_BREACH")),
            CaseConfidentiality::Aml
        );
        assert_eq!(
            CaseConfidentiality::of_case_type(Some("KYB_INFECTED")),
            CaseConfidentiality::Confidential
        );
        assert_eq!(
            CaseConfidentiality::of_case_type(Some("BACKUP_FAILED")),
            CaseConfidentiality::Normal
        );
        assert_eq!(
            CaseConfidentiality::of_case_type(None),
            CaseConfidentiality::Normal
        );
    }

    #[test]
    fn redaction_drops_sensitive_keys_for_non_internal_classes() {
        let payload = json!({
            "amount": "10.0000",
            "amlCaseId": "case-1",
            "risk_score": 90,
            "merchant_id": "m-1",
            "sanctionsHit": false,
        });
        let object = payload.as_object().expect("object");
        let redacted = redact_aml_payload(object, ConfidentialityClass::Merchant);
        assert!(redacted.contains_key("amount"));
        assert!(redacted.contains_key("merchant_id"));
        assert!(!redacted.contains_key("amlCaseId"));
        assert!(!redacted.contains_key("risk_score"));
        assert!(!redacted.contains_key("sanctionsHit"));

        let kept = redact_aml_payload(object, ConfidentialityClass::Internal);
        assert_eq!(kept.len(), object.len());
    }

    #[test]
    fn sensitive_keys_match_the_ts_regex() {
        for key in [
            "aml",
            "amlStatus",
            "sanction_list",
            "pepFlag",
            "screeningId",
            "watchList",
            "watch_list",
            "case_reason",
            "risk_score",
            "internal_note",
            "investigationNotes",
        ] {
            assert!(is_sensitive_aml_key(key), "{key}");
        }
        for key in ["amount", "merchantId", "reference"] {
            assert!(!is_sensitive_aml_key(key), "{key}");
        }
    }
}

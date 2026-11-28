//! Stored-spec compatibility classification.
//!
//! Port of `core-back/lib/reportEngineSdk/compatibility/reportCompatibility.ts`.
//!
//! Statuses map one-to-one on the wire: TS `COMPATIBLE` → [`Compatibility::Compatible`],
//! `NEEDS_MIGRATION` → [`Compatibility::NeedsMigration`], `INVALID` → [`Compatibility::Unsupported`]
//! (the port's name for "this engine cannot run it and a prompt cannot repair it in place").
//!
//! Schema validation is the subset a Rust `serde` view can prove without zod: the descriptor
//! kind, the version gate, at least one dataset, at least one section, and that every structural
//! field of the typed view parses. Semantic checks (field references, i18n coverage, query
//! safety) are the verifier's job and run on execution.

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::spec::ReportSpec;
use crate::version::{
    is_supported_engine_version, is_supported_report_spec_version, major_version_of,
    REPORT_ENGINE_VERSION, REPORT_SPEC_VERSION,
};

/// The three compatibility outcomes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Compatibility {
    /// Executable by this engine as stored.
    Compatible,
    /// Readable but must be migrated before execution.
    NeedsMigration,
    /// Not executable and not repairable by a migration prompt.
    Unsupported,
}

impl Compatibility {
    /// The wire value (`COMPATIBLE` / `NEEDS_MIGRATION` / `UNSUPPORTED`).
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Compatible => "COMPATIBLE",
            Self::NeedsMigration => "NEEDS_MIGRATION",
            Self::Unsupported => "UNSUPPORTED",
        }
    }
}

/// `CompatibilityReasonCode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ReasonCode {
    EngineMajorVersionMismatch,
    SpecVersionUnsupported,
    MissingVersionMetadata,
    InvalidSpecJson,
    CurrentSchemaValidationFailed,
    WrongSpecKind,
}

impl ReasonCode {
    /// The wire value used by the admin/merchant API and the migration prompt builder.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::EngineMajorVersionMismatch => "ENGINE_MAJOR_VERSION_MISMATCH",
            Self::SpecVersionUnsupported => "SPEC_VERSION_UNSUPPORTED",
            Self::MissingVersionMetadata => "MISSING_VERSION_METADATA",
            Self::InvalidSpecJson => "INVALID_SPEC_JSON",
            Self::CurrentSchemaValidationFailed => "CURRENT_SCHEMA_VALIDATION_FAILED",
            Self::WrongSpecKind => "WRONG_SPEC_KIND",
        }
    }
}

/// One schema problem reported with the compatibility result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompatibilityIssue {
    pub path: String,
    pub code: String,
    pub message: String,
}

impl CompatibilityIssue {
    fn new(path: impl Into<String>, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            code: code.into(),
            message: message.into(),
        }
    }
}

/// `ReportCompatibilityResult`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportCompatibility {
    pub status: Compatibility,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<ReasonCode>,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stored_engine_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stored_spec_version: Option<String>,
    pub current_engine_version: String,
    pub current_spec_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub declared_spec_version: Option<String>,
    pub issues: Vec<CompatibilityIssue>,
    pub prompt_available: bool,
}

impl ReportCompatibility {
    /// True when the spec can execute without migration.
    #[must_use]
    pub fn is_compatible(&self) -> bool {
        self.status == Compatibility::Compatible
    }
}

/// The simple version gate requested by the port plan: same engine major and a parseable spec
/// version mean compatible; a different major needs a migration; unparsable input is unsupported.
#[must_use]
pub fn compatibility(current_engine_version: &str, spec_version: &str) -> Compatibility {
    let current_major = major_version_of(Some(current_engine_version));
    let spec_major = major_version_of(Some(spec_version));
    match (current_major, spec_major) {
        (Some(current), Some(stored)) if current == stored => Compatibility::Compatible,
        (Some(_), Some(_)) => Compatibility::NeedsMigration,
        _ => Compatibility::Unsupported,
    }
}

/// The stored row's metadata plus its `spec_json` value.
#[derive(Debug, Clone, Copy)]
pub struct StoredSpecInput<'a> {
    pub spec_json: &'a Value,
    pub stored_engine_version: Option<&'a str>,
    pub stored_spec_version: Option<&'a str>,
}

fn declared_text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.as_object()?.get(key)?.as_str()
}

fn base_result(
    declared: Option<&str>,
    stored_engine_version: Option<&str>,
    stored_spec_version: Option<&str>,
) -> ReportCompatibility {
    ReportCompatibility {
        status: Compatibility::Unsupported,
        reason_code: None,
        message: String::new(),
        stored_engine_version: stored_engine_version.map(std::string::ToString::to_string),
        stored_spec_version: stored_spec_version.map(std::string::ToString::to_string),
        current_engine_version: REPORT_ENGINE_VERSION.to_owned(),
        current_spec_version: REPORT_SPEC_VERSION.to_owned(),
        declared_spec_version: declared.map(std::string::ToString::to_string),
        issues: Vec::new(),
        prompt_available: true,
    }
}

fn validate_current_schema(value: &Value) -> Vec<CompatibilityIssue> {
    let mut issues = Vec::new();
    match serde_json::from_value::<ReportSpec>(value.clone()) {
        Ok(spec) => {
            if spec.datasets.is_empty() {
                issues.push(CompatibilityIssue::new(
                    "datasets",
                    "too_small",
                    "Array must contain at least 1 element(s)",
                ));
            }
            if spec.sections.is_empty() {
                issues.push(CompatibilityIssue::new(
                    "sections",
                    "too_small",
                    "Array must contain at least 1 element(s)",
                ));
            }
        }
        Err(error) => {
            issues.push(CompatibilityIssue::new(
                "<root>",
                "invalid_type",
                error.to_string(),
            ));
        }
    }
    issues
}

/// `classifyStoredReportSpec` for an already parsed value.
#[must_use]
pub fn classify_stored_report_spec(input: StoredSpecInput<'_>) -> ReportCompatibility {
    let declared = declared_text(input.spec_json, "spec_version");
    let kind = declared_text(input.spec_json, "spec_kind");
    let stored_spec_version = input.stored_spec_version.or(declared);
    let mut result = base_result(declared, input.stored_engine_version, stored_spec_version);

    if kind != Some("REPORT_DESCRIPTOR") {
        result.status = Compatibility::Unsupported;
        result.reason_code = Some(ReasonCode::WrongSpecKind);
        result.message = "The stored report spec is not a REPORT_DESCRIPTOR.".to_owned();
        result.issues = vec![CompatibilityIssue::new(
            "spec_kind",
            "WRONG_SPEC_KIND",
            "Expected REPORT_DESCRIPTOR.",
        )];
        return result;
    }

    if input.stored_engine_version.is_none_or(str::is_empty)
        || stored_spec_version.is_none_or(str::is_empty)
    {
        result.status = Compatibility::NeedsMigration;
        result.reason_code = Some(ReasonCode::MissingVersionMetadata);
        result.message = "The stored report spec has no recorded engine/spec version.".to_owned();
        return result;
    }

    if !is_supported_engine_version(input.stored_engine_version) {
        let stored = input.stored_engine_version.unwrap_or_default();
        let major = major_version_of(Some(stored));
        result.status = Compatibility::NeedsMigration;
        result.reason_code = Some(ReasonCode::EngineMajorVersionMismatch);
        result.message = format!(
            "The report was saved for engine version {stored}; this engine is {REPORT_ENGINE_VERSION}."
        );
        result.issues = vec![CompatibilityIssue::new(
            "engine_version",
            "ENGINE_MAJOR_VERSION_MISMATCH",
            format!(
                "Engine major {} is not supported.",
                major.map_or_else(|| "unknown".to_owned(), |value| value.to_string())
            ),
        )];
        return result;
    }

    if !is_supported_report_spec_version(stored_spec_version) {
        let stored = stored_spec_version.unwrap_or_default();
        result.status = Compatibility::NeedsMigration;
        result.reason_code = Some(ReasonCode::SpecVersionUnsupported);
        result.message = format!(
            "The report uses spec version {stored}; this engine supports {REPORT_SPEC_VERSION}."
        );
        result.issues = vec![CompatibilityIssue::new(
            "spec_version",
            "SPEC_VERSION_UNSUPPORTED",
            format!("Spec version {stored} is not supported."),
        )];
        return result;
    }

    let issues = validate_current_schema(input.spec_json);
    if !issues.is_empty() {
        result.status = Compatibility::Unsupported;
        result.reason_code = Some(ReasonCode::CurrentSchemaValidationFailed);
        result.message = "The stored report spec does not match the current schema.".to_owned();
        result.issues = issues;
        return result;
    }

    result.status = Compatibility::Compatible;
    result.reason_code = None;
    result.message = "The stored report spec is compatible with the running engine.".to_owned();
    result.prompt_available = false;
    result
}

/// `classifyStoredReportSpec` for the raw `spec_json` text (invalid JSON is
/// `INVALID_SPEC_JSON`, not `WRONG_SPEC_KIND`).
#[must_use]
pub fn classify_stored_report_spec_json(
    spec_json: &str,
    stored_engine_version: Option<&str>,
    stored_spec_version: Option<&str>,
) -> ReportCompatibility {
    match serde_json::from_str::<Value>(spec_json) {
        Ok(value) => classify_stored_report_spec(StoredSpecInput {
            spec_json: &value,
            stored_engine_version,
            stored_spec_version,
        }),
        Err(_) => {
            let mut result = base_result(None, stored_engine_version, stored_spec_version);
            result.status = Compatibility::Unsupported;
            result.reason_code = Some(ReasonCode::InvalidSpecJson);
            result.message = "The stored report spec is not valid JSON.".to_owned();
            result
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn descriptor() -> Value {
        json!({
            "spec_kind": "REPORT_DESCRIPTOR",
            "spec_version": "1.0",
            "datasets": [{"dataset_id": "daily", "from_model": "paymentAttempt", "select": [{"alias": "volume", "column": "total_charged_amount"}]}],
            "sections": [{"section_id": "kpis", "section_type": "KPI_GRID", "cards": [{"dataset_id": "daily", "value_field": "volume"}]}]
        })
    }

    fn classify(value: &Value, engine: Option<&str>, spec: Option<&str>) -> ReportCompatibility {
        classify_stored_report_spec(StoredSpecInput {
            spec_json: value,
            stored_engine_version: engine,
            stored_spec_version: spec,
        })
    }

    #[test]
    fn simple_gate_compares_engine_majors() {
        assert_eq!(compatibility("1.0.0", "1.0"), Compatibility::Compatible);
        assert_eq!(compatibility("1.4.2", "1.9"), Compatibility::Compatible);
        assert_eq!(compatibility("2.0.0", "1.0"), Compatibility::NeedsMigration);
        assert_eq!(compatibility("1.0.0", "2.0"), Compatibility::NeedsMigration);
        assert_eq!(compatibility("nope", "1.0"), Compatibility::Unsupported);
        assert_eq!(Compatibility::NeedsMigration.as_str(), "NEEDS_MIGRATION");
    }

    #[test]
    fn a_current_descriptor_is_compatible() {
        let result = classify(&descriptor(), Some("1.0.0"), Some("1.0"));
        assert_eq!(result.status, Compatibility::Compatible);
        assert_eq!(result.reason_code, None);
        assert!(!result.prompt_available);
        assert!(result.issues.is_empty());
        assert_eq!(result.current_engine_version, "1.0.0");
        assert_eq!(result.declared_spec_version.as_deref(), Some("1.0"));
        assert!(result.is_compatible());
    }

    #[test]
    fn the_declared_spec_version_fills_missing_metadata() {
        let result = classify(&descriptor(), Some("1.0.0"), None);
        assert_eq!(result.status, Compatibility::Compatible);
        assert_eq!(result.stored_spec_version.as_deref(), Some("1.0"));
    }

    #[test]
    fn missing_metadata_needs_migration() {
        let mut value = descriptor();
        if let Some(object) = value.as_object_mut() {
            object.remove("spec_version");
        }
        let result = classify(&value, None, None);
        assert_eq!(result.status, Compatibility::NeedsMigration);
        assert_eq!(result.reason_code, Some(ReasonCode::MissingVersionMetadata));
        assert!(result.prompt_available);
    }

    #[test]
    fn an_engine_major_bump_needs_migration() {
        let result = classify(&descriptor(), Some("2.0.0"), Some("1.0"));
        assert_eq!(result.status, Compatibility::NeedsMigration);
        assert_eq!(
            result.reason_code,
            Some(ReasonCode::EngineMajorVersionMismatch)
        );
        assert_eq!(result.issues[0].code, "ENGINE_MAJOR_VERSION_MISMATCH");
        assert!(result.message.contains("2.0.0"));
    }

    #[test]
    fn an_unsupported_spec_version_needs_migration() {
        let result = classify(&descriptor(), Some("1.0.0"), Some("0.9"));
        assert_eq!(result.status, Compatibility::NeedsMigration);
        assert_eq!(result.reason_code, Some(ReasonCode::SpecVersionUnsupported));
        assert_eq!(result.issues[0].path, "spec_version");
    }

    #[test]
    fn a_non_descriptor_is_unsupported() {
        let value = json!({"spec_kind": "INTEGRATION_SPEC", "spec_version": "1.0"});
        let result = classify(&value, Some("1.0.0"), Some("1.0"));
        assert_eq!(result.status, Compatibility::Unsupported);
        assert_eq!(result.reason_code, Some(ReasonCode::WrongSpecKind));
        assert_eq!(result.issues[0].code, "WRONG_SPEC_KIND");
    }

    #[test]
    fn invalid_json_is_reported_as_such() {
        let result = classify_stored_report_spec_json("{not json", Some("1.0.0"), Some("1.0"));
        assert_eq!(result.status, Compatibility::Unsupported);
        assert_eq!(result.reason_code, Some(ReasonCode::InvalidSpecJson));
        assert_eq!(ReasonCode::InvalidSpecJson.as_str(), "INVALID_SPEC_JSON");
    }

    #[test]
    fn an_empty_descriptor_fails_current_schema_validation() {
        let value = json!({"spec_kind": "REPORT_DESCRIPTOR", "spec_version": "1.0", "datasets": [], "sections": []});
        let result = classify(&value, Some("1.0.0"), Some("1.0"));
        assert_eq!(result.status, Compatibility::Unsupported);
        assert_eq!(
            result.reason_code,
            Some(ReasonCode::CurrentSchemaValidationFailed)
        );
        assert_eq!(result.issues.len(), 2);
        assert!(result.issues.iter().any(|issue| issue.path == "datasets"));
        assert!(result.issues.iter().any(|issue| issue.path == "sections"));
    }

    #[test]
    fn the_result_serialises_with_the_ts_field_names() {
        let result = classify(&descriptor(), Some("1.0.0"), Some("1.0"));
        let value = serde_json::to_value(&result).expect("serialises");
        assert_eq!(value["status"], "COMPATIBLE");
        assert_eq!(value["currentSpecVersion"], "1.0");
        assert_eq!(value["promptAvailable"], false);
        assert!(value.get("reasonCode").is_none());
    }
}

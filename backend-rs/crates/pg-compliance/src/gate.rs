//! The regulatory filing gate.
//!
//! Port of the submission checks in `core-back/api/internal/admin.ts`
//! (`validateRegulatoryReportForSubmission`) and of the output validation status in
//! `core-back/engine/compliance/reporting/ReportGenerationService.ts`.
//!
//! Two invariants are absolute:
//! 1. A **PROVISIONAL** schema can never produce a live filing
//!    (`REPORT_SCHEMA_NOT_CONFIRMED`); the provisional CBL/goAML baselines are configuration
//!    drafts until the owner confirms them.
//! 2. The filed artefact must be the bytes that were approved: a payload hash that differs from
//!    the approved hash is stale (`OUTPUT_STALE`) and is refused.

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};

/// `ReportOutputFormat`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ReportOutputFormat {
    Xml,
    Xlsx,
    Docx,
}

impl ReportOutputFormat {
    /// The wire value (`XML`/`XLSX`/`DOCX`).
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Xml => "XML",
            Self::Xlsx => "XLSX",
            Self::Docx => "DOCX",
        }
    }

    /// Parses the wire value.
    #[must_use]
    pub fn from_wire(value: &str) -> Option<Self> {
        match value {
            "XML" => Some(Self::Xml),
            "XLSX" => Some(Self::Xlsx),
            "DOCX" => Some(Self::Docx),
            _ => None,
        }
    }

    /// `xml` / `xlsx` / `docx`.
    #[must_use]
    pub const fn extension(self) -> &'static str {
        match self {
            Self::Xml => "xml",
            Self::Xlsx => "xlsx",
            Self::Docx => "docx",
        }
    }
}

impl std::fmt::Display for ReportOutputFormat {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// `RegulatorySchemaStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SchemaStatus {
    Draft,
    Provisional,
    PendingApproval,
    Confirmed,
    Superseded,
    Archived,
}

impl SchemaStatus {
    /// Only `CONFIRMED` may file.
    #[must_use]
    pub const fn can_file(self) -> bool {
        matches!(self, Self::Confirmed)
    }

    /// The wire value.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "DRAFT",
            Self::Provisional => "PROVISIONAL",
            Self::PendingApproval => "PENDING_APPROVAL",
            Self::Confirmed => "CONFIRMED",
            Self::Superseded => "SUPERSEDED",
            Self::Archived => "ARCHIVED",
        }
    }
}

/// `RegulatoryReportStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ReportStatus {
    Draft,
    PendingChecker,
    Approved,
    Submitted,
    Acknowledged,
    RejectedByAuthority,
}

impl ReportStatus {
    /// The wire value.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "DRAFT",
            Self::PendingChecker => "PENDING_CHECKER",
            Self::Approved => "APPROVED",
            Self::Submitted => "SUBMITTED",
            Self::Acknowledged => "ACKNOWLEDGED",
            Self::RejectedByAuthority => "REJECTED_BY_AUTHORITY",
        }
    }
}

/// `ReportOutputValidationStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum OutputValidationStatus {
    NotGenerated,
    ProvisionalSchema,
    Validated,
    Invalid,
}

impl OutputValidationStatus {
    /// A filing needs `VALIDATED`.
    #[must_use]
    pub const fn is_validated(self) -> bool {
        matches!(self, Self::Validated)
    }

    /// The wire value.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::NotGenerated => "NOT_GENERATED",
            Self::ProvisionalSchema => "PROVISIONAL_SCHEMA",
            Self::Validated => "VALIDATED",
            Self::Invalid => "INVALID",
        }
    }
}

/// The exact API error codes (`ApiError(409, ...)`).
pub mod codes {
    /// The report is not `APPROVED`.
    pub const REPORT_NOT_APPROVED: &str = "REGULATORY_REPORT_NOT_APPROVED";
    /// The reporting rule is not `CONFIRMED`.
    pub const REPORTING_RULE_PROVISIONAL: &str = "REPORTING_RULE_PROVISIONAL";
    /// No confirmed rule and no required output format.
    pub const REPORT_OUTPUTS_REQUIRED: &str = "REPORT_OUTPUTS_REQUIRED";
    /// A required output is missing, provisional, invalid or stale.
    pub const REPORT_OUTPUT_NOT_READY: &str = "REPORT_OUTPUT_NOT_READY";
    /// A provisional (or otherwise unconfirmed) schema.
    pub const REPORT_SCHEMA_NOT_CONFIRMED: &str = "REPORT_SCHEMA_NOT_CONFIRMED";
    /// The output was generated from an older payload (a reason inside `REPORT_OUTPUT_NOT_READY`).
    pub const OUTPUT_STALE: &str = "OUTPUT_STALE";
}

/// One reason a required output cannot be filed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutputProblem {
    pub format: ReportOutputFormat,
    pub reason: String,
    pub message: String,
}

impl OutputProblem {
    fn new(
        format: ReportOutputFormat,
        reason: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            format,
            reason: reason.into(),
            message: message.into(),
        }
    }
}

/// A refusal to file.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FilingError {
    /// The report is not `APPROVED`.
    #[error("The regulatory report is '{status}' and cannot be submitted")]
    ReportNotApproved {
        /// The current report status.
        status: String,
    },
    /// The rule that produced the report is still provisional.
    #[error("A PROVISIONAL reporting rule can never produce a live regulatory filing")]
    ReportingRuleProvisional {
        /// The rule status.
        rule_status: String,
    },
    /// A live filing needs a confirmed rule or at least one confirmed output format.
    #[error(
        "A live filing needs a confirmed reporting rule or at least one confirmed output format"
    )]
    OutputsRequired,
    /// One or more required outputs are not ready.
    #[error("One or more required report outputs are not ready for filing")]
    OutputNotReady {
        /// Per-format reasons.
        problems: Vec<OutputProblem>,
    },
    /// A provisional/unconfirmed schema cannot file.
    #[error("Only a confirmed schema can file ({format})")]
    SchemaNotConfirmed {
        /// The format whose schema is unconfirmed.
        format: ReportOutputFormat,
        /// The schema status.
        schema_status: String,
    },
    /// The artefact is not the approved bytes.
    #[error("The {format} output was generated from an older report payload")]
    OutputStale {
        /// The stale format.
        format: ReportOutputFormat,
    },
}

impl FilingError {
    /// The exact API code.
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::ReportNotApproved { .. } => codes::REPORT_NOT_APPROVED,
            Self::ReportingRuleProvisional { .. } => codes::REPORTING_RULE_PROVISIONAL,
            Self::OutputsRequired => codes::REPORT_OUTPUTS_REQUIRED,
            Self::OutputNotReady { .. } => codes::REPORT_OUTPUT_NOT_READY,
            Self::SchemaNotConfirmed { .. } => codes::REPORT_SCHEMA_NOT_CONFIRMED,
            Self::OutputStale { .. } => codes::REPORT_OUTPUT_NOT_READY,
        }
    }

    /// The HTTP status (`409` for every gate refusal).
    #[must_use]
    pub const fn status(&self) -> u16 {
        409
    }

    /// The stale-output reason, when the refusal is a payload mismatch.
    #[must_use]
    pub const fn reason(&self) -> Option<&'static str> {
        match self {
            Self::OutputStale { .. } => Some(codes::OUTPUT_STALE),
            _ => None,
        }
    }
}

/// One generated output row for a filing check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilingOutput<'a> {
    pub format: ReportOutputFormat,
    pub validation_status: OutputValidationStatus,
    pub schema_status: Option<SchemaStatus>,
    pub payload_sha256: Option<&'a str>,
}

/// The full submission state (`validateRegulatoryReportForSubmission`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilingCheck<'a> {
    pub report_status: ReportStatus,
    /// The reporting rule status; `None` when the report is not rule-backed.
    pub reporting_rule_status: Option<&'a str>,
    /// `report.requiredOutputFormats`.
    pub required_formats: &'a [ReportOutputFormat],
    pub outputs: &'a [FilingOutput<'a>],
}

/// The regulatory filing gate.
#[derive(Debug, Clone, Copy, Default)]
pub struct ReportingGate;

impl ReportingGate {
    /// `schemaStatus === "CONFIRMED" ? "VALIDATED" : "PROVISIONAL_SCHEMA"`.
    #[must_use]
    pub const fn output_validation_status(schema_status: SchemaStatus) -> OutputValidationStatus {
        if schema_status.can_file() {
            OutputValidationStatus::Validated
        } else {
            OutputValidationStatus::ProvisionalSchema
        }
    }

    /// True when the report may be filed with the given schema.
    #[must_use]
    pub const fn can_file(report_status: ReportStatus, schema_status: SchemaStatus) -> bool {
        matches!(report_status, ReportStatus::Approved) && schema_status.can_file()
    }

    /// The simple gate: approved report, confirmed schema, matching payload hash.
    ///
    /// # Errors
    /// Returns the exact API error for the first failed check.
    pub fn validate_filing(
        report_status: ReportStatus,
        schema_status: SchemaStatus,
        payload_hash: &str,
        approved_hash: &str,
    ) -> Result<(), FilingError> {
        if report_status != ReportStatus::Approved {
            return Err(FilingError::ReportNotApproved {
                status: report_status.as_str().to_owned(),
            });
        }
        if !schema_status.can_file() {
            return Err(FilingError::SchemaNotConfirmed {
                format: ReportOutputFormat::Xml,
                schema_status: schema_status.as_str().to_owned(),
            });
        }
        if !approved_hash.is_empty() && !payload_hash.is_empty() && payload_hash != approved_hash {
            return Err(FilingError::OutputStale {
                format: ReportOutputFormat::Xml,
            });
        }
        Ok(())
    }

    /// The full submission gate: report status, rule status, required formats, per-output
    /// validation status, schema status and payload hash.
    ///
    /// # Errors
    /// Returns the exact API error; `OutputNotReady` carries one problem per format.
    pub fn check_submission(
        check: &FilingCheck<'_>,
        payload_hash: &str,
    ) -> Result<(), FilingError> {
        if check.report_status != ReportStatus::Approved {
            return Err(FilingError::ReportNotApproved {
                status: check.report_status.as_str().to_owned(),
            });
        }
        if let Some(rule_status) = check.reporting_rule_status {
            if rule_status != "CONFIRMED" {
                return Err(FilingError::ReportingRuleProvisional {
                    rule_status: rule_status.to_owned(),
                });
            }
        }
        let has_rule = check.reporting_rule_status.is_some();
        if check.required_formats.is_empty() && !has_rule {
            return Err(FilingError::OutputsRequired);
        }

        let mut problems = Vec::new();
        for format in check.required_formats {
            let Some(output) = check.outputs.iter().find(|output| output.format == *format) else {
                problems.push(OutputProblem::new(
                    *format,
                    "NOT_GENERATED",
                    format!("The {format} output has not been generated"),
                ));
                continue;
            };
            if !output.validation_status.is_validated() {
                problems.push(OutputProblem::new(
                    *format,
                    output.validation_status.as_str(),
                    format!(
                        "The {format} output is '{}'",
                        output.validation_status.as_str()
                    ),
                ));
                continue;
            }
            match output.schema_status {
                Some(status) if status.can_file() => {}
                other => problems.push(OutputProblem::new(
                    *format,
                    "SCHEMA_NOT_CONFIRMED",
                    format!(
                        "The {format} schema is not CONFIRMED ({})",
                        other.map_or("MISSING", SchemaStatus::as_str)
                    ),
                )),
            }
            if let Some(output_hash) = output.payload_sha256 {
                if !output_hash.is_empty()
                    && !payload_hash.is_empty()
                    && output_hash != payload_hash
                {
                    problems.push(OutputProblem::new(
                        *format,
                        codes::OUTPUT_STALE,
                        format!("The {format} output was generated from an older report payload"),
                    ));
                }
            }
        }
        if problems.is_empty() {
            Ok(())
        } else {
            Err(FilingError::OutputNotReady { problems })
        }
    }
}

/// Free-function form of [`ReportingGate::validate_filing`].
///
/// # Errors
/// See [`ReportingGate::validate_filing`].
pub fn validate_filing(
    report_status: ReportStatus,
    schema_status: SchemaStatus,
    payload_hash: &str,
    approved_hash: &str,
) -> Result<(), FilingError> {
    ReportingGate::validate_filing(report_status, schema_status, payload_hash, approved_hash)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_provisional_schema_can_never_file() {
        let error = validate_filing(
            ReportStatus::Approved,
            SchemaStatus::Provisional,
            "abc",
            "abc",
        )
        .expect_err("provisional schemas cannot file");
        assert_eq!(error.code(), "REPORT_SCHEMA_NOT_CONFIRMED");
        assert_eq!(error.status(), 409);
        assert!(!ReportingGate::can_file(
            ReportStatus::Approved,
            SchemaStatus::Provisional
        ));
        assert!(!ReportingGate::can_file(
            ReportStatus::Approved,
            SchemaStatus::Draft
        ));
        assert!(ReportingGate::can_file(
            ReportStatus::Approved,
            SchemaStatus::Confirmed
        ));
    }

    #[test]
    fn the_report_must_be_approved() {
        let error = validate_filing(
            ReportStatus::PendingChecker,
            SchemaStatus::Confirmed,
            "abc",
            "abc",
        )
        .expect_err("draft reports cannot file");
        assert_eq!(error.code(), "REGULATORY_REPORT_NOT_APPROVED");
        assert!(error.to_string().contains("PENDING_CHECKER"));
    }

    #[test]
    fn the_filed_bytes_must_be_the_approved_bytes() {
        assert!(validate_filing(
            ReportStatus::Approved,
            SchemaStatus::Confirmed,
            "abc",
            "abc"
        )
        .is_ok());
        let error = validate_filing(
            ReportStatus::Approved,
            SchemaStatus::Confirmed,
            "abc",
            "def",
        )
        .expect_err("stale payload");
        assert_eq!(error.reason(), Some("OUTPUT_STALE"));
        assert_eq!(error.code(), "REPORT_OUTPUT_NOT_READY");
        // An absent approved hash (legacy row) does not block.
        assert!(
            validate_filing(ReportStatus::Approved, SchemaStatus::Confirmed, "abc", "").is_ok()
        );
    }

    #[test]
    fn output_validation_status_follows_the_schema() {
        assert_eq!(
            ReportingGate::output_validation_status(SchemaStatus::Confirmed),
            OutputValidationStatus::Validated
        );
        assert_eq!(
            ReportingGate::output_validation_status(SchemaStatus::Provisional),
            OutputValidationStatus::ProvisionalSchema
        );
    }

    #[test]
    fn a_provisional_reporting_rule_blocks_the_filing() {
        let formats = [ReportOutputFormat::Xml];
        let outputs = [FilingOutput {
            format: ReportOutputFormat::Xml,
            validation_status: OutputValidationStatus::Validated,
            schema_status: Some(SchemaStatus::Confirmed),
            payload_sha256: Some("hash"),
        }];
        let check = FilingCheck {
            report_status: ReportStatus::Approved,
            reporting_rule_status: Some("PROVISIONAL"),
            required_formats: &formats,
            outputs: &outputs,
        };
        let error = ReportingGate::check_submission(&check, "hash").expect_err("provisional rule");
        assert_eq!(error.code(), "REPORTING_RULE_PROVISIONAL");
    }

    #[test]
    fn a_missing_confirmed_rule_and_no_outputs_is_refused() {
        let check = FilingCheck {
            report_status: ReportStatus::Approved,
            reporting_rule_status: None,
            required_formats: &[],
            outputs: &[],
        };
        let error = ReportingGate::check_submission(&check, "hash").expect_err("outputs required");
        assert_eq!(error.code(), "REPORT_OUTPUTS_REQUIRED");
    }

    #[test]
    fn every_required_output_is_checked() {
        let formats = [
            ReportOutputFormat::Xml,
            ReportOutputFormat::Xlsx,
            ReportOutputFormat::Docx,
        ];
        let outputs = [
            FilingOutput {
                format: ReportOutputFormat::Xlsx,
                validation_status: OutputValidationStatus::ProvisionalSchema,
                schema_status: Some(SchemaStatus::Provisional),
                payload_sha256: Some("hash"),
            },
            FilingOutput {
                format: ReportOutputFormat::Docx,
                validation_status: OutputValidationStatus::Validated,
                schema_status: Some(SchemaStatus::Confirmed),
                payload_sha256: Some("older"),
            },
        ];
        let check = FilingCheck {
            report_status: ReportStatus::Approved,
            reporting_rule_status: Some("CONFIRMED"),
            required_formats: &formats,
            outputs: &outputs,
        };
        let error = ReportingGate::check_submission(&check, "hash").expect_err("not ready");
        let FilingError::OutputNotReady { problems } = error else {
            panic!("expected OutputNotReady");
        };
        let reasons: Vec<(&str, &str)> = problems
            .iter()
            .map(|problem| (problem.format.as_str(), problem.reason.as_str()))
            .collect();
        assert_eq!(
            reasons,
            vec![
                ("XML", "NOT_GENERATED"),
                ("XLSX", "PROVISIONAL_SCHEMA"),
                ("DOCX", "OUTPUT_STALE")
            ]
        );
    }

    #[test]
    fn a_complete_confirmed_submission_passes() {
        let formats = [ReportOutputFormat::Xml, ReportOutputFormat::Docx];
        let outputs = [
            FilingOutput {
                format: ReportOutputFormat::Xml,
                validation_status: OutputValidationStatus::Validated,
                schema_status: Some(SchemaStatus::Confirmed),
                payload_sha256: Some("hash"),
            },
            FilingOutput {
                format: ReportOutputFormat::Docx,
                validation_status: OutputValidationStatus::Validated,
                schema_status: Some(SchemaStatus::Confirmed),
                payload_sha256: Some("hash"),
            },
        ];
        let check = FilingCheck {
            report_status: ReportStatus::Approved,
            reporting_rule_status: Some("CONFIRMED"),
            required_formats: &formats,
            outputs: &outputs,
        };
        assert!(ReportingGate::check_submission(&check, "hash").is_ok());
    }

    #[test]
    fn formats_round_trip_on_the_wire() {
        assert_eq!(
            serde_json::to_value(ReportOutputFormat::Xml).expect("ser"),
            "XML"
        );
        assert_eq!(
            ReportOutputFormat::from_wire("DOCX"),
            Some(ReportOutputFormat::Docx)
        );
        assert_eq!(ReportOutputFormat::from_wire("PDF"), None);
        assert_eq!(ReportOutputFormat::Xlsx.extension(), "xlsx");
    }
}

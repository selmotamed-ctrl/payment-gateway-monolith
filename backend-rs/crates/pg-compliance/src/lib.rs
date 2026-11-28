//! Regulatory reporting support for the Rust/ntex port.
//!
//! Ports (task P8-T03):
//! - [`gate`] — the filing gate: approved report, confirmed schema, matching payload hash; a
//!   `PROVISIONAL` schema can never file (`REPORT_SCHEMA_NOT_CONFIRMED`).
//! - [`xml`] — the safe XML tokenizer and the whitelisted XSD subset compiler/validator
//!   (`XsdCompiler.ts`, `XsdXmlGenerator.ts`/`XsdXmlValidator.ts` structure).
//! - [`periods`] — `Africa/Tripoli` monthly/quarterly/annual period keys, due dates and the
//!   Sunday–Thursday business week (`periods.ts`, `businessTime.ts`).
//! - [`incidents`] — the incident state machine, postmortem rules and responders (`incidents.ts`).
//! - [`context`] — the canonical report context with camelCase serde names and the
//!   gateway/environment/currency totals.
//!
//! Deliberately not here yet: the XSD→XML generator (bindings/blueprints), the XLSX/DOCX writers
//! (structures live in `pg-office`), filing adapters and the rule evaluator (P8-T03 follow-ups).

#![forbid(unsafe_code)]
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

pub mod context;
pub mod gate;
pub mod incidents;
pub mod periods;
pub mod xml;

pub use context::{
    money4, Aggregates, AmlCaseContext, CanonicalReportContext, CurrencyTotals, GatewayTotals,
    InstitutionContext, MerchantContext, ReportContextReport, SummaryRow, TransactionContext,
    WalletContext, PROVISIONAL_LOCAL_CURRENCY_CODE, PROVISIONAL_RENTITY_BRANCH,
    PROVISIONAL_RENTITY_ID, PROVISIONAL_REPORTING_PERSON_EMAIL, PROVISIONAL_REPORTING_PERSON_NAME,
    PROVISIONAL_SUBMISSION_CODE,
};
pub use gate::{
    codes as filing_codes, validate_filing, FilingCheck, FilingError, FilingOutput, OutputProblem,
    OutputValidationStatus, ReportOutputFormat, ReportStatus, ReportingGate, SchemaStatus,
};
pub use incidents::{
    allowed_transitions, can_transition_incident, incident_postmortem_due_at,
    incident_requires_postmortem, incident_timestamp_field, validate_transition, IncidentCategory,
    IncidentError, IncidentResponder, IncidentSeverity, IncidentStatus, IncidentTransition,
    TransitionPlan, MAX_RESPONDER_ROLE_CHARS, STANDARD_RESPONDER_ROLES,
};
pub use periods::{
    add_local_days, business_day_batches, closed_periods, due_after_batch, due_after_period,
    is_business_day, libya_offset, local_date, local_year_month, minus_business_days,
    start_of_local_day, BusinessCalendar, ReportPeriod, ReturnPeriod, DEFAULT_BUSINESS_TIME_ZONE,
    LIBYA_UTC_OFFSET_SECONDS, MAX_PERIODS,
};
pub use xml::{
    child_text, compile_schema, escape_xml, parse_safe_xml, validate_xml, AttributeUse,
    CompiledSchema, Compositor, ElementKind, MaxOccurs, ValidationIssue, XmlError, XmlNode,
    XmlValidation, XsdAttributeNode, XsdCodeList, XsdElementNode, XsdError, XsdPathInfo,
    XsdPrimitiveType, XsdTypeFacets, ALLOWED_XSD_ELEMENTS, MAX_DEPTH, MAX_REPEAT, MAX_XML_BYTES,
    MAX_XSD_BYTES,
};

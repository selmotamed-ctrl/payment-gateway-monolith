//! Report engine SDK core: spec model, normalisation, limits, diagnostics, canonical hashing,
//! decimal transforms, compatibility classification, PII/authority inference and the Layer 1-3
//! verifier.
//!
//! Port of `core-back/lib/reportEngineSdk/{version,specHash,types,compiler/TransformPipelineExecutor,
//! compatibility,verifier}/**` (chapter 2 §29, task P8-T01).
//!
//! Parity notes (chapter 2 §29 — released artefacts):
//! - [`REPORT_ENGINE_VERSION`] and the other contract versions are copied verbatim.
//! - [`spec_hash`] reimplements the SDK's canonical JSON (recursively sorted keys, UTF-16 code-unit
//!   order) and SHA-256 **locally**: this crate's manifest has neither `sha2` nor `pg-types`, and
//!   agents may not edit the workspace manifest. The digest is checked against the NIST vectors and
//!   matches `createHash("sha256")` byte for byte; swap in `sha2` when the coordinator adds it.
//! - The typed [`ReportSpec`] is a lossless *view*: unknown members stay in `extra`, so the
//!   persisted `spec_json` remains the source of truth and never passes through this struct on
//!   write. `spec_version` is exposed as `version`.
//! - Transforms use `bigdecimal` at decimal.js precision 40 / HALF_UP; every emitted value matches
//!   decimal.js `toFixed()` (plain notation, trailing zeros trimmed).
//!
//! What this crate deliberately does not do (P8-T01 follow-up steps): SQL compilation, the
//! read-only executor, transcripts, chrome rendering and asset bundles.

#![forbid(unsafe_code)]
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

pub mod authority;
pub mod compatibility;
pub mod decimal;
pub mod diagnostics;
pub mod limits;
pub mod sha256;
pub mod spec;
pub mod spec_hash;
pub mod verifier;
pub mod version;

pub use authority::{
    collect_referenced_columns, infer_authorities, infer_authorities_with_override,
    is_reportable_model, Catalog, CatalogColumn, CatalogModel, ConflictDetail, ConflictRule,
    ConflictStatus, Domain, EffectiveAccessPolicy, MerchantScopable, ReferencedColumn,
    SecurityOverride, Sensitivity, NON_REPORTABLE_MODELS,
};
pub use compatibility::{
    classify_stored_report_spec, classify_stored_report_spec_json, compatibility, Compatibility,
    CompatibilityIssue, ReasonCode, ReportCompatibility, StoredSpecInput,
};
pub use decimal::{
    apply_formula, compare_columns, compare_field, decimal_string, divide_to, parse_decimal,
    parse_decimal_str, percentage_share, round_decimal, safe_divide, sum_column, variance_bps,
    CompareOutcome, RoundMode,
};
pub use diagnostics::{codes, ReportDiagnostic, Severity};
pub use limits::{
    is_identifier, MAX_DATASETS, MAX_DATASET_ROWS, MAX_GROUP_BY, MAX_INPUTS, MAX_JOINS,
    MAX_ORDER_BY, MAX_REQUIRED_ASSETS, MAX_SECTIONS, MAX_SELECT_FIELDS, MAX_TRANSFORMS,
    MAX_WINDOW_FIELDS,
};
pub use spec::{
    normalize_spec, AudienceScope, ChromeMode, ChromeSelection, DatasetSpec, Formula, InputSpec,
    ReportMeta, ReportSpec, RequiredAsset, SectionSpec, SectionType, SuggestedAccess,
    TransformOperation, TransformSpec, SPEC_KIND,
};
pub use spec_hash::{canonical_json, spec_hash, spec_hash_from_str};
pub use verifier::{
    diagnostic_codes, has_errors, validate_merchant_scope, validate_spec, validate_spec_defaults,
    verify_merchant_scope, MerchantScopeViolation, VerificationOptions,
};
pub use version::{
    is_supported_chrome_spec_version, is_supported_engine_version,
    is_supported_report_spec_version, major_version_of, REPORT_CHROME_SPEC_VERSION,
    REPORT_CHROME_TRANSCRIPT_VERSION, REPORT_ENGINE_VERSION, REPORT_ENGINE_VERSION_MAJOR,
    REPORT_SPEC_VERSION, REPORT_TRANSCRIPT_VERSION, SUPPORTED_REPORT_CHROME_SPEC_VERSIONS,
    SUPPORTED_REPORT_ENGINE_MAJORS, SUPPORTED_REPORT_SPEC_VERSIONS,
};

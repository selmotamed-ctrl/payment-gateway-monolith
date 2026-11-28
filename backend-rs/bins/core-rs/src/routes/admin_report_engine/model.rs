//! Row views, compatibility classification and JSON shaping for the Report Studio read routes.
//!
//! Port of the pure helpers of `core-back/api/internal/adminReportEngine.ts`:
//!
//! - `reportCompatibilityOf` / `chromeCompatibilityOf` (the stored-spec classifiers);
//! - `isAllowed` → [`actor_allowed`] (`isActorAllowedByPolicy`,
//!   `lib/reportEngineSdk/verifier/AuthorityInferenceEngine.ts:256`);
//! - `chromeView` / the `specs` and `catalog` projections;
//! - the report chrome registry and `reportChromeDependency` readiness rule.
//!
//! The report classifier is `pg-report-engine`'s [`classify_stored_report_spec`]. Its wire status
//! `UNSUPPORTED` is mapped back to the TS `INVALID` here so the API bytes match; the crate keeps
//! its own name internally (documented in that crate).
//!
//! The chrome classifier and the full zod-equivalent schema do not exist in `pg-report-engine`
//! yet (P8-T01/T02), so [`ChromeCompatibility`] reproduces the TS gate from the stored JSON:
//! kind, recorded/declared versions, and the structural contract of `chrome`, `required_assets`
//! and `i18n`. Unknown members are preserved (the stored JSON is what the API returns).

#![forbid(unsafe_code)]

use chrono::{DateTime, NaiveDateTime, SecondsFormat, Utc};
use pg_report_engine::{
    classify_stored_report_spec, is_supported_chrome_spec_version, is_supported_engine_version,
    major_version_of, Compatibility, ReasonCode, ReportCompatibility, StoredSpecInput,
    REPORT_CHROME_SPEC_VERSION, REPORT_ENGINE_VERSION,
};
use serde_json::{json, Value};
use sqlx::postgres::PgRow;
use sqlx::Row;
use uuid::Uuid;

/// `toISOString()`: always three fraction digits and `Z`.
#[must_use]
pub fn iso(datetime: DateTime<Utc>) -> String {
    datetime.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// `toISOString()` for a `timestamp without time zone` column, which stores UTC.
#[must_use]
pub fn iso_naive(naive: NaiveDateTime) -> String {
    iso(DateTime::<Utc>::from_naive_utc_and_offset(naive, Utc))
}

/// An optional timestamp column.
#[must_use]
pub fn iso_opt(datetime: Option<DateTime<Utc>>) -> Value {
    datetime.map_or(Value::Null, |value| Value::String(iso(value)))
}

/// The actor view used by `isActorAllowedByPolicy` (`role` + granted authorities).
#[derive(Debug, Clone, Copy)]
pub struct Actor<'a> {
    pub role: &'a str,
    pub authorities: &'a [String],
}

impl Actor<'_> {
    /// `hasAuthority` (staff wildcard included).
    #[must_use]
    pub fn has(&self, authority: &str) -> bool {
        self.authorities
            .iter()
            .any(|held| held == "*" || held == authority)
    }
}

/// `isActorAllowedByPolicy`: SECURITY_ADMIN/`security:write` first, then the stored policy.
///
/// `inferredAuthorities.length > 0 && every(...)` is reproduced, including the vacuous case
/// (an empty inferred list never grants on its own).
#[must_use]
pub fn actor_allowed(
    authority_mode: &str,
    inferred_roles: &[String],
    inferred_authorities: &[String],
    override_allowed_roles: &[String],
    override_allowed_authorities: &[String],
    actor: Actor<'_>,
) -> bool {
    if actor.role == "SECURITY_ADMIN" || actor.has("security:write") {
        return true;
    }
    if authority_mode == "SECURITY_ADMIN_OVERRIDE" {
        return override_allowed_roles.iter().any(|role| role == actor.role)
            || override_allowed_authorities
                .iter()
                .any(|authority| actor.has(authority));
    }
    inferred_roles.iter().any(|role| role == actor.role)
        || (!inferred_authorities.is_empty()
            && inferred_authorities
                .iter()
                .all(|authority| actor.has(authority)))
}

/// The compatibility status on the wire (`pg-report-engine` calls it `UNSUPPORTED`).
fn wire_status(compatibility: Compatibility) -> &'static str {
    match compatibility {
        Compatibility::Compatible => "COMPATIBLE",
        Compatibility::NeedsMigration => "NEEDS_MIGRATION",
        Compatibility::Unsupported => "INVALID",
    }
}

/// `ReportCompatibilityResult` in the TS field order and status names.
#[must_use]
pub fn report_compatibility_json(compatibility: &ReportCompatibility) -> Value {
    let issues: Vec<Value> = compatibility
        .issues
        .iter()
        .map(|issue| {
            json!({
                "path": issue.path,
                "code": issue.code,
                "message": issue.message,
            })
        })
        .collect();
    json!({
        "status": wire_status(compatibility.status),
        "reasonCode": compatibility.reason_code.map(ReasonCode::as_str),
        "message": compatibility.message,
        "storedEngineVersion": compatibility.stored_engine_version,
        "storedSpecVersion": compatibility.stored_spec_version,
        "currentEngineVersion": compatibility.current_engine_version,
        "currentSpecVersion": compatibility.current_spec_version,
        "declaredSpecVersion": compatibility.declared_spec_version,
        "issues": issues,
        "promptAvailable": compatibility.prompt_available,
    })
}

/// `report_definition_specs` as the read routes need it.
#[derive(Debug, Clone)]
pub struct ReportRow {
    pub id: Uuid,
    pub code: String,
    pub version: i32,
    pub category: String,
    pub audience_scope: String,
    pub status: String,
    pub is_latest_published: bool,
    pub supported_locales: Vec<String>,
    pub default_locale: String,
    pub spec_json: Value,
    pub spec_sha256: String,
    pub verification_report_json: Value,
    pub asset_bundle_id: Option<Uuid>,
    pub authority_mode: String,
    pub inferred_roles: Vec<String>,
    pub inferred_authorities: Vec<String>,
    pub conflict_status: String,
    pub requires_confidential_aml: bool,
    pub override_allowed_roles: Vec<String>,
    pub override_allowed_authorities: Vec<String>,
    pub override_justification: Option<String>,
    pub allow_confidential_aml_bypass: bool,
    pub engine_version: String,
    pub spec_schema_version: String,
    pub authoring_transcript_version: Option<String>,
    pub created_at: DateTime<Utc>,
    pub published_at: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
}

/// The columns every `report_definition_specs` query in this module selects.
pub const REPORT_COLUMNS: &str = "id, code, version, category, audience_scope::text AS audience_scope, \
     status::text AS status, is_latest_published, supported_locales, default_locale, spec_json, \
     spec_sha256, verification_report_json, asset_bundle_id, authority_mode::text AS authority_mode, \
     inferred_roles, inferred_authorities, conflict_status, requires_confidential_aml, \
     override_allowed_roles, override_allowed_authorities, override_justification, \
     allow_confidential_aml_bypass, engine_version, spec_schema_version, \
     authoring_transcript_version, created_at, published_at, updated_at";

impl ReportRow {
    /// Decode a row selected with [`REPORT_COLUMNS`].
    pub fn from_row(row: &PgRow) -> Result<Self, sqlx::Error> {
        Ok(Self {
            id: row.try_get("id")?,
            code: row.try_get("code")?,
            version: row.try_get("version")?,
            category: row.try_get("category")?,
            audience_scope: row.try_get("audience_scope")?,
            status: row.try_get("status")?,
            is_latest_published: row.try_get("is_latest_published")?,
            supported_locales: row.try_get("supported_locales")?,
            default_locale: row.try_get("default_locale")?,
            spec_json: row.try_get("spec_json")?,
            spec_sha256: row.try_get("spec_sha256")?,
            verification_report_json: row.try_get("verification_report_json")?,
            asset_bundle_id: row.try_get("asset_bundle_id")?,
            authority_mode: row.try_get("authority_mode")?,
            inferred_roles: row.try_get("inferred_roles")?,
            inferred_authorities: row.try_get("inferred_authorities")?,
            conflict_status: row.try_get("conflict_status")?,
            requires_confidential_aml: row.try_get("requires_confidential_aml")?,
            override_allowed_roles: row.try_get("override_allowed_roles")?,
            override_allowed_authorities: row.try_get("override_allowed_authorities")?,
            override_justification: row.try_get("override_justification")?,
            allow_confidential_aml_bypass: row.try_get("allow_confidential_aml_bypass")?,
            engine_version: row.try_get("engine_version")?,
            spec_schema_version: row.try_get("spec_schema_version")?,
            authoring_transcript_version: row.try_get("authoring_transcript_version")?,
            created_at: row.try_get("created_at")?,
            published_at: row.try_get("published_at")?,
            updated_at: row.try_get("updated_at")?,
        })
    }

    /// `reportCompatibilityOf(row)`.
    #[must_use]
    pub fn compatibility(&self) -> ReportCompatibility {
        classify_stored_report_spec(StoredSpecInput {
            spec_json: &self.spec_json,
            stored_engine_version: Some(self.engine_version.as_str()),
            stored_spec_version: Some(self.spec_schema_version.as_str()),
        })
    }

    /// `isAllowed(row, actor)`.
    #[must_use]
    pub fn allowed(&self, actor: Actor<'_>) -> bool {
        actor_allowed(
            &self.authority_mode,
            &self.inferred_roles,
            &self.inferred_authorities,
            &self.override_allowed_roles,
            &self.override_allowed_authorities,
            actor,
        )
    }

    /// The `GET /report-engine/specs` list item (never the spec body).
    #[must_use]
    pub fn list_json(&self) -> Value {
        json!({
            "id": self.id,
            "code": self.code,
            "version": self.version,
            "category": self.category,
            "audienceScope": self.audience_scope,
            "status": self.status,
            "isLatestPublished": self.is_latest_published,
            "supportedLocales": self.supported_locales,
            "defaultLocale": self.default_locale,
            "engineVersion": self.engine_version,
            "specSchemaVersion": self.spec_schema_version,
            "authoringTranscriptVersion": self.authoring_transcript_version,
            "compatibility": report_compatibility_json(&self.compatibility()),
            "specSha256": self.spec_sha256,
            "createdAt": iso(self.created_at),
            "publishedAt": iso_opt(self.published_at),
            "assetBundleId": self.asset_bundle_id,
            "authorityMode": self.authority_mode,
            "allowConfidentialAmlBypass": self.allow_confidential_aml_bypass,
        })
    }

    /// `GET /report-engine/specs/:id` (the spec body is the caller's own stored JSON).
    #[must_use]
    pub fn detail_json(&self) -> Value {
        json!({
            "id": self.id,
            "code": self.code,
            "version": self.version,
            "category": self.category,
            "audienceScope": self.audience_scope,
            "status": self.status,
            "isLatestPublished": self.is_latest_published,
            "supportedLocales": self.supported_locales,
            "defaultLocale": self.default_locale,
            "engineVersion": self.engine_version,
            "specSchemaVersion": self.spec_schema_version,
            "authoringTranscriptVersion": self.authoring_transcript_version,
            "compatibility": report_compatibility_json(&self.compatibility()),
            "spec": self.spec_json,
            "verification": self.verification_report_json,
            "specSha256": self.spec_sha256,
            "createdAt": iso(self.created_at),
            "publishedAt": iso_opt(self.published_at),
            "assetBundleId": self.asset_bundle_id,
            "authorityMode": self.authority_mode,
            "inferredRoles": self.inferred_roles,
            "inferredAuthorities": self.inferred_authorities,
            "conflictStatus": self.conflict_status,
            "requiresConfidentialAml": self.requires_confidential_aml,
            "overrideAllowedRoles": self.override_allowed_roles,
            "overrideAllowedAuthorities": self.override_allowed_authorities,
            "overrideJustification": self.override_justification,
            "allowConfidentialAmlBypass": self.allow_confidential_aml_bypass,
        })
    }

    /// The `GET /report-engine/catalog` entry.
    #[must_use]
    pub fn catalog_json(&self) -> Value {
        json!({
            "id": self.id,
            "code": self.code,
            "version": self.version,
            "category": self.category,
            "audienceScope": self.audience_scope,
            "supportedLocales": self.supported_locales,
            "defaultLocale": self.default_locale,
            "authorityMode": self.authority_mode,
            "inferredRoles": self.inferred_roles,
            "inferredAuthorities": self.inferred_authorities,
            "conflictStatus": self.conflict_status,
            "requiresConfidentialAml": self.requires_confidential_aml,
            "assetBundleId": self.asset_bundle_id,
            "spec": self.spec_json,
            "updatedAt": iso(self.updated_at),
        })
    }
}

/// `report_chrome_specs` as the read routes need it.
#[derive(Debug, Clone)]
pub struct ChromeRow {
    pub id: Uuid,
    pub code: String,
    pub version: i32,
    pub name: String,
    pub chrome_type: String,
    pub status: String,
    pub is_default_global: bool,
    pub default_revoked_at: Option<DateTime<Utc>>,
    pub default_revoked_reason: Option<String>,
    pub supported_locales: Vec<String>,
    pub spec_json: Value,
    pub asset_bundle_id: Option<Uuid>,
    pub engine_version: String,
    pub spec_schema_version: String,
    pub authoring_transcript_version: Option<String>,
}

/// The columns every `report_chrome_specs` query in this module selects.
pub const CHROME_COLUMNS: &str = "id, code, version, name, chrome_type::text AS chrome_type, \
     status::text AS status, is_default_global, default_revoked_at, default_revoked_reason, \
     supported_locales, spec_json, asset_bundle_id, engine_version, spec_schema_version, \
     authoring_transcript_version";

impl ChromeRow {
    /// Decode a row selected with [`CHROME_COLUMNS`].
    pub fn from_row(row: &PgRow) -> Result<Self, sqlx::Error> {
        Ok(Self {
            id: row.try_get("id")?,
            code: row.try_get("code")?,
            version: row.try_get("version")?,
            name: row.try_get("name")?,
            chrome_type: row.try_get("chrome_type")?,
            status: row.try_get("status")?,
            is_default_global: row.try_get("is_default_global")?,
            default_revoked_at: row.try_get("default_revoked_at")?,
            default_revoked_reason: row.try_get("default_revoked_reason")?,
            supported_locales: row.try_get("supported_locales")?,
            spec_json: row.try_get("spec_json")?,
            asset_bundle_id: row.try_get("asset_bundle_id")?,
            engine_version: row.try_get("engine_version")?,
            spec_schema_version: row.try_get("spec_schema_version")?,
            authoring_transcript_version: row.try_get("authoring_transcript_version")?,
        })
    }

    /// `chromeView(row, includeAssets)`.
    ///
    /// `assetDataUrls` stays empty in the read slice: inlining needs the Report Studio asset
    /// storage port (object storage + local default), which is P8-T02. The bundle id is returned so
    /// a client can request the assets through that path once it exists.
    #[must_use]
    pub fn view_json(&self) -> Value {
        let compatibility = self.compatibility();
        json!({
            "id": self.id,
            "code": self.code,
            "version": self.version,
            "name": self.name,
            "chromeType": self.chrome_type,
            "status": self.status,
            "isDefaultGlobal": self.is_default_global,
            "defaultRevokedAt": iso_opt(self.default_revoked_at),
            "defaultRevokedReason": self.default_revoked_reason,
            "engineVersion": self.engine_version,
            "specSchemaVersion": self.spec_schema_version,
            "authoringTranscriptVersion": self.authoring_transcript_version,
            "compatibility": compatibility.to_json(),
            "supportedLocales": self.supported_locales,
            "assetBundleId": self.asset_bundle_id,
            "assetDataUrls": {},
            "spec": self.spec_json,
        })
    }

    /// `chromeCompatibilityOf(row)`.
    #[must_use]
    pub fn compatibility(&self) -> ChromeCompatibility {
        classify_chrome(
            &self.spec_json,
            Some(&self.engine_version),
            Some(&self.spec_schema_version),
        )
    }

    /// True when this row can serve a default (published, default flag, compatible).
    #[must_use]
    pub fn usable_default(&self) -> bool {
        self.status == "PUBLISHED"
            && self.is_default_global
            && self.compatibility().status == "COMPATIBLE"
    }
}

/// `ChromeCompatibilityResult` (the TS chrome classifier).
#[derive(Debug, Clone)]
pub struct ChromeCompatibility {
    pub status: &'static str,
    pub reason_code: Option<&'static str>,
    pub message: String,
    pub stored_engine_version: Option<String>,
    pub stored_spec_version: Option<String>,
    pub declared_spec_version: Option<String>,
    pub issues: Vec<ChromeIssue>,
    pub prompt_available: bool,
}

/// One `CompatibilityIssue` reported with a chrome classification.
#[derive(Debug, Clone)]
pub struct ChromeIssue {
    pub path: &'static str,
    pub code: &'static str,
    pub message: String,
}

impl ChromeCompatibility {
    /// `ChromeCompatibilityResult` in the TS field order.
    #[must_use]
    pub fn to_json(&self) -> Value {
        let issues: Vec<Value> = self
            .issues
            .iter()
            .map(|issue| {
                json!({
                    "path": issue.path,
                    "code": issue.code,
                    "message": issue.message,
                })
            })
            .collect();
        json!({
            "status": self.status,
            "reasonCode": self.reason_code,
            "message": self.message,
            "storedEngineVersion": self.stored_engine_version,
            "storedSpecVersion": self.stored_spec_version,
            "currentEngineVersion": REPORT_ENGINE_VERSION,
            "currentSpecVersion": REPORT_CHROME_SPEC_VERSION,
            "declaredSpecVersion": self.declared_spec_version,
            "issues": issues,
            "promptAvailable": self.prompt_available,
        })
    }
}

fn declared(value: &Value, key: &str) -> Option<String> {
    value
        .as_object()
        .and_then(|object| object.get(key))
        .and_then(Value::as_str)
        .map(std::string::ToString::to_string)
}

fn parsed_spec(spec_json: &Value) -> Option<Value> {
    match spec_json {
        Value::String(text) => serde_json::from_str::<Value>(text).ok(),
        other => Some(other.clone()),
    }
}

fn base_chrome(
    declared_spec_version: Option<String>,
    stored_engine_version: Option<&str>,
    stored_spec_version: Option<&str>,
) -> ChromeCompatibility {
    ChromeCompatibility {
        status: "INVALID",
        reason_code: None,
        message: String::new(),
        stored_engine_version: stored_engine_version.map(std::string::ToString::to_string),
        stored_spec_version: stored_spec_version.map(std::string::ToString::to_string),
        declared_spec_version,
        issues: Vec::new(),
        prompt_available: true,
    }
}

fn is_kebab_code(value: &str) -> bool {
    (3..=64).contains(&value.len())
        && value.split('-').all(|part| {
            !part.is_empty()
                && part
                    .chars()
                    .all(|character| character.is_ascii_lowercase() || character.is_ascii_digit())
        })
}

fn chrome_schema_issues(spec: &Value) -> Vec<ChromeIssue> {
    let mut issues = Vec::new();
    let Some(object) = spec.as_object() else {
        issues.push(ChromeIssue {
            path: "<root>",
            code: "invalid_type",
            message: "Expected an object.".to_owned(),
        });
        return issues;
    };
    if object.get("spec_version").and_then(Value::as_str) != Some(REPORT_CHROME_SPEC_VERSION) {
        issues.push(ChromeIssue {
            path: "spec_version",
            code: "invalid_literal",
            message: format!("Expected {REPORT_CHROME_SPEC_VERSION}."),
        });
    }
    let Some(chrome) = object.get("chrome").and_then(Value::as_object) else {
        issues.push(ChromeIssue {
            path: "chrome",
            code: "invalid_type",
            message: "Expected the chrome identity block.".to_owned(),
        });
        return issues;
    };
    let code = chrome
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !is_kebab_code(code) {
        issues.push(ChromeIssue {
            path: "chrome.code",
            code: "invalid_string",
            message: "Must be kebab-case, e.g. cbl-official-header-v1.".to_owned(),
        });
    }
    let name = chrome
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !(3..=120).contains(&name.chars().count()) {
        issues.push(ChromeIssue {
            path: "chrome.name",
            code: "too_small",
            message: "Must be 3 to 120 characters.".to_owned(),
        });
    }
    match chrome.get("chrome_type").and_then(Value::as_str) {
        Some("HEADER" | "FOOTER") => {}
        _ => issues.push(ChromeIssue {
            path: "chrome.chrome_type",
            code: "invalid_enum_value",
            message: "Must be HEADER or FOOTER.".to_owned(),
        }),
    }
    let Some(required) = object.get("required_assets") else {
        issues.push(ChromeIssue {
            path: "required_assets",
            code: "invalid_type",
            message: "Expected an array (default []).".to_owned(),
        });
        return issues;
    };
    match required.as_array() {
        Some(assets) if assets.len() <= 10 => {
            for (index, asset) in assets.iter().enumerate() {
                let valid = asset.as_object().is_some_and(|entry| {
                    entry
                        .get("asset_key")
                        .and_then(Value::as_str)
                        .is_some_and(|value| {
                            !value.is_empty()
                                && value.chars().all(|character| {
                                    character.is_ascii_alphanumeric()
                                        || matches!(character, '_' | '-')
                                })
                        })
                        && entry
                            .get("file_name")
                            .and_then(Value::as_str)
                            .is_some_and(|value| {
                                !value.is_empty()
                                    && value.chars().all(|character| {
                                        character.is_ascii_alphanumeric()
                                            || matches!(character, '.' | '_' | '-')
                                    })
                            })
                        && matches!(
                            entry.get("mime_type").and_then(Value::as_str),
                            Some("image/png" | "image/jpeg" | "image/webp" | "image/svg+xml")
                        )
                        && entry.get("alt_i18n_key").and_then(Value::as_str).is_some()
                });
                if !valid {
                    issues.push(ChromeIssue {
                        path: "required_assets",
                        code: "invalid_asset",
                        message: format!("Asset {index} does not match the required asset shape."),
                    });
                }
            }
        }
        _ => issues.push(ChromeIssue {
            path: "required_assets",
            code: "too_big",
            message: "At most 10 assets are allowed.".to_owned(),
        }),
    }
    let locales = object
        .get("i18n")
        .and_then(Value::as_object)
        .and_then(|i18n| i18n.get("locales"))
        .and_then(Value::as_object);
    match locales {
        Some(locales) if locales.contains_key("en") && locales.contains_key("ar") => {}
        _ => issues.push(ChromeIssue {
            path: "i18n.locales",
            code: "custom",
            message: "i18n.locales MUST include both 'en' and 'ar' translation dictionaries."
                .to_owned(),
        }),
    }
    issues
}

/// `classifyStoredChromeSpec`.
#[must_use]
pub fn classify_chrome(
    spec_json: &Value,
    stored_engine_version: Option<&str>,
    stored_spec_version: Option<&str>,
) -> ChromeCompatibility {
    let Some(spec) = parsed_spec(spec_json) else {
        let mut result = base_chrome(None, stored_engine_version, stored_spec_version);
        result.reason_code = Some("INVALID_SPEC_JSON");
        result.message = "The stored chrome spec is not valid JSON.".to_owned();
        return result;
    };
    let declared_version = declared(&spec, "spec_version");
    let stored_spec_version = stored_spec_version
        .map(std::string::ToString::to_string)
        .or_else(|| declared_version.clone());
    let mut result = base_chrome(
        declared_version,
        stored_engine_version,
        stored_spec_version.as_deref(),
    );

    if declared(&spec, "spec_kind").as_deref() != Some("REPORT_CHROME") {
        result.reason_code = Some("WRONG_SPEC_KIND");
        result.message = "The stored chrome spec is not a REPORT_CHROME.".to_owned();
        result.issues.push(ChromeIssue {
            path: "spec_kind",
            code: "WRONG_SPEC_KIND",
            message: "Expected REPORT_CHROME.".to_owned(),
        });
        return result;
    }
    if stored_engine_version.is_none_or(str::is_empty)
        || stored_spec_version.as_deref().is_none_or(str::is_empty)
    {
        result.status = "NEEDS_MIGRATION";
        result.reason_code = Some("MISSING_VERSION_METADATA");
        result.message = "The stored chrome spec has no recorded engine/spec version.".to_owned();
        return result;
    }
    if !is_supported_engine_version(stored_engine_version) {
        let stored = stored_engine_version.unwrap_or_default();
        result.status = "NEEDS_MIGRATION";
        result.reason_code = Some("ENGINE_MAJOR_VERSION_MISMATCH");
        result.message = format!(
            "The header/footer was saved for engine version {stored}; this engine is {REPORT_ENGINE_VERSION}."
        );
        result.issues.push(ChromeIssue {
            path: "engine_version",
            code: "ENGINE_MAJOR_VERSION_MISMATCH",
            message: format!(
                "Engine major {} is not supported.",
                major_version_of(Some(stored))
                    .map_or_else(|| "unknown".to_owned(), |value| value.to_string())
            ),
        });
        return result;
    }
    if !is_supported_chrome_spec_version(stored_spec_version.as_deref()) {
        let stored = stored_spec_version.as_deref().unwrap_or_default();
        result.status = "NEEDS_MIGRATION";
        result.reason_code = Some("SPEC_VERSION_UNSUPPORTED");
        result.message = format!(
            "The header/footer uses spec version {stored}; this engine supports {REPORT_CHROME_SPEC_VERSION}."
        );
        result.issues.push(ChromeIssue {
            path: "spec_version",
            code: "SPEC_VERSION_UNSUPPORTED",
            message: format!("Chrome spec version {stored} is not supported."),
        });
        return result;
    }
    let issues = chrome_schema_issues(&spec);
    if !issues.is_empty() {
        result.reason_code = Some("CURRENT_SCHEMA_VALIDATION_FAILED");
        result.message = "The stored chrome spec does not match the current schema.".to_owned();
        result.issues = issues;
        return result;
    }
    result.status = "COMPATIBLE";
    result.reason_code = None;
    result.message = "The stored chrome spec is compatible with the running engine.".to_owned();
    result.prompt_available = false;
    result
}

/// The published chrome of one control plane, latest version per code (TS `loadChromeRegistryState`
/// restricted to what the catalog health needs).
#[derive(Debug, Default)]
pub struct ChromeRegistry {
    pub latest: Vec<ChromeRow>,
    pub broken_by_code: Vec<String>,
}

impl ChromeRegistry {
    /// Build the registry from published rows ordered `chrome_type asc, code asc, version desc`.
    #[must_use]
    pub fn from_published(rows: Vec<ChromeRow>) -> Self {
        let mut latest: Vec<ChromeRow> = Vec::new();
        for row in rows {
            if latest.iter().any(|entry| entry.code == row.code) {
                continue;
            }
            latest.push(row);
        }
        let broken_by_code = latest
            .iter()
            .filter(|row| row.compatibility().status != "COMPATIBLE")
            .map(|row| row.code.clone())
            .collect();
        Self {
            latest,
            broken_by_code,
        }
    }

    /// `reportChromeDependency(spec, state, "PLATFORM", compatibility)` readiness.
    #[must_use]
    pub fn dependency_ready(&self, spec: &Value) -> bool {
        let layout = spec.get("page_layout");
        let mode = |key: &str| {
            layout
                .and_then(|value| value.get(key))
                .and_then(Value::as_str)
                .unwrap_or("GLOBAL_DEFAULT")
        };
        let code = |key: &str| {
            layout
                .and_then(|value| value.get(key))
                .and_then(Value::as_str)
        };
        for (type_name, mode_key, code_key) in [
            ("HEADER", "header_mode", "header_chrome_code"),
            ("FOOTER", "footer_mode", "footer_chrome_code"),
        ] {
            match mode(mode_key) {
                "NONE" | "INLINE_SPEC" => {}
                "SPECIFIC_CHROME_CODE" => {
                    let Some(requested) = code(code_key) else {
                        return false;
                    };
                    let ready = self.latest.iter().any(|row| {
                        row.chrome_type == type_name
                            && row.code == requested
                            && row.compatibility().status == "COMPATIBLE"
                    });
                    if !ready {
                        return false;
                    }
                }
                _ => {
                    let ready = self
                        .latest
                        .iter()
                        .any(|row| row.chrome_type == type_name && row.usable_default());
                    if !ready {
                        return false;
                    }
                }
            }
        }
        true
    }
}

/// One header/footer selection read from a stored report spec (`page_layout`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayoutSelection {
    pub header_mode: String,
    pub header_code: Option<String>,
    pub footer_mode: String,
    pub footer_code: Option<String>,
}

/// Read `page_layout` with the TS schema defaults.
#[must_use]
pub fn layout_selection(spec: &Value) -> LayoutSelection {
    let layout = spec.get("page_layout");
    let text = |key: &str| {
        layout
            .and_then(|value| value.get(key))
            .and_then(Value::as_str)
            .map(std::string::ToString::to_string)
    };
    LayoutSelection {
        header_mode: text("header_mode").unwrap_or_else(|| "GLOBAL_DEFAULT".to_owned()),
        header_code: text("header_chrome_code"),
        footer_mode: text("footer_mode").unwrap_or_else(|| "GLOBAL_DEFAULT".to_owned()),
        footer_code: text("footer_chrome_code"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report_policy() -> (String, Vec<String>, Vec<String>, Vec<String>, Vec<String>) {
        (
            "INFERRED_STRICT".to_owned(),
            vec!["COMPLIANCE".to_owned()],
            vec!["report:run".to_owned()],
            Vec::new(),
            Vec::new(),
        )
    }

    #[test]
    fn the_wire_status_uses_the_ts_invalid_name() {
        assert_eq!(wire_status(Compatibility::Compatible), "COMPATIBLE");
        assert_eq!(
            wire_status(Compatibility::NeedsMigration),
            "NEEDS_MIGRATION"
        );
        assert_eq!(wire_status(Compatibility::Unsupported), "INVALID");
    }

    #[test]
    fn actor_policy_matches_is_actor_allowed_by_policy() {
        let (mode, roles, authorities, override_roles, override_authorities) = report_policy();
        let compliance = ["report:run".to_owned()];
        assert!(actor_allowed(
            &mode,
            &roles,
            &authorities,
            &override_roles,
            &override_authorities,
            Actor {
                role: "COMPLIANCE",
                authorities: &compliance
            }
        ));
        // Wrong role and not every inferred authority: refused.
        let finance = ["other:read".to_owned()];
        assert!(!actor_allowed(
            &mode,
            &roles,
            &authorities,
            &override_roles,
            &override_authorities,
            Actor {
                role: "FINANCE",
                authorities: &finance
            }
        ));
        // The security wildcard always reaches the record.
        let security = ["security:write".to_owned()];
        assert!(actor_allowed(
            &mode,
            &roles,
            &authorities,
            &override_roles,
            &override_authorities,
            Actor {
                role: "FINANCE",
                authorities: &security
            }
        ));
        // An inferred empty authority list never grants on its own.
        assert!(!actor_allowed(
            "INFERRED_STRICT",
            &[],
            &[],
            &[],
            &[],
            Actor {
                role: "FINANCE",
                authorities: &finance
            }
        ));
        // Override mode only reads the override lists.
        assert!(actor_allowed(
            "SECURITY_ADMIN_OVERRIDE",
            &roles,
            &authorities,
            &["FINANCE".to_owned()],
            &[],
            Actor {
                role: "FINANCE",
                authorities: &finance
            }
        ));
        assert!(!actor_allowed(
            "SECURITY_ADMIN_OVERRIDE",
            &roles,
            &authorities,
            &[],
            &["report:run".to_owned()],
            Actor {
                role: "FINANCE",
                authorities: &["other:read".to_owned()]
            }
        ));
    }

    #[test]
    fn a_compatible_chrome_spec_passes_the_structural_gate() {
        let spec = json!({
            "spec_kind": "REPORT_CHROME",
            "spec_version": "1.0",
            "chrome": {
                "code": "platform-header-v1",
                "name": "Platform header",
                "chrome_type": "HEADER"
            },
            "required_assets": [],
            "i18n": {"default_locale": "en", "locales": {"en": {}, "ar": {}}}
        });
        let result = classify_chrome(&spec, Some("1.0.0"), Some("1.0"));
        assert_eq!(result.status, "COMPATIBLE");
        assert!(result.reason_code.is_none());
        assert!(!result.prompt_available);
        let wire = result.to_json();
        assert_eq!(wire["status"], "COMPATIBLE");
        assert_eq!(wire["currentSpecVersion"], "1.0");
    }

    #[test]
    fn chrome_compatibility_reports_the_three_outcomes() {
        let base = json!({
            "spec_kind": "REPORT_CHROME",
            "spec_version": "1.0",
            "chrome": {"code": "x-header-v1", "name": "Header", "chrome_type": "HEADER"},
            "required_assets": [],
            "i18n": {"locales": {"en": {}, "ar": {}}}
        });
        assert_eq!(
            classify_chrome(&base, Some("2.0.0"), Some("1.0")).reason_code,
            Some("ENGINE_MAJOR_VERSION_MISMATCH")
        );
        let mut without_version = base.clone();
        without_version
            .as_object_mut()
            .expect("object")
            .remove("spec_version");
        assert_eq!(
            classify_chrome(&without_version, Some("1.0.0"), None).status,
            "NEEDS_MIGRATION"
        );
        let mut wrong = base.clone();
        wrong["spec_kind"] = json!("REPORT_DESCRIPTOR");
        let result = classify_chrome(&wrong, Some("1.0.0"), Some("1.0"));
        assert_eq!(result.status, "INVALID");
        assert_eq!(result.reason_code, Some("WRONG_SPEC_KIND"));
        let mut invalid = base;
        invalid["chrome"]["code"] = json!("Not Kebab");
        let result = classify_chrome(&invalid, Some("1.0.0"), Some("1.0"));
        assert_eq!(result.status, "INVALID");
        assert_eq!(result.reason_code, Some("CURRENT_SCHEMA_VALIDATION_FAILED"));
    }

    #[test]
    fn chrome_dependency_requires_a_compatible_default_or_named_code() {
        let header = ChromeRow {
            id: Uuid::new_v4(),
            code: "platform-header-v1".to_owned(),
            version: 1,
            name: "Header".to_owned(),
            chrome_type: "HEADER".to_owned(),
            status: "PUBLISHED".to_owned(),
            is_default_global: true,
            default_revoked_at: None,
            default_revoked_reason: None,
            supported_locales: vec!["en".to_owned()],
            spec_json: json!({
                "spec_kind": "REPORT_CHROME",
                "spec_version": "1.0",
                "chrome": {"code": "platform-header-v1", "name": "Header", "chrome_type": "HEADER"},
                "required_assets": [],
                "i18n": {"locales": {"en": {}, "ar": {}}}
            }),
            asset_bundle_id: None,
            engine_version: "1.0.0".to_owned(),
            spec_schema_version: "1.0".to_owned(),
            authoring_transcript_version: None,
        };
        let registry = ChromeRegistry::from_published(vec![header]);
        assert!(registry.broken_by_code.is_empty());
        let global =
            json!({"page_layout": {"header_mode": "GLOBAL_DEFAULT", "footer_mode": "NONE"}});
        assert!(registry.dependency_ready(&global));
        let named = json!({"page_layout": {
            "header_mode": "SPECIFIC_CHROME_CODE",
            "header_chrome_code": "platform-header-v1",
            "footer_mode": "NONE"
        }});
        assert!(registry.dependency_ready(&named));
        let missing = json!({"page_layout": {
            "header_mode": "SPECIFIC_CHROME_CODE",
            "header_chrome_code": "unknown-header",
            "footer_mode": "NONE"
        }});
        assert!(!registry.dependency_ready(&missing));
    }

    #[test]
    fn timestamps_are_iso_with_milliseconds() {
        let instant = DateTime::parse_from_rfc3339("2026-11-28T10:20:30.123Z")
            .expect("timestamp")
            .with_timezone(&Utc);
        assert_eq!(iso(instant), "2026-11-28T10:20:30.123Z");
        assert_eq!(iso_opt(None), Value::Null);
    }
}

//! Merchant Report Studio catalogue, autocomplete, authoring transcripts and migration prompts.
//!
//! Sources:
//! - `core-back/api/internal/merchantReportEngine.ts` (catalog, autocomplete, transcripts,
//!   migration prompts);
//! - `core-back/engine/reportStudio/{merchantHostConfig,merchantReportEngine}.ts` (allow-list,
//!   tier limits, merchant-safe spec);
//! - `core-back/lib/reportEngineSdk/{transcript,migrations}/**` (released artefacts);
//! - `core-back/api/internal/adminReportEngine.ts` (`loadChromeRegistryState`,
//!   `reportChromeDependency`).
//!
//! The authoring transcripts are released, byte-identical artefacts. They are committed next to
//! this module and were generated from the TS SDK with the merchant host catalog and a fixed
//! `generatedAt` (`1970-01-01T00:00:00.000Z`); the handler substitutes the request timestamp. To
//! regenerate after a catalog change, run the SDK builder with `merchantMode: true` and
//! `generatedAt: new Date(0)` (assets enabled and disabled) and the chrome builder with
//! `merchantMode: true`. `report_catalog.json` is the merchant model allow-list metadata used by the
//! scope/tier validators (generated from `buildSchemaCatalog()` + `pickMerchantModels()`).

#![forbid(unsafe_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

use chrono::{DateTime, SecondsFormat, Utc};
use ntex::web::HttpRequest;
use pg_domain_auth::Principal;
use pg_report_engine::{
    Catalog, CatalogColumn, CatalogModel, Domain, MerchantScopable, ReportSpec, Sensitivity,
};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sqlx::Row;
use uuid::Uuid;

use super::super::common::json_ok;
use super::super::{Handler, HandlerFuture, MountedRoute, PrincipalGuard};
use super::report_engine::{
    assert_engine_available, chrome_compatibility, report_compatibility,
    REPORT_CHROME_SPEC_VERSION, REPORT_ENGINE_VERSION, REPORT_SPEC_VERSION,
};
use super::{
    assert_merchant_authority, path_segment, path_uuid, positive_int, query_scalar,
    require_merchant_session,
};
use crate::http::error_response;
use crate::routes::common::database_error;
use crate::state::AppState;
use pg_http::{ApiError, Authn, BodyRule, Channel, Policy, ScopeRule};

const ORIGIN_CATALOG: &str = "core-back/api/internal/merchantReportEngine.ts:576";
const ORIGIN_AUTOCOMPLETE: &str = "core-back/api/internal/merchantReportEngine.ts:735";
const ORIGIN_REPORT_TRANSCRIPT: &str = "core-back/api/internal/merchantReportEngine.ts:1161";
const ORIGIN_CHROME_TRANSCRIPT: &str = "core-back/api/internal/merchantReportEngine.ts:808";
const ORIGIN_REPORT_MIGRATION: &str = "core-back/api/internal/merchantReportEngine.ts:1470";
const ORIGIN_CHROME_MIGRATION: &str = "core-back/api/internal/merchantReportEngine.ts:1120";

/// `REPORT_TRANSCRIPT_VERSION`.
pub const REPORT_TRANSCRIPT_VERSION: &str = "1.1";
/// `REPORT_CHROME_TRANSCRIPT_VERSION`.
pub const REPORT_CHROME_TRANSCRIPT_VERSION: &str = "1.1";
/// The placeholder timestamp baked into the committed transcripts.
pub(super) const TEMPLATE_GENERATED_AT: &str = "1970-01-01T00:00:00.000Z";

/// The released merchant report transcript with assets enabled.
const TRANSCRIPT_ASSETS: &str = include_str!("transcript_merchant_assets.md");
/// The released merchant report transcript with assets disabled.
const TRANSCRIPT_NO_ASSETS: &str = include_str!("transcript_merchant_no_assets.md");
/// The released merchant chrome transcript.
const TRANSCRIPT_CHROME: &str = include_str!("transcript_chrome_merchant.md");
/// The merchant model allow-list metadata (regeneration note in the module doc).
const SNAPSHOT: &str = include_str!("report_catalog.json");

/// Routes owned by this module.
#[must_use]
pub fn routes() -> Vec<MountedRoute> {
    let run = super::policy_authorities(&["report_engine:run"]);
    let author = super::policy_authorities(&["report_engine:author"]);
    let run_refs: Vec<&str> = run.iter().map(String::as_str).collect();
    let author_refs: Vec<&str> = author.iter().map(String::as_str).collect();
    let route = |path: &str, origin: &str, authorities: &[&str], handler| MountedRoute {
        policy: Policy::new("GET", path, Channel::Merchant, Authn::Session, origin)
            .authorities(authorities)
            .merchant_scope(ScopeRule::Required)
            .body(BodyRule::None),
        handler,
        guard: PrincipalGuard::Merchant,
    };
    vec![
        route(
            "/internal/merchant/report-engine/catalog",
            ORIGIN_CATALOG,
            &run_refs,
            Handler::Custom(catalog),
        ),
        route(
            "/internal/merchant/report-engine/autocomplete/:sourceKey",
            ORIGIN_AUTOCOMPLETE,
            &run_refs,
            Handler::Custom(autocomplete),
        ),
        route(
            "/internal/merchant/report-engine/studio/transcript",
            ORIGIN_REPORT_TRANSCRIPT,
            &author_refs,
            Handler::Custom(report_transcript),
        ),
        route(
            "/internal/merchant/report-engine/studio/chrome/transcript",
            ORIGIN_CHROME_TRANSCRIPT,
            &author_refs,
            Handler::Custom(chrome_transcript),
        ),
        route(
            "/internal/merchant/report-engine/studio/specs/:id/migration-prompt",
            ORIGIN_REPORT_MIGRATION,
            &author_refs,
            Handler::Custom(report_migration_prompt),
        ),
        route(
            "/internal/merchant/report-engine/studio/chrome/:id/migration-prompt",
            ORIGIN_CHROME_MIGRATION,
            &author_refs,
            Handler::Custom(chrome_migration_prompt),
        ),
    ]
}

// ---------------------------------------------------------------------------------------------
// Catalog snapshot
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    models: Vec<SnapModel>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapModel {
    model_name: String,
    table_name: String,
    domain: String,
    columns: Vec<SnapColumn>,
    #[serde(default)]
    merchant_scopable: Option<SnapScopable>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapColumn {
    name: String,
    #[serde(default)]
    sensitivity: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapScopable {
    merchant_id_column: String,
    #[serde(default)]
    application_id_column: Option<String>,
}

fn snapshot() -> &'static Snapshot {
    static SNAPSHOT_VALUE: OnceLock<Snapshot> = OnceLock::new();
    SNAPSHOT_VALUE
        .get_or_init(|| serde_json::from_str(SNAPSHOT).unwrap_or(Snapshot { models: Vec::new() }))
}

fn parse_domain(raw: &str) -> Domain {
    match raw {
        "LEDGER" => Domain::Ledger,
        "PAYMENTS" => Domain::Payments,
        "MERCHANTS" => Domain::Merchants,
        "COMPLIANCE_AML" => Domain::ComplianceAml,
        "GATEWAYS" => Domain::Gateways,
        "RECONCILIATION" => Domain::Reconciliation,
        "SECURITY_AUDIT" => Domain::SecurityAudit,
        _ => Domain::Operations,
    }
}

fn parse_sensitivity(raw: &str) -> Sensitivity {
    match raw {
        "PUBLIC" => Sensitivity::Public,
        "CONFIDENTIAL_AML" => Sensitivity::ConfidentialAml,
        "PII_MASKED" => Sensitivity::PiiMasked,
        "FORBIDDEN_SECRET" => Sensitivity::ForbiddenSecret,
        _ => Sensitivity::Internal,
    }
}

fn merchant_catalog() -> &'static Catalog {
    static CATALOG: OnceLock<Catalog> = OnceLock::new();
    CATALOG.get_or_init(|| {
        let mut catalog = Catalog::new();
        for model in &snapshot().models {
            let mut entry = CatalogModel::new(
                &model.model_name,
                &model.table_name,
                parse_domain(&model.domain),
            );
            for column in &model.columns {
                entry.columns.insert(
                    column.name.clone(),
                    CatalogColumn::new(&column.name, parse_sensitivity(&column.sensitivity)),
                );
            }
            entry.merchant_scopable =
                model
                    .merchant_scopable
                    .as_ref()
                    .map(|scopable| MerchantScopable {
                        merchant_id_column: scopable.merchant_id_column.clone(),
                        application_id_column: scopable.application_id_column.clone(),
                    });
            catalog = catalog.with_model(entry);
        }
        catalog
    })
}

fn model_date_column(model: &str) -> Option<&'static str> {
    let entry = snapshot()
        .models
        .iter()
        .find(|entry| entry.table_name == model)?;
    if entry
        .columns
        .iter()
        .any(|column| column.name == "created_at")
    {
        Some("created_at")
    } else if entry.columns.iter().any(|column| column.name == "day") {
        Some("day")
    } else {
        None
    }
}

// ---------------------------------------------------------------------------------------------
// Merchant tier limits (merchantReportEngine.ts:127)
// ---------------------------------------------------------------------------------------------

const MERCHANT_MAX_DATASETS: usize = 6;
const MERCHANT_MAX_JOINS: usize = 2;
const MERCHANT_MAX_SELECTS: usize = 20;
const MERCHANT_MAX_WINDOWS: usize = 2;
const MERCHANT_MAX_SECTIONS: usize = 24;
const MERCHANT_MAX_ROWS: i64 = 10_000;
const MERCHANT_MAX_RANGE_DAYS: i64 = 92;
const MERCHANT_MAX_SPEC_BYTES: usize = 256 * 1024;

fn collect_range_predicates<'a>(node: Option<&'a Value>, out: &mut Vec<&'a Value>) {
    let Some(node) = node else {
        return;
    };
    match node.get("kind").and_then(Value::as_str) {
        Some("PREDICATE") => out.push(node),
        Some("GROUP") if node.get("logic").and_then(Value::as_str) == Some("AND") => {
            if let Some(conditions) = node.get("conditions").and_then(Value::as_array) {
                for condition in conditions {
                    collect_range_predicates(Some(condition), out);
                }
            }
        }
        _ => {}
    }
}

fn js_date_millis(raw: &str) -> Option<i64> {
    if let Ok(value) = DateTime::parse_from_rfc3339(raw) {
        return Some(value.timestamp_millis());
    }
    let date = chrono::NaiveDate::parse_from_str(raw, "%Y-%m-%d").ok()?;
    Some(date.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis())
}

fn days_between(start: &Value, end: &Value) -> Option<i64> {
    let start = start.as_str().and_then(js_date_millis)?;
    let end = end.as_str().and_then(js_date_millis)?;
    Some((end - start) / (24 * 3600 * 1000))
}

fn input_max_range_days(spec: &ReportSpec, input_key: &str) -> i64 {
    spec.inputs
        .iter()
        .find(|input| input.key == input_key)
        .and_then(|input| input.extra.get("validation"))
        .and_then(|validation| validation.get("max_range_days"))
        .and_then(Value::as_i64)
        .unwrap_or(0)
}

fn literal_pair(binding: &Value) -> Option<(Value, Value)> {
    let value = binding.get("value")?;
    if let Some(pair) = value.as_array() {
        return Some((pair.first()?.clone(), pair.get(1)?.clone()));
    }
    let start = value.get("start")?.clone();
    let end = value.get("end")?.clone();
    Some((start, end))
}

fn tier_limits_ok(spec: &ReportSpec, spec_bytes: Option<usize>) -> bool {
    if spec_bytes.is_some_and(|bytes| bytes > MERCHANT_MAX_SPEC_BYTES) {
        return false;
    }
    if spec.datasets.len() > MERCHANT_MAX_DATASETS || spec.sections.len() > MERCHANT_MAX_SECTIONS {
        return false;
    }
    for dataset in &spec.datasets {
        if dataset.joins.len() > MERCHANT_MAX_JOINS
            || dataset.select.len() > MERCHANT_MAX_SELECTS
            || dataset.window_fields.len() > MERCHANT_MAX_WINDOWS
        {
            return false;
        }
        let limit = dataset
            .extra
            .get("limit")
            .and_then(Value::as_i64)
            .unwrap_or(1000);
        if limit > MERCHANT_MAX_ROWS {
            return false;
        }
        let Some(date_column) = model_date_column(&dataset.from_model) else {
            return false;
        };
        let mut predicates = Vec::new();
        collect_range_predicates(dataset.where_filter.as_ref(), &mut predicates);
        let predicates: Vec<&Value> = predicates
            .into_iter()
            .filter(|predicate| {
                predicate.get("column").and_then(Value::as_str) == Some(date_column)
            })
            .collect();
        let mut bounded = false;
        for predicate in &predicates {
            if predicate.get("op").and_then(Value::as_str) != Some("between") {
                continue;
            }
            let Some(binding) = predicate.get("binding") else {
                continue;
            };
            match binding.get("source").and_then(Value::as_str) {
                Some("INPUT") => {
                    if let Some(key) = binding.get("input_key").and_then(Value::as_str) {
                        let max_range = input_max_range_days(spec, key);
                        if max_range > 0 && max_range <= MERCHANT_MAX_RANGE_DAYS {
                            bounded = true;
                        }
                    }
                }
                Some("LITERAL") => {
                    if let Some((start, end)) = literal_pair(binding) {
                        if days_between(&start, &end)
                            .is_some_and(|days| days <= MERCHANT_MAX_RANGE_DAYS)
                        {
                            bounded = true;
                        }
                    }
                }
                _ => {}
            }
        }
        if !bounded {
            let lower = predicates.iter().find(|predicate| {
                matches!(
                    predicate.get("op").and_then(Value::as_str),
                    Some("gte" | "gt")
                )
            });
            let upper = predicates.iter().find(|predicate| {
                matches!(
                    predicate.get("op").and_then(Value::as_str),
                    Some("lte" | "lt")
                )
            });
            if let (Some(lower), Some(upper)) = (lower, upper) {
                let lower_binding = lower.get("binding");
                let upper_binding = upper.get("binding");
                if let (Some(lower_binding), Some(upper_binding)) = (lower_binding, upper_binding) {
                    let lower_source = lower_binding.get("source").and_then(Value::as_str);
                    let upper_source = upper_binding.get("source").and_then(Value::as_str);
                    if lower_source == Some("INPUT") && upper_source == Some("INPUT") {
                        let lower_key = lower_binding.get("input_key").and_then(Value::as_str);
                        let upper_key = upper_binding.get("input_key").and_then(Value::as_str);
                        if lower_key == upper_key
                            && lower_binding.get("range_bound").and_then(Value::as_str)
                                == Some("START")
                            && upper_binding.get("range_bound").and_then(Value::as_str)
                                == Some("END")
                        {
                            let max_range = lower_key
                                .map(|key| input_max_range_days(spec, key))
                                .unwrap_or(0);
                            if max_range > 0 && max_range <= MERCHANT_MAX_RANGE_DAYS {
                                bounded = true;
                            }
                        }
                    } else if lower_source == Some("LITERAL") && upper_source == Some("LITERAL") {
                        if let (Some(lower_value), Some(upper_value)) =
                            (lower_binding.get("value"), upper_binding.get("value"))
                        {
                            if days_between(lower_value, upper_value)
                                .is_some_and(|days| days <= MERCHANT_MAX_RANGE_DAYS)
                            {
                                bounded = true;
                            }
                        }
                    }
                }
            }
        }
        if !bounded {
            return false;
        }
    }
    true
}

/// `merchantSafeSpec` (`merchantReportEngine.ts:541`): no query AST, no suggested access.
#[must_use]
pub fn merchant_safe_spec(spec: &Value) -> Value {
    let Some(object) = spec.as_object() else {
        return spec.clone();
    };
    let mut out = Map::new();
    for (key, value) in object {
        if key == "datasets" || key == "suggested_access" {
            continue;
        }
        out.insert(key.clone(), value.clone());
    }
    let datasets: Vec<Value> = object
        .get("datasets")
        .and_then(Value::as_array)
        .map(|datasets| {
            datasets
                .iter()
                .map(|dataset| {
                    let mut entry = Map::new();
                    entry.insert(
                        "dataset_id".to_owned(),
                        dataset.get("dataset_id").cloned().unwrap_or(Value::Null),
                    );
                    let select: Vec<Value> = dataset
                        .get("select")
                        .and_then(Value::as_array)
                        .map(|select| {
                            select
                                .iter()
                                .map(|field| {
                                    let mut item = Map::new();
                                    item.insert(
                                        "alias".to_owned(),
                                        field.get("alias").cloned().unwrap_or(Value::Null),
                                    );
                                    item.insert(
                                        "format_hint".to_owned(),
                                        field
                                            .get("format_hint")
                                            .filter(|value| value.is_string())
                                            .cloned()
                                            .unwrap_or_else(|| Value::String("RAW".to_owned())),
                                    );
                                    if let Some(label) = field
                                        .get("label_i18n_key")
                                        .filter(|value| value.is_string())
                                    {
                                        item.insert("label_i18n_key".to_owned(), label.clone());
                                    }
                                    Value::Object(item)
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    entry.insert("select".to_owned(), Value::Array(select));
                    let windows: Vec<Value> = dataset
                        .get("window_fields")
                        .and_then(Value::as_array)
                        .map(|windows| {
                            windows
                                .iter()
                                .map(|field| {
                                    let mut item = Map::new();
                                    item.insert(
                                        "alias".to_owned(),
                                        field.get("alias").cloned().unwrap_or(Value::Null),
                                    );
                                    if let Some(format) = field.get("format_hint") {
                                        item.insert("format_hint".to_owned(), format.clone());
                                    }
                                    if let Some(label) = field.get("label_i18n_key") {
                                        item.insert("label_i18n_key".to_owned(), label.clone());
                                    }
                                    Value::Object(item)
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    entry.insert("window_fields".to_owned(), Value::Array(windows));
                    Value::Object(entry)
                })
                .collect()
        })
        .unwrap_or_default();
    out.insert("datasets".to_owned(), Value::Array(datasets));
    Value::Object(out)
}

// ---------------------------------------------------------------------------------------------
// Chrome registry and dependency
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChromeScope {
    Platform,
    Merchant,
}

#[derive(Debug, Clone)]
struct ChromeEntry {
    scope: ChromeScope,
    code: String,
    chrome_type: String,
    is_default_global: bool,
    is_default_for_merchant: bool,
}

#[derive(Debug, Clone)]
struct BrokenChrome {
    code: String,
    chrome_type: String,
    is_default_global: bool,
    is_default_for_merchant: bool,
}

#[derive(Debug, Default, Clone)]
struct ChromeState {
    entries: Vec<ChromeEntry>,
    broken: BTreeMap<String, BrokenChrome>,
}

#[derive(Debug, Clone)]
#[allow(dead_code)] // the catalog only needs `ready`; the reason drives the Chrome Studio later
struct ChromeDependency {
    ready: bool,
    reason_code: Option<String>,
    message: Option<String>,
    broken_chrome_code: Option<String>,
}

impl ChromeDependency {
    fn ready() -> Self {
        Self {
            ready: true,
            reason_code: None,
            message: None,
            broken_chrome_code: None,
        }
    }

    fn blocked(reason: &str, message: String, code: Option<String>) -> Self {
        Self {
            ready: false,
            reason_code: Some(reason.to_owned()),
            message: Some(message),
            broken_chrome_code: code,
        }
    }
}

fn chrome_spec_parts(spec: &Value) -> Option<(String, String)> {
    let chrome = spec.get("chrome")?.as_object()?;
    let code = chrome.get("code")?.as_str()?.to_owned();
    let chrome_type = chrome.get("chrome_type")?.as_str()?.to_owned();
    Some((code, chrome_type))
}

async fn platform_chrome(state: &AppState) -> Result<ChromeState, ApiError> {
    let rows = sqlx::query(
        "SELECT id, code, version, chrome_type::text AS chrome_type, is_default_global, \
                status::text AS status, engine_version, spec_schema_version, spec_json \
           FROM report_chrome_specs WHERE status = 'PUBLISHED' \
          ORDER BY chrome_type ASC, code ASC, version DESC",
    )
    .fetch_all(&state.pools.main)
    .await;
    let rows = match rows {
        Ok(rows) => rows,
        Err(error) => return Err(database_error(error)),
    };
    let mut seen = BTreeSet::new();
    let mut registry = ChromeState::default();
    for row in &rows {
        let code: String = row.get("code");
        if !seen.insert(code.clone()) {
            continue;
        }
        let chrome_type: String = row.get("chrome_type");
        let is_default_global: bool = row.get("is_default_global");
        let spec_json: Value = row.try_get("spec_json").unwrap_or(Value::Null);
        let engine_version: Option<String> = row.try_get("engine_version").unwrap_or(None);
        let spec_version: Option<String> = row.try_get("spec_schema_version").unwrap_or(None);
        let compatibility = chrome_compatibility(
            &spec_json,
            engine_version.as_deref(),
            spec_version.as_deref(),
        );
        let parsed = chrome_spec_parts(&spec_json);
        let broken = BrokenChrome {
            code: code.clone(),
            chrome_type: chrome_type.clone(),
            is_default_global,
            is_default_for_merchant: false,
        };
        if compatibility["status"] != "COMPATIBLE" {
            registry.broken.insert(code.clone(), broken);
            continue;
        }
        match parsed {
            Some((_spec_code, spec_type)) => registry.entries.push(ChromeEntry {
                scope: ChromeScope::Platform,
                code,
                chrome_type: if spec_type.is_empty() {
                    chrome_type
                } else {
                    spec_type
                },
                is_default_global,
                is_default_for_merchant: false,
            }),
            None => {
                registry.broken.insert(code.clone(), broken);
            }
        }
    }
    Ok(registry)
}

async fn merchant_chrome(
    state: &AppState,
    merchant_id: Uuid,
    platform: ChromeState,
) -> Result<ChromeState, ApiError> {
    let rows = sqlx::query(
        "SELECT id, code, version, chrome_type::text AS chrome_type, is_default_for_merchant, \
                status::text AS status, engine_version, spec_schema_version, spec_json \
           FROM merchant_report_chrome_specs \
          WHERE merchant_id = $1 AND status = 'PUBLISHED' \
          ORDER BY chrome_type ASC, code ASC, version DESC",
    )
    .bind(merchant_id)
    .fetch_all(&state.pools.main)
    .await;
    let rows = match rows {
        Ok(rows) => rows,
        Err(error) => return Err(database_error(error)),
    };
    let mut seen = BTreeSet::new();
    let mut registry = platform;
    for row in &rows {
        let code: String = row.get("code");
        if !seen.insert(code.clone()) {
            continue;
        }
        let chrome_type: String = row.get("chrome_type");
        let is_default_for_merchant: bool = row.get("is_default_for_merchant");
        let spec_json: Value = row.try_get("spec_json").unwrap_or(Value::Null);
        let engine_version: Option<String> = row.try_get("engine_version").unwrap_or(None);
        let spec_version: Option<String> = row.try_get("spec_schema_version").unwrap_or(None);
        let compatibility = chrome_compatibility(
            &spec_json,
            engine_version.as_deref(),
            spec_version.as_deref(),
        );
        let parsed = chrome_spec_parts(&spec_json);
        let broken = BrokenChrome {
            code: code.clone(),
            chrome_type: chrome_type.clone(),
            is_default_global: false,
            is_default_for_merchant,
        };
        if compatibility["status"] != "COMPATIBLE" {
            registry.broken.insert(code.clone(), broken);
            continue;
        }
        match parsed {
            Some((_spec_code, spec_type)) => registry.entries.push(ChromeEntry {
                scope: ChromeScope::Merchant,
                code,
                chrome_type: if spec_type.is_empty() {
                    chrome_type
                } else {
                    spec_type
                },
                is_default_global: false,
                is_default_for_merchant,
            }),
            None => {
                registry.broken.insert(code.clone(), broken);
            }
        }
    }
    Ok(registry)
}

fn report_chrome_dependency(
    spec: &Value,
    state: &ChromeState,
    default_scope: ChromeScope,
) -> ChromeDependency {
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
    let check = |chrome_type: &str, mode: &str, code: Option<&str>| -> Option<ChromeDependency> {
        if mode == "NONE" || mode == "INLINE_SPEC" {
            return None;
        }
        let entries: Vec<&ChromeEntry> = state
            .entries
            .iter()
            .filter(|entry| entry.chrome_type == chrome_type)
            .collect();
        if mode == "SPECIFIC_CHROME_CODE" {
            let Some(code) = code else {
                return Some(ChromeDependency::blocked(
                    "REPORT_CHROME_NOT_FOUND",
                    format!("{chrome_type} chrome code is missing."),
                    None,
                ));
            };
            let found = if default_scope == ChromeScope::Merchant {
                entries
                    .iter()
                    .find(|entry| entry.scope == ChromeScope::Merchant && entry.code == code)
                    .or_else(|| {
                        entries.iter().find(|entry| {
                            entry.scope == ChromeScope::Platform && entry.code == code
                        })
                    })
            } else {
                entries
                    .iter()
                    .find(|entry| entry.scope == ChromeScope::Platform && entry.code == code)
            };
            if found.is_some() {
                return None;
            }
            let broken = state.broken.get(code);
            return Some(ChromeDependency::blocked(
                if broken.is_some() {
                    "REPORT_CHROME_NEEDS_MIGRATION"
                } else {
                    "REPORT_CHROME_NOT_FOUND"
                },
                if broken.is_some() {
                    format!(
                        "The {} chrome \"{code}\" needs migration.",
                        chrome_type.to_lowercase()
                    )
                } else {
                    format!(
                        "The {} chrome \"{code}\" is not published.",
                        chrome_type.to_lowercase()
                    )
                },
                Some(code.to_owned()),
            ));
        }
        if mode == "GLOBAL_DEFAULT" {
            if default_scope == ChromeScope::Merchant
                && entries.iter().any(|entry| {
                    entry.scope == ChromeScope::Merchant && entry.is_default_for_merchant
                })
            {
                return None;
            }
            if entries
                .iter()
                .any(|entry| entry.scope == ChromeScope::Platform && entry.is_default_global)
            {
                return None;
            }
            let broken_default = state.broken.values().find(|entry| {
                entry.chrome_type == chrome_type
                    && if default_scope == ChromeScope::Merchant {
                        entry.is_default_for_merchant || entry.is_default_global
                    } else {
                        entry.is_default_global
                    }
            });
            return Some(ChromeDependency::blocked(
                if broken_default.is_some() {
                    "REPORT_CHROME_NEEDS_MIGRATION"
                } else {
                    "REPORT_CHROME_DEFAULT_MISSING"
                },
                if broken_default.is_some() {
                    format!(
                        "The default {} chrome needs migration.",
                        chrome_type.to_lowercase()
                    )
                } else {
                    format!(
                        "No published default {} chrome is configured.",
                        chrome_type.to_lowercase()
                    )
                },
                broken_default.map(|entry| entry.code.clone()),
            ));
        }
        None
    };
    if let Some(dependency) = check("HEADER", mode("header_mode"), code("header_chrome_code")) {
        return dependency;
    }
    if let Some(dependency) = check("FOOTER", mode("footer_mode"), code("footer_chrome_code")) {
        return dependency;
    }
    ChromeDependency::ready()
}

// ---------------------------------------------------------------------------------------------
// Transcripts and migration prompts
// ---------------------------------------------------------------------------------------------

fn generated_at_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn transcript_markdown(assets_enabled: bool) -> String {
    let template = if assets_enabled {
        TRANSCRIPT_ASSETS
    } else {
        TRANSCRIPT_NO_ASSETS
    };
    template.replace(TEMPLATE_GENERATED_AT, &generated_at_iso())
}

fn chrome_transcript_markdown() -> String {
    TRANSCRIPT_CHROME.replace(TEMPLATE_GENERATED_AT, &generated_at_iso())
}

fn compatibility_text(compatibility: &Value, key: &str) -> String {
    compatibility
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| "unknown".to_owned())
}

fn render_compatibility(compatibility: &Value) -> Vec<String> {
    let status = compatibility
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("UNKNOWN")
        .to_owned();
    let reason = compatibility
        .get("reasonCode")
        .and_then(Value::as_str)
        .unwrap_or("UNKNOWN")
        .to_owned();
    let message = compatibility
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let mut lines = vec![
        "### Compatibility Finding".to_owned(),
        format!("Status: {status}"),
        format!("Reason: {reason}"),
        format!("Message: {message}"),
        format!(
            "Stored engine version: {}",
            compatibility_text(compatibility, "storedEngineVersion")
        ),
        format!(
            "Stored spec version: {}",
            compatibility_text(compatibility, "storedSpecVersion")
        ),
    ];
    if let Some(issues) = compatibility.get("issues").and_then(Value::as_array) {
        if !issues.is_empty() {
            lines.push("Issues:".to_owned());
            for issue in issues {
                let code = issue
                    .get("code")
                    .and_then(Value::as_str)
                    .unwrap_or("UNKNOWN");
                let path = issue
                    .get("path")
                    .and_then(Value::as_str)
                    .unwrap_or("<root>");
                let message = issue
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                lines.push(format!("- [{code}] {path}: {message}"));
            }
        }
    }
    lines
}

const NO_GUIDE: [&str; 2] = [
    "### Migration Guide",
    "No subject-specific guide is registered for this transition. Use the target transcript and preserve the report semantics exactly.",
];

fn pretty_spec(spec: &Value) -> String {
    serde_json::to_string_pretty(spec).unwrap_or_else(|_| "null".to_owned())
}

fn build_report_migration_prompt(
    code: &str,
    version: i32,
    old_spec: &Value,
    compatibility: &Value,
    transcript: &str,
) -> String {
    let mut lines = vec![
        "# Report Descriptor Migration".to_owned(),
        String::new(),
        format!(
            "You are migrating the stored report `{code}` version {version} to the current Report Engine contract."
        ),
        format!("Target engine version: `{REPORT_ENGINE_VERSION}`"),
        format!("Target report spec version: `{REPORT_SPEC_VERSION}`"),
        format!("Target authoring transcript version: `{REPORT_TRANSCRIPT_VERSION}`"),
        String::new(),
        "Return exactly one complete JSON `REPORT_DESCRIPTOR` object. No markdown fences, no commentary, no partial patch.".to_owned(),
        String::new(),
        "## Rules".to_owned(),
        "- Preserve the report's business meaning, datasets, filters, sections and bilingual intent.".to_owned(),
        "- Preserve `report.code`; `report.version` may stay unchanged because saving creates the next stored version.".to_owned(),
        "- Use only models, columns, relations, operators, transforms, sections, variables and limits from the target transcript.".to_owned(),
        "- Do not invent fields, SQL, external URLs, scripts or secrets.".to_owned(),
        "- Keep `i18n.locales.en` and `i18n.locales.ar` complete.".to_owned(),
        "- Do not author headers/footers inside the report spec. Keep the existing chrome selection mode; chrome is a separate workflow.".to_owned(),
        "- Verify the migrated spec in Merchant Report Studio; it may only use merchant-safe models, inputs and assets.".to_owned(),
        String::new(),
    ];
    lines.extend(render_compatibility(compatibility));
    lines.push(String::new());
    lines.extend(NO_GUIDE.iter().map(|line| (*line).to_owned()));
    lines.extend([
        String::new(),
        "## Original Stored Spec".to_owned(),
        "```json".to_owned(),
        pretty_spec(old_spec),
        "```".to_owned(),
        String::new(),
        "## Target Authoring Transcript".to_owned(),
        transcript.to_owned(),
        String::new(),
        "## Required Output".to_owned(),
        "Return only the migrated JSON object. Before returning, run the target transcript's mandatory self-validation checklist.".to_owned(),
    ]);
    lines.join("\n")
}

fn build_chrome_migration_prompt(
    code: &str,
    version: i32,
    old_spec: &Value,
    compatibility: &Value,
    transcript: &str,
) -> String {
    let mut lines = vec![
        "# Report Header/Footer Migration".to_owned(),
        String::new(),
        format!(
            "You are migrating the stored header/footer `{code}` version {version} to the current Report Engine contract."
        ),
        format!("Target engine version: `{REPORT_ENGINE_VERSION}`"),
        format!("Target chrome spec version: `{REPORT_CHROME_SPEC_VERSION}`"),
        format!("Target chrome transcript version: `{REPORT_CHROME_TRANSCRIPT_VERSION}`"),
        String::new(),
        "Return exactly one complete JSON `REPORT_CHROME` object. No markdown fences, no commentary, no partial patch.".to_owned(),
        String::new(),
        "## Rules".to_owned(),
        "- Preserve the chrome code and chrome type.".to_owned(),
        "- Preserve the intended visual design, height, first-page behaviour and accent/border style.".to_owned(),
        "- Preserve every locale and translation key; `en` and `ar` remain mandatory.".to_owned(),
        "- Use only variables and fields documented in the target chrome transcript.".to_owned(),
        "- Assets must be declared in `required_assets` and referenced as `asset://asset_key`; no external or data URLs.".to_owned(),
        "- Keep `used_variables` exactly in sync with the template.".to_owned(),
        "- If the original chrome had assets, remind the user to re-attach the asset zip when saving the migrated version.".to_owned(),
        "- Verify the migrated chrome in Chrome Studio or Report Branding and save it as a new version.".to_owned(),
        String::new(),
    ];
    lines.extend(render_compatibility(compatibility));
    lines.push(String::new());
    lines.extend(NO_GUIDE.iter().map(|line| (*line).to_owned()));
    lines.extend([
        String::new(),
        "## Original Stored Chrome Spec".to_owned(),
        "```json".to_owned(),
        pretty_spec(old_spec),
        "```".to_owned(),
        String::new(),
        "## Target Chrome Authoring Transcript".to_owned(),
        transcript.to_owned(),
        String::new(),
        "## Required Output".to_owned(),
        "Return only the migrated JSON object. Before returning, run the target transcript's mandatory self-validation checklist.".to_owned(),
    ]);
    lines.join("\n")
}

// ---------------------------------------------------------------------------------------------
// Handlers: transcripts and migration prompts
// ---------------------------------------------------------------------------------------------

/// `GET /internal/merchant/report-engine/studio/transcript`.
pub fn report_transcript<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: ntex::web::types::Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            let (principal, merchant_id) = require_merchant_session(principal)?;
            assert_merchant_authority(principal, &["report_engine:author"])?;
            Ok(merchant_id)
        })();
        let merchant_id = match result {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        let policy = match assert_engine_available(state, merchant_id).await {
            Ok(policy) => policy,
            Err(error) => return error_response(request, error),
        };
        json_ok(&json!({
            "filename": format!("report-engine-ai-transcript-v{REPORT_TRANSCRIPT_VERSION}.md"),
            "contentType": "text/markdown",
            "markdown": transcript_markdown(policy.assets_enabled),
            "specVersion": REPORT_SPEC_VERSION,
        }))
    })
}

/// `GET /internal/merchant/report-engine/studio/chrome/transcript`.
pub fn chrome_transcript<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: ntex::web::types::Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            let (principal, merchant_id) = require_merchant_session(principal)?;
            assert_merchant_authority(principal, &["report_engine:author"])?;
            Ok(merchant_id)
        })();
        let merchant_id = match result {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        let policy = match assert_engine_available(state, merchant_id).await {
            Ok(policy) => policy,
            Err(error) => return error_response(request, error),
        };
        json_ok(&json!({
            "filename": format!("chrome-engine-ai-transcript-v{REPORT_CHROME_TRANSCRIPT_VERSION}.md"),
            "contentType": "text/markdown",
            "markdown": chrome_transcript_markdown(),
            "specVersion": REPORT_CHROME_SPEC_VERSION,
            "engineVersion": REPORT_ENGINE_VERSION,
            "transcriptVersion": REPORT_CHROME_TRANSCRIPT_VERSION,
            "assetsEnabled": policy.assets_enabled,
        }))
    })
}

fn transcript_filename(code: &str, version: i32) -> String {
    format!("migrate-{code}-v{version}-to-engine-{REPORT_ENGINE_VERSION}.md")
}

/// `GET /internal/merchant/report-engine/studio/specs/:id/migration-prompt`.
pub fn report_migration_prompt<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: ntex::web::types::Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            let (principal, merchant_id) = require_merchant_session(principal)?;
            assert_merchant_authority(principal, &["report_engine:author"])?;
            let id = path_uuid(
                request,
                6,
                "MERCHANT_REPORT_SPEC_NOT_FOUND",
                "The report spec does not exist",
            )?;
            Ok((merchant_id, id))
        })();
        let (merchant_id, id) = match result {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        let policy = match assert_engine_available(state, merchant_id).await {
            Ok(policy) => policy,
            Err(error) => return error_response(request, error),
        };
        let row = sqlx::query(
            "SELECT id, code, version, engine_version, spec_schema_version, spec_json \
               FROM merchant_report_specs WHERE id = $1 AND merchant_id = $2",
        )
        .bind(id)
        .bind(merchant_id)
        .fetch_optional(&state.pools.main)
        .await;
        let row = match row {
            Ok(Some(row)) => row,
            Ok(None) => {
                return error_response(
                    request,
                    ApiError::new(
                        404,
                        "MERCHANT_REPORT_SPEC_NOT_FOUND",
                        "The report spec does not exist",
                    ),
                )
            }
            Err(error) => return error_response(request, database_error(error)),
        };
        let code: String = row.get("code");
        let version: i32 = row.get("version");
        let spec_json: Value = row.try_get("spec_json").unwrap_or(Value::Null);
        let compatibility = report_compatibility(
            &spec_json,
            row.try_get::<Option<String>, _>("engine_version")
                .unwrap_or(None)
                .as_deref(),
            row.try_get::<Option<String>, _>("spec_schema_version")
                .unwrap_or(None)
                .as_deref(),
        );
        if compatibility["status"] == "COMPATIBLE" {
            return error_response(
                request,
                ApiError::new(
                    409,
                    "MERCHANT_REPORT_SPEC_NOT_MIGRATABLE",
                    "This report spec does not need migration",
                ),
            );
        }
        let transcript = transcript_markdown(policy.assets_enabled);
        let prompt =
            build_report_migration_prompt(&code, version, &spec_json, &compatibility, &transcript);
        json_ok(&json!({
            "filename": transcript_filename(&code, version),
            "prompt": prompt,
            "compatibility": compatibility,
            "target": {
                "engineVersion": REPORT_ENGINE_VERSION,
                "specVersion": REPORT_SPEC_VERSION,
                "transcriptVersion": REPORT_TRANSCRIPT_VERSION,
            },
        }))
    })
}

/// `GET /internal/merchant/report-engine/studio/chrome/:id/migration-prompt`.
pub fn chrome_migration_prompt<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: ntex::web::types::Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            let (principal, merchant_id) = require_merchant_session(principal)?;
            assert_merchant_authority(principal, &["report_engine:author"])?;
            let id = path_uuid(
                request,
                6,
                "MERCHANT_REPORT_CHROME_NOT_FOUND",
                "The header/footer does not exist",
            )?;
            Ok((merchant_id, id))
        })();
        let (merchant_id, id) = match result {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        let row = sqlx::query(
            "SELECT id, code, version, engine_version, spec_schema_version, spec_json \
               FROM merchant_report_chrome_specs WHERE id = $1 AND merchant_id = $2",
        )
        .bind(id)
        .bind(merchant_id)
        .fetch_optional(&state.pools.main)
        .await;
        let row = match row {
            Ok(Some(row)) => row,
            Ok(None) => {
                return error_response(
                    request,
                    ApiError::new(
                        404,
                        "MERCHANT_REPORT_CHROME_NOT_FOUND",
                        "The header/footer does not exist",
                    ),
                )
            }
            Err(error) => return error_response(request, database_error(error)),
        };
        let code: String = row.get("code");
        let version: i32 = row.get("version");
        let spec_json: Value = row.try_get("spec_json").unwrap_or(Value::Null);
        let compatibility = chrome_compatibility(
            &spec_json,
            row.try_get::<Option<String>, _>("engine_version")
                .unwrap_or(None)
                .as_deref(),
            row.try_get::<Option<String>, _>("spec_schema_version")
                .unwrap_or(None)
                .as_deref(),
        );
        if compatibility["status"] == "COMPATIBLE" {
            return error_response(
                request,
                ApiError::new(
                    409,
                    "MERCHANT_REPORT_CHROME_NOT_MIGRATABLE",
                    "This header/footer does not need migration",
                ),
            );
        }
        let transcript = chrome_transcript_markdown();
        let prompt =
            build_chrome_migration_prompt(&code, version, &spec_json, &compatibility, &transcript);
        json_ok(&json!({
            "filename": transcript_filename(&code, version),
            "prompt": prompt,
            "compatibility": compatibility,
            "target": {
                "engineVersion": REPORT_ENGINE_VERSION,
                "specVersion": REPORT_CHROME_SPEC_VERSION,
                "transcriptVersion": REPORT_CHROME_TRANSCRIPT_VERSION,
            },
        }))
    })
}

// ---------------------------------------------------------------------------------------------
// Autocomplete
// ---------------------------------------------------------------------------------------------

const MERCHANT_SAFE_SOURCES: [&str; 4] = [
    "applications",
    "currencies",
    "payment_links",
    "pos_terminals",
];
const CURRENCIES: [&str; 7] = ["LYD", "USD", "EUR", "GBP", "AED", "TND", "EGP"];

fn like_pattern(query: &str) -> String {
    let mut escaped = String::with_capacity(query.len());
    for ch in query.chars() {
        if matches!(ch, '\\' | '%' | '_') {
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    format!("%{escaped}%")
}

/// `GET /internal/merchant/report-engine/autocomplete/:sourceKey`.
pub fn autocomplete<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: ntex::web::types::Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            let (principal, merchant_id) = require_merchant_session(principal)?;
            assert_merchant_authority(principal, &["report_engine:run"])?;
            let source = path_segment(request, 5).unwrap_or_default().to_owned();
            Ok((principal, merchant_id, source))
        })();
        let (_principal, merchant_id, source) = match result {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        if !MERCHANT_SAFE_SOURCES.contains(&source.as_str()) {
            return error_response(
                request,
                ApiError::new(
                    403,
                    "MERCHANT_AUTOCOMPLETE_SOURCE_NOT_ALLOWED",
                    "This autocomplete source is not available to merchants",
                ),
            );
        }
        let query = query_scalar(request, "q").unwrap_or_default();
        let limit = query_scalar(request, "limit")
            .and_then(|value| value.trim().parse::<i64>().ok())
            .filter(|value| *value != 0)
            .unwrap_or(20)
            .clamp(1, 50);
        let items: Vec<Value> = match source.as_str() {
            "currencies" => {
                let needle = query.trim().to_ascii_uppercase();
                CURRENCIES
                    .iter()
                    .filter(|code| needle.is_empty() || code.contains(&needle))
                    .take(limit as usize)
                    .map(|code| json!({ "value": code, "label": code }))
                    .collect()
            }
            "applications" => {
                let rows = sqlx::query(
                    "SELECT id, name FROM applications \
                      WHERE merchant_id = $1 AND name ILIKE $2 ESCAPE '\\' \
                      ORDER BY name LIMIT $3",
                )
                .bind(merchant_id)
                .bind(like_pattern(&query))
                .bind(limit)
                .fetch_all(&state.pools.main)
                .await;
                match rows {
                    Ok(rows) => rows
                        .iter()
                        .map(|row| {
                            json!({
                                "value": row.get::<Uuid, _>("id"),
                                "label": row.get::<String, _>("name"),
                            })
                        })
                        .collect(),
                    Err(error) => return error_response(request, database_error(error)),
                }
            }
            "payment_links" => {
                let rows = sqlx::query(
                    "SELECT pl.id, pl.key FROM payment_links pl \
                     JOIN applications a ON a.id = pl.application_id \
                      WHERE a.merchant_id = $1 AND pl.key ILIKE $2 ESCAPE '\\' \
                      ORDER BY pl.created_at DESC LIMIT $3",
                )
                .bind(merchant_id)
                .bind(like_pattern(&query))
                .bind(limit)
                .fetch_all(&state.pools.main)
                .await;
                match rows {
                    Ok(rows) => rows
                        .iter()
                        .map(|row| {
                            json!({
                                "value": row.get::<Uuid, _>("id"),
                                "label": row.get::<String, _>("key"),
                            })
                        })
                        .collect(),
                    Err(error) => return error_response(request, database_error(error)),
                }
            }
            "pos_terminals" => {
                let rows = sqlx::query(
                    "SELECT pt.id, pt.name FROM pos_terminals pt \
                     JOIN applications a ON a.id = pt.application_id \
                      WHERE a.merchant_id = $1 AND pt.name ILIKE $2 ESCAPE '\\' \
                      ORDER BY pt.name LIMIT $3",
                )
                .bind(merchant_id)
                .bind(like_pattern(&query))
                .bind(limit)
                .fetch_all(&state.pools.main)
                .await;
                match rows {
                    Ok(rows) => rows
                        .iter()
                        .map(|row| {
                            json!({
                                "value": row.get::<Uuid, _>("id"),
                                "label": row.get::<String, _>("name"),
                            })
                        })
                        .collect(),
                    Err(error) => return error_response(request, database_error(error)),
                }
            }
            _ => Vec::new(),
        };
        json_ok(&json!({ "items": items }))
    })
}

// ---------------------------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------------------------

fn merchant_role_allowed(
    authority_mode: Option<&str>,
    allowed_roles: &[String],
    allowed_authorities: &[String],
    role: &str,
    authorities: &BTreeSet<String>,
) -> bool {
    if authority_mode != Some("SECURITY_ADMIN_OVERRIDE") {
        return true;
    }
    allowed_roles.iter().any(|entry| entry == role)
        || allowed_authorities
            .iter()
            .any(|authority| authorities.contains(authority))
}

fn report_entry(
    row: &sqlx::postgres::PgRow,
    spec: &Value,
    source: &str,
    audience_scope: Option<String>,
    merchant_id: Uuid,
) -> Value {
    json!({
        "id": row.get::<Uuid, _>("id"),
        "code": row.get::<String, _>("code"),
        "version": row.get::<i32, _>("version"),
        "category": row.get::<String, _>("category"),
        "audienceScope": audience_scope
            .unwrap_or_else(|| row.get::<String, _>("audience_scope")),
        "supportedLocales": row
            .try_get::<Vec<String>, _>("supported_locales")
            .unwrap_or_default(),
        "defaultLocale": row.get::<String, _>("default_locale"),
        "spec": merchant_safe_spec(spec),
        "updatedAt": super::iso_timestamptz(row.try_get("updated_at").unwrap_or(None)),
        "source": source,
        "merchantId": merchant_id,
    })
}

/// `GET /internal/merchant/report-engine/catalog`.
pub fn catalog<'a>(
    state: &'a AppState,
    request: &'a HttpRequest,
    principal: Option<&'a Principal>,
    _payload: ntex::web::types::Payload,
) -> HandlerFuture<'a> {
    Box::pin(async move {
        let result = (|| {
            let (principal, merchant_id) = require_merchant_session(principal)?;
            assert_merchant_authority(principal, &["report_engine:run"])?;
            Ok((principal, merchant_id))
        })();
        let (principal, merchant_id) = match result {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        let policy = match assert_engine_available(state, merchant_id).await {
            Ok(policy) => policy,
            Err(error) => return error_response(request, error),
        };
        let page = positive_int(query_scalar(request, "page").as_deref(), 1, u32::MAX);
        let page_size = positive_int(query_scalar(request, "pageSize").as_deref(), 20, 200);
        let search = query_scalar(request, "search")
            .unwrap_or_default()
            .trim()
            .to_owned();
        let sort_key = query_scalar(request, "sortKey").unwrap_or_default();
        let sort_direction = if query_scalar(request, "sortDirection").as_deref() == Some("asc") {
            "ASC"
        } else {
            "DESC"
        };
        let order = match sort_key.as_str() {
            "version" => format!("version {sort_direction}"),
            "category" => format!("category {sort_direction}"),
            "report" => format!("code {sort_direction}"),
            _ => format!("updated_at {sort_direction}"),
        };
        let pattern = like_pattern(&search);
        let mut template_sql = String::from(
            "SELECT id, code, version, category, audience_scope::text AS audience_scope, \
                    supported_locales, default_locale, spec_json, updated_at, \
                    authority_mode::text AS authority_mode, override_allowed_roles, \
                    override_allowed_authorities, requires_confidential_aml, engine_version, \
                    spec_schema_version \
               FROM report_definition_specs \
              WHERE status = 'PUBLISHED' AND is_latest_published \
                AND audience_scope IN ('MERCHANT_FACING', 'BOTH') \
                AND requires_confidential_aml = false",
        );
        if !search.is_empty() {
            template_sql.push_str(" AND (code ILIKE $1 OR category ILIKE $1)");
        }
        template_sql.push_str(&format!(" ORDER BY {order}"));
        let mut template_query = sqlx::query(sqlx::AssertSqlSafe(template_sql));
        if !search.is_empty() {
            template_query = template_query.bind(&pattern);
        }
        let template_rows = match template_query.fetch_all(&state.pools.main).await {
            Ok(rows) => rows,
            Err(error) => return error_response(request, database_error(error)),
        };
        let mut own_sql = String::from(
            "SELECT id, code, version, category, supported_locales, default_locale, spec_json, \
                    updated_at, engine_version, spec_schema_version \
               FROM merchant_report_specs \
              WHERE merchant_id = $1 AND status = 'PUBLISHED' AND is_latest_published",
        );
        if !search.is_empty() {
            own_sql.push_str(" AND (code ILIKE $2 OR category ILIKE $2)");
        }
        own_sql.push_str(" ORDER BY updated_at DESC");
        let mut own_query = sqlx::query(sqlx::AssertSqlSafe(own_sql)).bind(merchant_id);
        if !search.is_empty() {
            own_query = own_query.bind(&pattern);
        }
        let own_rows = match own_query.fetch_all(&state.pools.main).await {
            Ok(rows) => rows,
            Err(error) => return error_response(request, database_error(error)),
        };
        let platform_chrome = match platform_chrome(state).await {
            Ok(value) => value,
            Err(error) => return error_response(request, error),
        };
        let combined_chrome =
            match merchant_chrome(state, merchant_id, platform_chrome.clone()).await {
                Ok(value) => value,
                Err(error) => return error_response(request, error),
            };
        let role = principal.role.as_deref().unwrap_or("MERCHANT_STAFF");
        let authorities = pg_domain_auth::authorities::effective_merchant_authorities(
            &principal.as_merchant_principal(),
        );
        let mut broken_template_specs = 0_i64;
        let mut broken_report_specs = 0_i64;
        let mut blocked_by_chrome = 0_i64;
        let mut own_reports_blocked_by_chrome = 0_i64;
        let mut templates = Vec::new();
        for row in &template_rows {
            let authority_mode: Option<String> = row.try_get("authority_mode").unwrap_or(None);
            let allowed_roles: Vec<String> =
                row.try_get("override_allowed_roles").unwrap_or_default();
            let allowed_authorities: Vec<String> = row
                .try_get("override_allowed_authorities")
                .unwrap_or_default();
            if !merchant_role_allowed(
                authority_mode.as_deref(),
                &allowed_roles,
                &allowed_authorities,
                role,
                &authorities,
            ) {
                continue;
            }
            let spec_json: Value = row.try_get("spec_json").unwrap_or(Value::Null);
            let engine_version: Option<String> = row.try_get("engine_version").unwrap_or(None);
            let spec_version: Option<String> = row.try_get("spec_schema_version").unwrap_or(None);
            let compatibility = report_compatibility(
                &spec_json,
                engine_version.as_deref(),
                spec_version.as_deref(),
            );
            if compatibility["status"] != "COMPATIBLE" {
                broken_template_specs += 1;
                continue;
            }
            let spec: ReportSpec = match serde_json::from_value(spec_json.clone()) {
                Ok(spec) => spec,
                Err(_) => {
                    broken_template_specs += 1;
                    continue;
                }
            };
            let required_assets = spec_json
                .get("required_assets")
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0);
            if !policy.assets_enabled && required_assets > 0 {
                continue;
            }
            if pg_report_engine::validate_merchant_scope(&spec, merchant_catalog())
                .iter()
                .any(|diagnostic| diagnostic.severity == pg_report_engine::Severity::Error)
            {
                continue;
            }
            let spec_bytes = serde_json::to_string(&spec_json)
                .map(|value| value.len())
                .unwrap_or(usize::MAX);
            if !tier_limits_ok(&spec, Some(spec_bytes)) {
                continue;
            }
            let dependency =
                report_chrome_dependency(&spec_json, &platform_chrome, ChromeScope::Platform);
            if !dependency.ready {
                blocked_by_chrome += 1;
                continue;
            }
            templates.push(report_entry(row, &spec_json, "TEMPLATE", None, merchant_id));
        }
        let mut own_reports = Vec::new();
        for row in &own_rows {
            let spec_json: Value = row.try_get("spec_json").unwrap_or(Value::Null);
            let engine_version: Option<String> = row.try_get("engine_version").unwrap_or(None);
            let spec_version: Option<String> = row.try_get("spec_schema_version").unwrap_or(None);
            let compatibility = report_compatibility(
                &spec_json,
                engine_version.as_deref(),
                spec_version.as_deref(),
            );
            if compatibility["status"] != "COMPATIBLE" {
                broken_report_specs += 1;
                continue;
            }
            let spec: ReportSpec = match serde_json::from_value(spec_json.clone()) {
                Ok(spec) => spec,
                Err(_) => {
                    broken_report_specs += 1;
                    continue;
                }
            };
            let required_assets = spec_json
                .get("required_assets")
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0);
            if !policy.assets_enabled && required_assets > 0 {
                continue;
            }
            let spec_bytes = serde_json::to_string(&spec_json)
                .map(|value| value.len())
                .unwrap_or(usize::MAX);
            if !tier_limits_ok(&spec, Some(spec_bytes)) {
                continue;
            }
            let dependency =
                report_chrome_dependency(&spec_json, &combined_chrome, ChromeScope::Merchant);
            if !dependency.ready {
                blocked_by_chrome += 1;
                own_reports_blocked_by_chrome += 1;
                continue;
            }
            own_reports.push(report_entry(
                row,
                &spec_json,
                "OWN",
                Some("MERCHANT_FACING".to_owned()),
                merchant_id,
            ));
        }
        let mut merged = own_reports;
        merged.extend(templates);
        merged.sort_by(|left, right| {
            let left = left.get("code").and_then(Value::as_str).unwrap_or_default();
            let right = right
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or_default();
            left.cmp(right)
        });
        let total = merged.len();
        let start = ((page as usize) - 1) * (page_size as usize);
        let reports: Vec<Value> = merged
            .into_iter()
            .skip(start)
            .take(page_size as usize)
            .collect();
        json_ok(&json!({
            "reports": reports,
            "total": total,
            "health": {
                "brokenReportSpecs": broken_report_specs,
                "brokenTemplateSpecs": broken_template_specs,
                "brokenChromeSpecs": combined_chrome.broken.len(),
                "reportsBlockedByChrome": blocked_by_chrome,
                "ownReportsBlockedByChrome": own_reports_blocked_by_chrome,
                "missingChromeDefaults": 0,
            },
        }))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_snapshot_has_the_six_merchant_models() {
        let names: Vec<&str> = snapshot()
            .models
            .iter()
            .map(|model| model.table_name.as_str())
            .collect();
        assert_eq!(
            names,
            [
                "merchants",
                "applications",
                "wallets",
                "payment_attempts",
                "cashout_requests",
                "rm_merchant_daily_stats"
            ]
        );
        assert!(merchant_catalog().models.contains_key("payment_attempts"));
        assert_eq!(model_date_column("merchants"), Some("created_at"));
        assert_eq!(model_date_column("rm_merchant_daily_stats"), Some("day"));
    }

    #[test]
    fn transcripts_substitute_the_request_timestamp() {
        let markdown = transcript_markdown(true);
        assert!(markdown.starts_with(
            "# Libyan National Payment Gateway — Merchant Report Authoring Transcript (v1.1)"
        ));
        assert!(!markdown.contains(TEMPLATE_GENERATED_AT));
        assert!(markdown.contains("Merchant assets are ENABLED"));
        let markdown = transcript_markdown(false);
        assert!(markdown.contains("Merchant assets are DISABLED"));
        let chrome = chrome_transcript_markdown();
        assert!(chrome.starts_with(
            "# Libyan National Payment Gateway — Merchant Report Branding AI Authoring Transcript (v1.1)"
        ));
        assert!(chrome.contains("## 7. Version Provenance"));
    }

    #[test]
    fn safe_spec_drops_the_query_ast_and_suggested_access() {
        let raw = json!({
            "spec_kind": "REPORT_DESCRIPTOR",
            "report": { "code": "x" },
            "suggested_access": { "roles": ["COMPLIANCE"] },
            "datasets": [{
                "dataset_id": "daily",
                "from_model": "payment_attempts",
                "from_alias": "t0",
                "description": "Daily",
                "select": [
                    { "alias": "volume", "column": "total_charged_amount", "aggregate": "SUM" },
                    { "alias": "label", "column": "status", "format_hint": "ENUM_TRANSLATED", "label_i18n_key": "status" }
                ],
                "joins": [{ "target_model": "wallets", "alias": "w", "relation_name": "wallet" }],
                "window_fields": []
            }],
            "sections": []
        });
        let safe = merchant_safe_spec(&raw);
        assert!(safe.get("suggested_access").is_none());
        let datasets = safe["datasets"].as_array().expect("datasets");
        assert_eq!(datasets[0]["dataset_id"], "daily");
        assert_eq!(datasets[0]["select"][0]["format_hint"], "RAW");
        assert_eq!(datasets[0]["select"][1]["format_hint"], "ENUM_TRANSLATED");
        assert_eq!(datasets[0]["select"][1]["label_i18n_key"], "status");
        assert!(datasets[0].get("joins").is_none());
        assert!(datasets[0].get("from_model").is_none());
    }

    #[test]
    fn tier_limits_enforce_the_merchant_budget() {
        let spec: ReportSpec = serde_json::from_value(json!({
            "spec_kind": "REPORT_DESCRIPTOR",
            "spec_version": "1.0",
            "report": { "code": "x", "audience_scope": "MERCHANT_FACING" },
            "inputs": [{
                "key": "periodRange",
                "type": "daterange",
                "validation": { "max_range_days": 90 }
            }],
            "datasets": [{
                "dataset_id": "daily",
                "from_model": "payment_attempts",
                "select": [{ "alias": "volume", "column": "total_charged_amount", "aggregate": "SUM" }],
                "where": {
                    "kind": "GROUP",
                    "logic": "AND",
                    "conditions": [{
                        "kind": "PREDICATE",
                        "column": "created_at",
                        "op": "between",
                        "binding": { "source": "INPUT", "input_key": "periodRange", "range_bound": "BOTH" }
                    }]
                },
                "limit": 100
            }],
            "sections": [{ "section_id": "kpi", "section_type": "KPI_GRID", "cards": [] }]
        }))
        .expect("spec");
        assert!(tier_limits_ok(&spec, Some(1024)));
        assert!(!tier_limits_ok(&spec, Some(MERCHANT_MAX_SPEC_BYTES + 1)));

        let mut unbounded = spec.clone();
        unbounded.datasets[0].where_filter = None;
        assert!(!tier_limits_ok(&unbounded, None));

        let mut too_wide = spec;
        too_wide.inputs[0]
            .extra
            .entry("validation".to_owned())
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .expect("validation object")
            .insert("max_range_days".to_owned(), json!(93));
        assert!(!tier_limits_ok(&too_wide, None));
    }

    #[test]
    fn chrome_dependency_resolves_merchant_then_platform_defaults() {
        let platform = ChromeState {
            entries: vec![ChromeEntry {
                scope: ChromeScope::Platform,
                code: "platform-header".to_owned(),
                chrome_type: "HEADER".to_owned(),
                is_default_global: true,
                is_default_for_merchant: false,
            }],
            broken: BTreeMap::new(),
        };
        let spec =
            json!({ "page_layout": { "header_mode": "GLOBAL_DEFAULT", "footer_mode": "NONE" } });
        assert!(report_chrome_dependency(&spec, &platform, ChromeScope::Platform).ready);
        let missing_footer = json!({ "page_layout": { "header_mode": "GLOBAL_DEFAULT", "footer_mode": "GLOBAL_DEFAULT" } });
        let dependency =
            report_chrome_dependency(&missing_footer, &platform, ChromeScope::Platform);
        assert!(!dependency.ready);
        assert_eq!(
            dependency.reason_code.as_deref(),
            Some("REPORT_CHROME_DEFAULT_MISSING")
        );
        let specific = json!({
            "page_layout": {
                "header_mode": "SPECIFIC_CHROME_CODE",
                "header_chrome_code": "merchant-header",
                "footer_mode": "NONE"
            }
        });
        let combined = ChromeState {
            entries: vec![ChromeEntry {
                scope: ChromeScope::Merchant,
                code: "merchant-header".to_owned(),
                chrome_type: "HEADER".to_owned(),
                is_default_global: false,
                is_default_for_merchant: true,
            }],
            broken: BTreeMap::new(),
        };
        assert!(report_chrome_dependency(&specific, &combined, ChromeScope::Merchant).ready);
        assert!(
            !report_chrome_dependency(&specific, &combined, ChromeScope::Platform).ready,
            "a merchant code never resolves for a platform template"
        );
    }

    #[test]
    fn migration_prompts_keep_the_ts_sections() {
        let compatibility = json!({
            "status": "NEEDS_MIGRATION",
            "reasonCode": "ENGINE_MAJOR_VERSION_MISMATCH",
            "message": "The report was saved for engine version 2.0.0; this engine is 1.0.0.",
            "storedEngineVersion": "2.0.0",
            "storedSpecVersion": "1.0",
            "issues": [{ "path": "engine_version", "code": "ENGINE_MAJOR_VERSION_MISMATCH", "message": "Engine major 2 is not supported." }],
        });
        let prompt = build_report_migration_prompt(
            "merchant-settlement",
            3,
            &json!({ "spec_kind": "REPORT_DESCRIPTOR" }),
            &compatibility,
            "TRANSCRIPT",
        );
        assert!(prompt.starts_with("# Report Descriptor Migration"));
        assert!(prompt.contains("`merchant-settlement` version 3"));
        assert!(prompt.contains("### Compatibility Finding"));
        assert!(prompt.contains("Reason: ENGINE_MAJOR_VERSION_MISMATCH"));
        assert!(prompt.contains("- [ENGINE_MAJOR_VERSION_MISMATCH] engine_version"));
        assert!(prompt.contains("### Migration Guide"));
        assert!(prompt.contains("## Target Authoring Transcript\nTRANSCRIPT"));
        let prompt = build_chrome_migration_prompt(
            "header",
            1,
            &json!({ "spec_kind": "REPORT_CHROME" }),
            &compatibility,
            "CHROME",
        );
        assert!(prompt.starts_with("# Report Header/Footer Migration"));
        assert!(prompt.contains("## Target Chrome Authoring Transcript\nCHROME"));
    }

    #[test]
    fn autocomplete_like_pattern_escapes_wildcards() {
        assert_eq!(like_pattern("a%b_c\\d"), "%a\\%b\\_c\\\\d%");
        assert_eq!(like_pattern(""), "%%");
    }
}

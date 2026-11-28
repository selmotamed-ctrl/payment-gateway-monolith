//! Layer 1-3 verification: references, model eligibility, merchant isolation, chrome selection
//! and suggested access.
//!
//! Ports:
//! - `core-back/lib/reportEngineSdk/verifier/SpecReferenceValidator.ts` (dataset/field registry,
//!   `UNKNOWN_TRANSFORM_DATASET`, `UNKNOWN_SECTION_DATASET`, `UNKNOWN_SECTION_FIELD`, asset checks)
//! - `core-back/lib/reportEngineSdk/verifier/QuerySafetyAndOptValidator.ts` (`MODEL_NOT_REPORTABLE`)
//! - `core-back/lib/reportEngineSdk/verifier/MerchantScopeValidator.ts` (merchant isolation)
//! - `core-back/lib/reportEngineSdk/verifier/SpecStructuralValidator.ts`
//!   (`UNSUPPORTED_TEMPLATE_TOKEN`)
//! - `core-back/lib/reportEngineSdk/verifier/AuthorityInferenceEngine.ts` (suggested-access
//!   warnings, `SUGGESTED_ACCESS_CONFLICT`, `ZERO_NATURAL_ROLE_INTERSECTION`)
//!
//! The query-safety layer (mandatory date bounds, seq-scan cost, join cardinality) needs
//! PostgreSQL `EXPLAIN` and is therefore P8-T01's executor step, not this pure verifier.

#![forbid(unsafe_code)]

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

use crate::authority::{infer_authorities, is_reportable_model, Catalog, Domain};
use crate::diagnostics::{
    codes, ReportDiagnostic, Severity, LAYER_ASSETS, LAYER_AUTHORITY, LAYER_QUERY, LAYER_STRUCTURE,
};
use crate::limits;
use crate::spec::{
    AudienceScope, DatasetSpec, ReportSpec, SectionSpec, SectionType, TransformOperation,
};

/// Verification knobs.
#[derive(Debug, Clone, Copy, Default)]
pub struct VerificationOptions<'a> {
    /// Published chrome codes. `None` skips the registry membership check (the code is still
    /// required when the mode is `SPECIFIC_CHROME_CODE`); `Some(&[])` means "no chrome exists".
    pub published_chrome_codes: Option<&'a [&'a str]>,
}

/// dataset id → field names (`"*"` marks a data-dependent pivot output).
type FieldRegistry = BTreeMap<String, BTreeSet<String>>;

fn initial_field_registry(spec: &ReportSpec) -> FieldRegistry {
    let mut registry = FieldRegistry::new();
    for dataset in &spec.datasets {
        let mut fields: BTreeSet<String> = dataset
            .select
            .iter()
            .map(|select| select.alias.clone())
            .collect();
        for window in &dataset.window_fields {
            fields.insert(window.alias.clone());
        }
        registry.insert(dataset.dataset_id.clone(), fields);
    }
    registry
}

fn computed_column_owners(spec: &ReportSpec) -> BTreeMap<String, String> {
    let mut owners = BTreeMap::new();
    for transform in &spec.transforms {
        if transform.operation == TransformOperation::ComputeColumn {
            if let (Some(column), Some(dataset)) = (
                transform.output_column.as_deref(),
                transform.target_dataset_id.as_deref(),
            ) {
                owners.insert(column.to_owned(), dataset.to_owned());
            }
        }
    }
    owners
}

fn apply_transform_to_registry(
    transform: &crate::spec::TransformSpec,
    registry: &mut FieldRegistry,
) {
    match transform.operation {
        TransformOperation::ComputeColumn => {
            if let (Some(target), Some(column)) = (
                transform.target_dataset_id.as_deref(),
                transform.output_column.as_deref(),
            ) {
                registry
                    .entry(target.to_owned())
                    .or_default()
                    .insert(column.to_owned());
            }
        }
        TransformOperation::JoinDatasets => {
            let mut fields = BTreeSet::new();
            for dataset in [
                transform.left_dataset_id.as_deref(),
                transform.right_dataset_id.as_deref(),
            ]
            .into_iter()
            .flatten()
            {
                if let Some(existing) = registry.get(dataset) {
                    fields.extend(existing.iter().cloned());
                }
            }
            if let Some(output) = transform.output_dataset_id.as_deref() {
                registry.insert(output.to_owned(), fields);
            }
        }
        TransformOperation::PivotDataset => {
            let mut fields = BTreeSet::new();
            if let Some(row_key) = transform.row_key.as_deref() {
                fields.insert(row_key.to_owned());
            }
            fields.insert("*".to_owned());
            if let Some(output) = transform.output_dataset_id.as_deref() {
                registry.insert(output.to_owned(), fields);
            }
        }
        TransformOperation::CompareWithAsset => {
            let mut fields = transform
                .source_dataset_id
                .as_deref()
                .and_then(|source| registry.get(source).cloned())
                .unwrap_or_default();
            fields.insert("_asset_matched".to_owned());
            fields.insert("_has_discrepancy".to_owned());
            for compare in &transform.compare_fields {
                fields.insert(compare.asset_field.clone());
                if let Some(output) = &compare.output_field {
                    fields.insert(output.clone());
                }
                fields.insert(format!("{}_expected", compare.dataset_field));
                fields.insert(format!("{}_variance", compare.dataset_field));
            }
            if let Some(output) = transform.output_dataset_id.as_deref() {
                registry.insert(output.to_owned(), fields);
            }
        }
        TransformOperation::Unknown => {}
    }
}

fn format_available<'a>(fields: impl Iterator<Item = &'a String>, limit: usize) -> String {
    let mut list: Vec<&str> = fields
        .map(String::as_str)
        .filter(|field| *field != "*")
        .collect();
    list.sort_unstable();
    if list.is_empty() {
        return "(none)".to_owned();
    }
    if list.len() > limit {
        format!("{} … ({} total)", list[..limit].join(", "), list.len())
    } else {
        list.join(", ")
    }
}

fn levenshtein(left: &str, right: &str) -> usize {
    let a: Vec<char> = left.to_lowercase().chars().collect();
    let b: Vec<char> = right.to_lowercase().chars().collect();
    let mut previous: Vec<usize> = (0..=b.len()).collect();
    for (index, character) in a.iter().enumerate() {
        let mut diagonal = previous[0];
        if let Some(first) = previous.first_mut() {
            *first = index + 1;
        }
        for (position, candidate) in b.iter().enumerate() {
            let above = previous[position + 1];
            let cost = usize::from(character != candidate);
            let best = (previous[position + 1] + 1)
                .min(previous[position] + 1)
                .min(diagonal + cost);
            previous[position + 1] = best;
            diagonal = above;
        }
    }
    previous[b.len()]
}

fn closest_match<'a>(value: &str, candidates: impl Iterator<Item = &'a String>) -> Option<&'a str> {
    let mut best: Option<&str> = None;
    let mut best_distance = usize::MAX;
    for candidate in candidates {
        if candidate == "*" || candidate == value {
            continue;
        }
        let distance = levenshtein(value, candidate);
        if distance < best_distance {
            best = Some(candidate);
            best_distance = distance;
        }
    }
    let threshold = std::cmp::max(2, value.chars().count() / 3);
    if best_distance <= threshold {
        best
    } else {
        None
    }
}

fn did_you_mean(suggestion: Option<&str>) -> String {
    suggestion.map_or_else(String::new, |field| format!(" Did you mean \"{field}\"?"))
}

fn dataset_hint(
    registry: &FieldRegistry,
    computed_owners: &BTreeMap<String, String>,
    missing: &str,
) -> String {
    if let Some(owner) = computed_owners.get(missing) {
        return format!(
            "\"{missing}\" is an output_column on dataset \"{owner}\", not a dataset. Set target_dataset_id to \"{owner}\" (COMPUTE_COLUMN does not create datasets)."
        );
    }
    format!(
        "Reference a dataset declared in datasets[] or an earlier transform output.{}",
        did_you_mean(closest_match(missing, registry.keys()))
    )
}

fn check_field(
    registry: &FieldRegistry,
    computed_owners: &BTreeMap<String, String>,
    dataset: &str,
    field: &str,
    path: &str,
    diagnostics: &mut Vec<ReportDiagnostic>,
) {
    let Some(fields) = registry.get(dataset) else {
        diagnostics.push(
            ReportDiagnostic::error(
                LAYER_STRUCTURE,
                path,
                codes::UNKNOWN_SECTION_DATASET,
                format!(
                    "Section references unknown dataset \"{dataset}\". Available datasets and transform outputs: {}.",
                    format_available(registry.keys(), 30)
                ),
            )
            .with_hint(dataset_hint(registry, computed_owners, dataset)),
        );
        return;
    };
    if !fields.contains(field) && !fields.contains("*") {
        diagnostics.push(
            ReportDiagnostic::error(
                LAYER_STRUCTURE,
                path,
                codes::UNKNOWN_SECTION_FIELD,
                format!(
                    "Section field \"{field}\" is not selected or produced by dataset \"{dataset}\". Available fields: {}.",
                    format_available(fields.iter(), 30)
                ),
            )
            .with_hint(format!(
                "Use a select alias, window alias or transform output field from the dataset.{}",
                did_you_mean(closest_match(field, fields.iter()))
            )),
        );
    }
}

/// `{{token}}` occurrences in a report HTML template. Only `{{$t.<key>}}` is supported.
fn unsupported_template_tokens(template: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut rest = template;
    while let Some(open) = rest.find("{{") {
        let after_open = &rest[open + 2..];
        let Some(close) = after_open.find("}}") else {
            break;
        };
        let token = after_open[..close].trim();
        if !token.starts_with("$t.") {
            tokens.push(token.to_owned());
        }
        rest = &after_open[close + 2..];
    }
    tokens
}

fn section_field_references(section: &SectionSpec) -> Vec<(String, String, String)> {
    let mut references = Vec::new();
    let path = format!("sections({})", section.section_id);
    match section.section_type {
        SectionType::KpiGrid => {
            for (index, card) in section.cards.iter().enumerate() {
                references.push((
                    card.dataset_id.clone(),
                    card.value_field.clone(),
                    format!("{path}.cards[{index}].value_field"),
                ));
                if let Some(delta) = card.delta_field.as_deref() {
                    references.push((
                        card.dataset_id.clone(),
                        delta.to_owned(),
                        format!("{path}.cards[{index}].delta_field"),
                    ));
                }
            }
        }
        SectionType::DataTable => {
            if let Some(dataset) = section.dataset_id.as_deref() {
                for (index, column) in section.columns.iter().enumerate() {
                    references.push((
                        dataset.to_owned(),
                        column.field.clone(),
                        format!("{path}.columns[{index}].field"),
                    ));
                }
            }
        }
        SectionType::Chart => {
            if let Some(dataset) = section.dataset_id.as_deref() {
                if let Some(field) = section.x_field.as_deref() {
                    references.push((
                        dataset.to_owned(),
                        field.to_owned(),
                        format!("{path}.x_field"),
                    ));
                }
                for (index, series) in section.series.iter().enumerate() {
                    references.push((
                        dataset.to_owned(),
                        series.field.clone(),
                        format!("{path}.series[{index}].field"),
                    ));
                }
            }
        }
        SectionType::VectorDraw => {
            for (index, node) in section.nodes.iter().enumerate() {
                if let Some(binding) = &node.value_binding {
                    references.push((
                        binding.dataset_id.clone(),
                        binding.field.clone(),
                        format!("{path}.nodes[{index}].value_binding.field"),
                    ));
                }
            }
        }
        SectionType::HtmlTemplate
        | SectionType::ImageBanner
        | SectionType::PageBreak
        | SectionType::Unknown => {}
    }
    references
}

fn validate_assets(spec: &ReportSpec, diagnostics: &mut Vec<ReportDiagnostic>) -> BTreeSet<String> {
    let mut keys = BTreeSet::new();
    for (index, asset) in spec.required_assets().iter().enumerate() {
        if keys.contains(&asset.asset_key) {
            diagnostics.push(
                ReportDiagnostic::error(
                    LAYER_ASSETS,
                    format!("required_assets[{index}].asset_key"),
                    "DUPLICATE_ASSET_KEY",
                    format!(
                        "Asset key \"{}\" is declared more than once.",
                        asset.asset_key
                    ),
                )
                .with_hint("Give every required asset a unique asset_key."),
            );
        }
        keys.insert(asset.asset_key.clone());
        let purpose = asset.purpose.as_deref().unwrap_or_default();
        let mime = asset.mime_type.as_deref().unwrap_or_default();
        if purpose == "COMPARISON_BASELINE_DATA" && !matches!(mime, "application/json" | "text/csv")
        {
            diagnostics.push(
                ReportDiagnostic::error(
                    LAYER_ASSETS,
                    format!("required_assets[{index}]"),
                    "COMPARISON_ASSET_MIME_INVALID",
                    "A comparison baseline must be application/json or text/csv.",
                )
                .with_hint("Use a JSON or CSV comparison asset."),
            );
        }
        if purpose == "VISUAL_IMAGE" && !mime.starts_with("image/") {
            diagnostics.push(
                ReportDiagnostic::error(
                    LAYER_ASSETS,
                    format!("required_assets[{index}]"),
                    "VISUAL_ASSET_MIME_INVALID",
                    "A visual asset must be an image MIME type.",
                )
                .with_hint("Use image/png, image/jpeg, image/webp or image/svg+xml."),
            );
        }
    }
    keys
}

fn validate_inputs(spec: &ReportSpec, catalog: &Catalog, diagnostics: &mut Vec<ReportDiagnostic>) {
    let declared: Vec<&str> = spec.input_keys();
    for (index, input) in spec.inputs.iter().enumerate() {
        if let Some(dependency) = input
            .autocomplete
            .as_ref()
            .and_then(|autocomplete| autocomplete.depends_on_input.as_deref())
        {
            if !declared.contains(&dependency) {
                diagnostics.push(
                    ReportDiagnostic::error(
                        LAYER_STRUCTURE,
                        format!("inputs[{index}].autocomplete.depends_on_input"),
                        "UNKNOWN_INPUT_DEPENDENCY",
                        format!(
                            "Autocomplete dependency \"{dependency}\" is not a declared input."
                        ),
                    )
                    .with_hint("Point depends_on_input at a declared input key."),
                );
            }
        }
        if let Some(autocomplete) = &input.autocomplete {
            if !catalog
                .autocomplete_sources
                .iter()
                .any(|source| source == &autocomplete.source)
            {
                diagnostics.push(
                    ReportDiagnostic::error(
                        LAYER_STRUCTURE,
                        format!("inputs[{index}].autocomplete.source"),
                        "UNKNOWN_AUTOCOMPLETE_SOURCE",
                        format!(
                            "Autocomplete source \"{}\" is not registered by the host.",
                            autocomplete.source
                        ),
                    )
                    .with_hint("Use one of the transcript autocomplete sources."),
                );
            }
        }
    }
}

fn validate_models(spec: &ReportSpec, catalog: &Catalog, diagnostics: &mut Vec<ReportDiagnostic>) {
    for (index, dataset) in spec.datasets.iter().enumerate() {
        let base_path = format!("datasets[{index}]({})", dataset.dataset_id);
        let models = std::iter::once((
            dataset.from_model.as_str(),
            format!("{base_path}.from_model"),
        ))
        .chain(dataset.joins.iter().enumerate().map(|(join_index, join)| {
            (
                join.target_model.as_str(),
                format!("{base_path}.joins[{join_index}].target_model"),
            )
        }));
        for (model_name, path) in models {
            match catalog.model(model_name) {
                None => diagnostics.push(
                    ReportDiagnostic::error(
                        LAYER_QUERY,
                        path,
                        codes::UNKNOWN_MODEL,
                        format!("Model \"{model_name}\" does not exist in the report catalog."),
                    )
                    .with_hint("Use only models listed in the transcript."),
                ),
                Some(model) if !is_reportable_model(&model.table_name) => diagnostics.push(
                    ReportDiagnostic::error(
                        LAYER_QUERY,
                        path,
                        codes::MODEL_NOT_REPORTABLE,
                        format!(
                            "Model \"{model_name}\" (table \"{}\") is engine/operational plumbing and is not reportable.",
                            model.table_name
                        ),
                    )
                    .with_hint("Use a business model listed in the transcript catalog."),
                ),
                Some(_) => {}
            }
        }
    }
}

/// The `where` tree must carry `column = inputKey` on `alias`; an OR branch without it would let
/// a merchant escape its scope.
fn has_scope_predicate(
    where_filter: &Value,
    column: &str,
    dataset: &DatasetSpec,
    alias: &str,
    input_key: &str,
) -> bool {
    let Some(object) = where_filter.as_object() else {
        return false;
    };
    if matches!(object.get("kind").and_then(Value::as_str), Some("GROUP")) {
        let Some(Value::Array(conditions)) = object.get("conditions") else {
            return false;
        };
        let logic = object.get("logic").and_then(Value::as_str).unwrap_or("AND");
        let matches =
            |condition: &Value| has_scope_predicate(condition, column, dataset, alias, input_key);
        return if logic == "AND" {
            conditions.iter().any(matches)
        } else {
            conditions.iter().all(matches)
        };
    }
    let predicate_column = object.get("column").and_then(Value::as_str);
    let predicate_alias = object
        .get("table_alias")
        .and_then(Value::as_str)
        .unwrap_or(dataset.from_alias.as_str());
    let operator = object.get("op").and_then(Value::as_str);
    let binding = object.get("binding").and_then(Value::as_object);
    let binding_source = binding
        .and_then(|binding| binding.get("source"))
        .and_then(Value::as_str);
    let binding_key = binding
        .and_then(|binding| binding.get("input_key"))
        .and_then(Value::as_str);
    predicate_column == Some(column)
        && predicate_alias == alias
        && operator == Some("eq")
        && binding_source == Some("INPUT")
        && binding_key == Some(input_key)
}

/// `MERCHANT_REPORT_AUTOCOMPLETE_SOURCE_KEYS` plus the scope input's own `merchants` source.
fn merchant_safe_sources() -> &'static [&'static str] {
    &[
        "merchants",
        "applications",
        "currencies",
        "payment_links",
        "pos_terminals",
    ]
}

/// `validateMerchantReportScope`.
#[must_use]
pub fn validate_merchant_scope(spec: &ReportSpec, catalog: &Catalog) -> Vec<ReportDiagnostic> {
    let mut diagnostics = Vec::new();
    if !matches!(
        spec.audience(),
        AudienceScope::MerchantFacing | AudienceScope::Both
    ) {
        return diagnostics;
    }
    let Some(scope_key) = spec.merchant_scope_input_key() else {
        diagnostics.push(
            ReportDiagnostic::error(
                LAYER_QUERY,
                "report.merchant_scope_input_key",
                codes::MERCHANT_SCOPE_INPUT_MISSING,
                "A merchant-facing report must declare report.merchant_scope_input_key.",
            )
            .with_hint("Add an entity_autocomplete input bound to the \"merchants\" source and name it here."),
        );
        return diagnostics;
    };
    let Some(scope_input) = spec.inputs.iter().find(|input| input.key == scope_key) else {
        diagnostics.push(
            ReportDiagnostic::error(
                LAYER_QUERY,
                "report.merchant_scope_input_key",
                codes::MERCHANT_SCOPE_INPUT_MISSING,
                "A merchant-facing report must declare report.merchant_scope_input_key.",
            )
            .with_hint("Add an entity_autocomplete input bound to the \"merchants\" source and name it here."),
        );
        return diagnostics;
    };
    if scope_input.input_type != "entity_autocomplete"
        || scope_input
            .autocomplete
            .as_ref()
            .map(|autocomplete| autocomplete.source.as_str())
            != Some("merchants")
    {
        diagnostics.push(
            ReportDiagnostic::error(
                LAYER_QUERY,
                format!("inputs({})", scope_input.key),
                codes::MERCHANT_SCOPE_INPUT_INVALID,
                "The merchant scope input must be an entity_autocomplete bound to the merchants source.",
            )
            .with_hint("Use type \"entity_autocomplete\" with autocomplete.source \"merchants\"."),
        );
    }

    for (index, input) in spec.inputs.iter().enumerate() {
        let Some(autocomplete) = &input.autocomplete else {
            continue;
        };
        if autocomplete.source == "merchants" && input.key != scope_key {
            diagnostics.push(
                ReportDiagnostic::error(
                    LAYER_QUERY,
                    format!("inputs[{index}].autocomplete.source"),
                    codes::MERCHANT_EXTRA_MERCHANT_INPUT_FORBIDDEN,
                    format!("Only the merchant scope input \"{scope_key}\" may use the merchants autocomplete source."),
                )
                .with_hint("Remove the extra merchant input or make the report back-office only."),
            );
        }
        if !merchant_safe_sources().contains(&autocomplete.source.as_str()) {
            diagnostics.push(
                ReportDiagnostic::error(
                    LAYER_QUERY,
                    format!("inputs[{index}].autocomplete.source"),
                    codes::MERCHANT_AUTOCOMPLETE_SOURCE_NOT_ALLOWED,
                    format!(
                        "Autocomplete source \"{}\" is not available to a merchant-facing report.",
                        autocomplete.source
                    ),
                )
                .with_hint("Use the merchant scope input or one of the merchant autocomplete sources listed in the transcript."),
            );
        }
    }

    for (index, dataset) in spec.datasets.iter().enumerate() {
        let base_path = format!("datasets[{index}]({})", dataset.dataset_id);
        let aliases: Vec<(&str, Option<&crate::authority::CatalogModel>)> = std::iter::once((
            dataset.from_alias.as_str(),
            catalog.model(&dataset.from_model),
        ))
        .chain(
            dataset
                .joins
                .iter()
                .map(|join| (join.alias.as_str(), catalog.model(&join.target_model))),
        )
        .collect();
        for (alias, model) in aliases {
            let Some(model) = model else {
                diagnostics.push(
                    ReportDiagnostic::error(
                        LAYER_QUERY,
                        format!("{base_path}.from_model"),
                        codes::UNKNOWN_MODEL,
                        format!(
                            "Model \"{}\" or a joined model does not exist in the report catalog.",
                            dataset.from_model
                        ),
                    )
                    .with_hint("Use only models listed in the transcript."),
                );
                continue;
            };
            if matches!(
                model.domain,
                Domain::ComplianceAml | Domain::SecurityAudit | Domain::Gateways
            ) {
                diagnostics.push(
                    ReportDiagnostic::error(
                        LAYER_QUERY,
                        format!("{base_path}.from_model"),
                        codes::MERCHANT_CONFIDENTIAL_DOMAIN_FORBIDDEN,
                        format!(
                            "Model \"{}\" belongs to {} and cannot appear in a merchant-facing report.",
                            model.model_name,
                            model.domain.as_str()
                        ),
                    )
                    .with_hint("Remove the model or make the report back-office only."),
                );
                continue;
            }
            let Some(scopable) = &model.merchant_scopable else {
                diagnostics.push(
                    ReportDiagnostic::error(
                        LAYER_QUERY,
                        format!("{base_path}.from_model"),
                        codes::MERCHANT_MODEL_OUT_OF_SCOPE,
                        format!(
                            "Model \"{}\" is not merchant-scopable and cannot appear in a merchant-facing report.",
                            model.model_name
                        ),
                    )
                    .with_hint("Remove the model or split the report into a back-office report."),
                );
                continue;
            };
            let scoped = dataset.where_filter.as_ref().is_some_and(|where_filter| {
                has_scope_predicate(
                    where_filter,
                    &scopable.merchant_id_column,
                    dataset,
                    alias,
                    scope_key,
                )
            });
            if !scoped {
                diagnostics.push(
                    ReportDiagnostic::error(
                        LAYER_QUERY,
                        format!("{base_path}.where"),
                        codes::MERCHANT_SCOPE_VIOLATION,
                        format!(
                            "Dataset \"{}\" queries merchant-scopable model \"{}\" without filtering \"{}\" by \"{scope_key}\".",
                            dataset.dataset_id, model.model_name, scopable.merchant_id_column
                        ),
                    )
                    .with_hint(format!(
                        "Add an equality predicate on \"{}\" bound to input \"{scope_key}\".",
                        scopable.merchant_id_column
                    )),
                );
            }
        }
    }

    diagnostics
}

fn validate_suggested_access(
    spec: &ReportSpec,
    catalog: &Catalog,
    diagnostics: &mut Vec<ReportDiagnostic>,
) {
    if let Some(suggested) = &spec.suggested_access {
        for role in &suggested.roles {
            if !catalog.roles.iter().any(|candidate| candidate == role) {
                diagnostics.push(
                    ReportDiagnostic::warning(
                        LAYER_AUTHORITY,
                        "suggested_access.roles",
                        codes::UNKNOWN_SUGGESTED_ROLE,
                        format!("Suggested role \"{role}\" is not in the host roles catalogue."),
                    )
                    .with_hint("Use a role from the transcript."),
                );
            }
        }
        for authority in &suggested.authorities {
            if !catalog
                .authorities
                .iter()
                .any(|candidate| candidate == authority)
            {
                diagnostics.push(
                    ReportDiagnostic::warning(
                        LAYER_AUTHORITY,
                        "suggested_access.authorities",
                        codes::UNKNOWN_SUGGESTED_AUTHORITY,
                        format!("Suggested authority \"{authority}\" is not in the host authorities catalogue."),
                    )
                    .with_hint("Use an authority from the transcript."),
                );
            }
        }
    }

    // The authority inference runs for every report, like the TS Layer 3: a cross-domain report
    // with no common natural role is a warning even when the author suggested nothing.
    let inference = infer_authorities(spec, catalog);
    for detail in &inference.conflict_details {
        let severity = if detail.code == codes::ZERO_NATURAL_ROLE_INTERSECTION {
            Severity::Warning
        } else {
            Severity::Error
        };
        let path = if detail.code == codes::ZERO_NATURAL_ROLE_INTERSECTION {
            "datasets"
        } else {
            "suggested_access"
        };
        let diagnostic = ReportDiagnostic {
            layer: LAYER_AUTHORITY,
            severity,
            path: path.to_owned(),
            code: detail.code.clone(),
            message: detail.message.clone(),
            hint: Some(detail.resolution_hint.clone()),
        };
        diagnostics.push(diagnostic);
    }
}

/// Chrome selection checks: a `SPECIFIC_CHROME_CODE` mode must name an existing published code.
fn validate_chrome(
    spec: &ReportSpec,
    options: &VerificationOptions<'_>,
    diagnostics: &mut Vec<ReportDiagnostic>,
) {
    use crate::spec::ChromeMode;
    let chrome = spec.chrome_selection();
    let checks: [(&str, ChromeMode, Option<&str>); 2] = [
        (
            "page_layout.header",
            chrome.header_mode,
            chrome.header_chrome_code.as_deref(),
        ),
        (
            "page_layout.footer",
            chrome.footer_mode,
            chrome.footer_chrome_code.as_deref(),
        ),
    ];
    for (path, mode, code) in checks {
        if mode != ChromeMode::SpecificChromeCode {
            continue;
        }
        let Some(code) = code else {
            diagnostics.push(
                ReportDiagnostic::error(
                    LAYER_STRUCTURE,
                    format!("{path}_chrome_code"),
                    codes::SPECIFIC_CHROME_CODE,
                    "SPECIFIC_CHROME_CODE requires the chrome code to be named.",
                )
                .with_hint(
                    "Set header_chrome_code / footer_chrome_code to a published chrome code.",
                ),
            );
            continue;
        };
        if let Some(published) = options.published_chrome_codes {
            if !published.contains(&code) {
                diagnostics.push(
                    ReportDiagnostic::error(
                        LAYER_STRUCTURE,
                        format!("{path}_chrome_code"),
                        codes::SPECIFIC_CHROME_CODE,
                        format!("Chrome code \"{code}\" is not published."),
                    )
                    .with_hint("Use a published chrome code, or GLOBAL_DEFAULT / NONE."),
                );
            }
        }
    }
}

/// The full Layer 1-3 pass. Errors block publishing; warnings do not.
#[must_use]
pub fn validate_spec(
    spec: &ReportSpec,
    catalog: &Catalog,
    options: &VerificationOptions<'_>,
) -> Vec<ReportDiagnostic> {
    let mut diagnostics = limits::validate(spec);

    let mut dataset_ids: BTreeSet<&str> = BTreeSet::new();
    for (index, dataset) in spec.datasets.iter().enumerate() {
        if !dataset_ids.insert(dataset.dataset_id.as_str()) {
            diagnostics.push(
                ReportDiagnostic::error(
                    LAYER_STRUCTURE,
                    format!("datasets[{index}].dataset_id"),
                    codes::DUPLICATE_DATASET_ID,
                    format!(
                        "Dataset id \"{}\" is used more than once.",
                        dataset.dataset_id
                    ),
                )
                .with_hint("Give every dataset a unique dataset_id."),
            );
        }
    }

    let asset_keys = validate_assets(spec, &mut diagnostics);
    validate_inputs(spec, catalog, &mut diagnostics);
    validate_models(spec, catalog, &mut diagnostics);

    let mut registry = initial_field_registry(spec);
    let computed_owners = computed_column_owners(spec);
    for (index, transform) in spec.transforms.iter().enumerate() {
        let path = format!("transforms[{index}]");
        for source in transform.source_datasets() {
            if !registry.contains_key(source) {
                diagnostics.push(
                    ReportDiagnostic::error(
                        LAYER_STRUCTURE,
                        &path,
                        codes::UNKNOWN_TRANSFORM_DATASET,
                        format!(
                            "Transform references unknown dataset \"{source}\". Available datasets and transform outputs: {}.",
                            format_available(registry.keys(), 30)
                        ),
                    )
                    .with_hint(dataset_hint(&registry, &computed_owners, source)),
                );
            }
        }
        if transform.operation == TransformOperation::CompareWithAsset {
            if let Some(asset_key) = transform.asset_key.as_deref() {
                if !asset_keys.contains(asset_key) {
                    diagnostics.push(
                        ReportDiagnostic::error(
                            LAYER_ASSETS,
                            format!("{path}.asset_key"),
                            codes::UNKNOWN_COMPARISON_ASSET,
                            format!(
                                "COMPARE_WITH_ASSET references asset \"{asset_key}\", which is not declared in required_assets."
                            ),
                        )
                        .with_hint("Declare the comparison asset in required_assets[]."),
                    );
                }
            }
        }
        apply_transform_to_registry(transform, &mut registry);
    }

    let mut section_ids: BTreeSet<&str> = BTreeSet::new();
    for (index, section) in spec.sections.iter().enumerate() {
        let path = format!("sections[{index}]({})", section.section_id);
        if !section_ids.insert(section.section_id.as_str()) {
            diagnostics.push(
                ReportDiagnostic::error(
                    LAYER_STRUCTURE,
                    format!("{path}.section_id"),
                    codes::DUPLICATE_SECTION_ID,
                    format!(
                        "Section id \"{}\" is used more than once.",
                        section.section_id
                    ),
                )
                .with_hint("Give every section a unique section_id."),
            );
        }
        if let Some(dataset) = section
            .visibility
            .as_ref()
            .and_then(|visibility| visibility.dataset_id.as_deref())
        {
            if !registry.contains_key(dataset) {
                diagnostics.push(
                    ReportDiagnostic::error(
                        LAYER_STRUCTURE,
                        format!("{path}.visibility.dataset_id"),
                        codes::UNKNOWN_VISIBILITY_DATASET,
                        format!(
                            "Visibility references unknown dataset \"{dataset}\". Available datasets and transform outputs: {}.",
                            format_available(registry.keys(), 30)
                        ),
                    )
                    .with_hint(format!(
                        "Use a declared dataset_id or a transform output dataset.{}",
                        did_you_mean(closest_match(dataset, registry.keys()))
                    )),
                );
            }
        }
        for (dataset, field, field_path) in section_field_references(section) {
            check_field(
                &registry,
                &computed_owners,
                &dataset,
                &field,
                &field_path,
                &mut diagnostics,
            );
        }
        if section.section_type == SectionType::HtmlTemplate {
            if let Some(template) = section.html_template.as_deref() {
                for token in unsupported_template_tokens(template) {
                    diagnostics.push(
                        ReportDiagnostic::error(
                            LAYER_STRUCTURE,
                            format!("{path}.html_template"),
                            codes::UNSUPPORTED_TEMPLATE_TOKEN,
                            format!("HTML template token \"{{{{{token}}}}}\" is not supported."),
                        )
                        .with_hint(
                            "Report HTML templates support only {{$t.<translation_key>}} and asset://<asset_key>. Use KPI_GRID, DATA_TABLE or CHART for dataset values.",
                        ),
                    );
                }
            }
        }
        if section.section_type == SectionType::ImageBanner {
            if let Some(asset_key) = section.asset_key.as_deref() {
                if !asset_keys.contains(asset_key) {
                    diagnostics.push(
                        ReportDiagnostic::error(
                            LAYER_ASSETS,
                            format!("{path}.asset_key"),
                            codes::UNKNOWN_IMAGE_ASSET,
                            format!("Image banner references undeclared asset \"{asset_key}\"."),
                        )
                        .with_hint("Declare the image in required_assets[]."),
                    );
                }
            }
        }
    }

    validate_chrome(spec, options, &mut diagnostics);
    diagnostics.extend(validate_merchant_scope(spec, catalog));
    validate_suggested_access(spec, catalog, &mut diagnostics);
    diagnostics
}

/// [`validate_spec`] with no chrome registry.
#[must_use]
pub fn validate_spec_defaults(spec: &ReportSpec, catalog: &Catalog) -> Vec<ReportDiagnostic> {
    validate_spec(spec, catalog, &VerificationOptions::default())
}

/// True when at least one diagnostic is an error.
#[must_use]
pub fn has_errors(diagnostics: &[ReportDiagnostic]) -> bool {
    diagnostics.iter().any(ReportDiagnostic::is_error)
}

/// The runtime merchant scope guard (`ReportMerchantScopeViolationError`, code
/// `MERCHANT_SCOPE_VIOLATION`). The merchant API calls this at execution so a legacy row cannot
/// bypass the publish-time check.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct MerchantScopeViolation {
    pub message: String,
}

impl MerchantScopeViolation {
    /// The API error code.
    pub const CODE: &'static str = "MERCHANT_SCOPE_VIOLATION";

    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

/// Verifies that a merchant-facing spec is fully isolated before execution.
///
/// # Errors
/// Returns [`MerchantScopeViolation`] when the scope input is missing/invalid or a
/// merchant-scopable model is not filtered by it.
pub fn verify_merchant_scope(
    spec: &ReportSpec,
    catalog: &Catalog,
) -> Result<(), MerchantScopeViolation> {
    let diagnostics = validate_merchant_scope(spec, catalog);
    match diagnostics.into_iter().find(ReportDiagnostic::is_error) {
        Some(diagnostic) => Err(MerchantScopeViolation::new(diagnostic.message)),
        None => Ok(()),
    }
}

/// Convenience: the diagnostic codes this pass can emit for a spec.
#[must_use]
pub fn diagnostic_codes(diagnostics: &[ReportDiagnostic]) -> Vec<&str> {
    diagnostics
        .iter()
        .map(|diagnostic| diagnostic.code.as_str())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authority::{CatalogColumn, CatalogModel, Sensitivity};
    use serde_json::json;

    fn catalog() -> Catalog {
        let mut attempts =
            CatalogModel::new("paymentAttempt", "payment_attempts", Domain::Payments);
        for column in ["reference", "total_charged_amount", "merchant_id"] {
            attempts.columns.insert(
                column.to_owned(),
                CatalogColumn::new(column, Sensitivity::Internal),
            );
        }
        attempts.required_authorities = vec!["merchant:read".to_owned()];
        attempts.natural_roles = vec!["OPS".to_owned(), "COMPLIANCE".to_owned()];
        attempts.merchant_scopable = Some(crate::authority::MerchantScopable::new("merchant_id"));

        let mut flows = CatalogModel::new("flows", "flows", Domain::Gateways);
        flows.columns.insert(
            "id".to_owned(),
            CatalogColumn::new("id", Sensitivity::Internal),
        );
        flows.required_authorities = vec!["gateway:read".to_owned()];
        flows.natural_roles = vec!["SECURITY_ADMIN".to_owned()];

        Catalog::new()
            .with_model(attempts)
            .with_model(flows)
            .with_roles(["OPS", "COMPLIANCE"])
            .with_authorities(["merchant:read", "gateway:read"])
            .with_autocomplete_sources([
                "merchants",
                "applications",
                "currencies",
                "payment_links",
                "pos_terminals",
            ])
    }

    fn spec(value: serde_json::Value) -> ReportSpec {
        serde_json::from_value(value).expect("spec fixture")
    }

    fn codes_of(diagnostics: &[ReportDiagnostic]) -> Vec<String> {
        diagnostics
            .iter()
            .map(|diagnostic| diagnostic.code.clone())
            .collect()
    }

    #[test]
    fn unknown_transform_dataset_points_at_the_compute_column_owner() {
        let spec = spec(json!({
            "datasets": [{"dataset_id": "daily", "from_model": "paymentAttempt", "select": [{"alias": "volume", "column": "total_charged_amount"}]}],
            "transforms": [
                {"operation": "COMPUTE_COLUMN", "target_dataset_id": "daily", "output_column": "share", "formula": "PERCENTAGE_SHARE", "left_operand": "volume"},
                {"operation": "COMPUTE_COLUMN", "target_dataset_id": "share", "output_column": "x", "formula": "ADD", "left_operand": "share", "right_operand": "volume"}
            ],
            "sections": [{"section_id": "kpis", "section_type": "KPI_GRID", "cards": [{"dataset_id": "daily", "value_field": "share"}]}]
        }));
        let diagnostics = validate_spec_defaults(&spec, &catalog());
        let unknown = diagnostics
            .iter()
            .find(|diagnostic| diagnostic.code == codes::UNKNOWN_TRANSFORM_DATASET)
            .expect("unknown transform dataset");
        assert_eq!(unknown.path, "transforms[1]");
        assert!(unknown
            .hint
            .as_deref()
            .unwrap_or_default()
            .contains("output_column on dataset \"daily\""));
    }

    #[test]
    fn unknown_section_field_suggests_the_closest_alias() {
        let spec = spec(json!({
            "datasets": [{"dataset_id": "daily", "from_model": "paymentAttempt", "select": [{"alias": "volume", "column": "total_charged_amount"}, {"alias": "attemptCount", "column": "reference"}]}],
            "sections": [{"section_id": "table", "section_type": "DATA_TABLE", "dataset_id": "daily", "columns": [{"field": "volum", "header_i18n_key": "h"}, {"field": "attemptCount", "header_i18n_key": "h2"}]}]
        }));
        let diagnostics = validate_spec_defaults(&spec, &catalog());
        let unknown = diagnostics
            .iter()
            .find(|diagnostic| diagnostic.code == codes::UNKNOWN_SECTION_FIELD)
            .expect("unknown field");
        assert!(unknown
            .message
            .contains("Available fields: attemptCount, volume."));
        assert!(unknown
            .hint
            .as_deref()
            .unwrap_or_default()
            .contains("Did you mean \"volume\"?"));
    }

    #[test]
    fn unknown_section_dataset_is_reported() {
        let spec = spec(json!({
            "datasets": [{"dataset_id": "daily", "from_model": "paymentAttempt", "select": [{"alias": "volume", "column": "total_charged_amount"}]}],
            "sections": [{"section_id": "table", "section_type": "DATA_TABLE", "dataset_id": "weekly", "columns": [{"field": "volume", "header_i18n_key": "h"}]}]
        }));
        let diagnostics = validate_spec_defaults(&spec, &catalog());
        assert!(codes_of(&diagnostics).contains(&codes::UNKNOWN_SECTION_DATASET.to_owned()));
    }

    #[test]
    fn engine_plumbing_models_are_not_reportable() {
        let spec = spec(json!({
            "datasets": [{"dataset_id": "f", "from_model": "flows", "select": [{"alias": "id", "column": "id"}]}],
            "sections": [{"section_id": "t", "section_type": "DATA_TABLE", "dataset_id": "f", "columns": [{"field": "id", "header_i18n_key": "h"}]}]
        }));
        let diagnostics = validate_spec_defaults(&spec, &catalog());
        let not_reportable = diagnostics
            .iter()
            .find(|diagnostic| diagnostic.code == codes::MODEL_NOT_REPORTABLE)
            .expect("model not reportable");
        assert!(not_reportable.message.contains("flows"));
    }

    #[test]
    fn html_templates_only_allow_translation_tokens() {
        let spec = spec(json!({
            "datasets": [{"dataset_id": "daily", "from_model": "paymentAttempt", "select": [{"alias": "volume", "column": "total_charged_amount"}]}],
            "sections": [{
                "section_id": "note",
                "section_type": "HTML_TEMPLATE",
                "html_template": "<p>{{$t.note.title}} {{volume}} <img src=\"asset://logo\"></p>"
            }]
        }));
        let diagnostics = validate_spec_defaults(&spec, &catalog());
        let tokens: Vec<&ReportDiagnostic> = diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.code == codes::UNSUPPORTED_TEMPLATE_TOKEN)
            .collect();
        assert_eq!(tokens.len(), 1);
        assert!(tokens[0].message.contains("{{volume}}"));
    }

    #[test]
    fn chrome_specific_code_requires_a_published_code() {
        let spec = spec(json!({
            "page_layout": {"header_mode": "SPECIFIC_CHROME_CODE", "header_chrome_code": "brand-header"},
            "datasets": [{"dataset_id": "daily", "from_model": "paymentAttempt", "select": [{"alias": "volume", "column": "total_charged_amount"}]}],
            "sections": [{"section_id": "t", "section_type": "DATA_TABLE", "dataset_id": "daily", "columns": [{"field": "volume", "header_i18n_key": "h"}]}]
        }));
        let published = ["other-header"];
        let options = VerificationOptions {
            published_chrome_codes: Some(&published),
        };
        let diagnostics = validate_spec(&spec, &catalog(), &options);
        assert!(codes_of(&diagnostics).contains(&codes::SPECIFIC_CHROME_CODE.to_owned()));

        let published = ["brand-header"];
        let options = VerificationOptions {
            published_chrome_codes: Some(&published),
        };
        assert!(!codes_of(&validate_spec(&spec, &catalog(), &options))
            .contains(&codes::SPECIFIC_CHROME_CODE.to_owned()));
    }

    fn merchant_spec(where_filter: serde_json::Value) -> ReportSpec {
        spec(json!({
            "report": {"code": "merchant-daily", "audience_scope": "MERCHANT_FACING", "merchant_scope_input_key": "merchantId"},
            "inputs": [{"key": "merchantId", "type": "entity_autocomplete", "autocomplete": {"source": "merchants"}}],
            "datasets": [{
                "dataset_id": "daily",
                "from_model": "paymentAttempt",
                "select": [{"alias": "volume", "column": "total_charged_amount"}],
                "where": where_filter
            }],
            "sections": [{"section_id": "t", "section_type": "DATA_TABLE", "dataset_id": "daily", "columns": [{"field": "volume", "header_i18n_key": "h"}]}]
        }))
    }

    #[test]
    fn a_merchant_report_without_the_scope_predicate_is_rejected() {
        let spec = merchant_spec(json!({"kind": "PREDICATE", "column": "reference", "op": "eq"}));
        let diagnostics = validate_merchant_scope(&spec, &catalog());
        assert!(codes_of(&diagnostics).contains(&codes::MERCHANT_SCOPE_VIOLATION.to_owned()));
        let error = verify_merchant_scope(&spec, &catalog()).expect_err("scope violation");
        assert_eq!(MerchantScopeViolation::CODE, "MERCHANT_SCOPE_VIOLATION");
        assert!(error.message.contains("merchant_id"));
    }

    #[test]
    fn the_scope_predicate_must_be_on_every_or_branch() {
        let escaping = merchant_spec(json!({
            "kind": "GROUP",
            "logic": "OR",
            "conditions": [
                {"kind": "PREDICATE", "column": "merchant_id", "op": "eq", "binding": {"source": "INPUT", "input_key": "merchantId"}},
                {"kind": "PREDICATE", "column": "reference", "op": "eq"}
            ]
        }));
        assert!(codes_of(&validate_merchant_scope(&escaping, &catalog()))
            .contains(&codes::MERCHANT_SCOPE_VIOLATION.to_owned()));

        let safe = merchant_spec(json!({
            "kind": "GROUP",
            "logic": "OR",
            "conditions": [
                {"kind": "PREDICATE", "column": "merchant_id", "op": "eq", "binding": {"source": "INPUT", "input_key": "merchantId"}},
                {"kind": "GROUP", "logic": "AND", "conditions": [
                    {"kind": "PREDICATE", "column": "merchant_id", "op": "eq", "binding": {"source": "INPUT", "input_key": "merchantId"}},
                    {"kind": "PREDICATE", "column": "reference", "op": "eq"}
                ]}
            ]
        }));
        assert!(validate_merchant_scope(&safe, &catalog()).is_empty());
        assert!(verify_merchant_scope(&safe, &catalog()).is_ok());
    }

    #[test]
    fn a_merchant_report_needs_the_scope_input() {
        let spec = spec(json!({
            "report": {"code": "merchant-daily", "audience_scope": "MERCHANT_FACING"},
            "datasets": [{"dataset_id": "daily", "from_model": "paymentAttempt", "select": [{"alias": "volume", "column": "total_charged_amount"}]}],
            "sections": [{"section_id": "t", "section_type": "DATA_TABLE", "dataset_id": "daily", "columns": [{"field": "volume", "header_i18n_key": "h"}]}]
        }));
        let diagnostics = validate_merchant_scope(&spec, &catalog());
        assert_eq!(diagnostics[0].code, codes::MERCHANT_SCOPE_INPUT_MISSING);
    }

    #[test]
    fn suggested_access_conflicts_and_unknown_catalogues_are_reported() {
        let mut value = serde_json::to_value(merchant_spec(json!({
            "kind": "PREDICATE",
            "column": "merchant_id",
            "op": "eq",
            "binding": {"source": "INPUT", "input_key": "merchantId"}
        })))
        .expect("serialises");
        if let Some(object) = value.as_object_mut() {
            object.insert(
                "suggested_access".to_owned(),
                json!({"roles": ["MLRO"], "authorities": ["aml:read"]}),
            );
        }
        let spec: ReportSpec = serde_json::from_value(value).expect("spec");
        let diagnostics = validate_spec_defaults(&spec, &catalog());
        let codes = codes_of(&diagnostics);
        assert!(codes.contains(&codes::UNKNOWN_SUGGESTED_ROLE.to_owned()));
        assert!(codes.contains(&codes::UNKNOWN_SUGGESTED_AUTHORITY.to_owned()));
        assert!(codes.contains(&codes::SUGGESTED_ACCESS_CONFLICT.to_owned()));
        assert!(codes.contains(&codes::SUGGESTED_AUTHORITY_NOT_REQUIRED.to_owned()));
    }

    #[test]
    fn zero_natural_role_intersection_is_a_warning() {
        let mut flows = catalog();
        if let Some(model) = flows.models.get_mut("flows") {
            model.natural_roles = vec!["SECURITY_ADMIN".to_owned()];
        }
        let spec = spec(json!({
            "datasets": [
                {"dataset_id": "daily", "from_model": "paymentAttempt", "select": [{"alias": "volume", "column": "total_charged_amount"}]},
                {"dataset_id": "f", "from_model": "flows", "select": [{"alias": "id", "column": "id"}]}
            ],
            "sections": [{"section_id": "t", "section_type": "DATA_TABLE", "dataset_id": "daily", "columns": [{"field": "volume", "header_i18n_key": "h"}]}]
        }));
        let diagnostics = validate_spec_defaults(&spec, &flows);
        let zero = diagnostics
            .iter()
            .find(|diagnostic| diagnostic.code == codes::ZERO_NATURAL_ROLE_INTERSECTION)
            .expect("zero intersection");
        assert_eq!(zero.severity, Severity::Warning);
        assert!(!has_errors(std::slice::from_ref(zero)));
        // The flows dataset is also not reportable, which is an error.
        assert!(has_errors(&diagnostics));
    }

    #[test]
    fn a_clean_back_office_spec_has_no_diagnostics() {
        let spec = spec(json!({
            "report": {"code": "ops-daily", "audience_scope": "BACKOFFICE_INTERNAL"},
            "datasets": [{
                "dataset_id": "daily",
                "from_model": "paymentAttempt",
                "select": [{"alias": "volume", "column": "total_charged_amount"}],
                "where": {"kind": "PREDICATE", "column": "reference", "op": "eq"}
            }],
            "sections": [{"section_id": "table", "section_type": "DATA_TABLE", "subtitle_i18n_key": "s", "dataset_id": "daily", "columns": [{"field": "volume", "header_i18n_key": "h"}]}]
        }));
        let diagnostics = validate_spec_defaults(&spec, &catalog());
        assert!(diagnostics.is_empty(), "unexpected: {diagnostics:?}");
    }

    #[test]
    fn duplicate_ids_and_assets_are_reported() {
        let spec = spec(json!({
            "datasets": [
                {"dataset_id": "daily", "from_model": "paymentAttempt", "select": [{"alias": "volume", "column": "total_charged_amount"}]},
                {"dataset_id": "daily", "from_model": "paymentAttempt", "select": [{"alias": "volume", "column": "total_charged_amount"}]}
            ],
            "required_assets": [
                {"asset_key": "logo", "mime_type": "image/png", "purpose": "VISUAL_IMAGE"},
                {"asset_key": "logo", "mime_type": "text/csv", "purpose": "COMPARISON_BASELINE_DATA"}
            ],
            "sections": [
                {"section_id": "t", "section_type": "DATA_TABLE", "dataset_id": "daily", "columns": [{"field": "volume", "header_i18n_key": "h"}]},
                {"section_id": "t", "section_type": "PAGE_BREAK"}
            ]
        }));
        let codes = codes_of(&validate_spec_defaults(&spec, &catalog()));
        assert!(codes.contains(&"DUPLICATE_DATASET_ID".to_owned()));
        assert!(codes.contains(&"DUPLICATE_SECTION_ID".to_owned()));
        assert!(codes.contains(&"DUPLICATE_ASSET_KEY".to_owned()));
    }
}

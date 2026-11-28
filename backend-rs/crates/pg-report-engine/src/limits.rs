//! Schema limits and identifier rules.
//!
//! Port of the `.min()`/`.max()`/`.regex()` constraints of
//! `core-back/lib/reportEngineSdk/types/reportSpec.ts`. The three global caps are exact and
//! released (`project-design/parts/01-core-back/12-report-engine-sdk.md`): 64 datasets,
//! 64 transforms, 128 sections. The per-dataset caps are the same numbers the zod schema uses.

#![forbid(unsafe_code)]

use crate::diagnostics::{codes, ReportDiagnostic, LAYER_STRUCTURE};
use crate::spec::ReportSpec;

/// `datasets.max(64)`.
pub const MAX_DATASETS: usize = 64;
/// `transforms.max(64)`.
pub const MAX_TRANSFORMS: usize = 64;
/// `sections.max(128)`.
pub const MAX_SECTIONS: usize = 128;
/// `inputs.max(20)`.
pub const MAX_INPUTS: usize = 20;
/// `required_assets.max(20)`.
pub const MAX_REQUIRED_ASSETS: usize = 20;
/// `joins.max(6)`.
pub const MAX_JOINS: usize = 6;
/// `select.min(1).max(40)`.
pub const MAX_SELECT_FIELDS: usize = 40;
/// `group_by.max(15)`.
pub const MAX_GROUP_BY: usize = 15;
/// `order_by.max(5)` and `window_fields.max(5)`.
pub const MAX_ORDER_BY: usize = 5;
/// `window_fields.max(5)`.
pub const MAX_WINDOW_FIELDS: usize = 5;
/// `limit.int().min(1).max(10_000).default(1_000)`.
pub const MAX_DATASET_ROWS: u32 = 10_000;
/// `inputs[].key.max(48)`.
pub const MAX_INPUT_KEY_CHARS: usize = 48;

/// `^[a-zA-Z][a-zA-Z0-9_]*$` — dataset ids, aliases, output columns, input keys.
#[must_use]
pub fn is_identifier(value: &str) -> bool {
    let mut characters = value.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    if !first.is_ascii_alphabetic() {
        return false;
    }
    characters.all(|character| character.is_ascii_alphanumeric() || character == '_')
}

fn limit_error(path: &str, actual: usize, maximum: usize, what: &str) -> ReportDiagnostic {
    ReportDiagnostic::error(
        LAYER_STRUCTURE,
        path,
        codes::LIMIT_EXCEEDED,
        format!("{what} has {actual} entries; the maximum is {maximum}."),
    )
    .with_hint(format!(
        "Remove entries or split the report so that at most {maximum} remain."
    ))
}

fn identifier_error(path: &str, value: &str, what: &str) -> ReportDiagnostic {
    ReportDiagnostic::error(
        LAYER_STRUCTURE,
        path,
        codes::INVALID_IDENTIFIER,
        format!("{what} \"{value}\" is not a valid identifier."),
    )
    .with_hint(
        "Use a camelCase or snake_case identifier starting with a letter, e.g. `dailyVolume`.",
    )
}

/// Counts, per-dataset caps and identifier syntax. Duplicate ids are a reference check.
#[must_use]
pub fn validate(spec: &ReportSpec) -> Vec<ReportDiagnostic> {
    let mut diagnostics = Vec::new();

    if spec.datasets.len() > MAX_DATASETS {
        diagnostics.push(limit_error(
            "datasets",
            spec.datasets.len(),
            MAX_DATASETS,
            "datasets[]",
        ));
    }
    if spec.transforms.len() > MAX_TRANSFORMS {
        diagnostics.push(limit_error(
            "transforms",
            spec.transforms.len(),
            MAX_TRANSFORMS,
            "transforms[]",
        ));
    }
    if spec.sections.len() > MAX_SECTIONS {
        diagnostics.push(limit_error(
            "sections",
            spec.sections.len(),
            MAX_SECTIONS,
            "sections[]",
        ));
    }
    if spec.inputs.len() > MAX_INPUTS {
        diagnostics.push(limit_error(
            "inputs",
            spec.inputs.len(),
            MAX_INPUTS,
            "inputs[]",
        ));
    }
    let assets = spec.required_assets();
    if assets.len() > MAX_REQUIRED_ASSETS {
        diagnostics.push(limit_error(
            "required_assets",
            assets.len(),
            MAX_REQUIRED_ASSETS,
            "required_assets[]",
        ));
    }

    for (index, dataset) in spec.datasets.iter().enumerate() {
        let path = format!("datasets[{index}]({})", dataset.dataset_id);
        if !is_identifier(&dataset.dataset_id) {
            diagnostics.push(identifier_error(
                &format!("datasets[{index}].dataset_id"),
                &dataset.dataset_id,
                "dataset_id",
            ));
        }
        if dataset.joins.len() > MAX_JOINS {
            diagnostics.push(limit_error(
                &format!("{path}.joins"),
                dataset.joins.len(),
                MAX_JOINS,
                "joins[]",
            ));
        }
        if dataset.select.len() > MAX_SELECT_FIELDS {
            diagnostics.push(limit_error(
                &format!("{path}.select"),
                dataset.select.len(),
                MAX_SELECT_FIELDS,
                "select[]",
            ));
        }
        if dataset.group_by.len() > MAX_GROUP_BY {
            diagnostics.push(limit_error(
                &format!("{path}.group_by"),
                dataset.group_by.len(),
                MAX_GROUP_BY,
                "group_by[]",
            ));
        }
        if dataset.order_by.len() > MAX_ORDER_BY {
            diagnostics.push(limit_error(
                &format!("{path}.order_by"),
                dataset.order_by.len(),
                MAX_ORDER_BY,
                "order_by[]",
            ));
        }
        if dataset.window_fields.len() > MAX_WINDOW_FIELDS {
            diagnostics.push(limit_error(
                &format!("{path}.window_fields"),
                dataset.window_fields.len(),
                MAX_WINDOW_FIELDS,
                "window_fields[]",
            ));
        }
        if !is_identifier(&dataset.from_alias) {
            diagnostics.push(identifier_error(
                &format!("{path}.from_alias"),
                &dataset.from_alias,
                "from_alias",
            ));
        }
        for (join_index, join) in dataset.joins.iter().enumerate() {
            if !is_identifier(&join.alias) {
                diagnostics.push(identifier_error(
                    &format!("{path}.joins[{join_index}].alias"),
                    &join.alias,
                    "join alias",
                ));
            }
        }
        for (select_index, select) in dataset.select.iter().enumerate() {
            if !is_identifier(&select.alias) {
                diagnostics.push(identifier_error(
                    &format!("{path}.select[{select_index}].alias"),
                    &select.alias,
                    "select alias",
                ));
            }
        }
        for (window_index, window) in dataset.window_fields.iter().enumerate() {
            if !is_identifier(&window.alias) {
                diagnostics.push(identifier_error(
                    &format!("{path}.window_fields[{window_index}].alias"),
                    &window.alias,
                    "window alias",
                ));
            }
        }
    }

    for (index, transform) in spec.transforms.iter().enumerate() {
        let path = format!("transforms[{index}]");
        if let Some(column) = transform.output_column.as_deref() {
            if !is_identifier(column) {
                diagnostics.push(identifier_error(
                    &format!("{path}.output_column"),
                    column,
                    "output_column",
                ));
            }
        }
        if let Some(dataset) = transform.output_dataset_id.as_deref() {
            if !is_identifier(dataset) {
                diagnostics.push(identifier_error(
                    &format!("{path}.output_dataset_id"),
                    dataset,
                    "output_dataset_id",
                ));
            }
        }
    }

    for (index, input) in spec.inputs.iter().enumerate() {
        if !is_identifier(&input.key) {
            diagnostics.push(identifier_error(
                &format!("inputs[{index}].key"),
                &input.key,
                "input key",
            ));
        }
        if input.key.chars().count() > MAX_INPUT_KEY_CHARS {
            diagnostics.push(ReportDiagnostic::error(
                LAYER_STRUCTURE,
                format!("inputs[{index}].key"),
                codes::LIMIT_EXCEEDED,
                format!(
                    "Input key \"{}\" is longer than {MAX_INPUT_KEY_CHARS} characters.",
                    input.key
                ),
            ));
        }
    }

    for (index, section) in spec.sections.iter().enumerate() {
        if section.section_id.trim().is_empty() {
            diagnostics.push(ReportDiagnostic::error(
                LAYER_STRUCTURE,
                format!("sections[{index}].section_id"),
                codes::INVALID_SECTION_ID,
                "section_id must be a non-empty string.",
            ));
        }
    }

    diagnostics
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn spec_from(value: serde_json::Value) -> ReportSpec {
        serde_json::from_value(value).expect("spec fixture deserialises")
    }

    #[test]
    fn limits_are_the_released_values() {
        assert_eq!(MAX_DATASETS, 64);
        assert_eq!(MAX_TRANSFORMS, 64);
        assert_eq!(MAX_SECTIONS, 128);
        assert_eq!(MAX_JOINS, 6);
        assert_eq!(MAX_SELECT_FIELDS, 40);
        assert_eq!(MAX_DATASET_ROWS, 10_000);
    }

    #[test]
    fn identifiers_match_the_zod_regex() {
        assert!(is_identifier("daily"));
        assert!(is_identifier("dailyVolume"));
        assert!(is_identifier("daily_volume_2"));
        assert!(!is_identifier(""));
        assert!(!is_identifier("2daily"));
        assert!(!is_identifier("daily-volume"));
        assert!(!is_identifier("daily volume"));
        assert!(!is_identifier("daily.volume"));
        assert!(!is_identifier("über"));
    }

    #[test]
    fn the_global_caps_are_enforced() {
        let datasets: Vec<serde_json::Value> = (0..65)
            .map(|index| json!({"dataset_id": format!("d{index}"), "from_model": "paymentAttempt", "select": [{"alias": "a", "column": "id"}]}))
            .collect();
        let sections: Vec<serde_json::Value> = (0..129)
            .map(|index| json!({"section_id": format!("s{index}"), "section_type": "PAGE_BREAK"}))
            .collect();
        let spec = spec_from(json!({"datasets": datasets, "sections": sections, "transforms": []}));
        let diagnostics = validate(&spec);
        let exceeded: Vec<&str> = diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.code == codes::LIMIT_EXCEEDED)
            .map(|diagnostic| diagnostic.path.as_str())
            .collect();
        assert!(exceeded.contains(&"datasets"));
        assert!(exceeded.contains(&"sections"));
    }

    #[test]
    fn bad_names_and_empty_section_ids_are_reported() {
        let spec = spec_from(json!({
            "datasets": [{"dataset_id": "1bad", "from_model": "paymentAttempt", "from_alias": "t 0", "select": [{"alias": "ok", "column": "id"}, {"alias": "not-ok", "column": "id"}]}],
            "sections": [{"section_id": "  ", "section_type": "PAGE_BREAK"}],
            "inputs": [{"key": "bad-key", "type": "string"}]
        }));
        let diagnostics = validate(&spec);
        let codes: Vec<&str> = diagnostics
            .iter()
            .map(|diagnostic| diagnostic.code.as_str())
            .collect();
        assert!(codes.contains(&codes::INVALID_IDENTIFIER));
        assert!(codes.contains(&codes::INVALID_SECTION_ID));
        assert!(diagnostics.iter().all(ReportDiagnostic::is_error));
    }

    #[test]
    fn a_clean_spec_has_no_diagnostics() {
        let spec = spec_from(json!({
            "datasets": [{"dataset_id": "daily", "from_model": "paymentAttempt", "select": [{"alias": "volume", "column": "total_charged_amount"}], "limit": 500}],
            "sections": [{"section_id": "kpis", "section_type": "KPI_GRID", "cards": [{"dataset_id": "daily", "value_field": "volume"}]}]
        }));
        assert!(validate(&spec).is_empty());
    }
}

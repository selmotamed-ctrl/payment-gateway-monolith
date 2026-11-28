//! The report descriptor spec: a minimal, lossless serde view plus the authoring normaliser.
//!
//! Port of `core-back/lib/reportEngineSdk/types/reportSpec.ts` and
//! `core-back/lib/reportEngineSdk/types/normalizeReportSpec.ts`.
//!
//! The persisted form stays the original JSON (`report_definition_specs.spec_json`); this struct
//! is the typed view the compilers/verifiers read. Unknown members are preserved in
//! [`ReportSpec::extra`] so a round trip never drops `required_assets`, `page_layout`, `i18n`,
//! `spec_kind` or a future field.
//!
//! Two deliberate naming differences, both documented in the crate header:
//! - `spec_version` deserialises into [`ReportSpec::version`] and serialises back as `version`.
//! - the chrome selection is read from `page_layout` (the TS location) when the explicit
//!   [`ReportSpec::chrome`] member is absent.

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// `REPORT_DESCRIPTOR` — the only accepted `spec_kind`.
pub const SPEC_KIND: &str = "REPORT_DESCRIPTOR";

macro_rules! wire_enum {
    ($name:ident, $unknown:literal, { $($variant:ident => $wire:literal),+ $(,)? }) => {
        impl $name {
            /// Parse a wire value; anything unrecognised becomes [`Self::Unknown`].
            #[must_use]
            pub fn from_wire(value: &str) -> Self {
                match value {
                    $($wire => Self::$variant,)+
                    _ => Self::Unknown,
                }
            }

            /// The canonical wire value.
            #[must_use]
            pub const fn as_wire(&self) -> &'static str {
                match self {
                    $(Self::$variant => $wire,)+
                    Self::Unknown => $unknown,
                }
            }

            /// True when the value was recognised.
            #[must_use]
            pub const fn is_known(&self) -> bool {
                !matches!(self, Self::Unknown)
            }
        }

        impl serde::Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str(self.as_wire())
            }
        }

        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let text = <String as serde::Deserialize>::deserialize(deserializer)?;
                Ok(Self::from_wire(&text))
            }
        }
    };
}

/// `ReportSectionSpec["section_type"]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SectionType {
    KpiGrid,
    DataTable,
    Chart,
    VectorDraw,
    HtmlTemplate,
    ImageBanner,
    PageBreak,
    Unknown,
}

wire_enum!(SectionType, "UNKNOWN", {
    KpiGrid => "KPI_GRID",
    DataTable => "DATA_TABLE",
    Chart => "CHART",
    VectorDraw => "VECTOR_DRAW",
    HtmlTemplate => "HTML_TEMPLATE",
    ImageBanner => "IMAGE_BANNER",
    PageBreak => "PAGE_BREAK",
});

/// `DatasetTransformSpec["operation"]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TransformOperation {
    ComputeColumn,
    JoinDatasets,
    PivotDataset,
    CompareWithAsset,
    Unknown,
}

wire_enum!(TransformOperation, "UNKNOWN", {
    ComputeColumn => "COMPUTE_COLUMN",
    JoinDatasets => "JOIN_DATASETS",
    PivotDataset => "PIVOT_DATASET",
    CompareWithAsset => "COMPARE_WITH_ASSET",
});

/// `COMPUTE_COLUMN["formula"]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Formula {
    Add,
    Subtract,
    Multiply,
    SafeDivide,
    PercentageShare,
    VarianceBps,
    Unknown,
}

wire_enum!(Formula, "UNKNOWN", {
    Add => "ADD",
    Subtract => "SUBTRACT",
    Multiply => "MULTIPLY",
    SafeDivide => "SAFE_DIVIDE",
    PercentageShare => "PERCENTAGE_SHARE",
    VarianceBps => "VARIANCE_BPS",
});

/// `report["audience_scope"]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum AudienceScope {
    BackofficeInternal,
    MerchantFacing,
    Both,
    #[default]
    Unknown,
}

wire_enum!(AudienceScope, "UNKNOWN", {
    BackofficeInternal => "BACKOFFICE_INTERNAL",
    MerchantFacing => "MERCHANT_FACING",
    Both => "BOTH",
});

/// `page_layout["header_mode"]` / `["footer_mode"]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum ChromeMode {
    #[default]
    GlobalDefault,
    SpecificChromeCode,
    InlineSpec,
    None,
    Unknown,
}

wire_enum!(ChromeMode, "UNKNOWN", {
    GlobalDefault => "GLOBAL_DEFAULT",
    SpecificChromeCode => "SPECIFIC_CHROME_CODE",
    InlineSpec => "INLINE_SPEC",
    None => "NONE",
});

/// The header/footer selection of a report.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChromeSelection {
    #[serde(default)]
    pub header_mode: ChromeMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header_chrome_code: Option<String>,
    #[serde(default)]
    pub footer_mode: ChromeMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub footer_chrome_code: Option<String>,
}

impl ChromeSelection {
    /// Reads `page_layout` (`header_mode`, `header_chrome_code`, `footer_mode`,
    /// `footer_chrome_code`); missing values follow the TS schema defaults.
    #[must_use]
    pub fn from_page_layout(layout: &Value) -> Self {
        let Some(object) = layout.as_object() else {
            return Self::default();
        };
        let text = |key: &str| {
            object
                .get(key)
                .and_then(Value::as_str)
                .map(std::string::ToString::to_string)
        };
        Self {
            header_mode: text("header_mode").map_or(ChromeMode::GlobalDefault, |value| {
                ChromeMode::from_wire(&value)
            }),
            header_chrome_code: text("header_chrome_code"),
            footer_mode: text("footer_mode").map_or(ChromeMode::GlobalDefault, |value| {
                ChromeMode::from_wire(&value)
            }),
            footer_chrome_code: text("footer_chrome_code"),
        }
    }

    /// Every chrome code this selection names (used by the verifier and the registry lookup).
    #[must_use]
    pub fn requested_codes(&self) -> Vec<&str> {
        let mut codes = Vec::new();
        if self.header_mode == ChromeMode::SpecificChromeCode {
            if let Some(code) = self.header_chrome_code.as_deref() {
                codes.push(code);
            }
        }
        if self.footer_mode == ChromeMode::SpecificChromeCode {
            if let Some(code) = self.footer_chrome_code.as_deref() {
                codes.push(code);
            }
        }
        codes
    }
}

/// `report` (the descriptor identity block).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ReportMeta {
    #[serde(default)]
    pub code: String,
    #[serde(default)]
    pub version: Option<u32>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub audience_scope: AudienceScope,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merchant_scope_input_key: Option<String>,
    #[serde(default)]
    pub classification: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl ReportMeta {
    /// True for `MERCHANT_FACING` and `BOTH`.
    #[must_use]
    pub const fn is_merchant_facing(&self) -> bool {
        matches!(
            self.audience_scope,
            AudienceScope::MerchantFacing | AudienceScope::Both
        )
    }
}

/// `inputs[]` (the subset the verifier needs).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InputSpec {
    pub key: String,
    #[serde(rename = "type", default)]
    pub input_type: String,
    #[serde(default)]
    pub required: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub autocomplete: Option<Autocomplete>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// `inputs[].autocomplete`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Autocomplete {
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub depends_on_input: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub static_filter: Option<Value>,
}

/// `datasets[]`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DatasetSpec {
    pub dataset_id: String,
    #[serde(default)]
    pub from_model: String,
    #[serde(default = "default_from_alias")]
    pub from_alias: String,
    #[serde(default)]
    pub joins: Vec<JoinSpec>,
    #[serde(default)]
    pub select: Vec<SelectField>,
    /// Recursive `WhereFilterNode` tree; kept as JSON because the compiler is a separate task.
    #[serde(default, rename = "where", skip_serializing_if = "Option::is_none")]
    pub where_filter: Option<Value>,
    #[serde(default)]
    pub group_by: Vec<String>,
    #[serde(default)]
    pub order_by: Vec<OrderBy>,
    #[serde(default)]
    pub window_fields: Vec<WindowField>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

fn default_from_alias() -> String {
    "t0".to_owned()
}

/// `datasets[].joins[]`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JoinSpec {
    #[serde(default)]
    pub join_type: Option<String>,
    #[serde(default)]
    pub relation_name: Option<String>,
    pub target_model: String,
    pub alias: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub additional_on: Option<Value>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// `datasets[].select[]`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SelectField {
    pub alias: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table_alias: Option<String>,
    #[serde(default)]
    pub column: String,
    #[serde(default)]
    pub expression: Option<String>,
    #[serde(default)]
    pub aggregate: Option<String>,
    #[serde(default)]
    pub format_hint: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// `order_by[]` / `window_fields[].order_by[]`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrderBy {
    pub field: String,
    #[serde(default)]
    pub direction: Option<String>,
}

/// `datasets[].window_fields[]`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WindowField {
    pub alias: String,
    #[serde(default)]
    pub window_fn: Option<String>,
    pub target_field: String,
    #[serde(default)]
    pub partition_by: Vec<String>,
    #[serde(default)]
    pub order_by: Vec<OrderBy>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// `transforms[]`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TransformSpec {
    pub operation: TransformOperation,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_dataset_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_dataset_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_dataset_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub left_dataset_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub right_dataset_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_column: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub formula: Option<Formula>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub left_operand: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub right_operand: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format_hint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_key: Option<String>,
    #[serde(default)]
    pub match_keys: Vec<String>,
    #[serde(default)]
    pub compare_fields: Vec<CompareField>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub row_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aggregation: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl TransformSpec {
    /// The datasets this transform reads, in the TS verifier's order.
    #[must_use]
    pub fn source_datasets(&self) -> Vec<&str> {
        let mut sources = Vec::new();
        if let Some(source) = self.source_dataset_id.as_deref() {
            sources.push(source);
        }
        if let Some(left) = self.left_dataset_id.as_deref() {
            sources.push(left);
        }
        if let Some(right) = self.right_dataset_id.as_deref() {
            sources.push(right);
        }
        if let Some(target) = self.target_dataset_id.as_deref() {
            sources.push(target);
        }
        sources
    }

    /// The dataset this transform writes, when it creates one.
    #[must_use]
    pub fn output_dataset(&self) -> Option<&str> {
        self.output_dataset_id.as_deref()
    }
}

/// `transforms[].compare_fields[]`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CompareField {
    pub dataset_field: String,
    pub asset_field: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_field: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tolerance_minor: Option<Value>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// `sections[]` (every section type flattened into one struct, as the report engine treats it).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SectionSpec {
    pub section_id: String,
    #[serde(default = "unknown_section_type")]
    pub section_type: SectionType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title_i18n_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtitle_i18n_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dataset_id: Option<String>,
    #[serde(default)]
    pub cards: Vec<KpiCard>,
    #[serde(default)]
    pub columns: Vec<TableColumn>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x_field: Option<String>,
    #[serde(default)]
    pub series: Vec<ChartSeries>,
    #[serde(default)]
    pub nodes: Vec<VectorNode>,
    #[serde(default)]
    pub edges: Vec<VectorEdge>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub html_template: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visibility: Option<Visibility>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

fn unknown_section_type() -> SectionType {
    SectionType::Unknown
}

/// `sections[].cards[]` (`KPI_GRID`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KpiCard {
    pub dataset_id: String,
    pub value_field: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delta_field: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format_hint: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// `sections[].columns[]` (`DATA_TABLE`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TableColumn {
    pub field: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header_i18n_key: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// `sections[].series[]` (`CHART`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChartSeries {
    pub field: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label_i18n_key: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// `sections[].nodes[]` (`VECTOR_DRAW`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VectorNode {
    #[serde(default)]
    pub node_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label_i18n_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value_binding: Option<ValueBinding>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// `sections[].nodes[].value_binding`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ValueBinding {
    pub dataset_id: String,
    pub field: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// `sections[].edges[]` (`VECTOR_DRAW`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VectorEdge {
    #[serde(default)]
    pub from_node_id: String,
    #[serde(default)]
    pub to_node_id: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// `sections[].visibility`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Visibility {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dataset_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// `suggested_access`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SuggestedAccess {
    #[serde(default)]
    pub roles: Vec<String>,
    #[serde(default)]
    pub authorities: Vec<String>,
}

/// `required_assets[]` (kept in [`ReportSpec::extra`], typed on demand).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RequiredAsset {
    pub asset_key: String,
    #[serde(default)]
    pub file_name: Option<String>,
    #[serde(default)]
    pub mime_type: Option<String>,
    #[serde(default)]
    pub purpose: Option<String>,
}

/// The report descriptor.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ReportSpec {
    /// `spec_version` (serialised as `version` by this typed view).
    #[serde(
        default,
        alias = "spec_version",
        skip_serializing_if = "Option::is_none"
    )]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub report: Option<ReportMeta>,
    #[serde(default)]
    pub inputs: Vec<InputSpec>,
    #[serde(default)]
    pub datasets: Vec<DatasetSpec>,
    #[serde(default)]
    pub transforms: Vec<TransformSpec>,
    #[serde(default)]
    pub sections: Vec<SectionSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chrome: Option<ChromeSelection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggested_access: Option<SuggestedAccess>,
    /// Every unconsumed member: `spec_kind`, `page_layout`, `required_assets`, `i18n`, ...
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl ReportSpec {
    /// `spec_kind` from the preserved members.
    #[must_use]
    pub fn spec_kind(&self) -> Option<&str> {
        self.extra.get("spec_kind").and_then(Value::as_str)
    }

    /// `page_layout` from the preserved members.
    #[must_use]
    pub fn page_layout(&self) -> Option<&Value> {
        self.extra.get("page_layout")
    }

    /// The effective chrome selection: the explicit member when present, else `page_layout`.
    #[must_use]
    pub fn chrome_selection(&self) -> ChromeSelection {
        if let Some(chrome) = &self.chrome {
            return chrome.clone();
        }
        self.page_layout()
            .map_or_else(ChromeSelection::default, ChromeSelection::from_page_layout)
    }

    /// `report.audience_scope`.
    #[must_use]
    pub fn audience(&self) -> AudienceScope {
        self.report
            .as_ref()
            .map_or(AudienceScope::Unknown, |report| report.audience_scope)
    }

    /// `report.merchant_scope_input_key`.
    #[must_use]
    pub fn merchant_scope_input_key(&self) -> Option<&str> {
        self.report
            .as_ref()
            .and_then(|report| report.merchant_scope_input_key.as_deref())
    }

    /// `required_assets[]`, typed. Malformed entries are ignored (the schema rejects them first).
    #[must_use]
    pub fn required_assets(&self) -> Vec<RequiredAsset> {
        self.extra
            .get("required_assets")
            .and_then(|value| serde_json::from_value::<Vec<RequiredAsset>>(value.clone()).ok())
            .unwrap_or_default()
    }

    /// Declared input keys.
    #[must_use]
    pub fn input_keys(&self) -> Vec<&str> {
        self.inputs.iter().map(|input| input.key.as_str()).collect()
    }

    /// Whether a header/footer chrome code is requested (`SPECIFIC_CHROME_CODE`).
    #[must_use]
    pub fn requests_specific_chrome(&self) -> bool {
        let chrome = self.chrome_selection();
        chrome.header_mode == ChromeMode::SpecificChromeCode
            || chrome.footer_mode == ChromeMode::SpecificChromeCode
    }
}

/// Renders a JSON value the way `String(value)` does in JavaScript (used by the normaliser).
fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(boolean) => boolean.to_string(),
        Value::Number(number) => number.to_string(),
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// A JSON number for an `f64`, using an integer when the value is integral so the re-serialised
/// JSON stays `800` rather than `800.0` (the TS normaliser writes JS numbers).
fn json_number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_992.0 {
        Value::Number(serde_json::Number::from(value as i64))
    } else {
        serde_json::Number::from_f64(value).map_or(Value::Null, Value::Number)
    }
}

/// `normalizeReportSpec`: accepts the aliases external AIs commonly emit.
///
/// - `inputs[].default_value` = `{ "literal": X }` → `X`
/// - `transforms[].kind` → `operation`, uppercased
/// - `COMPUTE_COLUMN` takes the formula from `formula` / `compute` / `compute_op` / `operator`
///   (uppercased) and drops the aliases
/// - `VECTOR_DRAW.view_box` as `"x y width height"` / `"width height"` → object
#[must_use]
pub fn normalize_spec(input: Value) -> Value {
    let Value::Object(mut root) = input else {
        return input;
    };
    normalize_inputs(&mut root);
    normalize_transforms(&mut root);
    normalize_sections(&mut root);
    Value::Object(root)
}

fn normalize_inputs(root: &mut Map<String, Value>) {
    let Some(Value::Array(items)) = root.get_mut("inputs") else {
        return;
    };
    for item in items {
        let Value::Object(field) = item else {
            continue;
        };
        let Some(default) = field.get_mut("default_value") else {
            continue;
        };
        let Value::Object(default_object) = default else {
            continue;
        };
        if let Some(literal) = default_object.get("literal") {
            *default = literal.clone();
        }
    }
}

fn normalize_transforms(root: &mut Map<String, Value>) {
    let Some(Value::Array(items)) = root.get_mut("transforms") else {
        return;
    };
    for item in items {
        let Value::Object(transform) = item else {
            continue;
        };
        if !transform.contains_key("operation") {
            if let Some(Value::String(kind)) = transform.get("kind") {
                transform.insert("operation".to_owned(), Value::String(kind.clone()));
            }
        }
        if let Some(Value::String(operation)) = transform.get_mut("operation") {
            *operation = operation.to_uppercase();
        }
        if matches!(transform.get("operation"), Some(Value::String(operation)) if operation.as_str() == "COMPUTE_COLUMN")
        {
            let formula = ["formula", "compute", "compute_op", "operator"]
                .iter()
                .find_map(|key| transform.get(*key))
                .map(|value| js_string(value).to_uppercase());
            if let Some(formula) = formula {
                transform.insert("formula".to_owned(), Value::String(formula));
            }
        }
        for key in ["kind", "compute", "compute_op", "operator"] {
            transform.remove(key);
        }
    }
}

fn normalize_sections(root: &mut Map<String, Value>) {
    let Some(Value::Array(items)) = root.get_mut("sections") else {
        return;
    };
    for item in items {
        let Value::Object(section) = item else {
            continue;
        };
        let is_vector = matches!(section.get("section_type"), Some(Value::String(kind)) if kind.as_str() == "VECTOR_DRAW");
        if !is_vector {
            continue;
        }
        let Some(Value::String(view_box)) = section.get("view_box") else {
            continue;
        };
        let parts: Vec<f64> = view_box
            .trim()
            .split(|character: char| character.is_whitespace() || character == ',')
            .filter(|part| !part.is_empty())
            .map(|part| part.parse::<f64>().unwrap_or(f64::NAN))
            .collect();
        if !parts.iter().all(|part| part.is_finite()) {
            continue;
        }
        let mut object = Map::new();
        match parts.as_slice() {
            [x, y, width, height] => {
                object.insert("x".to_owned(), json_number(*x));
                object.insert("y".to_owned(), json_number(*y));
                object.insert("width".to_owned(), json_number(*width));
                object.insert("height".to_owned(), json_number(*height));
            }
            [width, height] => {
                object.insert("width".to_owned(), json_number(*width));
                object.insert("height".to_owned(), json_number(*height));
            }
            _ => continue,
        }
        section.insert("view_box".to_owned(), Value::Object(object));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn deserialises_the_descriptor_and_keeps_unknown_members() {
        let raw = json!({
            "spec_kind": "REPORT_DESCRIPTOR",
            "spec_version": "1.0",
            "report": {
                "code": "merchant-daily-settlement-summary",
                "audience_scope": "BOTH",
                "merchant_scope_input_key": "merchantId",
                "future_flag": true
            },
            "page_layout": {
                "header_mode": "SPECIFIC_CHROME_CODE",
                "header_chrome_code": "institutional-header",
                "footer_mode": "NONE"
            },
            "required_assets": [
                {"asset_key": "baseline", "mime_type": "application/json", "purpose": "COMPARISON_BASELINE_DATA"}
            ],
            "datasets": [{
                "dataset_id": "daily",
                "from_model": "paymentAttempt",
                "select": [{"alias": "volume", "column": "total_charged_amount"}],
                "where": {"kind": "PREDICATE", "column": "merchant_id", "op": "eq"}
            }],
            "transforms": [{"operation": "COMPUTE_COLUMN", "target_dataset_id": "daily", "output_column": "share", "formula": "PERCENTAGE_SHARE", "left_operand": "volume"}],
            "sections": [{"section_id": "kpis", "section_type": "KPI_GRID", "cards": [{"dataset_id": "daily", "value_field": "volume"}]}],
            "suggested_access": {"roles": ["COMPLIANCE"], "authorities": ["reports:read"]}
        });
        let spec: ReportSpec = serde_json::from_value(raw).expect("spec deserialises");
        assert_eq!(spec.version.as_deref(), Some("1.0"));
        assert_eq!(spec.spec_kind(), Some("REPORT_DESCRIPTOR"));
        assert_eq!(spec.audience(), AudienceScope::Both);
        assert_eq!(spec.merchant_scope_input_key(), Some("merchantId"));
        assert_eq!(spec.datasets.len(), 1);
        assert_eq!(spec.datasets[0].from_alias, "t0");
        assert_eq!(spec.transforms[0].formula, Some(Formula::PercentageShare));
        assert_eq!(spec.sections[0].section_type, SectionType::KpiGrid);
        assert_eq!(spec.required_assets().len(), 1);
        assert_eq!(spec.required_assets()[0].asset_key, "baseline");
        let chrome = spec.chrome_selection();
        assert_eq!(chrome.header_mode, ChromeMode::SpecificChromeCode);
        assert_eq!(
            chrome.header_chrome_code.as_deref(),
            Some("institutional-header")
        );
        assert_eq!(chrome.footer_mode, ChromeMode::None);
        assert_eq!(chrome.requested_codes(), vec!["institutional-header"]);
        assert_eq!(
            spec.report
                .as_ref()
                .and_then(|report| report.extra.get("future_flag")),
            Some(&Value::Bool(true))
        );
        assert_eq!(
            spec.extra
                .get("page_layout")
                .and_then(|layout| layout.get("header_mode")),
            Some(&json!("SPECIFIC_CHROME_CODE"))
        );
    }

    #[test]
    fn normalize_accepts_kind_compute_and_literal_defaults() {
        let raw = json!({
            "inputs": [{"key": "period", "type": "daterange", "default_value": {"literal": ["2026-01-01", "2026-01-31"]}}],
            "transforms": [{"kind": "compute_column", "target_dataset_id": "daily", "output_column": "rate", "compute": "safe_divide", "left_operand": "volume", "right_operand": "count"}],
            "sections": [{"section_id": "diagram", "section_type": "VECTOR_DRAW", "view_box": "0 0 800 260"}]
        });
        let normalized = normalize_spec(raw);
        assert_eq!(
            normalized["inputs"][0]["default_value"],
            json!(["2026-01-01", "2026-01-31"])
        );
        assert_eq!(
            normalized["transforms"][0]["operation"],
            json!("COMPUTE_COLUMN")
        );
        assert_eq!(normalized["transforms"][0]["formula"], json!("SAFE_DIVIDE"));
        assert!(normalized["transforms"][0].get("kind").is_none());
        assert!(normalized["transforms"][0].get("compute").is_none());
        assert_eq!(
            normalized["sections"][0]["view_box"],
            json!({"x": 0, "y": 0, "width": 800, "height": 260})
        );

        let compiled: ReportSpec =
            serde_json::from_value(normalized).expect("normalised spec deserialises");
        assert_eq!(
            compiled.transforms[0].operation,
            TransformOperation::ComputeColumn
        );
        assert_eq!(compiled.transforms[0].formula, Some(Formula::SafeDivide));
        assert_eq!(compiled.inputs[0].input_type, "daterange");
    }

    #[test]
    fn normalize_two_value_view_box_and_keeps_unknown_fields() {
        let normalized = normalize_spec(json!({
            "sections": [{"section_id": "d", "section_type": "VECTOR_DRAW", "view_box": "640, 200", "extra_node": 1}],
            "unrelated": {"keep": true}
        }));
        assert_eq!(
            normalized["sections"][0]["view_box"],
            json!({"width": 640, "height": 200})
        );
        assert_eq!(normalized["sections"][0]["extra_node"], json!(1));
        assert_eq!(normalized["unrelated"], json!({"keep": true}));
    }

    #[test]
    fn non_object_input_is_returned_unchanged() {
        assert_eq!(normalize_spec(json!(["a"])), json!(["a"]));
        assert_eq!(normalize_spec(json!(null)), json!(null));
    }

    #[test]
    fn chrome_defaults_to_global() {
        let spec: ReportSpec =
            serde_json::from_value(json!({"datasets": [], "sections": []})).expect("spec");
        let chrome = spec.chrome_selection();
        assert_eq!(chrome.header_mode, ChromeMode::GlobalDefault);
        assert_eq!(chrome.footer_mode, ChromeMode::GlobalDefault);
        assert!(chrome.requested_codes().is_empty());
    }

    #[test]
    fn wire_enums_round_trip_and_tolerate_unknown_values() {
        assert_eq!(
            SectionType::from_wire("IMAGE_BANNER"),
            SectionType::ImageBanner
        );
        assert_eq!(
            SectionType::from_wire("FUTURE_SECTION"),
            SectionType::Unknown
        );
        assert!(!SectionType::Unknown.is_known());
        assert_eq!(SectionType::Unknown.as_wire(), "UNKNOWN");
        assert_eq!(
            serde_json::to_value(SectionType::PageBreak).expect("serialises"),
            json!("PAGE_BREAK")
        );
        assert_eq!(
            serde_json::from_value::<AudienceScope>(json!("MERCHANT_FACING"))
                .expect("deserialises"),
            AudienceScope::MerchantFacing
        );
        assert_eq!(
            serde_json::from_value::<ChromeMode>(json!("INLINE_SPEC")).expect("deserialises"),
            ChromeMode::InlineSpec
        );
    }

    #[test]
    fn transform_sources_follow_the_ts_verifier() {
        let transform: TransformSpec = serde_json::from_value(json!({
            "operation": "COMPARE_WITH_ASSET",
            "source_dataset_id": "daily",
            "asset_key": "baseline",
            "output_dataset_id": "compared",
            "match_keys": ["reference"],
            "compare_fields": [{"dataset_field": "volume", "asset_field": "amount", "output_field": "amount_expected"}]
        }))
        .expect("transform");
        assert_eq!(transform.source_datasets(), vec!["daily"]);
        assert_eq!(transform.output_dataset(), Some("compared"));
        assert_eq!(
            transform.compare_fields[0].output_field.as_deref(),
            Some("amount_expected")
        );
    }
}

//! PII and authority inference.
//!
//! Port of `core-back/lib/reportEngineSdk/verifier/AuthorityInferenceEngine.ts` and of the
//! non-reportable model list in `core-back/lib/reportEngineSdk/transcript/reportableModels.ts`.
//!
//! Pure: the caller injects the host catalog (models, columns, domains, conflict matrix, roles),
//! and this module only reads it. Every column a dataset references is scanned — select,
//! `where`, join `additional_on`, `group_by`, `order_by` and window base/partition/order fields —
//! because PostgreSQL reads window and order columns even when the compiler hides them from the
//! output (A01).

#![forbid(unsafe_code)]

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::spec::{DatasetSpec, ReportSpec};

/// Tables that are engine/operational plumbing and must never be reported on.
///
/// Verbatim from `reportableModels.ts`. The Layer 2 verifier rejects a hallucinated internal
/// table with `MODEL_NOT_REPORTABLE` instead of a generic unknown-model error.
pub const NON_REPORTABLE_MODELS: &[&str] = &[
    // Report engine storage.
    "report_asset_bundles",
    "report_chrome_specs",
    "report_definition_specs",
    "report_execution_audit",
    "merchant_report_specs",
    "merchant_report_asset_bundles",
    "merchant_report_execution_audit",
    "merchant_report_rate_events",
    "merchant_report_studio_status",
    // Authentication / session internals.
    "mfa_challenges",
    "access_tokens",
    "access_token_ips",
    "user_identities",
    "session_revocations",
    "worker_cursors",
    "deadline_stages",
    // Queues, outboxes and backup control.
    "outbox_events",
    "audit_outbox",
    "backup_catalog_runs",
    "backup_restore_drills",
    // Ledger shard maintenance.
    "gl_shard_repairs",
    "gl_shard_checkpoints",
    // Gateway configuration internals.
    "credential_sets",
    "gateway_auth",
    "crypto_profiles",
    "gateway_version_evidence",
    "gateway_environments",
    "gateway_settings",
    "rail_fields",
    "flows",
    "flow_steps",
    "step_parameters",
    "step_outputs",
    "status_rules",
    "error_maps",
    "confirmation_channels",
    "poll_policies",
    "widget_definitions",
    "redirect_definitions",
    "manual_instructions",
    // Platform configuration and template/asset plumbing.
    "platform_settings",
    "notification_templates",
    "regulatory_schema_default_bindings",
    "regulatory_rule_schema_bindings",
    "assets",
];

/// `isReportableModel(tableName)`.
#[must_use]
pub fn is_reportable_model(table_name: &str) -> bool {
    !NON_REPORTABLE_MODELS.contains(&table_name)
}

/// `CatalogDomain`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Domain {
    Ledger,
    Payments,
    Merchants,
    ComplianceAml,
    Gateways,
    Reconciliation,
    SecurityAudit,
    Operations,
}

impl Domain {
    /// The wire value.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Ledger => "LEDGER",
            Self::Payments => "PAYMENTS",
            Self::Merchants => "MERCHANTS",
            Self::ComplianceAml => "COMPLIANCE_AML",
            Self::Gateways => "GATEWAYS",
            Self::Reconciliation => "RECONCILIATION",
            Self::SecurityAudit => "SECURITY_AUDIT",
            Self::Operations => "OPERATIONS",
        }
    }

    /// Confirmed matches and confidential AML data.
    #[must_use]
    pub const fn is_confidential(self) -> bool {
        matches!(self, Self::ComplianceAml)
    }
}

/// `ColumnSensitivity`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Sensitivity {
    Public,
    Internal,
    ConfidentialAml,
    PiiMasked,
    ForbiddenSecret,
}

/// `CatalogColumnDef` (the fields inference needs).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CatalogColumn {
    pub name: String,
    pub sensitivity: Sensitivity,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redaction_strategy: Option<String>,
}

impl CatalogColumn {
    /// A column with the given sensitivity.
    #[must_use]
    pub fn new(name: impl Into<String>, sensitivity: Sensitivity) -> Self {
        Self {
            name: name.into(),
            sensitivity,
            redaction_strategy: None,
        }
    }

    /// Attaches a redaction strategy (`MASK_MIDDLE`, `HASH_PREFIX`, `OMIT`).
    #[must_use]
    pub fn with_redaction(mut self, strategy: impl Into<String>) -> Self {
        self.redaction_strategy = Some(strategy.into());
        self
    }
}

/// `merchantScopable` on a catalog model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MerchantScopable {
    pub merchant_id_column: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub application_id_column: Option<String>,
}

impl MerchantScopable {
    /// The mandatory merchant equality column.
    #[must_use]
    pub fn new(merchant_id_column: impl Into<String>) -> Self {
        Self {
            merchant_id_column: merchant_id_column.into(),
            application_id_column: None,
        }
    }
}

/// `CatalogModelDef` (the fields inference and reference checks need).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CatalogModel {
    pub model_name: String,
    pub table_name: String,
    pub domain: Domain,
    #[serde(default)]
    pub columns: BTreeMap<String, CatalogColumn>,
    #[serde(default)]
    pub required_authorities: Vec<String>,
    #[serde(default)]
    pub natural_roles: Vec<String>,
    #[serde(default)]
    pub confidential_aml_only: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merchant_scopable: Option<MerchantScopable>,
}

impl Default for CatalogModel {
    fn default() -> Self {
        // A builder default; every real catalog entry sets the domain explicitly.
        Self {
            model_name: String::new(),
            table_name: String::new(),
            domain: Domain::Operations,
            columns: BTreeMap::new(),
            required_authorities: Vec::new(),
            natural_roles: Vec::new(),
            confidential_aml_only: false,
            merchant_scopable: None,
        }
    }
}

impl CatalogModel {
    /// A model with the given identity; the rest of the fields set through struct update syntax.
    #[must_use]
    pub fn new(
        model_name: impl Into<String>,
        table_name: impl Into<String>,
        domain: Domain,
    ) -> Self {
        Self {
            model_name: model_name.into(),
            table_name: table_name.into(),
            domain,
            ..Self::default()
        }
    }
}

/// One entry of the host authority conflict matrix.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConflictRule {
    pub domain_a: Domain,
    pub domain_b: Domain,
    pub conflict_code: String,
    pub description: String,
    pub resolution_hint: String,
}

/// The host catalog (the inference subset of `ReportEngineHostConfig`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Catalog {
    pub models: BTreeMap<String, CatalogModel>,
    #[serde(default)]
    pub conflict_rules: Vec<ConflictRule>,
    #[serde(default)]
    pub roles: Vec<String>,
    #[serde(default)]
    pub authorities: Vec<String>,
    /// Registered autocomplete source keys (`host.autocompleteProviders`).
    #[serde(default)]
    pub autocomplete_sources: Vec<String>,
}

impl Catalog {
    /// An empty catalog.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers a model.
    #[must_use]
    pub fn with_model(mut self, model: CatalogModel) -> Self {
        self.models.insert(model.model_name.clone(), model);
        self
    }

    /// Registers a conflict rule.
    #[must_use]
    pub fn with_conflict(mut self, rule: ConflictRule) -> Self {
        self.conflict_rules.push(rule);
        self
    }

    /// Sets the role catalogue.
    #[must_use]
    pub fn with_roles<S: Into<String>>(mut self, roles: impl IntoIterator<Item = S>) -> Self {
        self.roles = roles.into_iter().map(Into::into).collect();
        self
    }

    /// Sets the authority catalogue.
    #[must_use]
    pub fn with_authorities<S: Into<String>>(
        mut self,
        authorities: impl IntoIterator<Item = S>,
    ) -> Self {
        self.authorities = authorities.into_iter().map(Into::into).collect();
        self
    }

    /// Sets the registered autocomplete sources.
    #[must_use]
    pub fn with_autocomplete_sources<S: Into<String>>(
        mut self,
        sources: impl IntoIterator<Item = S>,
    ) -> Self {
        self.autocomplete_sources = sources.into_iter().map(Into::into).collect();
        self
    }

    /// Looks a model up by its camelCase model name.
    #[must_use]
    pub fn model(&self, name: &str) -> Option<&CatalogModel> {
        self.models.get(name)
    }

    /// True when a model (looked up by name) is engine plumbing.
    #[must_use]
    pub fn is_model_reportable(&self, name: &str) -> bool {
        self.model(name)
            .is_none_or(|model| is_reportable_model(&model.table_name))
    }
}

/// One referenced column and the model it belongs to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReferencedColumn {
    pub model: Option<String>,
    pub column: String,
}

fn model_name_for_alias<'a>(dataset: &'a DatasetSpec, alias: Option<&str>) -> Option<&'a str> {
    match alias {
        None => Some(dataset.from_model.as_str()),
        Some(alias) if alias == dataset.from_alias => Some(dataset.from_model.as_str()),
        Some(alias) => dataset
            .joins
            .iter()
            .find(|join| join.alias == alias)
            .map(|join| join.target_model.as_str()),
    }
}

fn push_column(
    catalog: &Catalog,
    model_name: Option<&str>,
    column: &str,
    out: &mut Vec<ReferencedColumn>,
) {
    let Some(model_name) = model_name else {
        return;
    };
    let Some(model) = catalog.model(model_name) else {
        return;
    };
    if model.columns.contains_key(column) {
        out.push(ReferencedColumn {
            model: Some(model.model_name.clone()),
            column: column.to_owned(),
        });
    }
}

fn visit_where(
    node: &Value,
    dataset: &DatasetSpec,
    catalog: &Catalog,
    out: &mut Vec<ReferencedColumn>,
) {
    let Some(object) = node.as_object() else {
        return;
    };
    if matches!(object.get("kind").and_then(Value::as_str), Some("GROUP")) {
        if let Some(Value::Array(conditions)) = object.get("conditions") {
            for condition in conditions {
                visit_where(condition, dataset, catalog, out);
            }
        }
        return;
    }
    let Some(column) = object.get("column").and_then(Value::as_str) else {
        return;
    };
    let alias = object.get("table_alias").and_then(Value::as_str);
    push_column(catalog, model_name_for_alias(dataset, alias), column, out);
}

/// Every column a dataset references, in the TS engine's order.
#[must_use]
pub fn collect_referenced_columns(
    dataset: &DatasetSpec,
    catalog: &Catalog,
) -> Vec<ReferencedColumn> {
    let mut out = Vec::new();
    for select in &dataset.select {
        push_column(
            catalog,
            model_name_for_alias(dataset, select.table_alias.as_deref()),
            &select.column,
            &mut out,
        );
    }
    if let Some(where_filter) = &dataset.where_filter {
        visit_where(where_filter, dataset, catalog, &mut out);
    }
    for join in &dataset.joins {
        if let Some(additional) = &join.additional_on {
            visit_where(additional, dataset, catalog, &mut out);
        }
    }
    for group in &dataset.group_by {
        if let Some(select) = dataset.select.iter().find(|select| &select.alias == group) {
            push_column(
                catalog,
                model_name_for_alias(dataset, select.table_alias.as_deref()),
                &select.column,
                &mut out,
            );
        } else {
            push_column(
                catalog,
                model_name_for_alias(dataset, None),
                group,
                &mut out,
            );
        }
    }
    for order in &dataset.order_by {
        if let Some(select) = dataset
            .select
            .iter()
            .find(|select| select.alias == order.field)
        {
            push_column(
                catalog,
                model_name_for_alias(dataset, select.table_alias.as_deref()),
                &select.column,
                &mut out,
            );
        } else {
            push_column(
                catalog,
                model_name_for_alias(dataset, None),
                &order.field,
                &mut out,
            );
        }
    }
    for window in &dataset.window_fields {
        if let Some(select) = dataset
            .select
            .iter()
            .find(|select| select.alias == window.target_field)
        {
            push_column(
                catalog,
                model_name_for_alias(dataset, select.table_alias.as_deref()),
                &select.column,
                &mut out,
            );
        } else {
            push_column(
                catalog,
                model_name_for_alias(dataset, None),
                &window.target_field,
                &mut out,
            );
        }
        for field in window
            .partition_by
            .iter()
            .chain(window.order_by.iter().map(|order| &order.field))
        {
            if let Some(select) = dataset.select.iter().find(|select| &select.alias == field) {
                push_column(
                    catalog,
                    model_name_for_alias(dataset, select.table_alias.as_deref()),
                    &select.column,
                    &mut out,
                );
            } else {
                push_column(
                    catalog,
                    model_name_for_alias(dataset, None),
                    field,
                    &mut out,
                );
            }
        }
    }
    out
}

/// `AuthorityInferenceResult["conflictStatus"]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ConflictStatus {
    None,
    CrossDomainIntersectionNarrow,
    OverConflictingZeroNaturalRoles,
    ConfidentialDomainMix,
}

impl ConflictStatus {
    /// The wire value.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::None => "NONE",
            Self::CrossDomainIntersectionNarrow => "CROSS_DOMAIN_INTERSECTION_NARROW",
            Self::OverConflictingZeroNaturalRoles => "OVER_CONFLICTING_ZERO_NATURAL_ROLES",
            Self::ConfidentialDomainMix => "CONFIDENTIAL_DOMAIN_MIX",
        }
    }
}

/// One conflict explanation (the `conflictDetails` entry).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConflictDetail {
    pub code: String,
    pub message: String,
    pub resolution_hint: String,
}

/// `effectiveAccessPolicy`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveAccessPolicy {
    pub mode: AuthorityMode,
    pub allowed_roles: Vec<String>,
    #[serde(default)]
    pub required_any_authorities: Vec<String>,
    #[serde(default)]
    pub required_all_authorities: Vec<String>,
}

/// `INFERRED_STRICT` / `SECURITY_ADMIN_OVERRIDE`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AuthorityMode {
    InferredStrict,
    SecurityAdminOverride,
}

/// The inference result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityInference {
    pub queried_models: Vec<String>,
    pub queried_domains: Vec<String>,
    pub inferred_required_authorities: Vec<String>,
    pub inferred_natural_roles: Vec<String>,
    pub requires_confidential_aml_access: bool,
    pub contains_masked_pii_columns: bool,
    pub conflict_status: ConflictStatus,
    pub conflict_details: Vec<ConflictDetail>,
    pub effective_access_policy: EffectiveAccessPolicy,
}

/// A Security Admin authority override (`SECURITY_ADMIN` + `security:write`), recorded with a
/// written justification in the TS flow.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityOverride {
    pub allowed_roles: Vec<String>,
    pub required_any_authorities: Vec<String>,
    pub justification: String,
    pub overridden_by_user_id: String,
    pub overridden_at_iso: String,
}

fn push_unique(values: &mut Vec<String>, value: &str) {
    if !values.iter().any(|existing| existing == value) {
        values.push(value.to_owned());
    }
}

/// `inferReportAuthorities`.
#[must_use]
pub fn infer_authorities(spec: &ReportSpec, catalog: &Catalog) -> AuthorityInference {
    infer_authorities_with_override(spec, catalog, None)
}

/// `inferReportAuthorities` with an optional Security Admin override.
#[must_use]
pub fn infer_authorities_with_override(
    spec: &ReportSpec,
    catalog: &Catalog,
    security_override: Option<&SecurityOverride>,
) -> AuthorityInference {
    let mut queried_models: Vec<String> = Vec::new();
    for dataset in &spec.datasets {
        push_unique(&mut queried_models, &dataset.from_model);
        for join in &dataset.joins {
            push_unique(&mut queried_models, &join.target_model);
        }
    }

    let mut queried_domains: Vec<String> = Vec::new();
    let mut required_authorities: Vec<String> = Vec::new();
    let mut natural_roles: Option<Vec<String>> = None;
    let mut requires_confidential_aml_access = false;

    for model_name in &queried_models {
        let Some(model) = catalog.model(model_name) else {
            continue;
        };
        push_unique(&mut queried_domains, model.domain.as_str());
        for authority in &model.required_authorities {
            push_unique(&mut required_authorities, authority);
        }
        if model.confidential_aml_only {
            requires_confidential_aml_access = true;
        }
        natural_roles = Some(match natural_roles {
            None => model.natural_roles.clone(),
            Some(previous) => previous
                .into_iter()
                .filter(|role| {
                    model
                        .natural_roles
                        .iter()
                        .any(|candidate| candidate == role)
                })
                .collect(),
        });
    }

    let mut contains_masked_pii_columns = false;
    for dataset in &spec.datasets {
        for reference in collect_referenced_columns(dataset, catalog) {
            let Some(model_name) = reference.model.as_deref() else {
                continue;
            };
            let Some(column) = catalog
                .model(model_name)
                .and_then(|model| model.columns.get(&reference.column))
            else {
                continue;
            };
            match column.sensitivity {
                Sensitivity::PiiMasked => contains_masked_pii_columns = true,
                Sensitivity::ConfidentialAml => requires_confidential_aml_access = true,
                Sensitivity::Public | Sensitivity::Internal | Sensitivity::ForbiddenSecret => {}
            }
        }
    }

    let inferred_natural_roles = natural_roles.unwrap_or_default();
    let mut conflict_details: Vec<ConflictDetail> = Vec::new();

    for rule in &catalog.conflict_rules {
        let has_a = queried_domains
            .iter()
            .any(|domain| domain == rule.domain_a.as_str());
        let has_b = queried_domains
            .iter()
            .any(|domain| domain == rule.domain_b.as_str());
        if has_a && has_b {
            conflict_details.push(ConflictDetail {
                code: rule.conflict_code.clone(),
                message: rule.description.clone(),
                resolution_hint: rule.resolution_hint.clone(),
            });
        }
    }

    if let Some(suggested) = &spec.suggested_access {
        for role in &suggested.roles {
            if !inferred_natural_roles
                .iter()
                .any(|candidate| candidate == role)
            {
                conflict_details.push(ConflictDetail {
                    code: crate::diagnostics::codes::SUGGESTED_ACCESS_CONFLICT.to_owned(),
                    message: format!(
                        "suggested_access grants role \"{role}\", but the queried models do not naturally allow that role."
                    ),
                    resolution_hint:
                        "Remove the suggestion or use a Security Admin authority override with a written justification."
                            .to_owned(),
                });
            }
        }
        for authority in &suggested.authorities {
            if !required_authorities
                .iter()
                .any(|candidate| candidate == authority)
            {
                conflict_details.push(ConflictDetail {
                    code: crate::diagnostics::codes::SUGGESTED_AUTHORITY_NOT_REQUIRED.to_owned(),
                    message: format!(
                        "suggested_access grants authority \"{authority}\", but the queried models do not require it."
                    ),
                    resolution_hint: "Keep only authorities the queried models actually require.".to_owned(),
                });
            }
        }
    }

    let confidential_mix = requires_confidential_aml_access
        && queried_domains.iter().any(|domain| {
            domain != Domain::ComplianceAml.as_str() && domain != Domain::Merchants.as_str()
        });
    let conflict_status = if confidential_mix {
        ConflictStatus::ConfidentialDomainMix
    } else if inferred_natural_roles.is_empty() && !queried_models.is_empty() {
        conflict_details.push(ConflictDetail {
            code: crate::diagnostics::codes::ZERO_NATURAL_ROLE_INTERSECTION.to_owned(),
            message: format!(
                "Queries span [{}], leaving no single default role holding all required authorities ({}). This is a non-blocking warning; the report needs an explicit access policy.",
                queried_domains.join(", "),
                required_authorities.join(", ")
            ),
            resolution_hint:
                "A Security Admin (SECURITY_ADMIN / security:write) can configure an Authority Override with the roles or authorities allowed to view and run this report."
                    .to_owned(),
        });
        ConflictStatus::OverConflictingZeroNaturalRoles
    } else if queried_domains.len() > 2 {
        ConflictStatus::CrossDomainIntersectionNarrow
    } else {
        ConflictStatus::None
    };

    let effective_access_policy = if let Some(override_record) = security_override {
        EffectiveAccessPolicy {
            mode: AuthorityMode::SecurityAdminOverride,
            allowed_roles: override_record.allowed_roles.clone(),
            required_any_authorities: override_record.required_any_authorities.clone(),
            required_all_authorities: Vec::new(),
        }
    } else {
        EffectiveAccessPolicy {
            mode: AuthorityMode::InferredStrict,
            allowed_roles: inferred_natural_roles.clone(),
            required_any_authorities: Vec::new(),
            required_all_authorities: required_authorities.clone(),
        }
    };

    AuthorityInference {
        queried_models,
        queried_domains,
        inferred_required_authorities: required_authorities,
        inferred_natural_roles,
        requires_confidential_aml_access,
        contains_masked_pii_columns,
        conflict_status,
        conflict_details,
        effective_access_policy,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spec::ReportSpec;
    use serde_json::json;

    fn catalog() -> Catalog {
        let mut attempts =
            CatalogModel::new("paymentAttempt", "payment_attempts", Domain::Payments);
        attempts.columns.insert(
            "reference".to_owned(),
            CatalogColumn::new("reference", Sensitivity::Internal),
        );
        attempts.columns.insert(
            "total_charged_amount".to_owned(),
            CatalogColumn::new("total_charged_amount", Sensitivity::Internal),
        );
        attempts.columns.insert(
            "payer_phone".to_owned(),
            CatalogColumn::new("payer_phone", Sensitivity::PiiMasked).with_redaction("MASK_MIDDLE"),
        );
        attempts.required_authorities = vec!["merchant:read".to_owned()];
        attempts.natural_roles = vec![
            "OPS".to_owned(),
            "COMPLIANCE".to_owned(),
            "MERCHANT_ADMIN".to_owned(),
        ];
        attempts.merchant_scopable = Some(MerchantScopable::new("merchant_id"));

        let mut aml = CatalogModel::new("amlCase", "aml_cases", Domain::ComplianceAml);
        aml.columns.insert(
            "trigger_reason".to_owned(),
            CatalogColumn::new("trigger_reason", Sensitivity::ConfidentialAml),
        );
        aml.required_authorities = vec!["aml:read".to_owned()];
        aml.natural_roles = vec!["MLRO".to_owned(), "COMPLIANCE".to_owned()];
        aml.confidential_aml_only = true;

        Catalog::new()
            .with_model(attempts)
            .with_model(aml)
            .with_roles(["OPS", "COMPLIANCE", "MLRO", "MERCHANT_ADMIN"])
            .with_authorities(["merchant:read", "aml:read", "security:write"])
    }

    fn spec() -> ReportSpec {
        serde_json::from_value(json!({
            "datasets": [{
                "dataset_id": "daily",
                "from_model": "paymentAttempt",
                "select": [
                    {"alias": "volume", "column": "total_charged_amount"},
                    {"alias": "phone", "column": "payer_phone"}
                ],
                "where": {"kind": "GROUP", "logic": "AND", "conditions": [
                    {"kind": "PREDICATE", "column": "reference", "op": "eq"}
                ]},
                "group_by": ["volume"],
                "order_by": [{"field": "reference"}],
                "window_fields": [{"alias": "rank", "window_fn": "RANK", "target_field": "volume", "partition_by": ["phone"]}]
            }],
            "sections": [{"section_id": "kpis", "section_type": "KPI_GRID"}],
            "suggested_access": {"roles": ["MLRO"], "authorities": ["aml:read"]}
        }))
        .expect("spec fixture")
    }

    #[test]
    fn non_reportable_models_are_hidden() {
        assert!(is_reportable_model("payment_attempts"));
        assert!(!is_reportable_model("report_definition_specs"));
        assert!(!is_reportable_model("credential_sets"));
        assert!(catalog().is_model_reportable("paymentAttempt"));
        let mut plumbing = catalog();
        plumbing.models.insert(
            "flows".to_owned(),
            CatalogModel::new("flows", "flows", Domain::Gateways),
        );
        assert!(!plumbing.is_model_reportable("flows"));
        assert_eq!(NON_REPORTABLE_MODELS.len(), 45);
    }

    #[test]
    fn every_referenced_column_is_collected() {
        let spec = spec();
        let references = collect_referenced_columns(&spec.datasets[0], &catalog());
        let columns: Vec<&str> = references
            .iter()
            .map(|reference| reference.column.as_str())
            .collect();
        assert_eq!(
            columns,
            vec![
                "total_charged_amount",
                "payer_phone",
                "reference",
                "total_charged_amount",
                "reference",
                "total_charged_amount",
                "payer_phone"
            ]
        );
        assert!(references
            .iter()
            .all(|reference| reference.model.as_deref() == Some("paymentAttempt")));
    }

    #[test]
    fn inference_reports_pii_and_the_role_intersection() {
        let inference = infer_authorities(&spec(), &catalog());
        assert_eq!(inference.queried_models, vec!["paymentAttempt"]);
        assert_eq!(inference.queried_domains, vec!["PAYMENTS"]);
        assert!(inference.contains_masked_pii_columns);
        assert!(!inference.requires_confidential_aml_access);
        assert_eq!(
            inference.inferred_natural_roles,
            vec!["OPS", "COMPLIANCE", "MERCHANT_ADMIN"]
        );
        assert_eq!(
            inference.effective_access_policy.mode,
            AuthorityMode::InferredStrict
        );
        assert_eq!(
            inference.effective_access_policy.required_all_authorities,
            vec!["merchant:read"]
        );
        let conflict_codes: Vec<&str> = inference
            .conflict_details
            .iter()
            .map(|detail| detail.code.as_str())
            .collect();
        assert!(conflict_codes.contains(&"SUGGESTED_ACCESS_CONFLICT"));
        assert!(conflict_codes.contains(&"SUGGESTED_AUTHORITY_NOT_REQUIRED"));
    }

    #[test]
    fn a_confidential_model_needs_aml_access_and_mixing_is_flagged() {
        let mut value = serde_json::to_value(spec()).expect("serialises");
        if let Some(datasets) = value.get_mut("datasets").and_then(Value::as_array_mut) {
            datasets.push(json!({
                "dataset_id": "aml",
                "from_model": "amlCase",
                "select": [{"alias": "reason", "column": "trigger_reason"}]
            }));
        }
        let spec: ReportSpec = serde_json::from_value(value).expect("spec");
        let inference = infer_authorities(&spec, &catalog());
        assert!(inference.requires_confidential_aml_access);
        assert_eq!(
            inference.conflict_status,
            ConflictStatus::ConfidentialDomainMix
        );
        assert_eq!(
            inference.queried_domains,
            vec!["PAYMENTS", "COMPLIANCE_AML"]
        );
        assert!(inference
            .effective_access_policy
            .required_all_authorities
            .contains(&"aml:read".to_owned()));
    }

    #[test]
    fn a_zero_intersection_is_a_non_blocking_warning() {
        let mut ledger = CatalogModel::new("ledgerEntry", "journal_entries", Domain::Ledger);
        ledger.columns.insert(
            "amount".to_owned(),
            CatalogColumn::new("amount", Sensitivity::Internal),
        );
        ledger.required_authorities = vec!["finance:read".to_owned()];
        ledger.natural_roles = vec!["FINANCE".to_owned()];
        let catalog = catalog().with_model(ledger);
        let spec: ReportSpec = serde_json::from_value(json!({
            "datasets": [
                {"dataset_id": "daily", "from_model": "paymentAttempt", "select": [{"alias": "volume", "column": "total_charged_amount"}], "where": {"kind": "PREDICATE", "column": "reference", "op": "eq"}},
                {"dataset_id": "ledger", "from_model": "ledgerEntry", "select": [{"alias": "amount", "column": "amount"}]}
            ],
            "sections": [{"section_id": "kpis", "section_type": "KPI_GRID"}]
        }))
        .expect("spec");
        let inference = infer_authorities(&spec, &catalog);
        assert!(inference.inferred_natural_roles.is_empty());
        assert_eq!(
            inference.conflict_status,
            ConflictStatus::OverConflictingZeroNaturalRoles
        );
        assert!(inference
            .conflict_details
            .iter()
            .any(|detail| detail.code == "ZERO_NATURAL_ROLE_INTERSECTION"));
    }

    #[test]
    fn a_security_override_replaces_the_inferred_policy() {
        let override_record = SecurityOverride {
            allowed_roles: vec!["OPS".to_owned()],
            required_any_authorities: vec!["reports:run".to_owned()],
            justification: "Board pack".to_owned(),
            overridden_by_user_id: "00000000-0000-4000-8000-000000000001".to_owned(),
            overridden_at_iso: "2026-11-28T09:00:00.000Z".to_owned(),
        };
        let inference =
            infer_authorities_with_override(&spec(), &catalog(), Some(&override_record));
        assert_eq!(
            inference.effective_access_policy.mode,
            AuthorityMode::SecurityAdminOverride
        );
        assert_eq!(inference.effective_access_policy.allowed_roles, vec!["OPS"]);
        assert!(inference
            .effective_access_policy
            .required_all_authorities
            .is_empty());
    }

    #[test]
    fn inference_serialises_with_camel_case_names() {
        let value =
            serde_json::to_value(infer_authorities(&spec(), &catalog())).expect("serialises");
        assert_eq!(value["queriedModels"][0], "paymentAttempt");
        assert_eq!(value["conflictStatus"], "NONE");
        assert_eq!(value["effectiveAccessPolicy"]["mode"], "INFERRED_STRICT");
    }
}

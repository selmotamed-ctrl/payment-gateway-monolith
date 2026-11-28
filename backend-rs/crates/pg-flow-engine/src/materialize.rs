//! The spec-importer runtime: stored gateway flow JSON, flow validation and materialisation.
//!
//! Port of `core-back/engine/runtime/flowProvider.ts` (`PrismaFlowProvider`, `selectFlow`,
//! `toMimeContentType`, `resolveUrlTemplate`, `toFlowStep`) and the flow rules of
//! `core-back/engine/specImporter/specValidator.ts` (layer 2, offline).
//!
//! The stored shape is the Prisma row shape (`orderIndex`, `urlTemplate`, `contentType`,
//! `sideEffect`, `retryPolicy`, `pointOfNoReturn`, `idempotencyConfig`, `successCheck`,
//! `canonicalStatus`, ...). snake_case aliases are accepted so an AI-authored spec can be fed in
//! directly for a dry run.
//!
//! The materialiser resolves `{api}`/`{{api}}` base URLs, maps a content-type enum name to a MIME
//! string, carries a COMPUTE operation / RENDER action in the `method` column (the datamodel has no
//! dedicated column), and attaches the phase's status rules to every step exactly like the TS
//! projection.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::error::EngineError;
use crate::ports::{Attempt, FlowProvider};
use crate::schema::{
    Assertion, AssertionOp, BranchStep, ClientAction, ComputeStep, FlowPhase, FlowStep, HttpMethod,
    IdempotencyConfig, IdempotencyMode, OutputStore, ParameterPlace, ParameterSource, RenderStep,
    RetryPolicy, SideEffect, StatusRule, StepOutput, StepParameter, StepType, WaitStep,
};
use crate::transform::TransformPipe;

const CONTENT_TYPE_MIME: [(&str, &str); 6] = [
    ("APPLICATION_JSON", "application/json"),
    (
        "APPLICATION_FORM_URLENCODED",
        "application/x-www-form-urlencoded",
    ),
    ("MULTIPART_FORM_DATA", "multipart/form-data"),
    ("APPLICATION_XML", "application/xml"),
    ("TEXT_XML", "text/xml"),
    ("TEXT_PLAIN", "text/plain"),
];

const CLIENT_ACTIONS: [&str; 5] = [
    "SHOW_OTP_FORM",
    "HTTP_REDIRECT",
    "RENDER_EMBEDDED",
    "SHOW_QR_OR_CODE",
    "SHOW_PUSH_OR_TRANSFER",
];

/// A stored flow row (`flows`) with its steps (`flow_steps`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredFlow {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub rail_id: Option<String>,
    #[serde(default, alias = "sub_mode")]
    pub sub_mode: Option<String>,
    pub phase: String,
    #[serde(default)]
    pub steps: Vec<StoredFlowStep>,
}

/// One `flow_steps` row.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredFlowStep {
    pub id: String,
    #[serde(default, alias = "order_index")]
    pub order_index: i64,
    #[serde(rename = "type")]
    pub step_type: String,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default, alias = "url_template")]
    pub url_template: Option<String>,
    #[serde(default, alias = "content_type")]
    pub content_type: Option<String>,
    #[serde(default, alias = "xml_template")]
    pub xml_template: Option<String>,
    #[serde(default, alias = "timeout_ms")]
    pub timeout_ms: Option<u64>,
    #[serde(default, alias = "side_effect")]
    pub side_effect: Option<String>,
    #[serde(default, alias = "retry_policy")]
    pub retry_policy: Option<String>,
    #[serde(default, alias = "point_of_no_return")]
    pub point_of_no_return: Option<bool>,
    #[serde(default, alias = "idempotency_config")]
    pub idempotency_config: Option<StoredIdempotency>,
    #[serde(default)]
    pub parameters: Vec<StoredStepParameter>,
    #[serde(default)]
    pub outputs: Vec<StoredStepOutput>,
    #[serde(default, alias = "success_check")]
    pub success_check: Option<Vec<StoredAssertion>>,
    #[serde(default)]
    pub compute: Option<StoredCompute>,
    #[serde(default)]
    pub render: Option<StoredRender>,
    #[serde(default)]
    pub wait: Option<StoredWait>,
    #[serde(default)]
    pub assertions: Option<Vec<StoredAssertion>>,
    #[serde(default)]
    pub branch: Option<StoredBranch>,
    #[serde(default, alias = "max_attempts")]
    pub max_attempts: Option<u32>,
    #[serde(default, alias = "retry_delay_ms")]
    pub retry_delay_ms: Option<u64>,
}

/// A `step_parameters` row.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredStepParameter {
    pub place: String,
    pub key: String,
    pub source: String,
    #[serde(default)]
    pub selector: Option<String>,
    #[serde(default, alias = "constant_value")]
    pub constant_value: Option<Value>,
    #[serde(default, alias = "crypto_profile_id")]
    pub crypto_profile_id: Option<String>,
    #[serde(default)]
    pub transforms: Vec<TransformPipe>,
}

/// A `step_outputs` row.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredStepOutput {
    pub name: String,
    #[serde(default)]
    pub selector: Option<String>,
    #[serde(default)]
    pub transforms: Vec<TransformPipe>,
    #[serde(default, alias = "store_as")]
    pub store_as: Option<String>,
    #[serde(default)]
    pub required: Option<bool>,
}

/// A `status_rules` row.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredStatusRule {
    #[serde(default)]
    pub phase: Option<String>,
    pub selector: String,
    #[serde(default)]
    pub op: Option<String>,
    #[serde(default, alias = "value_json", alias = "value")]
    pub value_json: Option<Value>,
    #[serde(default, alias = "canonical_status")]
    pub canonical_status: Option<String>,
    #[serde(default, alias = "canonical_substatus")]
    pub canonical_substatus: Option<String>,
    #[serde(default, alias = "canonical_error")]
    pub canonical_error: Option<String>,
}

/// A stored assertion (`success_check` JSON or a step assertion).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredAssertion {
    pub selector: String,
    #[serde(default)]
    pub op: Option<String>,
    #[serde(default)]
    pub value: Option<Value>,
}

/// The `idempotencyConfig` JSON column.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredIdempotency {
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default, alias = "key_name")]
    pub key_name: Option<String>,
    #[serde(default, alias = "source_template")]
    pub source_template: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredCompute {
    pub name: String,
    #[serde(default)]
    pub input: Option<Value>,
    #[serde(default)]
    pub transforms: Vec<TransformPipe>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredRender {
    pub action: String,
    #[serde(default)]
    pub values: Option<Map<String, Value>>,
    #[serde(default)]
    pub transforms: Vec<TransformPipe>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredWait {
    #[serde(default, alias = "duration_ms")]
    pub duration_ms: Option<u64>,
    #[serde(default)]
    pub event: Option<String>,
    #[serde(default, alias = "timeout_ms")]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredBranch {
    pub selector: String,
    #[serde(default)]
    pub op: Option<String>,
    #[serde(default)]
    pub value: Option<Value>,
    #[serde(default, alias = "then_step_id")]
    pub then_step_id: Option<String>,
    #[serde(default, alias = "else_step_id")]
    pub else_step_id: Option<String>,
}

/// One materialised flow.
#[derive(Debug, Clone, PartialEq)]
pub struct MaterializedFlow {
    pub phase: FlowPhase,
    pub rail_id: Option<String>,
    pub sub_mode: Option<String>,
    pub steps: Vec<FlowStep>,
}

/// The materialised flow set of one stored gateway version.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MaterializedGatewayFlow {
    flows: Vec<MaterializedFlow>,
}

impl MaterializedGatewayFlow {
    /// Materialises every stored flow, refusing any flow-level error.
    pub fn build(
        flows: &[StoredFlow],
        status_rules: &[StoredStatusRule],
        base_urls: &BTreeMap<String, String>,
    ) -> Result<Self, SpecValidation> {
        let mut materialised = Vec::with_capacity(flows.len());
        for flow in flows {
            match materialize_flow(flow, status_rules, base_urls) {
                Ok(value) => materialised.push(value),
                Err(diagnostics) => {
                    return Err(SpecValidation {
                        valid: false,
                        errors: diagnostics,
                        warnings: Vec::new(),
                    })
                }
            }
        }
        Ok(Self {
            flows: materialised,
        })
    }

    /// Parses `{ flows: [...], statusRules: [...] }` and materialises it.
    pub fn from_json(
        value: &Value,
        base_urls: &BTreeMap<String, String>,
    ) -> Result<Self, SpecValidation> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Document {
            flows: Vec<StoredFlow>,
            #[serde(default, alias = "status_rules")]
            status_rules: Vec<StoredStatusRule>,
        }
        let document: Document = serde_json::from_value(value.clone()).map_err(|error| {
            SpecValidation::single(
                "flows",
                "INVALID_STORED_FLOW",
                format!("The stored flow JSON is invalid: {error}"),
                "Use the Prisma row shape: flows[].phase/steps[].id/type/urlTemplate/parameters.",
            )
        })?;
        Self::build(&document.flows, &document.status_rules, base_urls)
    }

    /// Every materialised flow.
    #[must_use]
    pub fn flows(&self) -> &[MaterializedFlow] {
        &self.flows
    }

    /// Selects the flow for a rail and sub-mode, with the `selectFlow` precedence: rail+subMode,
    /// rail+null, null+subMode, null+null.
    #[must_use]
    pub fn select(
        &self,
        phase: FlowPhase,
        rail_id: Option<&str>,
        sub_mode: Option<&str>,
    ) -> Option<&MaterializedFlow> {
        let candidates: Vec<&MaterializedFlow> = self
            .flows
            .iter()
            .filter(|flow| flow.phase == phase)
            .filter(|flow| flow.rail_id.as_deref() == rail_id || flow.rail_id.is_none())
            .collect();
        let rail_match = |flow: &&MaterializedFlow, sub: Option<&str>| {
            flow.rail_id.as_deref() == rail_id && flow.sub_mode.as_deref() == sub
        };
        let generic_match = |flow: &&MaterializedFlow, sub: Option<&str>| {
            flow.rail_id.is_none() && flow.sub_mode.as_deref() == sub
        };
        candidates
            .iter()
            .find(|flow| rail_match(flow, sub_mode))
            .or_else(|| candidates.iter().find(|flow| rail_match(flow, None)))
            .or_else(|| candidates.iter().find(|flow| generic_match(flow, sub_mode)))
            .or_else(|| candidates.iter().find(|flow| generic_match(flow, None)))
            .copied()
    }
}

#[async_trait]
impl FlowProvider for MaterializedGatewayFlow {
    async fn get_steps(
        &self,
        phase: FlowPhase,
        attempt: &Attempt,
    ) -> Result<Vec<FlowStep>, EngineError> {
        Ok(self
            .select(
                phase,
                attempt.rail_id.as_deref(),
                attempt.sub_mode.as_deref(),
            )
            .map(|flow| flow.steps.clone())
            .unwrap_or_default())
    }
}

/// One materialisation diagnostic (`SpecDiagnostic`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpecDiagnostic {
    pub path: String,
    pub code: String,
    pub message: String,
    pub ai_fix_hint: String,
}

impl SpecDiagnostic {
    fn error(
        path: impl Into<String>,
        code: &'static str,
        message: impl Into<String>,
        hint: impl Into<String>,
    ) -> Self {
        Self {
            path: path.into(),
            code: code.to_owned(),
            message: message.into(),
            ai_fix_hint: hint.into(),
        }
    }

    fn warning(
        path: impl Into<String>,
        code: &'static str,
        message: impl Into<String>,
        hint: impl Into<String>,
    ) -> Self {
        Self {
            path: path.into(),
            code: code.to_owned(),
            message: message.into(),
            ai_fix_hint: hint.into(),
        }
    }
}

/// `SpecSemanticResult`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SpecValidation {
    pub valid: bool,
    pub errors: Vec<SpecDiagnostic>,
    pub warnings: Vec<SpecDiagnostic>,
}

impl SpecValidation {
    #[must_use]
    pub fn single(
        path: impl Into<String>,
        code: &'static str,
        message: impl Into<String>,
        hint: impl Into<String>,
    ) -> Self {
        Self {
            valid: false,
            errors: vec![SpecDiagnostic::error(path, code, message, hint)],
            warnings: Vec::new(),
        }
    }
}

/// Materialises one stored flow.
pub fn materialize_flow(
    flow: &StoredFlow,
    status_rules: &[StoredStatusRule],
    base_urls: &BTreeMap<String, String>,
) -> Result<MaterializedFlow, Vec<SpecDiagnostic>> {
    let phase =
        FlowPhase::parse(&flow.phase).ok_or_else(|| {
            vec![SpecDiagnostic::error(
            "flows[].phase",
            "UNKNOWN_FLOW_PHASE",
            format!("The flow phase '{}' is not one of the engine phases.", flow.phase),
            "Use CREDENTIAL_CHECK, PRE_INITIATE, INITIATE, SUBMIT, VERIFY, CANCEL, REFUND or VOID.",
        )]
        })?;
    let mut errors = Vec::new();
    let mut steps = Vec::with_capacity(flow.steps.len());
    // `PrismaFlowProvider` queries the status rules of the phase; a rule without a phase is
    // applied to every phase (the stored rows always carry it).
    let phase_rules: Vec<&StoredStatusRule> = status_rules
        .iter()
        .filter(|rule| {
            rule.phase
                .as_deref()
                .is_none_or(|rule_phase| rule_phase == flow.phase)
        })
        .collect();
    for (index, stored) in flow.steps.iter().enumerate() {
        match materialize_step(stored, &phase_rules, base_urls) {
            Ok(step) => steps.push(step),
            Err(mut diagnostics) => {
                for diagnostic in &mut diagnostics {
                    diagnostic.path =
                        format!("flows[{}].steps[{index}]{}", flow.phase, diagnostic.path);
                }
                errors.append(&mut diagnostics);
            }
        }
    }
    if !errors.is_empty() {
        return Err(errors);
    }
    Ok(MaterializedFlow {
        phase,
        rail_id: flow.rail_id.clone(),
        sub_mode: flow.sub_mode.clone(),
        steps,
    })
}

fn materialize_step(
    stored: &StoredFlowStep,
    status_rules: &[&StoredStatusRule],
    base_urls: &BTreeMap<String, String>,
) -> Result<FlowStep, Vec<SpecDiagnostic>> {
    let mut errors = Vec::new();
    let step_type = StepType::parse(&stored.step_type).or_else(|| {
        // A blank/unknown type is an error, but keep parsing to report every field.
        errors.push(SpecDiagnostic::error(
            ".type",
            "UNKNOWN_STEP_TYPE",
            format!("The step type '{}' is unknown.", stored.step_type),
            "Use HTTP, COMPUTE, RENDER, WAIT, ASSERT or BRANCH.",
        ));
        None
    });
    let Some(step_type) = step_type else {
        return Err(errors);
    };
    let method = stored.method.clone();
    let mut step = FlowStep {
        id: stored.id.clone(),
        step_type,
        order_index: u32::try_from(stored.order_index.max(0)).unwrap_or(u32::MAX),
        method: method.as_deref().and_then(HttpMethod::parse),
        url_template: resolve_url_template(stored.url_template.as_deref(), base_urls),
        content_type: to_mime_content_type(stored.content_type.as_deref()),
        xml_template: stored.xml_template.clone(),
        timeout_ms: stored.timeout_ms,
        side_effect: stored
            .side_effect
            .as_deref()
            .and_then(SideEffect::parse)
            .unwrap_or(SideEffect::ReadOnly),
        retry_policy: stored
            .retry_policy
            .as_deref()
            .and_then(RetryPolicy::parse)
            .unwrap_or(RetryPolicy::Safe),
        point_of_no_return: stored.point_of_no_return.unwrap_or(false),
        idempotency_config: stored
            .idempotency_config
            .as_ref()
            .map(|config| IdempotencyConfig {
                mode: match config.mode.as_deref().unwrap_or("NONE") {
                    "HEADER" => IdempotencyMode::Header,
                    "BODY_FIELD" => IdempotencyMode::BodyField,
                    _ => IdempotencyMode::None,
                },
                key_name: config.key_name.clone(),
                source_template: config.source_template.clone(),
            })
            .unwrap_or_default(),
        parameters: Vec::new(),
        outputs: Vec::new(),
        success_check: stored
            .success_check
            .as_deref()
            .unwrap_or_default()
            .iter()
            .filter_map(|assertion| to_assertion(assertion, &mut errors, ".success_check"))
            .collect(),
        status_rules: status_rules
            .iter()
            .filter_map(|rule| to_status_rule(rule, &mut errors))
            .collect(),
        compute: None,
        render: None,
        wait: None,
        assertions: stored
            .assertions
            .as_deref()
            .unwrap_or_default()
            .iter()
            .filter_map(|assertion| to_assertion(assertion, &mut errors, ".assertions"))
            .collect(),
        branch: None,
        max_attempts: stored.max_attempts,
        retry_delay_ms: stored.retry_delay_ms,
    };

    for (index, parameter) in stored.parameters.iter().enumerate() {
        let place = ParameterPlace::parse(&parameter.place);
        let source = ParameterSource::parse(&parameter.source);
        let (Some(place), Some(source)) = (place, source) else {
            errors.push(SpecDiagnostic::error(
                format!(".parameters[{index}]"),
                "INVALID_STEP_PARAMETER",
                format!(
                    "The parameter '{}' has an unknown place '{}' or source '{}'.",
                    parameter.key, parameter.place, parameter.source
                ),
                "Use one of the seven places (HEADERS, QUERY, PATH, BODY, FORM, MULTIPART, XML) and a declared source.",
            ));
            continue;
        };
        step.parameters.push(StepParameter {
            place,
            key: parameter.key.clone(),
            source,
            selector: parameter.selector.clone(),
            constant_value: parameter.constant_value.clone(),
            crypto_profile_id: parameter.crypto_profile_id.clone(),
            transforms: parameter.transforms.clone(),
        });
    }
    for (index, output) in stored.outputs.iter().enumerate() {
        let Some(store_as) = output.store_as.as_deref().and_then(OutputStore::parse) else {
            errors.push(SpecDiagnostic::error(
                format!(".outputs[{index}]"),
                "INVALID_OUTPUT_STORE",
                format!(
                    "The output '{}' has an unknown store '{}'.",
                    output.name,
                    output.store_as.as_deref().unwrap_or("")
                ),
                "Use STATE, PUBLIC, SETTLED_AMOUNT, PROVIDER_FEE, PROVIDER_REF or NETWORK_REF.",
            ));
            continue;
        };
        step.outputs.push(StepOutput {
            name: output.name.clone(),
            selector: output.selector.clone(),
            transforms: output.transforms.clone(),
            store_as,
            required: output.required.unwrap_or(false),
        });
    }

    if let Some(compute) = &stored.compute {
        step.compute = Some(ComputeStep {
            name: compute.name.clone(),
            input: compute.input.clone(),
            transforms: compute.transforms.clone(),
        });
    } else if step_type == StepType::Compute {
        if let Some(name) = method.as_deref().filter(|name| !name.is_empty()) {
            step.compute = Some(ComputeStep {
                name: name.to_owned(),
                input: None,
                transforms: Vec::new(),
            });
        }
    }
    if let Some(render) = &stored.render {
        match ClientAction::parse(&render.action) {
            Some(action) => {
                let mut values = render.values.clone().unwrap_or_default();
                values
                    .entry("actionType".to_owned())
                    .or_insert_with(|| Value::String(render.action.clone()));
                step.render = Some(RenderStep {
                    action,
                    values,
                    transforms: render.transforms.clone(),
                });
            }
            None => errors.push(SpecDiagnostic::error(
                ".render.action",
                "INVALID_RENDER_ACTION",
                format!("The render action '{}' is not one of the five client actions.", render.action),
                "Use SHOW_OTP_FORM, HTTP_REDIRECT, RENDER_EMBEDDED, SHOW_QR_OR_CODE or SHOW_PUSH_OR_TRANSFER.",
            )),
        }
    } else if step_type == StepType::Render {
        if let Some(action) = method
            .as_deref()
            .filter(|action| CLIENT_ACTIONS.contains(action))
            .and_then(ClientAction::parse)
        {
            step.render = Some(RenderStep::with_action_type(action));
        }
    }
    if let Some(wait) = &stored.wait {
        step.wait = Some(WaitStep {
            duration_ms: wait.duration_ms,
            event: wait.event.clone(),
            timeout_ms: wait.timeout_ms,
        });
    }
    if let Some(branch) = &stored.branch {
        let op = branch
            .op
            .as_deref()
            .and_then(AssertionOp::parse)
            .unwrap_or(AssertionOp::Exists);
        step.branch = Some(BranchStep {
            selector: branch.selector.clone(),
            op,
            value: branch.value.clone(),
            then_step_id: branch.then_step_id.clone(),
            else_step_id: branch.else_step_id.clone(),
        });
    }

    if errors.is_empty() {
        Ok(step)
    } else {
        Err(errors)
    }
}

fn to_assertion(
    stored: &StoredAssertion,
    errors: &mut Vec<SpecDiagnostic>,
    path: &str,
) -> Option<Assertion> {
    let Some(op) = stored.op.as_deref().and_then(AssertionOp::parse) else {
        errors.push(SpecDiagnostic::error(
            path,
            "INVALID_ASSERTION_OP",
            format!(
                "The assertion on '{}' has an unknown operator '{}'.",
                stored.selector,
                stored.op.as_deref().unwrap_or("")
            ),
            "Use equals, not_equals, in, exists or matches.",
        ));
        return None;
    };
    Some(Assertion::new(
        stored.selector.clone(),
        op,
        stored.value.clone(),
    ))
}

fn to_status_rule(
    stored: &StoredStatusRule,
    errors: &mut Vec<SpecDiagnostic>,
) -> Option<StatusRule> {
    let status = stored
        .canonical_status
        .as_deref()
        .and_then(pg_domain_flow::CanonicalStepStatus::parse);
    let op = stored
        .op
        .as_deref()
        .and_then(AssertionOp::parse)
        .unwrap_or(AssertionOp::Exists);
    let Some(status) = status else {
        errors.push(SpecDiagnostic::error(
            "status_rules",
            "INVALID_CANONICAL_STATUS",
            format!(
                "The status rule on '{}' has an unknown canonical status '{}'.",
                stored.selector,
                stored.canonical_status.as_deref().unwrap_or("")
            ),
            "Use AWAITING_CUSTOMER, VERIFYING, SUCCEEDED, FAILED or UNKNOWN.",
        ));
        return None;
    };
    Some(StatusRule {
        selector: stored.selector.clone(),
        op,
        value: stored.value_json.clone(),
        canonical_status: status,
        canonical_substatus: stored.canonical_substatus.clone(),
        canonical_error: stored.canonical_error.clone(),
    })
}

/// `resolveUrlTemplate`: replaces named base URL placeholders and drops one trailing slash.
#[must_use]
pub fn resolve_url_template(
    template: Option<&str>,
    base_urls: &BTreeMap<String, String>,
) -> Option<String> {
    let template = template?;
    Some(crate::selector::render_template_with(
        template,
        |key| match base_urls.get(key) {
            Some(base) => Value::String(base.trim_end_matches('/').to_owned()),
            None => Value::String(format!("{{{key}}}")),
        },
    ))
}

/// `toMimeContentType`.
#[must_use]
pub fn to_mime_content_type(value: Option<&str>) -> Option<String> {
    let text = value?.trim();
    if text.is_empty() {
        return None;
    }
    let upper = text.to_ascii_uppercase();
    if let Some((_, mime)) = CONTENT_TYPE_MIME.iter().find(|(name, _)| *name == upper) {
        return Some((*mime).to_owned());
    }
    Some(text.to_ascii_lowercase())
}

/// The flow-level validation inputs (the parts of the integration spec the flow rules read).
#[derive(Debug, Clone)]
pub struct FlowValidationInput<'a> {
    pub flows: &'a [StoredFlow],
    pub base_urls: &'a BTreeMap<String, String>,
    pub rail_sub_modes: Option<&'a [String]>,
    pub collection_mode: Option<&'a str>,
    pub supports_idempotency_key: bool,
    pub crypto_profile_names: &'a [String],
    pub allowed_hosts: &'a [String],
}

impl<'a> FlowValidationInput<'a> {
    #[must_use]
    pub fn new(flows: &'a [StoredFlow], base_urls: &'a BTreeMap<String, String>) -> Self {
        Self {
            flows,
            base_urls,
            rail_sub_modes: None,
            collection_mode: None,
            supports_idempotency_key: false,
            crypto_profile_names: &[],
            allowed_hosts: &[],
        }
    }
}

/// Layer 2 of the verification pipeline: the offline flow rules of `validateSpecSemantics`.
#[must_use]
pub fn validate_flow_spec(input: &FlowValidationInput<'_>) -> SpecValidation {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    let base_url_names: Vec<&str> = input.base_urls.keys().map(String::as_str).collect();
    let mut step_ids: Vec<(String, String)> = Vec::new();
    let mut phases: Vec<FlowPhase> = Vec::new();

    for (flow_index, flow) in input.flows.iter().enumerate() {
        let flow_path = format!("flows[{flow_index}]");
        let Some(phase) = FlowPhase::parse(&flow.phase) else {
            errors.push(SpecDiagnostic::error(
                format!("{flow_path}.phase"),
                "UNKNOWN_FLOW_PHASE",
                format!("The flow phase '{}' is not an engine phase.", flow.phase),
                "Use CREDENTIAL_CHECK, PRE_INITIATE, INITIATE, SUBMIT, VERIFY, CANCEL, REFUND or VOID.",
            ));
            continue;
        };
        phases.push(phase);
        if let Some(sub_mode) = &flow.sub_mode {
            if let Some(declared) = input.rail_sub_modes {
                if !declared.iter().any(|candidate| candidate == sub_mode) {
                    errors.push(SpecDiagnostic::error(
                        format!("{flow_path}.sub_mode"),
                        "UNKNOWN_SUB_MODE",
                        format!("The sub_mode '{sub_mode}' is not listed in rail.sub_modes."),
                        format!(
                            "Use one of: {}, or add '{sub_mode}' to rail.sub_modes.",
                            declared.join(", ")
                        ),
                    ));
                }
            }
        }
        let mut ordered: Vec<&StoredFlowStep> = flow.steps.iter().collect();
        ordered.sort_by_key(|step| step.order_index);
        let mut saw_money = false;
        for (index, step) in ordered.iter().enumerate() {
            let path = format!("{flow_path}.steps[{index}]");
            let step_key = format!("{}:{}", flow.phase, step.id);
            if step_ids.iter().any(|(phase_key, _)| *phase_key == step_key) {
                errors.push(SpecDiagnostic::error(
                    format!("{path}.id"),
                    "DUPLICATE_STEP_ID",
                    format!(
                        "The step id '{}' is used twice in the {} phase.",
                        step.id, flow.phase
                    ),
                    "Give every step of a phase a unique id.",
                ));
            }
            step_ids.push((step_key, step.id.clone()));

            let step_type = StepType::parse(&step.step_type);
            let Some(step_type) = step_type else {
                errors.push(SpecDiagnostic::error(
                    format!("{path}.type"),
                    "UNKNOWN_STEP_TYPE",
                    format!("The step type '{}' is unknown.", step.step_type),
                    "Use HTTP, COMPUTE, RENDER, WAIT, ASSERT or BRANCH.",
                ));
                continue;
            };
            if !matches!(
                step_type,
                StepType::Http | StepType::Compute | StepType::Render
            ) {
                errors.push(SpecDiagnostic::error(
                    format!("{path}.type"),
                    "STEP_TYPE_NOT_IMPORTABLE",
                    format!("The {} step type cannot be imported from a spec yet.", step.step_type),
                    "Use an HTTP step (with an `assertions` list for ASSERT-like checks), a COMPUTE step, or a RENDER step. Add a WAIT / ASSERT / BRANCH step afterwards in the wizard's flow editor.",
                ));
            }
            if step_type == StepType::Compute
                && step
                    .compute
                    .as_ref()
                    .is_some_and(|compute| !compute.transforms.is_empty())
            {
                warnings.push(SpecDiagnostic::warning(
                    format!("{path}.compute.transforms"),
                    "COMPUTE_TRANSFORMS_NOT_PROJECTED",
                    "A COMPUTE step's transforms are not projected onto the stored flow yet.",
                    "Put the transforms on the step outputs instead, or add the COMPUTE transforms in the wizard afterwards.",
                ));
            }
            if step_type == StepType::Render
                && step.render.as_ref().is_some_and(|render| {
                    render
                        .values
                        .as_ref()
                        .is_some_and(|values| !values.is_empty())
                })
            {
                warnings.push(SpecDiagnostic::warning(
                    format!("{path}.render.values"),
                    "RENDER_VALUES_NOT_PROJECTED",
                    "A RENDER step's custom values are not projected onto the stored flow yet.",
                    "The render action is stored; set its values in the wizard afterwards if the defaults are not enough.",
                ));
            }
            for (parameter_index, parameter) in step.parameters.iter().enumerate() {
                let parameter_path = format!("{path}.parameters[{parameter_index}]");
                let Some(source) = ParameterSource::parse(&parameter.source) else {
                    errors.push(SpecDiagnostic::error(
                        format!("{parameter_path}.source"),
                        "INVALID_PARAMETER_SOURCE",
                        format!("The source '{}' is unknown.", parameter.source),
                        "Use one of the fourteen declared parameter sources.",
                    ));
                    continue;
                };
                if source == ParameterSource::PreviousResponse && index == 0 {
                    errors.push(SpecDiagnostic::error(
                        format!("{path}.parameters"),
                        "PREVIOUS_RESPONSE_ON_FIRST_STEP",
                        "The first step of a phase cannot read PREVIOUS_RESPONSE: there is no previous response yet.",
                        "Remove the PREVIOUS_RESPONSE parameter from the first step, or move that step after the request that produces the value.",
                    ));
                }
                if source == ParameterSource::CryptoSignature {
                    match &parameter.crypto_profile_id {
                        None => errors.push(SpecDiagnostic::error(
                            format!("{path}.parameters"),
                            "CRYPTO_PROFILE_MISSING",
                            "A CRYPTO_SIGNATURE parameter must name the crypto profile it uses.",
                            "Set crypto_profile_id to the id of one of the crypto_profiles.",
                        )),
                        Some(profile)
                            if !input
                                .crypto_profile_names
                                .iter()
                                .any(|name| name == profile) =>
                        {
                            errors.push(SpecDiagnostic::error(
                                format!("{path}.parameters"),
                                "UNKNOWN_CRYPTO_PROFILE",
                                format!("The crypto profile '{profile}' does not exist."),
                                format!(
                                    "Use one of: {}.",
                                    if input.crypto_profile_names.is_empty() {
                                        "(none declared)".to_owned()
                                    } else {
                                        input.crypto_profile_names.join(", ")
                                    }
                                ),
                            ));
                        }
                        _ => {}
                    }
                }
                if source.requires_selector()
                    && parameter.selector.as_deref().is_none_or(str::is_empty)
                {
                    warnings.push(SpecDiagnostic::warning(
                        format!("{path}.parameters"),
                        "SELECTOR_MISSING",
                        format!(
                            "The parameter '{}' of source {} has no selector.",
                            parameter.key, parameter.source
                        ),
                        "Add a selector (e.g. \"amount\", \"customer.phone\", \"process_id\").",
                    ));
                }
            }

            let side_effect = step
                .side_effect
                .as_deref()
                .and_then(SideEffect::parse)
                .unwrap_or(SideEffect::ReadOnly);
            let retry_policy = step
                .retry_policy
                .as_deref()
                .and_then(RetryPolicy::parse)
                .unwrap_or(RetryPolicy::Safe);
            if phase == FlowPhase::Verify && side_effect == SideEffect::MovesMoney {
                errors.push(SpecDiagnostic::error(
                    format!("{path}.side_effect"),
                    "VERIFY_MONEY_STEP_FORBIDDEN",
                    "The VERIFY flow is used by inquiry and must not move money.",
                    "Move the money-moving step to SUBMIT (or CONFIRM) and keep VERIFY read-only.",
                ));
            }
            if side_effect == SideEffect::MovesMoney {
                saw_money = true;
                let idempotent = step.idempotency_config.as_ref().is_some_and(|config| {
                    config.mode.as_deref().is_some_and(|mode| mode != "NONE")
                }) && input.supports_idempotency_key;
                if retry_policy != RetryPolicy::Never && !idempotent {
                    errors.push(SpecDiagnostic::error(
                        format!("{path}.retry_policy"),
                        "MOVES_MONEY_RETRY_NOT_NEVER",
                        "A MOVES_MONEY step must use retry_policy = \"NEVER\" unless the gateway proves an idempotency key.",
                        "Set retry_policy to \"NEVER\". If the gateway supports an idempotency key, set idempotency_config.mode to \"HEADER\" and settings.supports_idempotency_key to true.",
                    ));
                }
                if !step.point_of_no_return.unwrap_or(false) {
                    warnings.push(SpecDiagnostic::warning(
                        format!("{path}.point_of_no_return"),
                        "MOVES_MONEY_PONR_MISSING",
                        "A MOVES_MONEY step usually declares point_of_no_return = true.",
                        "Set point_of_no_return to true so a timeout is treated as UNKNOWN and never retried.",
                    ));
                }
            }

            if step_type == StepType::Http {
                match step.url_template.as_deref() {
                    None => errors.push(SpecDiagnostic::error(
                        format!("{path}.url_template"),
                        "URL_TEMPLATE_MISSING",
                        "An HTTP step needs a url_template.",
                        "Add url_template, e.g. \"{api}/verify\" (the {api} placeholder is resolved from environments.base_urls).",
                    )),
                    Some(template) => {
                        let path_parameters: Vec<&str> = step
                            .parameters
                            .iter()
                            .filter(|parameter| parameter.place.eq_ignore_ascii_case("PATH"))
                            .map(|parameter| parameter.key.as_str())
                            .collect();
                        for placeholder in url_placeholders(template) {
                            if !base_url_names.contains(&placeholder.as_str())
                                && !path_parameters.contains(&placeholder.as_str())
                            {
                                errors.push(SpecDiagnostic::error(
                                    format!("{path}.url_template"),
                                    "UNKNOWN_URL_PLACEHOLDER",
                                    format!(
                                        "The placeholder {{{placeholder}}} is neither a base URL name nor a PATH parameter."
                                    ),
                                    format!(
                                        "Use one of the base URL names ({}) or declare a PATH parameter with key \"{placeholder}\".",
                                        if base_url_names.is_empty() {
                                            "none".to_owned()
                                        } else {
                                            base_url_names.join(", ")
                                        }
                                    ),
                                ));
                            }
                        }
                        if template.starts_with("http://") || template.starts_with("https://") {
                            match url::Url::parse(template) {
                                Ok(parsed) => {
                                    if parsed.scheme() != "https" {
                                        errors.push(SpecDiagnostic::error(
                                            format!("{path}.url_template"),
                                            "INSECURE_URL_BLOCKED",
                                            "Only https:// URLs are allowed.",
                                            "Change the URL to https://.",
                                        ));
                                    }
                                    if let Some(host) = parsed.host_str() {
                                        if is_private_host(host) {
                                            errors.push(SpecDiagnostic::error(
                                                format!("{path}.url_template"),
                                                "PRIVATE_HOST_BLOCKED",
                                                format!("The host '{host}' is private or loopback."),
                                                "Use the provider's public https host.",
                                            ));
                                        }
                                    }
                                }
                                Err(_) => errors.push(SpecDiagnostic::error(
                                    format!("{path}.url_template"),
                                    "INVALID_URL",
                                    "The url_template is not a valid URL.",
                                    "Use a base-URL placeholder (e.g. {api}/path) instead of a hand-written URL.",
                                )),
                            }
                        }
                    }
                }
            }
            if step_type == StepType::Compute
                && step
                    .compute
                    .as_ref()
                    .is_none_or(|compute| compute.name.is_empty())
                && step.method.as_deref().is_none_or(str::is_empty)
            {
                errors.push(SpecDiagnostic::error(
                    format!("{path}.compute.name"),
                    "COMPUTE_NAME_MISSING",
                    "A COMPUTE step needs a registered compute operation name.",
                    "Set compute.name (or the method column) to one of the engine's registered compute operations.",
                ));
            }
            if step_type == StepType::Render {
                let has_action = step
                    .render
                    .as_ref()
                    .is_some_and(|render| !render.action.is_empty())
                    || step
                        .method
                        .as_deref()
                        .is_some_and(|method| CLIENT_ACTIONS.contains(&method));
                if !has_action {
                    errors.push(SpecDiagnostic::error(
                        format!("{path}.render.action"),
                        "RENDER_ACTION_MISSING",
                        "A RENDER step needs a render action.",
                        "Set render.action (or the method column) to one of the five ClientAction kinds.",
                    ));
                }
            }

            // Transform rules (closed library + monetary to_number).
            let pipeline = crate::transform::TransformPipeline::new(
                std::sync::Arc::new(crate::clock::FixedClock::at(0)),
                std::sync::Arc::new(crate::clock::CounterRng::new(1)),
            );
            let mut usages = Vec::new();
            for (parameter_index, parameter) in step.parameters.iter().enumerate() {
                usages.push(crate::transform::TransformUsage {
                    path: format!("{path}.parameters[{parameter_index}].transforms"),
                    pipes: parameter.transforms.clone(),
                    store_as: Some("STATE".to_owned()),
                });
            }
            for (output_index, output) in step.outputs.iter().enumerate() {
                usages.push(crate::transform::TransformUsage {
                    path: format!("{path}.outputs[{output_index}].transforms"),
                    pipes: output.transforms.clone(),
                    store_as: output.store_as.clone(),
                });
            }
            for error in crate::transform::validate_transform_usage(&pipeline, &usages) {
                errors.push(SpecDiagnostic::error(
                    error.path.clone().unwrap_or_else(|| path.clone()),
                    "INVALID_TRANSFORM",
                    format!("{}: {}", error.op, error.message),
                    "Use only an operation from the closed transform library, with the documented arguments.",
                ));
            }
            for output in &step.outputs {
                if output
                    .store_as
                    .as_deref()
                    .is_some_and(|store| matches!(store, "SETTLED_AMOUNT" | "PROVIDER_FEE"))
                    && output.transforms.iter().any(|pipe| pipe.op == "to_number")
                {
                    errors.push(SpecDiagnostic::error(
                        format!("{path}.outputs"),
                        "FLOAT_MONEY_FORBIDDEN",
                        "A monetary output cannot use to_number: money must stay an exact decimal.",
                        "Use scale / round / format_decimal instead of to_number for a settled amount or a fee.",
                    ));
                }
            }
        }
        if phase == FlowPhase::Submit && !saw_money {
            warnings.push(SpecDiagnostic::warning(
                format!("{flow_path}.steps"),
                "SUBMIT_WITHOUT_MONEY_STEP",
                "The SUBMIT flow has no MOVES_MONEY step, so the confirmation moves no money.",
                "Mark the step that captures / confirms the payment as side_effect = \"MOVES_MONEY\".",
            ));
        }
    }

    if !phases.contains(&FlowPhase::Initiate) {
        errors.push(SpecDiagnostic::error(
            "flows",
            "REQUIRED_PHASE_MISSING",
            "The INITIATE flow is required for every rail.",
            "Add a flows entry with phase = \"INITIATE\" and at least one step.",
        ));
    }
    if input
        .collection_mode
        .is_some_and(|mode| matches!(mode, "OTP_PULL" | "HYBRID"))
        && !phases.contains(&FlowPhase::Submit)
    {
        errors.push(SpecDiagnostic::error(
            "flows",
            "SUBMIT_PHASE_MISSING",
            "The OTP_PULL / HYBRID collection mode needs a SUBMIT flow.",
            "Add a flows entry with phase = \"SUBMIT\" that confirms the OTP / payment.",
        ));
    }

    // The allowlist is advisory here: the egress adapter enforces it. A literal host outside the
    // declared allowlist is refused early because the request could never be sent.
    if !input.allowed_hosts.is_empty() {
        for (flow_index, flow) in input.flows.iter().enumerate() {
            for (index, step) in flow.steps.iter().enumerate() {
                if let Some(template) = step.url_template.as_deref() {
                    if let Ok(parsed) = url::Url::parse(template) {
                        if let Some(host) = parsed.host_str() {
                            let host = host.trim_end_matches('.').to_ascii_lowercase();
                            if !input.allowed_hosts.iter().any(|allowed| {
                                allowed.trim_end_matches('.').eq_ignore_ascii_case(&host)
                            }) {
                                errors.push(SpecDiagnostic::error(
                                    format!("flows[{flow_index}].steps[{index}].url_template"),
                                    "HOST_NOT_ALLOWED",
                                    format!("The host '{host}' is not in allowed_hosts."),
                                    format!("Add \"{host}\" to allowed_hosts, or change the URL to an allowed host."),
                                ));
                            }
                        }
                    }
                }
            }
        }
    }

    SpecValidation {
        valid: errors.is_empty(),
        errors,
        warnings,
    }
}

fn url_placeholders(template: &str) -> Vec<String> {
    let mut names = Vec::new();
    let chars: Vec<char> = template.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        if chars[index] == '{' {
            let double = chars.get(index + 1) == Some(&'{');
            let open = if double { index + 2 } else { index + 1 };
            if let Some(offset) = chars[open..].iter().position(|character| *character == '}') {
                let name: String = chars[open..open + offset].iter().collect();
                if !name.is_empty()
                    && name.chars().all(|character| {
                        character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '-')
                    })
                    && !names.contains(&name)
                {
                    names.push(name);
                }
                index = open + offset + if double { 2 } else { 1 };
                continue;
            }
        }
        index += 1;
    }
    names
}

fn is_private_host(host: &str) -> bool {
    let host = host
        .trim()
        .to_ascii_lowercase()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_owned();
    if host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
    {
        return true;
    }
    host.parse::<std::net::IpAddr>()
        .map(|address| !pg_egress::is_public_ip(address))
        .unwrap_or(false)
}

/// Materialises and validates at once: the caller gets the diagnostics before anything is stored.
pub fn import_gateway_flow(
    flows: &[StoredFlow],
    status_rules: &[StoredStatusRule],
    base_urls: &BTreeMap<String, String>,
    validation: &FlowValidationInput<'_>,
) -> Result<MaterializedGatewayFlow, SpecValidation> {
    let result = validate_flow_spec(validation);
    if !result.valid {
        return Err(result);
    }
    MaterializedGatewayFlow::build(flows, status_rules, base_urls)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn base_urls() -> BTreeMap<String, String> {
        let mut urls = BTreeMap::new();
        urls.insert("api".to_owned(), "https://sandbox.provider.ly/".to_owned());
        urls.insert(
            "inquiry".to_owned(),
            "https://inquiry.provider.ly".to_owned(),
        );
        urls
    }

    fn stored_flow() -> StoredFlow {
        serde_json::from_value(json!({
            "phase": "INITIATE",
            "railId": "otp",
            "subMode": null,
            "steps": [
                {
                    "id": "send-otp",
                    "orderIndex": 0,
                    "type": "HTTP",
                    "method": "POST",
                    "urlTemplate": "{api}/verify",
                    "contentType": "APPLICATION_JSON",
                    "sideEffect": "SENDS_NOTIFICATION",
                    "retryPolicy": "SAFE_WITH_COOLDOWN",
                    "idempotencyConfig": { "mode": "NONE" },
                    "parameters": [
                        { "place": "BODY", "key": "amount", "source": "ATTEMPT", "selector": "totalChargedAmount" }
                    ],
                    "outputs": [
                        { "name": "process_id", "selector": "result.process_id", "storeAs": "STATE", "required": true }
                    ]
                },
                {
                    "id": "show-otp",
                    "orderIndex": 1,
                    "type": "RENDER",
                    "method": "SHOW_OTP_FORM"
                }
            ]
        }))
        .expect("stored flow")
    }

    fn status_rules() -> Vec<StoredStatusRule> {
        vec![serde_json::from_value(json!({
            "selector": "result.status",
            "op": "EQUALS",
            "valueJson": "OTP_SENT",
            "canonicalStatus": "AWAITING_CUSTOMER"
        }))
        .expect("status rule")]
    }

    #[test]
    fn materialisation_resolves_urls_and_carries_the_method() {
        let flow = materialize_flow(&stored_flow(), &status_rules(), &base_urls()).expect("flow");
        assert_eq!(flow.phase, FlowPhase::Initiate);
        assert_eq!(flow.steps.len(), 2);
        assert_eq!(
            flow.steps[0].url_template.as_deref(),
            Some("https://sandbox.provider.ly/verify")
        );
        assert_eq!(
            flow.steps[0].content_type.as_deref(),
            Some("application/json")
        );
        assert_eq!(flow.steps[0].side_effect, SideEffect::SendsNotification);
        assert_eq!(flow.steps[0].retry_policy, RetryPolicy::SafeWithCooldown);
        assert_eq!(flow.steps[0].status_rules.len(), 1);
        assert_eq!(
            flow.steps[1].render.as_ref().map(|render| render.action),
            Some(ClientAction::ShowOtpForm)
        );
    }

    #[test]
    fn flow_selection_follows_the_ts_precedence() {
        let flow = |rail: Option<&str>, sub: Option<&str>| MaterializedFlow {
            phase: FlowPhase::Initiate,
            rail_id: rail.map(str::to_owned),
            sub_mode: sub.map(str::to_owned),
            steps: Vec::new(),
        };
        let gateway = MaterializedGatewayFlow {
            flows: vec![
                flow(None, None),
                flow(None, Some("card")),
                flow(Some("rail-1"), None),
                flow(Some("rail-1"), Some("card")),
            ],
        };
        let pick = |rail: Option<&str>, sub: Option<&str>| {
            gateway
                .select(FlowPhase::Initiate, rail, sub)
                .map(|flow| (flow.rail_id.clone(), flow.sub_mode.clone()))
        };
        assert_eq!(
            pick(Some("rail-1"), Some("card")),
            Some((Some("rail-1".to_owned()), Some("card".to_owned())))
        );
        assert_eq!(
            pick(Some("rail-1"), Some("other")),
            Some((Some("rail-1".to_owned()), None))
        );
        assert_eq!(
            pick(Some("other"), Some("card")),
            Some((None, Some("card".to_owned())))
        );
        assert_eq!(pick(None, None), Some((None, None)));
    }

    #[test]
    fn mime_content_types_are_mapped_from_the_enum_name() {
        assert_eq!(
            to_mime_content_type(Some("APPLICATION_JSON")).as_deref(),
            Some("application/json")
        );
        assert_eq!(
            to_mime_content_type(Some("MULTIPART_FORM_DATA")).as_deref(),
            Some("multipart/form-data")
        );
        assert_eq!(
            to_mime_content_type(Some("Text/Plain")).as_deref(),
            Some("text/plain")
        );
        assert_eq!(to_mime_content_type(Some("  ")), None);
        assert_eq!(to_mime_content_type(None), None);
    }

    #[test]
    fn flow_validation_reports_the_layer_two_errors() {
        let mut flow = stored_flow();
        flow.steps[0].side_effect = Some("MOVES_MONEY".to_owned());
        flow.steps[0].retry_policy = Some("SAFE".to_owned());
        flow.steps[0].point_of_no_return = Some(false);
        let flows = vec![flow];
        let sub_modes = vec!["wallet".to_owned()];
        let profiles = vec!["profile-1".to_owned()];
        let input = FlowValidationInput {
            flows: &flows,
            base_urls: &base_urls(),
            rail_sub_modes: Some(&sub_modes),
            collection_mode: Some("OTP_PULL"),
            supports_idempotency_key: false,
            crypto_profile_names: &profiles,
            allowed_hosts: &[],
        };
        let result = validate_flow_spec(&input);
        assert!(!result.valid);
        let codes: Vec<&str> = result
            .errors
            .iter()
            .map(|error| error.code.as_str())
            .collect();
        assert!(codes.contains(&"MOVES_MONEY_RETRY_NOT_NEVER"));
        assert!(codes.contains(&"SUBMIT_PHASE_MISSING"));
        assert!(result
            .warnings
            .iter()
            .any(|warning| warning.code == "MOVES_MONEY_PONR_MISSING"));
    }

    #[test]
    fn verify_money_step_and_unknown_placeholder_are_refused() {
        let mut flow = stored_flow();
        flow.phase = "VERIFY".to_owned();
        flow.steps.truncate(1);
        flow.steps[0].side_effect = Some("MOVES_MONEY".to_owned());
        flow.steps[0].retry_policy = Some("NEVER".to_owned());
        flow.steps[0].url_template = Some("{nope}/verify".to_owned());
        let flows = vec![flow];
        let base_urls = base_urls();
        let input = FlowValidationInput::new(&flows, &base_urls);
        let result = validate_flow_spec(&input);
        let codes: Vec<&str> = result
            .errors
            .iter()
            .map(|error| error.code.as_str())
            .collect();
        assert!(codes.contains(&"VERIFY_MONEY_STEP_FORBIDDEN"));
        assert!(codes.contains(&"UNKNOWN_URL_PLACEHOLDER"));
        assert!(codes.contains(&"REQUIRED_PHASE_MISSING"));
    }

    #[test]
    fn json_documents_materialise() {
        let document = json!({
            "flows": [{
                "phase": "INITIATE",
                "railId": null,
                "steps": [{
                    "id": "create",
                    "orderIndex": 0,
                    "type": "HTTP",
                    "method": "POST",
                    "urlTemplate": "{api}/payment",
                    "contentType": "application/json"
                }]
            }],
            "statusRules": [{
                "selector": "status",
                "op": "EQUALS",
                "value": "SUCCESS",
                "canonicalStatus": "SUCCEEDED"
            }]
        });
        let flows = MaterializedGatewayFlow::from_json(&document, &base_urls()).expect("flows");
        assert_eq!(flows.flows().len(), 1);
        assert_eq!(flows.flows()[0].steps.len(), 1);
        assert_eq!(flows.flows()[0].steps[0].status_rules.len(), 1);
        let invalid = MaterializedGatewayFlow::from_json(&json!({"flows": "nope"}), &base_urls());
        assert!(invalid.is_err());
    }
}

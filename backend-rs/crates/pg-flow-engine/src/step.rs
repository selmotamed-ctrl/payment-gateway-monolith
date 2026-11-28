//! The step executor: HTTP, COMPUTE, RENDER, WAIT, ASSERT and BRANCH.
//!
//! Port of `core-back/engine/flow/StepExecutor.ts` (1,296 lines). The executor owns no I/O: the
//! outbound call goes through [`EgressPort`], secrets through [`SecretResolver`], compute operations
//! through [`ComputeRegistry`], sleeps through [`Clock`] and ids through [`Rng`].
//!
//! Reproduced behaviours that matter for a payment:
//!
//! - a `MOVES_MONEY` step never retries, and a timeout/5xx/missing-required-output becomes `UNKNOWN`,
//!   never `FAILED` (the money may have moved);
//! - a matched `status_rules` entry wins; an unmatched non-2xx is `FAILED` for a read-only step and
//!   `UNKNOWN` for a money step;
//! - `VERIFY` is read-only: a money-moving step in it is refused at run time;
//! - `to_number` is refused on a monetary output;
//! - the idempotency recipe injects the rendered key as a header or a body field;
//! - the scoped Fake Rails relaxation adds the merchant/credential/environment headers;
//! - PAN-named fields are deleted from the customer and state maps when the step returns.
//!
//! Recorded deviations (see `README.md`):
//!
//! - the egress response is available for every HTTP status (the TS executor has the same shape
//!   without an `ApiConsumer`; an `ApiConsumer` throws before the rule is evaluated);
//! - `NOW` is an RFC 3339 string (JSON has no `Date`); `format_date` accepts it;
//! - multipart fields are handed to the port, which owns the boundary and removes the explicit
//!   `content-type`, instead of a `FormData` object;
//! - the SSRF pre-flight uses `pg-egress` when a policy is configured; the port still validates.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::sync::Arc;

use async_trait::async_trait;
use chrono::Utc;
use rust_decimal::Decimal;
use serde_json::{Map, Value};

use crate::compute::{ComputeContext, ComputeRegistry};
use crate::crypto_profile::{sign_payload, signing_payload, CryptoProfileResolver};
use crate::error::{codes, EngineError};
use crate::ports::{
    Clock, EgressBody, EgressError, EgressPort, EgressRequest, EgressResponse, Rng,
};
use crate::schema::{
    self, Assertion, FlowPhase, FlowStep, HttpMethod, IdempotencyMode, OutputStore, ParameterPlace,
    ParameterSource, RetryPolicy, SideEffect, StepOutput, StepType,
};
use crate::selector::{
    self, assert_no_control_characters, compile_url, encode_for_destination, header_value,
    merge_maps, select, source_map, stringify_value, UrlOptions,
};
use crate::transform::{SecretResolver, TransformContext, TransformPipeline};

/// The maximum wait a `WAIT` step may declare (`24 * 60 * 60 * 1000`).
pub const MAX_WAIT_MS: u64 = 24 * 60 * 60 * 1000;

/// The default outbound timeout (`ApiConsumer` default).
pub const DEFAULT_TIMEOUT_MS: u64 = 15_000;

/// The execution context of one step (`StepExecutionContext`).
#[derive(Debug, Clone, Default)]
pub struct StepContext {
    pub phase: Option<FlowPhase>,
    pub gateway_meta: Map<String, Value>,
    pub route_meta: Map<String, Value>,
    pub credentials: Map<String, Value>,
    pub attempt: Map<String, Value>,
    pub customer_fields: Map<String, Value>,
    pub state: Map<String, Value>,
    pub previous_response: Option<Value>,
    pub urls: Map<String, Value>,
    pub client_context: Map<String, Value>,
    pub constants: Map<String, Value>,
    pub template_values: Map<String, Value>,
    pub pan_field_names: Vec<String>,
}

impl StepContext {
    /// The context of a flow phase. `attempt` is [`crate::ports::Attempt::context_map`].
    #[must_use]
    pub fn phase(phase: FlowPhase, attempt: Map<String, Value>) -> Self {
        Self {
            phase: Some(phase),
            attempt,
            ..Self::default()
        }
    }

    /// The roots a `{{path}}` template addresses (`contextTemplateRoots`).
    #[must_use]
    pub fn template_roots(&self) -> Map<String, Value> {
        let mut roots = Map::new();
        roots.insert("attempt".to_owned(), Value::Object(self.attempt.clone()));
        roots.insert(
            "customer".to_owned(),
            Value::Object(self.customer_fields.clone()),
        );
        roots.insert(
            "customerFields".to_owned(),
            Value::Object(self.customer_fields.clone()),
        );
        roots.insert("state".to_owned(), Value::Object(self.state.clone()));
        roots.insert(
            "previousResponse".to_owned(),
            self.previous_response
                .clone()
                .unwrap_or(Value::Object(Map::new())),
        );
        roots.insert(
            "gatewayMeta".to_owned(),
            Value::Object(self.gateway_meta.clone()),
        );
        roots.insert(
            "routeMeta".to_owned(),
            Value::Object(self.route_meta.clone()),
        );
        roots.insert(
            "credentials".to_owned(),
            Value::Object(self.credentials.clone()),
        );
        roots.insert("urls".to_owned(), Value::Object(self.urls.clone()));
        roots.insert(
            "clientContext".to_owned(),
            Value::Object(self.client_context.clone()),
        );
        roots.insert(
            "constants".to_owned(),
            Value::Object(self.constants.clone()),
        );
        roots
    }

    #[must_use]
    pub fn previous_or_state(&self) -> Value {
        self.previous_response
            .clone()
            .unwrap_or_else(|| Value::Object(self.state.clone()))
    }

    /// The compute registry's view of the context.
    #[must_use]
    pub fn compute_context(&self) -> ComputeContext {
        ComputeContext {
            attempt: self.attempt.clone(),
            credentials: self.credentials.clone(),
            state: self.state.clone(),
            customer_fields: self.customer_fields.clone(),
        }
    }
}

/// `StepOutputs`. Monetary values are decimals, never floats.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct StepOutputs {
    pub state: Map<String, Value>,
    pub public: Map<String, Value>,
    pub settled_amount: Option<Decimal>,
    pub provider_fee: Option<Decimal>,
    pub provider_reference: Option<String>,
    pub network_reference: Option<String>,
}

impl StepOutputs {
    fn is_present(&self, output: &StepOutput) -> bool {
        match output.store_as {
            OutputStore::State => self.state.contains_key(&output.name),
            OutputStore::Public => self.public.contains_key(&output.name),
            OutputStore::SettledAmount => self.settled_amount.is_some(),
            OutputStore::ProviderFee => self.provider_fee.is_some(),
            OutputStore::ProviderRef => self.provider_reference.is_some(),
            OutputStore::NetworkRef => self.network_reference.is_some(),
        }
    }
}

/// The branch outcome of a `BRANCH` step.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BranchOutcome {
    Then,
    Else,
}

impl BranchOutcome {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Then => "then",
            Self::Else => "else",
        }
    }
}

/// One redacted step log (`StepLog`).
#[derive(Debug, Clone, PartialEq)]
pub struct StepLog {
    pub step_id: String,
    pub step_type: StepType,
    pub outcome: String,
    pub http_status: Option<u16>,
    pub duration_ms: u64,
    pub request: Option<Value>,
    pub response: Option<Value>,
}

/// `StepExecutionResult`.
#[derive(Debug, Clone, PartialEq)]
pub struct StepExecutionResult {
    pub step_id: String,
    pub status: schema::CanonicalStepStatus,
    pub substatus: Option<String>,
    pub canonical_error: Option<String>,
    pub output: StepOutputs,
    pub response: Option<Value>,
    pub raw_text: Option<String>,
    pub branch: Option<BranchOutcome>,
    pub logs: Vec<StepLog>,
}

/// A custom `WAIT` implementation (an event wait).
#[async_trait]
pub trait WaitPort: Send + Sync {
    async fn wait(&self, definition: &schema::WaitStep) -> Result<(), EngineError>;
}

/// The executor options.
#[derive(Clone)]
pub struct StepExecutorOptions {
    /// The gateway version's host allowlist. `None` means "no executor-level list" (the egress
    /// adapter still enforces its own).
    pub allowed_hosts: Option<Vec<String>>,
    /// Explicit opt-out; with an empty list the HTTP request is refused by the URL compiler.
    pub allow_any_host: bool,
    /// Development-only plain HTTP (never set in production).
    pub allow_insecure_http: bool,
    /// The resolved Fake Rails scoped allowlist (`ALLOW_FAKE_RAILS_HOSTS` + `FAKE_RAILS_ALLOWED_HOSTS`).
    pub fake_rails_hosts: Vec<String>,
    pub literal_secrets: Vec<String>,
    pub pan_field_names: Vec<String>,
    pub max_response_bytes: usize,
    pub max_json_depth: usize,
    pub default_timeout_ms: u64,
    /// An optional `pg-egress` policy; when set, the resolved target is checked before the port and
    /// the pinned address is never used for a second DNS answer.
    pub egress_policy: Option<pg_egress::EgressPolicy>,
    pub resolver: Option<Arc<dyn pg_egress::Resolver + Send + Sync>>,
}

impl Default for StepExecutorOptions {
    fn default() -> Self {
        Self {
            allowed_hosts: None,
            allow_any_host: false,
            allow_insecure_http: false,
            fake_rails_hosts: Vec::new(),
            literal_secrets: Vec::new(),
            pan_field_names: Vec::new(),
            max_response_bytes: 2 * 1024 * 1024,
            max_json_depth: 64,
            default_timeout_ms: DEFAULT_TIMEOUT_MS,
            egress_policy: None,
            resolver: None,
        }
    }
}

/// The step executor.
#[derive(Clone)]
pub struct StepExecutor {
    egress: Arc<dyn EgressPort>,
    clock: Arc<dyn Clock>,
    rng: Arc<dyn Rng>,
    pipeline: TransformPipeline,
    compute: Option<Arc<dyn ComputeRegistry>>,
    profiles: Option<Arc<dyn CryptoProfileResolver>>,
    secrets: Option<Arc<dyn SecretResolver>>,
    waiter: Option<Arc<dyn WaitPort>>,
    options: StepExecutorOptions,
}

impl StepExecutor {
    #[must_use]
    pub fn new(egress: Arc<dyn EgressPort>, clock: Arc<dyn Clock>, rng: Arc<dyn Rng>) -> Self {
        let pipeline = TransformPipeline::new(clock.clone(), rng.clone());
        Self {
            egress,
            clock,
            rng,
            pipeline,
            compute: None,
            profiles: None,
            secrets: None,
            waiter: None,
            options: StepExecutorOptions::default(),
        }
    }

    #[must_use]
    pub fn with_options(mut self, options: StepExecutorOptions) -> Self {
        self.options = options;
        self
    }

    #[must_use]
    pub fn with_compute(mut self, compute: Arc<dyn ComputeRegistry>) -> Self {
        self.compute = Some(compute);
        self
    }

    #[must_use]
    pub fn with_crypto_profiles(mut self, profiles: Arc<dyn CryptoProfileResolver>) -> Self {
        self.profiles = Some(profiles);
        self
    }

    #[must_use]
    pub fn with_secrets(mut self, secrets: Arc<dyn SecretResolver>) -> Self {
        self.secrets = Some(secrets);
        self
    }

    #[must_use]
    pub fn with_waiter(mut self, waiter: Arc<dyn WaitPort>) -> Self {
        self.waiter = Some(waiter);
        self
    }

    #[must_use]
    pub fn pipeline(&self) -> &TransformPipeline {
        &self.pipeline
    }

    #[must_use]
    pub fn options(&self) -> &StepExecutorOptions {
        &self.options
    }

    /// Executes one step.
    pub async fn execute(
        &self,
        step: &FlowStep,
        context: &mut StepContext,
    ) -> Result<StepExecutionResult, EngineError> {
        let started = self.clock.now();
        let result = self.execute_inner(step, context, started).await;
        self.wipe_pan_fields(context);
        result
    }

    async fn execute_inner(
        &self,
        step: &FlowStep,
        context: &StepContext,
        started: chrono::DateTime<Utc>,
    ) -> Result<StepExecutionResult, EngineError> {
        if context.phase == Some(FlowPhase::Verify) && step.side_effect == SideEffect::MovesMoney {
            return Err(EngineError::new(
                400,
                codes::VERIFY_MONEY_STEP_FORBIDDEN,
                format!(
                    "Step '{}' moves money inside the read-only VERIFY flow",
                    step.id
                ),
            ));
        }
        match step.step_type {
            StepType::Http => self.execute_http(step, context, started).await,
            StepType::Compute => self.execute_compute_async(step, context, started).await,
            StepType::Render => self.execute_render(step, context, started),
            StepType::Wait => self.execute_wait(step, context, started).await,
            StepType::Assert => self.execute_assert(step, context, started),
            StepType::Branch => self.execute_branch(step, context, started),
        }
    }

    fn log(
        &self,
        step: &FlowStep,
        outcome: impl Into<String>,
        http_status: Option<u16>,
        started: chrono::DateTime<Utc>,
        request: Option<Value>,
        response: Option<Value>,
    ) -> StepLog {
        let duration_ms = (self.clock.now() - started).num_milliseconds().max(0) as u64;
        let literal: Vec<&str> = self
            .options
            .literal_secrets
            .iter()
            .map(String::as_str)
            .collect();
        StepLog {
            step_id: step.id.clone(),
            step_type: step.step_type,
            outcome: outcome.into(),
            http_status,
            duration_ms,
            request: request.map(|value| pg_crypto::redact_payload(&value, &literal)),
            response: response.map(|value| pg_crypto::redact_payload(&value, &literal)),
        }
    }

    async fn execute_http(
        &self,
        step: &FlowStep,
        context: &StepContext,
        started: chrono::DateTime<Utc>,
    ) -> Result<StepExecutionResult, EngineError> {
        let side_effect = step.side_effect;
        let retry_policy = step.retry_policy;
        let maximum_attempts = if side_effect == SideEffect::MovesMoney {
            1
        } else {
            step.max_attempts
                .unwrap_or(if retry_policy == RetryPolicy::Never {
                    1
                } else {
                    2
                })
                .max(1)
        };
        let mut attempt = 0;
        loop {
            attempt += 1;
            let request = self.build_http_request(step, context).await?;
            self.assert_url_allowed(&request.url)?;
            match self.send_http(&request).await {
                Ok(response) => {
                    if (300..400).contains(&response.status) {
                        return Ok(self.failed_result(
                            step,
                            "Outbound redirects are forbidden",
                            started,
                            Some(request.log_value()),
                            Some(Value::String(response.raw_text)),
                        ));
                    }
                    let can_retry_status = side_effect != SideEffect::MovesMoney
                        && retry_policy != RetryPolicy::Never
                        && attempt < maximum_attempts
                        && response.status >= 500;
                    if can_retry_status {
                        self.clock
                            .sleep_ms(step.retry_delay_ms.unwrap_or(250))
                            .await;
                        continue;
                    }
                    return self.finish_http(step, context, response, started, &request);
                }
                Err(error) => {
                    let money_uncertain =
                        side_effect == SideEffect::MovesMoney || step.point_of_no_return;
                    let can_retry = !money_uncertain
                        && retry_policy != RetryPolicy::Never
                        && attempt < maximum_attempts
                        && error.retryable;
                    if can_retry {
                        self.clock
                            .sleep_ms(step.retry_delay_ms.unwrap_or(250))
                            .await;
                        continue;
                    }
                    return Ok(self.failed_result(
                        step,
                        &error.message,
                        started,
                        Some(request.log_value()),
                        None,
                    ));
                }
            }
        }
    }

    fn failed_result(
        &self,
        step: &FlowStep,
        message: &str,
        started: chrono::DateTime<Utc>,
        request: Option<Value>,
        response: Option<Value>,
    ) -> StepExecutionResult {
        let status = if step.side_effect == SideEffect::MovesMoney || step.point_of_no_return {
            schema::CanonicalStepStatus::Unknown
        } else {
            schema::CanonicalStepStatus::Failed
        };
        let log = self.log(step, status.as_str(), None, started, request, response);
        StepExecutionResult {
            step_id: step.id.clone(),
            status,
            substatus: None,
            canonical_error: Some(message.to_owned()),
            output: StepOutputs::default(),
            response: None,
            raw_text: None,
            branch: None,
            logs: vec![log],
        }
    }

    fn finish_http(
        &self,
        step: &FlowStep,
        context: &StepContext,
        response: EgressResponse,
        started: chrono::DateTime<Utc>,
        request: &HttpRequest,
    ) -> Result<StepExecutionResult, EngineError> {
        if response.raw_text.len() > self.options.max_response_bytes {
            return Ok(self.failed_result(
                step,
                &format!(
                    "Gateway response exceeds {} bytes",
                    self.options.max_response_bytes
                ),
                started,
                Some(request.log_value()),
                None,
            ));
        }
        if json_depth(&response.data) > self.options.max_json_depth {
            return Ok(self.failed_result(
                step,
                &format!(
                    "JSON response exceeds depth {}",
                    self.options.max_json_depth
                ),
                started,
                Some(request.log_value()),
                Some(response.data),
            ));
        }
        if response.headers.iter().any(|(key, value)| {
            key.eq_ignore_ascii_case("content-type") && value.to_ascii_lowercase().contains("xml")
        }) && contains_xml_entity(&response.raw_text)
        {
            return Ok(self.failed_result(
                step,
                "XML DTD and external entities are forbidden",
                started,
                Some(request.log_value()),
                Some(Value::String(response.raw_text)),
            ));
        }
        let outputs =
            self.extract_outputs(step, &response.data, Some(&response.raw_text), context)?;
        let missing_required = step
            .outputs
            .iter()
            .any(|output| output.required && !outputs.is_present(output));
        let mapped = self.map_status(step, &response.data, response.status)?;
        let mut status = mapped.status;
        if step.side_effect == SideEffect::MovesMoney
            && !mapped.rule_matched
            && status == schema::CanonicalStepStatus::Failed
        {
            status = schema::CanonicalStepStatus::Unknown;
        }
        if step.side_effect == SideEffect::MovesMoney && missing_required {
            status = schema::CanonicalStepStatus::Unknown;
        }
        let log = self.log(
            step,
            status.as_str(),
            Some(response.status),
            started,
            Some(request.log_value()),
            Some(response.data.clone()),
        );
        Ok(StepExecutionResult {
            step_id: step.id.clone(),
            status,
            substatus: mapped.substatus,
            canonical_error: mapped.canonical_error,
            output: outputs,
            response: Some(response.data),
            raw_text: Some(response.raw_text),
            branch: None,
            logs: vec![log],
        })
    }

    async fn execute_compute_async(
        &self,
        step: &FlowStep,
        context: &StepContext,
        started: chrono::DateTime<Utc>,
    ) -> Result<StepExecutionResult, EngineError> {
        let definition = step.compute.as_ref().ok_or_else(|| {
            EngineError::new(
                400,
                codes::MISSING_COMPUTE_DEFINITION,
                "COMPUTE step requires a declarative compute definition",
            )
        })?;
        let registry = self.compute.as_ref().ok_or_else(|| {
            EngineError::new(
                400,
                codes::UNKNOWN_COMPUTE_OPERATION,
                format!("Compute operation '{}' is not registered", definition.name),
            )
        })?;
        let mut value = registry
            .compute(
                &definition.name,
                definition.input.as_ref().unwrap_or(&Value::Null),
                &context.compute_context(),
            )
            .await?;
        if !definition.transforms.is_empty() {
            let transform_context = TransformContext::with_values(&context.template_values);
            value = self
                .pipeline
                .apply(value, &definition.transforms, &transform_context)?;
        }
        let outputs = self.extract_outputs(step, &value, None, context)?;
        let log = self.log(step, "SUCCEEDED", None, started, None, Some(value.clone()));
        Ok(StepExecutionResult {
            step_id: step.id.clone(),
            status: schema::CanonicalStepStatus::Succeeded,
            substatus: None,
            canonical_error: None,
            output: outputs,
            response: Some(value),
            raw_text: None,
            branch: None,
            logs: vec![log],
        })
    }

    fn execute_render(
        &self,
        step: &FlowStep,
        context: &StepContext,
        started: chrono::DateTime<Utc>,
    ) -> Result<StepExecutionResult, EngineError> {
        let definition = step.render.as_ref().ok_or_else(|| {
            EngineError::new(
                400,
                codes::MISSING_RENDER_DEFINITION,
                "RENDER step requires a declarative render definition",
            )
        })?;
        let mut value = Value::Object(definition.values.clone());
        if !definition.transforms.is_empty() {
            let transform_context = TransformContext::with_values(&context.template_values);
            value = self
                .pipeline
                .apply(value, &definition.transforms, &transform_context)?;
        }
        let mut output = StepOutputs::default();
        if let Value::Object(map) = &value {
            output.public = map.clone();
        }
        let log = self.log(step, "SUCCEEDED", None, started, None, Some(value.clone()));
        Ok(StepExecutionResult {
            step_id: step.id.clone(),
            status: schema::CanonicalStepStatus::Succeeded,
            substatus: None,
            canonical_error: None,
            output,
            response: Some(value),
            raw_text: None,
            branch: None,
            logs: vec![log],
        })
    }

    async fn execute_wait(
        &self,
        step: &FlowStep,
        _context: &StepContext,
        started: chrono::DateTime<Utc>,
    ) -> Result<StepExecutionResult, EngineError> {
        let definition = step.wait.clone().unwrap_or_default();
        if let Some(waiter) = &self.waiter {
            waiter.wait(&definition).await?;
        } else if let Some(duration) = definition.duration_ms {
            if duration > MAX_WAIT_MS {
                return Err(EngineError::new(
                    400,
                    codes::INVALID_WAIT_DURATION,
                    "Wait duration is outside the allowed range",
                ));
            }
            self.clock.sleep_ms(duration).await;
        }
        let log = self.log(step, "SUCCEEDED", None, started, None, None);
        Ok(StepExecutionResult {
            step_id: step.id.clone(),
            status: schema::CanonicalStepStatus::Succeeded,
            substatus: None,
            canonical_error: None,
            output: StepOutputs::default(),
            response: None,
            raw_text: None,
            branch: None,
            logs: vec![log],
        })
    }

    fn execute_assert(
        &self,
        step: &FlowStep,
        context: &StepContext,
        started: chrono::DateTime<Utc>,
    ) -> Result<StepExecutionResult, EngineError> {
        let source = context.previous_or_state();
        let assertions: &[Assertion] = if step.assertions.is_empty() {
            &step.success_check
        } else {
            &step.assertions
        };
        for assertion in assertions {
            if !selector::evaluate_assertion(assertion, &source)? {
                return Err(EngineError::new(
                    400,
                    codes::STEP_ASSERTION_FAILED,
                    format!("Assertion failed at '{}'", assertion.selector),
                ));
            }
        }
        let log = self.log(step, "SUCCEEDED", None, started, None, Some(source));
        Ok(StepExecutionResult {
            step_id: step.id.clone(),
            status: schema::CanonicalStepStatus::Succeeded,
            substatus: None,
            canonical_error: None,
            output: StepOutputs::default(),
            response: None,
            raw_text: None,
            branch: None,
            logs: vec![log],
        })
    }

    fn execute_branch(
        &self,
        step: &FlowStep,
        context: &StepContext,
        started: chrono::DateTime<Utc>,
    ) -> Result<StepExecutionResult, EngineError> {
        let branch = step.branch.as_ref().ok_or_else(|| {
            EngineError::new(
                400,
                codes::MISSING_BRANCH_DEFINITION,
                "BRANCH step requires a declarative branch definition",
            )
        })?;
        let matched = selector::evaluate_assertion(
            &Assertion::new(branch.selector.clone(), branch.op, branch.value.clone()),
            &context.previous_or_state(),
        )?;
        let outcome = if matched {
            BranchOutcome::Then
        } else {
            BranchOutcome::Else
        };
        let log = self.log(step, outcome.as_str(), None, started, None, None);
        Ok(StepExecutionResult {
            step_id: step.id.clone(),
            status: schema::CanonicalStepStatus::Succeeded,
            substatus: None,
            canonical_error: None,
            output: StepOutputs::default(),
            response: None,
            raw_text: None,
            branch: Some(outcome),
            logs: vec![log],
        })
    }

    async fn build_http_request(
        &self,
        step: &FlowStep,
        context: &StepContext,
    ) -> Result<HttpRequest, EngineError> {
        let template = step.url_template.as_ref().ok_or_else(|| {
            EngineError::new(
                400,
                codes::MISSING_STEP_URL,
                "HTTP step requires a URL template",
            )
        })?;
        let mut headers: BTreeMap<String, String> = BTreeMap::new();
        let mut query: Map<String, Value> = Map::new();
        let mut path_parameters: Map<String, Value> = Map::new();
        let mut body = Value::Object(Map::new());
        let mut has_body = false;
        let mut form: Vec<(String, String)> = Vec::new();
        let mut multipart: Vec<(String, String)> = Vec::new();
        let mut xml = step.xml_template.clone().unwrap_or_default();

        for parameter in &step.parameters {
            let mut value = if parameter.source == ParameterSource::CryptoSignature
                && parameter.crypto_profile_id.is_some()
            {
                self.resolve_crypto_signature(parameter, context)?
            } else {
                self.select_parameter(parameter, context)?
            };
            if !parameter.transforms.is_empty() {
                let transform_context = TransformContext::with_values(&context.template_values);
                value = self
                    .pipeline
                    .apply(value, &parameter.transforms, &transform_context)?;
            }
            if value.is_null() {
                continue;
            }
            match parameter.place {
                ParameterPlace::Headers => {
                    let text = header_value(&value)?;
                    headers.insert(parameter.key.to_ascii_lowercase(), text);
                }
                ParameterPlace::Query => {
                    let map = source_map(&parameter.key, value)?;
                    merge_maps(&mut query, map);
                }
                ParameterPlace::Path => {
                    path_parameters.insert(parameter.key.clone(), value);
                }
                ParameterPlace::Body => {
                    let addition = source_map(&parameter.key, value)?;
                    if let Value::Object(current) = &mut body {
                        merge_maps(current, addition);
                    } else {
                        body = Value::Object(addition);
                    }
                    has_body = true;
                }
                ParameterPlace::Form => {
                    form.push((parameter.key.clone(), stringify_value(&value)));
                }
                ParameterPlace::Multipart => {
                    multipart.push((parameter.key.clone(), stringify_value(&value)));
                }
                ParameterPlace::Xml => {
                    xml = xml.replace(
                        &format!("{{{{{}}}}}", parameter.key),
                        &encode_for_destination(&value, "XML"),
                    );
                }
            }
        }

        if let Some(idempotency) = self.resolve_idempotency(step, context)? {
            match idempotency.mode {
                IdempotencyMode::Header => {
                    assert_no_control_characters(&idempotency.value, "header")?;
                    headers.insert(idempotency.key_name.to_ascii_lowercase(), idempotency.value);
                }
                IdempotencyMode::BodyField => {
                    let mut addition = Map::new();
                    addition.insert(
                        idempotency.key_name.clone(),
                        Value::String(idempotency.value.clone()),
                    );
                    if let Value::Object(current) = &mut body {
                        current.extend(addition);
                    } else {
                        body = Value::Object(addition);
                    }
                    has_body = true;
                    if step
                        .content_type
                        .as_deref()
                        .is_some_and(|content_type| content_type.contains("x-www-form-urlencoded"))
                    {
                        form.push((idempotency.key_name, idempotency.value));
                    }
                }
                IdempotencyMode::None => {}
            }
        }

        let method = step.method.unwrap_or_default();
        let sends_body = method.sends_body();
        let mut request_body = None;
        if sends_body {
            let content_type = step.content_type.as_deref().unwrap_or("");
            if content_type.contains("json") {
                let encoded = if has_body {
                    body.clone()
                } else {
                    Value::Object(Map::new())
                };
                request_body = Some(EgressBody::Text(
                    serde_json::to_string(&encoded).unwrap_or_else(|_| "{}".to_owned()),
                ));
                headers
                    .entry("content-type".to_owned())
                    .or_insert_with(|| content_type.to_owned());
            } else if content_type.contains("x-www-form-urlencoded") {
                request_body = Some(EgressBody::Form(form));
                headers
                    .entry("content-type".to_owned())
                    .or_insert_with(|| content_type.to_owned());
            } else if content_type.contains("multipart") {
                request_body = Some(EgressBody::Multipart(multipart));
                headers.remove("content-type");
            } else if content_type.contains("xml") {
                request_body = Some(EgressBody::Text(xml));
                headers
                    .entry("content-type".to_owned())
                    .or_insert_with(|| content_type.to_owned());
            } else if has_body {
                request_body = Some(EgressBody::Text(
                    serde_json::to_string(&body).unwrap_or_else(|_| "{}".to_owned()),
                ));
                headers
                    .entry("content-type".to_owned())
                    .or_insert_with(|| "application/json".to_owned());
            }
        }

        // Resolve the URL once to detect the scoped Fake Rails target, then apply the real policy.
        let probe_options = UrlOptions {
            allowed_hosts: None,
            require_https: false,
            allow_any_host: true,
            allow_private_hosts: true,
            allow_fragment: false,
            allow_insecure_http: true,
        };
        let resolved = compile_url(template, &query, &path_parameters, &probe_options)?;
        let host = url::Url::parse(&resolved)
            .ok()
            .and_then(|url| url.host_str().map(str::to_owned))
            .unwrap_or_default();
        let fake_rails = self.is_fake_rails_host(&host);
        if fake_rails {
            let merchant_id = context
                .attempt
                .get("merchantId")
                .map(stringify_value)
                .unwrap_or_default();
            let credential_set_id = context
                .attempt
                .get("credentialSetId")
                .map(stringify_value)
                .unwrap_or_default();
            let environment = context
                .attempt
                .get("env")
                .map(stringify_value)
                .unwrap_or_default()
                .to_ascii_uppercase();
            if is_uuid(&merchant_id) {
                headers.insert("x-pg-merchant-id".to_owned(), merchant_id);
            }
            if is_uuid(&credential_set_id) {
                headers.insert("x-pg-credential-set-id".to_owned(), credential_set_id);
            }
            if environment == "LIVE" || environment == "SANDBOX" {
                headers.insert("x-pg-environment".to_owned(), environment);
            }
        }
        let options = UrlOptions {
            allowed_hosts: self.options.allowed_hosts.clone(),
            require_https: !fake_rails,
            allow_any_host: self.allow_any_host(),
            allow_private_hosts: fake_rails,
            allow_fragment: false,
            allow_insecure_http: fake_rails && self.options.allow_insecure_http,
        };
        let url = compile_url(template, &query, &path_parameters, &options)?;
        let log_request = serde_json::json!({
            "method": method.as_str(),
            "url": url,
            "headers": headers,
        });
        Ok(HttpRequest {
            method,
            url,
            headers,
            body: request_body,
            timeout_ms: step.timeout_ms.unwrap_or(self.options.default_timeout_ms),
            side_effect: step.side_effect,
            retry_policy: step.retry_policy,
            point_of_no_return: step.point_of_no_return,
            log_request,
        })
    }

    fn allow_any_host(&self) -> bool {
        self.options.allow_any_host || self.options.allowed_hosts.is_none()
    }

    fn is_fake_rails_host(&self, host: &str) -> bool {
        let normalized = host
            .trim()
            .to_ascii_lowercase()
            .trim_end_matches('.')
            .to_owned();
        if normalized.is_empty() {
            return false;
        }
        let declared = self.options.allowed_hosts.as_ref().is_some_and(|hosts| {
            hosts
                .iter()
                .map(|entry| {
                    entry
                        .trim()
                        .to_ascii_lowercase()
                        .trim_end_matches('.')
                        .to_owned()
                })
                .any(|entry| entry == normalized)
        });
        declared
            && self
                .options
                .fake_rails_hosts
                .iter()
                .map(|entry| {
                    entry
                        .trim()
                        .to_ascii_lowercase()
                        .trim_end_matches('.')
                        .to_owned()
                })
                .any(|entry| entry == normalized)
    }

    fn select_parameter(
        &self,
        parameter: &schema::StepParameter,
        context: &StepContext,
    ) -> Result<Value, EngineError> {
        let root = |map: &Map<String, Value>| Value::Object(map.clone());
        match parameter.source {
            ParameterSource::GatewayMeta => self.selected(&root(&context.gateway_meta), parameter),
            ParameterSource::RouteMeta => self.selected(&root(&context.route_meta), parameter),
            ParameterSource::Credential => self.selected(&root(&context.credentials), parameter),
            ParameterSource::Attempt => self.selected(&root(&context.attempt), parameter),
            ParameterSource::CustomerField => {
                self.selected(&root(&context.customer_fields), parameter)
            }
            ParameterSource::State => self.selected(&root(&context.state), parameter),
            ParameterSource::PreviousResponse => match &parameter.selector {
                Some(selector) => Ok(context
                    .previous_response
                    .as_ref()
                    .and_then(|value| select(value, selector).ok().flatten().cloned())
                    .unwrap_or(Value::Null)),
                None => Ok(context.previous_response.clone().unwrap_or(Value::Null)),
            },
            ParameterSource::Urls => self.selected(&root(&context.urls), parameter),
            ParameterSource::ClientContext => {
                self.selected(&root(&context.client_context), parameter)
            }
            ParameterSource::Constant => {
                Ok(parameter.constant_value.clone().unwrap_or(Value::Null))
            }
            ParameterSource::Now => Ok(Value::String(
                self.clock
                    .now()
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            )),
            ParameterSource::Random => Ok(Value::String(self.rng.uuid().to_string())),
            ParameterSource::Computed | ParameterSource::CryptoSignature => {
                Ok(parameter.constant_value.clone().unwrap_or(Value::Null))
            }
        }
    }

    fn selected(
        &self,
        root: &Value,
        parameter: &schema::StepParameter,
    ) -> Result<Value, EngineError> {
        match &parameter.selector {
            Some(selector) => Ok(select(root, selector)?.cloned().unwrap_or(Value::Null)),
            None => Ok(root.clone()),
        }
    }

    fn resolve_idempotency(
        &self,
        step: &FlowStep,
        context: &StepContext,
    ) -> Result<Option<ResolvedIdempotency>, EngineError> {
        let config = &step.idempotency_config;
        if config.mode == IdempotencyMode::None {
            return Ok(None);
        }
        let key_name = config
            .key_name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .ok_or_else(|| {
                EngineError::new(
                    400,
                    codes::IDEMPOTENCY_KEY_NAME_MISSING,
                    "An idempotency configuration requires a key name",
                )
            })?;
        let template = config.source_template.as_deref().ok_or_else(|| {
            EngineError::new(
                400,
                codes::IDEMPOTENCY_SOURCE_TEMPLATE_MISSING,
                "An idempotency configuration requires a source template",
            )
        })?;
        let roots = context.template_roots();
        let direct = [
            &context.attempt,
            &context.customer_fields,
            &context.state,
            &context.gateway_meta,
            &context.route_meta,
            &context.constants,
        ];
        let direct_refs: Vec<&Map<String, Value>> = direct.to_vec();
        Ok(Some(ResolvedIdempotency {
            mode: config.mode,
            key_name: key_name.to_owned(),
            value: selector::render_context_template(template, &roots, &direct_refs),
        }))
    }

    fn resolve_crypto_signature(
        &self,
        parameter: &schema::StepParameter,
        context: &StepContext,
    ) -> Result<Value, EngineError> {
        let profile_id = parameter.crypto_profile_id.as_deref().ok_or_else(|| {
            EngineError::new(
                400,
                codes::CRYPTO_PROFILE_REQUIRED,
                "A CRYPTO_SIGNATURE parameter requires a crypto profile",
            )
        })?;
        let resolver = self.profiles.as_ref().ok_or_else(|| {
            EngineError::new(
                400,
                codes::CRYPTO_PROFILE_RESOLVER_MISSING,
                "No crypto profile resolver is configured",
            )
        })?;
        let profile = resolver.resolve(profile_id).ok_or_else(|| {
            EngineError::new(
                400,
                codes::CRYPTO_PROFILE_NOT_FOUND,
                format!("Crypto profile '{profile_id}' does not exist"),
            )
        })?;
        let roots = context.template_roots();
        let root_value = Value::Object(roots);
        let selected = match &parameter.selector {
            Some(selector) => select(&root_value, selector)?.cloned(),
            None => Some(root_value.clone()),
        };
        let timestamp = root_value
            .get("timestamp")
            .or_else(|| context.attempt.get("timestamp"))
            .cloned();
        let payload = signing_payload(selected.as_ref(), timestamp.as_ref());
        let secrets = self.secrets.as_ref().ok_or_else(|| {
            EngineError::new(
                400,
                codes::CRYPTO_PROFILE_RESOLVER_MISSING,
                "No secret resolver is configured to sign canonical data",
            )
        })?;
        Ok(Value::String(sign_payload(
            &profile,
            &payload,
            secrets.as_ref(),
        )?))
    }

    fn extract_outputs(
        &self,
        step: &FlowStep,
        response: &Value,
        raw_text: Option<&str>,
        context: &StepContext,
    ) -> Result<StepOutputs, EngineError> {
        let mut output = StepOutputs::default();
        for definition in &step.outputs {
            if definition.store_as.is_monetary()
                && definition
                    .transforms
                    .iter()
                    .any(|pipe| pipe.op == "to_number")
            {
                return Err(EngineError::new(
                    400,
                    codes::MONEY_OUTPUT_FLOAT_FORBIDDEN,
                    format!(
                        "Output '{}' stores money and must not use the to_number transform",
                        definition.name
                    ),
                ));
            }
            let mut value = match &definition.selector {
                Some(selector) => select(response, selector)?.cloned().unwrap_or(Value::Null),
                None => response.clone(),
            };
            if !definition.transforms.is_empty() {
                let transform_context = TransformContext::with_values(&context.template_values);
                value = self
                    .pipeline
                    .apply(value, &definition.transforms, &transform_context)?;
            }
            match definition.store_as {
                OutputStore::State => {
                    output.state.insert(definition.name.clone(), value);
                }
                OutputStore::Public => {
                    output.public.insert(definition.name.clone(), value);
                }
                OutputStore::SettledAmount => {
                    if !value.is_null() {
                        output.settled_amount = Some(parse_money(&value, &definition.name)?);
                    }
                }
                OutputStore::ProviderFee => {
                    if !value.is_null() {
                        output.provider_fee = Some(parse_money(&value, &definition.name)?);
                    }
                }
                OutputStore::ProviderRef => {
                    if !value.is_null() {
                        output.provider_reference = Some(stringify_value(&value));
                    }
                }
                OutputStore::NetworkRef => {
                    if !value.is_null() {
                        output.network_reference = Some(stringify_value(&value));
                    }
                }
            }
        }
        if let Some(raw) = raw_text {
            output
                .state
                .entry("raw_response".to_owned())
                .or_insert_with(|| Value::String(raw.to_owned()));
        }
        Ok(output)
    }

    fn map_status(
        &self,
        step: &FlowStep,
        response: &Value,
        http_status: u16,
    ) -> Result<MappedStatus, EngineError> {
        for rule in &step.status_rules {
            let assertion = Assertion::new(rule.selector.clone(), rule.op, rule.value.clone());
            if selector::evaluate_assertion(&assertion, response)? {
                return Ok(MappedStatus {
                    status: rule.canonical_status,
                    substatus: rule.canonical_substatus.clone(),
                    canonical_error: rule.canonical_error.clone(),
                    rule_matched: true,
                });
            }
        }
        if (200..300).contains(&http_status) {
            return Ok(MappedStatus {
                status: schema::CanonicalStepStatus::Succeeded,
                substatus: None,
                canonical_error: None,
                rule_matched: false,
            });
        }
        Ok(MappedStatus {
            status: if step.side_effect == SideEffect::MovesMoney {
                schema::CanonicalStepStatus::Unknown
            } else {
                schema::CanonicalStepStatus::Failed
            },
            substatus: None,
            canonical_error: Some(format!("HTTP {http_status}")),
            rule_matched: false,
        })
    }

    async fn send_http(&self, request: &HttpRequest) -> Result<EgressResponse, EgressError> {
        self.egress
            .send(EgressRequest {
                method: request.method,
                url: request.url.clone(),
                headers: request.headers.clone(),
                body: request.body.clone(),
                timeout_ms: request.timeout_ms,
                side_effect: request.side_effect,
                retry_policy: request.retry_policy,
                point_of_no_return: request.point_of_no_return,
            })
            .await
    }

    fn assert_url_allowed(&self, url: &str) -> Result<(), EngineError> {
        let (Some(policy), Some(resolver)) = (&self.options.egress_policy, &self.options.resolver)
        else {
            return Ok(());
        };
        pg_egress::validate_target_with(url, policy, resolver.as_ref())
            .map(|_| ())
            .map_err(|error| {
                EngineError::new(400, codes::SSRF_PRIVATE_ADDRESS_BLOCKED, error.to_string())
            })
    }

    fn wipe_pan_fields(&self, context: &mut StepContext) {
        let mut names: Vec<String> = self.options.pan_field_names.clone();
        names.extend(context.pan_field_names.iter().cloned());
        if names.is_empty() {
            return;
        }
        let names: Vec<String> = names
            .into_iter()
            .map(|name| name.to_ascii_lowercase())
            .collect();
        wipe_map(&mut context.customer_fields, &names);
        wipe_map(&mut context.state, &names);
    }
}

fn wipe_map(map: &mut Map<String, Value>, names: &[String]) {
    map.retain(|key, _| !names.contains(&key.to_ascii_lowercase()));
    for value in map.values_mut() {
        wipe_value(value, names);
    }
}

fn wipe_value(value: &mut Value, names: &[String]) {
    match value {
        Value::Object(map) => wipe_map(map, names),
        Value::Array(items) => {
            for item in items {
                wipe_value(item, names);
            }
        }
        _ => {}
    }
}

fn is_uuid(value: &str) -> bool {
    value.len() == 36
        && value.chars().enumerate().all(|(index, character)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                character == '-'
            } else {
                character.is_ascii_hexdigit()
            }
        })
}

fn parse_money(value: &Value, name: &str) -> Result<Decimal, EngineError> {
    let literal = match value {
        Value::String(text) => text.trim().to_owned(),
        Value::Number(number) => number.to_string(),
        Value::Null => return Err(missing_money(name)),
        _ => return Err(missing_money(name)),
    };
    Decimal::from_str_exact(&literal).map_err(|_| {
        EngineError::with_code(
            400,
            codes::INVALID_MONEY_VALUE,
            format!("Output '{name}' is not a decimal: '{literal}'"),
        )
    })
}

fn missing_money(name: &str) -> EngineError {
    EngineError::with_code(
        400,
        codes::INVALID_MONEY_VALUE,
        format!("Output '{name}' is empty"),
    )
}

fn json_depth(value: &Value) -> usize {
    match value {
        Value::Array(items) => 1 + items.iter().map(json_depth).max().unwrap_or(0),
        Value::Object(map) => 1 + map.values().map(json_depth).max().unwrap_or(0),
        _ => 0,
    }
}

fn contains_xml_entity(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("<!doctype") || lower.contains("<!entity")
}

#[derive(Debug)]
struct HttpRequest {
    method: HttpMethod,
    url: String,
    headers: BTreeMap<String, String>,
    body: Option<EgressBody>,
    timeout_ms: u64,
    side_effect: SideEffect,
    retry_policy: RetryPolicy,
    point_of_no_return: bool,
    log_request: Value,
}

impl HttpRequest {
    fn log_value(&self) -> Value {
        self.log_request.clone()
    }
}

struct ResolvedIdempotency {
    mode: IdempotencyMode,
    key_name: String,
    value: String,
}

struct MappedStatus {
    status: schema::CanonicalStepStatus,
    substatus: Option<String>,
    canonical_error: Option<String>,
    rule_matched: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::{CounterRng, FixedClock};
    use crate::schema::ClientAction;
    use serde_json::json;

    struct NeverEgress;

    #[async_trait]
    impl EgressPort for NeverEgress {
        async fn send(&self, request: EgressRequest) -> Result<EgressResponse, EgressError> {
            Err(EgressError::blocked(format!(
                "unexpected request to {}",
                request.url
            )))
        }
    }

    #[test]
    fn render_values_are_carried_to_public_outputs() {
        let clock = Arc::new(FixedClock::at(1_700_000_000_000));
        let rng = Arc::new(CounterRng::new(1));
        let executor = StepExecutor::new(Arc::new(NeverEgress), clock, rng);
        let step = FlowStep::render("show", ClientAction::ShowOtpForm);
        let mut context = StepContext::phase(FlowPhase::Initiate, Map::new());
        let result = futures_block(executor.execute(&step, &mut context)).expect("render");
        assert_eq!(result.status, schema::CanonicalStepStatus::Succeeded);
        assert_eq!(
            result.output.public.get("actionType"),
            Some(&json!("SHOW_OTP_FORM"))
        );
        assert_eq!(result.logs[0].outcome, "SUCCEEDED");
    }

    #[tokio::test]
    async fn verify_refuses_a_money_step() {
        let clock = Arc::new(FixedClock::at(1_700_000_000_000));
        let rng = Arc::new(CounterRng::new(1));
        let executor = StepExecutor::new(Arc::new(NeverEgress), clock, rng);
        let step = FlowStep::json("confirm", HttpMethod::Post, "https://api.example.ly/x")
            .side_effect(SideEffect::MovesMoney);
        let mut context = StepContext::phase(FlowPhase::Verify, Map::new());
        let error = executor
            .execute(&step, &mut context)
            .await
            .expect_err("forbidden");
        assert_eq!(error.code, "VERIFY_MONEY_STEP_FORBIDDEN");
    }

    #[test]
    fn json_depth_is_bounded() {
        assert_eq!(json_depth(&json!(1)), 0);
        assert_eq!(json_depth(&json!({"a": {"b": 1}})), 2);
        assert_eq!(json_depth(&json!([[[1]]])), 3);
    }

    #[test]
    fn uuid_shape_is_checked() {
        assert!(is_uuid("0190a5c4-0000-7000-8000-000000000001"));
        assert!(!is_uuid("not-a-uuid"));
        assert!(!is_uuid(""));
    }

    fn futures_block<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(future)
    }
}

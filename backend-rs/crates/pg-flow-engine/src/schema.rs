//! Runtime schema of a declarative flow step.
//!
//! Port of `core-back/engine/flow/StepExecutor.ts:20-150` and the closed vocabulary of
//! `core-back/engine/specImporter/specSchema.ts:35-230`. The stored gateway flow JSON is projected
//! onto these types by [`crate::materialize`].
//!
//! Money is represented by the transform pipeline as decimal strings / [`rust_decimal::Decimal`];
//! no field here is a floating-point number.

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub use pg_domain_flow::{CanonicalStepStatus, ClientAction, FlowPhase};

use crate::transform::TransformPipe;

/// `StepType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum StepType {
    Http,
    Compute,
    Render,
    Wait,
    Assert,
    Branch,
}

impl StepType {
    pub const ALL: [Self; 6] = [
        Self::Http,
        Self::Compute,
        Self::Render,
        Self::Wait,
        Self::Assert,
        Self::Branch,
    ];

    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Http => "HTTP",
            Self::Compute => "COMPUTE",
            Self::Render => "RENDER",
            Self::Wait => "WAIT",
            Self::Assert => "ASSERT",
            Self::Branch => "BRANCH",
        }
    }

    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_uppercase().as_str() {
            "HTTP" => Some(Self::Http),
            "COMPUTE" => Some(Self::Compute),
            "RENDER" => Some(Self::Render),
            "WAIT" => Some(Self::Wait),
            "ASSERT" => Some(Self::Assert),
            "BRANCH" => Some(Self::Branch),
            _ => None,
        }
    }
}

/// `FlowStep["method"]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "UPPERCASE")]
pub enum HttpMethod {
    Get,
    #[default]
    Post,
    Put,
    Patch,
    Delete,
}

impl HttpMethod {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
            Self::Put => "PUT",
            Self::Patch => "PATCH",
            Self::Delete => "DELETE",
        }
    }

    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_uppercase().as_str() {
            "GET" => Some(Self::Get),
            "POST" => Some(Self::Post),
            "PUT" => Some(Self::Put),
            "PATCH" => Some(Self::Patch),
            "DELETE" => Some(Self::Delete),
            _ => None,
        }
    }

    /// A GET/DELETE carries no body (`ApiConsumer` and `fetch` drop it).
    #[must_use]
    pub fn sends_body(self) -> bool {
        !matches!(self, Self::Get | Self::Delete)
    }
}

/// `ConsumerSideEffect`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SideEffect {
    #[default]
    ReadOnly,
    SendsNotification,
    MovesMoney,
}

impl SideEffect {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ReadOnly => "READ_ONLY",
            Self::SendsNotification => "SENDS_NOTIFICATION",
            Self::MovesMoney => "MOVES_MONEY",
        }
    }

    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_uppercase().as_str() {
            "READ_ONLY" => Some(Self::ReadOnly),
            "SENDS_NOTIFICATION" => Some(Self::SendsNotification),
            "MOVES_MONEY" => Some(Self::MovesMoney),
            _ => None,
        }
    }
}

/// `ConsumerRetryPolicy`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RetryPolicy {
    #[default]
    Never,
    Safe,
    SafeWithCooldown,
}

impl RetryPolicy {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Never => "NEVER",
            Self::Safe => "SAFE",
            Self::SafeWithCooldown => "SAFE_WITH_COOLDOWN",
        }
    }

    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_uppercase().as_str() {
            "NEVER" => Some(Self::Never),
            "SAFE" => Some(Self::Safe),
            "SAFE_WITH_COOLDOWN" => Some(Self::SafeWithCooldown),
            _ => None,
        }
    }

    #[must_use]
    pub fn may_retry(self) -> bool {
        self != Self::Never
    }
}

/// `StepParameterPlace`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ParameterPlace {
    Headers,
    Query,
    Path,
    Body,
    Form,
    Multipart,
    Xml,
}

impl ParameterPlace {
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_uppercase().as_str() {
            "HEADERS" => Some(Self::Headers),
            "QUERY" => Some(Self::Query),
            "PATH" => Some(Self::Path),
            "BODY" => Some(Self::Body),
            "FORM" => Some(Self::Form),
            "MULTIPART" => Some(Self::Multipart),
            "XML" => Some(Self::Xml),
            _ => None,
        }
    }
}

/// `StepParameterSource`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ParameterSource {
    GatewayMeta,
    RouteMeta,
    Credential,
    Attempt,
    CustomerField,
    State,
    PreviousResponse,
    Urls,
    ClientContext,
    Constant,
    Now,
    Random,
    Computed,
    CryptoSignature,
}

impl ParameterSource {
    pub const ALL: [Self; 14] = [
        Self::GatewayMeta,
        Self::RouteMeta,
        Self::Credential,
        Self::Attempt,
        Self::CustomerField,
        Self::State,
        Self::PreviousResponse,
        Self::Urls,
        Self::ClientContext,
        Self::Constant,
        Self::Now,
        Self::Random,
        Self::Computed,
        Self::CryptoSignature,
    ];

    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::GatewayMeta => "GATEWAY_META",
            Self::RouteMeta => "ROUTE_META",
            Self::Credential => "CREDENTIAL",
            Self::Attempt => "ATTEMPT",
            Self::CustomerField => "CUSTOMER_FIELD",
            Self::State => "STATE",
            Self::PreviousResponse => "PREVIOUS_RESPONSE",
            Self::Urls => "URLS",
            Self::ClientContext => "CLIENT_CONTEXT",
            Self::Constant => "CONSTANT",
            Self::Now => "NOW",
            Self::Random => "RANDOM",
            Self::Computed => "COMPUTED",
            Self::CryptoSignature => "CRYPTO_SIGNATURE",
        }
    }

    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|source| source.as_str() == raw.trim().to_ascii_uppercase())
    }

    /// Sources that do not need a selector (`CONSTANT`, `NOW`, `RANDOM`, `COMPUTED`,
    /// `CRYPTO_SIGNATURE`).
    #[must_use]
    pub fn requires_selector(self) -> bool {
        !matches!(
            self,
            Self::Constant | Self::Now | Self::Random | Self::Computed | Self::CryptoSignature
        )
    }
}

/// `StepOutputStore`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum OutputStore {
    State,
    Public,
    SettledAmount,
    ProviderFee,
    ProviderRef,
    NetworkRef,
}

impl OutputStore {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::State => "STATE",
            Self::Public => "PUBLIC",
            Self::SettledAmount => "SETTLED_AMOUNT",
            Self::ProviderFee => "PROVIDER_FEE",
            Self::ProviderRef => "PROVIDER_REF",
            Self::NetworkRef => "NETWORK_REF",
        }
    }

    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_uppercase().as_str() {
            "STATE" => Some(Self::State),
            "PUBLIC" => Some(Self::Public),
            "SETTLED_AMOUNT" => Some(Self::SettledAmount),
            "PROVIDER_FEE" => Some(Self::ProviderFee),
            "PROVIDER_REF" => Some(Self::ProviderRef),
            "NETWORK_REF" => Some(Self::NetworkRef),
            _ => None,
        }
    }

    /// `MONETARY_OUTPUT_STORES`: the stores that must stay an exact decimal.
    #[must_use]
    pub fn is_monetary(self) -> bool {
        matches!(self, Self::SettledAmount | Self::ProviderFee)
    }
}

/// `StepAssertion["op"]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssertionOp {
    Equals,
    NotEquals,
    In,
    Exists,
    Matches,
}

impl AssertionOp {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Equals => "equals",
            Self::NotEquals => "not_equals",
            Self::In => "in",
            Self::Exists => "exists",
            Self::Matches => "matches",
        }
    }

    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "equals" => Some(Self::Equals),
            "not_equals" => Some(Self::NotEquals),
            "in" => Some(Self::In),
            "exists" => Some(Self::Exists),
            "matches" => Some(Self::Matches),
            _ => None,
        }
    }
}

/// `StepAssertion` (also the selector/op/value part of `StatusRule` and `BranchStep`).
#[derive(Debug, Clone, PartialEq)]
pub struct Assertion {
    pub selector: String,
    pub op: AssertionOp,
    pub value: Option<Value>,
}

impl Assertion {
    #[must_use]
    pub fn new(selector: impl Into<String>, op: AssertionOp, value: Option<Value>) -> Self {
        Self {
            selector: selector.into(),
            op,
            value,
        }
    }

    #[must_use]
    pub fn equals(selector: impl Into<String>, value: impl Into<Value>) -> Self {
        Self::new(selector, AssertionOp::Equals, Some(value.into()))
    }

    #[must_use]
    pub fn exists(selector: impl Into<String>) -> Self {
        Self::new(selector, AssertionOp::Exists, None)
    }
}

/// `StatusRule`.
#[derive(Debug, Clone, PartialEq)]
pub struct StatusRule {
    pub selector: String,
    pub op: AssertionOp,
    pub value: Option<Value>,
    pub canonical_status: CanonicalStepStatus,
    pub canonical_substatus: Option<String>,
    pub canonical_error: Option<String>,
}

impl StatusRule {
    #[must_use]
    pub fn equals(
        selector: impl Into<String>,
        value: impl Into<Value>,
        canonical_status: CanonicalStepStatus,
    ) -> Self {
        Self {
            selector: selector.into(),
            op: AssertionOp::Equals,
            value: Some(value.into()),
            canonical_status,
            canonical_substatus: None,
            canonical_error: None,
        }
    }

    #[must_use]
    pub fn with_error(mut self, error: impl Into<String>) -> Self {
        self.canonical_error = Some(error.into());
        self
    }
}

/// `StepParameter`.
#[derive(Debug, Clone, PartialEq)]
pub struct StepParameter {
    pub place: ParameterPlace,
    pub key: String,
    pub source: ParameterSource,
    pub selector: Option<String>,
    pub constant_value: Option<Value>,
    pub crypto_profile_id: Option<String>,
    pub transforms: Vec<TransformPipe>,
}

impl StepParameter {
    #[must_use]
    pub fn new(
        place: ParameterPlace,
        key: impl Into<String>,
        source: ParameterSource,
        selector: Option<&str>,
    ) -> Self {
        Self {
            place,
            key: key.into(),
            source,
            selector: selector.map(str::to_owned),
            constant_value: None,
            crypto_profile_id: None,
            transforms: Vec::new(),
        }
    }

    #[must_use]
    pub fn constant(place: ParameterPlace, key: impl Into<String>, value: Value) -> Self {
        Self {
            place,
            key: key.into(),
            source: ParameterSource::Constant,
            selector: None,
            constant_value: Some(value),
            crypto_profile_id: None,
            transforms: Vec::new(),
        }
    }

    #[must_use]
    pub fn with_transforms(mut self, transforms: Vec<TransformPipe>) -> Self {
        self.transforms = transforms;
        self
    }

    #[must_use]
    pub fn with_crypto_profile(mut self, profile_id: impl Into<String>) -> Self {
        self.crypto_profile_id = Some(profile_id.into());
        self
    }
}

/// `StepOutput`.
#[derive(Debug, Clone, PartialEq)]
pub struct StepOutput {
    pub name: String,
    pub selector: Option<String>,
    pub transforms: Vec<TransformPipe>,
    pub store_as: OutputStore,
    pub required: bool,
}

impl StepOutput {
    #[must_use]
    pub fn new(
        name: impl Into<String>,
        selector: Option<&str>,
        store_as: OutputStore,
        required: bool,
    ) -> Self {
        Self {
            name: name.into(),
            selector: selector.map(str::to_owned),
            transforms: Vec::new(),
            store_as,
            required,
        }
    }

    #[must_use]
    pub fn state(name: impl Into<String>, selector: &str, required: bool) -> Self {
        Self::new(name, Some(selector), OutputStore::State, required)
    }

    #[must_use]
    pub fn public(name: impl Into<String>, selector: &str, required: bool) -> Self {
        Self::new(name, Some(selector), OutputStore::Public, required)
    }

    #[must_use]
    pub fn with_transforms(mut self, transforms: Vec<TransformPipe>) -> Self {
        self.transforms = transforms;
        self
    }
}

/// `StepIdempotencyMode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum IdempotencyMode {
    #[default]
    None,
    Header,
    BodyField,
}

/// `StepIdempotencyConfig`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct IdempotencyConfig {
    pub mode: IdempotencyMode,
    pub key_name: Option<String>,
    pub source_template: Option<String>,
}

/// `ComputeStepDefinition`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ComputeStep {
    pub name: String,
    pub input: Option<Value>,
    pub transforms: Vec<TransformPipe>,
}

/// `RenderStepDefinition`.
#[derive(Debug, Clone, PartialEq)]
pub struct RenderStep {
    pub action: ClientAction,
    pub values: Map<String, Value>,
    pub transforms: Vec<TransformPipe>,
}

impl RenderStep {
    #[must_use]
    pub fn new(action: ClientAction) -> Self {
        Self {
            action,
            values: Map::new(),
            transforms: Vec::new(),
        }
    }

    /// `PrismaFlowProvider` renders `{ actionType: method }` for a seeded RENDER step.
    #[must_use]
    pub fn with_action_type(action: ClientAction) -> Self {
        let mut values = Map::new();
        values.insert(
            "actionType".to_owned(),
            Value::String(action.as_str().to_owned()),
        );
        Self {
            action,
            values,
            transforms: Vec::new(),
        }
    }
}

/// `WaitStepDefinition`. The spec vocabulary uses `duration_ms` / `timeout_ms`; the runtime type
/// uses `durationMs` / `timeoutMs`, both accepted by [`crate::materialize`].
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct WaitStep {
    pub duration_ms: Option<u64>,
    pub event: Option<String>,
    pub timeout_ms: Option<u64>,
}

/// `BranchStepDefinition`.
#[derive(Debug, Clone, PartialEq)]
pub struct BranchStep {
    pub selector: String,
    pub op: AssertionOp,
    pub value: Option<Value>,
    pub then_step_id: Option<String>,
    pub else_step_id: Option<String>,
}

/// One step of a declarative flow (`FlowStep`).
#[derive(Debug, Clone, PartialEq)]
pub struct FlowStep {
    pub id: String,
    pub step_type: StepType,
    pub order_index: u32,
    pub method: Option<HttpMethod>,
    pub url_template: Option<String>,
    pub content_type: Option<String>,
    pub xml_template: Option<String>,
    pub timeout_ms: Option<u64>,
    pub side_effect: SideEffect,
    pub retry_policy: RetryPolicy,
    pub point_of_no_return: bool,
    pub idempotency_config: IdempotencyConfig,
    pub parameters: Vec<StepParameter>,
    pub outputs: Vec<StepOutput>,
    pub success_check: Vec<Assertion>,
    pub status_rules: Vec<StatusRule>,
    pub compute: Option<ComputeStep>,
    pub render: Option<RenderStep>,
    pub wait: Option<WaitStep>,
    pub assertions: Vec<Assertion>,
    pub branch: Option<BranchStep>,
    pub max_attempts: Option<u32>,
    pub retry_delay_ms: Option<u64>,
}

impl FlowStep {
    fn base(id: impl Into<String>, step_type: StepType) -> Self {
        Self {
            id: id.into(),
            step_type,
            order_index: 0,
            method: None,
            url_template: None,
            content_type: None,
            xml_template: None,
            timeout_ms: None,
            side_effect: SideEffect::ReadOnly,
            retry_policy: RetryPolicy::Never,
            point_of_no_return: false,
            idempotency_config: IdempotencyConfig::default(),
            parameters: Vec::new(),
            outputs: Vec::new(),
            success_check: Vec::new(),
            status_rules: Vec::new(),
            compute: None,
            render: None,
            wait: None,
            assertions: Vec::new(),
            branch: None,
            max_attempts: None,
            retry_delay_ms: None,
        }
    }

    /// An HTTP step with the method and URL template.
    #[must_use]
    pub fn http(
        id: impl Into<String>,
        method: HttpMethod,
        url_template: impl Into<String>,
    ) -> Self {
        let mut step = Self::base(id, StepType::Http);
        step.method = Some(method);
        step.url_template = Some(url_template.into());
        step
    }

    /// A JSON HTTP step (the seed default).
    #[must_use]
    pub fn json(
        id: impl Into<String>,
        method: HttpMethod,
        url_template: impl Into<String>,
    ) -> Self {
        let mut step = Self::http(id, method, url_template);
        step.content_type = Some("application/json".to_owned());
        step
    }

    #[must_use]
    pub fn compute(id: impl Into<String>, name: impl Into<String>) -> Self {
        let mut step = Self::base(id, StepType::Compute);
        step.compute = Some(ComputeStep {
            name: name.into(),
            input: None,
            transforms: Vec::new(),
        });
        step
    }

    #[must_use]
    pub fn render(id: impl Into<String>, action: ClientAction) -> Self {
        let mut step = Self::base(id, StepType::Render);
        step.render = Some(RenderStep::with_action_type(action));
        step
    }

    #[must_use]
    pub fn wait(id: impl Into<String>, duration_ms: u64) -> Self {
        let mut step = Self::base(id, StepType::Wait);
        step.wait = Some(WaitStep {
            duration_ms: Some(duration_ms),
            event: None,
            timeout_ms: None,
        });
        step
    }

    #[must_use]
    pub fn assert(id: impl Into<String>, assertions: Vec<Assertion>) -> Self {
        let mut step = Self::base(id, StepType::Assert);
        step.assertions = assertions;
        step
    }

    #[must_use]
    pub fn branch(id: impl Into<String>, branch: BranchStep) -> Self {
        let mut step = Self::base(id, StepType::Branch);
        step.branch = Some(branch);
        step
    }

    #[must_use]
    pub fn order(mut self, order_index: u32) -> Self {
        self.order_index = order_index;
        self
    }

    #[must_use]
    pub fn side_effect(mut self, side_effect: SideEffect) -> Self {
        self.side_effect = side_effect;
        self
    }

    #[must_use]
    pub fn retry_policy(mut self, retry_policy: RetryPolicy) -> Self {
        self.retry_policy = retry_policy;
        self
    }

    #[must_use]
    pub fn point_of_no_return(mut self, point_of_no_return: bool) -> Self {
        self.point_of_no_return = point_of_no_return;
        self
    }

    #[must_use]
    pub fn parameters(mut self, parameters: Vec<StepParameter>) -> Self {
        self.parameters = parameters;
        self
    }

    #[must_use]
    pub fn outputs(mut self, outputs: Vec<StepOutput>) -> Self {
        self.outputs = outputs;
        self
    }

    #[must_use]
    pub fn status_rules(mut self, status_rules: Vec<StatusRule>) -> Self {
        self.status_rules = status_rules;
        self
    }

    #[must_use]
    pub fn success_check(mut self, assertions: Vec<Assertion>) -> Self {
        self.success_check = assertions;
        self
    }

    #[must_use]
    pub fn timeout_ms(mut self, timeout_ms: u64) -> Self {
        self.timeout_ms = Some(timeout_ms);
        self
    }

    #[must_use]
    pub fn idempotency(mut self, config: IdempotencyConfig) -> Self {
        self.idempotency_config = config;
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn step_types_round_trip() {
        for step_type in StepType::ALL {
            assert_eq!(StepType::parse(step_type.as_str()), Some(step_type));
        }
        assert_eq!(StepType::parse("http"), Some(StepType::Http));
        assert_eq!(StepType::parse("BRANCH"), Some(StepType::Branch));
    }

    #[test]
    fn parameter_sources_match_the_spec_list() {
        let spec = [
            "GATEWAY_META",
            "ROUTE_META",
            "CREDENTIAL",
            "ATTEMPT",
            "CUSTOMER_FIELD",
            "STATE",
            "PREVIOUS_RESPONSE",
            "URLS",
            "CLIENT_CONTEXT",
            "CONSTANT",
            "NOW",
            "RANDOM",
            "COMPUTED",
            "CRYPTO_SIGNATURE",
        ];
        assert_eq!(spec.len(), ParameterSource::ALL.len());
        for name in spec {
            let source = ParameterSource::parse(name).expect("source");
            assert_eq!(source.as_str(), name);
        }
        assert!(!ParameterSource::Constant.requires_selector());
        assert!(ParameterSource::Attempt.requires_selector());
    }

    #[test]
    fn output_stores_mark_money() {
        assert!(OutputStore::SettledAmount.is_monetary());
        assert!(OutputStore::ProviderFee.is_monetary());
        assert!(!OutputStore::ProviderRef.is_monetary());
        assert!(!OutputStore::State.is_monetary());
        assert_eq!(
            OutputStore::parse("NETWORK_REF"),
            Some(OutputStore::NetworkRef)
        );
    }

    #[test]
    fn builders_produce_the_seeded_shapes() {
        let step = FlowStep::json("send-otp", HttpMethod::Post, "{api}/verify")
            .parameters(vec![StepParameter::new(
                ParameterPlace::Body,
                "amount",
                ParameterSource::Attempt,
                Some("totalChargedAmount"),
            )])
            .outputs(vec![StepOutput::state(
                "process_id",
                "result.process_id",
                true,
            )])
            .side_effect(SideEffect::SendsNotification)
            .retry_policy(RetryPolicy::SafeWithCooldown);
        assert_eq!(step.content_type.as_deref(), Some("application/json"));
        assert_eq!(step.parameters[0].place, ParameterPlace::Body);
        assert!(step.outputs[0].required);

        let render = FlowStep::render("show", ClientAction::ShowOtpForm);
        assert_eq!(
            render
                .render
                .as_ref()
                .map(|render| render.values.get("actionType")),
            Some(Some(&json!("SHOW_OTP_FORM")))
        );
    }

    #[test]
    fn http_methods_carry_no_body_for_get_delete() {
        assert!(!HttpMethod::Get.sends_body());
        assert!(!HttpMethod::Delete.sends_body());
        assert!(HttpMethod::Post.sends_body());
        assert!(HttpMethod::Patch.sends_body());
    }
}

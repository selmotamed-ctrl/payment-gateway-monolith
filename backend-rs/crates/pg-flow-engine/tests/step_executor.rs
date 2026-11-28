//! Step-executor tests: the request builder, the six step kinds, retries/timeouts, status rules,
//! response guards, the Fake Rails headers, PAN wiping and declarative crypto signing.

mod support;

use std::sync::Arc;

use pg_crypto::canonical::CanonicalizationMode;
use pg_crypto::{CryptoAlgorithm, KeyEncoding, OutputEncoding};
use pg_flow_engine::{
    Assertion, BranchOutcome, BuiltinComputeRegistry, ClientAction, ComputeStep,
    CredentialResolver, CryptoProfile, CryptoProfileResolver, EgressBody, EgressError, FlowPhase,
    FlowStep, HttpMethod, IdempotencyConfig, IdempotencyMode, OutputStore, ParameterPlace,
    ParameterSource, RetryPolicy, SecretResolver, SideEffect, StatusRule, StepContext,
    StepExecutionResult, StepExecutor, StepExecutorOptions, StepOutput, StepParameter,
    TransformPipe, WaitStep,
};
use serde_json::{json, Map, Value};
use support::*;

fn options() -> StepExecutorOptions {
    StepExecutorOptions {
        allowed_hosts: Some(vec![API_HOST.to_owned()]),
        ..StepExecutorOptions::default()
    }
}

fn executor(egress: Arc<FakeEgress>) -> StepExecutor {
    StepExecutor::new(
        egress,
        Arc::new(pg_flow_engine::FixedClock::at(1_700_000_000_000)),
        Arc::new(pg_flow_engine::CounterRng::new(1)),
    )
    .with_options(options())
    .with_compute(Arc::new(BuiltinComputeRegistry::new(
        Arc::new(pg_flow_engine::FixedClock::at(1_700_000_000_000)),
        Arc::new(pg_flow_engine::CounterRng::new(1)),
    )))
}

fn context() -> StepContext {
    let attempt = default_attempt();
    let mut context = StepContext::phase(FlowPhase::Submit, attempt.context_map());
    context.customer_fields = form(&[
        ("otp", json!("123456")),
        ("customer_mobile", json!("0912345678")),
        ("card_number", json!("4111111111111111")),
        ("nested", json!({"pan": "4111111111111111"})),
    ]);
    context.template_values = context.customer_fields.clone();
    context.state = form(&[("process_id", json!("P-1"))]);
    context.credentials = FixedCredentials::moamalat().credentials(&attempt);
    context
}

#[tokio::test]
async fn json_body_headers_and_the_idempotency_recipe_are_rendered() {
    let egress = Arc::new(FakeEgress::new());
    egress.enqueue_json("/pay", 200, json!({"ok": true}));
    let step = FlowStep::json("pay", HttpMethod::Post, format!("https://{API_HOST}/pay"))
        .parameters(vec![
            StepParameter::new(
                ParameterPlace::Headers,
                "X-Key",
                ParameterSource::Attempt,
                Some("reference"),
            ),
            StepParameter::new(
                ParameterPlace::Body,
                "amount",
                ParameterSource::Attempt,
                Some("totalChargedAmount"),
            )
            .with_transforms(vec![TransformPipe::format_decimal(2)]),
            StepParameter::constant(ParameterPlace::Body, "meta.order", json!("A")),
        ])
        .idempotency(IdempotencyConfig {
            mode: IdempotencyMode::Header,
            key_name: Some("Idempotency-Key".to_owned()),
            source_template: Some("{attempt.reference}".to_owned()),
        });
    let result = executor(egress.clone())
        .execute(&step, &mut context())
        .await
        .expect("step");
    assert_eq!(
        result.status,
        pg_flow_engine::CanonicalStepStatus::Succeeded
    );
    let request = &egress.requests()[0];
    assert_eq!(request.headers.get("x-key"), Some(&"ORD-1".to_owned()));
    assert_eq!(
        request.headers.get("idempotency-key"),
        Some(&"ORD-1".to_owned())
    );
    assert_eq!(
        request.headers.get("content-type"),
        Some(&"application/json".to_owned())
    );
    let body: Value = serde_json::from_str(&body_text(request).expect("body")).expect("json");
    assert_eq!(body["amount"], json!("100.00"));
    assert_eq!(body["meta"]["order"], json!("A"));
}

#[tokio::test]
async fn a_get_carries_no_body_or_content_type() {
    let egress = Arc::new(FakeEgress::new());
    egress.enqueue_json("/status", 200, json!({"ok": true}));
    let step = FlowStep::json(
        "status",
        HttpMethod::Get,
        format!("https://{API_HOST}/status"),
    );
    executor(egress.clone())
        .execute(&step, &mut context())
        .await
        .expect("step");
    let request = &egress.requests()[0];
    assert!(request.body.is_none());
    assert!(!request.headers.contains_key("content-type"));
}

#[tokio::test]
async fn a_form_step_is_url_encoded_in_insertion_order() {
    let egress = Arc::new(FakeEgress::new());
    egress.enqueue_json("/form", 200, json!({"ok": true}));
    let step = FlowStep::http("form", HttpMethod::Post, format!("https://{API_HOST}/form"))
        .parameters(vec![
            StepParameter::new(
                ParameterPlace::Form,
                "mobile",
                ParameterSource::CustomerField,
                Some("customer_mobile"),
            ),
            StepParameter::new(
                ParameterPlace::Form,
                "amount",
                ParameterSource::Attempt,
                Some("totalChargedAmount"),
            ),
        ]);
    let step = FlowStep {
        content_type: Some("application/x-www-form-urlencoded".to_owned()),
        ..step
    };
    executor(egress.clone())
        .execute(&step, &mut context())
        .await
        .expect("step");
    let request = &egress.requests()[0];
    match request.body.as_ref().expect("body") {
        EgressBody::Form(fields) => {
            assert_eq!(fields[0], ("mobile".to_owned(), "0912345678".to_owned()));
            assert_eq!(fields[1], ("amount".to_owned(), "100.0000".to_owned()));
        }
        other => panic!("expected a form body, got {other:?}"),
    }
    assert_eq!(
        request.headers.get("content-type"),
        Some(&"application/x-www-form-urlencoded".to_owned())
    );
}

#[tokio::test]
async fn an_xml_template_escapes_the_substituted_values() {
    let egress = Arc::new(FakeEgress::new());
    egress.enqueue_raw("/xml", 200, "application/xml", "<ok>true</ok>".to_owned());
    let step =
        FlowStep::http("xml", HttpMethod::Post, format!("https://{API_HOST}/xml")).parameters(
            vec![
                StepParameter::new(ParameterPlace::Xml, "ref", ParameterSource::Constant, None)
                    .with_transforms(vec![TransformPipe::no_args("to_string")]),
            ],
        );
    let mut step = step;
    step.content_type = Some("application/xml".to_owned());
    step.xml_template = Some("<request><ref>{{ref}}</ref></request>".to_owned());
    step.parameters[0].constant_value = Some(json!("a&b"));
    executor(egress.clone())
        .execute(&step, &mut context())
        .await
        .expect("step");
    let request = &egress.requests()[0];
    assert_eq!(
        body_text(request).as_deref(),
        Some("<request><ref>a&amp;b</ref></request>")
    );
    assert_eq!(
        request.headers.get("content-type"),
        Some(&"application/xml".to_owned())
    );
}

#[tokio::test]
async fn multipart_fields_are_handed_to_the_port_without_a_boundary_header() {
    let egress = Arc::new(FakeEgress::new());
    egress.enqueue_json("/upload", 200, json!({"ok": true}));
    let mut step = FlowStep::http(
        "upload",
        HttpMethod::Post,
        format!("https://{API_HOST}/upload"),
    )
    .parameters(vec![StepParameter::new(
        ParameterPlace::Multipart,
        "file_name",
        ParameterSource::Attempt,
        Some("reference"),
    )]);
    step.content_type = Some("multipart/form-data".to_owned());
    executor(egress.clone())
        .execute(&step, &mut context())
        .await
        .expect("step");
    let request = &egress.requests()[0];
    assert!(matches!(request.body, Some(EgressBody::Multipart(_))));
    assert!(!request.headers.contains_key("content-type"));
}

#[tokio::test]
async fn a_money_step_timeout_is_unknown_and_never_retried() {
    let egress = Arc::new(FakeEgress::new());
    egress.enqueue_error("/confirm", EgressError::timeout());
    let step = FlowStep::json(
        "confirm",
        HttpMethod::Post,
        format!("https://{API_HOST}/confirm"),
    )
    .side_effect(SideEffect::MovesMoney)
    .retry_policy(RetryPolicy::Safe)
    .point_of_no_return(true);
    let result = executor(egress.clone())
        .execute(&step, &mut context())
        .await
        .expect("step");
    assert_eq!(result.status, pg_flow_engine::CanonicalStepStatus::Unknown);
    assert_eq!(
        result.canonical_error.as_deref(),
        Some("Gateway request timed out")
    );
    assert_eq!(egress.count(), 1);
}

#[tokio::test]
async fn a_missing_required_output_makes_a_money_step_unknown() {
    let egress = Arc::new(FakeEgress::new());
    egress.enqueue_json("/confirm", 200, json!({"ok": true}));
    let step = FlowStep::json(
        "confirm",
        HttpMethod::Post,
        format!("https://{API_HOST}/confirm"),
    )
    .side_effect(SideEffect::MovesMoney)
    .retry_policy(RetryPolicy::Never)
    .outputs(vec![StepOutput::new(
        "transaction_id",
        Some("transaction_id"),
        OutputStore::ProviderRef,
        true,
    )]);
    let result = executor(egress)
        .execute(&step, &mut context())
        .await
        .expect("step");
    assert_eq!(result.status, pg_flow_engine::CanonicalStepStatus::Unknown);
}

#[tokio::test]
async fn a_status_rule_maps_a_decline() {
    let egress = Arc::new(FakeEgress::new());
    egress.enqueue_json("/confirm", 200, json!({"status": "DECLINED"}));
    let step = FlowStep::json(
        "confirm",
        HttpMethod::Post,
        format!("https://{API_HOST}/confirm"),
    )
    .status_rules(vec![StatusRule::equals(
        "status",
        "DECLINED",
        pg_flow_engine::CanonicalStepStatus::Failed,
    )
    .with_error("TERMINAL_DECLINE")]);
    let result = executor(egress)
        .execute(&step, &mut context())
        .await
        .expect("step");
    assert_eq!(result.status, pg_flow_engine::CanonicalStepStatus::Failed);
    assert_eq!(result.canonical_error.as_deref(), Some("TERMINAL_DECLINE"));
}

#[tokio::test]
async fn xml_dtd_and_json_depth_are_refused() {
    let egress = Arc::new(FakeEgress::new());
    egress.enqueue_raw(
        "/xml",
        200,
        "application/xml",
        "<!DOCTYPE x [<!ENTITY e SYSTEM 'file:///etc/passwd'>]><x>&e;</x>".to_owned(),
    );
    let step = FlowStep::http("xml", HttpMethod::Get, format!("https://{API_HOST}/xml"));
    let result = executor(egress.clone())
        .execute(&step, &mut context())
        .await
        .expect("step");
    assert_eq!(result.status, pg_flow_engine::CanonicalStepStatus::Failed);
    assert_eq!(
        result.canonical_error.as_deref(),
        Some("XML DTD and external entities are forbidden")
    );

    let deep = json!({"a": {"b": {"c": {"d": 1}}}});
    egress.enqueue_json("/deep", 200, deep);
    let step = FlowStep::json("deep", HttpMethod::Get, format!("https://{API_HOST}/deep"));
    let options = StepExecutorOptions {
        allowed_hosts: Some(vec![API_HOST.to_owned()]),
        max_json_depth: 2,
        ..StepExecutorOptions::default()
    };
    let executor = StepExecutor::new(
        egress,
        Arc::new(pg_flow_engine::FixedClock::at(1_700_000_000_000)),
        Arc::new(pg_flow_engine::CounterRng::new(1)),
    )
    .with_options(options);
    let result = executor.execute(&step, &mut context()).await.expect("step");
    assert_eq!(result.status, pg_flow_engine::CanonicalStepStatus::Failed);
    assert_eq!(
        result.canonical_error.as_deref(),
        Some("JSON response exceeds depth 2")
    );
}

#[tokio::test]
async fn pan_fields_are_wiped_from_the_customer_and_state_maps() {
    let egress = Arc::new(FakeEgress::new());
    let step = FlowStep::render("render", ClientAction::ShowOtpForm);
    let mut context = context();
    context.pan_field_names = vec!["card_number".to_owned(), "pan".to_owned()];
    executor(egress)
        .execute(&step, &mut context)
        .await
        .expect("step");
    assert!(!context.customer_fields.contains_key("card_number"));
    assert_eq!(context.customer_fields.get("nested"), Some(&json!({})));
    assert!(context.customer_fields.contains_key("otp"));
}

#[tokio::test]
async fn the_scoped_fake_rails_headers_are_injected() {
    let egress = Arc::new(FakeEgress::new());
    egress.enqueue_json("/api", 200, json!({"ok": true}));
    let step = FlowStep::json(
        "verify",
        HttpMethod::Post,
        "http://fake-rails.local:4003/api".to_owned(),
    );
    let options = StepExecutorOptions {
        allowed_hosts: Some(vec!["fake-rails.local".to_owned()]),
        fake_rails_hosts: vec!["fake-rails.local".to_owned()],
        allow_insecure_http: true,
        ..StepExecutorOptions::default()
    };
    let executor = StepExecutor::new(
        egress.clone(),
        Arc::new(pg_flow_engine::FixedClock::at(1_700_000_000_000)),
        Arc::new(pg_flow_engine::CounterRng::new(1)),
    )
    .with_options(options);
    let mut context = context();
    context
        .attempt
        .insert("merchantId".to_owned(), json!(MERCHANT_ID));
    context
        .attempt
        .insert("credentialSetId".to_owned(), json!(CREDENTIAL_SET_ID));
    executor.execute(&step, &mut context).await.expect("step");
    let request = &egress.requests()[0];
    assert_eq!(
        request.headers.get("x-pg-merchant-id"),
        Some(&MERCHANT_ID.to_owned())
    );
    assert_eq!(
        request.headers.get("x-pg-credential-set-id"),
        Some(&CREDENTIAL_SET_ID.to_owned())
    );
    assert_eq!(
        request.headers.get("x-pg-environment"),
        Some(&"LIVE".to_owned())
    );
}

#[tokio::test]
async fn assertions_branches_compute_and_wait_follow_the_contract() {
    let egress = Arc::new(FakeEgress::new());
    let executor = executor(egress);
    // ASSERT: previous response approved.
    let step = FlowStep::assert("assert", vec![Assertion::equals("approved", json!(true))]);
    let mut context = context();
    context.previous_response = Some(json!({"approved": true}));
    let result = executor.execute(&step, &mut context).await.expect("assert");
    assert_eq!(
        result.status,
        pg_flow_engine::CanonicalStepStatus::Succeeded
    );

    context.previous_response = Some(json!({"approved": false}));
    let error = executor
        .execute(&step, &mut context)
        .await
        .expect_err("assertion");
    assert_eq!(error.code, "STEP_ASSERTION_FAILED");

    // BRANCH.
    let branch = FlowStep::branch(
        "branch",
        pg_flow_engine::BranchStep {
            selector: "approved".to_owned(),
            op: pg_flow_engine::AssertionOp::Exists,
            value: None,
            then_step_id: Some("then".to_owned()),
            else_step_id: Some("else".to_owned()),
        },
    );
    context.previous_response = Some(json!({"approved": true}));
    let result = executor
        .execute(&branch, &mut context)
        .await
        .expect("branch");
    assert_eq!(result.branch, Some(BranchOutcome::Then));
    context.previous_response = Some(json!({}));
    let result = executor
        .execute(&branch, &mut context)
        .await
        .expect("branch");
    assert_eq!(result.branch, Some(BranchOutcome::Else));

    // COMPUTE with the registered registry; RENDER with the five actions.
    context
        .attempt
        .insert("status".to_owned(), json!("SUCCEEDED"));
    let compute = FlowStep {
        compute: Some(ComputeStep {
            name: "LOCAL_SETTLEMENT_RECONCILE".to_owned(),
            input: None,
            transforms: Vec::new(),
        }),
        ..FlowStep::compute("compute", "LOCAL_SETTLEMENT_RECONCILE")
    };
    let result = executor
        .execute(&compute, &mut context)
        .await
        .expect("compute");
    assert_eq!(
        result.response.as_ref().map(|value| &value["status"]),
        Some(&json!("SUCCESS"))
    );
    let render = FlowStep::render("render", ClientAction::ShowQrOrCode);
    let result = executor
        .execute(&render, &mut context)
        .await
        .expect("render");
    assert_eq!(
        result.output.public.get("actionType"),
        Some(&json!("SHOW_QR_OR_CODE"))
    );

    // WAIT beyond 24 h is refused.
    let wait = FlowStep {
        wait: Some(WaitStep {
            duration_ms: Some(25 * 60 * 60 * 1000),
            event: None,
            timeout_ms: None,
        }),
        ..FlowStep::wait("wait", 0)
    };
    let error = executor
        .execute(&wait, &mut context)
        .await
        .expect_err("wait");
    assert_eq!(error.code, "INVALID_WAIT_DURATION");
}

#[tokio::test]
async fn an_unknown_compute_operation_is_refused() {
    let egress = Arc::new(FakeEgress::new());
    let step = FlowStep::compute("nope", "DOES_NOT_EXIST");
    let error = executor(egress)
        .execute(&step, &mut context())
        .await
        .expect_err("unknown compute");
    assert_eq!(error.code, "UNKNOWN_COMPUTE_OPERATION");
}

struct Profiles;

impl CryptoProfileResolver for Profiles {
    fn resolve(&self, id: &str) -> Option<CryptoProfile> {
        if id != "profile-1" {
            return None;
        }
        Some(CryptoProfile {
            algorithm: CryptoAlgorithm::HmacSha256,
            canonicalization_mode: CanonicalizationMode::RawBody,
            secret_key_ref: Some("CREDENTIAL.key".to_owned()),
            secret_key_encoding: KeyEncoding::Utf8,
            output_encoding: OutputEncoding::HexLower,
            included_fields: Vec::new(),
            excluded_fields: Vec::new(),
            template_string: None,
        })
    }
}

struct Secrets;

impl SecretResolver for Secrets {
    fn resolve_secret(&self, reference: &str) -> Result<Vec<u8>, String> {
        if reference == "CREDENTIAL.key" {
            Ok(b"secret".to_vec())
        } else {
            Err("missing".to_owned())
        }
    }
}

#[tokio::test]
async fn a_crypto_signature_parameter_is_signed_from_its_profile() {
    let egress = Arc::new(FakeEgress::new());
    egress.enqueue_json("/signed", 200, json!({"ok": true}));
    let step = FlowStep::json(
        "signed",
        HttpMethod::Post,
        format!("https://{API_HOST}/signed"),
    )
    .parameters(vec![StepParameter::new(
        ParameterPlace::Headers,
        "X-Signature",
        ParameterSource::CryptoSignature,
        Some("attempt.reference"),
    )
    .with_crypto_profile("profile-1")]);
    let executor = StepExecutor::new(
        egress.clone(),
        Arc::new(pg_flow_engine::FixedClock::at(1_700_000_000_000)),
        Arc::new(pg_flow_engine::CounterRng::new(1)),
    )
    .with_options(options())
    .with_crypto_profiles(Arc::new(Profiles))
    .with_secrets(Arc::new(Secrets));
    executor
        .execute(&step, &mut context())
        .await
        .expect("signed step");
    let request = &egress.requests()[0];
    assert_eq!(
        request.headers.get("x-signature"),
        Some(&hex::encode(pg_crypto::hmac_sha256(b"secret", b"ORD-1")))
    );
}

#[tokio::test]
async fn a_foreign_host_is_refused_before_the_request() {
    let egress = Arc::new(FakeEgress::new());
    let step = FlowStep::json(
        "evil",
        HttpMethod::Post,
        "https://evil.example/pay".to_owned(),
    );
    let error = executor(egress.clone())
        .execute(&step, &mut context())
        .await
        .expect_err("allowlist");
    assert_eq!(error.code, "HOST_NOT_ALLOWED");
    assert_eq!(egress.count(), 0);
}

#[tokio::test]
async fn an_invalid_status_pattern_is_an_error() {
    let egress = Arc::new(FakeEgress::new());
    egress.enqueue_json("/x", 200, json!({"status": "SUCCESS"}));
    let step =
        FlowStep::json("x", HttpMethod::Get, format!("https://{API_HOST}/x")).status_rules(vec![
            StatusRule {
                selector: "status".to_owned(),
                op: pg_flow_engine::AssertionOp::Matches,
                value: Some(json!("[")),
                canonical_status: pg_flow_engine::CanonicalStepStatus::Failed,
                canonical_substatus: None,
                canonical_error: None,
            },
        ]);
    let error = executor(egress)
        .execute(&step, &mut context())
        .await
        .expect_err("pattern");
    assert_eq!(error.code, "INVALID_STATUS_PATTERN");
}

#[tokio::test]
async fn monetary_outputs_keep_exact_decimals_and_reject_float_transforms() {
    let egress = Arc::new(FakeEgress::new());
    egress.enqueue_json(
        "/confirm",
        200,
        json!({"amount": "100.0000", "fee": "0.8000"}),
    );
    let step = FlowStep::json(
        "confirm",
        HttpMethod::Get,
        format!("https://{API_HOST}/confirm"),
    )
    .outputs(vec![
        StepOutput::new("settled", Some("amount"), OutputStore::SettledAmount, true),
        StepOutput::new("fee", Some("fee"), OutputStore::ProviderFee, false),
    ]);
    let result = executor(egress.clone())
        .execute(&step, &mut context())
        .await
        .expect("step");
    assert_eq!(result.output.settled_amount, Some(dec("100.0000")));
    assert_eq!(result.output.provider_fee, Some(dec("0.8000")));

    // The float-producing transform is refused again at execution time.
    egress.enqueue_json("/confirm", 200, json!({"amount": "100.0000"}));
    let step = FlowStep::json(
        "confirm",
        HttpMethod::Get,
        format!("https://{API_HOST}/confirm"),
    )
    .outputs(vec![StepOutput::new(
        "settled",
        Some("amount"),
        OutputStore::SettledAmount,
        true,
    )
    .with_transforms(vec![TransformPipe::no_args("to_number")])]);
    let error = executor(egress)
        .execute(&step, &mut context())
        .await
        .expect_err("float money");
    assert_eq!(error.code, "MONEY_OUTPUT_FLOAT_FORBIDDEN");
}

#[allow(dead_code)]
fn unused(_: StepExecutionResult, _: Map<String, Value>) {}

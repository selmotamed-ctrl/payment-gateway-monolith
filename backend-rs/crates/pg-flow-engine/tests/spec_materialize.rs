//! The spec-importer runtime against a committed stored-gateway-flow fixture.
//!
//! The fixture is the Prisma row shape an admin's imported gateway version persists. The test
//! materialises it, validates it with the offline flow rules and then executes the materialised
//! provider against the in-memory rail engine and egress, proving the projection is usable.

mod support;

use std::collections::BTreeMap;
use std::sync::Arc;

use pg_flow_engine::{
    import_gateway_flow, validate_flow_spec, FlowPhase, FlowValidationInput,
    MaterializedGatewayFlow, StoredFlow, StoredStatusRule,
};
use serde_json::{json, Value};
use support::*;

const FIXTURE: &str = include_str!("fixtures/stored_gateway_flow.json");

fn base_urls() -> BTreeMap<String, String> {
    let mut urls = BTreeMap::new();
    urls.insert("api".to_owned(), "https://sandbox.provider.ly/".to_owned());
    urls
}

fn fixture_document() -> Value {
    serde_json::from_str(FIXTURE).expect("fixture json")
}

fn stored_parts() -> (Vec<StoredFlow>, Vec<StoredStatusRule>) {
    let document = fixture_document();
    let flows: Vec<StoredFlow> = serde_json::from_value(document["flows"].clone()).expect("flows");
    let rules: Vec<StoredStatusRule> =
        serde_json::from_value(document["statusRules"].clone()).expect("rules");
    (flows, rules)
}

#[test]
fn the_fixture_validates_cleanly() {
    let (flows, _) = stored_parts();
    let sub_modes = vec!["otp".to_owned()];
    let base_urls = base_urls();
    let allowed_hosts = vec!["sandbox.provider.ly".to_owned()];
    let input = FlowValidationInput {
        flows: &flows,
        base_urls: &base_urls,
        rail_sub_modes: Some(&sub_modes),
        collection_mode: Some("OTP_PULL"),
        supports_idempotency_key: false,
        crypto_profile_names: &[],
        allowed_hosts: &allowed_hosts,
    };
    let result = validate_flow_spec(&input);
    assert!(result.valid, "{:?}", result.errors);
    assert!(result
        .warnings
        .iter()
        .all(|warning| warning.code != "MOVES_MONEY_RETRY_NOT_NEVER"));
}

#[test]
fn the_fixture_materialises_and_projects_the_ts_rules() {
    let (flows, rules) = stored_parts();
    let base_urls = base_urls();
    let validation = FlowValidationInput::new(&flows, &base_urls);
    let materialized =
        import_gateway_flow(&flows, &rules, &base_urls, &validation).expect("materialized");
    assert_eq!(materialized.flows().len(), 3);

    let initiate = materialized
        .select(FlowPhase::Initiate, Some("otp"), None)
        .expect("initiate");
    assert_eq!(initiate.steps.len(), 2);
    assert_eq!(
        initiate.steps[0].url_template.as_deref(),
        Some("https://sandbox.provider.ly/verify")
    );
    assert_eq!(
        initiate.steps[0].content_type.as_deref(),
        Some("application/json")
    );
    assert_eq!(initiate.steps[0].parameters.len(), 3);
    assert_eq!(
        initiate.steps[0].parameters[0].transforms[0].op,
        "phone_normalize"
    );
    assert!(initiate.steps[0].status_rules.is_empty());
    assert_eq!(
        initiate.steps[1]
            .render
            .as_ref()
            .map(|render| render.action.as_str()),
        Some("SHOW_OTP_FORM")
    );

    let submit = materialized
        .select(FlowPhase::Submit, Some("otp"), None)
        .expect("submit");
    assert_eq!(submit.steps.len(), 1);
    assert!(submit.steps[0].point_of_no_return);
    assert_eq!(submit.steps[0].status_rules.len(), 3);
    assert_eq!(
        submit.steps[0].outputs[0].store_as,
        pg_flow_engine::OutputStore::ProviderRef
    );
}

#[test]
fn the_json_entrypoint_accepts_the_stored_document() {
    let materialized =
        MaterializedGatewayFlow::from_json(&fixture_document(), &base_urls()).expect("flows");
    assert_eq!(materialized.flows().len(), 3);
    assert!(MaterializedGatewayFlow::from_json(&json!({"flows": "nope"}), &base_urls()).is_err());
}

#[test]
fn the_flow_rules_refuse_the_known_spec_mistakes() {
    let (mut flows, _) = stored_parts();
    // 1. VERIFY moving money.
    flows[2].steps[0].side_effect = Some("MOVES_MONEY".to_owned());
    // 2. an unknown URL placeholder.
    flows[0].steps[0].url_template = Some("{nope}/verify".to_owned());
    // 3. a monetary output with to_number.
    flows[1].steps[0].outputs[1].transforms =
        vec![pg_flow_engine::TransformPipe::no_args("to_number")];
    // 4. a duplicate step id in one phase.
    flows[0].steps[1].id = "send-otp".to_owned();
    // 5. a money step with a retry policy.
    flows[1].steps[0].retry_policy = Some("SAFE".to_owned());

    let base_urls = base_urls();
    let input = FlowValidationInput::new(&flows, &base_urls);
    let result = validate_flow_spec(&input);
    assert!(!result.valid);
    let codes: Vec<&str> = result
        .errors
        .iter()
        .map(|error| error.code.as_str())
        .collect();
    for expected in [
        "VERIFY_MONEY_STEP_FORBIDDEN",
        "UNKNOWN_URL_PLACEHOLDER",
        "FLOAT_MONEY_FORBIDDEN",
        "DUPLICATE_STEP_ID",
        "MOVES_MONEY_RETRY_NOT_NEVER",
    ] {
        assert!(codes.contains(&expected), "missing {expected}: {codes:?}");
    }
    assert!(result
        .errors
        .iter()
        .any(|error| error.path.contains("steps")));
    assert!(!result
        .errors
        .iter()
        .any(|error| error.ai_fix_hint.is_empty()));
}

#[test]
fn required_phases_and_sub_modes_are_checked() {
    let (mut flows, _) = stored_parts();
    flows.retain(|flow| flow.phase != "INITIATE" && flow.phase != "SUBMIT");
    flows[0].sub_mode = Some("unknown".to_owned());
    let base_urls = base_urls();
    let sub_modes = vec!["otp".to_owned()];
    let input = FlowValidationInput {
        flows: &flows,
        base_urls: &base_urls,
        rail_sub_modes: Some(&sub_modes),
        collection_mode: Some("OTP_PULL"),
        supports_idempotency_key: false,
        crypto_profile_names: &[],
        allowed_hosts: &[],
    };
    let result = validate_flow_spec(&input);
    let codes: Vec<&str> = result
        .errors
        .iter()
        .map(|error| error.code.as_str())
        .collect();
    assert!(codes.contains(&"REQUIRED_PHASE_MISSING"));
    assert!(codes.contains(&"SUBMIT_PHASE_MISSING"));
    assert!(codes.contains(&"UNKNOWN_SUB_MODE"));
}

#[tokio::test]
async fn the_materialised_provider_runs_an_otp_payment_end_to_end() {
    let (flows, rules) = stored_parts();
    let base_urls = base_urls();
    let materialized =
        Arc::new(MaterializedGatewayFlow::build(&flows, &rules, &base_urls).expect("materialized"));
    let harness = HarnessBuilder::default_attempt()
        .provider(materialized)
        .build();
    harness.egress.enqueue_json(
        "/verify",
        200,
        json!({"result": {"status": "OTP_SENT", "process_id": "P-FIXTURE"}}),
    );
    harness.egress.enqueue_json(
        "/confirm",
        200,
        json!({
            "status": "SUCCESS",
            "transaction_id": "TX-FIXTURE",
            "amount": "100.0000",
            "currency": "LYD",
            "environment": "LIVE",
            "reference": "ORD-1"
        }),
    );
    harness.egress.enqueue_json(
        "/inquiry",
        200,
        json!({
            "status": "SUCCESS",
            "transaction_id": "TX-FIXTURE",
            "amount": "100.0000",
            "currency": "LYD",
            "environment": "LIVE",
            "reference": "ORD-1"
        }),
    );
    let initiated = harness
        .engine
        .initiate(
            "attempt-1",
            &form(&[("customer_mobile", json!("0912345678"))]),
            pg_flow_engine::InitiateOptions::default(),
        )
        .await
        .expect("initiate");
    assert_eq!(
        initiated.attempt.status,
        pg_domain_flow::PaymentStatus::AwaitingCustomer
    );
    assert_eq!(
        initiated.outputs.get("actionType"),
        Some(&json!("SHOW_OTP_FORM"))
    );
    let confirmed = harness
        .engine
        .confirm(
            "attempt-1",
            &otp("123456"),
            pg_flow_engine::ConfirmOptions::claimed(None),
        )
        .await
        .expect("confirm");
    assert_eq!(confirmed.status, pg_domain_flow::PaymentStatus::Succeeded);
    assert_eq!(harness.ledger.confirmations().len(), 1);
    // The raw body carried the materialised transforms: phone normalized, amount 2 dp.
    let verify = harness
        .egress
        .requests()
        .into_iter()
        .find(|request| request.url.contains("/verify"))
        .expect("verify request");
    let body = body_text(&verify).expect("body");
    assert!(body.contains("\"mobile_number\":\"0912345678\""), "{body}");
    assert!(body.contains("\"amount\":\"100.00\""), "{body}");
}

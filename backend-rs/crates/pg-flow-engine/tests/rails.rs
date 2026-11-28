//! End-to-end rail flows over the in-memory ports.
//!
//! These are the seeded shapes: OTP pull (Edfali/Sadad), redirect, embedded widget, card, hosted
//! session, push/transfer and wallet QR. The list also covers retries, timeouts, replay, terminal
//! transitions, slot conflicts, visible-rail selection, refunds, late success and AML escrow.

mod support;

use pg_domain_flow::{
    LinkSlotState, PaymentStatus, RailCandidate, RouteHealth, RouteStatus, VisibleRailsPolicy,
    VisibleRoute,
};
use pg_flow_engine::{
    Assertion, AttemptPatch, CallbackVerification, ClientAction, ConfirmOptions,
    CredentialResolver, EgressError, FlowPhase, FlowStep, FlowStore, HttpMethod, InitiateOptions,
    OutputStore, ParameterPlace, ParameterSource, RetryPolicy, Settlement, SideEffect, StatusRule,
    StepOutput, StepParameter,
};
use serde_json::{json, Map, Value};
use support::*;

fn confirmed(reference: &str, amount: &str) -> Value {
    json!({
        "status": "SUCCESS",
        "transaction_id": "TX-1",
        "amount": amount,
        "currency": "LYD",
        "environment": "LIVE",
        "reference": reference
    })
}

fn customer_form() -> Map<String, Value> {
    form(&[("customer_mobile", json!("0912345678"))])
}

fn otp_harness() -> Harness {
    HarnessBuilder::default_attempt()
        .static_flow(otp_flow())
        .build()
}

#[tokio::test]
async fn otp_success_settles_once_and_persists_the_gateway_facts() {
    let harness = otp_harness();
    script_otp_success(&harness.egress);

    let initiated = harness
        .engine
        .initiate(
            "attempt-1",
            &form(&[("customer_mobile", json!("0912345678"))]),
            InitiateOptions::default(),
        )
        .await
        .expect("initiate");
    assert_eq!(initiated.attempt.status, PaymentStatus::AwaitingCustomer);
    let action = initiated.client_action.clone().expect("client action");
    assert_eq!(action["type"], "SHOW_OTP_FORM");
    assert_eq!(
        initiated.outputs.get("actionType"),
        Some(&json!("SHOW_OTP_FORM"))
    );

    let confirmed = harness
        .engine
        .confirm("attempt-1", &otp("123456"), ConfirmOptions::default())
        .await
        .expect("confirm");
    assert_eq!(confirmed.status, PaymentStatus::Succeeded);
    assert_eq!(confirmed.settlement, Some(Settlement::Normal));
    assert_eq!(harness.ledger.confirmations().len(), 1);
    assert_eq!(
        harness.ledger.confirmations()[0].scenario,
        pg_domain_ledger::LedgerScenario::PlatformHeldConfirmation
    );
    assert_eq!(harness.slots.commits(), 1);
    assert_eq!(harness.slots.releases(), Vec::<String>::new());

    let attempt = harness
        .store
        .load_attempt("attempt-1")
        .await
        .expect("load")
        .expect("attempt");
    assert_eq!(attempt.status, PaymentStatus::Succeeded);
    assert_eq!(attempt.provider_reference.as_deref(), Some("TX-1"));
    assert_eq!(attempt.settled_amount, Some(dec("100.0000")));
    assert_eq!(attempt.otp_attempts, 0);

    // The OTP travelled in the confirm body; the sealed context kept the process id.
    let confirm_request = harness
        .egress
        .requests()
        .into_iter()
        .find(|request| request.url.contains("/confirm"))
        .expect("confirm request");
    let body = body_text(&confirm_request).expect("body");
    assert!(body.contains("\"code\":\"123456\""), "{body}");
    assert!(body.contains("\"process_id\":\"P-1\""), "{body}");
    assert!(body.contains("\"amount\":\"100.00\""), "{body}");
    assert!(harness.vault.seal_calls() > 0);
    assert!(!harness.store.logs().is_empty());
}

#[tokio::test]
async fn otp_wrong_code_is_retryable_and_the_next_code_succeeds() {
    let harness = otp_harness();
    harness.egress.enqueue_json(
        "/verify",
        200,
        json!({"result": {"status": "OTP_SENT", "process_id": "P-1"}}),
    );
    harness.egress.enqueue_json(
        "/confirm",
        200,
        json!({"status": "INVALID_OTP", "transaction_id": "TX-0"}),
    );
    harness
        .egress
        .enqueue_json("/confirm", 200, confirmed("ORD-1", "100.0000"));

    harness
        .engine
        .initiate("attempt-1", &customer_form(), InitiateOptions::default())
        .await
        .expect("initiate");
    let retry = harness
        .engine
        .confirm("attempt-1", &otp("000000"), ConfirmOptions::default())
        .await
        .expect("wrong code");
    assert_eq!(retry.status, PaymentStatus::AwaitingCustomer);
    assert_eq!(retry.canonical_error.as_deref(), Some("RETRYABLE_OTP"));
    let attempt = harness
        .store
        .load_attempt("attempt-1")
        .await
        .expect("load")
        .expect("attempt");
    assert_eq!(attempt.otp_attempts, 1);
    assert_eq!(attempt.status, PaymentStatus::AwaitingCustomer);

    let success = harness
        .engine
        .confirm("attempt-1", &otp("111111"), ConfirmOptions::default())
        .await
        .expect("second code");
    assert_eq!(success.status, PaymentStatus::Succeeded);
    assert_eq!(harness.ledger.confirmations().len(), 1);
}

#[tokio::test]
async fn otp_attempts_are_capped_and_the_failed_attempt_releases_its_slot() {
    let harness = otp_harness();
    harness.egress.enqueue_json(
        "/verify",
        200,
        json!({"result": {"status": "OTP_SENT", "process_id": "P-1"}}),
    );
    for _ in 0..3 {
        harness.egress.enqueue_json(
            "/confirm",
            200,
            json!({"status": "INVALID_OTP", "transaction_id": "TX-0"}),
        );
    }
    harness
        .engine
        .initiate("attempt-1", &customer_form(), InitiateOptions::default())
        .await
        .expect("initiate");
    for _ in 0..2 {
        let result = harness
            .engine
            .confirm("attempt-1", &otp("000000"), ConfirmOptions::default())
            .await
            .expect("retry");
        assert_eq!(result.status, PaymentStatus::AwaitingCustomer);
    }
    let failed = harness
        .engine
        .confirm("attempt-1", &otp("000000"), ConfirmOptions::default())
        .await
        .expect("third code");
    assert_eq!(failed.status, PaymentStatus::Failed);
    assert_eq!(failed.canonical_error.as_deref(), Some("RETRYABLE_OTP"));
    let attempt = harness
        .store
        .load_attempt("attempt-1")
        .await
        .expect("load")
        .expect("attempt");
    assert_eq!(attempt.status, PaymentStatus::Failed);
    assert_eq!(attempt.otp_attempts, 3);
    assert_eq!(harness.slots.releases(), vec!["FAILED".to_owned()]);
    assert!(harness.ledger.confirmations().is_empty());
}

#[tokio::test]
async fn otp_timeout_is_unknown_and_never_retried_or_resubmitted() {
    let harness = otp_harness();
    harness.egress.enqueue_json(
        "/verify",
        200,
        json!({"result": {"status": "OTP_SENT", "process_id": "P-1"}}),
    );
    harness
        .egress
        .enqueue_error("/confirm", EgressError::timeout());

    harness
        .engine
        .initiate("attempt-1", &customer_form(), InitiateOptions::default())
        .await
        .expect("initiate");
    let unknown = harness
        .engine
        .confirm("attempt-1", &otp("123456"), ConfirmOptions::default())
        .await
        .expect("confirm");
    assert_eq!(unknown.status, PaymentStatus::Unknown);
    assert_eq!(
        unknown.canonical_error.as_deref(),
        Some("Gateway request timed out")
    );
    assert_eq!(
        harness
            .egress
            .requests()
            .iter()
            .filter(|request| request.url.contains("/confirm"))
            .count(),
        1,
        "a MOVES_MONEY step must not retry"
    );
    assert!(harness.slots.releases().is_empty());
    assert!(harness.ledger.confirmations().is_empty());

    let error = harness
        .engine
        .confirm("attempt-1", &otp("123456"), ConfirmOptions::default())
        .await
        .expect_err("resubmission");
    assert_eq!(error.code, "POINT_OF_NO_RETURN");
}

#[tokio::test]
async fn otp_decline_fails_and_releases_the_slot() {
    let harness = otp_harness();
    harness.egress.enqueue_json(
        "/verify",
        200,
        json!({"result": {"status": "OTP_SENT", "process_id": "P-1"}}),
    );
    harness.egress.enqueue_json(
        "/confirm",
        200,
        json!({"status": "DECLINED", "transaction_id": "TX-0"}),
    );
    harness
        .engine
        .initiate("attempt-1", &customer_form(), InitiateOptions::default())
        .await
        .expect("initiate");
    let failed = harness
        .engine
        .confirm("attempt-1", &otp("123456"), ConfirmOptions::default())
        .await
        .expect("declined");
    assert_eq!(failed.status, PaymentStatus::Failed);
    assert_eq!(failed.canonical_error.as_deref(), Some("TERMINAL_DECLINE"));
    assert_eq!(harness.slots.releases(), vec!["FAILED".to_owned()]);
    assert!(harness.ledger.confirmations().is_empty());
}

#[tokio::test]
async fn redirect_flow_confirms_through_an_inquiry() {
    let flow = StaticFlow::new()
        .phase(
            FlowPhase::Initiate,
            vec![
                FlowStep::json(
                    "create",
                    HttpMethod::Post,
                    format!("https://{API_HOST}/payment/create"),
                )
                .outputs(vec![
                    StepOutput::public("redirect_url", "redirect_url", true),
                    StepOutput::state("payment_reference", "reference", true),
                ]),
                FlowStep::render("redirect", ClientAction::HttpRedirect)
                    .outputs(vec![StepOutput::public("actionType", "actionType", true)]),
            ],
        )
        .phase(FlowPhase::Submit, Vec::new())
        .phase(
            FlowPhase::Verify,
            vec![FlowStep::json(
                "status",
                HttpMethod::Get,
                format!("https://{API_HOST}/payment/status"),
            )
            .parameters(vec![StepParameter::new(
                ParameterPlace::Query,
                "reference",
                ParameterSource::State,
                Some("payment_reference"),
            )])
            .outputs(vec![
                StepOutput::state("status", "status", true),
                StepOutput::new(
                    "transaction_id",
                    Some("transaction_id"),
                    OutputStore::ProviderRef,
                    false,
                ),
                StepOutput::new(
                    "settled_amount",
                    Some("amount"),
                    OutputStore::SettledAmount,
                    false,
                ),
            ])
            .status_rules(vec![StatusRule::equals(
                "status",
                "SUCCESS",
                pg_flow_engine::CanonicalStepStatus::Succeeded,
            )])],
        );
    let harness = HarnessBuilder::default_attempt().static_flow(flow).build();
    harness.egress.enqueue_json(
        "/payment/create",
        200,
        json!({"status": "PENDING", "redirect_url": "https://pay.example.ly/x", "reference": "PAY-9"}),
    );
    harness
        .egress
        .enqueue_json("/payment/status", 200, confirmed("ORD-1", "100.0000"));

    let initiated = harness
        .engine
        .initiate("attempt-1", &customer_form(), InitiateOptions::default())
        .await
        .expect("initiate");
    assert_eq!(initiated.attempt.status, PaymentStatus::AwaitingCustomer);
    assert_eq!(
        initiated
            .client_action
            .as_ref()
            .map(|action| &action["type"]),
        Some(&json!("HTTP_REDIRECT"))
    );
    // A redirect rail has no SUBMIT stack: confirm asks the gateway instead of trusting the payer.
    let confirmed = harness
        .engine
        .confirm("attempt-1", &Map::new(), ConfirmOptions::default())
        .await
        .expect("confirm");
    assert_eq!(confirmed.status, PaymentStatus::Succeeded);
    assert!(harness
        .egress
        .requests()
        .iter()
        .any(|request| request.url.contains("/payment/status")));
}

#[tokio::test]
async fn widget_flow_runs_a_compute_and_asserts_the_gateway_answer() {
    let flow = StaticFlow::new()
        .phase(
            FlowPhase::Initiate,
            vec![
                FlowStep::compute("build-lightbox", "MOAMALAT_LIGHTBOX_PAYLOAD")
                    .outputs(vec![StepOutput::public("AmountTrxn", "AmountTrxn", true)]),
                FlowStep::render("render-lightbox", ClientAction::RenderEmbedded),
            ],
        )
        .phase(
            FlowPhase::Submit,
            vec![
                FlowStep::json(
                    "status",
                    HttpMethod::Get,
                    format!("https://{API_HOST}/GetTransactionStatus"),
                )
                .outputs(vec![
                    StepOutput::state("approved", "Approved", true),
                    StepOutput::state("action_code", "ActionCode", false),
                ])
                .status_rules(vec![StatusRule::equals(
                    "Approved",
                    true,
                    pg_flow_engine::CanonicalStepStatus::Succeeded,
                )]),
                FlowStep::assert(
                    "assert-approved",
                    vec![
                        Assertion::equals("Approved", json!(true)),
                        Assertion::equals("ActionCode", json!("00")),
                    ],
                ),
            ],
        )
        .phase(
            FlowPhase::Verify,
            vec![FlowStep::json(
                "status",
                HttpMethod::Get,
                format!("https://{API_HOST}/GetTransactionStatus"),
            )
            .outputs(vec![
                StepOutput::state("Approved", "Approved", true),
                StepOutput::new(
                    "transaction_id",
                    Some("TransactionId"),
                    OutputStore::ProviderRef,
                    false,
                ),
                StepOutput::new(
                    "settled_amount",
                    Some("AmountTrxn"),
                    OutputStore::SettledAmount,
                    false,
                ),
            ])],
        );
    let harness = HarnessBuilder::default_attempt()
        .static_flow(flow)
        .compute()
        .build();
    harness.egress.enqueue_json(
        "/GetTransactionStatus",
        200,
        json!({
            "Approved": true,
            "ActionCode": "00",
            "TransactionId": "TX-9",
            "AmountTrxn": "100.000",
            "amount": "100.0000",
            "status": "SUCCESS",
            "reference": "ORD-1",
            "currency": "LYD",
            "environment": "LIVE"
        }),
    );

    let initiated = harness
        .engine
        .initiate("attempt-1", &customer_form(), InitiateOptions::default())
        .await
        .expect("initiate");
    assert_eq!(initiated.attempt.status, PaymentStatus::AwaitingCustomer);
    assert_eq!(
        initiated
            .client_action
            .as_ref()
            .map(|action| &action["type"]),
        Some(&json!("RENDER_EMBEDDED"))
    );
    let confirmed = harness
        .engine
        .confirm("attempt-1", &Map::new(), ConfirmOptions::default())
        .await
        .expect("confirm");
    assert_eq!(confirmed.status, PaymentStatus::Succeeded, "{confirmed:?}");
    assert_eq!(harness.ledger.confirmations().len(), 1);
}

#[tokio::test]
async fn card_flow_uses_the_pinned_credentials_and_asserts_the_action_code() {
    let flow = StaticFlow::new()
        .phase(
            FlowPhase::Initiate,
            vec![
                FlowStep::compute("build", "MOAMALAT_LIGHTBOX_PAYLOAD").outputs(vec![
                    StepOutput::public("MerchantReference", "MerchantReference", true),
                ]),
                FlowStep::render("render", ClientAction::RenderEmbedded),
            ],
        )
        .phase(
            FlowPhase::Submit,
            vec![
                FlowStep::json(
                    "status",
                    HttpMethod::Get,
                    format!("https://{API_HOST}/GetTransactionStatus"),
                )
                .outputs(vec![StepOutput::state("Approved", "Approved", true)])
                .status_rules(vec![StatusRule::equals(
                    "Approved",
                    true,
                    pg_flow_engine::CanonicalStepStatus::Succeeded,
                )]),
                FlowStep::assert("check", vec![Assertion::equals("Approved", json!(true))]),
            ],
        );
    let harness = HarnessBuilder::default_attempt()
        .static_flow(flow)
        .compute()
        .credentials(FixedCredentials::moamalat().credentials(&default_attempt()))
        .build();
    // The compute step needs no HTTP; the status check does.
    harness.egress.enqueue_json(
        "/GetTransactionStatus",
        200,
        json!({
            "status": "SUCCESS",
            "Approved": true,
            "ActionCode": "00",
            "TransactionId": "TX-9",
            "AmountTrxn": "100.000",
            "amount": "100.0000",
            "reference": "ORD-1",
            "currency": "LYD",
            "environment": "LIVE"
        }),
    );
    let initiated = harness
        .engine
        .initiate("attempt-1", &customer_form(), InitiateOptions::default())
        .await
        .expect("initiate");
    assert_eq!(
        initiated.outputs.get("MerchantReference"),
        Some(&json!("0000000001"))
    );
    let confirmed = harness
        .engine
        .confirm("attempt-1", &Map::new(), ConfirmOptions::default())
        .await
        .expect("confirm");
    assert_eq!(confirmed.status, PaymentStatus::Succeeded, "{confirmed:?}");
}

#[tokio::test]
async fn hosted_flow_substitutes_the_state_order_id_in_the_path() {
    let flow = StaticFlow::new()
        .phase(
            FlowPhase::Initiate,
            vec![
                FlowStep::json(
                    "create-session",
                    HttpMethod::Post,
                    format!("https://{API_HOST}/checkout/sessions"),
                )
                .outputs(vec![StepOutput::state("order_id", "order.id", true)]),
                FlowStep::render("render", ClientAction::RenderEmbedded),
            ],
        )
        .phase(FlowPhase::Submit, Vec::new())
        .phase(
            FlowPhase::Verify,
            vec![FlowStep::json(
                "order-status",
                HttpMethod::Get,
                format!("https://{API_HOST}/order/{{order_id}}"),
            )
            .parameters(vec![StepParameter::new(
                ParameterPlace::Path,
                "order_id",
                ParameterSource::State,
                Some("order_id"),
            )])
            .outputs(vec![
                StepOutput::state("status", "status", true),
                StepOutput::new(
                    "transaction_id",
                    Some("transactionId"),
                    OutputStore::ProviderRef,
                    false,
                ),
                StepOutput::new(
                    "settled_amount",
                    Some("amount"),
                    OutputStore::SettledAmount,
                    false,
                ),
            ])
            .status_rules(vec![StatusRule::equals(
                "status",
                "CAPTURED",
                pg_flow_engine::CanonicalStepStatus::Succeeded,
            )])],
        );
    let harness = HarnessBuilder::default_attempt().static_flow(flow).build();
    harness.egress.enqueue_json(
        "/checkout/sessions",
        200,
        json!({"order": {"id": "ORDER-77"}}),
    );
    harness.egress.enqueue_json(
        "/order/ORDER-77",
        200,
        json!({
            "status": "CAPTURED",
            "transactionId": "TX-77",
            "amount": "100.0000",
            "reference": "ORD-1",
            "currency": "LYD",
            "environment": "LIVE"
        }),
    );
    harness
        .engine
        .initiate("attempt-1", &customer_form(), InitiateOptions::default())
        .await
        .expect("initiate");
    let confirmed = harness
        .engine
        .confirm("attempt-1", &Map::new(), ConfirmOptions::default())
        .await
        .expect("confirm");
    assert_eq!(confirmed.status, PaymentStatus::Succeeded);
    assert!(harness
        .egress
        .requests()
        .iter()
        .any(|request| request.url.contains("/order/ORDER-77")));
}

#[tokio::test]
async fn push_wallet_flow_confirms_the_transfer() {
    let flow = StaticFlow::new()
        .phase(
            FlowPhase::Initiate,
            vec![
                FlowStep::json(
                    "request",
                    HttpMethod::Post,
                    format!("https://{API_HOST}/payments/requests"),
                )
                .outputs(vec![StepOutput::state("request_id", "request.id", true)]),
                FlowStep::render("push", ClientAction::ShowPushOrTransfer),
            ],
        )
        .phase(
            FlowPhase::Submit,
            vec![FlowStep::json(
                "confirm",
                HttpMethod::Post,
                format!("https://{API_HOST}/payments/{{request_id}}/confirm"),
            )
            .side_effect(SideEffect::MovesMoney)
            .retry_policy(RetryPolicy::Never)
            .point_of_no_return(true)
            .parameters(vec![StepParameter::new(
                ParameterPlace::Path,
                "request_id",
                ParameterSource::State,
                Some("request_id"),
            )])
            .outputs(vec![
                StepOutput::new(
                    "transaction_id",
                    Some("transactionId"),
                    OutputStore::ProviderRef,
                    true,
                ),
                StepOutput::new(
                    "settled_amount",
                    Some("amount"),
                    OutputStore::SettledAmount,
                    false,
                ),
            ])],
        );
    let harness = HarnessBuilder::default_attempt().static_flow(flow).build();
    harness.egress.enqueue_json(
        "/payments/requests",
        200,
        json!({"request": {"id": "REQ-1"}}),
    );
    harness.egress.enqueue_json(
        "/payments/REQ-1/confirm",
        200,
        json!({
            "status": "SUCCESS",
            "transactionId": "TX-REQ",
            "amount": "100.0000",
            "reference": "ORD-1",
            "currency": "LYD",
            "environment": "LIVE"
        }),
    );
    let initiated = harness
        .engine
        .initiate("attempt-1", &customer_form(), InitiateOptions::default())
        .await
        .expect("initiate");
    assert_eq!(
        initiated
            .client_action
            .as_ref()
            .map(|action| &action["type"]),
        Some(&json!("SHOW_PUSH_OR_TRANSFER"))
    );
    let confirmed = harness
        .engine
        .confirm("attempt-1", &Map::new(), ConfirmOptions::default())
        .await
        .expect("confirm");
    assert_eq!(confirmed.status, PaymentStatus::Succeeded);
}

#[tokio::test]
async fn wallet_qr_flow_renders_a_dynamic_payload_and_inquires() {
    let flow = StaticFlow::new()
        .phase(
            FlowPhase::Initiate,
            vec![
                FlowStep::json(
                    "create",
                    HttpMethod::Post,
                    format!("https://{API_HOST}/payments/requests"),
                )
                .outputs(vec![StepOutput::state("request_id", "request.id", true)]),
                FlowStep::compute("qr", "NEOMPAY_QR_PAYLOAD").outputs(vec![StepOutput::public(
                    "qr_payload",
                    "qr_payload",
                    true,
                )]),
                FlowStep::render("render-qr", ClientAction::ShowQrOrCode),
            ],
        )
        .phase(FlowPhase::Submit, Vec::new())
        .phase(
            FlowPhase::Verify,
            vec![FlowStep::json(
                "status",
                HttpMethod::Get,
                format!("https://{API_HOST}/payments/requests/{{request_id}}"),
            )
            .parameters(vec![StepParameter::new(
                ParameterPlace::Path,
                "request_id",
                ParameterSource::State,
                Some("request_id"),
            )])
            .outputs(vec![
                StepOutput::state("status", "status", true),
                StepOutput::new(
                    "transaction_id",
                    Some("transactionId"),
                    OutputStore::ProviderRef,
                    false,
                ),
                StepOutput::new(
                    "settled_amount",
                    Some("amount"),
                    OutputStore::SettledAmount,
                    false,
                ),
            ])],
        );
    let harness = HarnessBuilder::default_attempt()
        .static_flow(flow)
        .compute()
        .build();
    harness.egress.enqueue_json(
        "/payments/requests",
        200,
        json!({"request": {"id": "REQ-2"}}),
    );
    harness.egress.enqueue_json(
        "/payments/requests/REQ-2",
        200,
        json!({
            "status": "SUCCESS",
            "transactionId": "TX-QR",
            "amount": "100.0000",
            "reference": "ORD-1",
            "currency": "LYD",
            "environment": "LIVE"
        }),
    );
    let initiated = harness
        .engine
        .initiate("attempt-1", &customer_form(), InitiateOptions::default())
        .await
        .expect("initiate");
    assert!(initiated
        .outputs
        .get("qr_payload")
        .and_then(Value::as_str)
        .is_some_and(|payload| payload.starts_with("neompay://pay")));
    assert_eq!(
        initiated
            .client_action
            .as_ref()
            .map(|action| &action["type"]),
        Some(&json!("SHOW_QR_OR_CODE"))
    );
    let confirmed = harness
        .engine
        .confirm("attempt-1", &Map::new(), ConfirmOptions::default())
        .await
        .expect("confirm");
    assert_eq!(confirmed.status, PaymentStatus::Succeeded);
}

#[tokio::test]
async fn customer_action_flow_runs_an_assertion_then_waits() {
    let flow = StaticFlow::new().phase(
        FlowPhase::Initiate,
        vec![
            FlowStep::json(
                "create",
                HttpMethod::Post,
                format!("https://{API_HOST}/create"),
            )
            .outputs(vec![StepOutput::state("approved", "approved", true)]),
            FlowStep::assert("approved", vec![Assertion::equals("approved", json!(true))]),
            FlowStep::wait("pause", 10),
            FlowStep::render("qr", ClientAction::ShowQrOrCode),
        ],
    );
    let harness = HarnessBuilder::default_attempt().static_flow(flow).build();
    harness
        .egress
        .enqueue_json("/create", 200, json!({"approved": true}));
    let initiated = harness
        .engine
        .initiate("attempt-1", &customer_form(), InitiateOptions::default())
        .await
        .expect("initiate");
    assert_eq!(initiated.attempt.status, PaymentStatus::AwaitingCustomer);
    assert_eq!(
        initiated
            .client_action
            .as_ref()
            .map(|action| &action["type"]),
        Some(&json!("SHOW_QR_OR_CODE"))
    );
    assert_eq!(harness.clock.sleeps(), vec![10]);
}

#[tokio::test]
async fn a_safe_read_only_step_retries_a_5xx_answer() {
    let flow = StaticFlow::new().phase(
        FlowPhase::Initiate,
        vec![FlowStep::json(
            "flaky",
            HttpMethod::Post,
            format!("https://{API_HOST}/flaky"),
        )
        .retry_policy(RetryPolicy::Safe)],
    );
    let harness = HarnessBuilder::default_attempt().static_flow(flow).build();
    harness.egress.enqueue_status("/flaky", 503);
    harness
        .egress
        .enqueue_json("/flaky", 200, json!({"ok": true}));
    harness
        .engine
        .initiate("attempt-1", &customer_form(), InitiateOptions::default())
        .await
        .expect("initiate");
    assert_eq!(harness.egress.count(), 2);
    assert_eq!(harness.clock.sleeps(), vec![250]);
}

#[tokio::test]
async fn confirm_replay_with_the_claim_settles_once() {
    let harness = otp_harness();
    script_otp_success(&harness.egress);
    harness
        .engine
        .initiate("attempt-1", &customer_form(), InitiateOptions::default())
        .await
        .expect("initiate");
    let first = harness
        .engine
        .confirm(
            "attempt-1",
            &otp("123456"),
            ConfirmOptions::claimed(Some("hash-1".to_owned())),
        )
        .await
        .expect("first");
    assert_eq!(first.status, PaymentStatus::Succeeded);
    let second = harness
        .engine
        .confirm(
            "attempt-1",
            &otp("123456"),
            ConfirmOptions::claimed(Some("hash-1".to_owned())),
        )
        .await
        .expect("second");
    assert_eq!(second.status, PaymentStatus::Succeeded);
    assert_eq!(harness.ledger.confirmations().len(), 1);
    assert_eq!(harness.slots.commits(), 1);
    assert_eq!(
        harness
            .egress
            .requests()
            .iter()
            .filter(|request| request.url.contains("/confirm"))
            .count(),
        1
    );
}

#[tokio::test]
async fn a_settled_attempt_refuses_a_contradicting_callback_and_a_cancel() {
    let harness = otp_harness();
    script_otp_success(&harness.egress);
    harness
        .engine
        .initiate("attempt-1", &customer_form(), InitiateOptions::default())
        .await
        .expect("initiate");
    harness
        .engine
        .confirm("attempt-1", &otp("123456"), ConfirmOptions::default())
        .await
        .expect("confirm");

    let mut verification = CallbackVerification::verified("attempt-1");
    verification.evidence = form(&[
        ("status", json!("DECLINED")),
        ("reference", json!("ORD-1")),
        ("amount", json!("100.0000")),
        ("currency", json!("LYD")),
        ("environment", json!("LIVE")),
    ]);
    let verifier = std::sync::Arc::new(ScriptedCallbackVerifier::new(verification));
    let harness = HarnessBuilder::default_attempt()
        .static_flow(otp_flow())
        .callback_verifier(verifier)
        .build();
    harness
        .store
        .update_attempt("attempt-1", AttemptPatch::status(PaymentStatus::Succeeded))
        .await
        .expect("patch");
    let error = harness
        .engine
        .verify_callback("webhook", &json!({}))
        .await
        .expect_err("contradicting callback");
    assert_eq!(error.code, "ATTEMPT_TERMINAL");

    let error = harness
        .engine
        .cancel("attempt-1")
        .await
        .expect_err("cancel");
    assert_eq!(error.code, "ATTEMPT_NOT_CANCELLABLE");
}

#[tokio::test]
async fn an_excess_settlement_is_routed_to_suspense_not_the_merchant() {
    let mut attempt = default_attempt();
    attempt.status = PaymentStatus::Authorizing;
    attempt.point_of_no_return = true;
    let mut link = LinkSlotState::single(1);
    link.confirmed_count = 1;
    let harness = HarnessBuilder::new(attempt)
        .static_flow(otp_flow())
        .link(link)
        .build();
    harness
        .egress
        .enqueue_json("/confirm", 200, confirmed("ORD-1", "100.0000"));
    let result = harness
        .engine
        .confirm("attempt-1", &otp("123456"), ConfirmOptions::default())
        .await
        .expect("confirm");
    assert_eq!(result.status, PaymentStatus::Succeeded);
    assert_eq!(result.settlement, Some(Settlement::Suspense));
    assert_eq!(
        result.canonical_error.as_deref(),
        Some("SLOT_ALREADY_SETTLED_SUSPENSE")
    );
    assert_eq!(result.substatus.as_deref(), Some("SUSPENSE_SETTLEMENT"));
    assert!(harness.ledger.confirmations().is_empty());
    let attempt = harness
        .store
        .load_attempt("attempt-1")
        .await
        .expect("load")
        .expect("attempt");
    assert_eq!(attempt.status, PaymentStatus::Succeeded);
    assert_eq!(attempt.substatus.as_deref(), Some("SUSPENSE_SETTLEMENT"));
    assert_eq!(attempt.ledger_entry_id.as_deref(), Some("entry-suspense"));
}

#[tokio::test]
async fn visible_rail_selection_skips_paused_and_open_breakers() {
    let healthy = RailCandidate::active("route-1");
    let paused = RailCandidate {
        route_status: RouteStatus::Paused,
        ..RailCandidate::active("route-paused")
    };
    let open = RailCandidate {
        health: RouteHealth::OpenBreaker,
        ..RailCandidate::active("route-open")
    };
    let selected = VisibleRoute {
        route_id: "route-1".to_owned(),
        rank: 1,
        health: RouteHealth::Healthy,
        weight: 100,
    };
    assert_eq!(
        pg_flow_engine::RailEngine::select_visible_route(
            &[paused.clone(), open.clone(), healthy.clone()],
            VisibleRailsPolicy::default()
        )
        .expect("route"),
        selected
    );
    let error = pg_flow_engine::RailEngine::select_visible_route(
        &[paused, open],
        VisibleRailsPolicy::default(),
    )
    .expect_err("no route");
    assert_eq!(error.code, "NO_VISIBLE_ROUTE");

    let harness = otp_harness();
    script_otp_success(&harness.egress);
    let initiated = harness
        .engine
        .initiate_with_candidates(
            "attempt-1",
            &[healthy],
            VisibleRailsPolicy::default(),
            &customer_form(),
            InitiateOptions::default(),
        )
        .await
        .expect("initiate");
    assert_eq!(initiated.attempt.status, PaymentStatus::AwaitingCustomer);
    let attempt = harness
        .store
        .load_attempt("attempt-1")
        .await
        .expect("load")
        .expect("attempt");
    assert_eq!(attempt.route_id.as_deref(), Some("route-1"));
}

#[tokio::test]
async fn advance_step_exposes_the_step_machine_one_step_at_a_time() {
    let mut attempt = default_attempt();
    attempt.status = PaymentStatus::Initiating;
    let harness = HarnessBuilder::new(attempt).static_flow(otp_flow()).build();
    harness.egress.enqueue_json(
        "/verify",
        200,
        json!({"result": {"status": "OTP_SENT", "process_id": "P-1"}}),
    );
    let first = harness
        .engine
        .advance_step_with_input("attempt-1", FlowPhase::Initiate, &customer_form())
        .await
        .expect("step 1");
    assert_eq!(first.step_id.as_deref(), Some("send-otp"));
    assert_eq!(first.step_index, Some(0));
    assert!(!first.finished);
    assert_eq!(first.output.state.get("process_id"), Some(&json!("P-1")));
    let second = harness
        .engine
        .advance_step_with_input("attempt-1", FlowPhase::Initiate, &customer_form())
        .await
        .expect("step 2");
    assert_eq!(second.step_id.as_deref(), Some("show-otp"));
    assert!(second.finished);
    assert_eq!(second.phase_status, PaymentStatus::Succeeded);
    assert_eq!(
        second.client_action.as_ref().map(|action| &action["type"]),
        Some(&json!("SHOW_OTP_FORM"))
    );
    let cursor = harness
        .store
        .cursor("attempt-1", FlowPhase::Initiate)
        .expect("cursor");
    assert!(cursor.completed);
    let exhausted = harness
        .engine
        .advance_step_with_input("attempt-1", FlowPhase::Initiate, &customer_form())
        .await
        .expect("step 3");
    assert!(exhausted.finished);
    assert!(exhausted.step_id.is_none());
}

#[tokio::test]
async fn a_duplicate_verified_callback_settles_once() {
    let mut verification = CallbackVerification::verified("attempt-1");
    verification.evidence = form(&[
        ("status", json!("SUCCESS")),
        ("reference", json!("ORD-1")),
        ("amount", json!("100.0000")),
        ("currency", json!("LYD")),
        ("environment", json!("LIVE")),
    ]);
    let harness = HarnessBuilder::default_attempt()
        .callback_verifier(std::sync::Arc::new(ScriptedCallbackVerifier::new(
            verification,
        )))
        .callback_inbox(std::sync::Arc::new(AcceptOnceInbox::new()))
        .build();
    harness
        .store
        .update_attempt(
            "attempt-1",
            AttemptPatch::status(PaymentStatus::Authorizing),
        )
        .await
        .expect("patch");
    let first = harness
        .engine
        .verify_callback("webhook", &json!({"dedupeKey": "evt-1"}))
        .await
        .expect("first callback");
    assert_eq!(first.status, PaymentStatus::Succeeded);
    let second = harness
        .engine
        .verify_callback("webhook", &json!({"dedupeKey": "evt-1"}))
        .await
        .expect("duplicate");
    assert_eq!(second.status, PaymentStatus::Succeeded);
    assert_eq!(harness.ledger.confirmations().len(), 1);
}

fn refund_flow() -> StaticFlow {
    otp_flow().phase(
        FlowPhase::Refund,
        vec![FlowStep::json(
            "refund",
            HttpMethod::Post,
            format!("https://{API_HOST}/refund"),
        )
        .side_effect(SideEffect::MovesMoney)
        .retry_policy(RetryPolicy::Never)
        .point_of_no_return(true)
        .parameters(vec![
            StepParameter::new(
                ParameterPlace::Body,
                "amount",
                ParameterSource::CustomerField,
                Some("amount"),
            ),
            StepParameter::new(
                ParameterPlace::Body,
                "adjustment_id",
                ParameterSource::CustomerField,
                Some("adjustmentId"),
            ),
        ])
        .status_rules(vec![StatusRule::equals(
            "status",
            "DECLINED",
            pg_flow_engine::CanonicalStepStatus::Failed,
        )
        .with_error("REFUND_DECLINED")])],
    )
}

#[tokio::test]
async fn refunds_move_the_attempt_to_partial_then_full() {
    let harness = HarnessBuilder::default_attempt()
        .static_flow(refund_flow())
        .build();
    script_otp_success(&harness.egress);
    harness
        .egress
        .enqueue_json("/refund", 200, json!({"status": "REFUNDED"}));
    harness
        .egress
        .enqueue_json("/refund", 200, json!({"status": "REFUNDED"}));
    harness
        .engine
        .initiate("attempt-1", &customer_form(), InitiateOptions::default())
        .await
        .expect("initiate");
    harness
        .engine
        .confirm("attempt-1", &otp("123456"), ConfirmOptions::default())
        .await
        .expect("confirm");

    let partial = harness
        .engine
        .refund("attempt-1", dec("40.0000"), "adjustment-1")
        .await
        .expect("partial refund");
    assert_eq!(partial.status, PaymentStatus::PartiallyRefunded);
    let full = harness
        .engine
        .refund("attempt-1", dec("100.0000"), "adjustment-2")
        .await
        .expect("full refund");
    assert_eq!(full.status, PaymentStatus::Refunded);
    let error = harness
        .engine
        .refund("attempt-1", dec("100.0100"), "adjustment-3")
        .await
        .expect_err("over amount");
    assert_eq!(error.code, "REFUND_AMOUNT_EXCEEDED");
    let error = harness
        .engine
        .refund("attempt-1", dec("0"), "adjustment-4")
        .await
        .expect_err("zero");
    assert_eq!(error.code, "INVALID_REFUND_AMOUNT");
}

#[tokio::test]
async fn a_failed_refund_is_scheduled_for_reconciliation() {
    let mut attempt = default_attempt();
    attempt.status = PaymentStatus::Succeeded;
    attempt.settled_amount = Some(dec("100.0000"));
    let harness = HarnessBuilder::new(attempt)
        .static_flow(refund_flow())
        .build();
    harness.egress.enqueue_json(
        "/refund",
        200,
        json!({"status": "DECLINED", "transaction_id": "TX-0"}),
    );
    let result = harness
        .engine
        .refund("attempt-1", dec("40.0000"), "adjustment-9")
        .await
        .expect("refund");
    assert_eq!(result.status, PaymentStatus::Failed);
    assert_eq!(result.canonical_error.as_deref(), Some("REFUND_DECLINED"));
    assert_eq!(
        harness.reconciliation.calls(),
        vec![("attempt-1".to_owned(), Some("adjustment-9".to_owned()))]
    );
}

#[tokio::test]
async fn a_late_success_after_failure_is_recovered_and_opens_a_p2_case() {
    let mut attempt = default_attempt();
    attempt.status = PaymentStatus::Failed;
    let harness = HarnessBuilder::new(attempt).static_flow(otp_flow()).build();
    harness
        .egress
        .enqueue_json("/inquiry", 200, confirmed("ORD-1", "100.0000"));
    let result = harness.engine.inquire("attempt-1").await.expect("inquire");
    assert_eq!(result.status, PaymentStatus::Succeeded);
    let cases = harness.cases.cases();
    assert_eq!(cases.len(), 1);
    assert_eq!(cases[0].kind, "LATE_SUCCESS");
    assert_eq!(cases[0].priority, pg_flow_engine::CasePriority::P2);
    assert_eq!(harness.slots.commits(), 1);
}

#[tokio::test]
async fn an_aml_held_capture_is_escrowed_not_settled() {
    let mut attempt = default_attempt();
    attempt.status = PaymentStatus::Authorizing;
    attempt.substatus = Some("AML_HOLD".to_owned());
    attempt.point_of_no_return = true;
    let harness = HarnessBuilder::new(attempt).static_flow(otp_flow()).build();
    harness
        .egress
        .enqueue_json("/confirm", 200, confirmed("ORD-1", "100.0000"));
    let result = harness
        .engine
        .confirm("attempt-1", &otp("123456"), ConfirmOptions::default())
        .await
        .expect("confirm");
    assert_eq!(result.substatus.as_deref(), Some("AML_HOLD"));
    assert_eq!(result.status, PaymentStatus::Authorizing);
    assert!(harness.ledger.confirmations().is_empty());
    let scenarios = harness.ledger.scenarios();
    assert_eq!(scenarios.len(), 1);
    assert_eq!(
        scenarios[0].scenario,
        pg_domain_ledger::LedgerScenario::AmlHoldAndRelease
    );
    assert_eq!(scenarios[0].stage, None);
    assert_eq!(harness.slots.commits(), 0);
}

#[tokio::test]
async fn initiating_twice_is_refused_by_the_transition_table() {
    let harness = otp_harness();
    script_otp_success(&harness.egress);
    harness
        .engine
        .initiate("attempt-1", &customer_form(), InitiateOptions::default())
        .await
        .expect("initiate");
    let error = harness
        .engine
        .initiate("attempt-1", &customer_form(), InitiateOptions::default())
        .await
        .expect_err("second initiate");
    assert_eq!(error.code, "INVALID_ATTEMPT_TRANSITION");
    assert_eq!(error.status, 409);
}

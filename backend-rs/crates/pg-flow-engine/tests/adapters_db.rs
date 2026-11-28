//! Database-gated integration tests for the flow-engine adapters.
//!
//! They run against `PG_TEST_DATABASE_URL` (default
//! `postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test`, schema 46) and print a
//! `SKIP:` line when the database is unreachable.
//!
//! Every fixture and every write happens inside one transaction that is rolled back at the end, so
//! the append-only journal (`journal_entries`, `journal_lines`), `operator_case_events` and
//! `outbox_events` are never left behind.

mod adapters_support;

use adapters_support::{dec, seed, test_pool, CURRENCY};
use pg_domain_flow::PaymentStatus;
use pg_domain_ledger::LedgerScenario;
use pg_flow_engine::adapters::{
    ledger::confirmation_template, PgCaseSink, PgFlowProvider, PgFlowStore, PgLedgerAdapter,
    PgSlotStore,
};
use pg_flow_engine::{
    Attempt, AttemptPatch, CasePriority, ConfirmationPosting, Environment, FeeBearer, FlowPhase,
    OperatorCaseInput, OwnershipMode, ScenarioPosting, StepLogRecord, StoreError,
};
use sqlx::PgPool;
use uuid::Uuid;

async fn prepare(pool: &PgPool) -> sqlx::Transaction<'_, sqlx::Postgres> {
    pool.begin().await.expect("transaction")
}

// ---------------------------------------------------------------------------------------------
// FlowStore
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn loads_the_pinned_attempt_projection() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let mut tx = prepare(&pool).await;
    let fixture = seed(&mut tx).await;
    let store = PgFlowStore::new(pool.clone());

    let attempt = store
        .load_attempt_on(&mut tx, &fixture.attempt_id.to_string())
        .await
        .expect("load attempt")
        .expect("attempt exists");

    assert_eq!(attempt.id, fixture.attempt_id.to_string());
    assert_eq!(attempt.reference, fixture.reference);
    assert_eq!(attempt.status, PaymentStatus::Created);
    assert_eq!(attempt.env, Environment::Live);
    assert_eq!(attempt.currency, CURRENCY);
    assert_eq!(attempt.ownership_mode, OwnershipMode::PlatformClearing);
    assert_eq!(attempt.fee_bearer, FeeBearer::MerchantAbsorbs);
    assert!(attempt.fee_accrual, "route cost_model accrues the fee");
    assert_eq!(attempt.max_otp_attempts, Some(3));
    assert_eq!(attempt.mismatch_tolerance, Some(dec("0.0100")));
    assert_eq!(
        attempt.gateway_id,
        Some(fixture.gateway_id.to_string()),
        "the gateway is derived from the pinned version"
    );
    assert_eq!(
        attempt.context.get("customer_mobile"),
        Some(&serde_json::json!("0912345678"))
    );
    assert_eq!(attempt.requested_amount, dec("100.0000"));
    assert_eq!(attempt.total_charged_amount, dec("100.0000"));
    assert!(attempt.context_ciphertext.is_none());

    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn compare_and_set_status_writes_detect_a_stale_reader() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let mut tx = prepare(&pool).await;
    let fixture = seed(&mut tx).await;
    let store = PgFlowStore::new(pool.clone());
    let attempt_id = fixture.attempt_id.to_string();

    let mut patch =
        AttemptPatch::status(PaymentStatus::Authorizing).expected(PaymentStatus::Created);
    patch.point_of_no_return = Some(true);
    let updated = store
        .update_attempt_on(&mut tx, &attempt_id, patch)
        .await
        .expect("claim");
    assert_eq!(updated.status, PaymentStatus::Authorizing);
    assert!(updated.point_of_no_return);

    let stale = store
        .update_attempt_on(
            &mut tx,
            &attempt_id,
            AttemptPatch::status(PaymentStatus::Failed).expected(PaymentStatus::Created),
        )
        .await
        .expect_err("stale write must fail");
    match stale {
        StoreError::StateConflict { expected, observed } => {
            assert_eq!(expected, "CREATED");
            assert_eq!(observed, "AUTHORIZING");
        }
        other => panic!("expected a state conflict, got {other:?}"),
    }

    let terminal = store
        .update_attempt_on(
            &mut tx,
            &attempt_id,
            AttemptPatch::status(PaymentStatus::Succeeded).expected(PaymentStatus::Authorizing),
        )
        .await
        .expect("terminal write");
    assert_eq!(terminal.status, PaymentStatus::Succeeded);
    assert!(terminal.terminal_at.is_some());

    let outbox: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox_events WHERE topic = 'attempt.transitioned' AND aggregate_id = $1",
    )
    .bind(&attempt_id)
    .fetch_one(&mut *tx)
    .await
    .expect("outbox count");
    assert!(outbox >= 1, "the terminal write emits attempt.transitioned");

    let first_terminal: Option<chrono::NaiveDateTime> =
        sqlx::query_scalar("SELECT first_terminal_at FROM payment_attempts WHERE id = $1")
            .bind(fixture.attempt_id)
            .fetch_one(&mut *tx)
            .await
            .expect("first_terminal_at");
    assert!(first_terminal.is_some());

    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn claim_authorizing_is_a_single_writer_and_honours_the_idempotency_hash() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let mut tx = prepare(&pool).await;
    let fixture = seed(&mut tx).await;
    let store = PgFlowStore::new(pool.clone());
    let attempt_id = fixture.attempt_id.to_string();
    let hash = "a".repeat(64);

    assert!(store
        .claim_authorizing_on(&mut tx, &attempt_id, Some(&hash))
        .await
        .expect("first claim"));
    assert!(!store
        .claim_authorizing_on(&mut tx, &attempt_id, Some(&hash))
        .await
        .expect("second claim"));

    // Rewind the status only; the stored hash must still refuse the repeated confirm.
    sqlx::query("UPDATE payment_attempts SET status = 'CREATED' WHERE id = $1")
        .bind(fixture.attempt_id)
        .execute(&mut *tx)
        .await
        .expect("rewind");
    assert!(!store
        .claim_authorizing_on(&mut tx, &attempt_id, Some(&hash))
        .await
        .expect("repeat with the same key"));

    let stored: Option<String> = sqlx::query_scalar(
        "SELECT customer_fields_masked #>> '{confirm_idempotency_key_hash}' \
           FROM payment_attempts WHERE id = $1",
    )
    .bind(fixture.attempt_id)
    .fetch_one(&mut *tx)
    .await
    .expect("stored hash");
    assert_eq!(stored.as_deref(), Some(hash.as_str()));

    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn claim_finalize_allows_a_late_success_only_once_the_status_is_unchanged() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let mut tx = prepare(&pool).await;
    let fixture = seed(&mut tx).await;
    let store = PgFlowStore::new(pool.clone());
    let attempt_id = fixture.attempt_id.to_string();

    sqlx::query(
        "UPDATE payment_attempts SET status = 'FAILED', terminal_at = now(), first_terminal_at = now() \
          WHERE id = $1",
    )
    .bind(fixture.attempt_id)
    .execute(&mut *tx)
    .await
    .expect("mark failed");

    assert!(store
        .claim_finalize_on(&mut tx, &attempt_id, PaymentStatus::Failed)
        .await
        .expect("late-success claim"));

    sqlx::query("UPDATE payment_attempts SET status = 'SUCCEEDED' WHERE id = $1")
        .bind(fixture.attempt_id)
        .execute(&mut *tx)
        .await
        .expect("mark succeeded");
    assert!(!store
        .claim_finalize_on(&mut tx, &attempt_id, PaymentStatus::Failed)
        .await
        .expect("claimed by a later reader"));
    assert!(!store
        .claim_finalize_on(&mut tx, &attempt_id, PaymentStatus::Created)
        .await
        .expect("wrong status"));

    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn cancel_is_a_single_conditional_transition() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let mut tx = prepare(&pool).await;
    let fixture = seed(&mut tx).await;
    let store = PgFlowStore::new(pool.clone());
    let attempt_id = fixture.attempt_id.to_string();

    let first = store
        .cancel_attempt_on(&mut tx, &attempt_id)
        .await
        .expect("cancel");
    assert_eq!(first.status, PaymentStatus::Cancelled);
    assert!(first.released);

    let second = store
        .cancel_attempt_on(&mut tx, &attempt_id)
        .await
        .expect("repeat cancel");
    assert_eq!(second.status, PaymentStatus::Cancelled);
    assert!(!second.released);

    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn records_step_logs_in_the_caller_transaction() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let mut tx = prepare(&pool).await;
    let fixture = seed(&mut tx).await;
    let store = PgFlowStore::new(pool.clone());

    store
        .record_step_on(
            &mut tx,
            StepLogRecord {
                attempt_id: fixture.attempt_id.to_string(),
                gateway_version_id: Some(fixture.gateway_version_id.to_string()),
                phase: FlowPhase::Initiate,
                step_id: fixture.step_id.to_string(),
                step_order: 0,
                redacted_request: serde_json::json!({"mobile_number": "0912345678"}),
                redacted_response_text: "{\"status\":\"OTP_SENT\"}".to_owned(),
                http_status: Some(200),
                duration_ms: 42,
                outcome: "SUCCEEDED".to_owned(),
                created_at: chrono::Utc::now(),
            },
        )
        .await
        .expect("record step");

    let (step_order, status, outcome, response): (i32, Option<i32>, String, String) =
        sqlx::query_as(
            "SELECT step_order, http_status, outcome, redacted_response_text \
           FROM attempt_step_logs WHERE attempt_id = $1",
        )
        .bind(fixture.attempt_id)
        .fetch_one(&mut *tx)
        .await
        .expect("step log row");
    assert_eq!(step_order, 0);
    assert_eq!(status, Some(200));
    assert_eq!(outcome, "SUCCEEDED");
    assert!(response.contains("OTP_SENT"));

    tx.rollback().await.expect("rollback");
}

// ---------------------------------------------------------------------------------------------
// FlowProvider
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn materialises_the_stored_flow_through_materialize_flow() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let mut tx = prepare(&pool).await;
    let fixture = seed(&mut tx).await;
    let attempt = fixture.attempt();
    let provider = PgFlowProvider::new(pool.clone()).without_cache();

    let steps = provider
        .load_steps_on(&mut tx, FlowPhase::Initiate, &attempt)
        .await
        .expect("flow steps");
    assert_eq!(steps.len(), 1);
    let step = &steps[0];
    assert_eq!(step.id, fixture.step_id.to_string());
    assert_eq!(step.order_index, 0);
    assert_eq!(
        step.url_template.as_deref(),
        Some("https://sandbox.adapters.test/verify"),
        "the named base URL is resolved and its trailing slash dropped"
    );
    assert_eq!(step.content_type.as_deref(), Some("application/json"));
    assert_eq!(
        step.side_effect,
        pg_flow_engine::SideEffect::SendsNotification
    );
    assert_eq!(
        step.retry_policy,
        pg_flow_engine::RetryPolicy::SafeWithCooldown
    );
    assert_eq!(step.parameters.len(), 1);
    assert_eq!(step.parameters[0].key, "mobile_number");
    assert_eq!(
        step.parameters[0].source,
        pg_flow_engine::ParameterSource::CustomerField
    );
    assert_eq!(step.outputs.len(), 1);
    assert_eq!(step.outputs[0].name, "process_id");
    assert_eq!(step.outputs[0].store_as, pg_flow_engine::OutputStore::State);
    assert_eq!(step.status_rules.len(), 1);
    assert_eq!(
        step.status_rules[0].canonical_status,
        pg_flow_engine::CanonicalStepStatus::AwaitingCustomer
    );

    let empty = provider
        .load_steps_on(&mut tx, FlowPhase::Submit, &attempt)
        .await
        .expect("no submit flow");
    assert!(empty.is_empty());

    tx.rollback().await.expect("rollback");
}

// ---------------------------------------------------------------------------------------------
// SlotStore
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn slot_reservation_commit_and_suspense_overflow_are_atomic() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let mut tx = prepare(&pool).await;
    let fixture = seed(&mut tx).await;
    let attempt = fixture.attempt();
    let slots = PgSlotStore::new(pool.clone());

    let reservation = slots.reserve_on(&mut tx, &attempt).await.expect("reserve");
    assert_eq!(
        reservation.reservation_id,
        format!("{}:{}", fixture.link_id, fixture.attempt_id)
    );
    assert_eq!(reservation.link_id, Some(fixture.link_id.to_string()));

    let busy = slots
        .reserve_on(&mut tx, &attempt)
        .await
        .expect_err("only one slot");
    assert!(busy.to_string().contains("no available slot"), "{busy}");

    let (locked,): (i32,) =
        sqlx::query_as("SELECT active_locked_count FROM payment_links WHERE id = $1")
            .bind(fixture.link_id)
            .fetch_one(&mut *tx)
            .await
            .expect("locked count");
    assert_eq!(locked, 1);

    let commit = slots.commit_on(&mut tx, &attempt).await.expect("commit");
    assert_eq!(commit.outcome, pg_flow_engine::SlotOutcome::Committed);
    let (confirmed, locked, state): (i32, i32, String) = sqlx::query_as(
        "SELECT confirmed_count, active_locked_count, state::text \
           FROM payment_links WHERE id = $1",
    )
    .bind(fixture.link_id)
    .fetch_one(&mut *tx)
    .await
    .expect("link counters");
    assert_eq!(confirmed, 1);
    assert_eq!(locked, 0);
    assert_eq!(state, "COMPLETED");

    // A second settlement on a single-use link is real money without a slot: SUSPENSE.
    let overflow = slots
        .commit_on(&mut tx, &attempt)
        .await
        .expect("suspense commit");
    assert_eq!(overflow.outcome, pg_flow_engine::SlotOutcome::Suspense);
    assert_eq!(overflow.reason.as_deref(), Some("SLOT_ALREADY_SETTLED"));
    let journal_entry_id = overflow.journal_entry_id.expect("suspense journal");
    assert!(Uuid::parse_str(&journal_entry_id).is_ok());
    let adjustment = overflow.adjustment_id.expect("refund draft");
    let operator_case = overflow.operator_case_id.expect("operator case");

    let (ref_type, ref_id): (String, String) =
        sqlx::query_as("SELECT ref_type::text, ref_id FROM journal_entries WHERE id = $1")
            .bind(Uuid::parse_str(&journal_entry_id).expect("uuid"))
            .fetch_one(&mut *tx)
            .await
            .expect("journal entry");
    assert_eq!(ref_type, "PAYMENT_ATTEMPT");
    assert_eq!(ref_id, fixture.attempt_id.to_string());

    let state: String = sqlx::query_scalar("SELECT state::text FROM adjustments WHERE id = $1")
        .bind(Uuid::parse_str(&adjustment).expect("uuid"))
        .fetch_one(&mut *tx)
        .await
        .expect("adjustment");
    assert_eq!(state, "PENDING_REVIEW");

    let (kind, priority, case_state, events): (String, String, String, i64) = sqlx::query_as(
        "SELECT c.kind::text, c.priority::text, c.state::text, \
                (SELECT count(*) FROM operator_case_events e WHERE e.case_id = c.id) \
           FROM operator_cases c WHERE c.id = $1",
    )
    .bind(Uuid::parse_str(&operator_case).expect("uuid"))
    .fetch_one(&mut *tx)
    .await
    .expect("operator case");
    assert_eq!(kind, "LATE_SUCCESS");
    assert_eq!(priority, "P1");
    assert_eq!(case_state, "OPEN");
    assert_eq!(events, 1);

    tx.rollback().await.expect("rollback");
}

// ---------------------------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn ledger_posts_join_the_callers_transaction_and_roll_back_with_it() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let mut tx = prepare(&pool).await;
    let fixture = seed(&mut tx).await;
    let ledger = PgLedgerAdapter::new(pool.clone());
    let posting = ConfirmationPosting {
        attempt_id: fixture.attempt_id.to_string(),
        ownership_mode: OwnershipMode::PlatformClearing,
        fee_bearer: FeeBearer::MerchantAbsorbs,
        fee_accrual: false,
        amount: dec("100.0000"),
        surcharge_amount: dec("0.0000"),
        commission_amount: dec("3.0000"),
        merchant_amount: dec("97.0000"),
        gateway_fee_amount: Some(dec("1.0000")),
        provider_fee_amount: Some(dec("1.0000")),
        scenario: LedgerScenario::PlatformHeldConfirmation,
        merchant_id: Some(fixture.merchant_id.to_string()),
        gateway_id: Some(fixture.gateway_id.to_string()),
        credential_set_id: Some(fixture.credential_set_id.to_string()),
        wallet_gl_account_id: Some(fixture.wallet_gl_id.to_string()),
        currency: CURRENCY.to_owned(),
        env: Environment::Live,
    };
    // The template must balance before the database sees it.
    assert!(matches!(
        confirmation_template(&posting).expect("template"),
        pg_flow_engine::adapters::ScenarioTemplate::Post(_)
    ));

    let posted = ledger
        .post_confirmation_on(&mut tx, &posting)
        .await
        .expect("post confirmation");
    assert!(Uuid::parse_str(&posted.entry_id).is_ok());
    assert!(!posted.idempotent);
    assert!(!posted.entry_id.is_empty());

    let replay = ledger
        .post_confirmation_on(&mut tx, &posting)
        .await
        .expect("idempotent replay");
    assert_eq!(replay.entry_id, posted.entry_id);
    assert!(replay.idempotent);

    let lines: i64 =
        sqlx::query_scalar("SELECT count(*) FROM journal_lines WHERE entry_id = $1::uuid")
            .bind(&posted.entry_id)
            .fetch_one(&mut *tx)
            .await
            .expect("journal lines");
    assert_eq!(lines, 4, "treasury, provider fee, wallet and income");

    let scenario = ScenarioPosting {
        scenario: LedgerScenario::SuspenseSettlement,
        stage: None,
        ref_id: format!("{}-scenario", fixture.attempt_id),
        amount: dec("10.0000"),
        commission_amount: dec("0.0000"),
        merchant_amount: dec("0.0000"),
        merchant_id: Some(fixture.merchant_id.to_string()),
        gateway_id: Some(fixture.gateway_id.to_string()),
        credential_set_id: Some(fixture.credential_set_id.to_string()),
        wallet_gl_account_id: None,
        currency: CURRENCY.to_owned(),
        env: Environment::Live,
    };
    let scheduled = ledger
        .post_scenario_on(&mut tx, &scenario)
        .await
        .expect("post scenario");
    assert!(Uuid::parse_str(&scheduled.entry_id).is_ok());

    let reference = fixture.attempt_id.to_string();
    tx.rollback().await.expect("rollback");

    // A fresh connection cannot see the rolled-back posting.
    let remaining: i64 =
        sqlx::query_scalar("SELECT count(*) FROM journal_entries WHERE ref_id = $1")
            .bind(&reference)
            .fetch_one(&pool)
            .await
            .expect("count after rollback");
    assert_eq!(remaining, 0, "the posting joined the caller's transaction");
}

#[tokio::test]
async fn case_sink_writes_one_case_and_its_opened_event() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let mut tx = prepare(&pool).await;
    let fixture = seed(&mut tx).await;
    let sink = PgCaseSink::new(pool.clone());
    let id = sink
        .open_on(
            &mut tx,
            &OperatorCaseInput {
                kind: "CONFLICT".to_owned(),
                priority: CasePriority::P1,
                attempt_id: fixture.attempt_id.to_string(),
                title: "Conflicting trusted signals".to_owned(),
                detail: "A failure arrived after a trusted success.".to_owned(),
                sla_due_at: chrono::Utc::now() + chrono::Duration::hours(4),
            },
        )
        .await
        .expect("open case");
    let (kind, priority, events): (String, String, i64) = sqlx::query_as(
        "SELECT c.kind::text, c.priority::text, \
                (SELECT count(*) FROM operator_case_events e WHERE e.case_id = c.id) \
           FROM operator_cases c WHERE c.id = $1",
    )
    .bind(id)
    .fetch_one(&mut *tx)
    .await
    .expect("case");
    assert_eq!(kind, "CONFLICT");
    assert_eq!(priority, "P1");
    assert_eq!(events, 1);
    tx.rollback().await.expect("rollback");
}

/// The in-memory attempt used by the provider test keeps the fixture's ids.
#[allow(dead_code)]
fn fixture_attempt(fixture: &adapters_support::Fixture) -> Attempt {
    fixture.attempt()
}

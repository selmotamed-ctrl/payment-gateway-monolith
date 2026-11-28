//! Database-gated integration tests for the concrete workers.
//!
//! They run against `PG_TEST_DATABASE_URL` (default
//! `postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test`, schema 46) and skip with
//! a message when that database is unreachable, so `cargo test -p pg-workers` is green on a machine
//! without PostgreSQL. Every test creates uniquely-named rows and removes them again; the
//! append-only tables are cleaned through the maintenance settings in
//! `pg_workers::db::APPEND_ONLY_CLEANUP_SQL` (superuser only).

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::Utc;
use pg_workers::cases::{platform_subject_key, MonitorPriority};
use pg_workers::checkpoint::{CheckpointService, ShardCaptureStatus};
use pg_workers::db::{now_tz, APPEND_ONLY_CLEANUP_SQL};
use pg_workers::inbox::{
    InboundError, InboundEventHandler, InboundEventRow, InboundInboxWorker, InboundOutcome,
    InboxConfig,
};
use pg_workers::monitor::{
    MonitorCaseClear, MonitorCaseRaise, MonitorCaseSink, MonitorConfig, MonitorContext,
    PgMonitorCaseSink, PlatformMonitorCheck, PlatformMonitorWorker,
};
use pg_workers::monitor_checks::{
    BackgroundJobQueueAgeCheck, CheckpointStalenessCheck, CommunicationReadinessCheck,
    CommunicationSettingsSource, CommunicationSnapshot, JournalDefaultPartitionCheck,
    KybScanBacklogCheck, ObjectStorageCheck, ObjectStorageHealth, ObjectStorageProbe,
    OldestPendingCheck, StaleUnknownCheck, UnscheduledRefundCheck, WorkerStalenessCheck,
};
use pg_workers::outbox::{
    enqueue_outbox_event, OutboxConsumer, OutboxEnvelope, OutboxRegistry, OutboxRelayConfig,
    OutboxRelayWorker, OutboxRetention,
};
use pg_workers::runtime::WorkerError;
use sqlx::{PgPool, Row};

const DEFAULT_TEST_DATABASE_URL: &str =
    "postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test";

async fn test_pool() -> Option<PgPool> {
    let url = std::env::var("PG_TEST_DATABASE_URL")
        .unwrap_or_else(|_| DEFAULT_TEST_DATABASE_URL.to_owned());
    let attempt = async {
        PgPool::connect(&url)
            .await
            .map_err(|error| error.to_string())
    };
    let pool = match tokio::time::timeout(Duration::from_secs(3), attempt).await {
        Ok(Ok(pool)) => pool,
        _ => {
            eprintln!("skip: PostgreSQL not reachable at {url}");
            return None;
        }
    };
    let version: Result<String, _> = sqlx::query_scalar("SELECT current_database()")
        .fetch_one(&pool)
        .await;
    if version.is_err() {
        eprintln!("skip: PostgreSQL session failed");
        return None;
    }
    Some(pool)
}

async fn exec_cleanup(pool: &PgPool, statements: &[(&str, Vec<String>)]) {
    let Ok(mut tx) = pool.begin().await else {
        return;
    };
    let _ = sqlx::query(APPEND_ONLY_CLEANUP_SQL).execute(&mut *tx).await;
    for (sql, values) in statements {
        let mut query = sqlx::query(sqlx::AssertSqlSafe(*sql));
        for value in values {
            query = query.bind(value.as_str());
        }
        let _ = query.execute(&mut *tx).await;
    }
    let _ = tx.commit().await;
}

// -------------------------------------------------------------------------------------------
// Outbox relay
// -------------------------------------------------------------------------------------------

struct FlakyConsumer {
    failing_aggregate: String,
}

#[async_trait]
impl OutboxConsumer for FlakyConsumer {
    async fn consume(
        &self,
        _conn: &mut sqlx::PgConnection,
        events: &[OutboxEnvelope],
    ) -> Result<(), WorkerError> {
        if events
            .iter()
            .any(|event| event.aggregate_id == self.failing_aggregate)
        {
            return Err(WorkerError::Failed("poison event".to_owned()));
        }
        Ok(())
    }
}

#[tokio::test]
async fn outbox_relay_parks_a_poison_event_and_requeues_it() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let suffix = uuid::Uuid::now_v7().to_string();
    let topic = format!("test.worker.{suffix}");
    let good = format!("good-{suffix}");
    let bad = format!("bad-{suffix}");

    let mut conn = pool.acquire().await.expect("connection");
    for aggregate in [&good, &bad] {
        let event = OutboxEnvelope {
            id: String::new(),
            topic: topic.clone(),
            aggregate_type: "TEST".to_owned(),
            aggregate_id: aggregate.clone(),
            merchant_id: None,
            payload: serde_json::json!({ "suffix": suffix }),
        };
        enqueue_outbox_event(&mut conn, &event, now_tz())
            .await
            .expect("enqueue");
    }
    drop(conn);

    let registry = Arc::new(OutboxRegistry::new().with_per_event(
        &topic,
        Arc::new(FlakyConsumer {
            failing_aggregate: bad.clone(),
        }),
    ));
    let relay = OutboxRelayWorker::new(
        pool.clone(),
        registry,
        OutboxRelayConfig {
            interval_ms: 10,
            max_idle_interval_ms: 20,
            batch_size: 100,
            max_attempts: 2,
            retention: None,
            topics: Some(vec![topic.clone()]),
        },
    );

    // First drain: the good event is acknowledged, the bad one has attempt 1.
    let processed = relay.drain().await.expect("first drain");
    assert_eq!(processed, 1);
    let attempts: i32 =
        sqlx::query_scalar("SELECT attempts FROM outbox_events WHERE aggregate_id = $1")
            .bind(&bad)
            .fetch_one(&pool)
            .await
            .expect("attempts");
    assert_eq!(attempts, 1);
    let parked: Option<chrono::DateTime<Utc>> =
        sqlx::query_scalar("SELECT parked_at FROM outbox_events WHERE aggregate_id = $1")
            .bind(&bad)
            .fetch_one(&pool)
            .await
            .expect("parked");
    assert!(parked.is_none());

    // Second drain parks it, audits it and opens one keyed case for the topic.
    relay.drain().await.expect("second drain");
    let row = sqlx::query("SELECT attempts, parked_at FROM outbox_events WHERE aggregate_id = $1")
        .bind(&bad)
        .fetch_one(&pool)
        .await
        .expect("parked row");
    assert_eq!(row.get::<i32, _>("attempts"), 2);
    assert!(row
        .get::<Option<chrono::DateTime<Utc>>, _>("parked_at")
        .is_some());

    let subject_key = format!("outbox.parked:{topic}");
    let case_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM operator_cases WHERE subject_key = $1 AND state <> 'RESOLVED'",
    )
    .bind(&subject_key)
    .fetch_one(&pool)
    .await
    .expect("case count");
    assert_eq!(case_count, 1);
    let audit_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE action = 'OUTBOX_EVENT_PARKED' AND entity_id = $1",
    )
    .bind(
        sqlx::query_scalar::<_, i64>("SELECT id FROM outbox_events WHERE aggregate_id = $1")
            .bind(&bad)
            .fetch_one(&pool)
            .await
            .expect("bad id")
            .to_string(),
    )
    .fetch_one(&pool)
    .await
    .expect("audit count");
    assert_eq!(audit_count, 1);

    // A parked event is invisible to the next drain; requeue brings it back with attempts reset.
    let processed = relay.drain().await.expect("third drain");
    assert_eq!(processed, 0);
    let requeued = relay.requeue_parked(Some(&topic)).await.expect("requeue");
    assert_eq!(requeued, 1);
    let attempts: i32 =
        sqlx::query_scalar("SELECT attempts FROM outbox_events WHERE aggregate_id = $1")
            .bind(&bad)
            .fetch_one(&pool)
            .await
            .expect("reset attempts");
    assert_eq!(attempts, 0);

    exec_cleanup(
        &pool,
        &[
            (
                "DELETE FROM operator_case_events WHERE case_id IN (SELECT id FROM operator_cases WHERE subject_key = $1)",
                vec![subject_key.clone()],
            ),
            (
                "DELETE FROM operator_cases WHERE subject_key = $1",
                vec![subject_key.clone()],
            ),
            (
                "DELETE FROM audit_log WHERE action = 'OUTBOX_EVENT_PARKED' AND entity_id IN (SELECT id::text FROM outbox_events WHERE topic = $1)",
                vec![topic.clone()],
            ),
            ("DELETE FROM outbox_events WHERE topic = $1", vec![topic.clone()]),
        ],
    )
    .await;
}

#[tokio::test]
async fn outbox_prune_never_touches_pending_rows() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let suffix = uuid::Uuid::now_v7().to_string();
    let topic = format!("test.prune.{suffix}");
    let mut conn = pool.acquire().await.expect("connection");
    // The pending row is inserted FIRST so it owns a lower id than the processed row: the bounded
    // prune walks only below the oldest pending id, so the processed row must survive it.
    let pending_aggregate = format!("pending-{suffix}");
    let processed_aggregate = format!("processed-{suffix}");
    for (aggregate, processed) in [(&pending_aggregate, false), (&processed_aggregate, true)] {
        let event = OutboxEnvelope {
            id: String::new(),
            topic: topic.clone(),
            aggregate_type: "TEST".to_owned(),
            aggregate_id: aggregate.clone(),
            merchant_id: None,
            payload: serde_json::json!({}),
        };
        enqueue_outbox_event(&mut conn, &event, now_tz() - chrono::Duration::days(1))
            .await
            .expect("enqueue");
        if processed {
            sqlx::query(
                "UPDATE outbox_events SET processed_at = now() - interval '1 day' WHERE aggregate_id = $1",
            )
            .bind(&event.aggregate_id)
            .execute(&mut *conn)
            .await
            .expect("mark processed");
        }
    }
    drop(conn);

    let relay = OutboxRelayWorker::new(
        pool.clone(),
        Arc::new(OutboxRegistry::new().with_known_topic(&topic)),
        OutboxRelayConfig {
            retention: Some(OutboxRetention {
                retention_ms: 60_000,
                prune_interval_ms: 0,
                prune_batch_size: 100,
            }),
            topics: Some(vec![topic.clone()]),
            ..OutboxRelayConfig::default()
        },
    );
    let _ = relay.prune(Utc::now()).await.expect("prune");
    let remaining: i64 = sqlx::query_scalar("SELECT count(*) FROM outbox_events WHERE topic = $1")
        .bind(&topic)
        .fetch_one(&pool)
        .await
        .expect("remaining");
    assert_eq!(
        remaining, 2,
        "the pending row pins the prune boundary and is never deleted"
    );
    let pending: String = sqlx::query_scalar(
        "SELECT aggregate_id FROM outbox_events WHERE topic = $1 AND processed_at IS NULL",
    )
    .bind(&topic)
    .fetch_one(&pool)
    .await
    .expect("pending id");
    assert_eq!(pending, pending_aggregate);

    exec_cleanup(
        &pool,
        &[(
            "DELETE FROM outbox_events WHERE topic = $1",
            vec![topic.clone()],
        )],
    )
    .await;
}

// -------------------------------------------------------------------------------------------
// Inbound inbox
// -------------------------------------------------------------------------------------------

struct RecordingHandler;

#[async_trait]
impl InboundEventHandler for RecordingHandler {
    async fn handle(&self, _event: &InboundEventRow) -> Result<InboundOutcome, InboundError> {
        Ok(InboundOutcome::processed())
    }
}

#[tokio::test]
async fn inbound_results_require_the_claim_owner() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let reference: Option<(uuid::Uuid, uuid::Uuid)> = sqlx::query_as(
        "SELECT v.gateway_id, c.id AS channel_id
           FROM confirmation_channels c
           JOIN gateway_versions v ON v.id = c.gateway_version_id
          ORDER BY c.created_at ASC LIMIT 1",
    )
    .fetch_optional(&pool)
    .await
    .expect("reference rows");
    let Some((gateway_id, channel_id)) = reference else {
        eprintln!("skip: no confirmation channel in the test database");
        return;
    };

    let suffix = uuid::Uuid::now_v7().to_string();
    let owner = InboundInboxWorker::new(
        pool.clone(),
        InboxConfig {
            batch_size: 10,
            ..InboxConfig::default()
        }
        .with_worker_id("test-owner"),
        Arc::new(RecordingHandler),
    );
    let intruder = InboundInboxWorker::new(
        pool.clone(),
        InboxConfig::default().with_worker_id("test-intruder"),
        Arc::new(RecordingHandler),
    );

    let persisted = owner
        .persist_inbound_event(pg_workers::inbox::PersistInboundEvent {
            channel_id,
            gateway_id,
            env: "LIVE",
            raw_body: b"{\"event\":\"test\"}",
            headers: serde_json::json!({ "content-type": "application/json" }),
            source_ip: Some("127.0.0.1"),
            verified: true,
            verification_error: None,
            dedupe_key: &format!("test-inbox-{suffix}"),
            attempt_id: None,
        })
        .await
        .expect("persist");
    assert!(!persisted.duplicate);
    let duplicate = owner
        .persist_inbound_event(pg_workers::inbox::PersistInboundEvent {
            channel_id,
            gateway_id,
            env: "LIVE",
            raw_body: b"{\"event\":\"test\"}",
            headers: serde_json::json!({}),
            source_ip: None,
            verified: true,
            verification_error: None,
            dedupe_key: &format!("test-inbox-{suffix}"),
            attempt_id: None,
        })
        .await
        .expect("duplicate persist");
    assert!(duplicate.duplicate);
    assert_eq!(duplicate.id, persisted.id);

    // Claim as the owner directly (never drain the whole shared inbox).
    sqlx::query(
        "UPDATE inbound_events SET claimed_at = now(), claimed_by = 'test-owner', updated_at = now() WHERE id = $1",
    )
    .bind(persisted.id)
    .execute(&pool)
    .await
    .expect("claim");

    let event = sqlx::query_as::<_, InboundEventRow>(
        "SELECT id, channel_id, gateway_id, env, raw_body_bytes, redacted_headers_json, source_ip,
                verified, verification_error, dedupe_key, attempt_id, received_at, processed_at,
                processing_result, claimed_at, claimed_by
           FROM inbound_events WHERE id = $1",
    )
    .bind(persisted.id)
    .fetch_one(&pool)
    .await
    .expect("claimed row");

    assert!(!intruder
        .mark_processed(&event, "PROCESSED")
        .await
        .expect("intruder write"));
    let processed_at: Option<chrono::NaiveDateTime> =
        sqlx::query_scalar("SELECT processed_at FROM inbound_events WHERE id = $1")
            .bind(persisted.id)
            .fetch_one(&pool)
            .await
            .expect("processed_at");
    assert!(processed_at.is_none());

    assert!(owner
        .mark_processed(&event, "PROCESSED")
        .await
        .expect("owner write"));
    let row = sqlx::query(
        "SELECT processed_at, processing_result, claimed_by FROM inbound_events WHERE id = $1",
    )
    .bind(persisted.id)
    .fetch_one(&pool)
    .await
    .expect("finalized row");
    assert!(row
        .get::<Option<chrono::NaiveDateTime>, _>("processed_at")
        .is_some());
    assert_eq!(row.get::<String, _>("processing_result"), "PROCESSED");
    assert!(row.get::<Option<String>, _>("claimed_by").is_none());

    let _ = sqlx::query("DELETE FROM inbound_events WHERE dedupe_key = $1")
        .bind(format!("test-inbox-{suffix}"))
        .execute(&pool)
        .await;
}

// -------------------------------------------------------------------------------------------
// Ledger checkpoints
// -------------------------------------------------------------------------------------------

#[tokio::test]
async fn checkpoint_capture_advances_and_records_parity() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let gl_account_id = uuid::Uuid::now_v7();
    let seed_key = format!("test-checkpoint-{}", uuid::Uuid::now_v7());
    sqlx::query(
        "INSERT INTO gl_accounts (id, created_at, updated_at, account_type, currency, shard_count, seed_key)
         VALUES ($1, now(), now(), 'TREASURY', 'LYD', 1, $2)",
    )
    .bind(gl_account_id)
    .bind(&seed_key)
    .execute(&pool)
    .await
    .expect("gl account");
    sqlx::query(
        "INSERT INTO gl_account_shards (gl_account_id, shard_id, current_balance, line_seq, updated_at)
         VALUES ($1, 0, 0, 0, now())
         ON CONFLICT (gl_account_id, shard_id) DO UPDATE SET current_balance = 0, line_seq = 0",
    )
    .bind(gl_account_id)
    .execute(&pool)
    .await
    .expect("shard");

    let service = CheckpointService::new(pool.clone());
    let noop = service
        .capture_shard(gl_account_id, 0)
        .await
        .expect("empty capture");
    assert_eq!(noop.status, ShardCaptureStatus::Noop);

    // The projection claims a sequence and a balance the journal does not back.
    sqlx::query(
        "INSERT INTO gl_shard_checkpoints
             (gl_account_id, shard_id, checkpoint_balance, checkpoint_seq, checkpoint_at, verified_at,
              status, failure_kind, consecutive_failures)
         VALUES ($1, 0, 99, 5, now(), now(), 'OK', NULL, 0)
         ON CONFLICT (gl_account_id, shard_id) DO UPDATE SET checkpoint_balance = 99, checkpoint_seq = 5",
    )
    .bind(gl_account_id)
    .execute(&pool)
    .await
    .expect("checkpoint");
    sqlx::query("UPDATE gl_account_shards SET current_balance = 100, line_seq = 5 WHERE gl_account_id = $1 AND shard_id = 0")
        .bind(gl_account_id)
        .execute(&pool)
        .await
        .expect("projection");

    let parity = service
        .capture_shard(gl_account_id, 0)
        .await
        .expect("parity capture");
    assert_eq!(parity.status, ShardCaptureStatus::Parity);
    assert!(!parity.drift.is_zero());
    assert!(parity.first_failure);
    let failures: i32 = sqlx::query_scalar(
        "SELECT consecutive_failures FROM gl_shard_checkpoints WHERE gl_account_id = $1 AND shard_id = 0",
    )
    .bind(gl_account_id)
    .fetch_one(&pool)
    .await
    .expect("failures");
    assert_eq!(failures, 1);

    // The worker's candidate query excludes the failed shard until the retry window elapses.
    let candidates = service
        .find_candidates(0, 1, 600, 100)
        .await
        .expect("candidates");
    assert!(candidates
        .iter()
        .all(|candidate| candidate.gl_account_id != gl_account_id));

    exec_cleanup(
        &pool,
        &[
            (
                "DELETE FROM gl_shard_checkpoints WHERE gl_account_id = $1::uuid",
                vec![gl_account_id.to_string()],
            ),
            (
                "DELETE FROM gl_account_shards WHERE gl_account_id = $1::uuid",
                vec![gl_account_id.to_string()],
            ),
            (
                "DELETE FROM gl_accounts WHERE id = $1::uuid",
                vec![gl_account_id.to_string()],
            ),
        ],
    )
    .await;
}

// -------------------------------------------------------------------------------------------
// Monitor checks: every SQL predicate against the real schema
// -------------------------------------------------------------------------------------------

struct HealthyVault;
#[async_trait]
impl ObjectStorageProbe for HealthyVault {
    async fn health(&self) -> Result<ObjectStorageHealth, String> {
        Ok(ObjectStorageHealth {
            ok: true,
            mode: "LOCAL".to_owned(),
            root_dir_or_url: "/tmp/vault".to_owned(),
            error: None,
        })
    }
}

struct ConfiguredComms;
#[async_trait]
impl CommunicationSettingsSource for ConfiguredComms {
    async fn configuration(&self) -> Result<CommunicationSnapshot, String> {
        Ok(CommunicationSnapshot {
            email_configured: true,
            ..CommunicationSnapshot::default()
        })
    }
}

#[tokio::test]
async fn platform_checks_execute_against_the_schema() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let ctx = MonitorContext {
        now: Utc::now(),
        registry: pg_workers::health::WorkerSnapshot::new(),
        pool: &pool,
    };
    let checks: Vec<Box<dyn PlatformMonitorCheck>> = vec![
        Box::new(OldestPendingCheck::outbox(300_000)),
        Box::new(OldestPendingCheck::audit_outbox(300_000)),
        Box::new(BackgroundJobQueueAgeCheck::new(
            300_000,
            MonitorPriority::P1,
        )),
        Box::new(KybScanBacklogCheck::new(7_200_000, MonitorPriority::P2)),
        Box::new(JournalDefaultPartitionCheck::new(
            1_000,
            MonitorPriority::P1,
        )),
        Box::new(StaleUnknownCheck::new(24, 5)),
        Box::new(UnscheduledRefundCheck::new(15, 5)),
        Box::new(CheckpointStalenessCheck::new(
            900_000,
            2.0,
            100,
            MonitorPriority::P2,
        )),
        Box::new(ObjectStorageCheck::new(Arc::new(HealthyVault), 1_800_000)),
        Box::new(CommunicationReadinessCheck::new(Arc::new(ConfiguredComms))),
    ];
    for check in checks {
        let result = check
            .run(&ctx)
            .await
            .unwrap_or_else(|error| panic!("{}: {error}", check.id()));
        // A seeded database legitimately has more stale shards than the check's LIMIT, so only the
        // scans with an unbounded subject set must report completeness.
        if check.id() != "checkpoint_stale" {
            assert!(
                result.complete,
                "{} must report a complete scan",
                check.id()
            );
        }
    }
}

// -------------------------------------------------------------------------------------------
// Platform monitor sink
// -------------------------------------------------------------------------------------------

#[tokio::test]
async fn monitor_sink_is_idempotent_per_subject_and_clears() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let suffix = uuid::Uuid::now_v7().to_string();
    let subject_key = platform_subject_key("worker_stale", Some(&format!("TestWorker-{suffix}")));
    let sink = PgMonitorCaseSink::new(
        pool.clone(),
        pg_workers::monitor::MonitorSinkConfig::default(),
    );
    let raise = MonitorCaseRaise {
        subject_key: subject_key.clone(),
        title: "Worker has stopped succeeding".to_owned(),
        detail: "TestWorker has had no successful tick for 10 min".to_owned(),
        priority: MonitorPriority::P1,
        now: Utc::now(),
    };
    assert!(sink.raise(&raise).await.expect("first raise"));
    assert!(!sink.raise(&raise).await.expect("second raise"));
    let active = sink
        .list_active_keys("platform.worker_stale")
        .await
        .expect("active keys");
    assert!(active.contains(&subject_key));

    let cases: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM operator_cases WHERE subject_key = $1 AND kind = 'MANUAL_REVIEW' AND state = 'OPEN'",
    )
    .bind(&subject_key)
    .fetch_one(&pool)
    .await
    .expect("case count");
    assert_eq!(cases, 1);

    sink.clear(&MonitorCaseClear {
        subject_key: subject_key.clone(),
        detail: "Condition no longer observed by the platform monitor".to_owned(),
        now: Utc::now(),
    })
    .await
    .expect("clear");
    let state: String =
        sqlx::query_scalar("SELECT state::text FROM operator_cases WHERE subject_key = $1")
            .bind(&subject_key)
            .fetch_one(&pool)
            .await
            .expect("state");
    assert_eq!(state, "RESOLVED");
    let code: Option<String> =
        sqlx::query_scalar("SELECT resolution_code FROM operator_cases WHERE subject_key = $1")
            .bind(&subject_key)
            .fetch_one(&pool)
            .await
            .expect("code");
    assert_eq!(code.as_deref(), Some("SOURCE_CLEARED"));
    assert!(sink
        .list_active_keys("platform.worker_stale")
        .await
        .expect("active after clear")
        .is_empty());

    // A cleared condition re-raises as a new case.
    assert!(sink.raise(&raise).await.expect("re-raise"));
    let open: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM operator_cases WHERE subject_key = $1 AND state <> 'RESOLVED'",
    )
    .bind(&subject_key)
    .fetch_one(&pool)
    .await
    .expect("open after re-raise");
    assert_eq!(open, 1);

    exec_cleanup(
        &pool,
        &[
            (
                "DELETE FROM audit_log WHERE entity_type = 'OPERATOR_CASE' AND entity_id IN (SELECT id::text FROM operator_cases WHERE subject_key = $1)",
                vec![subject_key.clone()],
            ),
            (
                "DELETE FROM operator_case_events WHERE case_id IN (SELECT id FROM operator_cases WHERE subject_key = $1)",
                vec![subject_key.clone()],
            ),
            (
                "DELETE FROM operator_cases WHERE subject_key = $1",
                vec![subject_key.clone()],
            ),
        ],
    )
    .await;
}

#[tokio::test]
async fn monitor_worker_raises_a_keyed_case_for_a_stale_worker() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let suffix = uuid::Uuid::now_v7().to_string();
    let check_id = format!("wprobe_{}", &suffix.replace('-', "")[..10]);
    // A dedicated check id keeps the test independent of the real worker names.
    struct LeakyCheck {
        id: &'static str,
        snapshot: pg_workers::health::WorkerSnapshot,
    }
    #[async_trait]
    impl pg_workers::monitor::PlatformMonitorCheck for LeakyCheck {
        fn id(&self) -> &'static str {
            self.id
        }
        async fn run(
            &self,
            _ctx: &pg_workers::monitor::MonitorContext<'_>,
        ) -> Result<pg_workers::monitor::MonitorCheckResult, WorkerError> {
            Ok(pg_workers::monitor::MonitorCheckResult::complete(
                WorkerStalenessCheck::findings(Utc::now(), &self.snapshot),
            ))
        }
    }
    // The check id must be a stable 'static string; use a shared leak for this test only.
    let leaked: &'static str = Box::leak(check_id.clone().into_boxed_str());
    let snapshot = pg_workers::health::WorkerSnapshot::new();
    let mut state = pg_workers::health::WorkerState::new("TestStaleWorker", false);
    state.running = true;
    state.interval_ms = 1_000;
    state.started_at = Some(
        (Utc::now() - chrono::Duration::seconds(600))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    );
    snapshot.register(state);

    let sink = Arc::new(PgMonitorCaseSink::new(
        pool.clone(),
        pg_workers::monitor::MonitorSinkConfig::default(),
    ));
    let worker = PlatformMonitorWorker::new(
        pool.clone(),
        vec![Arc::new(LeakyCheck {
            id: leaked,
            snapshot,
        })],
        sink,
        pg_workers::health::WorkerSnapshot::new(),
        MonitorConfig {
            interval_ms: 10,
            check_timeout_ms: 1_000,
            check_failure_threshold: 1,
        },
    )
    .expect("monitor");
    let summary = worker.tick_once().await.expect("tick");
    assert_eq!(
        summary.raised,
        vec![format!("platform.{leaked}:TestStaleWorker")]
    );

    exec_cleanup(
        &pool,
        &[
            (
                "DELETE FROM audit_log WHERE entity_type = 'OPERATOR_CASE' AND entity_id IN (SELECT id::text FROM operator_cases WHERE subject_key = $1)",
                vec![format!("platform.{leaked}:TestStaleWorker")],
            ),
            (
                "DELETE FROM operator_case_events WHERE case_id IN (SELECT id FROM operator_cases WHERE subject_key = $1)",
                vec![format!("platform.{leaked}:TestStaleWorker")],
            ),
            (
                "DELETE FROM operator_cases WHERE subject_key = $1",
                vec![format!("platform.{leaked}:TestStaleWorker")],
            ),
        ],
    )
    .await;
}

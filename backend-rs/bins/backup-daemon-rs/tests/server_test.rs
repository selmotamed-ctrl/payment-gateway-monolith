//! Port of `deploy/backup-daemon/test/server.test.ts`.

mod common;

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use backup_daemon::catalog::{
    create_default_policy, CatalogFileSystem, CatalogStore, CatalogStoreOptions,
    FailingCatalogFileSystem,
};
use backup_daemon::drill::{DrillRunOptions, DrillRunner};
use backup_daemon::engine::{
    BackupEngine, BackupExecutionResult, BackupKind, BackupSummary, BackupTarget, EngineError,
    EngineFuture, EngineHealth, WalIngestOutcome,
};
use backup_daemon::job_queue::JobQueue;
use backup_daemon::server::{BackupDaemonHandler, CallerRole, RouteRequest, ServerOptions};
use common::{
    make_config, make_drill_report, FakeDrillRunner, FakeEngine, PG_PASSWORD, S3_SECRET_KEY,
};
use serde_json::{json, Value};
use tokio::sync::Notify;

struct Harness {
    handler: BackupDaemonHandler,
    catalog: Arc<CatalogStore>,
}

async fn handler_with(
    engine: Arc<dyn BackupEngine>,
    drill: Arc<dyn DrillRunner>,
    jobs: Option<Arc<JobQueue>>,
    file_system: Option<Arc<dyn CatalogFileSystem>>,
) -> Harness {
    let catalog = Arc::new(
        CatalogStore::load(CatalogStoreOptions {
            path: std::path::PathBuf::from("/virtual/catalog.json"),
            default_policy: create_default_policy_with_now(),
            file_system,
            max_runs: None,
            max_drills: None,
            mirror: None,
            on_warning: None,
        })
        .await,
    );
    let jobs = jobs.unwrap_or_else(|| Arc::new(JobQueue::new(25, None, Box::new(common::now))));
    let mut options = ServerOptions::new(
        Arc::new(make_config(&[])),
        engine,
        drill,
        Arc::clone(&catalog),
        jobs,
        Arc::new(common::now),
    );
    let counter = Arc::new(AtomicUsize::new(0));
    options.id_factory = Arc::new(move || {
        let value = counter.fetch_add(1, Ordering::SeqCst) + 1;
        format!("id-{value}")
    });
    Harness {
        handler: BackupDaemonHandler::new(options),
        catalog,
    }
}

fn create_default_policy_with_now() -> backup_daemon::catalog::BackupPolicy {
    backup_daemon::catalog::BackupPolicy {
        updated_at: common::NOW_ISO.to_owned(),
        ..create_default_policy()
    }
}

async fn default_harness() -> Harness {
    handler_with(
        Arc::new(FakeEngine::new(
            |_, _| Ok(BackupExecutionResult::default()),
            |_| Box::pin(async { Ok(Default::default()) }),
        )),
        Arc::new(FakeDrillRunner::reports()),
        None,
        None,
    )
    .await
}

fn request(method: &str, path: &str, body: Option<Value>) -> RouteRequest {
    let (query, path) = match path.split_once('?') {
        Some((path, query)) => (query, path),
        None => ("", path),
    };
    let mut request = RouteRequest::new(method, path).with_query(query);
    if let Some(body) = body {
        let text = body.to_string();
        request = request
            .with_body(text.clone().into_bytes())
            .with_header("content-type", "application/json")
            .with_header("content-length", &text.len().to_string());
    }
    request
}

fn get(path: &str) -> RouteRequest {
    request("GET", path, None)
}

fn post(path: &str, body: Value) -> RouteRequest {
    request("POST", path, Some(body))
}

fn put(path: &str, body: Value) -> RouteRequest {
    request("PUT", path, Some(body))
}

#[tokio::test]
async fn health_exposes_status_engine_mode_and_version_without_secrets() {
    let harness = default_harness().await;
    let response = harness.handler.handle(get("/health")).await;
    assert_eq!(response.status.as_u16(), 200);
    let headers: BTreeMap<String, String> = response.headers.iter().cloned().collect();
    assert!(headers.contains_key("x-request-id"));
    assert!(headers["content-type"].contains("application/json"));
    assert_eq!(
        response.json_value().expect("json"),
        json!({"status": "ok", "engineMode": "wal-g", "version": "0.1.0"})
    );
}

#[tokio::test]
async fn overview_includes_wal_health_targets_schedule_policy_and_recent_runs() {
    let harness = default_harness().await;
    harness
        .catalog
        .add_run(backup_daemon::catalog::BackupRun {
            id: "run-1".to_owned(),
            target: "postgres_core".to_owned(),
            kind: "full".to_owned(),
            engine: "wal-g".to_owned(),
            status: "PASSED".to_owned(),
            started_at: common::NOW_ISO.to_owned(),
            completed_at: Some(common::NOW_ISO.to_owned()),
            duration_ms: Some(100),
            size_bytes: None,
            start_lsn: None,
            end_lsn: None,
            storage_targets: vec!["primary-s3".to_owned()],
            error_message: None,
        })
        .await;
    harness
        .catalog
        .add_drill(make_drill_report("drill-1"))
        .await;
    let response = harness.handler.handle(get("/v1/overview")).await;
    assert_eq!(response.status.as_u16(), 200);
    let body = response.json_value().expect("json");
    assert_eq!(body["generatedAt"], common::NOW_ISO);
    assert_eq!(body["engineMode"], "wal-g");
    assert_eq!(body["healthy"], true);
    assert_eq!(
        body["wal"],
        json!({
            "archiveLagSeconds": 2,
            "currentLsn": "0/16B6C50",
            "lastArchivedLsn": "0/16B6C00",
            "lagBytes": 80,
        })
    );
    assert_eq!(body["targets"].as_array().expect("targets").len(), 2);
    let schedule = &body["schedule"];
    assert_eq!(schedule["fullCron"], "0 2 * * 0");
    assert_eq!(schedule["deltaCron"], "0 2 * * 1-6");
    assert_eq!(schedule["drillCron"], "0 4 * * 0");
    assert_eq!(schedule["fullRetentionDays"], 56);
    assert_eq!(schedule["walRetentionDays"], 14);
    assert_eq!(schedule["alertLagSeconds"], 300);
    assert_eq!(body["backups"][0]["id"], "run-1");
    assert_eq!(body["latestDrill"]["id"], "drill-1");
    assert_eq!(body["drills"].as_array().expect("drills").len(), 1);
    assert_eq!(body["scheduler"]["enabled"], false);
}

#[tokio::test]
async fn trigger_returns_202_and_completes_asynchronously() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let calls_clone = Arc::clone(&calls);
    let engine = Arc::new(FakeEngine::new(
        move |target, kind| {
            calls_clone.lock().expect("calls").push((target, kind));
            Ok(BackupExecutionResult {
                storage_targets: vec!["primary-s3".to_owned()],
                size_bytes: Some(1024),
                start_lsn: Some("0/1".to_owned()),
                end_lsn: Some("0/2".to_owned()),
            })
        },
        |_| Box::pin(async { Ok(Default::default()) }),
    ));
    let harness = handler_with(engine, Arc::new(FakeDrillRunner::reports()), None, None).await;
    let response = harness
        .handler
        .handle(post(
            "/v1/backups/trigger",
            json!({"target": "postgres_core", "kind": "full", "requestedBy": "admin"}),
        ))
        .await;
    assert_eq!(response.status.as_u16(), 202);
    let body = response.json_value().expect("json");
    assert!(body["backupJobId"].is_string());
    assert!(body["acceptedAt"].is_string());
    harness.handler.state().when_idle().await;
    assert_eq!(
        *calls.lock().expect("calls"),
        vec![(BackupTarget::PostgresCore, BackupKind::Full)]
    );
    let run = harness.catalog.list_runs(1).remove(0);
    assert_eq!(run.status, "PASSED");
    assert_eq!(run.storage_targets, vec!["primary-s3".to_owned()]);
    assert_eq!(run.size_bytes, Some(1024));
}

#[tokio::test]
async fn trigger_validates_target_and_kind() {
    let harness = default_harness().await;
    for body in [
        json!({"target": "mysql", "kind": "full"}),
        json!({"target": "all", "kind": "weekly"}),
        json!({}),
    ] {
        let response = harness
            .handler
            .handle(post("/v1/backups/trigger", body))
            .await;
        assert_eq!(response.status.as_u16(), 400);
    }
}

#[tokio::test]
async fn drills_return_202_and_store_the_report_under_the_returned_id() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let calls_clone = Arc::clone(&calls);
    let drill = Arc::new(FakeDrillRunner::new(move |options: DrillRunOptions| {
        calls_clone.lock().expect("calls").push(options.clone());
        Ok(make_drill_report(
            options.id.as_deref().unwrap_or("unexpected"),
        ))
    }));
    let harness = handler_with(
        Arc::new(FakeEngine::new(
            |_, _| Ok(Default::default()),
            |_| Box::pin(async { Ok(Default::default()) }),
        )),
        drill,
        None,
        None,
    )
    .await;
    let response = harness
        .handler
        .handle(post("/v1/drills/run", json!({"requestedBy": "admin"})))
        .await;
    assert_eq!(response.status.as_u16(), 202);
    let drill_id = response.json_value().expect("json")["drillId"]
        .as_str()
        .expect("drill id")
        .to_owned();
    harness.handler.state().when_idle().await;
    let calls = calls.lock().expect("calls");
    assert_eq!(calls[0].id.as_deref(), Some(drill_id.as_str()));
    assert_eq!(harness.catalog.latest_drill().expect("latest").id, drill_id);
}

#[tokio::test]
async fn a_rejected_drill_runner_still_records_a_signed_failed_report() {
    let harness = handler_with(
        Arc::new(FakeEngine::new(
            |_, _| Ok(Default::default()),
            |_| Box::pin(async { Ok(Default::default()) }),
        )),
        Arc::new(FakeDrillRunner::failing("drill orchestration exploded")),
        None,
        None,
    )
    .await;
    let response = harness
        .handler
        .handle(post("/v1/drills/run", json!({})))
        .await;
    let drill_id = response.json_value().expect("json")["drillId"]
        .as_str()
        .expect("drill id")
        .to_owned();
    harness.handler.state().when_idle().await;
    let report = harness.catalog.latest_drill().expect("latest");
    assert_eq!(report.id, drill_id);
    assert_eq!(report.status, "FAILED");
    assert!(report
        .error_message
        .as_deref()
        .expect("message")
        .contains("drill orchestration exploded"));
    assert_eq!(report.report_signature.as_deref().map(str::len), Some(64));
}

#[tokio::test]
async fn policy_updates_schedule_and_rejects_invalid_cron() {
    let harness = default_harness().await;
    let valid = harness
        .handler
        .handle(put(
            "/v1/policy",
            json!({
                "fullCron": "0 3 * * 0",
                "deltaCron": "0 3 * * 1-6",
                "drillCron": "0 5 * * 0",
                "fullRetentionDays": 60,
                "walRetentionDays": 21,
                "alertLagSeconds": 120,
                "updatedBy": "operator-1",
            }),
        ))
        .await;
    assert_eq!(valid.status.as_u16(), 200);
    let policy = &valid.json_value().expect("json")["policy"];
    assert_eq!(policy["fullCron"], "0 3 * * 0");
    assert_eq!(policy["fullRetentionDays"], 60);
    assert_eq!(policy["updatedAt"], common::NOW_ISO);
    assert_eq!(harness.catalog.get_policy().wal_retention_days, 21);

    let invalid = harness
        .handler
        .handle(put(
            "/v1/policy",
            json!({
                "fullCron": "not a cron",
                "deltaCron": "0 3 * * 1-6",
                "drillCron": "0 5 * * 0",
                "fullRetentionDays": 60,
                "walRetentionDays": 21,
                "alertLagSeconds": 120,
            }),
        ))
        .await;
    assert_eq!(invalid.status.as_u16(), 400);
    assert_eq!(harness.catalog.get_policy().full_cron, "0 3 * * 0");
}

#[tokio::test]
async fn runs_and_drills_enforce_limit_validation() {
    let harness = default_harness().await;
    assert_eq!(
        harness
            .handler
            .handle(get("/v1/runs?limit=10"))
            .await
            .status
            .as_u16(),
        200
    );
    assert_eq!(
        harness
            .handler
            .handle(get("/v1/drills?limit=1"))
            .await
            .status
            .as_u16(),
        200
    );
    assert_eq!(
        harness
            .handler
            .handle(get("/v1/runs?limit=0"))
            .await
            .status
            .as_u16(),
        400
    );
    assert_eq!(
        harness
            .handler
            .handle(get("/v1/runs?limit=abc"))
            .await
            .status
            .as_u16(),
        400
    );
}

#[tokio::test]
async fn unknown_routes_return_404_json_and_wrong_methods_405_json() {
    let harness = default_harness().await;
    let missing = harness.handler.handle(get("/v1/nope")).await;
    assert_eq!(missing.status.as_u16(), 404);
    assert_eq!(
        missing.json_value().expect("json")["error"]["code"],
        "not_found"
    );
    let wrong = harness.handler.handle(post("/health", json!({}))).await;
    assert_eq!(wrong.status.as_u16(), 405);
    assert_eq!(
        wrong.json_value().expect("json")["error"]["code"],
        "method_not_allowed"
    );
}

#[tokio::test]
async fn redacts_secrets_from_overview_detail_and_failed_run_errors() {
    let engine = FakeEngine::new(
        |_, _| {
            Err(EngineError::Other(format!(
                "backup failed password={PG_PASSWORD} secret={S3_SECRET_KEY}"
            )))
        },
        |_| Box::pin(async { Ok(Default::default()) }),
    );
    if let Ok(mut health) = engine.health.lock() {
        health.targets[0].detail = format!("token={S3_SECRET_KEY}");
    }
    let harness = handler_with(
        Arc::new(engine),
        Arc::new(FakeDrillRunner::reports()),
        None,
        None,
    )
    .await;
    let overview = harness.handler.handle(get("/v1/overview")).await;
    let overview_text = String::from_utf8(overview.body.clone()).expect("text");
    assert!(!overview_text.contains(S3_SECRET_KEY));
    assert!(overview_text.contains("[REDACTED]"));

    harness
        .handler
        .handle(post(
            "/v1/backups/trigger",
            json!({"target": "all", "kind": "full"}),
        ))
        .await;
    harness.handler.state().when_idle().await;
    let runs = harness.handler.handle(get("/v1/runs")).await;
    let runs_text = String::from_utf8(runs.body.clone()).expect("text");
    assert!(!runs_text.contains(PG_PASSWORD));
    assert!(!runs_text.contains(S3_SECRET_KEY));
    let body: Value = serde_json::from_str(&runs_text).expect("json");
    assert_eq!(body["runs"][0]["status"], "FAILED");
    assert!(body["runs"][0]["errorMessage"]
        .as_str()
        .expect("message")
        .contains("[REDACTED]"));
}

#[tokio::test]
async fn an_engine_rejection_is_recorded_as_failed_without_crashing_the_daemon() {
    let harness = handler_with(
        Arc::new(FakeEngine::new(
            |_, _| Err(EngineError::Other("engine is unavailable".to_owned())),
            |_| Box::pin(async { Ok(Default::default()) }),
        )),
        Arc::new(FakeDrillRunner::reports()),
        None,
        None,
    )
    .await;
    assert_eq!(
        harness
            .handler
            .handle(post(
                "/v1/backups/trigger",
                json!({"target": "audit_db", "kind": "delta"}),
            ))
            .await
            .status
            .as_u16(),
        202
    );
    harness.handler.state().when_idle().await;
    let run = harness.catalog.list_runs(1).remove(0);
    assert_eq!(run.status, "FAILED");
    assert_eq!(run.error_message.as_deref(), Some("engine is unavailable"));
    assert_eq!(
        harness.handler.handle(get("/health")).await.status.as_u16(),
        200
    );
}

#[tokio::test]
async fn a_catalog_write_failure_does_not_prevent_accepted_jobs_from_being_tracked_in_memory() {
    let harness = handler_with(
        Arc::new(FakeEngine::new(
            |_, _| Ok(Default::default()),
            |_| Box::pin(async { Ok(Default::default()) }),
        )),
        Arc::new(FakeDrillRunner::reports()),
        None,
        Some(Arc::new(FailingCatalogFileSystem)),
    )
    .await;
    assert_eq!(
        harness
            .handler
            .handle(post(
                "/v1/backups/trigger",
                json!({"target": "postgres_core", "kind": "full"}),
            ))
            .await
            .status
            .as_u16(),
        202
    );
    harness.handler.state().when_idle().await;
    assert!(!harness.catalog.is_persistent());
    assert_eq!(harness.catalog.list_runs(1)[0].status, "PASSED");
}

#[tokio::test]
async fn idempotency_key_retries_return_the_same_job_and_never_start_a_second_backup() {
    let engine = Arc::new(FakeEngine::new(
        |_, _| Ok(Default::default()),
        |_| Box::pin(async { Ok(Default::default()) }),
    ));
    let harness = handler_with(
        Arc::clone(&engine) as Arc<dyn BackupEngine>,
        Arc::new(FakeDrillRunner::reports()),
        None,
        None,
    )
    .await;
    let send = || {
        post(
            "/v1/backups/trigger",
            json!({"target": "postgres_core", "kind": "full"}),
        )
        .with_header("idempotency-key", "click-1")
    };
    let first = harness.handler.handle(send()).await;
    let retry = harness.handler.handle(send()).await;
    let first_body = first.json_value().expect("json");
    assert_eq!(first.status.as_u16(), 202);
    assert_eq!(retry.status.as_u16(), 202);
    let retry_body = retry.json_value().expect("json");
    assert_eq!(retry_body["backupJobId"], first_body["backupJobId"]);
    assert_eq!(retry_body["deduplicated"], true);
    harness.handler.state().when_idle().await;
    assert_eq!(engine.trigger_count(), 1);
    assert_eq!(harness.catalog.list_runs(10).len(), 1);

    let other = harness
        .handler
        .handle(
            post(
                "/v1/backups/trigger",
                json!({"target": "postgres_core", "kind": "full"}),
            )
            .with_header("idempotency-key", "click-2"),
        )
        .await
        .json_value()
        .expect("json");
    assert_ne!(other["backupJobId"], first_body["backupJobId"]);
    harness.handler.state().when_idle().await;
    assert_eq!(engine.trigger_count(), 2);
}

#[tokio::test]
async fn concurrent_retries_with_one_idempotency_key_allocate_exactly_one_run() {
    let engine = Arc::new(FakeEngine::new(
        |_, _| Ok(Default::default()),
        |_| Box::pin(async { Ok(Default::default()) }),
    ));
    let harness = handler_with(engine, Arc::new(FakeDrillRunner::reports()), None, None).await;
    let state = harness.handler.state();
    let send = || {
        post(
            "/v1/backups/trigger",
            json!({"target": "postgres_core", "kind": "full"}),
        )
        .with_header("idempotency-key", "race-key")
    };
    let (first, second) = tokio::join!(
        backup_daemon::server::handle(&state, send()),
        backup_daemon::server::handle(&state, send())
    );
    let first_body = first.json_value().expect("json");
    let second_body = second.json_value().expect("json");
    assert_eq!(first_body["backupJobId"], second_body["backupJobId"]);
    assert!(
        first_body["deduplicated"].as_bool().unwrap_or(false)
            || second_body["deduplicated"].as_bool().unwrap_or(false)
    );
    harness.handler.state().when_idle().await;
    assert_eq!(harness.catalog.list_runs(10).len(), 1);
}

#[tokio::test]
async fn the_same_idempotency_key_is_scoped_per_route() {
    let harness = default_harness().await;
    let backup = post(
        "/v1/backups/trigger",
        json!({"target": "all", "kind": "full"}),
    )
    .with_header("idempotency-key", "shared-key-1");
    let drill = post("/v1/drills/run", json!({})).with_header("idempotency-key", "shared-key-1");
    assert!(harness
        .handler
        .handle(backup)
        .await
        .json_value()
        .expect("json")["deduplicated"]
        .is_null());
    assert!(harness
        .handler
        .handle(drill)
        .await
        .json_value()
        .expect("json")["deduplicated"]
        .is_null());
    harness.handler.state().when_idle().await;
}

#[tokio::test]
async fn a_malformed_idempotency_key_is_rejected_with_400() {
    let harness = default_harness().await;
    let response = harness
        .handler
        .handle(
            post(
                "/v1/backups/trigger",
                json!({"target": "all", "kind": "full"}),
            )
            .with_header("idempotency-key", "bad key with spaces!"),
        )
        .await;
    assert_eq!(response.status.as_u16(), 400);
    assert_eq!(
        response.json_value().expect("json")["error"]["code"],
        "invalid_idempotency_key"
    );
}

#[tokio::test]
async fn drills_accept_latest_but_not_together_with_target_time() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let calls_clone = Arc::clone(&calls);
    let drill = Arc::new(FakeDrillRunner::new(move |options: DrillRunOptions| {
        calls_clone.lock().expect("calls").push(options.clone());
        Ok(make_drill_report(options.id.as_deref().unwrap_or("d")))
    }));
    let harness = handler_with(
        Arc::new(FakeEngine::new(
            |_, _| Ok(Default::default()),
            |_| Box::pin(async { Ok(Default::default()) }),
        )),
        drill,
        None,
        None,
    )
    .await;
    assert_eq!(
        harness
            .handler
            .handle(post("/v1/drills/run", json!({"latest": true})))
            .await
            .status
            .as_u16(),
        202
    );
    harness.handler.state().when_idle().await;
    assert!(calls.lock().expect("calls")[0].latest);
    assert!(calls.lock().expect("calls")[0].target_time.is_none());

    let both = harness
        .handler
        .handle(post(
            "/v1/drills/run",
            json!({"latest": true, "targetTime": "2026-11-03T11:30:00.000Z"}),
        ))
        .await;
    assert_eq!(both.status.as_u16(), 400);
    assert!(String::from_utf8(both.body.clone())
        .expect("text")
        .contains("mutually exclusive"));

    harness
        .handler
        .handle(post("/v1/drills/run", json!({"latest": false})))
        .await;
    harness.handler.state().when_idle().await;
    assert!(!calls.lock().expect("calls").last().expect("call").latest);
}

#[tokio::test]
async fn drills_accept_an_explicit_target_time_and_reject_a_future_or_invalid_one() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let calls_clone = Arc::clone(&calls);
    let drill = Arc::new(FakeDrillRunner::new(move |options: DrillRunOptions| {
        calls_clone.lock().expect("calls").push(options.clone());
        Ok(make_drill_report("d"))
    }));
    let harness = handler_with(
        Arc::new(FakeEngine::new(
            |_, _| Ok(Default::default()),
            |_| Box::pin(async { Ok(Default::default()) }),
        )),
        drill,
        None,
        None,
    )
    .await;
    assert_eq!(
        harness
            .handler
            .handle(post(
                "/v1/drills/run",
                json!({"targetTime": "2026-11-03T11:30:00.000Z"}),
            ))
            .await
            .status
            .as_u16(),
        202
    );
    harness.handler.state().when_idle().await;
    assert_eq!(
        calls.lock().expect("calls")[0]
            .target_time
            .expect("target")
            .to_rfc3339(),
        "2026-11-03T11:30:00+00:00"
    );
    assert_eq!(
        harness
            .handler
            .handle(post(
                "/v1/drills/run",
                json!({"targetTime": "2026-11-04T00:00:00.000Z"}),
            ))
            .await
            .status
            .as_u16(),
        400
    );
    assert_eq!(
        harness
            .handler
            .handle(post(
                "/v1/drills/run",
                json!({"targetTime": "yesterday-ish"})
            ))
            .await
            .status
            .as_u16(),
        400
    );
}

#[tokio::test]
async fn wal_upload_streams_the_body_to_the_engine() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let calls_clone = Arc::clone(&calls);
    let engine = FakeEngine::new(
        |_, _| Ok(Default::default()),
        |_| Box::pin(async { Ok(Default::default()) }),
    )
    .with_ingest(Box::new(move |target, file, body, _declared| {
        calls_clone
            .lock()
            .expect("calls")
            .push((target.to_owned(), file.to_owned(), body.len()));
        Ok(WalIngestOutcome {
            status: "stored".to_owned(),
            key: format!("wal/{target}/{file}.zst.enc"),
            bytes: body.len() as u64,
        })
    }));
    let harness = handler_with(
        Arc::new(engine),
        Arc::new(FakeDrillRunner::reports()),
        None,
        None,
    )
    .await;
    let body = "x".repeat(1000);
    let response = harness
        .handler
        .handle(
            request(
                "PUT",
                "/v1/wal/postgres_core/000000010000000000000001",
                None,
            )
            .with_body(body.clone().into_bytes())
            .with_header("content-length", &body.len().to_string()),
        )
        .await;
    assert_eq!(response.status.as_u16(), 200);
    let json = response.json_value().expect("json");
    assert_eq!(json["status"], "stored");
    assert_eq!(json["bytes"], 1000);
    assert_eq!(
        *calls.lock().expect("calls"),
        vec![(
            "postgres_core".to_owned(),
            "000000010000000000000001".to_owned(),
            1000
        )]
    );
}

#[tokio::test]
async fn a_non_put_method_and_an_engine_without_wal_support_are_refused() {
    let engine = FakeEngine::new(
        |_, _| Ok(Default::default()),
        |_| Box::pin(async { Ok(Default::default()) }),
    )
    .with_ingest(Box::new(|_target, _file, _body, _declared| {
        Ok(WalIngestOutcome {
            status: "stored".to_owned(),
            key: "wal/x".to_owned(),
            bytes: 1,
        })
    }));
    let harness = handler_with(
        Arc::new(engine),
        Arc::new(FakeDrillRunner::reports()),
        None,
        None,
    )
    .await;
    let wrong_method = harness
        .handler
        .handle(
            request(
                "POST",
                "/v1/wal/postgres_core/000000010000000000000001",
                None,
            )
            .with_body(b"x".to_vec()),
        )
        .await;
    assert_eq!(wrong_method.status.as_u16(), 405);

    let plain = default_harness().await;
    let response = plain
        .handler
        .handle(
            request(
                "PUT",
                "/v1/wal/postgres_core/000000010000000000000001",
                None,
            )
            .with_body(b"x".to_vec()),
        )
        .await;
    assert_eq!(response.status.as_u16(), 501);
    assert_eq!(
        response.json_value().expect("json")["error"]["code"],
        "wal_push_not_supported"
    );
}

#[tokio::test]
async fn the_wal_role_can_only_upload_wal_and_the_control_role_cannot() {
    let engine = FakeEngine::new(
        |_, _| Ok(Default::default()),
        |_| Box::pin(async { Ok(Default::default()) }),
    )
    .with_ingest(Box::new(|target, file, body, _declared| {
        Ok(WalIngestOutcome {
            status: "stored".to_owned(),
            key: format!("wal/{target}/{file}.zst.enc"),
            bytes: body.len() as u64,
        })
    }));
    let harness = handler_with(
        Arc::new(engine),
        Arc::new(FakeDrillRunner::reports()),
        None,
        None,
    )
    .await;
    let wal = |request: RouteRequest| request.with_role(CallerRole::Wal);
    let control = |request: RouteRequest| request.with_role(CallerRole::Control);
    assert_eq!(
        harness
            .handler
            .handle(wal(get("/v1/overview")))
            .await
            .status
            .as_u16(),
        403
    );
    assert_eq!(
        harness
            .handler
            .handle(wal(put("/v1/policy", json!({}))))
            .await
            .status
            .as_u16(),
        403
    );
    assert_eq!(
        harness
            .handler
            .handle(wal(post(
                "/v1/backups/trigger",
                json!({"target": "all", "kind": "full"}),
            )))
            .await
            .status
            .as_u16(),
        403
    );
    assert_eq!(
        harness
            .handler
            .handle(
                wal(request(
                    "PUT",
                    "/v1/wal/postgres_core/000000010000000000000001",
                    None,
                ))
                .with_body(b"x".to_vec()),
            )
            .await
            .status
            .as_u16(),
        200
    );
    assert_eq!(
        harness
            .handler
            .handle(control(get("/v1/overview")))
            .await
            .status
            .as_u16(),
        200
    );
    assert_eq!(
        harness
            .handler
            .handle(
                control(request(
                    "PUT",
                    "/v1/wal/postgres_core/000000010000000000000001",
                    None,
                ))
                .with_body(b"x".to_vec()),
            )
            .await
            .status
            .as_u16(),
        403
    );
}

#[tokio::test]
async fn rejects_an_upload_with_no_body() {
    let engine = FakeEngine::new(
        |_, _| Ok(Default::default()),
        |_| Box::pin(async { Ok(Default::default()) }),
    )
    .with_ingest(Box::new(|_target, _file, _body, _declared| {
        Ok(WalIngestOutcome {
            status: "stored".to_owned(),
            key: "wal/x".to_owned(),
            bytes: 0,
        })
    }));
    let harness = handler_with(
        Arc::new(engine),
        Arc::new(FakeDrillRunner::reports()),
        None,
        None,
    )
    .await;
    let response = harness
        .handler
        .handle(request(
            "PUT",
            "/v1/wal/postgres_core/000000010000000000000001",
            None,
        ))
        .await;
    assert_eq!(response.status.as_u16(), 400);
}

#[tokio::test]
async fn wal_conflicts_keep_their_409_and_code() {
    let engine = FakeEngine::new(
        |_, _| Ok(Default::default()),
        |_| Box::pin(async { Ok(Default::default()) }),
    )
    .with_ingest(Box::new(|_target, _file, _body, _declared| {
        Err(EngineError::Wal(
            backup_daemon::wal_archive::WalIngestError::new(
                409,
                "wal_conflict",
                "already archived with different content",
            ),
        ))
    }));
    let harness = handler_with(
        Arc::new(engine),
        Arc::new(FakeDrillRunner::reports()),
        None,
        None,
    )
    .await;
    let response = harness
        .handler
        .handle(
            request(
                "PUT",
                "/v1/wal/postgres_core/000000010000000000000001",
                None,
            )
            .with_body(b"x".to_vec()),
        )
        .await;
    assert_eq!(response.status.as_u16(), 409);
    assert_eq!(
        response.json_value().expect("json")["error"]["code"],
        "wal_conflict"
    );
}

// ---------------------------------------------------------------------------
// Concurrency: the shared FIFO queue
// ---------------------------------------------------------------------------

struct GatedEngine {
    started: Arc<Notify>,
    release: Arc<Notify>,
    calls: Mutex<Vec<(BackupTarget, BackupKind)>>,
    running: AtomicUsize,
    peak: AtomicUsize,
}

impl GatedEngine {
    fn new() -> Self {
        Self {
            started: Arc::new(Notify::new()),
            release: Arc::new(Notify::new()),
            calls: Mutex::new(Vec::new()),
            running: AtomicUsize::new(0),
            peak: AtomicUsize::new(0),
        }
    }

    async fn wait_started(&self) {
        while self.running.load(Ordering::SeqCst) == 0 {
            self.started.notified().await;
        }
    }
}

impl BackupEngine for GatedEngine {
    fn overview_health(&self) -> EngineFuture<'_, EngineHealth> {
        Box::pin(async {
            Ok(EngineHealth {
                healthy: true,
                wal: Default::default(),
                targets: Vec::new(),
            })
        })
    }

    fn trigger_backup(
        &self,
        target: BackupTarget,
        kind: BackupKind,
    ) -> EngineFuture<'_, BackupExecutionResult> {
        Box::pin(async move {
            let now = self.running.fetch_add(1, Ordering::SeqCst) + 1;
            self.peak.fetch_max(now, Ordering::SeqCst);
            self.calls
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push((target, kind));
            self.started.notify_one();
            self.release.notified().await;
            self.running.fetch_sub(1, Ordering::SeqCst);
            Ok(BackupExecutionResult {
                storage_targets: vec!["primary-s3".to_owned()],
                ..BackupExecutionResult::default()
            })
        })
    }

    fn list_backups(
        &self,
        _limit: usize,
        _target: Option<BackupTarget>,
    ) -> EngineFuture<'_, Vec<BackupSummary>> {
        Box::pin(async { Ok(Vec::new()) })
    }
}

#[tokio::test]
async fn concurrent_triggers_get_unique_ids_are_queued_fifo_and_never_run_at_the_same_time() {
    let engine = Arc::new(GatedEngine::new());
    let harness = handler_with(
        Arc::clone(&engine) as Arc<dyn BackupEngine>,
        Arc::new(FakeDrillRunner::reports()),
        None,
        None,
    )
    .await;
    let targets = ["postgres_core", "audit_db", "redis", "postgres_core"];
    let mut ids = Vec::new();
    for target in targets {
        let response = harness
            .handler
            .handle(post(
                "/v1/backups/trigger",
                json!({"target": target, "kind": "delta"}),
            ))
            .await;
        ids.push(
            response.json_value().expect("json")["backupJobId"]
                .as_str()
                .expect("id")
                .to_owned(),
        );
    }
    assert_eq!(
        ids.iter().collect::<std::collections::BTreeSet<_>>().len(),
        4
    );
    engine.wait_started().await;
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    let statuses: Vec<String> = harness
        .catalog
        .list_runs(10)
        .into_iter()
        .map(|run| run.status)
        .collect();
    let mut sorted = statuses.clone();
    sorted.sort();
    assert_eq!(sorted, vec!["QUEUED", "QUEUED", "QUEUED", "RUNNING"]);
    for _ in 0..4 {
        engine.release.notify_one();
        for _attempt in 0..50 {
            if harness
                .catalog
                .list_runs(10)
                .iter()
                .all(|run| run.status == "PASSED")
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }
    }
    harness.handler.state().when_idle().await;
    assert_eq!(engine.peak.load(Ordering::SeqCst), 1);
    assert!(harness
        .catalog
        .list_runs(10)
        .iter()
        .all(|run| run.status == "PASSED"));
}

#[tokio::test]
async fn a_backup_and_a_restore_drill_share_the_same_queue() {
    let engine = Arc::new(GatedEngine::new());
    let drill_calls = Arc::new(AtomicUsize::new(0));
    let drill_calls_clone = Arc::clone(&drill_calls);
    let drill = Arc::new(FakeDrillRunner::new(move |_options| {
        drill_calls_clone.fetch_add(1, Ordering::SeqCst);
        Ok(make_drill_report("d"))
    }));
    let harness = handler_with(
        Arc::clone(&engine) as Arc<dyn BackupEngine>,
        drill,
        None,
        None,
    )
    .await;
    harness
        .handler
        .handle(post(
            "/v1/backups/trigger",
            json!({"target": "all", "kind": "full"}),
        ))
        .await;
    engine.wait_started().await;
    let drill_response = harness
        .handler
        .handle(post("/v1/drills/run", json!({})))
        .await;
    assert_eq!(drill_response.status.as_u16(), 202);
    assert_eq!(
        drill_response.json_value().expect("json")["queuePosition"],
        1
    );
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    assert_eq!(drill_calls.load(Ordering::SeqCst), 0);
    engine.release.notify_one();
    harness.handler.state().when_idle().await;
    assert_eq!(drill_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_full_queue_answers_429_and_leaves_a_failed_row_not_a_phantom_queued_one() {
    let engine = Arc::new(GatedEngine::new());
    let jobs = Arc::new(JobQueue::new(1, None, Box::new(common::now)));
    let harness = handler_with(
        Arc::clone(&engine) as Arc<dyn BackupEngine>,
        Arc::new(FakeDrillRunner::reports()),
        Some(jobs),
        None,
    )
    .await;
    let trigger = || {
        post(
            "/v1/backups/trigger",
            json!({"target": "all", "kind": "delta"}),
        )
    };
    assert_eq!(harness.handler.handle(trigger()).await.status.as_u16(), 202);
    assert_eq!(harness.handler.handle(trigger()).await.status.as_u16(), 202);
    let rejected = harness.handler.handle(trigger()).await;
    assert_eq!(rejected.status.as_u16(), 429);
    assert_eq!(
        rejected.json_value().expect("json")["error"]["code"],
        "queue_full"
    );
    assert_eq!(
        harness
            .catalog
            .list_runs(10)
            .into_iter()
            .filter(|run| run.status == "FAILED")
            .count(),
        1
    );
    engine.release.notify_one();
    for _attempt in 0..100 {
        if engine.running.load(Ordering::SeqCst) == 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    }
    engine.release.notify_one();
    harness.handler.state().when_idle().await;
}

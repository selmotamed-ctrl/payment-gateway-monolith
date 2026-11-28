//! Port of `deploy/backup-daemon/test/restoreDrillRunner.test.ts`.

mod common;

use std::sync::{Arc, Mutex};

use backup_daemon::command_runner::CommandResult;
use backup_daemon::drill::{
    build_audit_canonical_payload, build_trigger_canonical_payload, compute_audit_row_hash,
    parse_control_data, verify_audit_chain, verify_drill_report_signature, DrillDependencies,
    DrillFileSystem, DrillRunOptions, DrillRunner, RestoreDrillRunner, AUDIT_CHAIN_QUERY,
    DOUBLE_ENTRY_QUERY, GENESIS_HASH, SCRATCH_SAFETY_CONF,
};
use backup_daemon::engine::{RecoverRequest, RecoverResult};
use backup_daemon::util::stable_json;
use chrono::{DateTime, Utc};
use common::{
    audit_output, audit_rows, drill_runner, make_config, DrillOutputs, FakeEngine,
    MemoryDrillFileSystem, RecordingRunner,
};
use serde_json::json;
use sha2::{Digest, Sha256};

const SCRATCH: &str = "/var/lib/pg-backup/scratch";

fn clock() -> Arc<dyn Fn() -> DateTime<Utc> + Send + Sync> {
    Arc::new(common::now)
}

struct Harness {
    runner: Arc<RecordingRunner>,
    files: Arc<MemoryDrillFileSystem>,
    engine: Arc<FakeEngine>,
    drill: RestoreDrillRunner,
    sleeps: Arc<Mutex<Vec<u64>>>,
}

fn harness(outputs: DrillOutputs, options: HarnessOptions) -> Harness {
    let mut config = make_config(&[("BACKUP_ENGINE_MODE", "pg-native")]);
    if options.dedicated_audit {
        config = make_config(&[
            ("BACKUP_ENGINE_MODE", "pg-native"),
            ("PG_AUDIT_DATA_DIR", "/var/lib/postgresql/18/audit"),
            ("PG_AUDIT_USER", "audit_app"),
        ]);
    }
    if let Some(timeout) = options.recovery_timeout_ms {
        config.recovery_timeout_ms = timeout;
    }
    let runner = Arc::new(drill_runner(outputs, options.start_fails));
    let files = Arc::new(MemoryDrillFileSystem::new(&[]));
    let files_for_engine = Arc::clone(&files);
    let recovered = options.recovered.clone();
    let produces_data_dir = options.produces_data_dir;
    let engine = Arc::new(FakeEngine::new(
        |_, _| Ok(Default::default()),
        move |request: RecoverRequest| {
            let files = Arc::clone(&files_for_engine);
            let recovered = recovered.clone();
            Box::pin(async move {
                if produces_data_dir {
                    let path = request.target_dir.join("PG_VERSION");
                    files
                        .write_file(&path, "18")
                        .await
                        .expect("write PG_VERSION");
                }
                Ok(recovered)
            })
        },
    ));
    let sleeps = Arc::new(Mutex::new(Vec::new()));
    let sleeps_clone = Arc::clone(&sleeps);
    let drill = RestoreDrillRunner::new(DrillDependencies {
        config: Arc::new(config),
        engine: Arc::clone(&engine) as Arc<dyn backup_daemon::engine::BackupEngine>,
        runner: Arc::clone(&runner) as Arc<dyn backup_daemon::command_runner::CommandRunner>,
        repository: None,
        file_system: Some(Arc::clone(&files) as Arc<dyn DrillFileSystem>),
        clock: clock(),
        id_factory: Some(Arc::new(|| "drill-fixed-id".to_owned())),
        sleep: Some(Arc::new(move |milliseconds| {
            let sleeps = Arc::clone(&sleeps_clone);
            Box::pin(async move {
                sleeps.lock().expect("sleeps").push(milliseconds);
            })
        })),
    });
    Harness {
        runner,
        files,
        engine,
        drill,
        sleeps,
    }
}

struct HarnessOptions {
    start_fails: bool,
    recovered: RecoverResult,
    produces_data_dir: bool,
    dedicated_audit: bool,
    recovery_timeout_ms: Option<u64>,
}

impl Default for HarnessOptions {
    fn default() -> Self {
        Self {
            start_fails: false,
            recovered: RecoverResult {
                replayed_lsn: Some("0/16B6C50".to_owned()),
                recovery_conf: Some(
                    "restore_command = 'wal-fetch postgres_core %f %p'\nrecovery_target_time = '2026-11-03T12:00:00.000Z'\n".to_owned(),
                ),
                initialized_empty_dir: false,
            },
            produces_data_dir: true,
            dedicated_audit: false,
            recovery_timeout_ms: None,
        }
    }
}

fn passing_outputs() -> DrillOutputs {
    DrillOutputs {
        audit: audit_output(),
        ..DrillOutputs::default()
    }
}

#[tokio::test]
async fn runs_a_passing_full_drill_with_a_dedicated_audit_cluster_and_signs_the_report() {
    let harness = harness(
        passing_outputs(),
        HarnessOptions {
            dedicated_audit: true,
            ..HarnessOptions::default()
        },
    );
    let report = harness
        .drill
        .run(DrillRunOptions {
            id: Some("drill-1".to_owned()),
            ..DrillRunOptions::default()
        })
        .await
        .expect("drill");
    assert_eq!(report.status, "PASSED", "{report:#?}");
    assert_eq!(report.id, "drill-1");
    assert!(report.report_signature.is_some());
    assert!(verify_drill_report_signature(
        &report,
        common::ENCRYPTION_KEY_HEX
    ));
    assert!(report.checks.double_entry.ok);
    assert!(report.checks.balance_parity.ok);
    assert!(report.checks.audit_chain.ok);
    assert_eq!(report.journal_line_count, 3);
    assert_eq!(report.replayed_lsn, "0/16B6C50");
    let recovered = harness.engine.recovered.lock().expect("recovered");
    assert_eq!(recovered.len(), 2);
    assert!(recovered
        .iter()
        .any(|request| request.target == backup_daemon::engine::RecoveryTarget::AuditDb));
    // The audit database is only granted to the audit role.
    let calls = harness.runner.calls();
    assert!(calls.iter().any(|call| {
        call.command.ends_with("psql") && call.args.iter().any(|arg| arg == "audit_app")
    }));
    // The scratch directories are removed after the drill.
    assert!(harness
        .files
        .snapshot()
        .keys()
        .all(|path| !path.starts_with(SCRATCH)));
}

#[tokio::test]
async fn refuses_to_initdb_over_a_restore_that_produced_no_data_directory() {
    let harness = harness(
        passing_outputs(),
        HarnessOptions {
            produces_data_dir: false,
            recovered: RecoverResult {
                recovery_conf: Some("restore_command = 'x %f %p'".to_owned()),
                ..RecoverResult::default()
            },
            ..HarnessOptions::default()
        },
    );
    let report = harness
        .drill
        .run(DrillRunOptions::default())
        .await
        .expect("report");
    assert_eq!(report.status, "FAILED");
    assert!(report
        .error_message
        .as_deref()
        .expect("message")
        .contains("refusing to initdb"));
    assert!(!harness
        .runner
        .commands()
        .iter()
        .any(|command| command == "initdb"));
}

#[tokio::test]
async fn runs_initdb_only_when_the_engine_declares_an_initialized_empty_dir() {
    let harness = harness(
        passing_outputs(),
        HarnessOptions {
            produces_data_dir: false,
            recovered: RecoverResult {
                initialized_empty_dir: true,
                ..RecoverResult::default()
            },
            ..HarnessOptions::default()
        },
    );
    let report = harness
        .drill
        .run(DrillRunOptions::default())
        .await
        .expect("report");
    assert_eq!(report.status, "PASSED", "{report:#?}");
    assert!(harness
        .runner
        .commands()
        .iter()
        .any(|command| command == "initdb"));
}

#[tokio::test]
async fn fails_independently_on_each_broken_check_and_still_cleans_the_scratch_instance() {
    let cases: Vec<(&str, DrillOutputs, &str)> = vec![
        (
            "double entry",
            DrillOutputs {
                double_entry: "0.0001".to_owned(),
                ..passing_outputs()
            },
            "doubleEntry",
        ),
        (
            "balance parity",
            DrillOutputs {
                balance_parity: "2".to_owned(),
                ..passing_outputs()
            },
            "balanceParity",
        ),
        (
            "audit chain",
            {
                let mut outputs = passing_outputs();
                let mut rows: Vec<serde_json::Value> =
                    serde_json::from_str(&outputs.audit).expect("rows");
                rows[0]["afterJson"] = json!({"status": "TAMPERED"});
                outputs.audit = serde_json::Value::Array(rows).to_string();
                outputs
            },
            "auditChain",
        ),
    ];
    for (name, outputs, failing_check) in cases {
        let harness = harness(outputs, HarnessOptions::default());
        let report = harness
            .drill
            .run(DrillRunOptions::default())
            .await
            .expect("report");
        assert_eq!(report.status, "FAILED", "{name}: {report:#?}");
        let checks = serde_json::to_value(&report.checks).expect("checks");
        assert_eq!(checks[failing_check]["ok"], false, "{name}: {checks}");
        for other in ["doubleEntry", "balanceParity", "auditChain"] {
            if other != failing_check {
                assert_eq!(checks[other]["ok"], true, "{name}/{other}: {checks}");
            }
        }
        assert!(harness
            .files
            .snapshot()
            .keys()
            .all(|path| !path.starts_with(SCRATCH)));
    }
}

#[tokio::test]
async fn reports_a_failed_recover_and_cleans_up() {
    let runner = Arc::new(RecordingRunner::ok());
    let files = Arc::new(MemoryDrillFileSystem::new(&[]));
    let engine = Arc::new(FakeEngine::new(
        |_, _| Ok(Default::default()),
        |_request| {
            Box::pin(async move {
                Err(backup_daemon::engine::EngineError::Store(
                    "restore failed: bucket unavailable".to_owned(),
                ))
            })
        },
    ));
    let drill = RestoreDrillRunner::new(DrillDependencies {
        config: Arc::new(make_config(&[("BACKUP_ENGINE_MODE", "pg-native")])),
        engine: Arc::clone(&engine) as Arc<dyn backup_daemon::engine::BackupEngine>,
        runner: Arc::clone(&runner) as Arc<dyn backup_daemon::command_runner::CommandRunner>,
        repository: None,
        file_system: Some(Arc::clone(&files) as Arc<dyn DrillFileSystem>),
        clock: clock(),
        id_factory: Some(Arc::new(|| "drill-failed".to_owned())),
        sleep: None,
    });
    let report = drill.run(DrillRunOptions::default()).await.expect("report");
    assert_eq!(report.status, "FAILED");
    assert!(report
        .error_message
        .as_deref()
        .expect("message")
        .contains("bucket unavailable"));
}

#[tokio::test]
async fn reports_a_failed_pg_ctl_start_and_still_destroys_the_scratch_directory() {
    let harness = harness(
        passing_outputs(),
        HarnessOptions {
            start_fails: true,
            ..HarnessOptions::default()
        },
    );
    let report = harness
        .drill
        .run(DrillRunOptions::default())
        .await
        .expect("report");
    assert_eq!(report.status, "FAILED");
    assert!(report
        .error_message
        .as_deref()
        .expect("message")
        .contains("pg_ctl start failed"));
    assert!(harness
        .files
        .snapshot()
        .keys()
        .all(|path| !path.starts_with(SCRATCH)));
}

#[tokio::test]
async fn surfaces_audit_query_failures_without_aborting_the_other_checks() {
    let outputs = passing_outputs();
    let runner = Arc::new(RecordingRunner::new(move |command, args, _options| {
        let binary = command.rsplit('/').next().unwrap_or(command);
        if binary != "psql" {
            return CommandResult {
                code: 0,
                stdout: String::new(),
                stderr: String::new(),
            };
        }
        let query = args.last().map(String::as_str).unwrap_or("");
        if query == AUDIT_CHAIN_QUERY {
            return CommandResult {
                code: 1,
                stdout: String::new(),
                stderr: "permission denied for table audit_records".to_owned(),
            };
        }
        if query == DOUBLE_ENTRY_QUERY {
            return CommandResult {
                code: 0,
                stdout: "0.0000\n".to_owned(),
                stderr: String::new(),
            };
        }
        if query == backup_daemon::drill::BALANCE_PARITY_QUERY {
            return CommandResult {
                code: 0,
                stdout: "0\n".to_owned(),
                stderr: String::new(),
            };
        }
        if query == backup_daemon::drill::JOURNAL_LINE_COUNT_QUERY {
            return CommandResult {
                code: 0,
                stdout: "5\n".to_owned(),
                stderr: String::new(),
            };
        }
        CommandResult {
            code: 0,
            stdout: String::new(),
            stderr: String::new(),
        }
    }));
    let files = Arc::new(MemoryDrillFileSystem::new(&[]));
    let files_for_engine = Arc::clone(&files);
    let engine = Arc::new(FakeEngine::new(
        |_, _| Ok(Default::default()),
        move |request: RecoverRequest| {
            let files = Arc::clone(&files_for_engine);
            Box::pin(async move {
                files
                    .write_file(&request.target_dir.join("PG_VERSION"), "18")
                    .await
                    .expect("write");
                Ok(RecoverResult {
                    replayed_lsn: Some("0/1".to_owned()),
                    recovery_conf: None,
                    initialized_empty_dir: false,
                })
            })
        },
    ));
    let drill = RestoreDrillRunner::new(DrillDependencies {
        config: Arc::new(make_config(&[("BACKUP_ENGINE_MODE", "pg-native")])),
        engine: Arc::clone(&engine) as Arc<dyn backup_daemon::engine::BackupEngine>,
        runner: Arc::clone(&runner) as Arc<dyn backup_daemon::command_runner::CommandRunner>,
        repository: None,
        file_system: Some(Arc::clone(&files) as Arc<dyn DrillFileSystem>),
        clock: clock(),
        id_factory: None,
        sleep: None,
    });
    let report = drill.run(DrillRunOptions::default()).await.expect("report");
    assert_eq!(report.status, "FAILED");
    assert!(!report.checks.audit_chain.ok);
    assert!(report.checks.double_entry.ok);
    assert!(report.checks.balance_parity.ok);
    assert!(report
        .checks
        .audit_chain
        .detail
        .contains("permission denied"));
    let _ = outputs;
}

#[test]
fn stable_json_sorts_nested_object_keys_but_preserves_array_order() {
    assert_eq!(
        stable_json(&json!({"b": 1, "a": {"d": 2, "c": 3}})),
        r#"{"a":{"c":3,"d":2},"b":1}"#
    );
    assert_eq!(
        stable_json(&json!([{"z": 1, "a": 2}, 3])),
        r#"[{"a":2,"z":1},3]"#
    );
    assert_eq!(stable_json(&serde_json::Value::Null), "null");
}

#[test]
fn computes_the_documented_canonical_sha256_payload() {
    let row = audit_rows().remove(0);
    let canonical = build_audit_canonical_payload(GENESIS_HASH, &row);
    let expected = [
        GENESIS_HASH.to_owned(),
        row.id.clone(),
        "2026-11-03T10:00:00.000Z".to_owned(),
        row.actor_id.clone(),
        row.action.clone(),
        row.entity_type.clone(),
        row.entity_id.clone(),
        stable_json(&row.before_json),
        stable_json(&row.after_json),
    ]
    .join("|");
    assert_eq!(canonical, expected);
    assert_eq!(
        compute_audit_row_hash(GENESIS_HASH, &row),
        hex::encode(Sha256::digest(canonical.as_bytes()))
    );
}

#[test]
fn detects_valid_chains_mutated_payloads_and_broken_previous_links() {
    let rows = audit_rows();
    let verification = verify_audit_chain(&rows);
    assert!(verification.valid);
    assert_eq!(verification.broken_links, 0);
    assert_eq!(verification.verified_count, 2);

    let mut payload_tampered = audit_rows();
    payload_tampered[0].after_json = json!({"status": "TAMPERED"});
    assert_eq!(verify_audit_chain(&payload_tampered).broken_links, 1);

    let mut link_tampered = audit_rows();
    link_tampered[1].prev_hash = "f".repeat(64);
    let verification = verify_audit_chain(&link_tampered);
    assert!(!verification.valid);
    assert_eq!(verification.broken_links, 1);
}

#[test]
fn verifies_rows_hashed_by_the_trigger_over_jsonb_text() {
    let mut row = audit_rows().remove(0);
    row.before_json_text = Some(r#"{"status": "PENDING", "z": 1, "a": 2}"#.to_owned());
    row.after_json_text = Some(r#"{"status": "ACTIVE"}"#.to_owned());
    // The line intentionally re-hashes with the trigger canonical form.
    row.row_hash = hex::encode(Sha256::digest(
        build_trigger_canonical_payload(
            GENESIS_HASH,
            &row,
            "{\"status\": \"PENDING\", \"z\": 1, \"a\": 2}",
            "{\"status\": \"ACTIVE\"}",
        )
        .as_bytes(),
    ));
    assert!(verify_audit_chain(std::slice::from_ref(&row)).valid);

    let mut tampered = row.clone();
    tampered.after_json_text = Some(r#"{"status":"TAMPERED"}"#.to_owned());
    // The parsed form still matches, so the row stays valid: the trigger hashed the database's own
    // text, which is why the drill compares both forms.
    assert!(!verify_audit_chain(std::slice::from_ref(&tampered)).valid);
    let mut broken = row;
    broken.row_hash = "f".repeat(64);
    assert!(!verify_audit_chain(&[broken]).valid);
}

#[test]
fn detects_a_deleted_row_through_the_gap_in_seq_no() {
    let mut rows = audit_rows();
    rows.remove(0);
    let verification = verify_audit_chain(&rows);
    assert!(!verification.valid);
    assert_eq!(verification.first_broken_seq_no.as_deref(), Some("2"));
}

#[tokio::test]
async fn a_shared_cluster_recovers_one_scratch_cluster_and_checks_the_audit_chain_against_it() {
    let harness = harness(passing_outputs(), HarnessOptions::default());
    let report = harness
        .drill
        .run(DrillRunOptions::default())
        .await
        .expect("report");
    assert_eq!(report.status, "PASSED", "{report:#?}");
    assert_eq!(harness.engine.recovered.lock().expect("recovered").len(), 1);
}

#[tokio::test]
async fn a_shared_cluster_restores_the_logical_audit_dump_when_the_database_is_missing() {
    let mut outputs = passing_outputs();
    outputs.audit_database_present = false;
    let harness = harness(outputs, HarnessOptions::default());
    let report = harness
        .drill
        .run(DrillRunOptions::default())
        .await
        .expect("report");
    assert!(
        harness
            .engine
            .logical_restores
            .lock()
            .expect("restores")
            .len()
            == 1
    );
    assert!(report
        .checks
        .audit_chain
        .detail
        .contains("restored logical dump"));
}

#[tokio::test]
async fn neutralizes_archiving_in_every_scratch_cluster() {
    let harness = harness(passing_outputs(), HarnessOptions::default());
    harness
        .drill
        .run(DrillRunOptions::default())
        .await
        .expect("report");
    let written = harness.files.written.lock().expect("written");
    let auto_conf = written
        .iter()
        .find(|(path, _)| path.ends_with("postgresql.auto.conf"))
        .expect("auto.conf");
    assert!(auto_conf.1.contains(SCRATCH_SAFETY_CONF));
    assert!(auto_conf.1.contains("archive_mode = off"));
    assert!(auto_conf.1.contains("archive_command = ''"));
}

#[tokio::test]
async fn builds_postgresql_conf_from_pg_controldata_for_a_config_less_restore() {
    let runner = Arc::new(RecordingRunner::new(|command, args, _options| {
        if command.ends_with("pg_controldata") {
            return CommandResult {
                code: 0,
                stdout: "max_connections setting: 200\nmax_worker_processes setting: 8\ntrack_commit_timestamp setting: on\n".to_owned(),
                stderr: String::new(),
            };
        }
        let query = args.last().map(String::as_str).unwrap_or("");
        let stdout = match query {
            backup_daemon::drill::AUDIT_CHAIN_QUERY => "[]",
            backup_daemon::drill::DOUBLE_ENTRY_QUERY => "0",
            backup_daemon::drill::BALANCE_PARITY_QUERY => "0",
            backup_daemon::drill::JOURNAL_LINE_COUNT_QUERY => "0",
            "SELECT pg_is_in_recovery();" => "f",
            _ => "",
        };
        CommandResult {
            code: 0,
            stdout: format!("{stdout}\n"),
            stderr: String::new(),
        }
    }));
    let files = Arc::new(MemoryDrillFileSystem::new(&[(SCRATCH, "")]));
    let files_for_engine = Arc::clone(&files);
    let engine = Arc::new(FakeEngine::new(
        |_, _| Ok(Default::default()),
        move |request: RecoverRequest| {
            let files = Arc::clone(&files_for_engine);
            Box::pin(async move {
                files
                    .write_file(&request.target_dir.join("PG_VERSION"), "18")
                    .await
                    .expect("write");
                Ok(RecoverResult::default())
            })
        },
    ));
    let drill = RestoreDrillRunner::new(DrillDependencies {
        config: Arc::new(make_config(&[("BACKUP_ENGINE_MODE", "pg-native")])),
        engine: Arc::clone(&engine) as Arc<dyn backup_daemon::engine::BackupEngine>,
        runner: Arc::clone(&runner) as Arc<dyn backup_daemon::command_runner::CommandRunner>,
        repository: None,
        file_system: Some(Arc::clone(&files) as Arc<dyn DrillFileSystem>),
        clock: clock(),
        id_factory: None,
        sleep: None,
    });
    let report = drill.run(DrillRunOptions::default()).await.expect("report");
    assert_eq!(report.status, "PASSED", "{report:#?}");
    let written = files.written.lock().expect("written");
    let conf = written
        .iter()
        .find(|(path, _)| path.ends_with("postgresql.conf"))
        .expect("conf");
    assert!(conf.1.contains("max_connections = 200"));
    assert!(conf.1.contains("track_commit_timestamp = on"));
    let parsed =
        parse_control_data("max_prepared_xacts setting: 0\nmax_locks_per_xact setting: 64\n");
    assert!(parsed.contains("max_prepared_transactions = 0"));
    assert!(parsed.contains("max_locks_per_transaction = 64"));
}

#[tokio::test]
async fn waits_for_wal_replay_to_finish_and_promote_before_running_any_query() {
    let mut outputs = passing_outputs();
    outputs.recovery_states = vec!["t".to_owned(), "t".to_owned(), "f".to_owned()];
    let harness = harness(outputs, HarnessOptions::default());
    let report = harness
        .drill
        .run(DrillRunOptions::default())
        .await
        .expect("report");
    assert_eq!(report.status, "PASSED");
    assert_eq!(*harness.sleeps.lock().expect("sleeps"), vec![250, 250]);
    // The double-entry query only runs after the promoted answer.
    let calls = harness.runner.calls();
    let recovery_answers = calls
        .iter()
        .filter(|call| call.args.last().map(String::as_str) == Some("SELECT pg_is_in_recovery();"))
        .count();
    assert_eq!(recovery_answers, 3);
}

#[tokio::test]
async fn fails_with_a_clear_error_when_recovery_never_finishes() {
    let mut outputs = passing_outputs();
    outputs.recovery_states = vec!["t".to_owned()];
    let harness = harness(
        outputs,
        HarnessOptions {
            recovery_timeout_ms: Some(500),
            ..HarnessOptions::default()
        },
    );
    let report = harness
        .drill
        .run(DrillRunOptions::default())
        .await
        .expect("report");
    assert_eq!(report.status, "FAILED");
    assert!(report
        .error_message
        .as_deref()
        .expect("message")
        .contains("recovery did not finish"));
}

#[tokio::test]
async fn latest_asks_the_engine_to_replay_all_wal_and_still_runs_every_check() {
    let harness = harness(passing_outputs(), HarnessOptions::default());
    let report = harness
        .drill
        .run(DrillRunOptions {
            latest: true,
            ..DrillRunOptions::default()
        })
        .await
        .expect("report");
    assert_eq!(report.status, "PASSED", "{report:#?}");
    let recovered = harness.engine.recovered.lock().expect("recovered");
    assert!(recovered[0].latest);
    assert_eq!(report.target_time, "2026-11-03T12:00:00.000Z");
}

#[tokio::test]
async fn recovers_to_an_explicit_target_time_when_one_is_given() {
    let harness = harness(passing_outputs(), HarnessOptions::default());
    let target = DateTime::parse_from_rfc3339("2026-11-03T11:30:00.000Z")
        .expect("date")
        .with_timezone(&Utc);
    let report = harness
        .drill
        .run(DrillRunOptions {
            target_time: Some(target),
            ..DrillRunOptions::default()
        })
        .await
        .expect("report");
    assert_eq!(report.target_time, "2026-11-03T11:30:00.000Z");
    let recovered = harness.engine.recovered.lock().expect("recovered");
    assert_eq!(recovered[0].target_time, target);
}

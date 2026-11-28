//! Port of `deploy/backup-daemon/test/pgNativeEngine.test.ts` and `backupEngine.test.ts`.

mod common;

use std::collections::BTreeMap;
use std::sync::Arc;

use backup_daemon::artifacts::{ArtifactRepository, MemoryArtifactStore, StoreKind};
use backup_daemon::catalog::BackupRun;
use backup_daemon::crypto::{
    sign_manifest, ArtifactRecord, BackupManifest, ManifestEncryption, PgVerifyBackup,
};
use backup_daemon::engine::pg_native::{
    build_restore_command, parse_wal_ranges, unexpected_backup_files, PgNativeEngine,
    EXPECTED_BACKUP_FILES,
};
use backup_daemon::engine::{
    create_backup_engine, wal_stream_health_target, BackupEngine, BackupKind, BackupTarget,
    EngineDeps, PolicyView,
};
use backup_daemon::pg_tools::PgCluster;
use backup_daemon::wal_names::WalTarget;
use chrono::{DateTime, Utc};
use common::{make_config, RecordingRunner, NOW_ISO};

fn clock() -> Arc<dyn Fn() -> DateTime<Utc> + Send + Sync> {
    Arc::new(Utc::now)
}

fn memory_repository() -> (Arc<ArtifactRepository>, Arc<MemoryArtifactStore>) {
    let store = Arc::new(MemoryArtifactStore::new(
        "primary-s3",
        "Primary S3 Bucket",
        StoreKind::S3,
    ));
    (
        Arc::new(ArtifactRepository::new(vec![store.clone()])),
        store,
    )
}

fn make_engine(
    repository: Arc<ArtifactRepository>,
    runner: Arc<RecordingRunner>,
) -> PgNativeEngine {
    let staging = std::env::temp_dir().join(format!(
        "bd-engine-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&staging).expect("staging");
    let staging_value = staging.to_string_lossy().into_owned();
    let catalog_value = staging.join("catalog.json").to_string_lossy().into_owned();
    PgNativeEngine::new(
        Arc::new(make_config(&[
            ("BACKUP_ENGINE_MODE", "pg-native"),
            ("BACKUP_STAGING_DIR", staging_value.as_str()),
            ("BACKUP_CATALOG_PATH", catalog_value.as_str()),
        ])),
        runner,
        repository,
        EngineDeps {
            repository: None,
            get_policy: Some(Arc::new(|| PolicyView {
                full_retention_days: 56,
                wal_retention_days: 14,
            })),
            clock: Some(clock()),
        },
    )
    .expect("engine")
}

fn manifest(
    id: &str,
    kind: &str,
    completed_at: &str,
    parent: Option<&str>,
    sha256: &str,
    wal_segment_start: Option<&str>,
) -> BackupManifest {
    BackupManifest {
        schema_version: 2,
        backup_id: id.to_owned(),
        target: "postgres_core".to_owned(),
        kind: kind.to_owned(),
        engine: "pg-native".to_owned(),
        cluster_topology: "shared-audit".to_owned(),
        started_at: completed_at.to_owned(),
        completed_at: completed_at.to_owned(),
        start_lsn: Some("0/1000000".to_owned()),
        end_lsn: Some("0/2000000".to_owned()),
        wal_segment_start: wal_segment_start.map(str::to_owned),
        wal_segment_end: None,
        parent_backup_id: parent.map(str::to_owned),
        uncompressed_bytes: 100,
        compressed_bytes: 50,
        sha256_plaintext: String::new(),
        sha256_ciphertext: sha256.to_owned(),
        encryption: ManifestEncryption {
            algorithm: "AES-256-GCM".to_owned(),
            kdf: "HKDF-SHA256".to_owned(),
            salt_hex: "00".to_owned(),
            iv_hex: "11".to_owned(),
            auth_tag_hex: "22".to_owned(),
        },
        pg_verify_backup: Some(PgVerifyBackup {
            verified: true,
            manifest_checksum_algorithm: "SHA256".to_owned(),
            detail: "verified".to_owned(),
        }),
        artifacts: None,
        storage_targets: vec!["primary-s3".to_owned()],
        signature: None,
    }
}

async fn store_manifest(store: &MemoryArtifactStore, target: &str, manifest: &BackupManifest) {
    let signed = sign_manifest(manifest, &common::master()).expect("sign");
    store.put_object(
        &format!("backups/{target}/{}.manifest.json", manifest.backup_id),
        serde_json::to_vec_pretty(&signed).expect("json"),
    );
}

#[test]
fn selects_the_engine_from_the_mode_and_refuses_unported_engines() {
    let runner: Arc<dyn backup_daemon::command_runner::CommandRunner> =
        Arc::new(RecordingRunner::ok());
    let (repository, _store) = memory_repository();
    let config = Arc::new(make_config(&[("BACKUP_ENGINE_MODE", "pg-native")]));
    assert!(create_backup_engine(
        config,
        Arc::clone(&runner),
        EngineDeps {
            repository: Some(repository),
            ..EngineDeps::default()
        }
    )
    .is_ok());
    for mode in ["wal-g", "barman"] {
        let config = Arc::new(make_config(&[("BACKUP_ENGINE_MODE", mode)]));
        let error = match create_backup_engine(config, Arc::clone(&runner), EngineDeps::default()) {
            Ok(_) => panic!("{mode} must not be ported"),
            Err(error) => error,
        };
        assert!(error.to_string().contains(mode));
        assert!(error.to_string().contains("not implemented"));
    }
}

#[tokio::test]
async fn lists_only_manifests_whose_signature_verifies() {
    let (repository, store) = memory_repository();
    let engine = make_engine(repository, Arc::new(RecordingRunner::ok()));
    store_manifest(
        &store,
        "postgres_core",
        &manifest("bkp_1", "full", NOW_ISO, None, "aa", None),
    )
    .await;
    let mut tampered = manifest("bkp_2", "full", NOW_ISO, None, "bb", None);
    tampered.signature = Some("f".repeat(64));
    store.put_object(
        "backups/postgres_core/bkp_2.manifest.json",
        serde_json::to_vec(&tampered).expect("json"),
    );
    let listed = engine
        .list_manifests(BackupTarget::PostgresCore)
        .await
        .expect("list");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].backup_id, "bkp_1");
}

#[tokio::test]
async fn resolves_the_newest_backup_before_the_target_and_walks_its_chain() {
    let (repository, store) = memory_repository();
    let engine = make_engine(repository, Arc::new(RecordingRunner::ok()));
    store_manifest(
        &store,
        "postgres_core",
        &manifest(
            "full-1",
            "full",
            "2026-11-01T00:00:00.000Z",
            None,
            "a1",
            None,
        ),
    )
    .await;
    store_manifest(
        &store,
        "postgres_core",
        &manifest(
            "delta-1",
            "delta",
            "2026-11-02T00:00:00.000Z",
            Some("full-1"),
            "a2",
            None,
        ),
    )
    .await;
    store_manifest(
        &store,
        "postgres_core",
        &manifest(
            "full-2",
            "full",
            "2026-11-03T00:00:00.000Z",
            None,
            "a3",
            None,
        ),
    )
    .await;
    let target = DateTime::parse_from_rfc3339("2026-11-02T12:00:00.000Z")
        .expect("date")
        .with_timezone(&Utc);
    let chain = engine
        .resolve_chain(BackupTarget::PostgresCore, target)
        .await
        .expect("chain");
    assert_eq!(
        chain
            .iter()
            .map(|entry| entry.backup_id.as_str())
            .collect::<Vec<_>>(),
        vec!["full-1", "delta-1"]
    );
}

#[tokio::test]
async fn fails_clearly_when_nothing_completed_before_the_target_or_a_parent_is_missing() {
    let (repository, store) = memory_repository();
    let engine = make_engine(repository, Arc::new(RecordingRunner::ok()));
    let before = DateTime::parse_from_rfc3339("2026-10-01T00:00:00.000Z")
        .expect("date")
        .with_timezone(&Utc);
    assert!(engine
        .resolve_chain(BackupTarget::PostgresCore, before)
        .await
        .unwrap_err()
        .to_string()
        .contains("no verified postgres_core backup"));
    store_manifest(
        &store,
        "postgres_core",
        &manifest(
            "delta-orphan",
            "delta",
            NOW_ISO,
            Some("missing"),
            "a1",
            None,
        ),
    )
    .await;
    let after = DateTime::parse_from_rfc3339("2026-12-01T00:00:00.000Z")
        .expect("date")
        .with_timezone(&Utc);
    assert!(engine
        .resolve_chain(BackupTarget::PostgresCore, after)
        .await
        .unwrap_err()
        .to_string()
        .contains("missing or failed verification"));
}

#[tokio::test]
async fn reconstructs_run_history_from_signed_manifests() {
    let (repository, store) = memory_repository();
    let engine = make_engine(repository, Arc::new(RecordingRunner::ok()));
    store_manifest(
        &store,
        "postgres_core",
        &manifest(
            "bkp_1",
            "full",
            "2026-11-01T00:00:00.000Z",
            None,
            "a1",
            None,
        ),
    )
    .await;
    let runs: Vec<BackupRun> = engine.reconstruct_runs().await;
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].id, "bkp_1");
    assert_eq!(runs[0].status, "PASSED");
    assert_eq!(runs[0].size_bytes, Some(50));
}

#[tokio::test]
async fn pruning_drops_whole_chains_older_than_the_policy_and_keeps_the_newest() {
    let (repository, store) = memory_repository();
    let engine = make_engine(repository, Arc::new(RecordingRunner::ok()));
    let old_full = manifest(
        "old-full",
        "full",
        "2026-01-01T00:00:00.000Z",
        None,
        "aa",
        Some("000000010000000000000001"),
    );
    let old_delta = manifest(
        "old-delta",
        "delta",
        "2026-01-02T00:00:00.000Z",
        Some("old-full"),
        "bb",
        None,
    );
    let new_full = manifest(
        "new-full",
        "full",
        &Utc::now().to_rfc3339(),
        None,
        "cc",
        Some("000000010000000000000010"),
    );
    for entry in [&old_full, &old_delta, &new_full] {
        store_manifest(&store, "postgres_core", entry).await;
        store.put_object(
            &format!("backups/postgres_core/{}.tar.zst.enc", entry.backup_id),
            b"artifact".to_vec(),
        );
    }
    store.put_object(
        "wal/postgres_core/000000010000000000000001.zst.enc",
        b"wal".to_vec(),
    );
    store.put_object(
        "wal/postgres_core/000000010000000000000020.zst.enc",
        b"wal".to_vec(),
    );
    store.put_object("wal/postgres_core/00000002.history", b"history".to_vec());

    engine
        .prune(BackupTarget::PostgresCore, Some(BackupKind::Full))
        .await
        .expect("prune");
    assert!(store
        .object("backups/postgres_core/old-full.manifest.json")
        .is_none());
    assert!(store
        .object("backups/postgres_core/old-delta.manifest.json")
        .is_none());
    assert!(store
        .object("backups/postgres_core/new-full.manifest.json")
        .is_some());
    assert!(store
        .object("backups/postgres_core/new-full.tar.zst.enc")
        .is_some());
    // WAL older than the oldest retained backup's first segment is deleted; newer segments and the
    // timeline history stay.
    assert!(store
        .object("wal/postgres_core/000000010000000000000001.zst.enc")
        .is_none());
    assert!(store
        .object("wal/postgres_core/000000010000000000000020.zst.enc")
        .is_some());
    assert!(store.object("wal/postgres_core/00000002.history").is_some());
}

#[tokio::test]
async fn a_tampered_manifest_is_never_trusted_to_delete_anything_and_delta_pruning_is_a_noop() {
    let (repository, store) = memory_repository();
    let engine = make_engine(repository, Arc::new(RecordingRunner::ok()));
    let mut tampered = manifest(
        "tampered",
        "full",
        "2026-01-01T00:00:00.000Z",
        None,
        "aa",
        None,
    );
    tampered.signature = Some("f".repeat(64));
    store.put_object(
        "backups/postgres_core/tampered.manifest.json",
        serde_json::to_vec(&tampered).expect("json"),
    );
    store.put_object("backups/postgres_core/tampered.tar.zst.enc", b"x".to_vec());
    engine
        .prune(BackupTarget::PostgresCore, Some(BackupKind::Delta))
        .await
        .expect("noop");
    assert!(store
        .object("backups/postgres_core/tampered.tar.zst.enc")
        .is_some());
}

#[test]
fn wal_stream_health_reports_how_far_behind_it_is() {
    let healthy = wal_stream_health_target(
        "postgres_core",
        true,
        Some("2026-11-01T00:00:00Z"),
        None,
        Some(1024),
        1024 * 1024,
    );
    assert!(healthy.healthy);
    assert!(healthy.detail.contains("behind the primary"));
    let far = wal_stream_health_target(
        "postgres_core",
        true,
        None,
        None,
        Some(1024 * 1024 * 1024),
        256 * 1024 * 1024,
    );
    assert!(!far.healthy);
    let unknown = wal_stream_health_target("postgres_core", true, None, None, None, 1024);
    assert!(unknown.healthy);
    let stopped =
        wal_stream_health_target("postgres_core", false, None, Some("exited"), None, 1024);
    assert!(!stopped.healthy);
    assert_eq!(stopped.detail, "exited");
}

#[tokio::test]
async fn manifest_times_come_from_the_primary_clock_and_fall_back_locally() {
    let (repository, _store) = memory_repository();
    let runner = Arc::new(RecordingRunner::new(|command, args, _options| {
        let binary = command.rsplit('/').next().unwrap_or(command);
        let query = args.last().map(String::as_str).unwrap_or("");
        if binary == "psql" && query.contains("clock_timestamp") {
            return backup_daemon::command_runner::CommandResult {
                code: 0,
                stdout: "2026-11-06T02:00:00.000Z\n".to_owned(),
                stderr: String::new(),
            };
        }
        backup_daemon::command_runner::CommandResult {
            code: 0,
            stdout: String::new(),
            stderr: String::new(),
        }
    }));
    let engine = make_engine(repository, Arc::clone(&runner));
    assert_eq!(
        engine
            .primary_clock(PgCluster::Core)
            .await
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "2026-11-06T02:00:00.000Z"
    );

    let (fallback_repository, _store) = memory_repository();
    let failing = Arc::new(RecordingRunner::new(|_command, _args, _options| {
        backup_daemon::command_runner::CommandResult {
            code: 1,
            stdout: String::new(),
            stderr: "unreachable".to_owned(),
        }
    }));
    let engine = make_engine(fallback_repository, failing);
    // Falls back to the local clock rather than failing the backup.
    assert!(engine.primary_clock(PgCluster::Core).await.timestamp() > 0);
}

#[tokio::test]
async fn a_delta_fails_loudly_when_summarize_wal_is_off_or_there_is_no_full_backup() {
    let (repository, _store) = memory_repository();
    let runner = Arc::new(RecordingRunner::new(|command, args, _options| {
        let binary = command.rsplit('/').next().unwrap_or(command);
        let query = args.last().map(String::as_str).unwrap_or("");
        if binary == "psql" && query == "SHOW summarize_wal;" {
            return backup_daemon::command_runner::CommandResult {
                code: 0,
                stdout: "off\n".to_owned(),
                stderr: String::new(),
            };
        }
        backup_daemon::command_runner::CommandResult {
            code: 0,
            stdout: String::new(),
            stderr: String::new(),
        }
    }));
    let engine = make_engine(repository, Arc::clone(&runner));
    let error = engine
        .trigger_backup(BackupTarget::PostgresCore, BackupKind::Delta)
        .await
        .expect_err("summarize_wal");
    assert!(error.to_string().contains("summarize_wal = on"));

    let (repository, _store) = memory_repository();
    let runner = Arc::new(RecordingRunner::new(|command, args, _options| {
        let binary = command.rsplit('/').next().unwrap_or(command);
        let query = args.last().map(String::as_str).unwrap_or("");
        if binary == "psql" && query == "SHOW summarize_wal;" {
            return backup_daemon::command_runner::CommandResult {
                code: 0,
                stdout: "on\n".to_owned(),
                stderr: String::new(),
            };
        }
        backup_daemon::command_runner::CommandResult {
            code: 0,
            stdout: String::new(),
            stderr: String::new(),
        }
    }));
    let engine = make_engine(repository, runner);
    let error = engine
        .trigger_backup(BackupTarget::PostgresCore, BackupKind::Delta)
        .await
        .expect_err("no parent");
    assert!(error.to_string().contains("previous full backup"));
}

#[tokio::test]
async fn a_cluster_with_extra_tablespaces_is_refused_before_any_backup_is_produced() {
    let (repository, _store) = memory_repository();
    let runner = Arc::new(RecordingRunner::new(|command, args, _options| {
        let binary = command.rsplit('/').next().unwrap_or(command);
        let query = args.last().map(String::as_str).unwrap_or("");
        if binary == "psql" && query.contains("FROM pg_tablespace") {
            return backup_daemon::command_runner::CommandResult {
                code: 0,
                stdout: "2\n".to_owned(),
                stderr: String::new(),
            };
        }
        if binary == "psql" && query.contains("clock_timestamp") {
            return backup_daemon::command_runner::CommandResult {
                code: 0,
                stdout: format!("{NOW_ISO}\n"),
                stderr: String::new(),
            };
        }
        backup_daemon::command_runner::CommandResult {
            code: 0,
            stdout: String::new(),
            stderr: String::new(),
        }
    }));
    let engine = make_engine(repository, Arc::clone(&runner));
    let error = engine
        .trigger_backup(BackupTarget::PostgresCore, BackupKind::Full)
        .await
        .expect_err("tablespaces");
    assert!(error.to_string().contains("non-default tablespace"));
    assert!(!runner
        .commands()
        .iter()
        .any(|command| command == "pg_basebackup"));
}

#[test]
fn any_file_other_than_the_expected_three_is_an_extra_tablespace() {
    assert!(unexpected_backup_files(&EXPECTED_BACKUP_FILES.map(str::to_owned)).is_empty());
    assert_eq!(
        unexpected_backup_files(&["16409.tar".to_owned()]),
        vec!["16409.tar".to_owned()]
    );
}

#[test]
fn the_restore_command_decrypts_wal_and_survives_postgresql_conf_quoting() {
    let command = build_restore_command(WalTarget::PostgresCore, "", "/opt/pg/backup-daemon-rs");
    assert!(command.contains("wal-fetch postgres_core %f %p"));
    assert!(command.contains("''"));
}

#[test]
fn parses_the_lsn_ranges_from_a_real_backup_manifest() {
    let manifest = r#"{
        "PostgreSQL-Backup-Manifest-Version": 2,
        "WAL-Ranges": [
            {"Timeline": 1, "Start-LSN": "0/18000028", "End-LSN": "0/180001A0"}
        ]
    }"#;
    let ranges = parse_wal_ranges(manifest).expect("ranges");
    assert_eq!(ranges.len(), 1);
    assert_eq!(ranges[0].timeline, 1);
    assert_eq!(ranges[0].start_lsn, "0/18000028");
    assert_eq!(ranges[0].end_lsn, "0/180001A0");
}

#[tokio::test]
async fn list_backups_reads_the_signed_manifest_history() {
    let (repository, store) = memory_repository();
    let engine = make_engine(repository, Arc::new(RecordingRunner::ok()));
    store_manifest(
        &store,
        "postgres_core",
        &manifest(
            "bkp_1",
            "full",
            "2026-11-01T00:00:00.000Z",
            None,
            "a1",
            None,
        ),
    )
    .await;
    store_manifest(
        &store,
        "postgres_core",
        &manifest(
            "bkp_2",
            "delta",
            "2026-11-02T00:00:00.000Z",
            Some("bkp_1"),
            "a2",
            None,
        ),
    )
    .await;
    let summaries = engine
        .list_backups(10, Some(BackupTarget::PostgresCore))
        .await
        .expect("list");
    assert_eq!(summaries.len(), 2);
    assert_eq!(summaries[0].backup_id, "bkp_2");
    assert_eq!(summaries[0].size_bytes, Some(50));
}

#[allow(dead_code)]
fn unused_artifact_map() -> BTreeMap<String, ArtifactRecord> {
    BTreeMap::new()
}

//! Port of `deploy/backup-daemon/test/catalogStore.test.ts` and `catalogMirror.test.ts`.

mod common;

use std::path::PathBuf;
use std::sync::Arc;

use backup_daemon::artifacts::{ArtifactRepository, MemoryArtifactStore, StoreKind};
use backup_daemon::catalog::{
    create_default_policy, CatalogMirror, CatalogStore, CatalogStoreOptions,
    FailingCatalogFileSystem, MemoryCatalogFileSystem, RepositoryCatalogMirror, CATALOG_KEY,
};
use common::{backup_run, make_drill_report, master};
use serde_json::Value;

fn default_policy() -> backup_daemon::catalog::BackupPolicy {
    create_default_policy()
}

async fn memory_catalog() -> Arc<CatalogStore> {
    Arc::new(
        CatalogStore::load(CatalogStoreOptions {
            path: PathBuf::from("/virtual/catalog.json"),
            default_policy: default_policy(),
            file_system: Some(Arc::new(MemoryCatalogFileSystem::default())),
            max_runs: None,
            max_drills: None,
            mirror: None,
            on_warning: None,
        })
        .await,
    )
}

#[tokio::test]
async fn creates_a_default_catalog_and_persists_runs_atomically() {
    let directory = tempfile::tempdir().expect("tempdir");
    let path = directory.path().join("catalog.json");
    let store = CatalogStore::load(CatalogStoreOptions {
        path: path.clone(),
        default_policy: backup_daemon::catalog::BackupPolicy {
            full_cron: "0 1 * * 0".to_owned(),
            updated_at: "2026-11-03T00:00:00.000Z".to_owned(),
            ..default_policy()
        },
        file_system: None,
        max_runs: None,
        max_drills: None,
        mirror: None,
        on_warning: None,
    })
    .await;
    assert!(store.is_persistent());
    assert_eq!(store.get_policy().full_cron, "0 1 * * 0");

    store.add_run(backup_run("run-1")).await;
    store
        .update_run(
            "run-1",
            backup_daemon::catalog::RunPatch {
                status: Some("PASSED".to_owned()),
                completed_at: Some("2026-11-03T10:05:00.000Z".to_owned()),
                duration_ms: Some(300_000),
                storage_targets: Some(vec!["primary-s3".to_owned(), "secondary-ssh".to_owned()]),
                ..backup_daemon::catalog::RunPatch::default()
            },
        )
        .await;

    let raw = std::fs::read_to_string(&path).expect("read");
    let persisted: Value = serde_json::from_str(&raw).expect("json");
    assert_eq!(persisted["runs"].as_array().expect("runs").len(), 1);
    assert_eq!(persisted["runs"][0]["status"], "PASSED");
    assert_eq!(persisted["runs"][0]["durationMs"], 300_000);
    let leftovers: Vec<String> = std::fs::read_dir(directory.path())
        .expect("read_dir")
        .map(|entry| {
            entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .filter(|name| name.ends_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty());

    let reloaded = CatalogStore::load(CatalogStoreOptions {
        path,
        default_policy: default_policy(),
        file_system: None,
        max_runs: None,
        max_drills: None,
        mirror: None,
        on_warning: None,
    })
    .await;
    assert_eq!(reloaded.list_runs(10)[0].id, "run-1");
    assert!(reloaded.get_load_warning().is_none());
}

#[tokio::test]
async fn a_corrupt_catalog_is_replaced_in_memory_and_on_disk() {
    let directory = tempfile::tempdir().expect("tempdir");
    let path = directory.path().join("catalog.json");
    std::fs::write(&path, "{ this is not json").expect("write");
    let store = CatalogStore::load(CatalogStoreOptions {
        path: path.clone(),
        default_policy: default_policy(),
        file_system: None,
        max_runs: None,
        max_drills: None,
        mirror: None,
        on_warning: None,
    })
    .await;
    assert!(store.list_runs(10).is_empty());
    assert!(store
        .get_load_warning()
        .expect("warning")
        .contains("corrupt"));

    let reloaded = CatalogStore::load(CatalogStoreOptions {
        path: path.clone(),
        default_policy: default_policy(),
        file_system: None,
        max_runs: None,
        max_drills: None,
        mirror: None,
        on_warning: None,
    })
    .await;
    assert!(reloaded.get_load_warning().is_none());
    let raw: Value =
        serde_json::from_str(&std::fs::read_to_string(&path).expect("read")).expect("json");
    assert_eq!(raw["runs"], serde_json::json!([]));
    assert_eq!(raw["drills"], serde_json::json!([]));
}

#[tokio::test]
async fn prunes_old_records_according_to_retention_limits() {
    let store = CatalogStore::load(CatalogStoreOptions {
        path: PathBuf::from("/virtual/catalog.json"),
        default_policy: default_policy(),
        file_system: Some(Arc::new(MemoryCatalogFileSystem::default())),
        max_runs: Some(2),
        max_drills: Some(1),
        mirror: None,
        on_warning: None,
    })
    .await;
    store
        .add_run(backup_daemon::catalog::BackupRun {
            started_at: "2026-11-01T00:00:00.000Z".to_owned(),
            ..backup_run("old")
        })
        .await;
    store
        .add_run(backup_daemon::catalog::BackupRun {
            started_at: "2026-11-02T00:00:00.000Z".to_owned(),
            ..backup_run("middle")
        })
        .await;
    store
        .add_run(backup_daemon::catalog::BackupRun {
            started_at: "2026-11-03T00:00:00.000Z".to_owned(),
            ..backup_run("new")
        })
        .await;
    assert_eq!(
        store
            .list_runs(10)
            .into_iter()
            .map(|run| run.id)
            .collect::<Vec<_>>(),
        vec!["new", "middle"]
    );
}

#[tokio::test]
async fn falls_back_to_memory_when_the_catalog_path_is_unwritable() {
    let store = CatalogStore::load(CatalogStoreOptions {
        path: PathBuf::from("/proc/pg-backup-daemon-rs/catalog.json"),
        default_policy: default_policy(),
        file_system: Some(Arc::new(FailingCatalogFileSystem)),
        max_runs: None,
        max_drills: None,
        mirror: None,
        on_warning: None,
    })
    .await;
    assert!(!store.is_persistent());
    store.add_run(backup_run("memory-run")).await;
    assert_eq!(store.list_runs(10)[0].id, "memory-run");
    assert!(store
        .get_persistence_error()
        .expect("error")
        .contains("EACCES"));
}

#[tokio::test]
async fn supports_an_injectable_in_memory_file_system() {
    let file_system = Arc::new(MemoryCatalogFileSystem::default());
    let store = CatalogStore::load(CatalogStoreOptions {
        path: PathBuf::from("/virtual/catalog.json"),
        default_policy: default_policy(),
        file_system: Some(file_system.clone()),
        max_runs: None,
        max_drills: None,
        mirror: None,
        on_warning: None,
    })
    .await;
    store.add_run(backup_run("virtual-run")).await;
    assert!(file_system
        .files
        .lock()
        .expect("files")
        .get(&PathBuf::from("/virtual/catalog.json"))
        .expect("file")
        .contains("virtual-run"));
    let reloaded = CatalogStore::load(CatalogStoreOptions {
        path: PathBuf::from("/virtual/catalog.json"),
        default_policy: default_policy(),
        file_system: Some(file_system),
        max_runs: None,
        max_drills: None,
        mirror: None,
        on_warning: None,
    })
    .await;
    assert_eq!(reloaded.list_runs(10)[0].id, "virtual-run");
}

#[tokio::test]
async fn updates_policy_and_keeps_the_configured_default_when_omitted() {
    let store = CatalogStore::load(CatalogStoreOptions {
        path: PathBuf::from("/virtual/policy.json"),
        default_policy: backup_daemon::catalog::BackupPolicy {
            full_cron: "0 2 * * 0".to_owned(),
            full_retention_days: 56,
            updated_at: "2026-11-03T00:00:00.000Z".to_owned(),
            ..default_policy()
        },
        file_system: Some(Arc::new(MemoryCatalogFileSystem::default())),
        max_runs: None,
        max_drills: None,
        mirror: None,
        on_warning: None,
    })
    .await;
    let updated = store
        .update_policy(
            None,
            None,
            None,
            Some(70),
            None,
            None,
            Some("operator-1".to_owned()),
            None,
        )
        .await;
    assert_eq!(updated.full_retention_days, 70);
    assert_eq!(updated.updated_by.as_deref(), Some("operator-1"));
    assert_eq!(updated.full_cron, "0 2 * * 0");
}

fn mirror_setup() -> (
    tempfile::TempDir,
    Arc<MemoryArtifactStore>,
    Arc<MemoryArtifactStore>,
    Arc<RepositoryCatalogMirror>,
    Arc<ArtifactRepository>,
) {
    let staging = tempfile::tempdir().expect("tempdir");
    let s3 = Arc::new(MemoryArtifactStore::new(
        "primary-s3",
        "Primary S3 Bucket",
        StoreKind::S3,
    ));
    let vault = Arc::new(MemoryArtifactStore::new(
        "secondary-ssh",
        "Vault",
        StoreKind::Ssh,
    ));
    let repository = Arc::new(ArtifactRepository::new(vec![s3.clone(), vault.clone()]));
    let mirror = Arc::new(RepositoryCatalogMirror::new(
        Arc::clone(&repository),
        master(),
        staging.path(),
    ));
    (staging, s3, vault, mirror, repository)
}

async fn load_with_mirror(
    mirror: Arc<RepositoryCatalogMirror>,
    file_system: Option<Arc<MemoryCatalogFileSystem>>,
) -> CatalogStore {
    CatalogStore::load(CatalogStoreOptions {
        path: PathBuf::from("/virtual/catalog.json"),
        default_policy: backup_daemon::catalog::BackupPolicy {
            updated_at: "2026-11-06T00:00:00.000Z".to_owned(),
            ..default_policy()
        },
        file_system: file_system
            .map(|file_system| file_system as Arc<dyn backup_daemon::catalog::CatalogFileSystem>),
        max_runs: None,
        max_drills: None,
        mirror: Some(mirror as Arc<dyn CatalogMirror>),
        on_warning: None,
    })
    .await
}

#[tokio::test]
async fn every_catalog_save_uploads_an_encrypted_copy_to_every_tier() {
    let (_staging, s3, vault, mirror, _repository) = mirror_setup();
    let catalog = load_with_mirror(mirror, None).await;
    catalog.add_run(backup_run("run-1")).await;
    catalog.when_mirrored().await;
    for store in [&s3, &vault] {
        let stored = store.object(CATALOG_KEY).expect("mirror object");
        assert!(!stored
            .windows(b"run-1".len())
            .any(|window| window == b"run-1"));
    }
}

#[tokio::test]
async fn a_replacement_host_recovers_runs_and_policy_then_persists_them_locally() {
    let (_staging, _s3, _vault, mirror, _repository) = mirror_setup();
    let original = load_with_mirror(Arc::clone(&mirror), None).await;
    original
        .update_policy(
            None,
            None,
            None,
            Some(90),
            None,
            None,
            Some("checker-1".to_owned()),
            None,
        )
        .await;
    original.add_run(backup_run("run-1")).await;
    original.add_run(backup_run("run-2")).await;
    original.when_mirrored().await;

    let fresh = Arc::new(MemoryCatalogFileSystem::default());
    let replacement = load_with_mirror(mirror, Some(Arc::clone(&fresh))).await;
    assert!(replacement.is_recovered());
    let mut ids: Vec<String> = replacement
        .list_runs(10)
        .into_iter()
        .map(|run| run.id)
        .collect();
    ids.sort();
    assert_eq!(ids, vec!["run-1", "run-2"]);
    assert_eq!(replacement.get_policy().full_retention_days, 90);
    assert!(fresh
        .files
        .lock()
        .expect("files")
        .get(&PathBuf::from("/virtual/catalog.json"))
        .expect("file")
        .contains("run-2"));
}

#[tokio::test]
async fn an_existing_local_catalog_is_not_overwritten_by_the_mirror() {
    let (_staging, _s3, _vault, mirror, _repository) = mirror_setup();
    let first = load_with_mirror(Arc::clone(&mirror), None).await;
    first.add_run(backup_run("mirrored")).await;
    first.when_mirrored().await;

    let local = Arc::new(MemoryCatalogFileSystem::default());
    let seeded = CatalogStore::load(CatalogStoreOptions {
        path: PathBuf::from("/virtual/catalog.json"),
        default_policy: default_policy(),
        file_system: Some(local.clone()),
        max_runs: None,
        max_drills: None,
        mirror: None,
        on_warning: None,
    })
    .await;
    seeded.add_run(backup_run("local-only")).await;

    let reloaded = load_with_mirror(mirror, Some(local)).await;
    assert!(!reloaded.is_recovered());
    assert_eq!(reloaded.list_runs(10)[0].id, "local-only");
}

#[tokio::test]
async fn a_tampered_or_wrong_key_mirror_is_ignored() {
    let (_staging, s3, vault, mirror, _repository) = mirror_setup();
    let catalog = load_with_mirror(Arc::clone(&mirror), None).await;
    catalog.add_run(backup_run("run-1")).await;
    catalog.when_mirrored().await;
    for store in [&s3, &vault] {
        let mut bytes = store.object(CATALOG_KEY).expect("object");
        let index = bytes.len() - 20;
        bytes[index] ^= 1;
        store.put_object(CATALOG_KEY, bytes);
    }
    let recovered = load_with_mirror(mirror, None).await;
    assert!(!recovered.is_recovered());
    assert!(recovered.list_runs(10).is_empty());

    let other_key = RepositoryCatalogMirror::new(
        Arc::new(ArtifactRepository::new(vec![s3])),
        vec![0xab; 32],
        tempfile::tempdir().expect("tempdir").path(),
    );
    assert!(other_key.download().await.expect("download").is_none());
}

#[tokio::test]
async fn the_mirror_falls_back_to_the_next_tier_and_never_blocks_catalog_writes() {
    let (_staging, s3, vault, mirror, _repository) = mirror_setup();
    let catalog = load_with_mirror(Arc::clone(&mirror), None).await;
    catalog.add_run(backup_run("run-1")).await;
    catalog.when_mirrored().await;
    s3.put_object(CATALOG_KEY, b"garbage".to_vec());
    assert!(mirror
        .download()
        .await
        .expect("download")
        .expect("catalog")
        .contains("run-1"));

    s3.set_fail_puts(true);
    vault.set_fail_puts(true);
    let result = catalog.add_run(backup_run("run-2")).await;
    assert_eq!(result.id, "run-2");
    catalog.when_mirrored().await;
    assert!(catalog.get_mirror_error().is_some());
    assert_eq!(catalog.list_runs(10).len(), 2);
}

#[tokio::test]
async fn runs_that_were_queued_or_running_when_the_daemon_stopped_are_failed_on_restart() {
    let store = memory_catalog().await;
    store
        .add_run(backup_daemon::catalog::BackupRun {
            status: "PASSED".to_owned(),
            ..backup_run("finished")
        })
        .await;
    store
        .add_run(backup_daemon::catalog::BackupRun {
            status: "RUNNING".to_owned(),
            ..backup_run("was-running")
        })
        .await;
    store
        .add_run(backup_daemon::catalog::BackupRun {
            status: "QUEUED".to_owned(),
            ..backup_run("was-queued")
        })
        .await;
    let mut interrupted = store
        .fail_interrupted_runs("interrupted: the daemon restarted before this job finished")
        .await;
    interrupted.sort();
    assert_eq!(interrupted, vec!["was-queued", "was-running"]);
    let by_id: std::collections::BTreeMap<String, _> = store
        .list_runs(10)
        .into_iter()
        .map(|run| (run.id.clone(), run))
        .collect();
    assert_eq!(by_id["finished"].status, "PASSED");
    assert_eq!(by_id["was-running"].status, "FAILED");
    assert!(by_id["was-running"]
        .error_message
        .as_deref()
        .expect("message")
        .contains("daemon restarted"));
    assert!(by_id["was-running"].completed_at.is_some());
    assert!(store.fail_interrupted_runs("").await.is_empty());
    assert!(store.has_finished_job("finished"));
    assert!(store.has_finished_job("was-running"));
    assert!(!store.has_finished_job("never-heard-of-it"));
}

#[tokio::test]
async fn import_runs_adds_history_without_duplicating_known_ids() {
    let store = memory_catalog().await;
    store.add_run(backup_run("known")).await;
    assert_eq!(
        store
            .import_runs(vec![
                backup_run("known"),
                backup_run("rebuilt-1"),
                backup_run("rebuilt-2"),
            ])
            .await,
        2
    );
    assert_eq!(store.list_runs(10).len(), 3);
    assert_eq!(store.import_runs(vec![backup_run("rebuilt-1")]).await, 0);
}

#[tokio::test]
async fn drills_are_listed_newest_first_with_a_latest_accessor() {
    let store = memory_catalog().await;
    store.add_drill(make_drill_report("drill-1")).await;
    store.add_drill(make_drill_report("drill-2")).await;
    assert_eq!(store.latest_drill().expect("latest").id, "drill-2");
    assert_eq!(store.list_drills(1)[0].id, "drill-2");
}

//! Port of `deploy/backup-daemon/test/startup.test.ts`.

mod common;

use std::sync::Arc;

use backup_daemon::catalog::{create_default_policy, CatalogStore, CatalogStoreOptions};
use backup_daemon::job_queue::{JobKind, JobQueue, JobSpec};
use backup_daemon::startup::restore_job_state;
use chrono::Utc;
use common::backup_run;

async fn catalog_and_jobs() -> (Arc<CatalogStore>, Arc<JobQueue>, tempfile::TempDir) {
    let directory = tempfile::tempdir().expect("tempdir");
    let catalog = Arc::new(
        CatalogStore::load(CatalogStoreOptions {
            path: directory.path().join("catalog.json"),
            default_policy: create_default_policy(),
            file_system: None,
            max_runs: None,
            max_drills: None,
            mirror: None,
            on_warning: None,
        })
        .await,
    );
    let jobs = Arc::new(JobQueue::new(
        25,
        Some(directory.path().join("idempotency-keys.json")),
        Box::new(Utc::now),
    ));
    (catalog, jobs, directory)
}

#[tokio::test]
async fn a_retry_after_a_crash_starts_a_fresh_job_but_a_finished_job_is_still_deduplicated() {
    let (catalog, jobs, _directory) = catalog_and_jobs().await;
    catalog
        .add_run(backup_daemon::catalog::BackupRun {
            status: "PASSED".to_owned(),
            ..backup_run("done-job")
        })
        .await;
    catalog
        .add_run(backup_daemon::catalog::BackupRun {
            status: "RUNNING".to_owned(),
            ..backup_run("lost-job")
        })
        .await;
    let gate = Arc::new(tokio::sync::Notify::new());
    let gate_clone = Arc::clone(&gate);
    jobs.enqueue(JobSpec {
        id: "done-job".to_owned(),
        kind: JobKind::Backup,
        scope: Some("backup".to_owned()),
        idempotency_key: Some("k-done".to_owned()),
        run: Box::pin(async {}),
    })
    .expect("accepted");
    jobs.enqueue(JobSpec {
        id: "lost-job".to_owned(),
        kind: JobKind::Backup,
        scope: Some("backup".to_owned()),
        idempotency_key: Some("k-lost".to_owned()),
        run: Box::pin(async move {
            gate_clone.notified().await;
        }),
    })
    .expect("accepted");
    jobs.when_persisted().await;

    // --- the daemon restarts: a new process starts with an empty key map ---
    let restarted = Arc::new(JobQueue::new(
        25,
        Some(_directory.path().join("idempotency-keys.json")),
        Box::new(Utc::now),
    ));
    let restored = restore_job_state(&catalog, &restarted).await;
    assert_eq!(restored.interrupted, vec!["lost-job".to_owned()]);
    assert_eq!(restored.restored_keys, 1);
    let retried = restarted
        .enqueue(JobSpec {
            id: "new-1".to_owned(),
            kind: JobKind::Backup,
            scope: Some("backup".to_owned()),
            idempotency_key: Some("k-done".to_owned()),
            run: Box::pin(async {}),
        })
        .expect("accepted");
    assert!(retried.deduplicated);
    assert_eq!(retried.id, "done-job");
    let fresh = restarted
        .enqueue(JobSpec {
            id: "new-2".to_owned(),
            kind: JobKind::Backup,
            scope: Some("backup".to_owned()),
            idempotency_key: Some("k-lost".to_owned()),
            run: Box::pin(async {}),
        })
        .expect("accepted");
    assert!(!fresh.deduplicated);
    restarted.when_idle().await;
    gate.notify_one();
    jobs.when_idle().await;
}

#[tokio::test]
async fn a_queued_or_running_run_is_failed_and_its_key_is_dropped_so_the_retry_runs_fresh() {
    let (catalog, jobs, _directory) = catalog_and_jobs().await;
    catalog
        .add_run(backup_daemon::catalog::BackupRun {
            status: "RUNNING".to_owned(),
            ..backup_run("interrupted")
        })
        .await;
    jobs.enqueue(JobSpec {
        id: "interrupted".to_owned(),
        kind: JobKind::Backup,
        scope: Some("backup".to_owned()),
        idempotency_key: Some("k".to_owned()),
        run: Box::pin(async {}),
    })
    .expect("accepted");
    jobs.when_persisted().await;
    jobs.when_idle().await;
    // A real restart starts a new process and loads the persisted keys; emulate the load.
    let restarted = Arc::new(JobQueue::new(
        25,
        Some(_directory.path().join("idempotency-keys.json")),
        Box::new(Utc::now),
    ));
    let restored = restore_job_state(&catalog, &restarted).await;
    assert_eq!(restored.interrupted, vec!["interrupted".to_owned()]);
    assert_eq!(restored.restored_keys, 0);
    let run = catalog.list_runs(1).remove(0);
    assert_eq!(run.status, "FAILED");
    assert!(run
        .error_message
        .as_deref()
        .expect("message")
        .contains("daemon restarted"));
    assert!(restarted.lookup_key("backup", "k").is_none());
}

#[tokio::test]
async fn a_drill_that_finished_keeps_its_idempotency_key() {
    let (catalog, jobs, _directory) = catalog_and_jobs().await;
    catalog
        .add_drill(common::make_drill_report("drill-done"))
        .await;
    jobs.enqueue(JobSpec {
        id: "drill-done".to_owned(),
        kind: JobKind::Drill,
        scope: Some("drill".to_owned()),
        idempotency_key: Some("drill-key".to_owned()),
        run: Box::pin(async {}),
    })
    .expect("accepted");
    jobs.when_persisted().await;
    jobs.when_idle().await;
    let restarted = Arc::new(JobQueue::new(
        25,
        Some(_directory.path().join("idempotency-keys.json")),
        Box::new(Utc::now),
    ));
    let restored = restore_job_state(&catalog, &restarted).await;
    assert!(restored.interrupted.is_empty());
    assert_eq!(restored.restored_keys, 1);
    assert!(restarted.lookup_key("drill", "drill-key").is_some());
}

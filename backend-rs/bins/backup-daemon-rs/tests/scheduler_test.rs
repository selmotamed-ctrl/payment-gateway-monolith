//! Port of `deploy/backup-daemon/test/scheduler.test.ts`.

mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use backup_daemon::catalog::{create_default_policy, CatalogStore, CatalogStoreOptions};
use backup_daemon::drill::{DrillRunOptions, DrillRunner};
use backup_daemon::engine::{BackupEngine, BackupExecutionResult, BackupKind};
use backup_daemon::job_queue::{JobKind, JobQueue, JobSpec};
use backup_daemon::scheduler::BackupScheduler;
use chrono::{DateTime, Utc};
use common::{make_config, FakeDrillRunner, FakeEngine};

fn instant(value: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value)
        .expect("date")
        .with_timezone(&Utc)
}

async fn scheduler_with(
    now: Arc<Mutex<DateTime<Utc>>>,
    engine: Arc<dyn BackupEngine>,
    drill: Arc<dyn DrillRunner>,
) -> (Arc<BackupScheduler>, Arc<CatalogStore>, Arc<JobQueue>) {
    let catalog = Arc::new(
        CatalogStore::load(CatalogStoreOptions {
            path: std::path::PathBuf::from("/virtual/catalog.json"),
            default_policy: create_default_policy(),
            file_system: Some(Arc::new(
                backup_daemon::catalog::MemoryCatalogFileSystem::default(),
            )),
            max_runs: None,
            max_drills: None,
            mirror: None,
            on_warning: None,
        })
        .await,
    );
    let jobs = Arc::new(JobQueue::new(25, None, {
        let now = Arc::clone(&now);
        Box::new(move || *now.lock().expect("clock"))
    }));
    let scheduler = Arc::new(BackupScheduler::new(
        Arc::new(make_config(&[("BACKUP_ENGINE_MODE", "pg-native")])),
        Arc::clone(&catalog),
        engine,
        drill,
        Arc::clone(&jobs),
        {
            let now = Arc::clone(&now);
            Arc::new(move || *now.lock().expect("clock"))
        },
        Some(Arc::new(|| "scheduled-id".to_owned())),
        None,
    ));
    (scheduler, catalog, jobs)
}

#[tokio::test]
async fn triggers_full_delta_and_drill_exactly_once_from_the_current_policy() {
    let now = Arc::new(Mutex::new(instant("2026-11-03T12:00:00.000Z")));
    let triggers = Arc::new(Mutex::new(Vec::new()));
    let triggers_clone = Arc::clone(&triggers);
    let engine = Arc::new(FakeEngine::new(
        move |target, kind| {
            triggers_clone
                .lock()
                .expect("triggers")
                .push((target, kind));
            Ok(BackupExecutionResult::default())
        },
        |_| Box::pin(async { Ok(Default::default()) }),
    ));
    let drills = Arc::new(AtomicUsize::new(0));
    let drills_clone = Arc::clone(&drills);
    let drill = Arc::new(FakeDrillRunner::new(move |_options: DrillRunOptions| {
        drills_clone.fetch_add(1, Ordering::SeqCst);
        Ok(common::make_drill_report("scheduler-drill"))
    }));
    let (scheduler, catalog, _jobs) = scheduler_with(
        Arc::clone(&now),
        Arc::clone(&engine) as Arc<dyn BackupEngine>,
        drill as Arc<dyn DrillRunner>,
    )
    .await;
    catalog
        .update_policy(
            Some("*/5 * * * *".to_owned()),
            Some("*/10 * * * *".to_owned()),
            Some("*/15 * * * *".to_owned()),
            None,
            None,
            None,
            None,
            None,
        )
        .await;

    *now.lock().expect("clock") = instant("2026-11-03T12:05:00.000Z");
    let current = *now.lock().expect("clock");
    scheduler.tick(current).await.expect("tick");
    *now.lock().expect("clock") = instant("2026-11-03T12:15:00.000Z");
    let current = *now.lock().expect("clock");
    scheduler.tick(current).await.expect("tick");
    let current = *now.lock().expect("clock");
    scheduler.tick(current).await.expect("tick");

    let triggers = triggers.lock().expect("triggers").clone();
    assert_eq!(
        triggers,
        vec![
            (backup_daemon::engine::BackupTarget::All, BackupKind::Full),
            (backup_daemon::engine::BackupTarget::All, BackupKind::Delta),
        ]
    );
    assert_eq!(drills.load(Ordering::SeqCst), 1);
    let runs = catalog.list_runs(10);
    assert_eq!(runs.len(), 2);
    assert!(runs.iter().all(|run| run.status == "PASSED"));
    assert_eq!(catalog.list_drills(10).len(), 1);
}

#[tokio::test]
async fn reloads_a_policy_persisted_through_the_http_api_without_restarting() {
    let now = Arc::new(Mutex::new(instant("2026-11-03T12:00:00.000Z")));
    let engine = Arc::new(FakeEngine::new(
        |_, _| Ok(BackupExecutionResult::default()),
        |_| Box::pin(async { Ok(Default::default()) }),
    ));
    let (scheduler, catalog, _jobs) = scheduler_with(
        Arc::clone(&now),
        engine,
        Arc::new(FakeDrillRunner::reports()),
    )
    .await;
    catalog
        .update_policy(
            Some("0 1 * * *".to_owned()),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await;
    *now.lock().expect("clock") = instant("2026-11-03T12:10:00.000Z");
    let current = *now.lock().expect("clock");
    scheduler.tick(current).await.expect("tick");
    assert!(catalog.list_runs(10).is_empty());

    catalog
        .update_policy(
            Some("*/5 * * * *".to_owned()),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await;
    *now.lock().expect("clock") = instant("2026-11-03T12:15:00.000Z");
    let current = *now.lock().expect("clock");
    scheduler.tick(current).await.expect("tick");
    *now.lock().expect("clock") = instant("2026-11-03T12:20:00.000Z");
    let current = *now.lock().expect("clock");
    scheduler.tick(current).await.expect("tick");
    assert_eq!(catalog.list_runs(10).len(), 1);
}

#[tokio::test]
async fn skips_overlapping_jobs_instead_of_queueing_behind_a_manual_run() {
    let now = Arc::new(Mutex::new(instant("2026-11-03T12:00:00.000Z")));
    let triggers = Arc::new(AtomicUsize::new(0));
    let triggers_clone = Arc::clone(&triggers);
    let engine = Arc::new(FakeEngine::new(
        move |_, _| {
            triggers_clone.fetch_add(1, Ordering::SeqCst);
            Ok(BackupExecutionResult::default())
        },
        |_| Box::pin(async { Ok(Default::default()) }),
    ));
    let (scheduler, catalog, jobs) = scheduler_with(
        Arc::clone(&now),
        engine,
        Arc::new(FakeDrillRunner::reports()),
    )
    .await;
    catalog
        .update_policy(
            Some("*/5 * * * *".to_owned()),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await;
    // A manual run is already waiting.
    let manual = jobs
        .enqueue(JobSpec {
            id: "manual".to_owned(),
            kind: JobKind::Backup,
            scope: None,
            idempotency_key: None,
            run: Box::pin(async {
                tokio::time::sleep(std::time::Duration::from_millis(30)).await;
            }),
        })
        .expect("accepted");
    *now.lock().expect("clock") = instant("2026-11-03T12:05:00.000Z");
    let current = *now.lock().expect("clock");
    scheduler.tick(current).await.expect("tick");
    assert_eq!(triggers.load(Ordering::SeqCst), 0);
    let _ = manual.done.await;
    jobs.when_idle().await;

    // The next slot does run once the manual job is gone.
    *now.lock().expect("clock") = instant("2026-11-03T12:10:00.000Z");
    let current = *now.lock().expect("clock");
    scheduler.tick(current).await.expect("tick");
    assert_eq!(triggers.load(Ordering::SeqCst), 1);
}

#[test]
fn scheduler_state_reports_enabled_and_next_slots() {
    let now = Arc::new(Mutex::new(instant("2026-11-03T12:00:00.000Z")));
    let catalog = futures_block_on(async move {
        CatalogStore::load(CatalogStoreOptions {
            path: std::path::PathBuf::from("/virtual/catalog.json"),
            default_policy: create_default_policy(),
            file_system: Some(Arc::new(
                backup_daemon::catalog::MemoryCatalogFileSystem::default(),
            )),
            max_runs: None,
            max_drills: None,
            mirror: None,
            on_warning: None,
        })
        .await
    });
    let jobs = Arc::new(JobQueue::new(25, None, {
        let now = Arc::clone(&now);
        Box::new(move || *now.lock().expect("clock"))
    }));
    let scheduler = BackupScheduler::new(
        Arc::new(make_config(&[("BACKUP_ENGINE_MODE", "pg-native")])),
        Arc::new(catalog),
        Arc::new(FakeEngine::new(
            |_, _| Ok(BackupExecutionResult::default()),
            |_| Box::pin(async { Ok(Default::default()) }),
        )),
        Arc::new(FakeDrillRunner::reports()),
        jobs,
        {
            let now = Arc::clone(&now);
            Arc::new(move || *now.lock().expect("clock"))
        },
        None,
        None,
    );
    let state = scheduler.get_state();
    assert!(state.enabled);
    assert_eq!(
        state.next_full_at.as_deref(),
        Some("2026-11-08T02:00:00.000Z")
    );
    assert_eq!(
        state.next_delta_at.as_deref(),
        Some("2026-11-04T02:00:00.000Z")
    );
    assert_eq!(
        state.next_drill_at.as_deref(),
        Some("2026-11-08T04:00:00.000Z")
    );
}

/// A tiny blocking executor for the synchronous test above.
fn futures_block_on<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime")
        .block_on(future)
}

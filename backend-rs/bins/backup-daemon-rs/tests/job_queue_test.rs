//! Port of `deploy/backup-daemon/test/jobQueue.test.ts`.

mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use backup_daemon::job_queue::{JobKind, JobQueue, JobSpec, QueueFullError};
use chrono::{DateTime, Utc};

fn queue(max_queued: usize) -> Arc<JobQueue> {
    Arc::new(JobQueue::new(max_queued, None, Box::new(Utc::now)))
}

fn job(
    id: &str,
    kind: JobKind,
    run: backup_daemon::command_runner::BoxFuture<'static, ()>,
) -> JobSpec {
    JobSpec {
        id: id.to_owned(),
        kind,
        scope: None,
        idempotency_key: None,
        run,
    }
}

#[tokio::test]
async fn runs_jobs_strictly_one_at_a_time_in_acceptance_order() {
    let queue = queue(25);
    let log = Arc::new(Mutex::new(Vec::new()));
    let running = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    let mut tickets = Vec::new();
    for index in 0..3 {
        let log = Arc::clone(&log);
        let running = Arc::clone(&running);
        let peak = Arc::clone(&peak);
        let ticket = queue
            .enqueue(job(
                &format!("j{index}"),
                JobKind::Backup,
                Box::pin(async move {
                    let now = running.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now, Ordering::SeqCst);
                    log.lock().expect("log").push(format!("start:{index}"));
                    tokio::time::sleep(Duration::from_millis(2)).await;
                    log.lock().expect("log").push(format!("end:{index}"));
                    running.fetch_sub(1, Ordering::SeqCst);
                }),
            ))
            .expect("accepted");
        tickets.push(ticket);
    }
    assert_eq!(
        tickets
            .iter()
            .map(|ticket| ticket.position)
            .collect::<Vec<_>>(),
        vec![0, 1, 2]
    );
    assert_eq!(queue.active_job().expect("active").0, "j0");
    assert_eq!(queue.queued_count(), 2);
    assert!(queue.is_busy());
    queue.when_idle().await;
    assert_eq!(peak.load(Ordering::SeqCst), 1);
    assert_eq!(
        *log.lock().expect("log"),
        vec!["start:0", "end:0", "start:1", "end:1", "start:2", "end:2"]
    );
    assert!(!queue.is_busy());
}

#[tokio::test]
async fn a_throwing_job_does_not_stop_the_queue_or_reject_its_done_promise() {
    let queue = queue(25);
    let first = queue
        .enqueue(job(
            "bad",
            JobKind::Backup,
            Box::pin(async {
                panic!("boom");
            }),
        ))
        .expect("accepted");
    let ran = Arc::new(AtomicUsize::new(0));
    let ran_clone = Arc::clone(&ran);
    let second = queue
        .enqueue(job(
            "good",
            JobKind::Drill,
            Box::pin(async move {
                ran_clone.fetch_add(1, Ordering::SeqCst);
            }),
        ))
        .expect("accepted");
    let _ = first.done.await;
    let _ = second.done.await;
    queue.when_idle().await;
    assert_eq!(ran.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn idempotency_keys_deduplicate_within_a_scope_and_are_independent_across_scopes() {
    let queue = queue(25);
    let runs = Arc::new(AtomicUsize::new(0));
    let make = |id: &str, scope: &str| {
        let runs = Arc::clone(&runs);
        JobSpec {
            id: id.to_owned(),
            kind: JobKind::Backup,
            scope: Some(scope.to_owned()),
            idempotency_key: Some("k".to_owned()),
            run: Box::pin(async move {
                runs.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(5)).await;
            }),
        }
    };
    let _first = queue.enqueue(make("a", "backup")).expect("accepted");
    let retry = queue.enqueue(make("b", "backup")).expect("deduplicated");
    let other = queue.enqueue(make("c", "drill")).expect("accepted");
    assert!(retry.deduplicated);
    assert_eq!(retry.id, "a");
    assert!(!other.deduplicated);
    assert_eq!(queue.lookup_key("backup", "k").expect("key").0, "a");
    queue.when_idle().await;
    assert_eq!(runs.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn idempotency_keys_expire_after_the_ttl() {
    let directory = tempfile::tempdir().expect("tempdir");
    let path = directory.path().join("keys.json");
    let now = Arc::new(Mutex::new(
        DateTime::parse_from_rfc3339("2026-11-06T00:00:00Z")
            .expect("date")
            .with_timezone(&Utc),
    ));
    let clock = {
        let now = Arc::clone(&now);
        Box::new(move || *now.lock().expect("clock"))
    };
    let queue = Arc::new(JobQueue::new(25, Some(path), clock).with_limits(1000, 1000));
    let make = |id: &str| JobSpec {
        id: id.to_owned(),
        kind: JobKind::Backup,
        scope: Some("backup".to_owned()),
        idempotency_key: Some("k".to_owned()),
        run: Box::pin(async {}),
    };
    queue.enqueue(make("a")).expect("accepted");
    queue.when_idle().await;
    *now.lock().expect("clock") += chrono::Duration::milliseconds(500);
    assert!(queue.enqueue(make("b")).expect("accepted").deduplicated);
    *now.lock().expect("clock") += chrono::Duration::milliseconds(600);
    assert!(!queue.enqueue(make("c")).expect("accepted").deduplicated);
    queue.when_idle().await;
}

#[tokio::test]
async fn the_key_map_is_bounded() {
    let queue =
        Arc::new(JobQueue::new(25, None, Box::new(Utc::now)).with_limits(3, 24 * 60 * 60 * 1000));
    for index in 0..6 {
        let ticket = queue
            .enqueue(JobSpec {
                id: format!("j{index}"),
                kind: JobKind::Backup,
                scope: Some("s".to_owned()),
                idempotency_key: Some(format!("key{index}")),
                run: Box::pin(async {}),
            })
            .expect("accepted");
        let _ = ticket.done.await;
        queue.when_idle().await;
    }
    assert!(queue.lookup_key("s", "key0").is_none());
    assert!(queue.lookup_key("s", "key5").is_some());
}

#[tokio::test]
async fn a_bounded_queue_refuses_new_work_with_queue_full() {
    let queue = queue(1);
    let gate = Arc::new(tokio::sync::Notify::new());
    let gate_clone = Arc::clone(&gate);
    queue
        .enqueue(job(
            "running",
            JobKind::Backup,
            Box::pin(async move {
                gate_clone.notified().await;
            }),
        ))
        .expect("accepted");
    queue
        .enqueue(job("waiting", JobKind::Backup, Box::pin(async {})))
        .expect("accepted");
    let error = match queue.enqueue(job("overflow", JobKind::Backup, Box::pin(async {}))) {
        Ok(_) => panic!("expected the queue to be full"),
        Err(error) => error,
    };
    assert_eq!(error, QueueFullError { limit: 1 });
    gate.notify_one();
    queue.when_idle().await;
}

#[tokio::test]
async fn idempotency_keys_survive_a_restart_for_finished_jobs_only() {
    let directory = tempfile::tempdir().expect("tempdir");
    let path = directory.path().join("idempotency-keys.json");
    let before = Arc::new(JobQueue::new(25, Some(path.clone()), Box::new(Utc::now)));
    before
        .enqueue(JobSpec {
            id: "done-job".to_owned(),
            kind: JobKind::Backup,
            scope: Some("backup".to_owned()),
            idempotency_key: Some("k-done".to_owned()),
            run: Box::pin(async {}),
        })
        .expect("accepted");
    let gate = Arc::new(tokio::sync::Notify::new());
    let gate_clone = Arc::clone(&gate);
    before
        .enqueue(JobSpec {
            id: "lost-job".to_owned(),
            kind: JobKind::Backup,
            scope: Some("backup".to_owned()),
            idempotency_key: Some("k-lost".to_owned()),
            run: Box::pin(async move {
                gate_clone.notified().await;
            }),
        })
        .expect("accepted");
    before.when_persisted().await;
    let raw: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).expect("read")).expect("json");
    assert_eq!(raw.as_array().expect("entries").len(), 2);

    let after = Arc::new(JobQueue::new(25, Some(path), Box::new(Utc::now)));
    assert_eq!(after.load_keys(|id| id == "done-job").await, 1);
    let retried = after
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
    let fresh = after
        .enqueue(JobSpec {
            id: "new-2".to_owned(),
            kind: JobKind::Backup,
            scope: Some("backup".to_owned()),
            idempotency_key: Some("k-lost".to_owned()),
            run: Box::pin(async {}),
        })
        .expect("accepted");
    assert!(!fresh.deduplicated);
    after.when_idle().await;
    gate.notify_one();
    before.when_idle().await;
}

#[tokio::test]
async fn expired_corrupt_or_missing_key_files_restore_nothing_and_never_throw() {
    let directory = tempfile::tempdir().expect("tempdir");
    let path = directory.path().join("keys.json");
    let now = Arc::new(Mutex::new(Utc::now()));
    let clock = {
        let now = Arc::clone(&now);
        Box::new(move || *now.lock().expect("clock"))
    };
    let queue = Arc::new(JobQueue::new(25, Some(path.clone()), clock).with_limits(1000, 1000));
    queue
        .enqueue(JobSpec {
            id: "a".to_owned(),
            kind: JobKind::Backup,
            scope: Some("s".to_owned()),
            idempotency_key: Some("k".to_owned()),
            run: Box::pin(async {}),
        })
        .expect("accepted");
    queue.when_persisted().await;
    *now.lock().expect("clock") += chrono::Duration::seconds(5);
    let later_clock = {
        let now = Arc::clone(&now);
        Box::new(move || *now.lock().expect("clock"))
    };
    let later = Arc::new(JobQueue::new(25, Some(path.clone()), later_clock));
    assert_eq!(later.load_keys(|_| true).await, 0);
    std::fs::write(&path, "{corrupt").expect("write");
    assert_eq!(later.load_keys(|_| true).await, 0);
    assert_eq!(
        Arc::new(JobQueue::new(
            25,
            Some(directory.path().join("nope.json")),
            Box::new(Utc::now)
        ))
        .load_keys(|_| true)
        .await,
        0
    );
    assert_eq!(
        Arc::new(JobQueue::new(25, None, Box::new(Utc::now)))
            .load_keys(|_| true)
            .await,
        0
    );
}

//! One FIFO queue for every long-running job (backups AND restore drills), shared by the HTTP API
//! and the scheduler. Port of `deploy/backup-daemon/src/jobQueue.ts`.
//!
//! Two rapid clicks on "Run backup now", or a manual trigger that lands on the scheduler's slot,
//! must never start overlapping `pg_basebackup` / `pg_ctl` processes on the same scratch directory.
//! Jobs therefore run strictly one at a time, in acceptance order. `Idempotency-Key` retries (same
//! scope + key) return the already-accepted job instead of enqueueing a second one.

use std::collections::{BTreeMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::{oneshot, Notify};

use crate::command_runner::BoxFuture;
use crate::util::write_file_atomic;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobKind {
    Backup,
    Drill,
}

impl JobKind {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Backup => "backup",
            Self::Drill => "drill",
        }
    }
}

pub struct JobSpec {
    pub id: String,
    pub kind: JobKind,
    /// Namespace of the idempotency key (e.g. the route).
    pub scope: Option<String>,
    pub idempotency_key: Option<String>,
    pub run: BoxFuture<'static, ()>,
}

pub struct EnqueueResult {
    pub id: String,
    pub deduplicated: bool,
    pub accepted_at: String,
    /// 0 = starts immediately; N = N jobs are ahead of it.
    pub position: usize,
    /// Settles (never rejects) when the job has finished. For a deduplicated request it resolves
    /// immediately.
    pub done: oneshot::Receiver<()>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueueFullError {
    pub limit: usize,
}

impl std::fmt::Display for QueueFullError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "the job queue is full ({} jobs waiting); retry later",
            self.limit
        )
    }
}

impl std::error::Error for QueueFullError {}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdempotencyEntry {
    id: String,
    accepted_at: String,
    expires_at_ms: i64,
}

struct QueuedJob {
    id: String,
    kind: JobKind,
    run: BoxFuture<'static, ()>,
    completion: oneshot::Sender<()>,
}

struct Inner {
    waiting: VecDeque<QueuedJob>,
    active: Option<(String, JobKind)>,
    draining: bool,
    keys: BTreeMap<String, IdempotencyEntry>,
}

type Clock = Box<dyn Fn() -> DateTime<Utc> + Send + Sync>;

pub struct JobQueue {
    inner: Mutex<Inner>,
    clock: Clock,
    max_queued: usize,
    max_entries: usize,
    ttl_ms: i64,
    persist_path: Option<PathBuf>,
    pending_persists: Arc<AtomicUsize>,
    persist_notify: Arc<Notify>,
    /// Serializes key-file writes so the newest snapshot is the one on disk.
    persist_lock: Arc<tokio::sync::Mutex<()>>,
    idle_notify: Notify,
}

impl JobQueue {
    #[must_use]
    pub fn new(max_queued: usize, persist_path: Option<PathBuf>, clock: Clock) -> Self {
        Self {
            inner: Mutex::new(Inner {
                waiting: VecDeque::new(),
                active: None,
                draining: false,
                keys: BTreeMap::new(),
            }),
            clock,
            max_queued,
            max_entries: 1000,
            ttl_ms: 24 * 60 * 60 * 1000,
            persist_path,
            pending_persists: Arc::new(AtomicUsize::new(0)),
            persist_notify: Arc::new(Notify::new()),
            persist_lock: Arc::new(tokio::sync::Mutex::new(())),
            idle_notify: Notify::new(),
        }
    }

    #[must_use]
    pub fn with_limits(mut self, max_entries: usize, ttl_ms: i64) -> Self {
        self.max_entries = max_entries;
        self.ttl_ms = ttl_ms;
        self
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Restores persisted keys. `is_finished(id)` must say whether that job completed
    /// (PASSED/FAILED): a key whose job was interrupted by the restart is DROPPED, so the client's
    /// retry runs a fresh job instead of being "deduplicated" to one that no longer exists.
    pub async fn load_keys(&self, is_finished: impl Fn(&str) -> bool) -> usize {
        let Some(path) = &self.persist_path else {
            return 0;
        };
        let raw = match tokio::fs::read_to_string(path).await {
            Ok(text) => text,
            Err(_) => return 0,
        };
        let entries: Vec<(String, IdempotencyEntry)> = match serde_json::from_str(&raw) {
            Ok(entries) => entries,
            Err(_) => return 0,
        };
        let now_ms = (self.clock)().timestamp_millis();
        let mut restored = 0;
        let mut inner = self.lock();
        for (key, entry) in entries {
            if entry.expires_at_ms <= now_ms || !is_finished(&entry.id) {
                continue;
            }
            inner.keys.insert(key, entry);
            restored += 1;
        }
        restored
    }

    /// Resolves when every queued key write has reached disk.
    pub async fn when_persisted(&self) {
        while self.pending_persists.load(Ordering::Acquire) > 0 {
            self.persist_notify.notified().await;
        }
    }

    fn persist_keys(&self) {
        let Some(path) = &self.persist_path else {
            return;
        };
        let snapshot = {
            let inner = self.lock();
            let entries: Vec<(String, IdempotencyEntry)> = inner
                .keys
                .iter()
                .map(|(key, entry)| (key.clone(), entry.clone()))
                .collect();
            serde_json::to_vec(&entries).unwrap_or_else(|_| b"[]".to_vec())
        };
        let path = path.clone();
        self.pending_persists.fetch_add(1, Ordering::AcqRel);
        let notify = Arc::clone(&self.persist_notify);
        let pending = Arc::clone(&self.pending_persists);
        let lock = Arc::clone(&self.persist_lock);
        tokio::spawn(async move {
            let _guard = lock.lock().await;
            let _ = write_file_atomic(&path, &snapshot).await;
            pending.fetch_sub(1, Ordering::AcqRel);
            notify.notify_waiters();
        });
    }

    /// Accepts a job, in acceptance order. Synchronous like the TS method; the drain task runs on
    /// the current Tokio runtime.
    ///
    /// # Errors
    /// [`QueueFullError`] when `max_queued` jobs are already waiting.
    pub fn enqueue(self: &Arc<Self>, spec: JobSpec) -> Result<EnqueueResult, QueueFullError> {
        let now = (self.clock)();
        let map_key = spec.idempotency_key.as_ref().map(|key| {
            format!(
                "{}:{key}",
                spec.scope
                    .clone()
                    .unwrap_or_else(|| spec.kind.as_str().to_owned())
            )
        });

        let mut inner = self.lock();
        let now_ms = now.timestamp_millis();
        Self::expire_keys(&mut inner.keys, now_ms);
        if let Some(key) = &map_key {
            if let Some(existing) = inner.keys.get(key) {
                let (sender, receiver) = oneshot::channel();
                let _ = sender.send(());
                return Ok(EnqueueResult {
                    id: existing.id.clone(),
                    deduplicated: true,
                    accepted_at: existing.accepted_at.clone(),
                    position: Self::position_of(&inner, &existing.id),
                    done: receiver,
                });
            }
        }
        if inner.waiting.len() >= self.max_queued {
            return Err(QueueFullError {
                limit: self.max_queued,
            });
        }
        let accepted_at = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let position = inner.waiting.len() + usize::from(inner.active.is_some());
        if let Some(key) = &map_key {
            if inner.keys.len() >= self.max_entries {
                if let Some(oldest) = inner.keys.keys().next().cloned() {
                    inner.keys.remove(&oldest);
                }
            }
            inner.keys.insert(
                key.clone(),
                IdempotencyEntry {
                    id: spec.id.clone(),
                    accepted_at: accepted_at.clone(),
                    expires_at_ms: now_ms + self.ttl_ms,
                },
            );
        }
        let id = spec.id.clone();
        let (completion, receiver) = oneshot::channel();
        inner.waiting.push_back(QueuedJob {
            id: id.clone(),
            kind: spec.kind,
            run: spec.run,
            completion,
        });
        let needs_persist = map_key.is_some();
        drop(inner);
        if needs_persist {
            self.persist_keys();
        }
        self.ensure_draining();
        Ok(EnqueueResult {
            id,
            deduplicated: false,
            accepted_at,
            position,
            done: receiver,
        })
    }

    /// The job a previous request with this key was accepted as, if it is still remembered.
    pub fn lookup_key(&self, scope: &str, key: &str) -> Option<(String, String)> {
        let mut inner = self.lock();
        Self::expire_keys(&mut inner.keys, (self.clock)().timestamp_millis());
        inner
            .keys
            .get(&format!("{scope}:{key}"))
            .map(|entry| (entry.id.clone(), entry.accepted_at.clone()))
    }

    /// True while a job runs or waits. The scheduler skips a due slot instead of queueing behind a
    /// manual run.
    pub fn is_busy(&self) -> bool {
        let inner = self.lock();
        inner.active.is_some() || !inner.waiting.is_empty()
    }

    pub fn active_job(&self) -> Option<(String, JobKind)> {
        self.lock().active.clone()
    }

    pub fn queued_count(&self) -> usize {
        self.lock().waiting.len()
    }

    pub async fn when_idle(&self) {
        loop {
            let notified = self.idle_notify.notified();
            let busy = {
                let inner = self.lock();
                inner.active.is_some() || !inner.waiting.is_empty()
            };
            if !busy {
                return;
            }
            notified.await;
        }
    }

    fn position_of(inner: &Inner, id: &str) -> usize {
        if inner
            .active
            .as_ref()
            .is_some_and(|(active, _)| active == id)
        {
            return 0;
        }
        match inner.waiting.iter().position(|job| job.id == id) {
            Some(index) => index + usize::from(inner.active.is_some()),
            None => 0,
        }
    }

    fn expire_keys(keys: &mut BTreeMap<String, IdempotencyEntry>, now_ms: i64) {
        keys.retain(|_, entry| entry.expires_at_ms > now_ms);
    }

    /// Starts the drain task and, exactly like the TS queue, marks the first accepted job active
    /// before `enqueue` returns. That is what makes `maxQueued` mean "25 *waiting*" (the running job
    /// does not occupy a slot) and keeps `activeJob()` observable right after acceptance.
    fn ensure_draining(self: &Arc<Self>) {
        let first = {
            let mut inner = self.lock();
            if inner.draining {
                return;
            }
            inner.draining = true;
            let first = inner.waiting.pop_front();
            if let Some(job) = &first {
                inner.active = Some((job.id.clone(), job.kind));
            }
            first
        };
        let queue = Arc::clone(self);
        tokio::spawn(async move {
            queue.drain(first).await;
        });
    }

    async fn drain(self: Arc<Self>, mut current: Option<QueuedJob>) {
        loop {
            let Some(job) = current else {
                let mut inner = self.lock();
                inner.draining = false;
                inner.active = None;
                drop(inner);
                self.idle_notify.notify_waiters();
                return;
            };
            // A panicking job body must not stop the queue: run it in its own task and observe the
            // join result. The job bodies record their own failures in the catalog.
            let handle = tokio::spawn(job.run);
            let _ = handle.await;
            let next = {
                let mut inner = self.lock();
                inner.active = None;
                let next = inner.waiting.pop_front();
                if let Some(job) = &next {
                    inner.active = Some((job.id.clone(), job.kind));
                }
                next
            };
            let _ = job.completion.send(());
            self.idle_notify.notify_waiters();
            current = next;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn queue(max_queued: usize) -> Arc<JobQueue> {
        Arc::new(JobQueue::new(max_queued, None, Box::new(Utc::now)))
    }

    #[tokio::test]
    async fn runs_jobs_one_at_a_time_in_order() {
        let queue = queue(25);
        let log = Arc::new(Mutex::new(Vec::new()));
        for index in 0..3 {
            let log = Arc::clone(&log);
            let job = JobSpec {
                id: format!("j{index}"),
                kind: JobKind::Backup,
                scope: None,
                idempotency_key: None,
                run: Box::pin(async move {
                    log.lock().unwrap().push(format!("start:{index}"));
                    tokio::task::yield_now().await;
                    log.lock().unwrap().push(format!("end:{index}"));
                }),
            };
            queue.enqueue(job).expect("accepted");
        }
        queue.when_idle().await;
        assert_eq!(
            *log.lock().unwrap(),
            vec!["start:0", "end:0", "start:1", "end:1", "start:2", "end:2"]
        );
    }

    #[tokio::test]
    async fn idempotency_keys_deduplicate_within_a_scope() {
        let queue = queue(25);
        let mut tickets = Vec::new();
        for id in ["a", "b"] {
            tickets.push(
                queue
                    .enqueue(JobSpec {
                        id: id.to_owned(),
                        kind: JobKind::Backup,
                        scope: Some("backup".to_owned()),
                        idempotency_key: Some("k".to_owned()),
                        run: Box::pin(async {}),
                    })
                    .expect("accepted"),
            );
        }
        assert!(!tickets[0].deduplicated);
        assert!(tickets[1].deduplicated);
        assert_eq!(tickets[1].id, "a");
        queue.when_idle().await;
    }
}

//! Worker runtime: interval loop, jitter, singleton leadership and health.
//!
//! Port of `core-back/engine/workers/workerRuntime.ts` (loop shape) and the boot/stop rules of
//! `productionRuntime.ts`. The advisory-lock SQL lives in `pg-db::leader`; this crate depends only
//! on the [`LeaderLock`] trait so it stays testable without PostgreSQL.

#![forbid(unsafe_code)]

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::Utc;
use futures_util::FutureExt;
use thiserror::Error;
use tokio::sync::watch;
use tokio::task::JoinSet;
use tracing::{error, info, warn};

use crate::health::{WorkerSnapshot, WorkerState};

#[derive(Debug, Error)]
pub enum WorkerError {
    #[error("{0}")]
    Failed(String),
    #[error("leader election failed: {0}")]
    Leader(String),
    #[error("worker {0} is disabled")]
    Disabled(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerOutcome {
    Processed(u64),
    Skipped,
    Deferred,
}

#[async_trait]
pub trait Worker: Send + Sync {
    fn name(&self) -> &'static str;
    fn interval(&self) -> Duration;
    /// Singleton workers run on one node through the shared advisory lock.
    fn singleton(&self) -> bool {
        false
    }
    /// Cadence for the next tick. `None` uses [`Worker::interval`].
    ///
    /// Additive to the TS runtime: the outbox relay backs off while the queue is idle
    /// (`nextPollDelayMs`, `core-back/lib/storageEngine/outboxWorkers.ts:373`) and shortens the
    /// delay after a busy drain. Other workers keep the fixed interval.
    fn next_delay(&self) -> Option<Duration> {
        None
    }
    async fn tick(&self, ctx: &WorkerContext) -> Result<WorkerOutcome, WorkerError>;
}

#[async_trait]
pub trait LeaderLock: Send + Sync {
    async fn try_acquire(&self, worker: &str) -> Result<bool, WorkerError>;
    async fn verify(&self, worker: &str) -> Result<bool, WorkerError>;
    async fn release(&self, worker: &str) -> Result<(), WorkerError>;
}

/// A lock that always succeeds. Development and tests only.
#[derive(Debug, Default)]
pub struct LocalLeaderLock;

#[async_trait]
impl LeaderLock for LocalLeaderLock {
    async fn try_acquire(&self, _worker: &str) -> Result<bool, WorkerError> {
        Ok(true)
    }
    async fn verify(&self, _worker: &str) -> Result<bool, WorkerError> {
        Ok(true)
    }
    async fn release(&self, _worker: &str) -> Result<(), WorkerError> {
        Ok(())
    }
}

pub struct WorkerContext {
    pub snapshot: WorkerSnapshot,
    pub leader: Arc<dyn LeaderLock>,
    pub tick: u64,
    pub shutdown: watch::Receiver<bool>,
}

impl WorkerContext {
    #[must_use]
    pub fn shutting_down(&self) -> bool {
        *self.shutdown.borrow()
    }
}

#[derive(Debug, Clone)]
pub struct WorkerRuntimeConfig {
    /// Maximum random-ish startup delay (0 disables). Prevents thundering herds after a deploy.
    pub jitter_ms: u64,
    /// A tick that runs longer than this logs a warning (it is not cancelled; parity with TS).
    pub slow_tick_warning: Duration,
    /// `WORKER_DISABLED` (comma list), P0-T03 on both implementations.
    pub disabled: Vec<String>,
}

impl Default for WorkerRuntimeConfig {
    fn default() -> Self {
        Self {
            jitter_ms: 1_000,
            slow_tick_warning: Duration::from_secs(30),
            disabled: Vec::new(),
        }
    }
}

/// Owns the worker tasks and their health registry.
pub struct WorkerRuntime {
    workers: Vec<Arc<dyn Worker>>,
    snapshot: WorkerSnapshot,
    leader: Arc<dyn LeaderLock>,
    config: WorkerRuntimeConfig,
    shutdown_tx: watch::Sender<bool>,
    shutdown_rx: watch::Receiver<bool>,
}

impl WorkerRuntime {
    #[must_use]
    pub fn new(
        workers: Vec<Arc<dyn Worker>>,
        leader: Arc<dyn LeaderLock>,
        config: WorkerRuntimeConfig,
    ) -> Self {
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let snapshot = WorkerSnapshot::new();
        for worker in &workers {
            let mut state = WorkerState::new(worker.name(), worker.singleton());
            state.interval_ms = worker.interval().as_millis() as u64;
            if config.disabled.iter().any(|name| name == worker.name()) {
                state.running = false;
            }
            snapshot.register(state);
        }
        Self {
            workers,
            snapshot,
            leader,
            config,
            shutdown_tx,
            shutdown_rx,
        }
    }

    #[must_use]
    pub fn snapshot(&self) -> WorkerSnapshot {
        self.snapshot.clone()
    }

    pub fn spawn(self) -> WorkerHandle {
        let WorkerRuntime {
            workers,
            snapshot,
            leader,
            config,
            shutdown_tx,
            shutdown_rx,
        } = self;
        let mut tasks = JoinSet::new();
        for (index, worker) in workers.into_iter().enumerate() {
            let snapshot = snapshot.clone();
            let leader = leader.clone();
            let config = config.clone();
            let mut shutdown = shutdown_rx.clone();
            tasks.spawn(async move {
                let jitter = if config.jitter_ms == 0 {
                    0
                } else {
                    (index as u64 * 2_654_435_761 + worker.name().len() as u64) % config.jitter_ms
                };
                if jitter > 0 {
                    tokio::time::sleep(Duration::from_millis(jitter)).await;
                }
                let disabled = config.disabled.iter().any(|name| name == worker.name());
                snapshot.set_running(worker.name(), !disabled);
                if disabled {
                    info!(worker = worker.name(), "worker disabled by WORKER_DISABLED");
                    return;
                }
                let mut tick = 0_u64;
                loop {
                    if *shutdown.borrow() {
                        break;
                    }
                    tick += 1;
                    if worker.singleton() {
                        match leader.try_acquire(worker.name()).await {
                            Ok(true) => snapshot.set_leader(worker.name(), true),
                            Ok(false) => {
                                snapshot.set_leader(worker.name(), false);
                                if sleep_or_shutdown(&mut shutdown, worker.interval()).await {
                                    break;
                                }
                                continue;
                            }
                            Err(error) => {
                                snapshot.record_failure(worker.name(), &error.to_string());
                                warn!(worker = worker.name(), %error, "leader election failed");
                                if sleep_or_shutdown(&mut shutdown, worker.interval()).await {
                                    break;
                                }
                                continue;
                            }
                        }
                    }
                    // Re-prove ownership every tick; fail closed without running.
                    if worker.singleton() {
                        match leader.verify(worker.name()).await {
                            Ok(true) => {}
                            Ok(false) | Err(_) => {
                                snapshot.set_leader(worker.name(), false);
                                if sleep_or_shutdown(&mut shutdown, worker.interval()).await {
                                    break;
                                }
                                continue;
                            }
                        }
                    }
                    snapshot.record_start(worker.name(), Utc::now());
                    let started = std::time::Instant::now();
                    let ctx = WorkerContext {
                        snapshot: snapshot.clone(),
                        leader: leader.clone(),
                        tick,
                        shutdown: shutdown.clone(),
                    };
                    let result = std::panic::AssertUnwindSafe(worker.tick(&ctx))
                        .catch_unwind()
                        .await;
                    let duration = started.elapsed();
                    match result {
                        Ok(Ok(outcome)) => {
                            let processed = match outcome {
                                WorkerOutcome::Processed(count) => Some(count),
                                WorkerOutcome::Skipped | WorkerOutcome::Deferred => None,
                            };
                            snapshot.record_success_with(
                                worker.name(),
                                Utc::now(),
                                duration,
                                processed,
                            );
                            if duration > config.slow_tick_warning {
                                warn!(
                                    worker = worker.name(),
                                    duration_ms = duration.as_millis() as u64,
                                    ?outcome,
                                    "slow worker tick"
                                );
                            }
                        }
                        Ok(Err(error)) => {
                            snapshot.record_failure_at(
                                worker.name(),
                                &error.to_string(),
                                Utc::now(),
                            );
                            error!(worker = worker.name(), %error, "worker tick failed");
                        }
                        Err(_) => {
                            snapshot.record_failure_at(
                                worker.name(),
                                "worker tick panicked",
                                Utc::now(),
                            );
                            error!(worker = worker.name(), "worker tick panicked");
                        }
                    }
                    let delay = worker.next_delay().unwrap_or_else(|| worker.interval());
                    if sleep_or_shutdown(&mut shutdown, delay).await {
                        break;
                    }
                }
                if worker.singleton() {
                    let _ = leader.release(worker.name()).await;
                }
                snapshot.set_running(worker.name(), false);
            });
        }
        WorkerHandle {
            tasks,
            shutdown_tx,
            snapshot,
        }
    }
}

async fn sleep_or_shutdown(shutdown: &mut watch::Receiver<bool>, duration: Duration) -> bool {
    tokio::select! {
        () = tokio::time::sleep(duration) => *shutdown.borrow(),
        result = shutdown.changed() => result.is_err() || *shutdown.borrow(),
    }
}

/// Handle used by `main` to stop workers before closing pools.
pub struct WorkerHandle {
    tasks: JoinSet<()>,
    shutdown_tx: watch::Sender<bool>,
    snapshot: WorkerSnapshot,
}

impl WorkerHandle {
    #[must_use]
    pub fn snapshot(&self) -> WorkerSnapshot {
        self.snapshot.clone()
    }

    /// Signal shutdown and wait for every worker's current tick.
    pub async fn shutdown(mut self) {
        let _ = self.shutdown_tx.send(true);
        while self.tasks.join_next().await.is_some() {}
    }

    /// Signal shutdown without waiting (graceful shutdown timeout path).
    pub fn request_shutdown(&self) {
        let _ = self.shutdown_tx.send(true);
    }

    pub async fn join(mut self) {
        while self.tasks.join_next().await.is_some() {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct CountingWorker {
        name: &'static str,
        ticks: Arc<AtomicU64>,
    }

    #[async_trait]
    impl Worker for CountingWorker {
        fn name(&self) -> &'static str {
            self.name
        }
        fn interval(&self) -> Duration {
            Duration::from_millis(10)
        }
        async fn tick(&self, _ctx: &WorkerContext) -> Result<WorkerOutcome, WorkerError> {
            self.ticks.fetch_add(1, Ordering::SeqCst);
            Ok(WorkerOutcome::Processed(1))
        }
    }

    #[tokio::test]
    async fn runs_and_stops() {
        let ticks = Arc::new(AtomicU64::new(0));
        let runtime = WorkerRuntime::new(
            vec![Arc::new(CountingWorker {
                name: "TestWorker",
                ticks: ticks.clone(),
            })],
            Arc::new(LocalLeaderLock),
            WorkerRuntimeConfig {
                jitter_ms: 0,
                ..WorkerRuntimeConfig::default()
            },
        );
        let snapshot = runtime.snapshot();
        let handle = runtime.spawn();
        tokio::time::sleep(Duration::from_millis(50)).await;
        handle.shutdown().await;
        assert!(ticks.load(Ordering::SeqCst) >= 1);
        assert!(!snapshot.get("TestWorker").expect("state").running);
    }

    #[tokio::test]
    async fn disabled_workers_do_not_tick() {
        let ticks = Arc::new(AtomicU64::new(0));
        let runtime = WorkerRuntime::new(
            vec![Arc::new(CountingWorker {
                name: "DisabledWorker",
                ticks: ticks.clone(),
            })],
            Arc::new(LocalLeaderLock),
            WorkerRuntimeConfig {
                jitter_ms: 0,
                disabled: vec!["DisabledWorker".to_owned()],
                ..WorkerRuntimeConfig::default()
            },
        );
        let handle = runtime.spawn();
        tokio::time::sleep(Duration::from_millis(30)).await;
        handle.shutdown().await;
        assert_eq!(ticks.load(Ordering::SeqCst), 0);
    }
}

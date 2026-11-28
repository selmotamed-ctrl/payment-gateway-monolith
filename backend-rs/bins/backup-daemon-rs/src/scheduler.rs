//! Policy-driven backup/drill scheduling with the daemon's own five-field cron.
//! Port of `deploy/backup-daemon/src/scheduler.ts`.
//!
//! A scheduled slot never overlaps a manual run: the scheduler skips a due slot instead of queueing
//! behind one, and every start goes through the shared [`crate::job_queue::JobQueue`].

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;

use crate::catalog::{BackupRun, CatalogStore, RunPatch};
use crate::command_runner::BoxFuture;
use crate::config::{redact_text, Config};
use crate::cron::next_cron_run;
use crate::drill::{sign_drill_report, DrillReport, DrillRunOptions, DrillRunner};
use crate::engine::{BackupEngine, BackupKind, BackupTarget};
use crate::job_queue::{JobKind, JobQueue, JobSpec};

pub const SCHEDULED_JOBS: [ScheduledJob; 3] =
    [ScheduledJob::Full, ScheduledJob::Delta, ScheduledJob::Drill];

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ScheduledJob {
    Full,
    Delta,
    Drill,
}

impl ScheduledJob {
    fn index(self) -> usize {
        match self {
            Self::Full => 0,
            Self::Delta => 1,
            Self::Drill => 2,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Full => "full",
            Self::Delta => "delta",
            Self::Drill => "drill",
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerState {
    pub enabled: bool,
    pub next_full_at: Option<String>,
    pub next_delta_at: Option<String>,
    pub next_drill_at: Option<String>,
}

pub type SyncObjectStorage = Arc<dyn Fn() -> BoxFuture<'static, Vec<String>> + Send + Sync>;

struct ScheduleInner {
    crons: [String; 3],
    next: [Option<DateTime<Utc>>; 3],
    last_slot: [Option<String>; 3],
    running: BTreeSet<ScheduledJob>,
}

pub struct BackupScheduler {
    config: Arc<Config>,
    catalog: Arc<CatalogStore>,
    engine: Arc<dyn BackupEngine>,
    drill_runner: Arc<dyn DrillRunner>,
    jobs: Arc<JobQueue>,
    clock: Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>,
    id_factory: Arc<dyn Fn() -> String + Send + Sync>,
    sync_object_storage: Option<SyncObjectStorage>,
    enabled: bool,
    running: AtomicBool,
    inner: Mutex<ScheduleInner>,
    issued_ids: Mutex<BTreeSet<String>>,
}

impl BackupScheduler {
    #[allow(clippy::too_many_arguments)]
    #[must_use]
    pub fn new(
        config: Arc<Config>,
        catalog: Arc<CatalogStore>,
        engine: Arc<dyn BackupEngine>,
        drill_runner: Arc<dyn DrillRunner>,
        jobs: Arc<JobQueue>,
        clock: Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>,
        id_factory: Option<Arc<dyn Fn() -> String + Send + Sync>>,
        sync_object_storage: Option<SyncObjectStorage>,
    ) -> Self {
        let enabled = config.scheduler_enabled;
        let mut issued_ids = BTreeSet::new();
        for run in catalog.snapshot().runs {
            issued_ids.insert(run.id);
        }
        for drill in catalog.snapshot().drills {
            issued_ids.insert(drill.id);
        }
        let scheduler = Self {
            config,
            catalog,
            engine,
            drill_runner,
            jobs,
            clock,
            id_factory: id_factory.unwrap_or_else(|| Arc::new(|| uuid::Uuid::new_v4().to_string())),
            sync_object_storage,
            enabled,
            running: AtomicBool::new(false),
            inner: Mutex::new(ScheduleInner {
                crons: [String::new(), String::new(), String::new()],
                next: [None, None, None],
                last_slot: [None, None, None],
                running: BTreeSet::new(),
            }),
            issued_ids: Mutex::new(issued_ids),
        };
        scheduler.sync_policy((scheduler.clock)());
        scheduler
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ScheduleInner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn start(self: &Arc<Self>) {
        if !self.enabled || self.running.swap(true, Ordering::AcqRel) {
            return;
        }
        let scheduler = Arc::clone(self);
        let tick_ms = self.config.scheduler_tick_ms;
        tokio::spawn(async move {
            let mut interval =
                tokio::time::interval(std::time::Duration::from_millis(tick_ms.max(1)));
            while scheduler.running.load(Ordering::Acquire) {
                interval.tick().await;
                if let Err(error) = scheduler.tick((scheduler.clock)()).await {
                    tracing::error!(error = %scheduler.safe_message(&error), "scheduler tick failed");
                }
            }
        });
    }

    pub fn stop(&self) {
        self.running.store(false, Ordering::Release);
    }

    pub fn get_state(&self) -> SchedulerState {
        let now = (self.clock)();
        self.sync_policy(now);
        let inner = self.lock();
        SchedulerState {
            enabled: self.enabled,
            next_full_at: inner.next[0].map(format_instant),
            next_delta_at: inner.next[1].map(format_instant),
            next_drill_at: inner.next[2].map(format_instant),
        }
    }

    fn sync_policy(&self, now: DateTime<Utc>) {
        let policy = self.catalog.get_policy();
        let expressions = [policy.full_cron, policy.delta_cron, policy.drill_cron];
        let mut inner = self.lock();
        for (index, expression) in expressions.into_iter().enumerate() {
            if inner.crons[index] == expression {
                if !self.enabled {
                    inner.next[index] = None;
                }
                continue;
            }
            inner.crons[index] = expression.clone();
            inner.last_slot[index] = None;
            inner.next[index] = if self.enabled {
                next_cron_run(&expression, now).ok()
            } else {
                None
            };
        }
    }

    pub async fn tick(&self, now: DateTime<Utc>) -> Result<(), String> {
        self.sync_policy(now);
        if !self.enabled {
            return Ok(());
        }

        let mut due: Vec<(ScheduledJob, DateTime<Utc>)> = Vec::new();
        {
            let mut inner = self.lock();
            for job in SCHEDULED_JOBS {
                let index = job.index();
                let expression = inner.crons[index].clone();
                let Some(next_at) = inner.next[index] else {
                    continue;
                };
                if next_at > now {
                    continue;
                }
                inner.next[index] = next_cron_run(&expression, now).ok();
                due.push((job, next_at));
            }
        }
        due.sort_by_key(|left| left.1);

        for (job, slot_at) in due {
            let slot_key = format_instant(slot_at);
            {
                let inner = self.lock();
                if inner.last_slot[job.index()].as_deref() == Some(slot_key.as_str()) {
                    continue;
                }
                if !inner.running.is_empty() || self.jobs.is_busy() {
                    tracing::warn!(
                        job = job.name(),
                        slot = slot_key.as_str(),
                        "skipping scheduled run: another job is still running"
                    );
                    continue;
                }
            }
            {
                let mut inner = self.lock();
                inner.last_slot[job.index()] = Some(slot_key);
                inner.running.insert(job);
            }
            let result = self.run_queued(job, slot_at).await;
            {
                let mut inner = self.lock();
                inner.running.remove(&job);
            }
            if let Err(error) = result {
                tracing::error!(
                    job = job.name(),
                    error = %self.safe_message(&error),
                    "scheduled job failed"
                );
            }
        }
        Ok(())
    }

    fn safe_message(&self, error: &str) -> String {
        redact_text(error, &self.config.secret_values())
            .chars()
            .take(2000)
            .collect()
    }

    fn reserve_id(&self) -> String {
        let mut issued = self
            .issued_ids
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for _attempt in 0..20 {
            let id = (self.id_factory)();
            if !id.is_empty() && !issued.contains(&id) {
                issued.insert(id.clone());
                return id;
            }
        }
        format!("scheduler-{}", (self.clock)().timestamp_millis())
    }

    /// Runs through the shared queue so HTTP triggers and slots serialize.
    async fn run_queued(&self, job: ScheduledJob, slot_at: DateTime<Utc>) -> Result<(), String> {
        let id = format!("scheduler-{}-{}", job.name(), slot_at.timestamp_millis());
        let engine = Arc::clone(&self.engine);
        let drill_runner = Arc::clone(&self.drill_runner);
        let catalog = Arc::clone(&self.catalog);
        let config = Arc::clone(&self.config);
        let clock = Arc::clone(&self.clock);
        let sync = self.sync_object_storage.clone();
        let scheduler_id = self.reserve_id();
        let kind = if job == ScheduledJob::Drill {
            JobKind::Drill
        } else {
            JobKind::Backup
        };
        let ticket = self
            .jobs
            .enqueue(JobSpec {
                id,
                kind,
                scope: None,
                idempotency_key: None,
                run: Box::pin(async move {
                    match job {
                        ScheduledJob::Drill => {
                            run_drill(&config, &catalog, &drill_runner, &clock, scheduler_id).await;
                        }
                        ScheduledJob::Full | ScheduledJob::Delta => {
                            let kind = if job == ScheduledJob::Full {
                                BackupKind::Full
                            } else {
                                BackupKind::Delta
                            };
                            run_backup(
                                &config,
                                &catalog,
                                &engine,
                                &clock,
                                scheduler_id,
                                kind,
                                sync,
                            )
                            .await;
                        }
                    }
                }),
            })
            .map_err(|error| error.to_string())?;
        let _ = ticket.done.await;
        Ok(())
    }
}

fn format_instant(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

async fn run_backup(
    config: &Arc<Config>,
    catalog: &Arc<CatalogStore>,
    engine: &Arc<dyn BackupEngine>,
    clock: &Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>,
    id: String,
    kind: BackupKind,
    sync_object_storage: Option<SyncObjectStorage>,
) {
    let started_at = clock();
    let _ = catalog
        .add_run(BackupRun {
            id: id.clone(),
            target: "all".to_owned(),
            kind: kind.as_str().to_owned(),
            engine: config.engine_mode.clone(),
            status: "QUEUED".to_owned(),
            started_at: format_instant(started_at),
            completed_at: None,
            duration_ms: None,
            size_bytes: None,
            start_lsn: None,
            end_lsn: None,
            storage_targets: Vec::new(),
            error_message: None,
        })
        .await;
    let _ = catalog
        .update_run(
            &id,
            RunPatch {
                status: Some("RUNNING".to_owned()),
                ..RunPatch::default()
            },
        )
        .await;
    match engine.trigger_backup(BackupTarget::All, kind).await {
        Ok(mut result) => {
            if let Some(sync) = sync_object_storage {
                let extra = sync().await;
                result.storage_targets.extend(extra);
            }
            let completed = clock();
            let _ =
                catalog
                    .update_run(
                        &id,
                        RunPatch {
                            status: Some("PASSED".to_owned()),
                            completed_at: Some(format_instant(completed)),
                            duration_ms: Some(
                                (completed - started_at).num_milliseconds().max(0) as u64
                            ),
                            size_bytes: result.size_bytes,
                            start_lsn: result.start_lsn,
                            end_lsn: result.end_lsn,
                            storage_targets: Some(result.storage_targets),
                            error_message: None,
                        },
                    )
                    .await;
            if kind == BackupKind::Full {
                if let Err(error) = engine
                    .prune(BackupTarget::All, Some(BackupKind::Full))
                    .await
                {
                    tracing::warn!(
                        error = %redact_text(&error.to_string(), &config.secret_values()),
                        "pruning after a full backup failed"
                    );
                }
            }
        }
        Err(error) => {
            let completed = clock();
            let _ =
                catalog
                    .update_run(
                        &id,
                        RunPatch {
                            status: Some("FAILED".to_owned()),
                            completed_at: Some(format_instant(completed)),
                            duration_ms: Some(
                                (completed - started_at).num_milliseconds().max(0) as u64
                            ),
                            storage_targets: Some(Vec::new()),
                            error_message: Some(
                                redact_text(&error.to_string(), &config.secret_values())
                                    .chars()
                                    .take(2000)
                                    .collect(),
                            ),
                            ..RunPatch::default()
                        },
                    )
                    .await;
        }
    }
}

async fn run_drill(
    config: &Arc<Config>,
    catalog: &Arc<CatalogStore>,
    drill_runner: &Arc<dyn DrillRunner>,
    clock: &Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>,
    id: String,
) {
    let started_at_date = clock();
    let started_at = format_instant(started_at_date);
    match drill_runner
        .run(DrillRunOptions {
            id: Some(id.clone()),
            requested_by: Some("scheduler".to_owned()),
            target_time: None,
            latest: false,
        })
        .await
    {
        Ok(report) => {
            let _ = catalog.add_drill(report).await;
        }
        Err(error) => {
            let completed = clock();
            let target_time = format_instant(started_at_date - chrono::Duration::minutes(5));
            let mut failed = DrillReport::failed(
                &id,
                &started_at,
                &format_instant(completed),
                (completed - started_at_date).num_milliseconds().max(0) as u64,
                &target_time,
                &redact_text(&error, &config.secret_values())
                    .chars()
                    .take(2000)
                    .collect::<String>(),
            );
            failed.report_signature = sign_drill_report(&failed, &config.encryption_key_hex).ok();
            let _ = catalog.add_drill(failed).await;
        }
    }
}

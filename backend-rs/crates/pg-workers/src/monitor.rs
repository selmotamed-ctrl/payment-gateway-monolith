//! Platform monitor (`core-back/engine/workers/PlatformMonitorWorker.ts`).
//!
//! Every check turns a condition into ONE keyed operator case (`platform.<check>[:<key>]`). A
//! condition opens a case when it first trips and records its clearing when it stops, so a repeated
//! tick never opens a second case. The state is held in memory and rehydrated from the case sink
//! after a restart or a leader change.
//!
//! Checks are injected through [`PlatformMonitorCheck`], the escalation sink through
//! [`MonitorCaseSink`] (the default is the `MANUAL_REVIEW` case sink on the main pool). External
//! probes (certificates, backup daemon, Redis, communication settings, object storage) are traits in
//! [`crate::monitor_checks`], so no check performs I/O it cannot be tested without.

#![forbid(unsafe_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, NaiveDateTime, Utc};
use sqlx::PgPool;
use tracing::{info, warn};
use uuid::Uuid;

use crate::cases::{
    annotate_open_case, clear_keyed_case, platform_subject_key, raise_keyed_case,
    write_system_audit, CaseKind, KeyedCaseInput, MonitorPriority, SystemAudit,
};
use crate::db::{now_tz, now_utc};
use crate::health::WorkerSnapshot;
use crate::runtime::{Worker, WorkerContext, WorkerError, WorkerOutcome};

pub use crate::cases::PLATFORM_SUBJECT_PREFIX;

/// The reserved id of the monitor's own blind-spot check.
pub const MONITOR_CHECK_FAILED_ID: &str = "monitor_check_failed";

const CLEARED_MARKER: &str = "[CLEARED ";
const RETRIPPED_MARKER: &str = "[RETRIPPED ";
const MAX_NOTES_LENGTH: usize = 8_000;
const MAX_SUMMARY_KEYS: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MonitorFinding {
    /// Distinguishes several findings of one check (a shard, a file, a worker).
    pub key: Option<String>,
    pub title: String,
    pub detail: String,
    pub priority: MonitorPriority,
}

impl MonitorFinding {
    #[must_use]
    pub fn new(title: &str, detail: &str, priority: MonitorPriority) -> Self {
        Self {
            key: None,
            title: title.to_owned(),
            detail: detail.to_owned(),
            priority,
        }
    }

    #[must_use]
    pub fn keyed(key: &str, title: &str, detail: &str, priority: MonitorPriority) -> Self {
        Self {
            key: Some(key.to_owned()),
            title: title.to_owned(),
            detail: detail.to_owned(),
            priority,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MonitorCheckResult {
    pub findings: Vec<MonitorFinding>,
    /// False when the check could not see every subject; previously tripped keys are kept.
    pub complete: bool,
}

impl MonitorCheckResult {
    #[must_use]
    pub fn complete(findings: Vec<MonitorFinding>) -> Self {
        Self {
            findings,
            complete: true,
        }
    }

    #[must_use]
    pub fn partial(findings: Vec<MonitorFinding>) -> Self {
        Self {
            findings,
            complete: false,
        }
    }

    #[must_use]
    pub fn empty() -> Self {
        Self {
            findings: Vec::new(),
            complete: true,
        }
    }
}

impl From<Vec<MonitorFinding>> for MonitorCheckResult {
    fn from(findings: Vec<MonitorFinding>) -> Self {
        Self::complete(findings)
    }
}

/// What a check may read. The registry is the in-process worker health; the pool is the main
/// database. A check that needs anything else takes it through its own trait.
pub struct MonitorContext<'a> {
    pub now: DateTime<Utc>,
    pub registry: WorkerSnapshot,
    pub pool: &'a PgPool,
}

#[async_trait]
pub trait PlatformMonitorCheck: Send + Sync {
    fn id(&self) -> &'static str;
    async fn run(&self, ctx: &MonitorContext<'_>) -> Result<MonitorCheckResult, WorkerError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MonitorCaseRaise {
    pub subject_key: String,
    pub title: String,
    pub detail: String,
    pub priority: MonitorPriority,
    pub now: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MonitorCaseClear {
    pub subject_key: String,
    pub detail: String,
    pub now: DateTime<Utc>,
}

/// Where the monitor raises and clears its keyed escalations.
#[async_trait]
pub trait MonitorCaseSink: Send + Sync {
    /// Opens a case unless an unresolved one exists. Returns whether it created the case.
    async fn raise(&self, input: &MonitorCaseRaise) -> Result<bool, WorkerError>;
    /// Records that the condition behind `subject_key` cleared.
    async fn clear(&self, input: &MonitorCaseClear) -> Result<(), WorkerError>;
    /// Keys under `prefix` whose case is unresolved and not marked cleared.
    async fn list_active_keys(&self, _prefix: &str) -> Result<Vec<String>, WorkerError> {
        Ok(Vec::new())
    }
}

#[derive(Debug, Clone)]
pub struct MonitorSinkConfig {
    pub kind: CaseKind,
    pub sla_hours: BTreeMap<MonitorPriority, i64>,
}

impl Default for MonitorSinkConfig {
    fn default() -> Self {
        let mut sla_hours = BTreeMap::new();
        sla_hours.insert(MonitorPriority::P1, 4);
        sla_hours.insert(MonitorPriority::P2, 24);
        sla_hours.insert(MonitorPriority::P3, 72);
        Self {
            kind: CaseKind::ManualReview,
            sla_hours,
        }
    }
}

/// The default sink: `PrismaMonitorCaseSink` (`PlatformMonitorWorker.ts:123-227`).
pub struct PgMonitorCaseSink {
    pool: PgPool,
    config: MonitorSinkConfig,
}

impl PgMonitorCaseSink {
    #[must_use]
    pub fn new(pool: PgPool, config: MonitorSinkConfig) -> Self {
        Self { pool, config }
    }
}

fn is_cleared_notes(notes: Option<&str>) -> bool {
    let Some(notes) = notes else {
        return false;
    };
    let cleared = notes.rfind(CLEARED_MARKER);
    let retripped = notes.rfind(RETRIPPED_MARKER);
    match (cleared, retripped) {
        (None, _) => false,
        (Some(cleared), None) => cleared > 0 || notes.starts_with(CLEARED_MARKER),
        (Some(cleared), Some(retripped)) => cleared > retripped,
    }
}

fn append_note(notes: Option<&str>, line: &str) -> String {
    let next = match notes {
        Some(notes) if !notes.is_empty() => format!("{notes}\n{line}"),
        _ => line.to_owned(),
    };
    if next.chars().count() <= MAX_NOTES_LENGTH {
        return next;
    }
    let head: String = next.chars().take(2_000).collect();
    let tail_len = MAX_NOTES_LENGTH - 2_010;
    let collected: Vec<char> = next.chars().collect();
    let tail: String = collected
        .iter()
        .skip(collected.len().saturating_sub(tail_len))
        .collect();
    format!("{head}\n...\n{tail}")
}

fn iso(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[async_trait]
impl MonitorCaseSink for PgMonitorCaseSink {
    async fn raise(&self, input: &MonitorCaseRaise) -> Result<bool, WorkerError> {
        let mut tx = self.pool.begin().await.map_err(sink_error)?;
        let open: Option<(Uuid, Option<String>)> = sqlx::query_as(
            "SELECT id, resolution_notes FROM operator_cases
              WHERE kind = $1::\"OperatorCaseKind\" AND subject_key = $2 AND state <> 'RESOLVED'
              LIMIT 1",
        )
        .bind(self.config.kind.as_str())
        .bind(&input.subject_key)
        .fetch_optional(&mut *tx)
        .await
        .map_err(sink_error)?;
        if let Some((id, notes)) = open {
            if is_cleared_notes(notes.as_deref()) {
                let line = format!(
                    "{RETRIPPED_MARKER}{}] {}: {}",
                    iso(input.now),
                    input.title,
                    input.detail
                );
                let merged = append_note(notes.as_deref(), &line);
                sqlx::query("UPDATE operator_cases SET resolution_notes = $2, updated_at = $3 WHERE id = $1")
                    .bind(id)
                    .bind(&merged)
                    .bind(input.now.naive_utc())
                    .execute(&mut *tx)
                    .await
                    .map_err(sink_error)?;
                let audit = SystemAudit::new(
                    "PLATFORM_MONITOR_RETRIPPED",
                    "OPERATOR_CASE",
                    &id.to_string(),
                    serde_json::json!({}),
                    serde_json::json!({
                        "subjectKey": input.subject_key,
                        "priority": input.priority.as_str(),
                        "detail": input.detail,
                    }),
                );
                write_system_audit(&mut tx, &audit).await?;
            }
            tx.commit().await.map_err(sink_error)?;
            return Ok(false);
        }
        let sla_hours = self
            .config
            .sla_hours
            .get(&input.priority)
            .copied()
            .unwrap_or_else(|| input.priority.default_sla_hours());
        let keyed = KeyedCaseInput {
            kind: self.config.kind,
            priority: input.priority,
            subject_key: &input.subject_key,
            attempt_id: None,
            reconciliation_item_id: None,
            notes: &input.detail,
            sla_hours,
            now: input.now.naive_utc(),
            dedupe_on_attempt: false,
            title: Some(&input.title),
        };
        let result = raise_keyed_case(&mut tx, &keyed).await?;
        if result.created {
            let audit = SystemAudit::new(
                "PLATFORM_MONITOR_CASE_RAISED",
                "OPERATOR_CASE",
                &result.id.map(|id| id.to_string()).unwrap_or_default(),
                serde_json::json!({}),
                serde_json::json!({
                    "subjectKey": input.subject_key,
                    "priority": input.priority.as_str(),
                    "detail": input.detail,
                }),
            );
            write_system_audit(&mut tx, &audit).await?;
        }
        tx.commit().await.map_err(sink_error)?;
        Ok(result.created)
    }

    async fn clear(&self, input: &MonitorCaseClear) -> Result<(), WorkerError> {
        let mut tx = self.pool.begin().await.map_err(sink_error)?;
        let open: Option<Uuid> = sqlx::query_scalar(
            "SELECT id FROM operator_cases
              WHERE kind = $1::\"OperatorCaseKind\" AND subject_key = $2 AND state <> 'RESOLVED'
              LIMIT 1",
        )
        .bind(self.config.kind.as_str())
        .bind(&input.subject_key)
        .fetch_optional(&mut *tx)
        .await
        .map_err(sink_error)?;
        let Some(id) = open else {
            tx.rollback().await.map_err(sink_error)?;
            return Ok(());
        };
        let cleared = clear_keyed_case(
            &mut tx,
            self.config.kind,
            &input.subject_key,
            &input.detail,
            input.now.naive_utc(),
        )
        .await?;
        if cleared {
            let audit = SystemAudit::new(
                "PLATFORM_MONITOR_CLEARED",
                "OPERATOR_CASE",
                &id.to_string(),
                serde_json::json!({}),
                serde_json::json!({
                    "subjectKey": input.subject_key,
                    "detail": input.detail,
                }),
            );
            write_system_audit(&mut tx, &audit).await?;
        }
        tx.commit().await.map_err(sink_error)?;
        Ok(())
    }

    async fn list_active_keys(&self, prefix: &str) -> Result<Vec<String>, WorkerError> {
        let rows: Vec<(Option<String>, Option<String>)> = sqlx::query_as(
            "SELECT subject_key, resolution_notes FROM operator_cases
              WHERE kind = $1::\"OperatorCaseKind\" AND subject_key LIKE $2 AND state <> 'RESOLVED'
              LIMIT 1000",
        )
        .bind(self.config.kind.as_str())
        .bind(format!("{prefix}%"))
        .fetch_all(&self.pool)
        .await
        .map_err(sink_error)?;
        Ok(rows
            .into_iter()
            .filter_map(|(key, notes)| key.filter(|_key| !is_cleared_notes(notes.as_deref())))
            .collect())
    }
}

fn sink_error(error: sqlx::Error) -> WorkerError {
    WorkerError::Failed(format!("platform monitor sink: {error}"))
}

#[derive(Debug, Clone)]
pub struct MonitorConfig {
    pub interval_ms: u64,
    pub check_timeout_ms: u64,
    pub check_failure_threshold: u32,
}

impl Default for MonitorConfig {
    fn default() -> Self {
        Self {
            interval_ms: 60_000,
            check_timeout_ms: 15_000,
            check_failure_threshold: 3,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MonitorTickSummary {
    pub raised: Vec<String>,
    pub cleared: Vec<String>,
    pub failed_checks: Vec<String>,
    /// `raised + cleared`, bounded to the first [`MAX_SUMMARY_KEYS`] entries for the health view.
    pub processed: usize,
    pub backlog: usize,
}

#[derive(Debug, Clone, Default)]
struct CheckFailure {
    count: u32,
    last_error: String,
}

#[derive(Debug, Default)]
struct MonitorState {
    /// subjectKey -> owning check id, for every condition currently tripped.
    active: BTreeMap<String, String>,
    check_failures: BTreeMap<String, CheckFailure>,
    hydrated: bool,
    last_summary: Option<MonitorTickSummary>,
}

pub struct PlatformMonitorWorker {
    pool: PgPool,
    checks: Vec<Arc<dyn PlatformMonitorCheck>>,
    sink: Arc<dyn MonitorCaseSink>,
    registry: WorkerSnapshot,
    config: MonitorConfig,
    state: parking_lot::Mutex<MonitorState>,
}

impl PlatformMonitorWorker {
    pub fn new(
        pool: PgPool,
        checks: Vec<Arc<dyn PlatformMonitorCheck>>,
        sink: Arc<dyn MonitorCaseSink>,
        registry: WorkerSnapshot,
        config: MonitorConfig,
    ) -> Result<Self, WorkerError> {
        let mut ids = BTreeSet::new();
        for check in &checks {
            let id = check.id();
            let valid = !id.is_empty()
                && id.len() <= 48
                && id.chars().all(|character| {
                    character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_'
                });
            if !valid {
                return Err(WorkerError::Failed(format!(
                    "PlatformMonitorWorker: invalid check id '{id}'"
                )));
            }
            if id == MONITOR_CHECK_FAILED_ID || !ids.insert(id.to_owned()) {
                return Err(WorkerError::Failed(format!(
                    "PlatformMonitorWorker: duplicate or reserved check id '{id}'"
                )));
            }
        }
        Ok(Self {
            pool,
            checks,
            sink,
            registry,
            config,
            state: parking_lot::Mutex::new(MonitorState::default()),
        })
    }

    /// The keys currently tripped (test/diagnostic view).
    #[must_use]
    pub fn active_keys(&self) -> Vec<String> {
        self.state.lock().active.keys().cloned().collect()
    }

    #[must_use]
    pub fn last_summary(&self) -> Option<MonitorTickSummary> {
        self.state.lock().last_summary.clone()
    }

    fn owner_of(&self, subject_key: &str) -> Option<String> {
        let rest = subject_key.strip_prefix(PLATFORM_SUBJECT_PREFIX)?;
        let id = rest.split(':').next().unwrap_or_default();
        if id == MONITOR_CHECK_FAILED_ID {
            return Some(id.to_owned());
        }
        self.checks
            .iter()
            .find(|check| check.id() == id)
            .map(|check| check.id().to_owned())
    }

    async fn hydrate(&self) -> Result<(), WorkerError> {
        if self.state.lock().hydrated {
            return Ok(());
        }
        let keys = self.sink.list_active_keys(PLATFORM_SUBJECT_PREFIX).await?;
        let mut state = self.state.lock();
        for key in keys {
            if let Some(owner) = self.owner_of(&key) {
                state.active.insert(key, owner);
            }
        }
        state.hydrated = true;
        Ok(())
    }

    pub async fn tick_once(&self) -> Result<MonitorTickSummary, WorkerError> {
        let now = now_tz();
        let mut summary = MonitorTickSummary::default();
        self.hydrate().await?;
        let mut failed_findings: Vec<MonitorFinding> = Vec::new();
        for check in &self.checks {
            let context = MonitorContext {
                now,
                registry: self.registry.clone(),
                pool: &self.pool,
            };
            let timeout = Duration::from_millis(self.config.check_timeout_ms.max(1));
            let outcome = tokio::time::timeout(timeout, check.run(&context)).await;
            let result = match outcome {
                Ok(Ok(result)) => result,
                Ok(Err(error)) => {
                    let message = error.to_string();
                    self.record_check_failure(check.id(), &message, &mut summary);
                    continue;
                }
                Err(_) => {
                    self.record_check_failure(
                        check.id(),
                        &format!("check timed out after {} ms", self.config.check_timeout_ms),
                        &mut summary,
                    );
                    continue;
                }
            };
            self.state
                .lock()
                .check_failures
                .insert(check.id().to_owned(), CheckFailure::default());
            self.apply(check.id(), &result, now.naive_utc(), &mut summary)
                .await?;
        }
        for (check_id, failure) in self.state.lock().check_failures.clone() {
            if failure.count >= self.config.check_failure_threshold.max(1) {
                failed_findings.push(MonitorFinding::keyed(
                    &check_id,
                    "Platform monitor check failing",
                    &format!(
                        "Check '{check_id}' failed {} times in a row: {}",
                        failure.count, failure.last_error
                    ),
                    MonitorPriority::P2,
                ));
            }
        }
        let blind_spot = MonitorCheckResult::complete(failed_findings);
        self.apply(
            MONITOR_CHECK_FAILED_ID,
            &blind_spot,
            now.naive_utc(),
            &mut summary,
        )
        .await?;
        summary.processed = summary.raised.len() + summary.cleared.len();
        summary.backlog = self.state.lock().active.len();
        summary.raised.truncate(MAX_SUMMARY_KEYS);
        summary.cleared.truncate(MAX_SUMMARY_KEYS);
        summary.failed_checks.truncate(MAX_SUMMARY_KEYS);
        self.state.lock().last_summary = Some(summary.clone());
        Ok(summary)
    }

    fn record_check_failure(
        &self,
        check_id: &str,
        message: &str,
        summary: &mut MonitorTickSummary,
    ) {
        let failures = {
            let mut state = self.state.lock();
            let entry = state.check_failures.entry(check_id.to_owned()).or_default();
            entry.count = entry.count.saturating_add(1);
            entry.last_error = message.chars().take(300).collect();
            entry.count
        };
        summary.failed_checks.push(check_id.to_owned());
        warn!(
            check = check_id,
            failures,
            error = %message,
            "platform monitor: check failed"
        );
    }

    async fn apply(
        &self,
        check_id: &str,
        result: &MonitorCheckResult,
        now: NaiveDateTime,
        summary: &mut MonitorTickSummary,
    ) -> Result<(), WorkerError> {
        let mut seen = BTreeSet::new();
        for finding in &result.findings {
            let subject_key = platform_subject_key(check_id, finding.key.as_deref());
            if !seen.insert(subject_key.clone()) {
                continue;
            }
            if self.state.lock().active.contains_key(&subject_key) {
                continue;
            }
            let created = self
                .sink
                .raise(&MonitorCaseRaise {
                    subject_key: subject_key.clone(),
                    title: finding.title.clone(),
                    detail: finding.detail.clone(),
                    priority: finding.priority,
                    now: now.and_utc(),
                })
                .await?;
            self.state
                .lock()
                .active
                .insert(subject_key.clone(), check_id.to_owned());
            summary.raised.push(subject_key.clone());
            warn!(
                %subject_key,
                created,
                title = %finding.title,
                "platform monitor: condition tripped"
            );
        }
        if !result.complete {
            return Ok(());
        }
        let owned: Vec<String> = {
            let state = self.state.lock();
            state
                .active
                .iter()
                .filter(|(key, owner)| owner.as_str() == check_id && !seen.contains(*key))
                .map(|(key, _)| key.clone())
                .collect()
        };
        for subject_key in owned {
            self.sink
                .clear(&MonitorCaseClear {
                    subject_key: subject_key.clone(),
                    detail: "Condition no longer observed by the platform monitor".to_owned(),
                    now: now.and_utc(),
                })
                .await?;
            self.state.lock().active.remove(&subject_key);
            summary.cleared.push(subject_key.clone());
            info!(%subject_key, "platform monitor: condition cleared");
        }
        Ok(())
    }
}

#[async_trait]
impl Worker for PlatformMonitorWorker {
    fn name(&self) -> &'static str {
        "PlatformMonitor"
    }

    fn interval(&self) -> Duration {
        Duration::from_millis(self.config.interval_ms.max(1))
    }

    fn singleton(&self) -> bool {
        true
    }

    async fn tick(&self, ctx: &WorkerContext) -> Result<WorkerOutcome, WorkerError> {
        if ctx.shutting_down() {
            return Ok(WorkerOutcome::Deferred);
        }
        let summary = self.tick_once().await?;
        Ok(WorkerOutcome::Processed(summary.processed as u64))
    }
}

/// Kept for parity with the TS `PrismaMonitorCaseSink` helper: annotate an open case.
pub async fn append_case_note(
    pool: &PgPool,
    subject_key: &str,
    note: &str,
) -> Result<bool, WorkerError> {
    let mut tx = pool.begin().await.map_err(sink_error)?;
    let annotated = annotate_open_case(
        &mut tx,
        CaseKind::ManualReview,
        subject_key,
        note,
        now_utc(),
    )
    .await?;
    tx.commit().await.map_err(sink_error)?;
    Ok(annotated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    #[derive(Default)]
    struct FakeSink {
        raised: parking_lot::Mutex<BTreeMap<String, (String, MonitorPriority)>>,
        cleared: parking_lot::Mutex<Vec<String>>,
        calls: AtomicU64,
    }

    #[async_trait]
    impl MonitorCaseSink for FakeSink {
        async fn raise(&self, input: &MonitorCaseRaise) -> Result<bool, WorkerError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let mut raised = self.raised.lock();
            if raised.contains_key(&input.subject_key) {
                return Ok(false);
            }
            raised.insert(
                input.subject_key.clone(),
                (input.title.clone(), input.priority),
            );
            Ok(true)
        }

        async fn clear(&self, input: &MonitorCaseClear) -> Result<(), WorkerError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.raised.lock().remove(&input.subject_key);
            self.cleared.lock().push(input.subject_key.clone());
            Ok(())
        }

        async fn list_active_keys(&self, prefix: &str) -> Result<Vec<String>, WorkerError> {
            Ok(self
                .raised
                .lock()
                .keys()
                .filter(|key| key.starts_with(prefix))
                .cloned()
                .collect())
        }
    }

    struct FixedCheck {
        id: &'static str,
        result: parking_lot::Mutex<MonitorCheckResult>,
        fail: bool,
    }

    #[async_trait]
    impl PlatformMonitorCheck for FixedCheck {
        fn id(&self) -> &'static str {
            self.id
        }
        async fn run(&self, _ctx: &MonitorContext<'_>) -> Result<MonitorCheckResult, WorkerError> {
            if self.fail {
                return Err(WorkerError::Failed("probe unavailable".to_owned()));
            }
            Ok(self.result.lock().clone())
        }
    }

    struct Harness {
        worker: PlatformMonitorWorker,
        sink: Arc<FakeSink>,
        check: Arc<FixedCheck>,
    }

    fn harness(check: FixedCheck, config: MonitorConfig) -> Harness {
        let sink = Arc::new(FakeSink::default());
        let check = Arc::new(check);
        let worker = PlatformMonitorWorker::new(
            PgPool::connect_lazy("postgres://unused/unused").expect("lazy pool"),
            vec![check.clone()],
            sink.clone(),
            WorkerSnapshot::new(),
            config,
        )
        .expect("worker");
        Harness {
            worker,
            sink,
            check,
        }
    }

    fn finding(key: &str, priority: MonitorPriority) -> MonitorFinding {
        MonitorFinding::keyed(key, "Condition", "Something is wrong", priority)
    }

    #[tokio::test]
    async fn raises_once_clears_and_re_raises() {
        let check = FixedCheck {
            id: "probe",
            result: parking_lot::Mutex::new(MonitorCheckResult::complete(vec![finding(
                "a",
                MonitorPriority::P1,
            )])),
            fail: false,
        };
        let harness = harness(
            check,
            MonitorConfig {
                check_timeout_ms: 1_000,
                ..MonitorConfig::default()
            },
        );
        let first = harness.worker.tick_once().await.expect("tick");
        assert_eq!(first.raised, vec!["platform.probe:a".to_owned()]);
        assert_eq!(harness.worker.active_keys(), vec!["platform.probe:a"]);
        let second = harness.worker.tick_once().await.expect("tick");
        assert!(second.raised.is_empty());
        assert_eq!(harness.sink.raised.lock().len(), 1);

        harness
            .check
            .result
            .lock()
            .clone_from(&MonitorCheckResult::complete(Vec::new()));
        let third = harness.worker.tick_once().await.expect("tick");
        assert_eq!(third.cleared, vec!["platform.probe:a".to_owned()]);
        assert!(harness.worker.active_keys().is_empty());

        *harness.check.result.lock() =
            MonitorCheckResult::complete(vec![finding("a", MonitorPriority::P1)]);
        let fourth = harness.worker.tick_once().await.expect("tick");
        assert_eq!(fourth.raised, vec!["platform.probe:a".to_owned()]);
    }

    #[tokio::test]
    async fn an_incomplete_result_never_clears() {
        let check = FixedCheck {
            id: "probe",
            result: parking_lot::Mutex::new(MonitorCheckResult::complete(vec![finding(
                "a",
                MonitorPriority::P2,
            )])),
            fail: false,
        };
        let harness = harness(check, MonitorConfig::default());
        harness.worker.tick_once().await.expect("tick");
        *harness.check.result.lock() = MonitorCheckResult::partial(Vec::new());
        let second = harness.worker.tick_once().await.expect("tick");
        assert!(second.cleared.is_empty());
        assert_eq!(harness.worker.active_keys(), vec!["platform.probe:a"]);
    }

    #[tokio::test]
    async fn a_failing_check_trips_the_blind_spot_case_after_the_threshold() {
        let check = FixedCheck {
            id: "probe",
            result: parking_lot::Mutex::new(MonitorCheckResult::empty()),
            fail: true,
        };
        let harness = harness(
            check,
            MonitorConfig {
                check_failure_threshold: 2,
                ..MonitorConfig::default()
            },
        );
        let first = harness.worker.tick_once().await.expect("tick");
        assert_eq!(first.failed_checks, vec!["probe".to_owned()]);
        assert!(harness.worker.active_keys().is_empty());
        let second = harness.worker.tick_once().await.expect("tick");
        assert!(second
            .raised
            .contains(&"platform.monitor_check_failed:probe".to_owned()));
        assert_eq!(
            harness.sink.raised.lock()["platform.monitor_check_failed:probe"].1,
            MonitorPriority::P2
        );
    }

    #[tokio::test]
    async fn hydrate_restores_active_keys_for_configured_checks_only() {
        let sink = Arc::new(FakeSink::default());
        sink.raised.lock().insert(
            "platform.probe:a".to_owned(),
            ("Condition".to_owned(), MonitorPriority::P1),
        );
        sink.raised.lock().insert(
            "platform.retired:x".to_owned(),
            ("Old".to_owned(), MonitorPriority::P2),
        );
        let check = Arc::new(FixedCheck {
            id: "probe",
            result: parking_lot::Mutex::new(MonitorCheckResult::complete(vec![finding(
                "a",
                MonitorPriority::P1,
            )])),
            fail: false,
        });
        let worker = PlatformMonitorWorker::new(
            PgPool::connect_lazy("postgres://unused/unused").expect("lazy pool"),
            vec![check],
            sink,
            WorkerSnapshot::new(),
            MonitorConfig::default(),
        )
        .expect("worker");
        let summary = worker.tick_once().await.expect("tick");
        assert!(summary.raised.is_empty(), "hydrated key must not re-raise");
        assert_eq!(worker.active_keys(), vec!["platform.probe:a"]);
    }

    #[tokio::test]
    async fn invalid_and_duplicate_check_ids_are_refused() {
        let pool = PgPool::connect_lazy("postgres://unused/unused").expect("lazy pool");
        let sink = Arc::new(FakeSink::default());
        let bad = PlatformMonitorWorker::new(
            pool.clone(),
            vec![Arc::new(FixedCheck {
                id: "Not-Valid",
                result: parking_lot::Mutex::new(MonitorCheckResult::empty()),
                fail: false,
            })],
            sink.clone(),
            WorkerSnapshot::new(),
            MonitorConfig::default(),
        );
        assert!(bad.is_err());
        let reserved = PlatformMonitorWorker::new(
            pool.clone(),
            vec![Arc::new(FixedCheck {
                id: MONITOR_CHECK_FAILED_ID,
                result: parking_lot::Mutex::new(MonitorCheckResult::empty()),
                fail: false,
            })],
            sink.clone(),
            WorkerSnapshot::new(),
            MonitorConfig::default(),
        );
        assert!(reserved.is_err());
        let duplicate = PlatformMonitorWorker::new(
            pool,
            vec![
                Arc::new(FixedCheck {
                    id: "same",
                    result: parking_lot::Mutex::new(MonitorCheckResult::empty()),
                    fail: false,
                }),
                Arc::new(FixedCheck {
                    id: "same",
                    result: parking_lot::Mutex::new(MonitorCheckResult::empty()),
                    fail: false,
                }),
            ],
            sink,
            WorkerSnapshot::new(),
            MonitorConfig::default(),
        );
        assert!(duplicate.is_err());
    }

    #[test]
    fn cleared_notes_detection_matches_the_marker_rules() {
        assert!(!is_cleared_notes(None));
        assert!(!is_cleared_notes(Some("something")));
        assert!(is_cleared_notes(Some("[CLEARED 2026-11-28T10:00:00Z] ok")));
        assert!(!is_cleared_notes(Some(
            "[CLEARED 2026-11-28T10:00:00Z] ok\n[RETRIPPED 2026-11-28T11:00:00Z] again"
        )));
        assert!(is_cleared_notes(Some(
            "[RETRIPPED 2026-11-28T11:00:00Z] again\n[CLEARED 2026-11-28T12:00:00Z] ok"
        )));
        assert!(!is_cleared_notes(Some(
            "prefix [CLEARED 2026] tail [RETRIPPED 2026]"
        )));
    }

    #[test]
    fn notes_are_bounded_keeping_the_head_and_the_timeline() {
        let long = "x".repeat(9_000);
        let merged = append_note(Some(&long), "[CLEARED now]");
        assert!(merged.chars().count() <= MAX_NOTES_LENGTH);
        assert!(merged.contains("\n...\n"));
        assert!(merged.ends_with("[CLEARED now]"));
    }

    #[test]
    fn subject_keys_are_namespaced_by_check() {
        assert_eq!(
            platform_subject_key("backup", Some("wal-lag")),
            "platform.backup:wal-lag"
        );
        assert_eq!(platform_subject_key("backup", None), "platform.backup");
    }
}

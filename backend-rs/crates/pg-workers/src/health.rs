//! Worker health snapshots (`/health.workers`).
//!
//! Extended for the platform monitor (`worker_stale` check) with the interval, the start time, the
//! consecutive-failure count and the processed counter. The fields are additive to the TS view
//! (`core-back/engine/workers/workerRuntime.ts` `WorkerHealthView`), which serialises them through
//! serde without renaming anything that existed before.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkerState {
    pub name: String,
    pub running: bool,
    pub leader: bool,
    pub ticks: u64,
    pub failures: u64,
    /// Consecutive failed ticks (reset by a success). Used by the `worker_stale` monitor check.
    pub consecutive_failures: u64,
    /// The worker's configured cadence in milliseconds (0 until the runtime registers it).
    pub interval_ms: u64,
    pub started_at: Option<String>,
    pub last_run_at: Option<String>,
    pub last_success_at: Option<String>,
    pub last_error_at: Option<String>,
    pub last_error: Option<String>,
    pub last_duration_ms: Option<u64>,
    /// Rows the last tick reported as processed.
    pub last_processed: Option<u64>,
    /// Rows processed since the process started.
    pub processed_total: u64,
}

impl WorkerState {
    #[must_use]
    pub fn new(name: &str, singleton: bool) -> Self {
        Self {
            name: name.to_owned(),
            running: false,
            leader: !singleton,
            ticks: 0,
            failures: 0,
            consecutive_failures: 0,
            interval_ms: 0,
            started_at: None,
            last_run_at: None,
            last_success_at: None,
            last_error_at: None,
            last_error: None,
            last_duration_ms: None,
            last_processed: None,
            processed_total: 0,
        }
    }
}

fn iso(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Thread-safe collection of worker snapshots for the health endpoint.
#[derive(Debug, Clone, Default)]
pub struct WorkerSnapshot {
    states: Arc<RwLock<BTreeMap<String, WorkerState>>>,
}

impl WorkerSnapshot {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&self, state: WorkerState) {
        self.states.write().insert(state.name.clone(), state);
    }

    pub fn set_interval(&self, name: &str, interval_ms: u64) {
        if let Some(state) = self.states.write().get_mut(name) {
            state.interval_ms = interval_ms;
        }
    }

    pub fn set_running(&self, name: &str, running: bool) {
        if let Some(state) = self.states.write().get_mut(name) {
            state.running = running;
        }
    }

    pub fn set_leader(&self, name: &str, leader: bool) {
        if let Some(state) = self.states.write().get_mut(name) {
            state.leader = leader;
        }
    }

    pub fn record_start(&self, name: &str, at: DateTime<Utc>) {
        if let Some(state) = self.states.write().get_mut(name) {
            if state.started_at.is_none() {
                state.started_at = Some(iso(at));
            }
            state.last_run_at = Some(iso(at));
        }
    }

    pub fn record_success(&self, name: &str, at: DateTime<Utc>, duration: Duration) {
        self.record_success_with(name, at, duration, None);
    }

    pub fn record_success_with(
        &self,
        name: &str,
        at: DateTime<Utc>,
        duration: Duration,
        processed: Option<u64>,
    ) {
        if let Some(state) = self.states.write().get_mut(name) {
            state.ticks = state.ticks.saturating_add(1);
            state.consecutive_failures = 0;
            state.last_success_at = Some(iso(at));
            state.last_error = None;
            state.last_duration_ms = Some(duration.as_millis() as u64);
            if let Some(processed) = processed {
                state.last_processed = Some(processed);
                state.processed_total = state.processed_total.saturating_add(processed);
            }
        }
    }

    pub fn record_failure(&self, name: &str, error: &str) {
        self.record_failure_at(name, error, Utc::now());
    }

    pub fn record_failure_at(&self, name: &str, error: &str, at: DateTime<Utc>) {
        if let Some(state) = self.states.write().get_mut(name) {
            state.failures = state.failures.saturating_add(1);
            state.consecutive_failures = state.consecutive_failures.saturating_add(1);
            state.last_error_at = Some(iso(at));
            state.last_error = Some(error.to_owned());
        }
    }

    #[must_use]
    pub fn get(&self, name: &str) -> Option<WorkerState> {
        self.states.read().get(name).cloned()
    }

    #[must_use]
    pub fn all(&self) -> Vec<WorkerState> {
        self.states.read().values().cloned().collect()
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.states.read().len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_success_and_failure() {
        let snapshot = WorkerSnapshot::new();
        snapshot.register(WorkerState::new("PollWorker", true));
        snapshot.set_running("PollWorker", true);
        snapshot.record_start("PollWorker", Utc::now());
        snapshot.record_success("PollWorker", Utc::now(), Duration::from_millis(5));
        let state = snapshot.get("PollWorker").expect("registered");
        assert_eq!(state.ticks, 1);
        assert_eq!(state.last_duration_ms, Some(5));
        assert!(state.started_at.is_some());
        snapshot.record_failure("PollWorker", "boom");
        let state = snapshot.get("PollWorker").expect("registered");
        assert_eq!(state.failures, 1);
        assert_eq!(state.consecutive_failures, 1);
        assert!(state.last_error_at.is_some());
        snapshot.record_success_with("PollWorker", Utc::now(), Duration::from_millis(2), Some(7));
        let state = snapshot.get("PollWorker").expect("registered");
        assert_eq!(state.consecutive_failures, 0);
        assert_eq!(state.last_processed, Some(7));
        assert_eq!(state.processed_total, 7);
    }

    #[test]
    fn start_time_is_kept_once() {
        let snapshot = WorkerSnapshot::new();
        snapshot.register(WorkerState::new("A", false));
        let first = Utc::now();
        snapshot.record_start("A", first);
        snapshot.record_start("A", first + chrono::Duration::seconds(30));
        let state = snapshot.get("A").expect("registered");
        assert_eq!(state.started_at, Some(iso(first)));
        assert_ne!(state.last_run_at, state.started_at);
    }
}

//! The in-process worker health registry served under `/health.workers`.
//!
//! P3 owns the shape (chapter 2 §20) but no workers: P6 registers each `pg_workers` worker here
//! when it starts, so `core-rs` never depends on the worker implementations. The JSON field names
//! are the TS ones (`lastTickAt`, `lastDurationMs`, …); the remaining TS fields (`intervalMs`,
//! `processedTotal`, `backlog`, `consecutiveFailures`) are added in P6 together with the runtime
//! that can fill them.

#![forbid(dead_code)]

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// One worker's health view.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkerView {
    pub name: String,
    pub running: bool,
    pub leader: bool,
    pub ticks: u64,
    pub failures: u64,
    pub last_tick_at: Option<String>,
    pub last_success_at: Option<String>,
    pub last_error: Option<String>,
    pub last_duration_ms: Option<u64>,
}

impl WorkerView {
    #[must_use]
    pub fn new(name: &str, running: bool, leader: bool) -> Self {
        Self {
            name: name.to_owned(),
            running,
            leader,
            ticks: 0,
            failures: 0,
            last_tick_at: None,
            last_success_at: None,
            last_error: None,
            last_duration_ms: None,
        }
    }

    /// The TS JSON view (`workerRuntime.ts:WorkerHealthView`).
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "name": self.name,
            "running": self.running,
            "leader": self.leader,
            "ticks": self.ticks,
            "failures": self.failures,
            "lastTickAt": self.last_tick_at,
            "lastSuccessAt": self.last_success_at,
            "lastError": self.last_error,
            "lastDurationMs": self.last_duration_ms,
        })
    }
}

/// Thread-safe collection of worker views.
#[derive(Debug, Clone, Default)]
pub struct WorkerRegistry {
    views: Arc<RwLock<BTreeMap<String, WorkerView>>>,
}

impl WorkerRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&self, view: WorkerView) {
        self.views.write().insert(view.name.clone(), view);
    }

    pub fn set_running(&self, name: &str, running: bool) {
        if let Some(view) = self.views.write().get_mut(name) {
            view.running = running;
        }
    }

    pub fn set_leader(&self, name: &str, leader: bool) {
        if let Some(view) = self.views.write().get_mut(name) {
            view.leader = leader;
        }
    }

    pub fn record_start(&self, name: &str, at: DateTime<Utc>) {
        if let Some(view) = self.views.write().get_mut(name) {
            view.last_tick_at = Some(at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
        }
    }

    pub fn record_success(&self, name: &str, at: DateTime<Utc>, duration: Duration) {
        if let Some(view) = self.views.write().get_mut(name) {
            view.ticks = view.ticks.saturating_add(1);
            view.last_success_at = Some(at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
            view.last_error = None;
            view.last_duration_ms = Some(duration.as_millis() as u64);
        }
    }

    pub fn record_failure(&self, name: &str, error: &str) {
        if let Some(view) = self.views.write().get_mut(name) {
            view.failures = view.failures.saturating_add(1);
            view.last_error = Some(error.chars().take(300).collect());
        }
    }

    #[must_use]
    pub fn all(&self) -> Vec<WorkerView> {
        self.views.read().values().cloned().collect()
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.views.read().len()
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
    fn registry_records_ticks_and_failures() {
        let registry = WorkerRegistry::new();
        registry.register(WorkerView::new("PollWorker", false, true));
        registry.set_running("PollWorker", true);
        registry.record_start("PollWorker", Utc::now());
        registry.record_success("PollWorker", Utc::now(), Duration::from_millis(7));
        registry.record_failure("PollWorker", "boom");
        let view = registry.all().pop().expect("registered");
        assert!(view.running);
        assert_eq!(view.ticks, 1);
        assert_eq!(view.last_duration_ms, Some(7));
        assert_eq!(view.failures, 1);
        assert_eq!(view.last_error.as_deref(), Some("boom"));
        assert_eq!(view.to_json()["lastDurationMs"], json!(7));
    }

    #[test]
    fn error_messages_are_bounded() {
        let registry = WorkerRegistry::new();
        registry.register(WorkerView::new("w", true, false));
        registry.record_failure("w", &"x".repeat(1_000));
        assert_eq!(
            registry.all()[0].last_error.as_deref().map(str::len),
            Some(300)
        );
    }
}

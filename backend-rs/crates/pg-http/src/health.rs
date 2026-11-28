//! Health payloads (chapter 2 §20). Rust adds `impl: "rust"` (additive).

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerHealth {
    pub name: String,
    pub running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_success_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default)]
    pub leader: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueueHealth {
    pub enabled: bool,
    pub queued: u64,
    pub oldest_queued_age_ms: u64,
    pub threshold_ms: u64,
    pub degraded: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl QueueHealth {
    #[must_use]
    pub fn disabled() -> Self {
        Self {
            enabled: false,
            queued: 0,
            oldest_queued_age_ms: 0,
            threshold_ms: 0,
            degraded: false,
            error: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoreHealth {
    pub msg: String,
    pub status: String,
    pub service: String,
    pub release: String,
    pub commit: String,
    pub leader: bool,
    pub queue: QueueHealth,
    pub workers: Vec<WorkerHealth>,
    /// Additive Rust marker.
    pub implementation: String,
}

impl CoreHealth {
    #[must_use]
    pub fn healthy(release: &str, commit: &str, workers: Vec<WorkerHealth>) -> Self {
        Self {
            msg: "OK".to_owned(),
            status: "ok".to_owned(),
            service: "core-back".to_owned(),
            release: release.to_owned(),
            commit: commit.to_owned(),
            leader: false,
            queue: QueueHealth::disabled(),
            workers,
            implementation: "rust".to_owned(),
        }
    }

    /// Re-evaluate `msg`/`status` from worker health, like the TS health builder.
    pub fn refresh_status(&mut self) {
        let degraded = self.queue.degraded
            || self
                .workers
                .iter()
                .any(|worker| worker.running && worker.last_error.is_some());
        self.msg = if degraded { "DEGRADED" } else { "OK" }.to_owned();
        self.status = if degraded { "degraded" } else { "ok" }.to_owned();
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EdgeHealth {
    pub status: String,
    pub service: String,
    pub release: String,
    pub commit: String,
    pub uptime: u64,
    /// Additive Rust marker.
    pub implementation: String,
}

impl EdgeHealth {
    #[must_use]
    pub fn new(service: &str, release: &str, commit: &str, uptime_seconds: u64) -> Self {
        Self {
            status: "ok".to_owned(),
            service: service.to_owned(),
            release: release.to_owned(),
            commit: commit.to_owned(),
            uptime: uptime_seconds,
            implementation: "rust".to_owned(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_error_degrades() {
        let mut health = CoreHealth::healthy(
            "r1",
            "c1",
            vec![WorkerHealth {
                name: "PollWorker".to_owned(),
                running: true,
                last_run_at: None,
                last_success_at: None,
                last_error: Some("boom".to_owned()),
                leader: false,
            }],
        );
        health.refresh_status();
        assert_eq!(health.status, "degraded");
        assert_eq!(health.msg, "DEGRADED");
    }
}

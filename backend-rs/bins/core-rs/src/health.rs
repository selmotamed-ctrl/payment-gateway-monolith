//! `/health` and the channel health payloads.
//!
//! Port of `core-back/index.ts:111-153` (root health) and the three channel handlers
//! (`admin.ts:245`, `merchant.ts:87`, `checkout.ts:42`), chapter 2 §20.
//!
//! Root payload (always 200, even when degraded):
//!
//! ```json
//! {"msg":"OK|DEGRADED","status":"ok|degraded","service":"core-back","release":…,"commit":…,
//!  "leader":{…}|null,"queue":{"enabled","queued","oldestQueuedAgeMs","thresholdMs","degraded",
//!  "error"?},"workers":[…]}
//! ```
//!
//! `implementation:"rust"` is the documented additive Rust marker. `workers` is the
//! `pg_workers::WorkerSnapshot` view; P6 adds the remaining TS fields when the runtime exposes
//! them (interval, processed totals, backlog).

#![forbid(unsafe_code)]

use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::time::timeout;

use crate::config::CoreConfig;
use crate::state::AppState;

/// The queue probe budget (`withTimeout(..., 2_000)` in `storageEngine.health`).
const QUEUE_PROBE_TIMEOUT: Duration = Duration::from_secs(2);

/// The leader-election snapshot (`LeaderElectionStatus`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LeaderStatus {
    pub endpoint: Option<EndpointView>,
    pub held: Vec<String>,
    pub expected: Vec<String>,
    pub backend_pid: Option<i32>,
    pub last_probe_at: Option<String>,
    pub lost_count: u32,
    pub probe_ok: Option<bool>,
}

/// Sanitised endpoint identity (never the URL or credentials).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EndpointView {
    pub host: String,
    pub port: u16,
    pub database: String,
}

/// The durable queue snapshot.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QueueView {
    pub enabled: bool,
    pub queued: u64,
    pub oldest_queued_age_ms: Option<u64>,
    pub threshold_ms: u64,
    pub degraded: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// The `/health` body.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HealthPayload {
    pub msg: String,
    pub status: String,
    pub service: String,
    pub release: Value,
    pub commit: Value,
    pub leader: Option<LeaderStatus>,
    pub queue: QueueView,
    pub workers: Vec<Value>,
    pub implementation: String,
}

impl HealthPayload {
    /// True when the payload reports `degraded`.
    #[must_use]
    pub fn is_degraded(&self) -> bool {
        self.status == "degraded"
    }
}

/// Build the payload of one process at `now`.
pub async fn snapshot(state: &AppState, now: DateTime<Utc>) -> HealthPayload {
    let config: &CoreConfig = &state.config;
    let workers_enabled = config.workers_enabled && config.background_jobs_enabled;
    let threshold_ms = config.queue_threshold_ms;

    let queue = match timeout(
        QUEUE_PROBE_TIMEOUT,
        pg_db::read_background_job_queue(&state.pools.main),
    )
    .await
    {
        Ok(Ok(counts)) => {
            let age = counts.oldest_created_at.map(|oldest| {
                let queued_at = oldest.and_utc();
                u64::try_from((now - queued_at).num_milliseconds().max(0)).unwrap_or(0)
            });
            QueueView {
                enabled: workers_enabled,
                queued: u64::try_from(counts.queued.max(0)).unwrap_or(0),
                oldest_queued_age_ms: age,
                threshold_ms,
                degraded: age.is_some_and(|age| age > threshold_ms),
                error: None,
            }
        }
        Ok(Err(error)) => {
            tracing::warn!(error = %error, "queue health probe failed");
            unavailable_queue(workers_enabled, threshold_ms)
        }
        Err(_) => unavailable_queue(workers_enabled, threshold_ms),
    };

    let leader = state.leader.as_ref().map(|election| {
        let probe = *state.leader_probe.read();
        LeaderStatus {
            endpoint: pg_db::EndpointIdentity::from_spec(state.config.database.leader_or_primary())
                .map(|endpoint| EndpointView {
                    host: endpoint.host,
                    port: endpoint.port,
                    database: endpoint.database,
                }),
            held: election.held(),
            expected: pg_db::EXPECTED_SINGLETON_KEYS
                .iter()
                .map(|key| (*key).to_owned())
                .collect(),
            backend_pid: Some(election.backend_pid()),
            last_probe_at: probe
                .at
                .map(|at| at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
            lost_count: election.lost_count(),
            probe_ok: probe.ok,
        }
    });

    let workers = state
        .workers
        .all()
        .iter()
        .map(crate::workers::WorkerView::to_json)
        .collect();

    let degraded = !workers_enabled || queue.degraded;

    HealthPayload {
        msg: if degraded { "DEGRADED" } else { "OK" }.to_owned(),
        status: if degraded { "degraded" } else { "ok" }.to_owned(),
        service: "core-back".to_owned(),
        release: config.release_or_null(),
        commit: config.commit_or_null(),
        leader,
        queue,
        workers,
        implementation: "rust".to_owned(),
    }
}

fn unavailable_queue(enabled: bool, threshold_ms: u64) -> QueueView {
    QueueView {
        enabled,
        queued: 0,
        oldest_queued_age_ms: None,
        threshold_ms,
        degraded: true,
        error: Some("QUEUE_HEALTH_UNAVAILABLE".to_owned()),
    }
}

/// The channel health body (`{status, channel, release, commit}`).
#[must_use]
pub fn channel_payload(config: &CoreConfig, channel: &str) -> Value {
    json!({
        "status": "ok",
        "channel": channel,
        "release": config.release_or_null(),
        "commit": config.commit_or_null(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unavailable_queue_is_degraded_and_names_the_reason() {
        let queue = unavailable_queue(true, 300_000);
        assert!(queue.degraded);
        assert_eq!(queue.error.as_deref(), Some("QUEUE_HEALTH_UNAVAILABLE"));
        assert_eq!(queue.oldest_queued_age_ms, None);
    }

    #[test]
    fn channel_payload_has_the_ts_shape() {
        let config = CoreConfig::for_tests("postgresql://u@127.0.0.1:5432/app", "0123456789abcdef");
        let payload = channel_payload(&config, "admin");
        assert_eq!(payload["status"], "ok");
        assert_eq!(payload["channel"], "admin");
        assert_eq!(payload["release"], Value::Null);
        assert_eq!(payload["commit"], Value::Null);
    }
}

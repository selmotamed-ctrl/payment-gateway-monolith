//! Post-deploy watch window and auto-rollback decision (chapter 7 §12, D3-T03).
//!
//! `pgctl` does not invent metrics: the caller feeds samples (health, 5xx rate, p95 latency and
//! worker errors). The decision is pure and deterministic for a given `now`:
//!
//! - only samples inside the window count;
//! - a breach with `auto_rollback = true` recommends `Rollback`;
//! - a breach without auto-rollback reports `Continue` with reasons (alert, do not act);
//! - a clean window recommends `Healthy` once it covers the whole window, otherwise `Continue`.

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};

/// Sampling policy, copied from `[deployment.watch]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchPolicy {
    /// Window length in seconds.
    pub window_seconds: u64,
    /// Maximum error rate in basis points.
    pub max_error_bps: u32,
    /// Maximum p95 latency in ms.
    pub max_p95_ms: u32,
    /// Maximum worker errors in the window.
    pub max_worker_errors: u32,
    /// Whether a breach rolls back automatically.
    pub auto_rollback: bool,
}

impl WatchPolicy {
    /// From the TOML watch settings.
    #[must_use]
    pub fn from_settings(watch: &pg_deploy_config::Watch) -> Self {
        Self {
            window_seconds: u64::from(watch.window_minutes) * 60,
            max_error_bps: watch.max_error_bps,
            max_p95_ms: watch.max_p95_ms,
            max_worker_errors: watch.max_worker_errors,
            auto_rollback: watch.auto_rollback,
        }
    }
}

/// One metrics sample.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WatchSample {
    /// Unix seconds.
    pub at_unix: u64,
    /// Requests observed in the interval.
    pub requests: u64,
    /// 5xx/error responses in the interval.
    pub errors: u64,
    /// p95 latency in ms.
    pub p95_ms: u64,
    /// Worker errors in the interval.
    pub worker_errors: u64,
}

/// What the operator (or the automation) should do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum WatchDecision {
    /// Keep watching (window not complete, or a breach without auto-rollback).
    Continue,
    /// The window completed without a breach.
    Healthy,
    /// Roll back the services changed by this deploy.
    Rollback,
}

/// Evaluation output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WatchReport {
    /// Decision.
    pub decision: WatchDecision,
    /// Samples inside the window.
    pub samples: usize,
    /// Requests inside the window.
    pub requests: u64,
    /// Errors inside the window.
    pub errors: u64,
    /// Error rate in basis points.
    pub error_bps: u32,
    /// Highest p95 inside the window.
    pub max_p95_ms: u64,
    /// Sum of worker errors inside the window.
    pub worker_errors: u64,
    /// Why a rollback is recommended (empty when healthy).
    pub reasons: Vec<String>,
    /// True when a threshold was breached.
    pub breached: bool,
}

/// Evaluate the window.
#[must_use]
pub fn evaluate(policy: &WatchPolicy, now_unix: u64, samples: &[WatchSample]) -> WatchReport {
    let window_start = now_unix.saturating_sub(policy.window_seconds);
    let in_window: Vec<&WatchSample> = samples
        .iter()
        .filter(|sample| sample.at_unix >= window_start && sample.at_unix <= now_unix)
        .collect();
    let requests: u64 = in_window.iter().map(|sample| sample.requests).sum();
    let errors: u64 = in_window.iter().map(|sample| sample.errors).sum();
    let max_p95_ms = in_window
        .iter()
        .map(|sample| sample.p95_ms)
        .max()
        .unwrap_or(0);
    let worker_errors: u64 = in_window.iter().map(|sample| sample.worker_errors).sum();
    let error_bps = errors
        .saturating_mul(10_000)
        .checked_div(requests)
        .and_then(|value| u32::try_from(value).ok())
        .unwrap_or(0);

    let mut reasons = Vec::new();
    if error_bps > policy.max_error_bps {
        reasons.push(format!(
            "error rate {error_bps} bps exceeds {} bps",
            policy.max_error_bps
        ));
    }
    if max_p95_ms > u64::from(policy.max_p95_ms) {
        reasons.push(format!(
            "p95 {max_p95_ms} ms exceeds {} ms",
            policy.max_p95_ms
        ));
    }
    if worker_errors > u64::from(policy.max_worker_errors) {
        reasons.push(format!(
            "worker errors {worker_errors} exceed {}",
            policy.max_worker_errors
        ));
    }
    let breached = !reasons.is_empty();
    let decision = if breached && policy.auto_rollback {
        WatchDecision::Rollback
    } else if breached {
        WatchDecision::Continue
    } else {
        let oldest = in_window.iter().map(|sample| sample.at_unix).min();
        let covered = oldest.is_some_and(|oldest| oldest <= window_start.saturating_add(1));
        if covered && !in_window.is_empty() {
            WatchDecision::Healthy
        } else {
            WatchDecision::Continue
        }
    };
    WatchReport {
        decision,
        samples: in_window.len(),
        requests,
        errors,
        error_bps,
        max_p95_ms,
        worker_errors,
        reasons,
        breached,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> WatchPolicy {
        WatchPolicy {
            window_seconds: 600,
            max_error_bps: 500,
            max_p95_ms: 1_500,
            max_worker_errors: 10,
            auto_rollback: true,
        }
    }

    fn sample(at: u64, requests: u64, errors: u64, p95: u64, worker_errors: u64) -> WatchSample {
        WatchSample {
            at_unix: at,
            requests,
            errors,
            p95_ms: p95,
            worker_errors,
        }
    }

    #[test]
    fn an_empty_window_keeps_watching() {
        let report = evaluate(&policy(), 1_000, &[]);
        assert_eq!(report.decision, WatchDecision::Continue);
        assert_eq!(report.samples, 0);
    }

    #[test]
    fn a_complete_clean_window_is_healthy() {
        let samples = vec![
            sample(400, 100, 1, 100, 0),
            sample(700, 100, 0, 120, 1),
            sample(990, 100, 0, 90, 0),
        ];
        let report = evaluate(&policy(), 1_000, &samples);
        assert_eq!(report.decision, WatchDecision::Healthy);
        assert!(!report.breached);
        assert_eq!(report.requests, 300);
        assert_eq!(report.error_bps, 33);
    }

    #[test]
    fn breaches_roll_back_when_enabled() {
        let samples = vec![sample(400, 100, 0, 100, 0), sample(990, 100, 20, 50, 0)];
        let report = evaluate(&policy(), 1_000, &samples);
        assert_eq!(report.decision, WatchDecision::Rollback);
        assert!(report.breached);
        assert!(report
            .reasons
            .iter()
            .any(|reason| reason.contains("error rate")));

        let samples = vec![sample(990, 100, 0, 2_000, 0)];
        assert_eq!(
            evaluate(&policy(), 1_000, &samples).decision,
            WatchDecision::Rollback
        );
        let samples = vec![sample(990, 100, 0, 100, 50)];
        assert_eq!(
            evaluate(&policy(), 1_000, &samples).decision,
            WatchDecision::Rollback
        );
    }

    #[test]
    fn without_auto_rollback_a_breach_only_alerts() {
        let mut policy = policy();
        policy.auto_rollback = false;
        let samples = vec![sample(990, 100, 20, 100, 0)];
        let report = evaluate(&policy, 1_000, &samples);
        assert_eq!(report.decision, WatchDecision::Continue);
        assert!(report.breached);
        assert!(!report.reasons.is_empty());
    }

    #[test]
    fn old_samples_are_ignored() {
        let samples = vec![
            sample(100, 10_000, 10_000, 9_999, 999),
            sample(990, 100, 0, 100, 0),
        ];
        let report = evaluate(&policy(), 1_000, &samples);
        assert_eq!(report.samples, 1);
        assert_eq!(report.requests, 100);
        assert_eq!(
            report.decision,
            WatchDecision::Continue,
            "the window is not covered yet, so it cannot be declared healthy"
        );
    }

    #[test]
    fn settings_map_to_the_policy() {
        let watch = pg_deploy_config::Watch::default();
        let policy = WatchPolicy::from_settings(&watch);
        assert_eq!(policy.window_seconds, 600);
        assert_eq!(policy.max_error_bps, 500);
        assert!(policy.auto_rollback);
    }
}

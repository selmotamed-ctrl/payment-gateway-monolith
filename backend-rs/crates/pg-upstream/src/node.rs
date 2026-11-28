//! Passive per-node health for the edge → core pool.
//!
//! Port of `{admin,merchant,checkout}-back/lib/coreInternalClient.ts:92-102` (`CoreNodeState`),
//! `:417-451` (`eligiblePool`, `markNodeFailure`, `markNodeHealthy`) and the constants at `:15-17`.
//!
//! A node is ejected after `failure_threshold` consecutive transport failures and stays out for
//! `cooldown_ms`. When the cooldown expires and the node has no request in flight, exactly one
//! half-open probe may be sent; any HTTP response marks the node healthy again.

#![forbid(unsafe_code)]

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};

/// `CORE_FAILURE_THRESHOLD` / `CORE_FAILURE_COOLDOWN_MS`.
///
/// Port of `coreInternalClient.ts:15-17`. TS keeps these as constants; the struct exists so tests
/// and future configuration can lower the threshold without touching the state machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HealthPolicy {
    /// Consecutive transport failures required before a node leaves rotation.
    pub failure_threshold: u32,
    /// How long the node stays out before one half-open probe is allowed.
    pub cooldown_ms: u64,
}

impl HealthPolicy {
    /// TS `CORE_FAILURE_THRESHOLD`.
    pub const DEFAULT_FAILURE_THRESHOLD: u32 = 3;
    /// TS `CORE_FAILURE_COOLDOWN_MS`.
    pub const DEFAULT_COOLDOWN_MS: u64 = 5_000;

    #[must_use]
    pub fn new(failure_threshold: u32, cooldown_ms: u64) -> Self {
        Self {
            failure_threshold: failure_threshold.max(1),
            cooldown_ms,
        }
    }
}

impl Default for HealthPolicy {
    fn default() -> Self {
        Self {
            failure_threshold: Self::DEFAULT_FAILURE_THRESHOLD,
            cooldown_ms: Self::DEFAULT_COOLDOWN_MS,
        }
    }
}

/// One configured core URL and its passive health state.
///
/// Port of `CoreNodeState` (`coreInternalClient.ts:92-102`). `ejected_until` replaces the TS
/// `cooldownUntil` and is an absolute millisecond instant from [`crate::pool::now_millis`].
#[derive(Debug)]
pub struct UpstreamNode {
    url: String,
    in_flight: AtomicUsize,
    consecutive_failures: AtomicU32,
    ejected_until: AtomicU64,
    half_open_probe: AtomicBool,
}

impl UpstreamNode {
    #[must_use]
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            in_flight: AtomicUsize::new(0),
            consecutive_failures: AtomicU32::new(0),
            ejected_until: AtomicU64::new(0),
            half_open_probe: AtomicBool::new(false),
        }
    }

    #[must_use]
    pub fn url(&self) -> &str {
        &self.url
    }

    #[must_use]
    pub fn in_flight(&self) -> usize {
        self.in_flight.load(Ordering::SeqCst)
    }

    /// Consecutive transport failures since the last HTTP response.
    #[must_use]
    pub fn consecutive_failures(&self) -> u32 {
        self.consecutive_failures.load(Ordering::SeqCst)
    }

    /// Absolute instant until which the node is ejected (`0` when healthy).
    #[must_use]
    pub fn ejected_until(&self) -> u64 {
        self.ejected_until.load(Ordering::SeqCst)
    }

    /// `healthy` in TS terms: fewer than `failure_threshold` consecutive failures.
    #[must_use]
    pub fn is_healthy(&self, threshold: u32) -> bool {
        self.consecutive_failures.load(Ordering::SeqCst) < threshold.max(1)
    }

    /// A ejected node whose cooldown expired with no request in flight may take one probe.
    #[must_use]
    pub fn half_open_ready(&self, policy: HealthPolicy, now_ms: u64) -> bool {
        self.consecutive_failures.load(Ordering::SeqCst) >= policy.failure_threshold
            && self.in_flight.load(Ordering::SeqCst) == 0
            && !self.half_open_probe.load(Ordering::SeqCst)
            && now_ms >= self.ejected_until.load(Ordering::SeqCst)
    }

    /// Reserve the single half-open slot. Returns `false` when another caller already holds it.
    pub fn try_claim_half_open(&self, policy: HealthPolicy, now_ms: u64) -> bool {
        if !self.half_open_ready(policy, now_ms) {
            return false;
        }
        self.half_open_probe
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    /// Mark the node healthy; called for ANY complete HTTP response, including 5xx.
    ///
    /// Port of `markNodeHealthy` (`coreInternalClient.ts:447-451`).
    pub fn record_healthy(&self) {
        self.consecutive_failures.store(0, Ordering::SeqCst);
        self.ejected_until.store(0, Ordering::SeqCst);
        self.half_open_probe.store(false, Ordering::SeqCst);
    }

    /// Count one transport failure and eject the node when the threshold is reached.
    ///
    /// Port of `markNodeFailure` (`coreInternalClient.ts:438-445`). Returns the new consecutive
    /// failure count.
    pub fn record_failure(&self, policy: HealthPolicy, now_ms: u64) -> u32 {
        let failures = self
            .consecutive_failures
            .fetch_add(1, Ordering::SeqCst)
            .saturating_add(1);
        if failures >= policy.failure_threshold {
            self.ejected_until
                .store(now_ms.saturating_add(policy.cooldown_ms), Ordering::SeqCst);
        }
        failures
    }

    /// Increment the in-flight counter (one accepted attempt).
    pub fn begin_request(&self) -> usize {
        self.in_flight
            .fetch_add(1, Ordering::SeqCst)
            .saturating_add(1)
    }

    /// Decrement the in-flight counter and end a half-open probe.
    ///
    /// A probe that failed stays ejected (`ejected_until` was just extended); a probe that
    /// succeeded already cleared the flag in [`Self::record_healthy`].
    pub fn finish_request(&self) -> usize {
        let mut current = self.in_flight.load(Ordering::SeqCst);
        loop {
            if current == 0 {
                return 0;
            }
            match self.in_flight.compare_exchange_weak(
                current,
                current - 1,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(previous) => {
                    if previous <= 1 {
                        self.half_open_probe.store(false, Ordering::SeqCst);
                    }
                    return previous - 1;
                }
                Err(actual) => current = actual,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_the_ts_constants() {
        let policy = HealthPolicy::default();
        assert_eq!(policy.failure_threshold, 3);
        assert_eq!(policy.cooldown_ms, 5_000);
        assert_eq!(HealthPolicy::new(0, 10).failure_threshold, 1);
    }

    #[test]
    fn third_failure_ejects_for_the_cooldown() {
        let node = UpstreamNode::new("https://core-a");
        let policy = HealthPolicy::default();

        assert_eq!(node.record_failure(policy, 1_000), 1);
        assert!(node.is_healthy(policy.failure_threshold));
        assert_eq!(node.record_failure(policy, 1_000), 2);
        assert!(node.is_healthy(policy.failure_threshold));
        assert_eq!(node.record_failure(policy, 1_000), 3);

        assert!(!node.is_healthy(policy.failure_threshold));
        assert_eq!(node.ejected_until(), 6_000);
        assert!(!node.half_open_ready(policy, 5_999));
        assert!(node.half_open_ready(policy, 6_000));
    }

    #[test]
    fn only_one_half_open_probe_at_a_time_and_only_when_idle() {
        let node = UpstreamNode::new("https://core-a");
        let policy = HealthPolicy::default();
        for _ in 0..3 {
            node.record_failure(policy, 0);
        }
        // A request in flight blocks the probe gate.
        node.begin_request();
        assert!(!node.half_open_ready(policy, 5_000));
        node.finish_request();
        assert!(node.half_open_ready(policy, 5_000));

        assert!(node.try_claim_half_open(policy, 5_000));
        assert!(!node.try_claim_half_open(policy, 5_000));
        // A second request cannot claim a probe while the first is in flight.
        node.begin_request();
        assert!(!node.half_open_ready(policy, 5_000));
        node.finish_request();
        // The claim was released by the end of the request.
        assert!(node.half_open_ready(policy, 5_000));
    }

    #[test]
    fn a_response_restores_health_and_clears_the_probe() {
        let node = UpstreamNode::new("https://core-a");
        let policy = HealthPolicy::default();
        for _ in 0..3 {
            node.record_failure(policy, 0);
        }
        assert!(node.try_claim_half_open(policy, 5_000));
        node.record_healthy();
        assert!(node.is_healthy(policy.failure_threshold));
        assert_eq!(node.consecutive_failures(), 0);
        assert_eq!(node.ejected_until(), 0);
        assert!(!node.half_open_probe.load(Ordering::SeqCst));
    }

    #[test]
    fn in_flight_never_underflows() {
        let node = UpstreamNode::new("https://core-a");
        assert_eq!(node.begin_request(), 1);
        assert_eq!(node.begin_request(), 2);
        assert_eq!(node.finish_request(), 1);
        assert_eq!(node.finish_request(), 0);
        assert_eq!(node.finish_request(), 0);
        assert_eq!(node.in_flight(), 0);
    }
}

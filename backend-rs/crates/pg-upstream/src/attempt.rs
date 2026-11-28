//! The per-call attempt state machine.
//!
//! Port of the `request()` loop in
//! `{admin,merchant,checkout}-back/lib/coreInternalClient.ts:667-712`: select a node, send one
//! attempt, mark the node healthy on **any** HTTP answer, count only transport failures, honour
//! the replay rules and return the last core response when every attempt answered 502/503/504.
//!
//! The executor owns the socket and the response body; this type owns the decisions so they can
//! be tested with a fixed clock and no network. One `next_node` call must be followed by exactly
//! one `record_response` or `record_transport`; dropping the loop releases the in-flight slot.

#![forbid(unsafe_code)]

use crate::error::{PoolError, TransportFailure};
use crate::node::UpstreamNode;
use crate::pool::{has_selectable, Exclusions, UpstreamPool};
use crate::retry::{CoreMethod, RetryOptions, RetryPolicy};

/// What the executor should do with the attempt it just finished.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AttemptDecision {
    /// Return this HTTP response to the caller unchanged (any status, including 5xx).
    Accept,
    /// Try the next node. The executor keeps the buffered response; if no node is selectable it
    /// returns that response (TS `lastResponse`).
    Retry,
    /// Stop: this error is the final answer.
    Fail(PoolError),
}

/// The outcome of a call that ran out of nodes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoopFinish {
    /// Return the last core response (its status; the executor keeps the body).
    Response(u16),
    /// No response was obtained; return this error.
    Error(PoolError),
}

/// One logical edge → core call.
pub struct AttemptLoop<'a> {
    pool: &'a UpstreamPool,
    replay_after_send: bool,
    max_attempts: u32,
    attempts_used: u32,
    excluded: Exclusions,
    active: Option<&'a UpstreamNode>,
    last_response: Option<u16>,
    last_failure: Option<TransportFailure>,
}

impl<'a> AttemptLoop<'a> {
    /// Start a call with the default retry policy.
    #[must_use]
    pub fn new(
        pool: &'a UpstreamPool,
        method: CoreMethod,
        idempotency_key: Option<&str>,
        options: RetryOptions,
    ) -> Self {
        Self::with_policy(
            pool,
            method,
            idempotency_key,
            options,
            RetryPolicy::default(),
        )
    }

    #[must_use]
    pub fn with_policy(
        pool: &'a UpstreamPool,
        method: CoreMethod,
        idempotency_key: Option<&str>,
        options: RetryOptions,
        policy: RetryPolicy,
    ) -> Self {
        Self {
            pool,
            replay_after_send: RetryPolicy::may_replay_after_send(
                method,
                idempotency_key.is_some(),
                options,
            ),
            max_attempts: policy.attempts_for_request(method, idempotency_key, options),
            attempts_used: 0,
            excluded: Exclusions::new(),
            active: None,
            last_response: None,
            last_failure: None,
        }
    }

    /// Select the node for the next attempt, or `None` when the call must finish.
    pub fn next_node(&mut self, now_ms: u64) -> Option<&'a UpstreamNode> {
        if self.active.is_some() || self.attempts_used >= self.max_attempts {
            return None;
        }
        let node = self.pool.select(&self.excluded, now_ms)?;
        self.excluded.insert(node.url());
        self.attempts_used = self.attempts_used.saturating_add(1);
        node.begin_request();
        self.active = Some(node);
        Some(node)
    }

    /// Record a complete HTTP response for the attempt in flight.
    ///
    /// Any response marks the node healthy (TS `markNodeHealthy` before the status check). A
    /// 502/503/504 is retried only when the request may be replayed after send and another
    /// attempt is left.
    pub fn record_response(&mut self, status: u16, _now_ms: u64) -> AttemptDecision {
        let Some(node) = self.release_active() else {
            return AttemptDecision::Fail(PoolError::connection_error());
        };
        node.record_healthy();
        // TS keeps the response object whenever it considers another node, and always returns
        // the accepted one to its caller. Recording every status keeps `finish` truthful for an
        // executor that asks for the last answer after `next_node` returned `None`.
        self.last_response = Some(status);
        self.last_failure = None;
        if RetryPolicy::retryable_status(status)
            && self.replay_after_send
            && self.attempts_used < self.max_attempts
        {
            return AttemptDecision::Retry;
        }
        AttemptDecision::Accept
    }

    /// Record a transport failure for the attempt in flight.
    ///
    /// Port of the catch branch (`coreInternalClient.ts:696-704`): a failure that does not prove
    /// the node broken stops the call; otherwise the node counts it, and the call stops when the
    /// request may not be replayed after send and nothing reached the wire.
    pub fn record_transport(
        &mut self,
        failure: TransportFailure,
        connect_phase: bool,
        now_ms: u64,
    ) -> AttemptDecision {
        let Some(node) = self.release_active() else {
            return AttemptDecision::Fail(PoolError::connection_error());
        };
        self.last_response = None;
        self.last_failure = Some(failure);
        if !failure.counts_against_node() {
            return AttemptDecision::Fail(PoolError::from_transport(failure));
        }
        node.record_failure(self.pool.policy(), now_ms);
        if !self.replay_after_send && !connect_phase {
            return AttemptDecision::Fail(PoolError::from_transport(failure));
        }
        AttemptDecision::Retry
    }

    /// The final answer when [`Self::next_node`] returned `None`.
    ///
    /// Port of the tail of `request()` (`coreInternalClient.ts:706-712`): the last core response
    /// wins; otherwise a transport failure becomes `503 CORE_UNAVAILABLE` when no node is
    /// selectable at all, and the mapped `CORE_*` error otherwise.
    #[must_use]
    pub fn finish(&self, now_ms: u64) -> LoopFinish {
        if let Some(status) = self.last_response {
            return LoopFinish::Response(status);
        }
        if let Some(failure) = self.last_failure {
            if failure.counts_against_node()
                && !has_selectable(
                    self.pool.nodes(),
                    &Exclusions::new(),
                    self.pool.policy(),
                    now_ms,
                )
            {
                return LoopFinish::Error(PoolError::unavailable());
            }
            return LoopFinish::Error(PoolError::from_transport(failure));
        }
        LoopFinish::Error(PoolError::unavailable())
    }

    #[must_use]
    pub fn attempts_used(&self) -> u32 {
        self.attempts_used
    }

    #[must_use]
    pub fn max_attempts(&self) -> u32 {
        self.max_attempts
    }

    #[must_use]
    pub fn last_response_status(&self) -> Option<u16> {
        self.last_response
    }

    #[must_use]
    pub fn exclusions(&self) -> &Exclusions {
        &self.excluded
    }

    fn release_active(&mut self) -> Option<&'a UpstreamNode> {
        let node = self.active.take();
        if let Some(node) = node {
            node.finish_request();
        }
        node
    }
}

impl Drop for AttemptLoop<'_> {
    fn drop(&mut self) {
        if let Some(node) = self.active.take() {
            node.finish_request();
        }
    }
}

impl std::fmt::Debug for AttemptLoop<'_> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AttemptLoop")
            .field("max_attempts", &self.max_attempts)
            .field("attempts_used", &self.attempts_used)
            .field("replay_after_send", &self.replay_after_send)
            .field("last_response", &self.last_response)
            .field("last_failure", &self.last_failure)
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::node::HealthPolicy;

    fn make_pool(urls: &[&str]) -> UpstreamPool {
        UpstreamPool::with_defaults(urls.iter().map(|url| (*url).to_owned()).collect())
    }

    fn defaults() -> RetryOptions {
        RetryOptions::default()
    }

    #[test]
    fn first_response_is_accepted_and_releases_the_node() {
        let pool = make_pool(&["https://a"]);
        let mut call = AttemptLoop::new(&pool, CoreMethod::Get, None, defaults());

        let node = call.next_node(0).expect("node");
        assert_eq!(node.in_flight(), 1);
        assert_eq!(call.record_response(200, 0), AttemptDecision::Accept);
        assert_eq!(pool.nodes()[0].in_flight(), 0);
        assert_eq!(call.attempts_used(), 1);
        assert_eq!(call.finish(0), LoopFinish::Response(200));
    }

    #[test]
    fn get_retries_503_on_the_other_node_and_keeps_the_last_response() {
        let pool = make_pool(&["https://a", "https://b"]);
        let mut call = AttemptLoop::new(&pool, CoreMethod::Get, None, defaults());

        let first = call.next_node(0).expect("first").url().to_owned();
        assert_eq!(call.record_response(503, 0), AttemptDecision::Retry);
        let second = call.next_node(0).expect("second").url().to_owned();
        assert_ne!(first, second);
        assert_eq!(call.record_response(503, 0), AttemptDecision::Accept);
        assert_eq!(call.attempts_used(), 2);
        assert_eq!(call.last_response_status(), Some(503));

        let pool = make_pool(&["https://a", "https://b"]);
        let mut exhausted = AttemptLoop::new(&pool, CoreMethod::Get, None, defaults());
        exhausted.next_node(0).expect("first");
        assert_eq!(exhausted.record_response(502, 0), AttemptDecision::Retry);
        assert!(exhausted.next_node(0).is_some());
        assert_eq!(exhausted.record_response(502, 0), AttemptDecision::Accept);
        assert_eq!(exhausted.finish(0), LoopFinish::Response(502));
    }

    #[test]
    fn post_is_not_replayed_after_send_without_an_idempotency_key() {
        let pool = make_pool(&["https://a", "https://b"]);
        let mut call = AttemptLoop::new(&pool, CoreMethod::Post, None, defaults());
        assert_eq!(call.max_attempts(), 1);
        call.next_node(0).expect("node");
        assert_eq!(call.record_response(503, 0), AttemptDecision::Accept);
        assert!(call.next_node(0).is_none());
    }

    #[test]
    fn post_with_an_idempotency_key_is_replayed() {
        let pool = make_pool(&["https://a", "https://b"]);
        let mut call =
            AttemptLoop::new(&pool, CoreMethod::Post, Some("order-12345678"), defaults());
        assert_eq!(call.max_attempts(), 2);
        call.next_node(0).expect("first");
        assert_eq!(call.record_response(503, 0), AttemptDecision::Retry);
        assert!(call.next_node(0).is_some());
    }

    #[test]
    fn connect_phase_failure_retries_a_put_whose_send_would_not_be_replayed() {
        // TS: PUT is in `IDEMPOTENT_METHODS` (connect-phase retry) but not in
        // `REPLAY_SAFE_METHODS` (no replay after send). This is the case the `connectPhase`
        // flag exists for.
        let pool = make_pool(&["https://a", "https://b"]);
        let mut call = AttemptLoop::new(&pool, CoreMethod::Put, None, defaults());
        assert_eq!(call.max_attempts(), 2);
        call.next_node(0).expect("first");
        assert_eq!(
            call.record_transport(TransportFailure::ConnectionRefused, true, 0),
            AttemptDecision::Retry
        );
        assert!(call.next_node(0).is_some());
    }

    #[test]
    fn a_post_connect_failure_does_not_retry_without_an_opt_in() {
        // TS `retryAttemptsFor`: POST is not in `IDEMPOTENT_METHODS`, so the default budget is
        // one attempt even for a connect-phase failure. The loop asks for the next node and gets
        // none; `finish` then returns the specific transport error.
        let pool = make_pool(&["https://a", "https://b"]);
        let mut call = AttemptLoop::new(&pool, CoreMethod::Post, None, defaults());
        assert_eq!(call.max_attempts(), 1);
        call.next_node(0).expect("first");
        assert_eq!(
            call.record_transport(TransportFailure::ConnectionRefused, true, 0),
            AttemptDecision::Retry
        );
        assert!(call.next_node(0).is_none());
        assert_eq!(call.finish(0), LoopFinish::Error(PoolError::unreachable()));
    }

    #[test]
    fn a_post_retries_a_connect_failure_when_the_caller_opts_in() {
        let pool = make_pool(&["https://a", "https://b"]);
        let options = RetryOptions {
            retry_if_unavailable: true,
            ..RetryOptions::default()
        };
        let mut call = AttemptLoop::new(&pool, CoreMethod::Post, None, options);
        assert_eq!(call.max_attempts(), 2);
        call.next_node(0).expect("first");
        assert_eq!(
            call.record_transport(TransportFailure::ConnectionRefused, true, 0),
            AttemptDecision::Retry
        );
        assert!(call.next_node(0).is_some());
    }

    #[test]
    fn after_send_failure_stops_an_unsafe_method() {
        let pool = make_pool(&["https://a", "https://b"]);
        let mut call = AttemptLoop::new(&pool, CoreMethod::Post, None, defaults());
        call.next_node(0).expect("first");
        let decision = call.record_transport(TransportFailure::ConnectionReset, false, 0);
        match decision {
            AttemptDecision::Fail(error) => {
                assert_eq!(error.code(), "CORE_UNREACHABLE");
                assert_eq!(error.status(), 502);
            }
            other => panic!("expected a failure, got {other:?}"),
        }
    }

    #[test]
    fn a_single_failing_node_returns_the_transport_error_before_the_threshold() {
        let pool = make_pool(&["https://a"]);
        let mut call = AttemptLoop::new(&pool, CoreMethod::Get, None, defaults());
        call.next_node(0).expect("node");
        assert_eq!(
            call.record_transport(TransportFailure::Timeout, true, 0),
            AttemptDecision::Retry
        );
        // The same URL is never attempted twice in one call.
        assert!(call.next_node(0).is_none());
        // One failure is below the threshold, so the node is still selectable and the specific
        // transport error is the answer (TS: `hasSelectableNode` is true).
        assert_eq!(call.finish(0), LoopFinish::Error(PoolError::timeout()));
        assert_eq!(pool.nodes()[0].consecutive_failures(), 1);
    }

    #[test]
    fn no_selectable_node_becomes_core_unavailable() {
        let pool = make_pool(&["https://a"]);
        for _ in 0..HealthPolicy::DEFAULT_FAILURE_THRESHOLD {
            pool.nodes()[0].record_failure(pool.policy(), 0);
        }
        let mut call = AttemptLoop::new(&pool, CoreMethod::Get, None, defaults());
        assert!(call.next_node(0).is_none());
        assert_eq!(call.finish(0), LoopFinish::Error(PoolError::unavailable()));
    }

    #[test]
    fn two_nodes_failing_twice_map_the_last_transport_error() {
        let pool = make_pool(&["https://a", "https://b"]);
        let mut call = AttemptLoop::new(&pool, CoreMethod::Get, None, defaults());
        for _ in 0..2 {
            assert!(call.next_node(0).is_some());
            assert_eq!(
                call.record_transport(TransportFailure::ConnectionRefused, true, 0),
                AttemptDecision::Retry
            );
        }
        assert!(call.next_node(0).is_none());
        // Both nodes failed twice, below the 3-failure threshold: still selectable, so the
        // transport error is returned instead of CORE_UNAVAILABLE.
        assert_eq!(call.finish(0), LoopFinish::Error(PoolError::unreachable()));
    }

    #[test]
    fn any_http_response_marks_a_failing_node_healthy() {
        let pool = make_pool(&["https://a"]);
        let node = &pool.nodes()[0];
        node.record_failure(pool.policy(), 0);
        node.record_failure(pool.policy(), 0);
        assert_eq!(node.consecutive_failures(), 2);

        let mut call = AttemptLoop::new(&pool, CoreMethod::Post, None, defaults());
        call.next_node(0).expect("node");
        // A 503 is an application decision: it proves the node is reachable and resets the
        // breaker, but a POST is still not replayed after send.
        assert_eq!(call.record_response(503, 0), AttemptDecision::Accept);
        assert_eq!(node.consecutive_failures(), 0);
        assert!(node.is_healthy(pool.policy().failure_threshold));
    }

    #[test]
    fn local_failures_do_not_count_and_stop_immediately() {
        let pool = make_pool(&["https://a", "https://b"]);
        let mut call = AttemptLoop::new(&pool, CoreMethod::Get, None, defaults());
        call.next_node(0).expect("node");
        let decision = call.record_transport(TransportFailure::Other, false, 0);
        match decision {
            AttemptDecision::Fail(error) => assert_eq!(error.code(), "CORE_CONNECTION_ERROR"),
            other => panic!("expected a failure, got {other:?}"),
        }
        for node in pool.nodes() {
            assert_eq!(node.consecutive_failures(), 0);
        }
    }

    #[test]
    fn a_dropped_loop_releases_the_in_flight_slot() {
        let pool = make_pool(&["https://a"]);
        {
            let mut call = AttemptLoop::new(&pool, CoreMethod::Get, None, defaults());
            call.next_node(0).expect("node");
            assert_eq!(pool.nodes()[0].in_flight(), 1);
        }
        assert_eq!(pool.nodes()[0].in_flight(), 0);
    }

    #[test]
    fn recording_without_a_node_fails_closed() {
        let pool = make_pool(&["https://a"]);
        let mut call = AttemptLoop::new(&pool, CoreMethod::Get, None, defaults());
        assert_eq!(
            call.record_response(200, 0),
            AttemptDecision::Fail(PoolError::connection_error())
        );
        assert_eq!(
            call.record_transport(TransportFailure::Timeout, true, 0),
            AttemptDecision::Fail(PoolError::connection_error())
        );
    }

    #[test]
    fn health_policy_threshold_is_honoured_by_the_loop() {
        let pool = UpstreamPool::new(vec!["https://a".to_owned()], HealthPolicy::new(1, 10_000));
        let mut call = AttemptLoop::new(&pool, CoreMethod::Get, None, defaults());
        call.next_node(0).expect("node");
        assert_eq!(
            call.record_transport(TransportFailure::Tls, true, 0),
            AttemptDecision::Retry
        );
        assert_eq!(call.finish(0), LoopFinish::Error(PoolError::unavailable()));
        assert!(!pool.nodes()[0].half_open_ready(pool.policy(), 9_999));
        assert!(pool.nodes()[0].half_open_ready(pool.policy(), 10_000));
    }
}

//! Least-in-flight node selection with a monotonic round-robin tie-break.
//!
//! Port of `{admin,merchant,checkout}-back/lib/coreInternalClient.ts:346-436`:
//! `CorePoolState`, `ensureNodes`, `eligiblePool`, `selectNode`, `hasSelectableNode` and the
//! global `roundRobinCursor`.
//!
//! Two invariants from the TS loop are part of this module:
//!
//! 1. a half-open node (ejected, cooldown expired, idle) is preferred over every healthy node and
//!    receives exactly ONE probe;
//! 2. a logical call never targets the same URL twice. [`Exclusions`] is the explicit set the
//!    caller threads through the attempts; [`select_node`] never returns an excluded URL.

#![forbid(unsafe_code)]

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::node::{HealthPolicy, UpstreamNode};

/// Monotonic wall clock in milliseconds, used for ejection deadlines.
///
/// The TS code uses `Date.now()`; the executor may inject a fixed clock in tests.
#[must_use]
pub fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// The URLs already attempted by one logical call.
///
/// Port of the `attempted` set in `request()` and `openCoreStream()`
/// (`coreInternalClient.ts:678-681`, `:883-886`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Exclusions {
    urls: HashSet<String>,
}

impl Exclusions {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns `true` when the URL was not already present.
    pub fn insert(&mut self, url: &str) -> bool {
        self.urls.insert(url.to_owned())
    }

    #[must_use]
    pub fn contains(&self, url: &str) -> bool {
        self.urls.contains(url)
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.urls.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.urls.is_empty()
    }

    pub fn clear(&mut self) {
        self.urls.clear();
    }
}

/// Select the next node, or `None` when no eligible node remains.
///
/// Port of `selectNode` (`coreInternalClient.ts:426-434`). Half-open candidates are tried first,
/// in round-robin order; a failed claim falls through to the next candidate and then to the
/// healthy set. The cursor is a single monotonic counter shared by every request, like the TS
/// module-level `roundRobinCursor`.
pub fn select_node<'a>(
    nodes: &'a [UpstreamNode],
    cursor: &AtomicU64,
    excluded: &Exclusions,
    policy: HealthPolicy,
    now_ms: u64,
) -> Option<&'a UpstreamNode> {
    let half_open: Vec<&'a UpstreamNode> = nodes
        .iter()
        .filter(|node| !excluded.contains(node.url()) && node.half_open_ready(policy, now_ms))
        .collect();
    if !half_open.is_empty() {
        let start = next_cursor(cursor) % half_open.len() as u64;
        for offset in 0..half_open.len() {
            let index = (start as usize + offset) % half_open.len();
            if let Some(node) = half_open.get(index).copied() {
                if node.try_claim_half_open(policy, now_ms) {
                    return Some(node);
                }
            }
        }
    }

    let healthy: Vec<&'a UpstreamNode> = nodes
        .iter()
        .filter(|node| !excluded.contains(node.url()) && node.is_healthy(policy.failure_threshold))
        .collect();
    let least = healthy.iter().map(|node| node.in_flight()).min()?;
    let tied: Vec<&'a UpstreamNode> = healthy
        .into_iter()
        .filter(|node| node.in_flight() == least)
        .collect();
    let index = next_cursor(cursor) % tied.len() as u64;
    tied.get(index as usize).copied()
}

/// Whether any node could be selected, without claiming a half-open probe.
///
/// Port of `hasSelectableNode` (`coreInternalClient.ts:436`).
#[must_use]
pub fn has_selectable(
    nodes: &[UpstreamNode],
    excluded: &Exclusions,
    policy: HealthPolicy,
    now_ms: u64,
) -> bool {
    nodes.iter().any(|node| {
        !excluded.contains(node.url())
            && (node.is_healthy(policy.failure_threshold) || node.half_open_ready(policy, now_ms))
    })
}

fn next_cursor(cursor: &AtomicU64) -> u64 {
    cursor.fetch_add(1, Ordering::Relaxed)
}

/// One plane's node list and shared cursor.
///
/// Port of `CorePoolState`/`ensureNodes` (`coreInternalClient.ts:346-406`). The Live and Sandbox
/// planes are separate pools; nothing in this type can move a request between them.
#[derive(Debug)]
pub struct UpstreamPool {
    urls: Vec<String>,
    nodes: Vec<UpstreamNode>,
    cursor: AtomicU64,
    policy: HealthPolicy,
}

impl UpstreamPool {
    #[must_use]
    pub fn new(urls: Vec<String>, policy: HealthPolicy) -> Self {
        let nodes = urls.iter().map(UpstreamNode::new).collect();
        Self {
            urls,
            nodes,
            cursor: AtomicU64::new(0),
            policy,
        }
    }

    /// Pool with the TS default health policy (`3` failures, `5_000` ms cooldown).
    #[must_use]
    pub fn with_defaults(urls: Vec<String>) -> Self {
        Self::new(urls, HealthPolicy::default())
    }

    /// The configured URLs, in configuration order.
    #[must_use]
    pub fn urls(&self) -> &[String] {
        &self.urls
    }

    #[must_use]
    pub fn nodes(&self) -> &[UpstreamNode] {
        &self.nodes
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    #[must_use]
    pub fn policy(&self) -> HealthPolicy {
        self.policy
    }

    /// Stable identity of the URL set, like the TS `signature` (`configured.join("\n")`).
    #[must_use]
    pub fn signature(&self) -> String {
        self.urls.join("\n")
    }

    #[must_use]
    pub fn select(&self, excluded: &Exclusions, now_ms: u64) -> Option<&UpstreamNode> {
        select_node(&self.nodes, &self.cursor, excluded, self.policy, now_ms)
    }

    #[must_use]
    pub fn has_selectable(&self, excluded: &Exclusions, now_ms: u64) -> bool {
        has_selectable(&self.nodes, excluded, self.policy, now_ms)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pool(urls: &[&str]) -> UpstreamPool {
        UpstreamPool::with_defaults(urls.iter().map(|url| (*url).to_owned()).collect())
    }

    fn eject(node: &UpstreamNode) {
        for _ in 0..HealthPolicy::DEFAULT_FAILURE_THRESHOLD {
            node.record_failure(HealthPolicy::default(), 0);
        }
    }

    #[test]
    fn empty_pool_has_no_node_and_lists_its_signature() {
        let empty = pool(&[]);
        assert!(empty.is_empty());
        assert_eq!(empty.signature(), "");
        assert!(empty.select(&Exclusions::new(), 0).is_none());

        let single = pool(&["https://a"]);
        assert_eq!(single.len(), 1);
        assert_eq!(single.signature(), "https://a");
        assert_eq!(single.urls(), ["https://a".to_owned()].as_slice());
    }

    #[test]
    fn picks_the_least_in_flight_node() {
        let pool = pool(&["https://a", "https://b"]);
        let nodes = pool.nodes();
        nodes[0].begin_request();
        nodes[0].begin_request();
        let selected = pool
            .select(&Exclusions::new(), 0)
            .expect("a node is available");
        assert_eq!(selected.url(), "https://b");
        nodes[0].finish_request();
        nodes[0].finish_request();
    }

    #[test]
    fn round_robin_tie_break_is_monotonic_across_calls() {
        let pool = pool(&["https://a", "https://b"]);
        let first = pool
            .select(&Exclusions::new(), 0)
            .expect("first")
            .url()
            .to_owned();
        let second = pool
            .select(&Exclusions::new(), 0)
            .expect("second")
            .url()
            .to_owned();
        let third = pool
            .select(&Exclusions::new(), 0)
            .expect("third")
            .url()
            .to_owned();
        assert_ne!(first, second);
        assert_eq!(first, third);
    }

    #[test]
    fn exclusions_prevent_the_same_url_twice_and_can_be_cleared() {
        let pool = pool(&["https://a", "https://b"]);
        let mut excluded = Exclusions::new();
        let first = pool.select(&excluded, 0).expect("first");
        assert!(excluded.insert(first.url()));
        let second = pool.select(&excluded, 0).expect("second");
        assert_ne!(first.url(), second.url());
        assert!(excluded.insert(second.url()));
        assert!(pool.select(&excluded, 0).is_none());
        assert!(!pool.has_selectable(&excluded, 0));

        excluded.clear();
        assert!(excluded.is_empty());
        assert!(pool.select(&excluded, 0).is_some());
    }

    #[test]
    fn half_open_node_is_preferred_and_probed_once() {
        let pool = pool(&["https://a", "https://b"]);
        eject(&pool.nodes()[0]);

        let probed = pool.select(&Exclusions::new(), 5_000).expect("probe");
        assert_eq!(probed.url(), "https://a");
        // While the probe is open the node is not selectable as a probe again.
        assert!(!pool.nodes()[0].half_open_ready(pool.policy(), 5_000));
        // A normal request goes to the healthy node.
        let normal = pool
            .select(&Exclusions::new(), 5_000)
            .expect("healthy node");
        assert_eq!(normal.url(), "https://b");
    }

    #[test]
    fn an_ejected_node_without_a_cooldown_elapse_is_skipped() {
        let pool = pool(&["https://a"]);
        eject(&pool.nodes()[0]);
        assert!(pool.select(&Exclusions::new(), 4_999).is_none());
        assert!(!pool.has_selectable(&Exclusions::new(), 0));
        assert!(pool.has_selectable(&Exclusions::new(), 5_000));
        assert!(pool.select(&Exclusions::new(), 5_000).is_some());
    }
}

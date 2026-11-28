//! Read-replica routing and LSN consistency (P3-T02 / chapter 2 §18).
//!
//! `readStoreAdapter.ts` monitors each replica every 150 ms (`pg_last_wal_replay_lsn()`, replay
//! lag), marks a replica unhealthy after two consecutive failures, round-robins healthy replicas
//! and falls back to the primary when the requested consistency cannot be met.

#![forbid(unsafe_code)]

use std::sync::atomic::{AtomicI64, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;

use sqlx::PgPool;

/// The consistency a caller asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadConsistency {
    Primary,
    /// A replica whose replay lag is at most `max_lag_ms`.
    Replica {
        max_lag_ms: i64,
    },
    /// A replica that replayed at least `lsn`.
    AtLeastLsn {
        lsn: PgLsn,
        max_wait_ms: u64,
    },
}

/// A PostgreSQL LSN (`HEX/HEX`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct PgLsn(pub u64);

impl PgLsn {
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        let (high, low) = raw.split_once('/')?;
        let high = u64::from_str_radix(high, 16).ok()?;
        let low = u64::from_str_radix(low, 16).ok()?;
        Some(Self((high << 32) | low))
    }
}

impl std::fmt::Display for PgLsn {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:X}/{:X}", self.0 >> 32, self.0 & 0xFFFF_FFFF)
    }
}

/// The mutable health of one replica.
#[derive(Debug)]
pub struct ReplicaState {
    pub lag_ms: AtomicI64,
    pub lsn: AtomicU64,
    pub failures: AtomicU32,
    pub healthy: AtomicUsize,
}

impl Default for ReplicaState {
    fn default() -> Self {
        Self {
            lag_ms: AtomicI64::new(i64::MAX),
            lsn: AtomicU64::new(0),
            failures: AtomicU32::new(0),
            healthy: AtomicUsize::new(0),
        }
    }
}

impl ReplicaState {
    #[must_use]
    pub fn snapshot(&self) -> ReplicaSnapshot {
        ReplicaSnapshot {
            lag_ms: self.lag_ms.load(Ordering::Relaxed),
            lsn: PgLsn(self.lsn.load(Ordering::Relaxed)),
            healthy: self.healthy.load(Ordering::Relaxed) == 1,
        }
    }

    /// Two consecutive monitor failures mark the replica unhealthy (TS threshold).
    pub fn record_failure(&self) {
        let failures = self.failures.fetch_add(1, Ordering::Relaxed) + 1;
        if failures >= 2 {
            self.healthy.store(0, Ordering::Relaxed);
        }
    }

    pub fn record_success(&self, lag_ms: i64, lsn: PgLsn) {
        self.failures.store(0, Ordering::Relaxed);
        self.lag_ms.store(lag_ms, Ordering::Relaxed);
        self.lsn.store(lsn.0, Ordering::Relaxed);
        self.healthy.store(1, Ordering::Relaxed);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReplicaSnapshot {
    pub lag_ms: i64,
    pub lsn: PgLsn,
    pub healthy: bool,
}

/// Pure selection used by [`ReplicaRouter`] and by tests.
#[must_use]
pub fn choose_replica(
    replicas: &[ReplicaSnapshot],
    consistency: ReadConsistency,
    round_robin: usize,
) -> Option<usize> {
    match consistency {
        ReadConsistency::Primary => None,
        ReadConsistency::Replica { max_lag_ms } => {
            let eligible: Vec<usize> = replicas
                .iter()
                .enumerate()
                .filter(|(_, replica)| replica.healthy && replica.lag_ms <= max_lag_ms)
                .map(|(index, _)| index)
                .collect();
            if eligible.is_empty() {
                None
            } else {
                Some(eligible[round_robin % eligible.len()])
            }
        }
        ReadConsistency::AtLeastLsn { lsn, .. } => {
            let mut best: Option<(usize, i64)> = None;
            for (index, replica) in replicas.iter().enumerate() {
                if !replica.healthy || replica.lsn < lsn {
                    continue;
                }
                if best.is_none_or(|(_, lag)| replica.lag_ms < lag) {
                    best = Some((index, replica.lag_ms));
                }
            }
            best.map(|(index, _)| index)
        }
    }
}

/// A monitored replica pool.
#[derive(Debug)]
pub struct ReplicaNode {
    pub pool: PgPool,
    pub state: Arc<ReplicaState>,
}

/// Primary plus replicas. A missing replica always falls back to the primary.
#[derive(Debug)]
pub struct ReplicaRouter {
    pub primary: PgPool,
    pub replicas: Vec<ReplicaNode>,
    round_robin: AtomicUsize,
}

impl ReplicaRouter {
    #[must_use]
    pub fn new(primary: PgPool, replicas: Vec<ReplicaNode>) -> Self {
        Self {
            primary,
            replicas,
            round_robin: AtomicUsize::new(0),
        }
    }

    #[must_use]
    pub fn snapshots(&self) -> Vec<ReplicaSnapshot> {
        self.replicas
            .iter()
            .map(|node| node.state.snapshot())
            .collect()
    }

    /// Select the pool for one read. `AtLeastLsn` falls back when no replica has caught up (the
    /// caller may retry within its `max_wait_ms` budget).
    pub fn pick(&self, consistency: ReadConsistency) -> &PgPool {
        let round_robin = self.round_robin.fetch_add(1, Ordering::Relaxed);
        match choose_replica(&self.snapshots(), consistency, round_robin) {
            Some(index) => &self.replicas[index].pool,
            None => &self.primary,
        }
    }

    /// Refresh the lag/LSN of every replica. A failed query counts as one monitor failure.
    pub async fn refresh(&self) {
        for node in &self.replicas {
            match sqlx::query_as::<_, (Option<f64>, Option<String>)>(
                "SELECT EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())) * 1000,
                        pg_last_wal_replay_lsn()::text",
            )
            .fetch_one(&node.pool)
            .await
            {
                Ok((lag, lsn)) => {
                    let lag_ms = lag.map_or(i64::MAX, |value| value as i64);
                    let lsn = lsn.as_deref().and_then(PgLsn::parse).unwrap_or(PgLsn(0));
                    node.state.record_success(lag_ms, lsn);
                }
                Err(_) => node.state.record_failure(),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(lag_ms: i64, lsn: u64, healthy: bool) -> ReplicaSnapshot {
        ReplicaSnapshot {
            lag_ms,
            lsn: PgLsn(lsn),
            healthy,
        }
    }

    #[test]
    fn parses_lsn_and_orders() {
        let a = PgLsn::parse("0/16B6C50").expect("lsn");
        let b = PgLsn::parse("0/16B6C51").expect("lsn");
        assert!(a < b);
        assert_eq!(a.to_string(), "0/16B6C50");
    }

    #[test]
    fn falls_back_to_primary_when_no_replica_is_eligible() {
        let replicas = [snapshot(5_000, 10, true), snapshot(100, 5, false)];
        assert_eq!(
            choose_replica(&replicas, ReadConsistency::Replica { max_lag_ms: 2_000 }, 0),
            None
        );
        assert_eq!(choose_replica(&[], ReadConsistency::Primary, 0), None);
    }

    #[test]
    fn round_robins_eligible_replicas() {
        let replicas = [snapshot(10, 10, true), snapshot(20, 20, true)];
        assert_eq!(
            choose_replica(&replicas, ReadConsistency::Replica { max_lag_ms: 100 }, 0),
            Some(0)
        );
        assert_eq!(
            choose_replica(&replicas, ReadConsistency::Replica { max_lag_ms: 100 }, 1),
            Some(1)
        );
        assert_eq!(
            choose_replica(&replicas, ReadConsistency::Replica { max_lag_ms: 100 }, 2),
            Some(0)
        );
    }

    #[test]
    fn at_least_lsn_picks_the_lowest_lag_caught_up_replica() {
        let replicas = [
            snapshot(10, 100, true),
            snapshot(5, 200, true),
            snapshot(1, 50, true),
        ];
        assert_eq!(
            choose_replica(
                &replicas,
                ReadConsistency::AtLeastLsn {
                    lsn: PgLsn(150),
                    max_wait_ms: 500,
                },
                0
            ),
            Some(1)
        );
    }

    #[test]
    fn two_failures_mark_unhealthy_and_success_recovers() {
        let state = ReplicaState::default();
        state.record_success(5, PgLsn(1));
        assert!(state.snapshot().healthy);
        state.record_failure();
        assert!(state.snapshot().healthy);
        state.record_failure();
        assert!(!state.snapshot().healthy);
        state.record_success(5, PgLsn(2));
        assert!(state.snapshot().healthy);
    }
}

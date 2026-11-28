//! Postgres advisory leader election.
//!
//! Port of `core-back/lib/storageEngine/leaderElection.ts`. Keys are
//! `hashtextextended('worker:' || name, 0)`, so TS and Rust contend on the same lock while both
//! run. The session endpoint must be a direct/session-pooled connection, never PgBouncer's
//! transaction pool (GAP-012).

#![forbid(unsafe_code)]

/// Stable probe key used by the boot session-safety probe.
pub const LEADER_BOOT_PROBE_KEY: i64 = 0x5047_4c45_4144_4552; // "PGL EADER" marker, any stable value

/// Singleton workers registered by `ProductionWorkerRuntime`.
pub const EXPECTED_SINGLETON_KEYS: &[&str] = &[
    "ExpirySweeper",
    "InboundInbox",
    "JoinRequestExpiry",
    "KybExpiry",
    "LedgerInvariant",
    "PeriodicScreening",
    "Retention",
    "LedgerCheckpoint",
    "LedgerShardScaler",
    "JournalPartition",
    "Deadline",
    "ExpiryHousekeeping",
    "PlatformMonitor",
    "CommissionNetting",
    "RegulatoryReport",
    "AuditChainAnchor",
    "StatementSchedule",
    "ConsistencyAudit",
    "ObjectStorageMaintenance",
    "GatewayHealth",
];

/// The SQL key expression, copied verbatim.
#[must_use]
pub fn leader_lock_key(worker_name: &str) -> String {
    // Only used for documentation/tests; the real query computes it in PostgreSQL so hashing
    // matches TS exactly.
    format!("hashtextextended('worker:' || '{worker_name}', 0)")
}

/// `pg_try_advisory_lock(hashtextextended('worker:'||$1,0))`.
#[must_use]
pub fn leader_lock_sql() -> &'static str {
    "SELECT pg_try_advisory_lock(hashtextextended('worker:' || $1, 0)) AS acquired"
}

/// Ownership re-check performed every tick: backend pid + the advisory row.
#[must_use]
pub fn leader_ownership_sql() -> &'static str {
    "SELECT EXISTS (
        SELECT 1
          FROM pg_locks l
         WHERE l.locktype = 'advisory'
           AND l.granted
           AND l.pid = pg_backend_pid()
           AND l.objsubid = 1
           AND (l.classid::bigint << 32 | l.objid::bigint) = hashtextextended('worker:' || $1, 0)
     ) AS owned"
}

/// Startup refusal when PgBouncer is on and the leader endpoint is missing or transaction-pooled.
#[must_use]
pub fn verify_session_safety_error(
    pgbouncer_enabled: bool,
    leader_url: Option<&str>,
    database_url: &str,
) -> Option<String> {
    if !pgbouncer_enabled {
        return None;
    }
    match leader_url {
        None => Some(
            "LEADER_ELECTION_DATABASE_URL is required when PGBOUNCER_ENABLED=true (use the session-pooled pgw_session alias)"
                .to_owned(),
        ),
        Some(url) if url.trim().is_empty() => Some(
            "LEADER_ELECTION_DATABASE_URL is empty; use the session-pooled pgw_session alias"
                .to_owned(),
        ),
        Some(url) if url == database_url => Some(
            "LEADER_ELECTION_DATABASE_URL must not be the transaction-pooled DATABASE_URL"
                .to_owned(),
        ),
        Some(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_safety_refuses_the_transaction_pool() {
        assert!(verify_session_safety_error(true, None, "postgres://x").is_some());
        assert!(verify_session_safety_error(true, Some("postgres://x"), "postgres://x").is_some());
        assert!(verify_session_safety_error(
            true,
            Some("postgres://session"),
            "postgres://transaction"
        )
        .is_none());
        assert!(verify_session_safety_error(false, None, "postgres://x").is_none());
    }

    #[test]
    fn singleton_list_is_unique() {
        let mut sorted = EXPECTED_SINGLETON_KEYS.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), EXPECTED_SINGLETON_KEYS.len());
    }
}

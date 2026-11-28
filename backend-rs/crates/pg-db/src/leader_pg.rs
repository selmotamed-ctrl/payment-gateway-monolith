//! PostgreSQL advisory-lock leader election (P3-T04).
//!
//! The keys and ownership checks are copied from `core-back/lib/storageEngine/leaderElection.ts`.
//! The pool passed here MUST be a session-safe endpoint (a direct PostgreSQL connection or the
//! PgBouncer `pgw_session` alias); the boot probe proves it.

#![forbid(unsafe_code)]

use std::collections::HashSet;
use std::sync::atomic::{AtomicU32, Ordering};

use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use sqlx::{Connection, PgPool, Row};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum LeaderError {
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("session safety probe failed: {0}")]
    SessionUnsafe(String),
}

pub struct PgLeaderElection {
    pool: PgPool,
    backend_pid: i32,
    held: Mutex<HashSet<String>>,
    lost_count: AtomicU32,
    last_probe_at: Mutex<Option<DateTime<Utc>>>,
    probe_ok: Mutex<Option<bool>>,
    /// The session-safe URL, used to open the independent second client of the boot probe.
    /// Never printed (`Debug` is manual).
    probe_url: Option<String>,
}

impl std::fmt::Debug for PgLeaderElection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PgLeaderElection")
            .field("backend_pid", &self.backend_pid)
            .field("held", &self.held.lock().len())
            .field("lost_count", &self.lost_count())
            .field("probe_ok", &self.probe_ok())
            .field("has_probe_url", &self.probe_url.is_some())
            .finish()
    }
}

impl PgLeaderElection {
    /// Acquire a dedicated connection to read this process's backend PID.
    ///
    /// Without the URL the boot probe needs the pool to have at least two connections; prefer
    /// [`Self::connect_with_url`] so the pool can be pinned to one backend.
    pub async fn connect(pool: PgPool) -> Result<Self, LeaderError> {
        Self::build(pool, None).await
    }

    /// Same as [`Self::connect`] but the boot probe opens its own second connection from `url`.
    pub async fn connect_with_url(pool: PgPool, url: &str) -> Result<Self, LeaderError> {
        Self::build(pool, Some(url.to_owned())).await
    }

    async fn build(pool: PgPool, probe_url: Option<String>) -> Result<Self, LeaderError> {
        let backend_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&pool)
            .await?;
        Ok(Self {
            pool,
            backend_pid,
            held: Mutex::new(HashSet::new()),
            lost_count: AtomicU32::new(0),
            last_probe_at: Mutex::new(None),
            probe_ok: Mutex::new(None),
            probe_url,
        })
    }

    #[must_use]
    pub fn backend_pid(&self) -> i32 {
        self.backend_pid
    }

    /// Keys this process currently holds (`status().held`).
    #[must_use]
    pub fn held(&self) -> Vec<String> {
        let mut keys: Vec<String> = self.held.lock().iter().cloned().collect();
        keys.sort();
        keys
    }

    /// `status().lostCount`.
    #[must_use]
    pub fn lost_count(&self) -> u32 {
        self.lost_count.load(Ordering::Relaxed)
    }

    /// `status().lastProbeAt`.
    #[must_use]
    pub fn last_probe_at(&self) -> Option<DateTime<Utc>> {
        *self.last_probe_at.lock()
    }

    /// `status().probeOk` (`None` before the boot probe ran).
    #[must_use]
    pub fn probe_ok(&self) -> Option<bool> {
        *self.probe_ok.lock()
    }

    fn record_verified(&self, owned: bool) {
        *self.last_probe_at.lock() = Some(Utc::now());
        if !owned {
            self.lost_count.fetch_add(1, Ordering::Relaxed);
        }
    }

    pub async fn try_acquire(&self, worker: &str) -> Result<bool, LeaderError> {
        // One acquisition per process: PostgreSQL advisory locks are re-entrant inside a session,
        // so a second `pg_try_advisory_lock` would succeed and silently raise the unlock count.
        // Treating an already-held key as "not acquired" keeps the in-process set and the server
        // count in lockstep (release unlocks exactly once).
        if self.held.lock().contains(worker) {
            return Ok(false);
        }
        let acquired: bool =
            sqlx::query_scalar("SELECT pg_try_advisory_lock(hashtextextended('worker:' || $1, 0))")
                .bind(worker)
                .fetch_one(&self.pool)
                .await?;
        if acquired {
            self.held.lock().insert(worker.to_owned());
        }
        Ok(acquired)
    }

    /// Re-prove ownership every tick: this backend PID still owns the advisory row.
    pub async fn verify(&self, worker: &str) -> Result<bool, LeaderError> {
        if !self.held.lock().contains(worker) {
            return Ok(false);
        }
        let row = sqlx::query(
            "SELECT pg_backend_pid() AS pid,
                    EXISTS (
                        SELECT 1
                          FROM pg_locks l
                         WHERE l.locktype = 'advisory'
                           AND l.granted
                           AND l.pid = pg_backend_pid()
                           AND l.objsubid = 1
                           AND (l.classid::bigint << 32 | l.objid::bigint)
                               = hashtextextended('worker:' || $1, 0)
                    ) AS owned",
        )
        .bind(worker)
        .fetch_one(&self.pool)
        .await?;
        let pid: i32 = row.try_get("pid")?;
        let owned: bool = row.try_get("owned")?;
        let still_leader = pid == self.backend_pid && owned;
        self.record_verified(still_leader);
        if !still_leader {
            self.held.lock().remove(worker);
        }
        Ok(still_leader)
    }

    pub async fn release(&self, worker: &str) -> Result<(), LeaderError> {
        let _: bool =
            sqlx::query_scalar("SELECT pg_advisory_unlock(hashtextextended('worker:' || $1, 0))")
                .bind(worker)
                .fetch_one(&self.pool)
                .await?;
        self.held.lock().remove(worker);
        Ok(())
    }

    /// Boot probe: a second connection must not be able to take the probe key, the backend PID
    /// must stay stable, and unlock must succeed. A transaction-pooled PgBouncer endpoint drops
    /// the session lock between statements and fails here.
    pub async fn probe_session_safety(&self) -> Result<(), LeaderError> {
        let mut first = self.pool.acquire().await?;
        let key = crate::leader::LEADER_BOOT_PROBE_KEY;
        let first_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&mut *first)
            .await?;
        let acquired: bool = sqlx::query_scalar("SELECT pg_try_advisory_lock($1)")
            .bind(key)
            .fetch_one(&mut *first)
            .await?;
        if !acquired {
            self.record_probe(false);
            return Err(LeaderError::SessionUnsafe(
                "probe key is already held; another leader may be running".to_owned(),
            ));
        }
        // The TS probe opens an independent client; a one-connection leader pool must not be able
        // to answer this from the same backend.
        let second_try: bool = match &self.probe_url {
            Some(url) => {
                let mut second = sqlx::PgConnection::connect(url).await?;
                sqlx::query_scalar("SELECT pg_try_advisory_lock($1)")
                    .bind(key)
                    .fetch_one(&mut second)
                    .await?
            }
            None => {
                sqlx::query_scalar("SELECT pg_try_advisory_lock($1)")
                    .bind(key)
                    .fetch_one(&self.pool)
                    .await?
            }
        };
        let still_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&mut *first)
            .await?;
        let unlocked: bool = sqlx::query_scalar("SELECT pg_advisory_unlock($1)")
            .bind(key)
            .fetch_one(&mut *first)
            .await?;

        if second_try {
            // Clean up the second connection's lock through the pool (a new statement on the
            // same pooled connection may or may not be the same backend; release by key).
            let _: bool = sqlx::query_scalar("SELECT pg_advisory_unlock($1)")
                .bind(key)
                .fetch_one(&self.pool)
                .await?;
            self.record_probe(false);
            return Err(LeaderError::SessionUnsafe(
                "two connections acquired the same advisory lock; the endpoint is transaction-pooled"
                    .to_owned(),
            ));
        }
        if first_pid != still_pid {
            self.record_probe(false);
            return Err(LeaderError::SessionUnsafe(
                "the backend PID changed between statements; the endpoint is transaction-pooled"
                    .to_owned(),
            ));
        }
        if !unlocked {
            self.record_probe(false);
            return Err(LeaderError::SessionUnsafe(
                "unlock did not report success".to_owned(),
            ));
        }
        self.record_probe(true);
        Ok(())
    }

    fn record_probe(&self, ok: bool) {
        *self.probe_ok.lock() = Some(ok);
        *self.last_probe_at.lock() = Some(Utc::now());
    }
}

/// SQL used by the boot probe, exported for tests and documentation.
pub const SESSION_PROBE_SQL: &str = "SELECT pg_backend_pid(); SELECT pg_try_advisory_lock($1); SELECT pg_try_advisory_lock($1); SELECT pg_backend_pid(); SELECT pg_advisory_unlock($1);";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_sql_names_the_five_steps() {
        assert_eq!(SESSION_PROBE_SQL.matches(';').count(), 5);
    }

    #[test]
    fn error_display_mentions_session_safety() {
        let error = LeaderError::SessionUnsafe("pooled".to_owned());
        assert!(error.to_string().contains("session safety"));
    }
}

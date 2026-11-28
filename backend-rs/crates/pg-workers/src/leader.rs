//! Adapter from `pg_db::PgLeaderElection` to the worker runtime's [`LeaderLock`].
//!
//! The advisory-lock SQL and the boot session probe live in `pg-db` (same keys as the TypeScript
//! `leaderElection.ts`: `hashtextextended('worker:' || name, 0)`). This type only maps the errors and
//! keeps the trait object small.

#![forbid(unsafe_code)]

use std::sync::Arc;

use async_trait::async_trait;
use sqlx::PgPool;

use crate::runtime::{LeaderLock, WorkerError};

pub struct PgLeaderLock {
    election: pg_db::PgLeaderElection,
}

impl PgLeaderLock {
    #[must_use]
    pub fn new(election: pg_db::PgLeaderElection) -> Self {
        Self { election }
    }

    /// Connects a dedicated session-safe endpoint and reads the backend PID.
    pub async fn connect(pool: PgPool) -> Result<Self, WorkerError> {
        let election = pg_db::PgLeaderElection::connect(pool)
            .await
            .map_err(|error| WorkerError::Leader(error.to_string()))?;
        Ok(Self::new(election))
    }

    /// Boot proof that the endpoint preserves a session-level advisory lock.
    pub async fn probe_session_safety(&self) -> Result<(), WorkerError> {
        self.election
            .probe_session_safety()
            .await
            .map_err(|error| WorkerError::Leader(error.to_string()))
    }

    #[must_use]
    pub fn backend_pid(&self) -> i32 {
        self.election.backend_pid()
    }

    #[must_use]
    pub fn into_arc(self) -> Arc<dyn LeaderLock> {
        Arc::new(self)
    }
}

#[async_trait]
impl LeaderLock for PgLeaderLock {
    async fn try_acquire(&self, worker: &str) -> Result<bool, WorkerError> {
        self.election
            .try_acquire(worker)
            .await
            .map_err(|error| WorkerError::Leader(error.to_string()))
    }

    async fn verify(&self, worker: &str) -> Result<bool, WorkerError> {
        self.election
            .verify(worker)
            .await
            .map_err(|error| WorkerError::Leader(error.to_string()))
    }

    async fn release(&self, worker: &str) -> Result<(), WorkerError> {
        self.election
            .release(worker)
            .await
            .map_err(|error| WorkerError::Leader(error.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_adapter_exposes_the_boot_probe() {
        // Construction needs a pool; the type-level contract is what this test pins.
        fn assert_leader_lock<T: LeaderLock>() {}
        assert_leader_lock::<PgLeaderLock>();
    }
}

//! Restart reconciliation. Port of `deploy/backup-daemon/src/startup.ts`.
//!
//! 1. Runs that were QUEUED/RUNNING when the previous process stopped can never finish; they are
//!    marked FAILED instead of staying RUNNING forever.
//! 2. Idempotency keys are restored ONLY for jobs that genuinely completed. An interrupted job's
//!    key is dropped, so a client retry starts a fresh job rather than being handed the id of one
//!    that died with the old process.

use crate::catalog::CatalogStore;
use crate::job_queue::JobQueue;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RestoredJobState {
    /// Runs that were QUEUED/RUNNING when the previous process stopped; now recorded as FAILED.
    pub interrupted: Vec<String>,
    /// Idempotency keys restored for jobs that really finished.
    pub restored_keys: usize,
}

pub async fn restore_job_state(catalog: &CatalogStore, jobs: &JobQueue) -> RestoredJobState {
    let interrupted = catalog
        .fail_interrupted_runs("interrupted: the daemon restarted before this job finished")
        .await;
    let interrupted_set: std::collections::BTreeSet<String> = interrupted.iter().cloned().collect();
    let restored_keys = jobs
        .load_keys(|id| !interrupted_set.contains(id) && catalog.has_finished_job(id))
        .await;
    RestoredJobState {
        interrupted,
        restored_keys,
    }
}

//! Process state: pools, leader election, authenticator, worker snapshot and the access-log sink.
//!
//! Port of the storage/worker wiring of `core-back/index.ts:294-390` (`start`) restricted to what
//! the P3 shell owns: no plane-fence check (the Fake Rails trigger is checked by the deploy), no
//! communication bootstrap (P8), no Redis invalidation transport (P5/P6) and no workers (P6).
//!
//! Boot order kept:
//! 1. open the pools (main, audit, log, leader);
//! 2. prove the leader-election endpoint preserves a session when workers are enabled
//!    (`verifySessionSafety`);
//! 3. connect Redis for session revocation (a failure only disables the fast path);
//! 4. start the access-log flusher.

#![forbid(unsafe_code)]

use std::sync::Arc;
use std::time::Instant;

use chrono::{DateTime, Utc};
use parking_lot::RwLock;
use redis::aio::ConnectionManager;
use sqlx::PgPool;
use thiserror::Error;
use tracing::{info, warn};

use pg_db::{connect_pool, DbError, PgLeaderElection, PoolKind, PoolSpec};

use crate::auth::{AuthService, REDIS_CONNECT_TIMEOUT};
use crate::config::CoreConfig;
use crate::health::HealthPayload;
use crate::logging::AccessLogSink;
use crate::workers::WorkerRegistry;

#[derive(Debug, Error)]
pub enum StartupError {
    #[error("invalid configuration: {0}")]
    Config(String),
    #[error("database: {0}")]
    Database(#[from] DbError),
    #[error("leader election: {0}")]
    Leader(String),
    #[error("KMS_MASTER_KEY is required to verify sessions")]
    MasterKeyMissing,
    #[error("Redis: {0}")]
    Redis(String),
}

/// The leader-election probe result reported on `/health`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LeaderProbe {
    pub ok: Option<bool>,
    pub at: Option<DateTime<Utc>>,
}

/// Every pool of the process.
pub struct Pools {
    pub main: PgPool,
    pub audit: Option<PgPool>,
    pub log: Option<PgPool>,
    pub leader: Option<PgPool>,
}

impl std::fmt::Debug for Pools {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Pools")
            .field("main", &"<pool>")
            .field("audit", &self.audit.is_some())
            .field("log", &self.log.is_some())
            .field("leader", &self.leader.is_some())
            .finish()
    }
}

/// Shared process state handed to every request.
pub struct AppState {
    pub config: Arc<CoreConfig>,
    pub pools: Pools,
    pub auth: AuthService,
    pub leader: Option<Arc<PgLeaderElection>>,
    pub leader_probe: RwLock<LeaderProbe>,
    pub workers: WorkerRegistry,
    pub log_sink: Option<Arc<AccessLogSink>>,
    pub started_at: Instant,
}

impl std::fmt::Debug for AppState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppState")
            .field("release", &self.config.release)
            .field("plane", &self.config.execution_plane)
            .field("pools", &self.pools)
            .field("leader", &self.leader.is_some())
            .field("workers", &self.workers.len())
            .finish()
    }
}

impl AppState {
    /// Open every pool and prepare the process for `serve`.
    pub async fn connect(config: CoreConfig) -> Result<Arc<Self>, StartupError> {
        let master_key = config
            .master_key
            .clone()
            .ok_or(StartupError::MasterKeyMissing)?;
        let main = connect_pool(&config.database.primary).await?;
        let audit = match &config.database.audit {
            Some(spec) => Some(connect_pool(spec).await?),
            None => None,
        };
        let log = match &config.database.log {
            Some(spec) => Some(connect_pool(spec).await?),
            None => None,
        };

        // The leader connection must be pinned to a single backend, so its pool is sized 1
        // (TS uses one dedicated `pg.Client`).
        let leader_spec = dedicated_leader_spec(config.database.leader_or_primary());
        let leader_pool = connect_pool(&leader_spec).await?;

        let mut probe = LeaderProbe::default();
        let leader = if config.workers_enabled {
            let election =
                PgLeaderElection::connect_with_url(leader_pool.clone(), &leader_spec.url)
                    .await
                    .map_err(|error| StartupError::Leader(error.to_string()))?;
            let result = election.probe_session_safety().await;
            probe = LeaderProbe {
                ok: Some(result.is_ok()),
                at: Some(Utc::now()),
            };
            match &result {
                Ok(()) => info!(
                    endpoint = leader_spec
                        .url
                        .split('@')
                        .next_back()
                        .unwrap_or("configured"),
                    "leader-election endpoint verified as session-safe"
                ),
                Err(error) => {
                    // `verifySessionSafety` throws in TS and the process exits.
                    return Err(StartupError::Leader(format!("{error}")));
                }
            }
            Some(Arc::new(election))
        } else {
            None
        };

        let redis = match &config.redis_url {
            Some(url) => match connect_redis(url).await {
                Ok(manager) => Some(manager),
                Err(error) => {
                    warn!(error = %error, "Redis unavailable; session revocation uses the table only");
                    None
                }
            },
            None => None,
        };

        let log_sink = log.as_ref().map(|pool| {
            AccessLogSink::spawn(
                pool.clone(),
                config.log_buffer_max,
                config.log_flush_interval_ms,
            )
        });

        let auth = AuthService::new(main.clone(), master_key, config.execution_plane, redis);

        Ok(Arc::new(Self {
            config: Arc::new(config),
            pools: Pools {
                main,
                audit,
                log,
                leader: Some(leader_pool),
            },
            auth,
            leader,
            leader_probe: RwLock::new(probe),
            workers: WorkerRegistry::new(),
            log_sink,
            started_at: Instant::now(),
        }))
    }

    /// Uptime in whole seconds.
    #[must_use]
    pub fn uptime_seconds(&self) -> u64 {
        self.started_at.elapsed().as_secs()
    }

    /// Build the `/health` payload (queue probe included).
    pub async fn health(&self, now: DateTime<Utc>) -> HealthPayload {
        crate::health::snapshot(self, now).await
    }

    /// Release every resource. Called once from the shutdown path.
    pub async fn close(&self) {
        if let Some(sink) = &self.log_sink {
            info!(dropped = sink.dropped(), "access-log sink stopping");
        }
        if let Some(leader) = &self.leader {
            for key in leader.held() {
                let _ = leader.release(&key).await;
            }
        }
        if let Some(pool) = &self.pools.leader {
            pool.close().await;
        }
        if let Some(pool) = &self.pools.audit {
            pool.close().await;
        }
        if let Some(pool) = &self.pools.log {
            pool.close().await;
        }
        self.pools.main.close().await;
    }
}

/// Force a leader pool of one connection on the configured URL.
#[must_use]
pub fn dedicated_leader_spec(spec: &PoolSpec) -> PoolSpec {
    let mut leader = spec.clone();
    leader.kind = PoolKind::Leader;
    leader.tuning.max_connections = 1;
    leader
}

async fn connect_redis(url: &str) -> Result<ConnectionManager, String> {
    let client = redis::Client::open(url).map_err(|error| error.to_string())?;
    match tokio::time::timeout(REDIS_CONNECT_TIMEOUT, client.get_connection_manager()).await {
        Ok(Ok(manager)) => Ok(manager),
        Ok(Err(error)) => Err(error.to_string()),
        Err(_) => Err("connect timed out".to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pg_db::{PoolSpec, PoolTuning};

    #[test]
    fn leader_pool_is_single_connection() {
        let spec = PoolSpec {
            kind: PoolKind::Main,
            url: "postgresql://u@127.0.0.1:5432/app".to_owned(),
            tuning: PoolTuning::default(),
        };
        let leader = dedicated_leader_spec(&spec);
        assert_eq!(leader.kind, PoolKind::Leader);
        assert_eq!(leader.tuning.max_connections, 1);
        // The source spec is untouched.
        assert_eq!(spec.tuning.max_connections, 20);
    }
}

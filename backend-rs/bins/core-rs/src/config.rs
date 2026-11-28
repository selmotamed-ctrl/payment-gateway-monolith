//! Core configuration: the subset of `core-back/lib/env/index.ts` the P3 shell needs.
//!
//! Every key name, default and cross-field rule is copied from the TS zod schema. Rust-only knobs
//! are marked `DEV` and only exist where the shell needs them (`MTLS_REQUIRED` for plain-HTTP
//! development and tests). Unknown keys are ignored like process environment; secrets are read as
//! `SecretValue` where the TS code treats them as secret.

#![forbid(unsafe_code)]

use std::path::PathBuf;
use std::time::Duration;

use pg_config::{ConfigError, Env};
use pg_db::{verify_session_safety_error, DatabaseConfig, PoolTuning};
use pg_domain_auth::ExecutionPlane;

/// Default `PORT` (`core-back/lib/env/index.ts:46`).
pub const DEFAULT_PORT: u16 = 4000;
/// Default `HOST`.
pub const DEFAULT_HOST: &str = "127.0.0.1";
/// `WORKER_BACKGROUND_JOBS_MAX_QUEUE_AGE_MS` default.
pub const DEFAULT_QUEUE_THRESHOLD_MS: u64 = 300_000;
/// `STORAGE_LOG_BUFFER_MAX` default.
pub const DEFAULT_LOG_BUFFER_MAX: usize = 5_000;
/// `STORAGE_LOG_FLUSH_INTERVAL_MS` default (TS flushes every 250 ms).
pub const DEFAULT_LOG_FLUSH_INTERVAL_MS: u64 = 250;

/// Files of the internal mTLS material.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MtlsPaths {
    pub ca_cert: PathBuf,
    pub server_cert: PathBuf,
    pub server_key: PathBuf,
}

/// Everything the P3 shell reads from the environment.
#[derive(Debug, Clone)]
pub struct CoreConfig {
    pub host: String,
    pub port: u16,
    /// `MTLS_REQUIRED` (DEV knob, default `true`): `false` serves plain HTTP and skips the CN gate
    /// so a developer or a test can call the shell without certificates.
    pub mtls_required: bool,
    pub mtls: Option<MtlsPaths>,
    /// `KMS_MASTER_KEY`, used to derive the session signing key.
    pub master_key: Option<String>,
    pub execution_plane: ExecutionPlane,
    pub redis_url: Option<String>,
    pub release: Option<String>,
    pub commit: Option<String>,
    pub node_id: Option<String>,
    pub workers_enabled: bool,
    pub background_jobs_enabled: bool,
    pub background_jobs_drained_externally: bool,
    pub queue_threshold_ms: u64,
    pub log_buffer_max: usize,
    pub log_flush_interval_ms: u64,
    pub database: DatabaseConfig,
}

impl CoreConfig {
    /// Read the environment exactly like the TS schema (`.env`, then process, then systemd
    /// credentials).
    pub fn from_env(env: &Env) -> Result<Self, ConfigError> {
        let port = env.u16("PORT", DEFAULT_PORT)?;
        let host = env
            .get_non_empty("HOST")
            .unwrap_or_else(|| DEFAULT_HOST.to_owned());
        let mtls_required = env.bool("MTLS_REQUIRED", true)?;

        let combined = [
            env.get_non_empty("MTLS_CA_CERT_PATH"),
            env.get_non_empty("MTLS_SERVER_CERT_PATH"),
            env.get_non_empty("MTLS_SERVER_KEY_PATH"),
        ];
        let mtls = match combined {
            [Some(ca), Some(cert), Some(key)] => Some(MtlsPaths {
                ca_cert: ca.into(),
                server_cert: cert.into(),
                server_key: key.into(),
            }),
            [None, None, None] => None,
            _ => {
                return Err(ConfigError::new(
                    "MTLS_CA_CERT_PATH",
                    "MTLS_CA_CERT_PATH, MTLS_SERVER_CERT_PATH and MTLS_SERVER_KEY_PATH must be set together",
                ))
            }
        };
        if mtls_required && mtls.is_none() {
            return Err(ConfigError::new(
                "MTLS_CA_CERT_PATH",
                "MTLS_CA_CERT_PATH, MTLS_SERVER_CERT_PATH and MTLS_SERVER_KEY_PATH are required",
            ));
        }

        let master_key = env.get_non_empty("KMS_MASTER_KEY");
        if master_key.as_deref().is_some_and(|key| key.len() < 16) {
            return Err(ConfigError::new(
                "KMS_MASTER_KEY",
                "KMS_MASTER_KEY must be at least 16 characters long",
            ));
        }

        let execution_plane =
            match ExecutionPlane::parse(env.get_non_empty("EXECUTION_PLANE").as_deref()) {
                Some(plane) => plane,
                None => {
                    return Err(ConfigError::new(
                        "EXECUTION_PLANE",
                        "EXECUTION_PLANE must be LIVE or SANDBOX",
                    ))
                }
            };

        let redis_url = resolve_redis_url(env);

        let pgbouncer = env.bool("PGBOUNCER_ENABLED", false)?;
        let database_url = env.require("DATABASE_URL")?;
        let leader_url = env.get_non_empty("LEADER_ELECTION_DATABASE_URL");
        if let Some(error) =
            verify_session_safety_error(pgbouncer, leader_url.as_deref(), &database_url)
        {
            return Err(ConfigError::new("LEADER_ELECTION_DATABASE_URL", error));
        }

        let tuning = PoolTuning {
            max_connections: pg_db::DEFAULT_MAX_CONNECTIONS,
            acquire_timeout_ms: env.u64(
                "PG_POOL_CONNECT_TIMEOUT_MS",
                pg_db::DEFAULT_ACQUIRE_TIMEOUT_MS,
            )?,
            idle_timeout_ms: pg_db::DEFAULT_IDLE_TIMEOUT_MS,
            statement_cache: env
                .u64(
                    "PG_STATEMENT_CACHE",
                    u64::from(pg_db::DEFAULT_STATEMENT_CACHE),
                )?
                .try_into()
                .unwrap_or(pg_db::DEFAULT_STATEMENT_CACHE),
        };
        let database = DatabaseConfig::from_values(
            &database_url,
            env.get_non_empty("DATABASE_REPLICA_URLS")
                .as_deref()
                .unwrap_or_default(),
            env.get_non_empty("AUDIT_DATABASE_URL").as_deref(),
            env.get_non_empty("LOG_DATABASE_URL").as_deref(),
            leader_url.as_deref(),
            env.get_non_empty("REPORT_READONLY_DATABASE_URL").as_deref(),
            tuning,
        )
        .map_err(|error| ConfigError::new("DATABASE_URL", error.to_string()))?;

        Ok(Self {
            host,
            port,
            mtls_required,
            mtls,
            master_key,
            execution_plane,
            redis_url,
            release: env.get_non_empty("APP_RELEASE"),
            commit: env
                .get_non_empty("APP_COMMIT")
                .or_else(|| env.get_non_empty("GIT_COMMIT")),
            node_id: env.get_non_empty("NODE_ID"),
            workers_enabled: env.bool("WORKER_ENABLED", true)?,
            background_jobs_enabled: env.bool("WORKER_BACKGROUND_JOBS_ENABLED", true)?,
            background_jobs_drained_externally: env
                .bool("WORKER_BACKGROUND_JOBS_DRAINED_EXTERNALLY", false)?,
            queue_threshold_ms: env.u64(
                "WORKER_BACKGROUND_JOBS_MAX_QUEUE_AGE_MS",
                DEFAULT_QUEUE_THRESHOLD_MS,
            )?,
            log_buffer_max: usize::try_from(
                env.u64("STORAGE_LOG_BUFFER_MAX", DEFAULT_LOG_BUFFER_MAX as u64)?,
            )
            .unwrap_or(DEFAULT_LOG_BUFFER_MAX),
            log_flush_interval_ms: env.u64(
                "STORAGE_LOG_FLUSH_INTERVAL_MS",
                DEFAULT_LOG_FLUSH_INTERVAL_MS,
            )?,
            database,
        })
    }

    /// The release label the TS health payload reports (`process.env.APP_RELEASE ?? null`).
    #[must_use]
    pub fn release_or_null(&self) -> serde_json::Value {
        self.release
            .as_ref()
            .map_or(serde_json::Value::Null, |value| {
                serde_json::Value::String(value.clone())
            })
    }

    /// `process.env.APP_COMMIT ?? null`.
    #[must_use]
    pub fn commit_or_null(&self) -> serde_json::Value {
        self.commit
            .as_ref()
            .map_or(serde_json::Value::Null, |value| {
                serde_json::Value::String(value.clone())
            })
    }

    /// A configuration for tests and embedders: plain HTTP, explicit database and master key.
    #[must_use]
    pub fn for_tests(database_url: &str, master_key: &str) -> Self {
        let tuning = PoolTuning::default();
        Self {
            host: DEFAULT_HOST.to_owned(),
            port: 0,
            mtls_required: false,
            mtls: None,
            master_key: Some(master_key.to_owned()),
            execution_plane: ExecutionPlane::Live,
            redis_url: None,
            release: None,
            commit: None,
            node_id: None,
            workers_enabled: false,
            background_jobs_enabled: false,
            background_jobs_drained_externally: true,
            queue_threshold_ms: DEFAULT_QUEUE_THRESHOLD_MS,
            log_buffer_max: DEFAULT_LOG_BUFFER_MAX,
            log_flush_interval_ms: DEFAULT_LOG_FLUSH_INTERVAL_MS,
            database: DatabaseConfig::from_values(database_url, "", None, None, None, None, tuning)
                .expect("the test database URL must parse"),
        }
    }

    /// Check the mTLS files exist, with the legacy startup message (`index.ts:55-63`).
    pub fn validate_files(&self) -> Result<(), ConfigError> {
        let Some(mtls) = &self.mtls else {
            return Ok(());
        };
        for (label, key, path) in [
            (
                "internal CA certificate",
                "MTLS_CA_CERT_PATH",
                &mtls.ca_cert,
            ),
            (
                "mTLS server certificate",
                "MTLS_SERVER_CERT_PATH",
                &mtls.server_cert,
            ),
            ("mTLS server key", "MTLS_SERVER_KEY_PATH", &mtls.server_key),
        ] {
            if !path.is_file() {
                return Err(ConfigError::new(
                    key,
                    format!(
                        "Unable to read {label} from '{}'. Run 'bun run generate-mtls-certs' before starting core-back.",
                        path.display()
                    ),
                ));
            }
        }
        Ok(())
    }

    /// Connection acquire budget of the main pool.
    #[must_use]
    pub fn acquire_timeout(&self) -> Duration {
        Duration::from_millis(self.database.primary.tuning.acquire_timeout_ms)
    }
}

/// `REDIS_URL` else `redis://<first REDIS_NODES entry>` (`storageEngine/index.ts:84-90`).
#[must_use]
pub fn resolve_redis_url(env: &Env) -> Option<String> {
    if let Some(url) = env
        .get_non_empty("REDIS_URL")
        .filter(|value| !value.trim().is_empty())
    {
        return Some(url);
    }
    env.get_non_empty("REDIS_NODES")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .find(|node| !node.is_empty())
        .map(|node| format!("redis://{node}"))
}

/// `assertBackgroundJobQueueDrainable` (`productionRuntime.ts:224`).
///
/// The statement upload and dispute intake are queue-only routes: a process that cannot drain the
/// durable jobs refuses to start unless another runtime was explicitly handed the queue.
pub fn assert_background_job_queue_drainable(
    worker_enabled: bool,
    background_jobs_enabled: bool,
    drained_externally: bool,
) -> Result<(), String> {
    if !worker_enabled && !drained_externally {
        return Err(
            "Refusing to start core-back: WORKER_ENABLED is disabled while the statement \
             upload and the dispute intake are queue-only routes (202 Accepted). Enable \
             WORKER_ENABLED, set WORKER_BACKGROUND_JOBS_DRAINED_EXTERNALLY=true, or jobs will \
             be accepted and never executed."
                .to_owned(),
        );
    }
    if !background_jobs_enabled && !drained_externally {
        return Err(
            "Refusing to start core-back: WORKER_BACKGROUND_JOBS_ENABLED is disabled while the \
             statement upload and the dispute intake are queue-only routes (202 Accepted). Every \
             queued job would be stranded without a drain. Set \
             WORKER_BACKGROUND_JOBS_DRAINED_EXTERNALLY=true when another runtime drains the queue."
                .to_owned(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_env() -> Env {
        Env::process()
            .with_value("DATABASE_URL", "postgresql://postgres@127.0.0.1:5432/app")
            .with_value("MTLS_REQUIRED", "false")
            .with_value("KMS_MASTER_KEY", "0123456789abcdef0123456789abcdef")
    }

    #[test]
    fn defaults_match_the_ts_schema() {
        let config = CoreConfig::from_env(&base_env()).expect("config");
        assert_eq!(config.port, DEFAULT_PORT);
        assert_eq!(config.host, DEFAULT_HOST);
        assert!(!config.mtls_required);
        assert_eq!(config.execution_plane, ExecutionPlane::Live);
        assert!(config.workers_enabled);
        assert!(config.background_jobs_enabled);
        assert_eq!(config.queue_threshold_ms, DEFAULT_QUEUE_THRESHOLD_MS);
        assert_eq!(config.log_buffer_max, DEFAULT_LOG_BUFFER_MAX);
        assert_eq!(
            config.database.primary.url,
            "postgresql://postgres@127.0.0.1:5432/app"
        );
    }

    #[test]
    fn mtls_files_must_be_configured_together() {
        let env = base_env()
            .with_value("MTLS_REQUIRED", "true")
            .with_value("MTLS_CA_CERT_PATH", "/tmp/ca.pem");
        let error = CoreConfig::from_env(&env).expect_err("partial mTLS is refused");
        assert_eq!(error.key, "MTLS_CA_CERT_PATH");
    }

    #[test]
    fn a_short_master_key_is_refused() {
        let env = base_env().with_value("KMS_MASTER_KEY", "short");
        let error = CoreConfig::from_env(&env).expect_err("short key");
        assert_eq!(error.key, "KMS_MASTER_KEY");
    }

    #[test]
    fn redis_falls_back_to_the_first_node() {
        let env = Env::process().with_value("REDIS_NODES", " 10.0.0.1:6379 , 10.0.0.2:6379");
        assert_eq!(
            resolve_redis_url(&env),
            Some("redis://10.0.0.1:6379".to_owned())
        );
        let env = Env::process().with_value("REDIS_URL", "redis://cache:6379");
        assert_eq!(
            resolve_redis_url(&env),
            Some("redis://cache:6379".to_owned())
        );
    }

    #[test]
    fn queue_drain_gate_matches_the_ts_rule() {
        assert!(assert_background_job_queue_drainable(true, true, false).is_ok());
        assert!(assert_background_job_queue_drainable(false, true, true).is_ok());
        assert!(assert_background_job_queue_drainable(false, true, false).is_err());
        assert!(assert_background_job_queue_drainable(true, false, false).is_err());
        assert_eq!(
            assert_background_job_queue_drainable(false, false, true),
            Ok(())
        );
    }
}

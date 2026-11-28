//! Connection pools for the main, replica, audit, log, leader and report-read-only databases.
//!
//! Port of `core-back/lib/storageEngine/index.ts` (pool construction),
//! `core-back/lib/db/connectionConfig.ts` (`buildPostgresPoolConfig`) and
//! `core-back/lib/db/waitBudgets.ts`.
//!
//! Every pool:
//! - normalises the URL (`sslmode=no-verify` → TLS required without certificate verification,
//!   `connection_limit` / `pool_max` → `max_connections`; [`crate::url`]);
//! - pins the session timezone to UTC in `after_connect`, because PgBouncer may drop the startup
//!   `options` string (GAP-030);
//! - carries the TS `application_name` (`pg-core-back`, `pg-core-back-leader`,
//!   `report_engine_readonly_line`) so DBA tooling and the platform monitor keep seeing the same
//!   labels;
//! - waits a bounded time for a connection (`PG_POOL_CONNECT_TIMEOUT_MS`, default 5,000 ms).

#![forbid(unsafe_code)]

use std::time::Duration;

use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions};

use crate::error::DbError;
use crate::url::{parse_pool_url, ApplicationName, DatabaseUrl, PoolSettings};

/// Default pooled connections (`connection_limit` fallback, chapter 2 §18).
pub const DEFAULT_MAX_CONNECTIONS: u32 = 20;
/// Audit and log pools hold few connections (TS uses `max: 5`).
pub const DEFAULT_AUX_MAX_CONNECTIONS: u32 = 5;
/// `PG_POOL_CONNECT_TIMEOUT_MS` default.
pub const DEFAULT_ACQUIRE_TIMEOUT_MS: u64 = 5_000;
/// node-postgres `idleTimeoutMillis`.
pub const DEFAULT_IDLE_TIMEOUT_MS: u64 = 30_000;
/// `PG_STATEMENT_CACHE` default; `0` disables the cache for PgBouncer compatibility.
pub const DEFAULT_STATEMENT_CACHE: u32 = 256;

/// Which database a pool talks to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PoolKind {
    Main,
    Replica,
    Audit,
    Log,
    Leader,
    ReportReadonly,
}

impl PoolKind {
    /// The `application_name` the TS driver uses.
    #[must_use]
    pub fn application_name(self) -> ApplicationName {
        match self {
            Self::Main | Self::Replica | Self::Audit | Self::Log => ApplicationName::Core,
            Self::Leader => ApplicationName::Leader,
            Self::ReportReadonly => ApplicationName::ReportReadonly,
        }
    }

    /// The environment key that supplies the URL.
    #[must_use]
    pub fn url_key(self) -> &'static str {
        match self {
            Self::Main => "DATABASE_URL",
            Self::Replica => "DATABASE_REPLICA_URLS",
            Self::Audit => "AUDIT_DATABASE_URL",
            Self::Log => "LOG_DATABASE_URL",
            Self::Leader => "LEADER_ELECTION_DATABASE_URL",
            Self::ReportReadonly => "REPORT_READONLY_DATABASE_URL",
        }
    }

    /// Audit and log pools are sized like the TS `max: 5` pools.
    #[must_use]
    pub fn default_max_connections(self) -> u32 {
        match self {
            Self::Audit | Self::Log => DEFAULT_AUX_MAX_CONNECTIONS,
            _ => DEFAULT_MAX_CONNECTIONS,
        }
    }

    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Main => "main",
            Self::Replica => "replica",
            Self::Audit => "audit",
            Self::Log => "log",
            Self::Leader => "leader",
            Self::ReportReadonly => "report-readonly",
        }
    }
}

/// Pool knobs shared by every pool of one process.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PoolTuning {
    pub max_connections: u32,
    pub acquire_timeout_ms: u64,
    pub idle_timeout_ms: u64,
    pub statement_cache: u32,
}

impl Default for PoolTuning {
    fn default() -> Self {
        Self {
            max_connections: DEFAULT_MAX_CONNECTIONS,
            acquire_timeout_ms: DEFAULT_ACQUIRE_TIMEOUT_MS,
            idle_timeout_ms: DEFAULT_IDLE_TIMEOUT_MS,
            statement_cache: DEFAULT_STATEMENT_CACHE,
        }
    }
}

impl PoolTuning {
    fn pool_settings(self) -> PoolSettings {
        PoolSettings {
            max_connections: self.max_connections,
            acquire_timeout_ms: self.acquire_timeout_ms,
            idle_timeout_ms: self.idle_timeout_ms,
            statement_cache: self.statement_cache,
        }
    }
}

/// One configured pool.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PoolSpec {
    pub kind: PoolKind,
    /// The URL exactly as configured (never logged; `DatabaseUrl::redacted` is used instead).
    pub url: String,
    pub tuning: PoolTuning,
}

impl PoolSpec {
    /// Parse and normalise the URL for this pool.
    pub fn database_url(&self) -> Result<DatabaseUrl, DbError> {
        Ok(parse_pool_url(
            &self.url,
            self.kind.application_name(),
            self.tuning.pool_settings(),
        )?)
    }

    /// sqlx connection options (password applied, UTC pinned through `after_connect`).
    ///
    /// Private on purpose: sqlx's `Debug` prints the password, so the options never leave this
    /// crate. [`connect_pool`] is the only consumer.
    fn connect_options(&self) -> Result<PgConnectOptions, DbError> {
        let parsed = self.database_url()?;
        let mut options = parsed.connect_options()?;
        if let Some(password) = parsed.password() {
            options = options.password(&password);
        }
        let capacity = usize::try_from(parsed.pool.statement_cache).unwrap_or(256);
        Ok(options.statement_cache_capacity(capacity))
    }
}

/// All databases of one process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DatabaseConfig {
    pub primary: PoolSpec,
    pub replicas: Vec<PoolSpec>,
    pub audit: Option<PoolSpec>,
    pub log: Option<PoolSpec>,
    pub leader: Option<PoolSpec>,
    pub report_readonly: Option<PoolSpec>,
}

impl DatabaseConfig {
    /// Build from the environment values, reproducing `createStorageEngine`:
    /// replicas are a comma-separated list of postgres URLs; audit/log/leader/report are optional.
    pub fn from_values(
        primary_url: &str,
        replica_urls: &str,
        audit_url: Option<&str>,
        log_url: Option<&str>,
        leader_url: Option<&str>,
        report_url: Option<&str>,
        tuning: PoolTuning,
    ) -> Result<Self, DbError> {
        let primary = PoolSpec {
            kind: PoolKind::Main,
            url: primary_url.to_owned(),
            tuning,
        };
        parse_pool_url(primary_url, ApplicationName::Core, tuning.pool_settings())?;
        let replicas = parse_postgres_url_list(replica_urls)
            .into_iter()
            .map(|url| PoolSpec {
                kind: PoolKind::Replica,
                url,
                tuning,
            })
            .collect();
        let optional = |kind: PoolKind, url: Option<&str>| -> Option<PoolSpec> {
            url.map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|url| PoolSpec {
                    kind,
                    url: url.to_owned(),
                    tuning: PoolTuning {
                        max_connections: kind.default_max_connections(),
                        ..tuning
                    },
                })
        };
        Ok(Self {
            primary,
            replicas,
            audit: optional(PoolKind::Audit, audit_url),
            log: optional(PoolKind::Log, log_url),
            leader: optional(PoolKind::Leader, leader_url),
            report_readonly: optional(PoolKind::ReportReadonly, report_url),
        })
    }

    /// `LEADER_ELECTION_DATABASE_URL`, else the primary (TS `storageEngine/index.ts`).
    #[must_use]
    pub fn leader_or_primary(&self) -> &PoolSpec {
        self.leader.as_ref().unwrap_or(&self.primary)
    }

    /// True when the leader pool is a distinct endpoint.
    #[must_use]
    pub fn has_dedicated_leader(&self) -> bool {
        self.leader.is_some()
    }
}

/// `parsePostgresUrlList`: trim, drop empties and non-postgres schemes.
#[must_use]
pub fn parse_postgres_url_list(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(str::trim)
        .filter(|entry| is_postgres_url(entry))
        .map(str::to_owned)
        .collect()
}

/// `isPostgresUrl`.
#[must_use]
pub fn is_postgres_url(raw: &str) -> bool {
    matches!(
        url::Url::parse(raw).map(|parsed| parsed.scheme().to_owned()),
        Ok(scheme) if scheme == "postgres" || scheme == "postgresql"
    )
}

/// Open a pool with the documented knobs and UTC pinned on every new connection.
pub async fn connect_pool(spec: &PoolSpec) -> Result<PgPool, DbError> {
    let parsed = spec.database_url()?;
    let options = spec.connect_options()?;
    let pool = PgPoolOptions::new()
        .max_connections(parsed.pool.max_connections.max(1))
        .acquire_timeout(Duration::from_millis(parsed.pool.acquire_timeout_ms))
        .idle_timeout(Some(Duration::from_millis(parsed.pool.idle_timeout_ms)))
        .after_connect(|connection, _metadata| {
            Box::pin(async move {
                // PgBouncer may drop the startup `options`, so the timezone is set on every
                // connection as well (`utcSession.ts`).
                sqlx::query("SET TIME ZONE 'UTC'")
                    .execute(&mut *connection)
                    .await?;
                Ok(())
            })
        })
        .connect_with(options)
        .await?;
    Ok(pool)
}

/// Sanitised endpoint identity (`leaderElection.ts:parseEndpoint`), safe for `/health` and logs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EndpointIdentity {
    pub host: String,
    pub port: u16,
    pub database: String,
}

impl EndpointIdentity {
    #[must_use]
    pub fn from_spec(spec: &PoolSpec) -> Option<Self> {
        let parsed = url::Url::parse(&spec.url).ok()?;
        let host = parsed.host_str()?.to_owned();
        Some(Self {
            host,
            port: parsed.port().unwrap_or(5432),
            database: parsed.path().trim_start_matches('/').to_owned(),
        })
    }

    #[must_use]
    pub fn display(&self) -> String {
        format!("{}:{}/{}", self.host, self.port, self.database)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audit_and_log_are_sized_like_the_ts_pools() {
        let config = DatabaseConfig::from_values(
            "postgresql://u@127.0.0.1:5432/app",
            "",
            Some("postgresql://u@127.0.0.1:5432/audit"),
            Some(""),
            None,
            None,
            PoolTuning::default(),
        )
        .expect("config");
        assert_eq!(
            config.audit.as_ref().expect("audit").tuning.max_connections,
            DEFAULT_AUX_MAX_CONNECTIONS
        );
        assert!(config.log.is_none(), "an empty URL means the pool is off");
        assert_eq!(config.leader_or_primary().kind, PoolKind::Main);
    }

    #[test]
    fn replicas_drop_non_postgres_entries() {
        let urls =
            parse_postgres_url_list(" postgres://a/db1 , mysql://b/db2, ,postgresql://c/db3 ");
        assert_eq!(urls, vec!["postgres://a/db1", "postgresql://c/db3"]);
    }

    #[test]
    fn application_names_match_the_contract() {
        assert_eq!(PoolKind::Main.application_name().as_str(), "pg-core-back");
        assert_eq!(
            PoolKind::Leader.application_name().as_str(),
            "pg-core-back-leader"
        );
        assert_eq!(
            PoolKind::ReportReadonly.application_name().as_str(),
            "report_engine_readonly_line"
        );
    }

    #[test]
    fn sslmode_is_normalised_and_the_password_reaches_the_options() {
        let spec = PoolSpec {
            kind: PoolKind::Main,
            url: "postgresql://user:secret@db:6432/app?sslmode=no-verify&connection_limit=7"
                .to_owned(),
            tuning: PoolTuning::default(),
        };
        let parsed = spec.database_url().expect("url");
        assert_eq!(parsed.ssl_mode, crate::url::SslMode::Require);
        assert_eq!(parsed.pool.max_connections, 7);
        assert_eq!(parsed.password().as_deref(), Some("secret"));
        assert!(!parsed.redacted().contains("secret"));
    }

    #[test]
    fn endpoint_identity_hides_credentials() {
        let spec = PoolSpec {
            kind: PoolKind::Leader,
            url: "postgresql://user:pw@127.0.0.1:6432/payment_gateway_prod?sslmode=no-verify"
                .to_owned(),
            tuning: PoolTuning::default(),
        };
        let endpoint = EndpointIdentity::from_spec(&spec).expect("endpoint");
        assert_eq!(endpoint.display(), "127.0.0.1:6432/payment_gateway_prod");
    }
}

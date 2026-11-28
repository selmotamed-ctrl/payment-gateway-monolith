//! Storage settings: defaults, `[storage]` overrides and pure validation (D5).
//!
//! `pg-deploy-config` owns the document and the cross-field rules of the TS `deploy.env`. The
//! D5 provisioners additionally need the knobs of chapters 4 and 7 (`ram_gb`, `io_method`,
//! PgBouncer pool budgets, Redis ACL/Sentinel, ClamAV). Until that crate models them, they live
//! in a `[storage.<component>]` table (top-level `[postgres]`/`[pgbouncer]`/`[clamav]`/
//! `[audit]`/`[log]` are accepted as aliases), parsed by this module and removed before the
//! `pgctl.toml` deserialiser runs. Recorded as a deviation in `DEVIATIONS.md`.

#![forbid(unsafe_code)]

use std::net::IpAddr;

use pg_deploy_config::{is_identifier, validate, DatabaseMode, Environment, PgctlConfig, Role};
use serde::{Deserialize, Serialize};

use super::model::{codes, ProvisionFinding};

/// PostgreSQL major this engine provisions (chapter 4 §3).
pub const POSTGRES_MAJOR: u8 = 18;
/// PGDG signing key (the repository the design pins when the distro has no `postgresql-18`).
pub const PGDG_KEY_URL: &str = "https://www.postgresql.org/media/keys/ACCC4CF8.asc";
/// PGDG apt root.
pub const PGDG_APT_URL: &str = "https://apt.postgresql.org/pub/repos/apt";
/// Default maintenance database.
pub const MAINTENANCE_DATABASE: &str = "postgres";
/// ClamAV loopback port (AUTO-06).
pub const CLAMD_PORT: u16 = 3310;
/// Default Sentinel listener.
pub const SENTINEL_PORT: u16 = 26379;
/// The KYB upload limit clamd must accept.
pub const KYB_UPLOAD_LIMIT_MB: u32 = 25;

/// Where the PostgreSQL packages come from.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PgSource {
    /// Add the PGDG repository and install `postgresql-18` from it (chapter 7 §9).
    #[default]
    Pgdg,
    /// Trust the distribution package to be PostgreSQL 18.
    Distro,
}

/// PostgreSQL 18 asynchronous I/O method.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum IoMethod {
    /// `io_uring` when the kernel supports it and liburing is installed, else `worker`.
    #[default]
    Auto,
    /// Worker threads.
    Worker,
    /// `io_uring` (requires kernel ≥ 5.6 and liburing).
    #[serde(rename = "io_uring", alias = "io-uring")]
    IoUring,
    /// Synchronous I/O.
    Sync,
}

impl IoMethod {
    /// The value written to `postgresql.conf` for a plan (auto resolves to `worker`; the apply
    /// phase re-renders from the `io-uring` probe before writing the file).
    #[must_use]
    pub fn rendered(self) -> &'static str {
        match self {
            Self::Auto | Self::Worker => "worker",
            Self::IoUring => "io_uring",
            Self::Sync => "sync",
        }
    }

    /// The CLI/TOML spelling.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Worker => "worker",
            Self::IoUring => "io_uring",
            Self::Sync => "sync",
        }
    }
}

/// `synchronous_commit` for the ledger cluster.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SyncCommit {
    /// Durable at commit (ledger default, S-DB-12).
    #[default]
    On,
    /// Faster, loses the last commits on a crash (never for production money).
    Off,
    /// Local flush, wait for remote apply.
    RemoteApply,
    /// Local flush, wait for remote flush.
    RemoteWrite,
}

impl SyncCommit {
    /// The GUC value.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::On => "on",
            Self::Off => "off",
            Self::RemoteApply => "remote_apply",
            Self::RemoteWrite => "remote_write",
        }
    }
}

/// High-availability mode.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HaMode {
    /// One primary plus optional streaming replicas (this plan).
    #[default]
    None,
    /// Operator-driven standby promotion (`manual-standby`).
    ManualStandby,
    /// Patroni + etcd (D5-T06, not implemented yet).
    Patroni,
}

impl HaMode {
    /// The CLI/TOML spelling.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::ManualStandby => "manual-standby",
            Self::Patroni => "patroni",
        }
    }
}

/// TLS verification mode for a client link (`sslmode` spelling).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TlsVerify {
    /// Encrypt, do not verify the peer (coexistence with TS self-signed certs).
    Require,
    /// Verify the chain against the internal CA.
    VerifyCa,
    /// Verify chain and hostname (D4-T02 target).
    #[default]
    VerifyFull,
}

impl TlsVerify {
    /// The libpq/PgBouncer spelling.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Require => "require",
            Self::VerifyCa => "verify-ca",
            Self::VerifyFull => "verify-full",
        }
    }

    /// True when the peer certificate chain is verified.
    #[must_use]
    pub fn verifies(self) -> bool {
        !matches!(self, Self::Require)
    }
}

/// Client-certificate policy of a `hostssl` rule.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ClientCertMode {
    /// No client certificate (TS coexistence).
    Off,
    /// Certificate signed by the internal CA, hostname not checked.
    #[default]
    VerifyCa,
    /// Certificate signed by the internal CA, CN must match the database user.
    VerifyFull,
}

impl ClientCertMode {
    /// The `pg_hba.conf` suffix (empty when off).
    #[must_use]
    pub fn hba_suffix(self) -> &'static str {
        match self {
            Self::Off => "",
            Self::VerifyCa => " clientcert=verify-ca",
            Self::VerifyFull => " clientcert=verify-full",
        }
    }
}

/// Redis-compatible engine.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RedisEngine {
    /// `redis-server`.
    #[default]
    Redis,
    /// `valkey` (the Arch replacement of redis).
    Valkey,
}

impl RedisEngine {
    /// The TOML spelling.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Redis => "redis",
            Self::Valkey => "valkey",
        }
    }

    /// The systemd unit candidates, in detection order (port of `redisUnitDetectScript`).
    #[must_use]
    pub fn unit_candidates(self) -> &'static [&'static str] {
        match self {
            Self::Redis => &["redis-server", "redis", "valkey"],
            Self::Valkey => &["valkey", "redis-server", "redis"],
        }
    }

    /// Debian and Arch package names (the TS engine installs `redis-server` on Debian and
    /// `valkey` on Arch, because Arch retired the redis package).
    #[must_use]
    pub fn packages(self) -> (&'static [&'static str], &'static [&'static str]) {
        match self {
            Self::Redis => (&["redis-server"], &["valkey"]),
            Self::Valkey => (&["valkey"], &["valkey"]),
        }
    }
}

/// Sentinel (Redis HA) mode.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SentinelMode {
    /// One Redis/Valkey node, no Sentinel.
    #[default]
    None,
    /// Three Sentinel instances monitoring the primary.
    Sentinel,
}

/// ClamAV management mode.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ClamavMode {
    /// pgctl installs and converges `clamd` on every core host.
    Managed,
    /// An operator runs `clamd` elsewhere (`KYB_CLAMD_ADDRESS` is set).
    External,
    /// No scanner (the TS `eicar` gate or no scanner; documents stay PENDING).
    #[default]
    Disabled,
}

impl ClamavMode {
    /// The TOML spelling.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Managed => "managed",
            Self::External => "external",
            Self::Disabled => "disabled",
        }
    }
}

/// PostgreSQL settings of the plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PostgresSettings {
    /// Major version (fixed at 18).
    pub version: u8,
    /// Package source.
    pub source: PgSource,
    /// Host RAM the memory settings are sized from; `None` keeps the 32 GB reference profile.
    pub ram_gb: Option<u32>,
    /// Asynchronous I/O method.
    pub io_method: IoMethod,
    /// `max_connections` (300 in the TS engine).
    pub max_connections: u16,
    /// `work_mem`.
    pub work_mem_mb: u32,
    /// `synchronous_commit`.
    pub synchronous_commit: SyncCommit,
    /// Use `synchronous_standby_names = 'ANY 1 (...)'` when at least one replica exists.
    pub sync_standbys: bool,
    /// `max_slot_wal_keep_size`.
    pub max_slot_wal_keep_size: String,
    /// `wal_compression = lz4`.
    pub wal_compression: bool,
    /// `log_min_duration_statement` (ms, 0 disables).
    pub log_min_duration_ms: u32,
    /// `hot_standby_feedback` on replicas.
    pub hot_standby_feedback: bool,
    /// Verify `initdb --data-checksums` (required by the design).
    pub data_checksums: bool,
    /// Replication slots (16 in the TS engine).
    pub max_replication_slots: u16,
    /// WAL senders (16 in the TS engine).
    pub max_wal_senders: u16,
    /// `shared_preload_libraries = 'pg_stat_statements'`.
    pub pg_stat_statements: bool,
    /// HA mode.
    pub ha: HaMode,
    /// TLS verification expectation for clients/peers.
    pub tls: TlsVerify,
    /// `pg_hba.conf` client-certificate policy.
    pub client_cert: ClientCertMode,
    /// Re-clone an initialised replica (the TS `PG_REPLICA_REBUILD`).
    pub replica_rebuild: bool,
    /// Role names.
    pub roles: PgRoles,
    /// Application database.
    pub database: String,
    /// Sandbox database, when the parallel plane is enabled.
    pub sandbox_database: Option<String>,
    /// Reference to the owner password (`secret:<name>`).
    pub owner_password: Option<String>,
    /// Reference to the application password.
    pub app_password: Option<String>,
    /// Reference to the replication password.
    pub replication_password: Option<String>,
}

impl Default for PostgresSettings {
    fn default() -> Self {
        Self {
            version: POSTGRES_MAJOR,
            source: PgSource::Pgdg,
            ram_gb: None,
            io_method: IoMethod::Auto,
            max_connections: 300,
            work_mem_mb: 32,
            synchronous_commit: SyncCommit::On,
            // Opt-in after the replica is streaming: rendering `synchronous_standby_names` on a
            // fresh primary would block every commit until the standby connects (S-DB-12 says
            // "benchmark first"). The TS engine leaves it unset.
            sync_standbys: false,
            max_slot_wal_keep_size: "64GB".to_owned(),
            wal_compression: true,
            log_min_duration_ms: 500,
            hot_standby_feedback: true,
            data_checksums: true,
            max_replication_slots: 16,
            max_wal_senders: 16,
            pg_stat_statements: true,
            ha: HaMode::None,
            tls: TlsVerify::VerifyFull,
            // One PgBouncer certificate cannot match two pooled roles under verify-full.
            client_cert: ClientCertMode::VerifyCa,
            replica_rebuild: false,
            roles: PgRoles::default(),
            database: "payment_gateway_prod".to_owned(),
            sandbox_database: None,
            owner_password: None,
            app_password: None,
            replication_password: None,
        }
    }
}

impl PostgresSettings {
    /// Derived memory settings: `(shared_buffers GB, effective_cache_size GB, maintenance_work_mem)`.
    ///
    /// Exact port of `postgresConfigSnippet` in `deploy/provisioners/postgres18Provisioner.ts`:
    /// 25 % shared buffers, 75 % effective cache and `ram_gb * 64` MB maintenance memory clamped
    /// to 256 MB..2 GB (rendered as GB when it divides evenly).
    #[must_use]
    pub fn memory(&self) -> MemorySizing {
        match self.ram_gb {
            Some(ram) => {
                let shared_gb = u32::max(1, ram / 4);
                let cache_gb = u32::max(2, ram.saturating_mul(3) / 4);
                let maintenance_mb = u32::min(2048, u32::max(256, ram.saturating_mul(1024) / 16));
                MemorySizing {
                    shared_buffers: format!("{shared_gb}GB"),
                    effective_cache_size: format!("{cache_gb}GB"),
                    maintenance_work_mem: if maintenance_mb.is_multiple_of(1024) {
                        format!("{}GB", maintenance_mb / 1024)
                    } else {
                        format!("{maintenance_mb}MB")
                    },
                }
            }
            None => MemorySizing {
                shared_buffers: "8GB".to_owned(),
                effective_cache_size: "24GB".to_owned(),
                maintenance_work_mem: "1GB".to_owned(),
            },
        }
    }
}

/// Rendered memory values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MemorySizing {
    /// `shared_buffers`.
    pub shared_buffers: String,
    /// `effective_cache_size`.
    pub effective_cache_size: String,
    /// `maintenance_work_mem`.
    pub maintenance_work_mem: String,
}

/// PostgreSQL role names.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct PgRoles {
    /// Database owner; runs migrations and seeds only.
    pub owner: String,
    /// Runtime login; a member of [`Self::app_group`].
    pub app: String,
    /// Runtime group with DML-only grants.
    pub app_group: String,
    /// Streaming replication role.
    pub replication: String,
}

impl Default for PgRoles {
    fn default() -> Self {
        Self {
            owner: "gw_core_user".to_owned(),
            app: "pgw_app_login".to_owned(),
            app_group: "pgw_app".to_owned(),
            replication: "gw_replicator".to_owned(),
        }
    }
}

/// PgBouncer settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PgbouncerSettings {
    /// Enabled (the TS `PGBOUNCER_ENABLED`).
    pub enabled: bool,
    /// Listener.
    pub port: u16,
    /// `max_client_conn`.
    pub max_client_conn: u32,
    /// `default_pool_size` per (database alias, user) pool.
    pub default_pool_size: u32,
    /// `reserve_pool_size`.
    pub reserve_pool_size: u32,
    /// `max_prepared_statements`.
    pub max_prepared_statements: u32,
    /// Session alias used by leader election and migrations (the TS `pgw_session`).
    pub session_alias: String,
    /// Sandbox aliases, when the plane exists.
    pub sandbox_database: Option<String>,
    /// TLS to PostgreSQL.
    pub server_tls: TlsVerify,
    /// TLS from clients.
    pub client_tls: TlsVerify,
    /// Explicit listener; empty means the host's private address plus loopback.
    pub listen_addr: String,
    /// Per-pool server lifetime in seconds (S-DB-11).
    pub server_lifetime: u32,
    /// Idle server connection timeout in seconds (S-DB-11).
    pub server_idle_timeout: u32,
    /// Core hosts, used to size the session alias pools.
    pub core_nodes: u32,
}

impl Default for PgbouncerSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            port: pg_deploy_config::PGBOUNCER_PORT,
            max_client_conn: 2000,
            default_pool_size: 50,
            reserve_pool_size: 10,
            max_prepared_statements: 256,
            session_alias: "pgw_session".to_owned(),
            sandbox_database: None,
            server_tls: TlsVerify::VerifyFull,
            client_tls: TlsVerify::VerifyFull,
            listen_addr: String::new(),
            server_lifetime: 3600,
            server_idle_timeout: 600,
            core_nodes: 1,
        }
    }
}

impl PgbouncerSettings {
    /// `pool_size` of the session alias, as the TS `pgbouncerIni` computes it.
    #[must_use]
    pub fn session_pool_size(&self) -> u32 {
        u32::max(8, self.core_nodes.saturating_mul(2) + 4)
    }

    /// Users PgBouncer pools for: the owner and the runtime login.
    #[must_use]
    pub fn pool_users(&self, database: &PostgresSettings) -> u32 {
        let mut users = 2;
        if database.app_password.is_none() {
            users = 1;
        }
        users
    }

    /// Server connections the configured aliases can open at once.
    ///
    /// Every alias gets `default_pool_size` per user; the two session aliases use their own
    /// (smaller) size. This is the S-DB-11 budget check.
    #[must_use]
    pub fn server_pool_budget(&self, database: &PostgresSettings) -> u32 {
        let users = self.pool_users(database);
        let aliases = if self.sandbox_database.is_some() {
            4
        } else {
            2
        };
        let main = self.default_pool_size.saturating_mul(users) * (aliases / 2);
        let session = self.session_pool_size().saturating_mul(users) * (aliases / 2);
        main.saturating_add(session)
    }
}

/// Redis/Valkey settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RedisSettings {
    /// Enabled (the TS `REDIS_MANAGE_VIA_SSH`).
    pub enabled: bool,
    /// Engine.
    pub engine: RedisEngine,
    /// Listener.
    pub port: u16,
    /// Logical database.
    pub db: u8,
    /// TLS-only listener (`port 0`, `tls-port`).
    pub tls: bool,
    /// ACL users instead of a single `requirepass`.
    pub acl: bool,
    /// Reference to the default/legacy password.
    pub password: Option<String>,
    /// Reference to the `core` ACL password.
    pub core_password: Option<String>,
    /// Reference to the `worker` ACL password.
    pub worker_password: Option<String>,
    /// Reference to the `backup` ACL password.
    pub backup_password: Option<String>,
    /// `maxmemory`.
    pub maxmemory: String,
    /// `maxmemory-policy` (`volatile-ttl` for the revoke list and throttles).
    pub maxmemory_policy: String,
    /// `appendonly`.
    pub appendonly: bool,
    /// `appendfsync`.
    pub appendfsync: String,
    /// Sentinel mode.
    pub ha: SentinelMode,
    /// Sentinel listener.
    pub sentinel_port: u16,
    /// Sentinel quorum.
    pub sentinel_quorum: u8,
    /// Sentinel hosts as `host:port`; empty means three instances on the Redis host.
    pub sentinel_hosts: Vec<String>,
    /// State directory.
    pub data_dir: String,
}

impl Default for RedisSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            engine: RedisEngine::Redis,
            port: pg_deploy_config::REDIS_PORT,
            db: 0,
            tls: true,
            acl: true,
            password: None,
            core_password: None,
            worker_password: None,
            backup_password: None,
            maxmemory: "4gb".to_owned(),
            maxmemory_policy: "volatile-ttl".to_owned(),
            appendonly: true,
            appendfsync: "everysec".to_owned(),
            ha: SentinelMode::None,
            sentinel_port: SENTINEL_PORT,
            sentinel_quorum: 2,
            sentinel_hosts: Vec::new(),
            data_dir: "/var/lib/pg-redis".to_owned(),
        }
    }
}

impl RedisSettings {
    /// Parse a Redis memory size (`4gb`, `512mb`, `1tb`) into bytes. `None` when malformed.
    #[must_use]
    pub fn parse_memory(value: &str) -> Option<u64> {
        let lowered = value.trim().to_ascii_lowercase();
        let (number, unit) = if let Some(number) = lowered.strip_suffix("tb") {
            (number, 1_099_511_627_776_u64)
        } else if let Some(number) = lowered.strip_suffix("gb") {
            (number, 1_073_741_824)
        } else if let Some(number) = lowered.strip_suffix("mb") {
            (number, 1_048_576)
        } else if let Some(number) = lowered.strip_suffix("kb") {
            (number, 1024)
        } else {
            (lowered.strip_suffix('b')?, 1)
        };
        let amount = number.trim().parse::<u64>().ok()?;
        amount.checked_mul(unit).filter(|bytes| *bytes > 0)
    }
}

/// One audit or log database tier.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct TierSettings {
    /// Database name.
    pub database: String,
    /// Owner role (migrations and DDL).
    pub owner_role: String,
    /// Least-privilege writer role.
    pub writer_role: String,
    /// Reference to the writer password.
    pub writer_password: Option<String>,
    /// Reference to the owner password.
    pub owner_password: Option<String>,
    /// Monthly partitions kept.
    pub retention_months: u32,
    /// Partitions created ahead.
    pub partitions_ahead: u32,
}

fn tier_default(database: &str, owner: &str, writer: &str) -> TierSettings {
    TierSettings {
        database: database.to_owned(),
        owner_role: owner.to_owned(),
        writer_role: writer.to_owned(),
        writer_password: None,
        owner_password: None,
        retention_months: 12,
        partitions_ahead: 6,
    }
}

/// ClamAV settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ClamavSettings {
    /// Managed, external or disabled.
    pub mode: ClamavMode,
    /// External daemon address when [`ClamavMode::External`].
    pub address: String,
    /// Loopback TCP port (managed).
    pub tcp_port: u16,
    /// `StreamMaxLength`/`MaxFileSize`.
    pub stream_max_mb: u32,
    /// Warn below this host memory.
    pub min_memory_mb: u32,
    /// `MaxThreads`.
    pub max_threads: u32,
}

impl Default for ClamavSettings {
    fn default() -> Self {
        Self {
            mode: ClamavMode::Disabled,
            address: String::new(),
            tcp_port: CLAMD_PORT,
            stream_max_mb: 32,
            min_memory_mb: 2048,
            max_threads: 12,
        }
    }
}

/// Every D5 setting.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct StorageSettings {
    /// PostgreSQL.
    pub postgres: PostgresSettings,
    /// PgBouncer.
    pub pgbouncer: PgbouncerSettings,
    /// Redis/Valkey.
    pub redis: RedisSettings,
    /// Audit database.
    pub audit: TierSettings,
    /// Log database.
    pub log: TierSettings,
    /// ClamAV.
    pub clamav: ClamavSettings,
}

// The settings above implement `Default` field by field (they carry non-zero defaults); the
// derived `Default` for the group would call each field's `Default`, which is exactly what we
// want, so no manual impl is needed.

/// A host that carries one of the storage roles.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct HostRef {
    /// Node id.
    pub id: String,
    /// SSH address.
    pub address: String,
    /// LAN address (`private_ip`, falling back to the SSH address).
    pub private_ip: String,
    /// Listener on this host.
    pub port: u16,
}

impl HostRef {
    fn from_host(host: &pg_deploy_config::Host, port: u16) -> Self {
        Self {
            id: host.name.clone(),
            address: host.address.clone(),
            private_ip: if host.private_ip.is_empty() {
                host.address.clone()
            } else {
                host.private_ip.clone()
            },
            port: host.service_port.unwrap_or(port),
        }
    }
}

/// The storage-relevant slice of the fleet.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Topology {
    /// PostgreSQL primary.
    pub primary: Option<HostRef>,
    /// Streaming replicas.
    pub replicas: Vec<HostRef>,
    /// PgBouncer hosts.
    pub pgbouncer: Vec<HostRef>,
    /// Redis/Valkey hosts.
    pub redis: Vec<HostRef>,
    /// Audit database host.
    pub audit: Option<HostRef>,
    /// Log database host.
    pub log: Option<HostRef>,
    /// Core hosts (clamd runs on each).
    pub core: Vec<HostRef>,
    /// Backup hosts (replication/HBA source and WAL consumer).
    pub backup: Vec<HostRef>,
}

impl Topology {
    /// Read the topology from `pgctl.toml`.
    #[must_use]
    pub fn from_config(config: &PgctlConfig) -> Self {
        let primary = config
            .hosts_with_role(Role::PgPrimary)
            .first()
            .map(|host| HostRef::from_host(host, config.database.port))
            .or_else(|| {
                config.database.host.as_ref().map(|host| HostRef {
                    id: "database".to_owned(),
                    address: host.clone(),
                    private_ip: host.clone(),
                    port: config.database.port,
                })
            });
        let replicas = config
            .hosts_with_role(Role::PgReplica)
            .iter()
            .map(|host| HostRef::from_host(host, config.database.port))
            .collect::<Vec<_>>();
        let mut pgbouncer = config
            .hosts_with_role(Role::Pgbouncer)
            .iter()
            .map(|host| HostRef::from_host(host, config.database.pgbouncer_port))
            .collect::<Vec<_>>();
        if pgbouncer.is_empty() && config.database.pgbouncer {
            if let Some(primary) = &primary {
                let mut pooler = primary.clone();
                pooler.port = config.database.pgbouncer_port;
                pgbouncer.push(pooler);
            }
        }
        Self {
            primary,
            replicas,
            pgbouncer,
            redis: config
                .hosts_with_role(Role::Redis)
                .iter()
                .map(|host| HostRef::from_host(host, config.redis.port))
                .collect(),
            audit: config
                .first_host_with_role(Role::AuditDb)
                .map(|host| HostRef::from_host(host, config.database.port)),
            log: config
                .first_host_with_role(Role::LogDb)
                .map(|host| HostRef::from_host(host, config.database.port)),
            core: config
                .hosts_with_role(Role::Core)
                .iter()
                .map(|host| HostRef::from_host(host, config.services.core.port))
                .collect(),
            backup: config
                .hosts_with_role(Role::Backup)
                .iter()
                .map(|host| HostRef::from_host(host, config.services.backup.port))
                .collect(),
        }
    }
}

impl StorageSettings {
    /// Defaults plus everything `pgctl.toml` already models.
    #[must_use]
    pub fn from_config(config: &PgctlConfig) -> Self {
        let topology = Topology::from_config(config);
        let mut settings = Self {
            postgres: PostgresSettings {
                database: config.database.name.clone(),
                sandbox_database: config
                    .sandbox
                    .enabled
                    .then(|| config.sandbox.db_name.clone()),
                roles: PgRoles {
                    owner: config.database.owner_role.clone(),
                    app: config.database.app_role.clone(),
                    replication: config.database.replication_role.clone(),
                    ..PgRoles::default()
                },
                owner_password: config.database.owner_password.clone(),
                app_password: config.database.app_password.clone(),
                replication_password: config.database.replication_password.clone(),
                ..PostgresSettings::default()
            },
            pgbouncer: PgbouncerSettings {
                enabled: config.database.pgbouncer,
                port: config.database.pgbouncer_port,
                sandbox_database: config
                    .sandbox
                    .enabled
                    .then(|| config.sandbox.db_name.clone()),
                core_nodes: u32::try_from(topology.core.len()).unwrap_or(1).max(1),
                ..PgbouncerSettings::default()
            },
            redis: RedisSettings {
                enabled: config.redis.enabled,
                port: config.redis.port,
                db: config.redis.db,
                tls: config.redis.tls,
                password: config.redis.password.clone(),
                ..RedisSettings::default()
            },
            // One owner role (`pgw_owner`) owns both databases, so both tiers use the same
            // password reference; a per-tier override is allowed only when the other tier is
            // absent (otherwise the last apply would rotate the shared role's password).
            audit: TierSettings {
                owner_password: Some("secret:pgw_owner_password".to_owned()),
                writer_password: Some("secret:audit_db_password".to_owned()),
                ..tier_default("payment_gateway_audit", "pgw_owner", "gw_audit_writer")
            },
            log: TierSettings {
                owner_password: Some("secret:pgw_owner_password".to_owned()),
                writer_password: Some("secret:log_db_password".to_owned()),
                ..tier_default("payment_gateway_log", "pgw_owner", "gw_log_writer")
            },
            clamav: ClamavSettings::default(),
        };
        if config.database.mode == DatabaseMode::External {
            // External databases are never provisioned, but the plan still reports the fact.
            settings.postgres.source = PgSource::Distro;
        }
        settings
    }

    /// Defaults, `pgctl.toml` and the `[storage]` overlay.
    #[must_use]
    pub fn resolve(config: &PgctlConfig, overrides: &StorageOverrides) -> Self {
        let mut settings = Self::from_config(config);
        overrides.apply(&mut settings);
        settings
    }
}

/// `[storage.postgres]` overlay.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct PostgresOverrides {
    /// PostgreSQL major (must stay 18).
    pub version: Option<u8>,
    /// Package source.
    pub source: Option<PgSource>,
    /// Host RAM in GB.
    pub ram_gb: Option<u32>,
    /// I/O method.
    pub io_method: Option<IoMethod>,
    /// `max_connections`.
    pub max_connections: Option<u16>,
    /// `work_mem` in MB.
    pub work_mem_mb: Option<u32>,
    /// `synchronous_commit`.
    pub synchronous_commit: Option<SyncCommit>,
    /// Synchronous standbys on the primary.
    pub sync_standbys: Option<bool>,
    /// `max_slot_wal_keep_size`.
    pub max_slot_wal_keep_size: Option<String>,
    /// `wal_compression`.
    pub wal_compression: Option<bool>,
    /// `log_min_duration_statement`.
    pub log_min_duration_ms: Option<u32>,
    /// `hot_standby_feedback` on replicas.
    pub hot_standby_feedback: Option<bool>,
    /// Require `initdb --data-checksums`.
    pub data_checksums: Option<bool>,
    /// Replication slots.
    pub max_replication_slots: Option<u16>,
    /// WAL senders.
    pub max_wal_senders: Option<u16>,
    /// `pg_stat_statements`.
    pub pg_stat_statements: Option<bool>,
    /// HA mode.
    pub ha: Option<HaMode>,
    /// TLS expectation.
    pub tls: Option<TlsVerify>,
    /// Client-certificate policy.
    pub client_cert: Option<ClientCertMode>,
    /// Re-clone replicas.
    pub replica_rebuild: Option<bool>,
    /// Role names.
    pub roles: Option<PgRoles>,
}

/// `[storage.pgbouncer]` overlay.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct PgbouncerOverrides {
    /// Enable the pooler.
    pub enabled: Option<bool>,
    /// Listener.
    pub port: Option<u16>,
    /// `max_client_conn`.
    pub max_client_conn: Option<u32>,
    /// `default_pool_size`.
    pub default_pool_size: Option<u32>,
    /// `reserve_pool_size`.
    pub reserve_pool_size: Option<u32>,
    /// `max_prepared_statements`.
    pub max_prepared_statements: Option<u32>,
    /// Session alias.
    pub session_alias: Option<String>,
    /// TLS to PostgreSQL.
    pub server_tls: Option<TlsVerify>,
    /// Client TLS.
    pub client_tls: Option<TlsVerify>,
    /// Explicit listener.
    pub listen_addr: Option<String>,
    /// `server_lifetime`.
    pub server_lifetime: Option<u32>,
    /// `server_idle_timeout`.
    pub server_idle_timeout: Option<u32>,
}

/// `[storage.redis]` overlay.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct RedisOverrides {
    /// Engine.
    pub engine: Option<RedisEngine>,
    /// Enable the tier.
    pub enabled: Option<bool>,
    /// Listener.
    pub port: Option<u16>,
    /// TLS-only listener.
    pub tls: Option<bool>,
    /// ACL users.
    pub acl: Option<bool>,
    /// Reference to the `core` password.
    pub core_password: Option<String>,
    /// Reference to the `worker` password.
    pub worker_password: Option<String>,
    /// Reference to the `backup` password.
    pub backup_password: Option<String>,
    /// `maxmemory`.
    pub maxmemory: Option<String>,
    /// `maxmemory-policy`.
    pub maxmemory_policy: Option<String>,
    /// `appendonly`.
    pub appendonly: Option<bool>,
    /// `appendfsync`.
    pub appendfsync: Option<String>,
    /// Sentinel mode.
    pub ha: Option<SentinelMode>,
    /// Sentinel port.
    pub sentinel_port: Option<u16>,
    /// Sentinel quorum.
    pub sentinel_quorum: Option<u8>,
    /// Sentinel hosts.
    pub sentinel_hosts: Option<Vec<String>>,
    /// State directory.
    pub data_dir: Option<String>,
}

/// `[storage.audit]` / `[storage.log]` overlay.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct TierOverrides {
    /// Database name.
    pub database: Option<String>,
    /// Owner role.
    pub owner_role: Option<String>,
    /// Writer role.
    pub writer_role: Option<String>,
    /// Reference to the writer password.
    pub writer_password: Option<String>,
    /// Reference to the owner password.
    pub owner_password: Option<String>,
    /// Retention months.
    pub retention_months: Option<u32>,
    /// Partitions ahead.
    pub partitions_ahead: Option<u32>,
}

/// `[storage.clamav]` overlay.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct ClamavOverrides {
    /// Mode.
    pub mode: Option<ClamavMode>,
    /// External daemon address.
    pub address: Option<String>,
    /// Loopback TCP port.
    pub tcp_port: Option<u16>,
    /// `StreamMaxLength`/`MaxFileSize` in MB.
    pub stream_max_mb: Option<u32>,
    /// Memory warning floor.
    pub min_memory_mb: Option<u32>,
    /// `MaxThreads`.
    pub max_threads: Option<u32>,
}

/// The `[storage]` overlay of a `pgctl.toml`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct StorageOverrides {
    /// PostgreSQL.
    #[serde(default)]
    pub postgres: PostgresOverrides,
    /// PgBouncer.
    #[serde(default)]
    pub pgbouncer: PgbouncerOverrides,
    /// Redis.
    #[serde(default)]
    pub redis: RedisOverrides,
    /// Audit database.
    #[serde(default)]
    pub audit: TierOverrides,
    /// Log database.
    #[serde(default)]
    pub log: TierOverrides,
    /// ClamAV.
    #[serde(default)]
    pub clamav: ClamavOverrides,
}

impl StorageOverrides {
    fn apply(&self, settings: &mut StorageSettings) {
        let postgres = &mut settings.postgres;
        assign(&mut postgres.version, &self.postgres.version);
        assign(&mut postgres.source, &self.postgres.source);
        assign_option(&mut postgres.ram_gb, &self.postgres.ram_gb);
        assign(&mut postgres.io_method, &self.postgres.io_method);
        assign(
            &mut postgres.max_connections,
            &self.postgres.max_connections,
        );
        assign(&mut postgres.work_mem_mb, &self.postgres.work_mem_mb);
        assign(
            &mut postgres.synchronous_commit,
            &self.postgres.synchronous_commit,
        );
        assign(&mut postgres.sync_standbys, &self.postgres.sync_standbys);
        assign(
            &mut postgres.max_slot_wal_keep_size,
            &self.postgres.max_slot_wal_keep_size,
        );
        assign(
            &mut postgres.wal_compression,
            &self.postgres.wal_compression,
        );
        assign(
            &mut postgres.log_min_duration_ms,
            &self.postgres.log_min_duration_ms,
        );
        assign(
            &mut postgres.hot_standby_feedback,
            &self.postgres.hot_standby_feedback,
        );
        assign(&mut postgres.data_checksums, &self.postgres.data_checksums);
        assign(
            &mut postgres.max_replication_slots,
            &self.postgres.max_replication_slots,
        );
        assign(
            &mut postgres.max_wal_senders,
            &self.postgres.max_wal_senders,
        );
        assign(
            &mut postgres.pg_stat_statements,
            &self.postgres.pg_stat_statements,
        );
        assign(&mut postgres.ha, &self.postgres.ha);
        assign(&mut postgres.tls, &self.postgres.tls);
        assign(&mut postgres.client_cert, &self.postgres.client_cert);
        assign(
            &mut postgres.replica_rebuild,
            &self.postgres.replica_rebuild,
        );
        assign(&mut postgres.roles, &self.postgres.roles);

        let pgbouncer = &mut settings.pgbouncer;
        assign(&mut pgbouncer.enabled, &self.pgbouncer.enabled);
        assign(&mut pgbouncer.port, &self.pgbouncer.port);
        assign(
            &mut pgbouncer.max_client_conn,
            &self.pgbouncer.max_client_conn,
        );
        assign(
            &mut pgbouncer.default_pool_size,
            &self.pgbouncer.default_pool_size,
        );
        assign(
            &mut pgbouncer.reserve_pool_size,
            &self.pgbouncer.reserve_pool_size,
        );
        assign(
            &mut pgbouncer.max_prepared_statements,
            &self.pgbouncer.max_prepared_statements,
        );
        assign(&mut pgbouncer.session_alias, &self.pgbouncer.session_alias);
        assign(&mut pgbouncer.server_tls, &self.pgbouncer.server_tls);
        assign(&mut pgbouncer.client_tls, &self.pgbouncer.client_tls);
        assign(&mut pgbouncer.listen_addr, &self.pgbouncer.listen_addr);
        assign(
            &mut pgbouncer.server_lifetime,
            &self.pgbouncer.server_lifetime,
        );
        assign(
            &mut pgbouncer.server_idle_timeout,
            &self.pgbouncer.server_idle_timeout,
        );

        let redis = &mut settings.redis;
        assign(&mut redis.engine, &self.redis.engine);
        assign(&mut redis.enabled, &self.redis.enabled);
        assign(&mut redis.port, &self.redis.port);
        assign(&mut redis.tls, &self.redis.tls);
        assign(&mut redis.acl, &self.redis.acl);
        assign_option(&mut redis.core_password, &self.redis.core_password);
        assign_option(&mut redis.worker_password, &self.redis.worker_password);
        assign_option(&mut redis.backup_password, &self.redis.backup_password);
        assign(&mut redis.maxmemory, &self.redis.maxmemory);
        assign(&mut redis.maxmemory_policy, &self.redis.maxmemory_policy);
        assign(&mut redis.appendonly, &self.redis.appendonly);
        assign(&mut redis.appendfsync, &self.redis.appendfsync);
        assign(&mut redis.ha, &self.redis.ha);
        assign(&mut redis.sentinel_port, &self.redis.sentinel_port);
        assign(&mut redis.sentinel_quorum, &self.redis.sentinel_quorum);
        assign(&mut redis.sentinel_hosts, &self.redis.sentinel_hosts);
        assign(&mut redis.data_dir, &self.redis.data_dir);

        apply_tier(&mut settings.audit, &self.audit);
        apply_tier(&mut settings.log, &self.log);

        let clamav = &mut settings.clamav;
        assign(&mut clamav.mode, &self.clamav.mode);
        assign(&mut clamav.address, &self.clamav.address);
        assign(&mut clamav.tcp_port, &self.clamav.tcp_port);
        assign(&mut clamav.stream_max_mb, &self.clamav.stream_max_mb);
        assign(&mut clamav.min_memory_mb, &self.clamav.min_memory_mb);
        assign(&mut clamav.max_threads, &self.clamav.max_threads);
    }
}

fn apply_tier(tier: &mut TierSettings, overrides: &TierOverrides) {
    assign(&mut tier.database, &overrides.database);
    assign(&mut tier.owner_role, &overrides.owner_role);
    assign(&mut tier.writer_role, &overrides.writer_role);
    assign_option(&mut tier.writer_password, &overrides.writer_password);
    assign_option(&mut tier.owner_password, &overrides.owner_password);
    assign(&mut tier.retention_months, &overrides.retention_months);
    assign(&mut tier.partitions_ahead, &overrides.partitions_ahead);
}

fn assign<T: Clone>(target: &mut T, source: &Option<T>) {
    if let Some(value) = source {
        *target = value.clone();
    }
}

fn assign_option<T: Clone>(target: &mut Option<T>, source: &Option<T>) {
    if source.is_some() {
        *target = source.clone();
    }
}

/// Validate the D5 settings against the topology.
#[must_use]
pub fn validate_storage(
    settings: &StorageSettings,
    topology: &Topology,
    config: &PgctlConfig,
) -> Vec<ProvisionFinding> {
    let mut findings = Vec::new();
    let postgres = &settings.postgres;
    if postgres.version != POSTGRES_MAJOR {
        findings.push(ProvisionFinding::error(
            codes::POSTGRES_VERSION,
            "storage.postgres.version",
            format!(
                "this engine provisions PostgreSQL {POSTGRES_MAJOR} only (asked for {}); raise the engine, not the setting",
                postgres.version
            ),
        ));
    }
    if let Some(ram) = postgres.ram_gb {
        if !(1..=4096).contains(&ram) {
            findings.push(ProvisionFinding::error(
                codes::POSTGRES_RAM,
                "storage.postgres.ram_gb",
                format!("ram_gb={ram} is outside 1..=4096 GB"),
            ));
        } else if ram > 1024 {
            findings.push(ProvisionFinding::warning(
                codes::POSTGRES_RAM,
                "storage.postgres.ram_gb",
                format!(
                    "ram_gb={ram}: shared_buffers would be {} GB; confirm this is a single database host",
                    postgres.memory().shared_buffers
                ),
            ));
        }
    }
    if postgres.max_connections < 20 {
        findings.push(ProvisionFinding::error(
            codes::POSTGRES_MAX_CONNECTIONS,
            "storage.postgres.max_connections",
            "max_connections must leave room for 20 reserved admin/replication connections",
        ));
    } else if postgres.max_connections < 100 {
        findings.push(ProvisionFinding::warning(
            codes::POSTGRES_MAX_CONNECTIONS,
            "storage.postgres.max_connections",
            "fewer than 100 connections will not fit the PgBouncer pool budget plus admin sessions",
        ));
    }
    for (field, role) in [
        ("storage.postgres.roles.owner", &postgres.roles.owner),
        ("storage.postgres.roles.app", &postgres.roles.app),
        (
            "storage.postgres.roles.app_group",
            &postgres.roles.app_group,
        ),
        (
            "storage.postgres.roles.replication",
            &postgres.roles.replication,
        ),
        ("storage.audit.owner_role", &settings.audit.owner_role),
        ("storage.audit.writer_role", &settings.audit.writer_role),
        ("storage.log.owner_role", &settings.log.owner_role),
        ("storage.log.writer_role", &settings.log.writer_role),
    ] {
        if let Some(reason) = role_problem(role) {
            findings.push(ProvisionFinding::error(
                codes::POSTGRES_ROLE,
                field,
                format!("role '{role}' {reason}"),
            ));
        }
    }
    for (left, right, message) in [
        (
            &postgres.roles.owner,
            &postgres.roles.app,
            "the owner and the runtime login must be different roles",
        ),
        (
            &postgres.roles.owner,
            &postgres.roles.replication,
            "the owner and the replication role must be different roles",
        ),
        (
            &postgres.roles.app,
            &postgres.roles.app_group,
            "the runtime login and its group must be different roles",
        ),
    ] {
        if left.eq_ignore_ascii_case(right) {
            findings.push(ProvisionFinding::error(
                codes::POSTGRES_ROLE_DUPLICATE,
                "storage.postgres.roles",
                message,
            ));
        }
    }
    if postgres.owner_password.is_none() && config.database.mode == DatabaseMode::Managed {
        findings.push(ProvisionFinding::error(
            codes::POSTGRES_SECRET_MISSING,
            "database.owner_password",
            "a managed cluster needs the owner password reference (secret:<name>)",
        ));
    }
    if postgres.replication_password.is_none()
        && (!topology.replicas.is_empty() || !topology.backup.is_empty())
    {
        findings.push(ProvisionFinding::error(
            codes::POSTGRES_SECRET_MISSING,
            "database.replication_password",
            "streaming replicas and pg_basebackup on the backup host need the replication password reference",
        ));
    }
    let slots = usize::from(postgres.max_replication_slots);
    if topology.replicas.len() > slots {
        findings.push(ProvisionFinding::error(
            codes::POSTGRES_SLOTS,
            "storage.postgres.max_replication_slots",
            format!(
                "{} replicas but only {slots} replication slots",
                topology.replicas.len()
            ),
        ));
    }
    if postgres.ha == HaMode::Patroni {
        findings.push(ProvisionFinding::error(
            codes::PATRONI_NOT_IMPLEMENTED,
            "storage.postgres.ha",
            "Patroni HA is D5-T06 and is not implemented; use ha = \"manual-standby\" or \"none\"",
        ));
    }
    if matches!(postgres.ha, HaMode::ManualStandby) && topology.replicas.is_empty() {
        findings.push(ProvisionFinding::warning(
            codes::POSTGRES_SLOTS,
            "storage.postgres.ha",
            "manual-standby without a replica has nothing to promote",
        ));
    }
    if postgres.sync_standbys && topology.replicas.is_empty() {
        findings.push(ProvisionFinding::warning(
            codes::POSTGRES_SLOTS,
            "storage.postgres.sync_standbys",
            "synchronous standbys are enabled but no replica is planned: commits wait for a standby that never connects",
        ));
    }
    if !postgres.wal_compression {
        findings.push(ProvisionFinding::warning(
            codes::TLS_DOWNGRADE,
            "storage.postgres.wal_compression",
            "WAL compression is disabled; the design uses lz4 to bound replication and backup volume",
        ));
    }
    if !postgres.data_checksums {
        findings.push(ProvisionFinding::error(
            codes::POSTGRES_VERSION,
            "storage.postgres.data_checksums",
            "data checksums are required by the design and cannot be enabled after initdb",
        ));
    }
    if postgres.tls == TlsVerify::Require {
        findings.push(ProvisionFinding::warning(
            codes::TLS_DOWNGRADE,
            "storage.postgres.tls",
            "TLS without peer verification (sslmode=require) is a coexistence setting; D4-T02 moves to verify-full",
        ));
    }
    if postgres.client_cert == ClientCertMode::Off {
        findings.push(ProvisionFinding::warning(
            codes::TLS_DOWNGRADE,
            "storage.postgres.client_cert",
            "no client certificate: any role with the password can connect; enable verify-ca after D4-T02",
        ));
    }
    if postgres.client_cert == ClientCertMode::VerifyFull && settings.pgbouncer.enabled {
        findings.push(ProvisionFinding::warning(
            codes::TLS_DOWNGRADE,
            "storage.postgres.client_cert",
            "PgBouncer presents one server certificate as its client certificate to PostgreSQL, so clientcert=verify-full cannot match both pooled roles; use verify-ca or a per-role pooler",
        ));
    }
    for (field, reference) in [
        ("database.owner_password", &postgres.owner_password),
        ("database.app_password", &postgres.app_password),
        (
            "database.replication_password",
            &postgres.replication_password,
        ),
        (
            "storage.audit.owner_password",
            &settings.audit.owner_password,
        ),
        (
            "storage.audit.writer_password",
            &settings.audit.writer_password,
        ),
        ("storage.log.owner_password", &settings.log.owner_password),
        ("storage.log.writer_password", &settings.log.writer_password),
        ("storage.redis.password", &settings.redis.password),
        ("storage.redis.core_password", &settings.redis.core_password),
        (
            "storage.redis.worker_password",
            &settings.redis.worker_password,
        ),
        (
            "storage.redis.backup_password",
            &settings.redis.backup_password,
        ),
    ] {
        if let Some(value) = reference {
            if !value.starts_with("secret:") {
                findings.push(ProvisionFinding::error(
                    codes::POSTGRES_SECRET_MISSING,
                    field,
                    "must be a secret:<name> reference; a literal password is never accepted in a plan",
                ));
            }
        }
    }

    if settings.pgbouncer.enabled || settings.pgbouncer.port != pg_deploy_config::PGBOUNCER_PORT {
        if settings.pgbouncer.port == 0 {
            findings.push(ProvisionFinding::error(
                codes::PORT_RANGE,
                "storage.pgbouncer.port",
                "the PgBouncer listener cannot be port 0",
            ));
        }
        if settings.pgbouncer.port == postgres_port(topology) {
            findings.push(ProvisionFinding::error(
                codes::PORT_COLLISION,
                "storage.pgbouncer.port",
                format!(
                    "PgBouncer cannot listen on {} because PostgreSQL already does on this host",
                    settings.pgbouncer.port
                ),
            ));
        }
        let budget = settings.pgbouncer.server_pool_budget(&settings.postgres);
        let ceiling = u32::from(postgres.max_connections.saturating_sub(20));
        if budget > ceiling {
            findings.push(ProvisionFinding::error(
                codes::PGBOUNCER_BUDGET,
                "storage.pgbouncer.default_pool_size",
                format!(
                    "computed server pools need {budget} connections but max_connections - 20 = {ceiling}; lower default_pool_size or raise max_connections"
                ),
            ));
        }
        if settings.pgbouncer.max_prepared_statements != 0
            && settings.pgbouncer.max_prepared_statements < 256
        {
            findings.push(ProvisionFinding::warning(
                codes::PGBOUNCER_PREPARED,
                "storage.pgbouncer.max_prepared_statements",
                "Prisma and sqlx use prepared statements; the design keeps max_prepared_statements >= 256",
            ));
        }
        if !settings.pgbouncer.server_tls.verifies() {
            findings.push(ProvisionFinding::warning(
                codes::TLS_DOWNGRADE,
                "storage.pgbouncer.server_tls",
                "PgBouncer does not verify the PostgreSQL server certificate",
            ));
        }
        if !settings.pgbouncer.client_tls.verifies() {
            findings.push(ProvisionFinding::warning(
                codes::TLS_DOWNGRADE,
                "storage.pgbouncer.client_tls",
                "PgBouncer does not verify client certificates",
            ));
        }
    }

    if settings.redis.enabled {
        if topology.redis.is_empty() {
            findings.push(ProvisionFinding::error(
                codes::REDIS_HOST,
                "redis.host",
                "redis is enabled but no host carries the redis role",
            ));
        }
        if RedisSettings::parse_memory(&settings.redis.maxmemory).is_none() {
            findings.push(ProvisionFinding::error(
                codes::REDIS_MAXMEMORY,
                "storage.redis.maxmemory",
                format!(
                    "maxmemory '{}' is not a Redis size (for example 4gb or 512mb)",
                    settings.redis.maxmemory
                ),
            ));
        }
        if settings.redis.port == 0 {
            findings.push(ProvisionFinding::error(
                codes::PORT_RANGE,
                "storage.redis.port",
                "the Redis listener cannot be port 0",
            ));
        }
        if settings.redis.port == postgres_port(topology)
            || (settings.pgbouncer.enabled && settings.redis.port == settings.pgbouncer.port)
        {
            findings.push(ProvisionFinding::error(
                codes::PORT_COLLISION,
                "storage.redis.port",
                "the Redis listener collides with PostgreSQL or PgBouncer on the same host",
            ));
        }
        if !settings.redis.tls && config.deployment.environment.is_production() {
            findings.push(ProvisionFinding::error(
                codes::TLS_DOWNGRADE,
                "redis.tls",
                "production Redis must use TLS (S-SEC-06); set redis.tls = true and issue the leaf with pgctl pki",
            ));
        }
        if !settings.redis.acl {
            findings.push(ProvisionFinding::warning(
                codes::TLS_DOWNGRADE,
                "storage.redis.acl",
                "a single requirepass gives every service the same command set; ACL users are the target",
            ));
        }
        if settings.redis.ha == SentinelMode::Sentinel {
            let instances = if settings.redis.sentinel_hosts.is_empty() {
                3
            } else {
                settings.redis.sentinel_hosts.len()
            };
            if instances < 3 {
                findings.push(ProvisionFinding::error(
                    codes::REDIS_SENTINEL,
                    "storage.redis.sentinel_hosts",
                    format!("Sentinel needs three instances for quorum, got {instances}"),
                ));
            }
        }
    }

    if settings.audit.database == settings.postgres.database {
        findings.push(ProvisionFinding::error(
            codes::AUDITLOG_DATABASE,
            "storage.audit.database",
            "the audit database must be separate from the application database",
        ));
    }
    if settings.log.database == settings.postgres.database
        || settings.log.database == settings.audit.database
    {
        findings.push(ProvisionFinding::error(
            codes::AUDITLOG_DATABASE,
            "storage.log.database",
            "the log database must be separate from the application and audit databases",
        ));
    }
    if settings.audit.database == settings.audit.owner_role
        || settings.log.database == settings.log.owner_role
    {
        findings.push(ProvisionFinding::error(
            codes::AUDITLOG_ROLE,
            "storage.audit.writer_role",
            "a database cannot be named like its owner role by this planner",
        ));
    }
    if topology.audit.is_some()
        && topology.log.is_some()
        && settings.audit.owner_role == settings.log.owner_role
        && settings.audit.owner_password != settings.log.owner_password
    {
        findings.push(ProvisionFinding::error(
            codes::AUDITLOG_OWNER_PASSWORD,
            "storage.log.owner_password",
            format!(
                "the shared owner role '{}' cannot have two passwords; use the same secret reference for both tiers",
                settings.audit.owner_role
            ),
        ));
    }
    if settings.audit.retention_months == 0 || settings.audit.partitions_ahead == 0 {
        findings.push(ProvisionFinding::warning(
            codes::AUDITLOG_DATABASE,
            "storage.audit.retention_months",
            "zero retention or partitions would create no monthly partition",
        ));
    }

    if settings.clamav.mode == ClamavMode::Managed {
        if !settings.clamav.address.is_empty()
            && !settings.clamav.address.starts_with("127.")
            && settings.clamav.address != "localhost"
        {
            findings.push(ProvisionFinding::error(
                codes::CLAMAV_BIND,
                "storage.clamav.address",
                "managed clamd binds loopback only; use mode = \"external\" for a remote daemon",
            ));
        }
        if settings.clamav.stream_max_mb < KYB_UPLOAD_LIMIT_MB {
            findings.push(ProvisionFinding::error(
                codes::CLAMAV_STREAM,
                "storage.clamav.stream_max_mb",
                format!(
                    "StreamMaxLength must be at least the {KYB_UPLOAD_LIMIT_MB} MB KYB upload limit"
                ),
            ));
        }
        if topology.core.is_empty() {
            findings.push(ProvisionFinding::error(
                codes::HOST_MISSING,
                "hosts",
                "managed clamd runs on the core hosts; no host carries the core role",
            ));
        }
    }

    // Include configuration errors that concern the storage tiers, so `provision plan` cannot
    // silently plan a database whose port/secret/role rules the document already violates.
    for problem in validate(config) {
        // Only the storage tiers of the document can block a storage plan. Cross-cutting rules
        // (object storage, public certificates, service ports) belong to `pgctl config validate`
        // and the full `pgctl plan`; failing a `--target postgres` plan on an object-storage
        // finding would be misleading. Host entries are included because the provisioners read
        // their roles, addresses and service ports.
        let path = &problem.path;
        let relevant = path == "database"
            || path.starts_with("database.")
            || path == "redis"
            || path.starts_with("redis.")
            || path == "sandbox"
            || path.starts_with("sandbox.")
            || (path.starts_with("hosts[")
                && (path.contains(".roles")
                    || path.contains(".address")
                    || path.contains(".private_ip")
                    || path.contains(".service_port")));
        if relevant {
            findings.push(ProvisionFinding {
                code: codes::CONFIG_INVALID.to_owned(),
                path: problem.path.clone(),
                message: problem.message.clone(),
                severity: problem.severity,
            });
        }
    }
    findings
}

fn postgres_port(topology: &Topology) -> u16 {
    topology
        .primary
        .as_ref()
        .map_or(pg_deploy_config::POSTGRES_PORT, |host| host.port)
}

/// Why a role name cannot be provisioned, if any.
///
/// PostgreSQL reserves `pg_` for its own roles: `CREATE ROLE pg_x` always fails, so a setting
/// with that prefix can never work. The TS validator rejects it for the same reason.
#[must_use]
pub fn role_problem(role: &str) -> Option<&'static str> {
    if role.is_empty() {
        return Some("is empty");
    }
    if role.starts_with("pg_") {
        return Some("uses the reserved pg_ prefix");
    }
    if role.eq_ignore_ascii_case("postgres") {
        return Some("is the reserved superuser");
    }
    if !is_identifier(role) {
        return Some("is not a PostgreSQL identifier (letters, digits, underscore; max 64)");
    }
    if role.len() > 63 {
        return Some("is longer than 63 bytes and would be truncated");
    }
    if matches!(
        role.to_ascii_lowercase().as_str(),
        "public" | "current_user" | "session_user" | "current_role"
    ) {
        return Some("is a reserved PostgreSQL keyword");
    }
    None
}

/// Environment of a config, for the plan header.
#[must_use]
pub fn environment_of(config: &PgctlConfig) -> Environment {
    config.deployment.environment
}

/// True when an address is a usable IPv4/IPv6 literal (CIDR sources are rendered as `/32`/`/128`).
#[must_use]
pub fn parse_address(address: &str) -> Option<IpAddr> {
    address.trim().parse::<IpAddr>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_sizing_matches_the_ts_reference_profile() {
        let mut settings = PostgresSettings::default();
        let sizing = settings.memory();
        assert_eq!(sizing.shared_buffers, "8GB");
        assert_eq!(sizing.effective_cache_size, "24GB");
        assert_eq!(sizing.maintenance_work_mem, "1GB");

        settings.ram_gb = Some(32);
        let sizing = settings.memory();
        assert_eq!(sizing.shared_buffers, "8GB");
        assert_eq!(sizing.effective_cache_size, "24GB");
        assert_eq!(sizing.maintenance_work_mem, "2GB");

        settings.ram_gb = Some(4);
        let sizing = settings.memory();
        assert_eq!(sizing.shared_buffers, "1GB");
        assert_eq!(sizing.effective_cache_size, "3GB");
        assert_eq!(sizing.maintenance_work_mem, "256MB");

        settings.ram_gb = Some(6);
        let sizing = settings.memory();
        assert_eq!(sizing.shared_buffers, "1GB");
        assert_eq!(sizing.effective_cache_size, "4GB");
        assert_eq!(sizing.maintenance_work_mem, "384MB");
    }

    #[test]
    fn redis_memory_sizes_parse_and_reject() {
        assert_eq!(RedisSettings::parse_memory("4gb"), Some(4 * 1_073_741_824));
        assert_eq!(RedisSettings::parse_memory("512MB"), Some(512 * 1_048_576));
        assert_eq!(RedisSettings::parse_memory("1tb"), Some(1_099_511_627_776));
        assert_eq!(RedisSettings::parse_memory("0gb"), None);
        assert_eq!(RedisSettings::parse_memory("lots"), None);
    }

    #[test]
    fn reserved_roles_are_rejected() {
        assert!(role_problem("pg_core_user").is_some());
        assert!(role_problem("postgres").is_some());
        assert!(role_problem("public").is_some());
        assert!(role_problem("bad role").is_some());
        assert!(role_problem("gw_core_user").is_none());
        assert!(role_problem("pgw_app").is_none());
    }
}

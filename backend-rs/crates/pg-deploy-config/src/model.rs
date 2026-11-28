//! Declarative desired state (`pgctl.toml`).
//!
//! Port of `deploy/lib/configSchema.ts` (the 282-key `deploy.env` object) into the TOML model of
//! chapter 7 §7, D0-T01. The model is deliberately *declarative*: it describes what must exist, not
//! how to install it, so `pgctl plan` can diff it against a running fleet.
//!
//! Rules that the model itself enforces:
//!
//! - every table denies unknown keys, so a typo (`prot = 4000`) fails on the operator's machine
//!   instead of halfway through a deploy (the TS engine achieved this with `z.strictObject`);
//! - secrets are never values, only references into `secrets.age` (`secret:<name>`); a literal
//!   secret is rejected by validation;
//! - `environment` defaults to `production`, exactly like the TS fail-safe (`DEPLOY_ENV` unset
//!   means production);
//! - the service ports are 4000/4101/4102/4103/4104/4090/4095 today (see [`crate::ports`]).
//!
//! Extensions beyond the minimum field list in the task are documented on the field and exist
//! because the planner or a validation rule needs them: `hosts[].ssh_port`,
//! `hosts[].service_port` (the `nodeId@sshHost:sshPort:privateIp:servicePort` grammar),
//! `database.owner_role`/`app_role`/`replication_role` (the `pg_*` guard and the app/owner split),
//! `tls.rotate`/`leaf_days`/`renew_within_days`, `network.lan_allowlist`/`core_back_urls`,
//! `deployment.keep_releases`, and the object-storage and backup settings the daemons need.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::ports;

/// The only supported document version. Bumped for a breaking model change, never for a new
/// optional field.
pub const CONFIG_VERSION: u32 = 1;

/// Deployment environment. `Production` is the default so a missing `[deployment]` table cannot
/// silently enable test tooling (port of the TS `DEPLOY_ENV` fail-safe).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum Environment {
    /// Customer traffic. Test tooling is refused unless explicitly opted in.
    #[default]
    Production,
    /// Pre-production with production-like guards.
    Staging,
    /// Developer machines; Fake Rails and seeds are allowed.
    Development,
    /// CI and throwaway test servers.
    Test,
}

impl Environment {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Production => "production",
            Self::Staging => "staging",
            Self::Development => "development",
            Self::Test => "test",
        }
    }

    #[must_use]
    pub fn is_production(self) -> bool {
        matches!(self, Self::Production)
    }
}

/// How `pgctl apply` reconciles a host. Port of the TS `DEPLOY_MODE` enum; `rolling-update` is
/// accepted for compatibility and behaves like `update` (chapter 7 §18: the TS no-op is retired,
/// rolling batches are the mechanism).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum DeployMode {
    /// Probe the host and choose fresh or update.
    #[default]
    Auto,
    /// Wipe and rebuild the managed services.
    Fresh,
    /// Converge an existing installation.
    Update,
    /// Accepted alias of `update` (rolling batches are controlled by `--rolling-batch`).
    RollingUpdate,
}

impl DeployMode {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Fresh => "fresh",
            Self::Update => "update",
            Self::RollingUpdate => "rolling-update",
        }
    }
}

/// Which implementation serves a service during the port (chapter 7 §10; TS `ts | rs | both`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ImplKind {
    /// The TypeScript service (PM2), today's production.
    #[default]
    Ts,
    /// The Rust service (systemd). `rust` is accepted as an alias in TOML.
    #[serde(alias = "rust")]
    Rs,
    /// Both, side by side: TS on its current port, Rust on the coexistence port.
    Both,
}

impl ImplKind {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ts | Self::Both => "ts",
            Self::Rs => "rs",
        }
    }
}

/// A role a host carries. Port of `ROLE_NAMES` + `STORAGE_ROLE_NAMES` in `configSchema.ts`.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "kebab-case")]
pub enum Role {
    /// Legacy externally managed PostgreSQL host (`DB_*` compatibility path).
    Db,
    /// Application core.
    Core,
    /// Admin edge BFF + SPA.
    Admin,
    /// Merchant edge BFF + SPA.
    Merchant,
    /// Checkout edge BFF + SPA.
    Checkout,
    /// Fake Payment Rails emulator.
    FakeRails,
    /// PostgreSQL 18 primary.
    PgPrimary,
    /// PostgreSQL 18 streaming replica.
    PgReplica,
    /// PgBouncer (co-located with a PostgreSQL node).
    Pgbouncer,
    /// Redis / Valkey.
    Redis,
    /// Dedicated tamper-evident audit database.
    AuditDb,
    /// Dedicated operational log database.
    LogDb,
    /// Backup daemon host.
    Backup,
    /// Shared object and asset storage daemon host.
    ObjectStorage,
}

impl Role {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Db => "db",
            Self::Core => "core",
            Self::Admin => "admin",
            Self::Merchant => "merchant",
            Self::Checkout => "checkout",
            Self::FakeRails => "fake-rails",
            Self::PgPrimary => "pg-primary",
            Self::PgReplica => "pg-replica",
            Self::Pgbouncer => "pgbouncer",
            Self::Redis => "redis",
            Self::AuditDb => "audit-db",
            Self::LogDb => "log-db",
            Self::Backup => "backup",
            Self::ObjectStorage => "object-storage",
        }
    }

    /// True for the roles that host a PostgreSQL listener (they may share 5432, like the TS engine
    /// allows for co-located primary/audit/log databases).
    #[must_use]
    pub fn is_postgres_family(self) -> bool {
        matches!(
            self,
            Self::Db | Self::PgPrimary | Self::PgReplica | Self::AuditDb | Self::LogDb
        )
    }
}

/// Database ownership model. `Managed` means `pgctl` provisions and owns the cluster (the TS
/// `PG_MANAGE_VIA_SSH` path); `External` is an operator-managed server reached with `DATABASE_URL`
/// (the TS `DB_*` compatibility path).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum DatabaseMode {
    /// `pgctl` installs PostgreSQL 18 and manages roles, HBA and certificates.
    Managed,
    /// The operator owns the server; `pgctl` only connects.
    #[default]
    External,
}

impl DatabaseMode {
    #[must_use]
    pub fn is_managed(self) -> bool {
        matches!(self, Self::Managed)
    }
}

/// TLS posture for the public vhosts. Port of `SSL_MODES` plus `mtls` for internal-only boxes.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum TlsMode {
    /// ACME (Let's Encrypt) certificates, renewed by a systemd timer.
    #[default]
    Certbot,
    /// Operator-supplied certificate and key paths.
    Custom,
    /// Self-signed leaf, development and LAN only (refused in production).
    SelfSigned,
    /// Internal mTLS CA only; no public vhost is served.
    Mtls,
}

impl TlsMode {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Certbot => "certbot",
            Self::Custom => "custom",
            Self::SelfSigned => "self-signed",
            Self::Mtls => "mtls",
        }
    }

    #[must_use]
    pub fn is_public(self) -> bool {
        matches!(self, Self::Certbot | Self::Custom)
    }
}

/// Backup engine. `pg-native` is the default and `auto` resolves to it (ADR-0004; port of
/// `resolveBackupEngineMode`), because it is the only engine verified end to end.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum BackupEngine {
    /// The daemon's own `pg_basebackup` / `pg_receivewal` / WAL-over-mTLS engine.
    #[default]
    PgNative,
    /// WAL-G 3.0.9 (co-located with the primary only).
    WalG,
    /// Barman 3.10.1 (dedicated backup host).
    Barman,
    /// Alias of `pg-native`.
    Auto,
}

impl BackupEngine {
    /// Resolve the accepted `auto` alias. Port of `resolveBackupEngineMode`.
    #[must_use]
    pub fn effective(self) -> Self {
        match self {
            Self::Auto => Self::PgNative,
            other => other,
        }
    }

    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self.effective() {
            Self::PgNative | Self::Auto => "pg-native",
            Self::WalG => "wal-g",
            Self::Barman => "barman",
        }
    }
}

/// Who runs the S3 object store used by the backup daemon (port of `BACKUP_S3_MODE`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum S3Mode {
    /// Managed when the endpoint resolves to the backup host, external otherwise.
    #[default]
    Auto,
    /// An existing MinIO/R2/AWS; `pgctl` only verifies it.
    External,
    /// `pgctl` installs and configures MinIO on the backup host.
    ManagedMinio,
}

/// Synthetic seeder volume. Port of `SYNTHETIC_SEED_PROFILE`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum SeedProfile {
    /// CI and laptops.
    #[default]
    Compact,
    /// A realistic demo history.
    Standard,
    /// Load-test volume.
    Stress,
}

impl SeedProfile {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Compact => "COMPACT",
            Self::Standard => "STANDARD",
            Self::Stress => "STRESS",
        }
    }
}

/// `[deployment.watch]`: post-deploy watch window (chapter 7 §12, D3-T03).
///
/// The window monitors health, 5xx rate, p95 latency and worker errors; breaching a threshold
/// triggers an automatic rollback of the services changed by the deploy (never of migrations).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, default)]
pub struct Watch {
    /// Whether the watch window runs after a deploy.
    pub enabled: bool,
    /// Window length in minutes (default 10).
    pub window_minutes: u16,
    /// Maximum error rate in basis points (500 = 5%).
    pub max_error_bps: u32,
    /// Maximum p95 latency in milliseconds.
    pub max_p95_ms: u32,
    /// Maximum worker errors seen in the window.
    pub max_worker_errors: u32,
    /// Roll back automatically when a threshold is breached.
    pub auto_rollback: bool,
}

impl Default for Watch {
    fn default() -> Self {
        Self {
            enabled: true,
            window_minutes: 10,
            max_error_bps: 500,
            max_p95_ms: 1_500,
            max_worker_errors: 50,
            auto_rollback: true,
        }
    }
}

/// `[deployment]`: identity and lifecycle of this installation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, default)]
pub struct Deployment {
    /// Short installation name, used in logs and release manifests.
    pub name: String,
    /// Target environment; `production` is the fail-safe default.
    pub environment: Environment,
    /// Reconcile mode.
    pub mode: DeployMode,
    /// Pinned release identifier (`pg-release-<version>-<sha>`); empty means "latest built".
    pub release: Option<String>,
    /// Releases kept per host for rollback (TS `KEEP_RELEASES`).
    pub keep_releases: u32,
    /// Post-deploy watch window.
    pub watch: Watch,
}

impl Default for Deployment {
    fn default() -> Self {
        Self {
            name: "payment-gateway".to_owned(),
            environment: Environment::Production,
            mode: DeployMode::Auto,
            release: None,
            keep_releases: 5,
            watch: Watch::default(),
        }
    }
}

/// One machine in the fleet.
///
/// `name` is the TS `nodeId`; `address` is the SSH host; `private_ip` is the LAN address written
/// into TLS SANs and firewall rules; `public_ip` is only used for public vhost verification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, default)]
pub struct Host {
    /// Unique node id (`core-1`, `db-1`, `obj-1`).
    pub name: String,
    /// SSH address or DNS name (IPv4, IPv6 or a hostname; the TS grammar was IPv4-only).
    pub address: String,
    /// SSH port.
    pub ssh_port: u16,
    /// SSH/unix account.
    pub ssh_user: String,
    /// Roles carried by this host.
    pub roles: Vec<Role>,
    /// LAN address advertised to peers (TLS SAN + firewall allowlists).
    pub private_ip: String,
    /// Public address of the host, when it terminates public vhosts.
    pub public_ip: String,
    /// Listener of the host's primary service when it differs from the service default.
    /// Port of the `servicePort` field of the TS node grammar.
    pub service_port: Option<u16>,
    /// Private key path used by `pgctl` (chapter 7 §5 per-node SSH; expands `~`).
    pub ssh_key: Option<String>,
    /// Reference to the sudo password (`secret:<name>`), written to the channel's stdin, never argv.
    pub sudo_password: Option<String>,
}

impl Default for Host {
    fn default() -> Self {
        Self {
            name: String::new(),
            address: String::new(),
            ssh_port: 22,
            ssh_user: "deploy".to_owned(),
            roles: Vec::new(),
            private_ip: String::new(),
            public_ip: String::new(),
            service_port: None,
            ssh_key: None,
            sudo_password: None,
        }
    }
}

impl Host {
    /// The address peers and certificates use: the private IP when set, otherwise the SSH address.
    #[must_use]
    pub fn peer_address(&self) -> &str {
        if self.private_ip.is_empty() {
            &self.address
        } else {
            &self.private_ip
        }
    }

    #[must_use]
    pub fn has_role(&self, role: Role) -> bool {
        self.roles.contains(&role)
    }
}

/// `[services.core]`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, default)]
pub struct CoreService {
    /// Whether the Live core is part of this deployment (always true in practice).
    pub enabled: bool,
    /// TS, Rust or both.
    #[serde(rename = "impl")]
    pub implementation: ImplKind,
    /// Live core listener (4000 in the TS engine).
    pub port: u16,
    /// Sandbox core listener (4005).
    pub sandbox_port: u16,
    /// Instances per host (the TS node array length on one box).
    pub replicas: u16,
    /// Workers enabled in this implementation (coexistence hand-off lists).
    pub workers: Vec<String>,
}

impl Default for CoreService {
    fn default() -> Self {
        Self {
            enabled: true,
            implementation: ImplKind::Ts,
            port: ports::CORE_PORT,
            sandbox_port: ports::CORE_SANDBOX_PORT,
            replicas: 1,
            workers: Vec::new(),
        }
    }
}

/// The admin portal: LAN-only, self-signed or certbot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, default)]
pub struct AdminEdge {
    /// Whether the admin tier is deployed.
    pub enabled: bool,
    /// `admin-back` listener (4101).
    pub port: u16,
    /// nginx LAN listener (8443, never router-forwarded).
    pub nginx_port: u16,
    /// Public hostname when the admin portal is exposed through a vhost.
    pub public_host: Option<String>,
}

impl Default for AdminEdge {
    fn default() -> Self {
        Self {
            enabled: true,
            port: ports::ADMIN_BACK_PORT,
            nginx_port: ports::ADMIN_NGINX_LAN_PORT,
            public_host: None,
        }
    }
}

/// A public portal (merchant or checkout).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, default)]
pub struct PublicEdge {
    /// Whether this portal is deployed.
    pub enabled: bool,
    /// Backend listener (4102 merchant, 4103 checkout).
    pub port: u16,
    /// Public TLS listener (443).
    pub nginx_port: u16,
    /// LAN-only listener without a domain (8081/8082); `None` disables it.
    pub lan_port: Option<u16>,
    /// Public hostname; must be present in `tls.certbot_domains` in certbot mode.
    pub public_host: Option<String>,
}

impl Default for PublicEdge {
    fn default() -> Self {
        Self {
            enabled: true,
            port: ports::MERCHANT_BACK_PORT,
            nginx_port: ports::MERCHANT_HTTPS_PORT,
            lan_port: None,
            public_host: None,
        }
    }
}

/// `[services.edges]`: the three mTLS edge BFFs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, default)]
pub struct Edges {
    /// Whether the edge tier is deployed at all.
    pub enabled: bool,
    /// TS, Rust or both (per-tier; a mixed fleet uses one file per environment).
    #[serde(rename = "impl")]
    pub implementation: ImplKind,
    /// Instances of each edge per host.
    pub replicas: u16,
    /// Worker list (unused by the edges; kept so every service has the same shape).
    pub workers: Vec<String>,
    /// Admin portal.
    pub admin: AdminEdge,
    /// Merchant portal.
    pub merchant: PublicEdge,
    /// Checkout portal.
    pub checkout: PublicEdge,
}

impl Default for Edges {
    fn default() -> Self {
        Self {
            enabled: true,
            implementation: ImplKind::Ts,
            replicas: 1,
            workers: Vec::new(),
            admin: AdminEdge::default(),
            merchant: PublicEdge {
                port: ports::MERCHANT_BACK_PORT,
                lan_port: Some(ports::MERCHANT_LAN_PORT),
                ..PublicEdge::default()
            },
            checkout: PublicEdge {
                port: ports::CHECKOUT_BACK_PORT,
                lan_port: Some(ports::CHECKOUT_LAN_PORT),
                ..PublicEdge::default()
            },
        }
    }
}

/// `[services.fake-rails]`: the Fake Payment Rails emulator (development/staging only).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, default)]
pub struct FakeRailsService {
    /// Whether Fake Rails is deployed.
    pub enabled: bool,
    /// TS, Rust or both.
    #[serde(rename = "impl")]
    pub implementation: ImplKind,
    /// Backend listener (4104, loopback).
    pub port: u16,
    /// nginx listener (8444).
    pub nginx_port: u16,
    /// Instances per host.
    pub replicas: u16,
    /// Worker list (unused).
    pub workers: Vec<String>,
    /// Opt-in required even outside production, because Fake Rails runs with `NODE_ENV=production`
    /// under PM2 and its runtime guard keys off that (TS `FAKE_RAILS_ALLOW_IN_PRODUCTION`).
    pub allow_in_production: bool,
    /// Public hostname of the tester portal.
    pub public_host: Option<String>,
}

impl Default for FakeRailsService {
    fn default() -> Self {
        Self {
            enabled: false,
            implementation: ImplKind::Ts,
            port: ports::FAKE_RAILS_BACK_PORT,
            nginx_port: ports::FAKE_RAILS_NGINX_PORT,
            replicas: 1,
            workers: Vec::new(),
            allow_in_production: false,
            public_host: None,
        }
    }
}

/// `[services.backup]`: the backup daemon service.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, default)]
pub struct BackupService {
    /// Whether the daemon is deployed.
    pub enabled: bool,
    /// TS, Rust or both.
    #[serde(rename = "impl")]
    pub implementation: ImplKind,
    /// Control-plane listener (4090, mTLS).
    pub port: u16,
    /// Instances per host.
    pub replicas: u16,
    /// Worker list (unused).
    pub workers: Vec<String>,
}

impl Default for BackupService {
    fn default() -> Self {
        Self {
            enabled: false,
            implementation: ImplKind::Ts,
            port: ports::BACKUP_DAEMON_PORT,
            replicas: 1,
            workers: Vec::new(),
        }
    }
}

/// `[services.object-storage]`: the shared vault daemon service.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, default)]
pub struct ObjectStorageService {
    /// Whether the daemon is deployed.
    pub enabled: bool,
    /// TS, Rust or both.
    #[serde(rename = "impl")]
    pub implementation: ImplKind,
    /// mTLS listener (4095).
    pub port: u16,
    /// Instances per host (one).
    pub replicas: u16,
    /// Worker list (unused).
    pub workers: Vec<String>,
}

impl Default for ObjectStorageService {
    fn default() -> Self {
        Self {
            enabled: false,
            implementation: ImplKind::Ts,
            port: ports::OBJECT_STORAGE_PORT,
            replicas: 1,
            workers: Vec::new(),
        }
    }
}

/// `[services]`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, default)]
pub struct Services {
    /// Live core.
    pub core: CoreService,
    /// Edge BFFs.
    pub edges: Edges,
    /// Fake Rails.
    pub fake_rails: FakeRailsService,
    /// Backup daemon.
    pub backup: BackupService,
    /// Object storage daemon.
    pub object_storage: ObjectStorageService,
}

/// `[database]`: the relational database.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, default)]
pub struct Database {
    /// Managed by pgctl or external.
    pub mode: DatabaseMode,
    /// Database host (private IP or DNS). Required for `managed`; parsed from `DATABASE_URL` for
    /// `external` when the importer can.
    pub host: Option<String>,
    /// PostgreSQL listener (5432).
    pub port: u16,
    /// Database name.
    pub name: String,
    /// Owner role; runs migrations and seeds only (TS `PG_DB_USER`).
    pub owner_role: String,
    /// Application role; a plain LOGIN member of `pgw_app` (TS `PG_APP_USER`).
    pub app_role: String,
    /// Streaming replication role (TS `PG_REPLICATION_USER`).
    pub replication_role: String,
    /// Reference to the owner password (`secret:<name>`), never the value.
    pub owner_password: Option<String>,
    /// Reference to the application password.
    pub app_password: Option<String>,
    /// Reference to the replication password.
    pub replication_password: Option<String>,
    /// Reference to an externally managed `DATABASE_URL` (it carries a password).
    pub url: Option<String>,
    /// PgBouncer in front of the cluster (TS `PGBOUNCER_ENABLED`).
    pub pgbouncer: bool,
    /// PgBouncer listener (6432).
    pub pgbouncer_port: u16,
    /// TLS to PostgreSQL/PgBouncer. A managed cluster is `hostssl`-only, so this must be `true`.
    pub tls: bool,
}

impl Default for Database {
    fn default() -> Self {
        Self {
            mode: DatabaseMode::External,
            host: None,
            port: ports::POSTGRES_PORT,
            name: "payment_gateway_prod".to_owned(),
            owner_role: "gw_core_user".to_owned(),
            app_role: "pgw_app_login".to_owned(),
            replication_role: "gw_replicator".to_owned(),
            owner_password: None,
            app_password: None,
            replication_password: None,
            url: None,
            pgbouncer: false,
            pgbouncer_port: ports::PGBOUNCER_PORT,
            tls: false,
        }
    }
}

impl Database {
    #[must_use]
    pub fn is_managed(&self) -> bool {
        self.mode.is_managed()
    }

    /// The application role actually used: the app role when its password is configured, else the
    /// owner (legacy single-role mode; the deploy warns). Port of `applicationCredentials`.
    #[must_use]
    pub fn effective_app_role(&self) -> &str {
        if self.app_password.is_some() {
            &self.app_role
        } else {
            &self.owner_role
        }
    }
}

/// `[redis]`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, default)]
pub struct Redis {
    /// Whether the cache/velocity tier is deployed or configured.
    pub enabled: bool,
    /// Redis host.
    pub host: Option<String>,
    /// Redis listener (6379).
    pub port: u16,
    /// Logical database index.
    pub db: u8,
    /// TLS (`rediss://`).
    pub tls: bool,
    /// Reference to the ACL/`requirepass` secret.
    pub password: Option<String>,
}

impl Default for Redis {
    fn default() -> Self {
        Self {
            enabled: false,
            host: None,
            port: ports::REDIS_PORT,
            db: 0,
            tls: false,
            password: None,
        }
    }
}

/// `[object_storage]`: settings of the shared vault (not the service entry).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, default)]
pub struct ObjectStorage {
    /// Bind address; empty means the node's private IP (TS `OBJECT_STORAGE_DAEMON_BIND_HOST`).
    pub bind: String,
    /// Vault root; must stay under `/var/lib/pg-object-storage/` (TS `objectStorageDir`).
    pub root: String,
    /// Reference to the KEK keyring (`secret:<name>`); required in production.
    pub kek: Option<String>,
    /// Active KEK version inside the keyring.
    pub active_kek_version: u32,
    /// Allow plaintext HTTP to the daemon (development only).
    pub allow_insecure_http: bool,
    /// mTLS client CNs allowed to call the daemon.
    pub allowed_client_cns: Vec<String>,
    /// Days a trashed object is kept.
    pub trash_retention_days: u32,
    /// Hours before an unreferenced object is collected.
    pub gc_grace_hours: u32,
}

impl Default for ObjectStorage {
    fn default() -> Self {
        Self {
            bind: String::new(),
            root: "/var/lib/pg-object-storage/vault".to_owned(),
            kek: None,
            active_kek_version: 1,
            allow_insecure_http: false,
            allowed_client_cns: vec![
                "object-storage-client".to_owned(),
                "backup-client".to_owned(),
            ],
            trash_retention_days: 7,
            gc_grace_hours: 24,
        }
    }
}

/// Backup schedule (cron in `Africa/Tripoli` local time, as the daemon accepts).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, default)]
pub struct BackupSchedule {
    /// Full base backup.
    pub full: String,
    /// Incremental/delta backup.
    pub incremental: String,
    /// Restore drill.
    pub drill: String,
}

impl Default for BackupSchedule {
    fn default() -> Self {
        Self {
            full: "0 2 * * 0".to_owned(),
            incremental: "0 2 * * 1-6".to_owned(),
            drill: "0 4 * * 0".to_owned(),
        }
    }
}

/// Retention policy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, default)]
pub struct BackupRetention {
    /// Full backups kept.
    pub full_count: u32,
    /// Days of WAL kept.
    pub wal_days: u32,
}

impl Default for BackupRetention {
    fn default() -> Self {
        Self {
            full_count: 8,
            wal_days: 14,
        }
    }
}

/// `[backup]`: engine and repositories.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, default)]
pub struct Backup {
    /// Engine; `auto` resolves to `pg-native`.
    pub engine: BackupEngine,
    /// Local repository of the pg-native engine.
    pub local_repo: String,
    /// S3 endpoint (empty keeps a local-repo-only pg-native setup).
    pub endpoint: Option<String>,
    /// S3 bucket/path (`s3://bucket/prefix`).
    pub bucket: Option<String>,
    /// Who runs the object store.
    pub s3_mode: S3Mode,
    /// Access-key reference.
    pub access_key: Option<String>,
    /// Secret-key reference.
    pub secret_key: Option<String>,
    /// Allow plaintext HTTP to the daemon/S3 (development only).
    pub allow_insecure_http: bool,
    /// Schedule.
    pub schedule: BackupSchedule,
    /// Retention.
    pub retention: BackupRetention,
}

impl Default for Backup {
    fn default() -> Self {
        Self {
            engine: BackupEngine::PgNative,
            local_repo: "/var/lib/pg-backup/repo".to_owned(),
            endpoint: None,
            bucket: None,
            s3_mode: S3Mode::Auto,
            access_key: None,
            secret_key: None,
            allow_insecure_http: false,
            schedule: BackupSchedule::default(),
            retention: BackupRetention::default(),
        }
    }
}

/// `[secrets]`: where the encrypted store lives and how services receive values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, default)]
pub struct Secrets {
    /// `age`-encrypted store path.
    pub age_file: Option<String>,
    /// Deliver through systemd `LoadCredential=` (AD-13) instead of an env file.
    pub systemd_credentials: bool,
}

impl Default for Secrets {
    fn default() -> Self {
        Self {
            age_file: None,
            systemd_credentials: true,
        }
    }
}

/// `[network]`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, default)]
pub struct Network {
    /// Proxy addresses whose `x-forwarded-*` headers are trusted (TS `TRUSTED_PROXY_CIDRS`).
    pub trusted_proxies: Vec<String>,
    /// Exact CORS origins (scheme://host[:port], no path).
    pub cors_origins: Vec<String>,
    /// LAN allowlist for admin/merchant/checkout LAN vhosts (TS `LAN_ALLOWED_CIDRS`).
    pub lan_allowlist: Vec<String>,
    /// Explicit edge -> core upstream list (must be `https://`).
    pub core_back_urls: Vec<String>,
    /// Explicit edge -> sandbox core upstream list.
    pub sandbox_core_back_urls: Vec<String>,
}

impl Default for Network {
    fn default() -> Self {
        Self {
            trusted_proxies: vec!["127.0.0.1/32".to_owned(), "::1/128".to_owned()],
            cors_origins: Vec::new(),
            lan_allowlist: vec![
                "127.0.0.1/32".to_owned(),
                "::1/128".to_owned(),
                "10.0.0.0/8".to_owned(),
                "172.16.0.0/12".to_owned(),
                "192.168.0.0/16".to_owned(),
            ],
            core_back_urls: Vec::new(),
            sandbox_core_back_urls: Vec::new(),
        }
    }
}

/// `[tls]`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, default)]
pub struct Tls {
    /// Public TLS posture.
    pub mode: TlsMode,
    /// Domains the ACME certificate must cover; every public host must appear here.
    pub certbot_domains: Vec<String>,
    /// Internal PKI directory (CA, leaves, CRL).
    pub pki_dir: String,
    /// Replace the CA and every leaf on the next apply (TS `ROTATE_MTLS_CERTS`).
    pub rotate: bool,
    /// Leaf lifetime in days (TS `MTLS_VALIDITY_DAYS`).
    pub leaf_days: u16,
    /// Re-issue leaves inside this window with the same CA; 0 disables (TS `MTLS_RENEW_WITHIN_DAYS`).
    pub renew_within_days: u16,
}

impl Default for Tls {
    fn default() -> Self {
        Self {
            mode: TlsMode::Certbot,
            certbot_domains: Vec::new(),
            pki_dir: "/etc/pg/pki".to_owned(),
            rotate: false,
            leaf_days: 90,
            renew_within_days: 30,
        }
    }
}

/// `[sandbox]`: the parallel execution plane.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, default)]
pub struct Sandbox {
    /// Whether the sandbox core and database are deployed.
    pub enabled: bool,
    /// Sandbox database; must differ from `database.name`.
    pub db_name: String,
    /// Private IP/DNS of the sandbox core host; empty means the first core host
    /// (the TS `sandboxNode` fallback to `CORE_NODES[0]`).
    pub host: Option<String>,
}

impl Default for Sandbox {
    fn default() -> Self {
        Self {
            enabled: false,
            db_name: "payment_gateway_sandbox".to_owned(),
            host: None,
        }
    }
}

/// `[seed]`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, default)]
pub struct Seed {
    /// Synthetic history volume.
    pub profile: SeedProfile,
    /// Run the base seed (GL accounts, settings, templates, blueprints).
    pub run_base: bool,
    /// Run the synthetic history seed (requires Fake Rails and a test server).
    pub run_synthetic: bool,
}

impl Default for Seed {
    fn default() -> Self {
        Self {
            profile: SeedProfile::Compact,
            run_base: false,
            run_synthetic: false,
        }
    }
}

/// The whole `pgctl.toml` document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, default)]
pub struct PgctlConfig {
    /// Document version; must be [`CONFIG_VERSION`].
    pub version: u32,
    /// Installation identity and lifecycle.
    pub deployment: Deployment,
    /// The fleet.
    pub hosts: Vec<Host>,
    /// Service settings.
    pub services: Services,
    /// Relational database.
    pub database: Database,
    /// Redis.
    pub redis: Redis,
    /// Shared object storage.
    pub object_storage: ObjectStorage,
    /// Backup engine.
    pub backup: Backup,
    /// Secret-store settings.
    pub secrets: Secrets,
    /// Network policy.
    pub network: Network,
    /// TLS/PKI.
    pub tls: Tls,
    /// Sandbox plane.
    pub sandbox: Sandbox,
    /// Seeding.
    pub seed: Seed,
    /// Imported `deploy.env` keys that have no TOML home. Never written to TOML, never carries a
    /// secret value (the importer reports those names separately).
    #[serde(skip)]
    #[schemars(skip)]
    pub extra: BTreeMap<String, String>,
}

impl Default for PgctlConfig {
    fn default() -> Self {
        Self {
            version: CONFIG_VERSION,
            deployment: Deployment::default(),
            hosts: Vec::new(),
            services: Services::default(),
            database: Database::default(),
            redis: Redis::default(),
            object_storage: ObjectStorage::default(),
            backup: Backup::default(),
            secrets: Secrets::default(),
            network: Network::default(),
            tls: Tls::default(),
            sandbox: Sandbox::default(),
            seed: Seed::default(),
            extra: BTreeMap::new(),
        }
    }
}

impl PgctlConfig {
    /// A document with every default applied and the current version stamp.
    #[must_use]
    pub fn new(environment: Environment) -> Self {
        Self {
            version: CONFIG_VERSION,
            deployment: Deployment {
                environment,
                ..Deployment::default()
            },
            ..Self::default()
        }
    }

    #[must_use]
    pub fn is_production(&self) -> bool {
        self.deployment.environment.is_production()
    }

    /// True when the object storage tier is part of the deployment (service entry or a host role).
    #[must_use]
    pub fn object_storage_active(&self) -> bool {
        self.services.object_storage.enabled
            || self
                .hosts
                .iter()
                .any(|host| host.has_role(Role::ObjectStorage))
    }

    /// True when the backup daemon is part of the deployment.
    #[must_use]
    pub fn backup_active(&self) -> bool {
        self.services.backup.enabled || self.hosts.iter().any(|host| host.has_role(Role::Backup))
    }

    /// Hosts carrying a role, in document order.
    #[must_use]
    pub fn hosts_with_role(&self, role: Role) -> Vec<&Host> {
        self.hosts
            .iter()
            .filter(|host| host.has_role(role))
            .collect()
    }

    /// First host carrying a role.
    #[must_use]
    pub fn first_host_with_role(&self, role: Role) -> Option<&Host> {
        self.hosts.iter().find(|host| host.has_role(role))
    }

    /// The first core host: where the sandbox core runs unless placed elsewhere (TS
    /// `sandboxNode` falls back to `CORE_NODES[0]`).
    #[must_use]
    pub fn first_core_host(&self) -> Option<&Host> {
        self.first_host_with_role(Role::Core)
    }

    /// Every enabled listener with its TOML path, used by the collision check and the planner.
    ///
    /// Nginx public listeners are excluded: `merchant` and `checkout` legitimately share 80/443
    /// (they are told apart by `server_name`, exactly as the TS validator documents).
    #[must_use]
    pub fn backend_listeners(&self) -> Vec<(u16, String)> {
        let mut listeners = Vec::new();
        if self.services.core.enabled {
            listeners.push((self.services.core.port, "services.core.port".to_owned()));
            if self.sandbox.enabled {
                listeners.push((
                    self.services.core.sandbox_port,
                    "services.core.sandbox_port".to_owned(),
                ));
            }
        }
        let edges = &self.services.edges;
        if edges.enabled {
            if edges.admin.enabled {
                listeners.push((edges.admin.port, "services.edges.admin.port".to_owned()));
            }
            if edges.merchant.enabled {
                listeners.push((
                    edges.merchant.port,
                    "services.edges.merchant.port".to_owned(),
                ));
            }
            if edges.checkout.enabled {
                listeners.push((
                    edges.checkout.port,
                    "services.edges.checkout.port".to_owned(),
                ));
            }
        }
        if self.services.fake_rails.enabled {
            listeners.push((
                self.services.fake_rails.port,
                "services.fake_rails.port".to_owned(),
            ));
        }
        if self.backup_active() {
            listeners.push((self.services.backup.port, "services.backup.port".to_owned()));
        }
        if self.object_storage_active() {
            listeners.push((
                self.services.object_storage.port,
                "services.object_storage.port".to_owned(),
            ));
        }
        let postgres_listeners = self
            .hosts
            .iter()
            .any(|host| host.roles.iter().any(|role| role.is_postgres_family()))
            || self.database.host.is_some()
            || self.database.is_managed();
        if postgres_listeners {
            listeners.push((self.database.port, "database.port".to_owned()));
        }
        if self.database.pgbouncer {
            listeners.push((
                self.database.pgbouncer_port,
                "database.pgbouncer_port".to_owned(),
            ));
        }
        if self.redis.enabled {
            listeners.push((self.redis.port, "redis.port".to_owned()));
        }
        listeners
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_reproduce_the_ts_engine() {
        let config = PgctlConfig::default();
        assert_eq!(config.deployment.environment, Environment::Production);
        assert_eq!(config.deployment.mode, DeployMode::Auto);
        assert_eq!(config.deployment.keep_releases, 5);
        assert_eq!(config.services.core.port, 4000);
        assert_eq!(config.services.core.sandbox_port, 4005);
        assert_eq!(config.services.edges.admin.port, 4101);
        assert_eq!(config.services.edges.merchant.port, 4102);
        assert_eq!(config.services.edges.checkout.port, 4103);
        assert_eq!(config.services.edges.merchant.lan_port, Some(8081));
        assert_eq!(config.services.edges.checkout.lan_port, Some(8082));
        assert_eq!(config.services.fake_rails.port, 4104);
        assert_eq!(config.services.fake_rails.nginx_port, 8444);
        assert_eq!(config.services.backup.port, 4090);
        assert_eq!(config.services.object_storage.port, 4095);
        assert_eq!(config.database.port, 5432);
        assert_eq!(config.database.pgbouncer_port, 6432);
        assert_eq!(config.redis.port, 6379);
        assert_eq!(config.backup.engine, BackupEngine::PgNative);
        assert_eq!(config.tls.mode, TlsMode::Certbot);
        assert_eq!(config.seed.profile, SeedProfile::Compact);
        assert!(PgctlConfig::default().is_production());
    }

    #[test]
    fn toml_round_trip_preserves_every_field() {
        let mut config = PgctlConfig::new(Environment::Development);
        config.deployment.name = "lab".to_owned();
        config.deployment.release = Some("2026.11.28".to_owned());
        config.hosts.push(Host {
            name: "core-1".to_owned(),
            address: "10.0.0.11".to_owned(),
            roles: vec![Role::Core, Role::Pgbouncer],
            private_ip: "10.0.0.11".to_owned(),
            public_ip: "203.0.113.11".to_owned(),
            service_port: Some(4000),
            ..Host::default()
        });
        config.services.core.implementation = ImplKind::Both;
        config.database.mode = DatabaseMode::Managed;
        config.database.owner_password = Some("secret:pg_db_password".to_owned());
        config.redis.enabled = true;
        config.object_storage.kek = Some("secret:object_storage_kek_keyring".to_owned());
        config.backup.engine = BackupEngine::Auto;
        config.sandbox.enabled = true;
        config.seed.profile = SeedProfile::Standard;
        config
            .extra
            .insert("ADMIN_SHOW_HELP_PANELS".to_owned(), "true".to_owned());

        let text = toml::to_string_pretty(&config).expect("serialisable");
        assert!(text.contains("impl = \"both\""), "{text}");
        let parsed: PgctlConfig = toml::from_str(&text).expect("parsable");
        assert_eq!(
            parsed,
            PgctlConfig {
                extra: BTreeMap::new(),
                ..config
            }
        );
        // `extra` is TOML-invisible by design.
        assert!(!text.contains("ADMIN_SHOW_HELP_PANELS"));
    }

    #[test]
    fn unknown_keys_are_rejected_at_every_level() {
        let unknown_top = "version = 1\nmodee = \"auto\"\n";
        let error = toml::from_str::<PgctlConfig>(unknown_top).expect_err("unknown top-level key");
        assert!(error.to_string().contains("modee"), "{error}");

        let unknown_nested = "version = 1\n[services.core]\nprot = 4000\n";
        let error = toml::from_str::<PgctlConfig>(unknown_nested).expect_err("unknown nested key");
        assert!(error.to_string().contains("prot"), "{error}");

        let typo_in_host =
            "version = 1\n[[hosts]]\nname = \"a\"\naddress = \"10.0.0.1\"\nrols = [\"core\"]\n";
        let error = toml::from_str::<PgctlConfig>(typo_in_host).expect_err("unknown host key");
        assert!(error.to_string().contains("rols"), "{error}");
    }

    #[test]
    fn empty_document_is_valid_and_production_by_default() {
        let config: PgctlConfig = toml::from_str("").expect("empty document");
        assert!(config.is_production());
        assert_eq!(config.version, CONFIG_VERSION);
    }

    #[test]
    fn roles_serialise_in_kebab_case() {
        let text = toml::to_string(&Host {
            roles: vec![Role::FakeRails, Role::PgPrimary, Role::ObjectStorage],
            ..Host::default()
        })
        .expect("serialisable");
        assert!(text.contains("\"fake-rails\""), "{text}");
        assert!(text.contains("\"pg-primary\""), "{text}");
        assert!(text.contains("\"object-storage\""), "{text}");
    }

    #[test]
    fn app_role_falls_back_to_owner_without_password() {
        let mut database = Database::default();
        assert_eq!(database.effective_app_role(), "gw_core_user");
        database.app_password = Some("secret:pg_app_password".to_owned());
        assert_eq!(database.effective_app_role(), "pgw_app_login");
    }

    #[test]
    fn auto_backup_engine_resolves_to_pg_native() {
        assert_eq!(BackupEngine::Auto.effective(), BackupEngine::PgNative);
        assert_eq!(BackupEngine::Auto.as_str(), "pg-native");
        assert_eq!(BackupEngine::WalG.as_str(), "wal-g");
    }

    #[test]
    fn object_storage_activity_considers_service_and_role() {
        let mut config = PgctlConfig::default();
        assert!(!config.object_storage_active());
        config.services.object_storage.enabled = true;
        assert!(config.object_storage_active());
        config.services.object_storage.enabled = false;
        config.hosts.push(Host {
            name: "obj-1".to_owned(),
            roles: vec![Role::ObjectStorage],
            ..Host::default()
        });
        assert!(config.object_storage_active());
    }

    #[test]
    fn backend_listeners_track_enabled_services_only() {
        let mut config = PgctlConfig::default();
        config.services.fake_rails.enabled = false;
        config.database.pgbouncer = false;
        let ports: Vec<u16> = config
            .backend_listeners()
            .into_iter()
            .map(|(port, _)| port)
            .collect();
        assert!(ports.contains(&4000));
        assert!(ports.contains(&4101));
        assert!(!ports.contains(&4104));
        assert!(!ports.contains(&6432));
    }
}

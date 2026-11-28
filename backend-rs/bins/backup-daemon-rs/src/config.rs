//! Environment configuration for the backup daemon. Port of
//! `deploy/backup-daemon/src/config.ts`.
//!
//! Everything that can be checked before the first subprocess is started is validated here: a
//! typo in a bucket URL or an odd-length encryption key must fail at boot, not during a restore
//! drill. Secrets are never included in `Display`/`Debug` output; [`Config::secret_values`] feeds
//! the response redactor and [`redact_text`] the error paths.

use std::fmt;

use pg_config::Env;
use serde_json::Value;

pub const ENGINE_MODES: [&str; 3] = ["pg-native", "wal-g", "barman"];
pub const COMPRESSION_METHODS: [&str; 5] = ["zstd", "lz4", "lzma", "brotli", "none"];
pub const SSLMODES: [&str; 6] = [
    "disable",
    "allow",
    "prefer",
    "require",
    "verify-ca",
    "verify-full",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigError {
    pub key: String,
    pub message: String,
}

impl ConfigError {
    fn new(key: &str, message: impl Into<String>) -> Self {
        Self {
            key: key.to_owned(),
            message: message.into(),
        }
    }
}

impl fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.key, self.message)
    }
}

/// All configuration errors, joined like the zod issue list the TS service prints.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigErrors(pub Vec<ConfigError>);

impl fmt::Display for ConfigErrors {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let joined = self
            .0
            .iter()
            .map(ConfigError::to_string)
            .collect::<Vec<_>>()
            .join("; ");
        write!(formatter, "Invalid backup daemon configuration: {joined}")
    }
}

impl std::error::Error for ConfigErrors {}

#[derive(Clone)]
pub struct Config {
    pub engine_mode: String,
    pub compression: String,
    pub encryption_key_hex: String,

    pub primary_s3_endpoint: String,
    pub primary_s3_bucket: String,
    pub primary_s3_access_key: String,
    pub primary_s3_secret_key: String,
    pub core_s3_prefix: String,
    pub audit_s3_prefix: String,
    pub secondary_ssh_target: Option<String>,
    pub local_repo_dir: String,

    pub wal_spool_dir: String,
    pub staging_dir: String,
    pub wal_client_cns: String,
    pub wal_push_max_bytes: u64,
    pub wal_streaming_enabled: bool,
    pub stream_alert_bytes: u64,
    pub secondary_mirror_delete: bool,

    pub full_cron: String,
    pub delta_cron: String,
    pub drill_cron: String,
    pub retention_full_count: u32,
    pub retention_wal_days: u32,
    pub alert_lag_seconds: u32,

    pub daemon_port: u16,
    pub bind_host: String,
    pub daemon_cert_path: Option<String>,
    pub daemon_key_path: Option<String>,
    pub daemon_ca_cert_path: Option<String>,
    pub allowed_client_cns: String,

    pub walg_env_file: Option<String>,
    pub walg_env_file_audit: Option<String>,

    pub pg_primary_host: String,
    pub pg_primary_port: u16,
    pub pg_primary_user: String,
    pub pg_primary_password: String,
    pub pg_primary_db_name: String,
    pub pg_audit_db_name: String,
    pub pg_audit_host: Option<String>,
    pub pg_audit_user: Option<String>,
    pub pg_audit_password: String,
    pub pg_audit_port: u16,
    pub pg_log_db_name: Option<String>,
    pub pg_replication_user: Option<String>,
    pub pg_replication_password: String,
    pub pg_replication_slot: String,
    pub pg_audit_replication_slot: String,
    pub pg_sslmode: String,
    pub pg_replica_nodes: String,
    pub pg_data_dir: String,
    pub pg_audit_data_dir: Option<String>,

    pub walg_bin: String,
    pub barman_bin: String,
    pub barman_cloud_bin: String,
    pub barman_server: Option<String>,
    pub barman_audit_server: String,
    pub pg_bin_dir: String,

    pub catalog_path: String,
    pub scratch_dir: String,
    pub scratch_port: u16,
    pub scratch_audit_dir: String,
    pub scratch_audit_port: u16,
    pub allow_insecure_http: bool,
    pub command_timeout_ms: u64,
    pub recovery_timeout_ms: u64,
    pub scheduler_enabled: bool,
    pub scheduler_tick_ms: u64,

    pub redis_url: Option<String>,
    pub redis_cli_bin: String,

    pub object_storage_daemon_url: Option<String>,
    pub object_storage_allow_insecure_http: bool,
    pub object_storage_tls_ca_path: Option<String>,
    pub object_storage_tls_client_cert_path: Option<String>,
    pub object_storage_tls_client_key_path: Option<String>,
    pub object_storage_root_dir: Option<String>,
    pub object_storage_kek_keyring: String,
    pub object_storage_active_kek_version: u32,
    pub object_storage_verify_parity: bool,
    pub object_storage_drill_sample: u32,
}

impl fmt::Debug for Config {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Print the key names only: several values are credentials.
        formatter
            .debug_struct("Config")
            .field("engine_mode", &self.engine_mode)
            .field("catalog_path", &self.catalog_path)
            .field("s3_configured", &!self.primary_s3_endpoint.is_empty())
            .field("secrets", &"<redacted>")
            .finish()
    }
}

struct Reader<'a> {
    env: &'a Env,
}

impl Reader<'_> {
    fn raw(&self, key: &str) -> Option<String> {
        self.env.get(key)
    }

    fn non_empty(&self, key: &str, default: &str) -> String {
        self.env
            .get_non_empty(key)
            .unwrap_or_else(|| default.to_owned())
    }

    fn optional(&self, key: &str) -> Option<String> {
        self.env.get_non_empty(key)
    }

    fn string(&self, key: &str, default: &str) -> String {
        self.raw(key).unwrap_or_else(|| default.to_owned())
    }

    fn u64(&self, key: &str, default: u64, min: u64, max: u64) -> Result<u64, ConfigError> {
        match self.raw(key) {
            None => Ok(default),
            Some(raw) if raw.trim().is_empty() => Ok(default),
            Some(raw) => {
                let parsed: u64 = raw
                    .trim()
                    .parse()
                    .map_err(|_| ConfigError::new(key, "must be an unsigned integer"))?;
                if parsed < min || parsed > max {
                    return Err(ConfigError::new(
                        key,
                        format!("must be between {min} and {max}"),
                    ));
                }
                Ok(parsed)
            }
        }
    }

    fn u16(&self, key: &str, default: u16, min: u16, max: u16) -> Result<u16, ConfigError> {
        Ok(self.u64(key, u64::from(default), u64::from(min), u64::from(max))? as u16)
    }

    fn u32(&self, key: &str, default: u32, min: u32) -> Result<u32, ConfigError> {
        Ok(self.u64(key, u64::from(default), u64::from(min), u32::MAX as u64)? as u32)
    }

    fn boolean(&self, key: &str, default: bool) -> Result<bool, ConfigError> {
        match self.raw(key) {
            None => Ok(default),
            Some(raw) if raw.trim().is_empty() => Ok(default),
            Some(raw) => match raw.trim().to_ascii_lowercase().as_str() {
                "true" | "1" | "yes" | "on" => Ok(true),
                "false" | "0" | "no" | "off" => Ok(false),
                _ => Err(ConfigError::new(
                    key,
                    "must be one of true, 1, yes, on, false, 0, no, off",
                )),
            },
        }
    }
}

fn is_hex(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn looks_like_url(value: &str) -> bool {
    match value.split_once("://") {
        Some((scheme, rest)) => {
            !scheme.is_empty()
                && !rest.is_empty()
                && scheme
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.'))
        }
        None => false,
    }
}

fn join_prefix(base: &str, suffix: &str) -> String {
    format!("{}/{}", base.trim_end_matches('/'), suffix)
}

impl Config {
    pub fn from_env(env: &Env) -> Result<Self, ConfigErrors> {
        let reader = Reader { env };
        let mut errors = Vec::new();

        macro_rules! guarded {
            ($key:expr, $value:expr) => {
                match $value {
                    Ok(value) => value,
                    Err(error) => {
                        errors.push(error);
                        $key
                    }
                }
            };
        }

        let engine_mode = reader.non_empty("BACKUP_ENGINE_MODE", "");
        let compression = reader.non_empty("BACKUP_COMPRESSION", "zstd");
        let encryption_key_hex = reader.non_empty("BACKUP_ENCRYPTION_KEY_HEX", "");

        if !ENGINE_MODES.contains(&engine_mode.as_str()) {
            errors.push(ConfigError::new(
                "BACKUP_ENGINE_MODE",
                "must be one of pg-native, wal-g, barman",
            ));
        }
        if !COMPRESSION_METHODS.contains(&compression.as_str()) {
            errors.push(ConfigError::new(
                "BACKUP_COMPRESSION",
                "must be one of zstd, lz4, lzma, brotli, none",
            ));
        }
        if !is_hex(&encryption_key_hex)
            || encryption_key_hex.len() < 32
            || !encryption_key_hex.len().is_multiple_of(2)
        {
            errors.push(ConfigError::new(
                "BACKUP_ENCRYPTION_KEY_HEX",
                "must be an even-length hexadecimal string of at least 16 bytes",
            ));
        }

        let primary_s3_endpoint = reader.optional("BACKUP_PRIMARY_S3_ENDPOINT");
        let primary_s3_bucket = reader.optional("BACKUP_PRIMARY_S3_BUCKET");
        if let Some(endpoint) = &primary_s3_endpoint {
            if !looks_like_url(endpoint) {
                errors.push(ConfigError::new(
                    "BACKUP_PRIMARY_S3_ENDPOINT",
                    "must be a URL",
                ));
            }
        }
        if engine_mode != "pg-native" {
            if primary_s3_endpoint.is_none() {
                errors.push(ConfigError::new(
                    "BACKUP_PRIMARY_S3_ENDPOINT",
                    format!("is required when BACKUP_ENGINE_MODE={engine_mode}"),
                ));
            }
            if primary_s3_bucket.is_none() {
                errors.push(ConfigError::new(
                    "BACKUP_PRIMARY_S3_BUCKET",
                    format!("is required when BACKUP_ENGINE_MODE={engine_mode}"),
                ));
            }
        }
        if primary_s3_endpoint.is_some() != primary_s3_bucket.is_some() {
            errors.push(ConfigError::new(
                "BACKUP_PRIMARY_S3_ENDPOINT",
                "BACKUP_PRIMARY_S3_ENDPOINT and BACKUP_PRIMARY_S3_BUCKET must be provided together",
            ));
        }

        let primary_s3_access_key = reader.string("BACKUP_PRIMARY_S3_ACCESS_KEY", "");
        let primary_s3_secret_key = reader.string("BACKUP_PRIMARY_S3_SECRET_KEY", "");
        if primary_s3_access_key.is_empty() != primary_s3_secret_key.is_empty() {
            errors.push(ConfigError::new(
                "BACKUP_PRIMARY_S3_ACCESS_KEY",
                "BACKUP_PRIMARY_S3_ACCESS_KEY and BACKUP_PRIMARY_S3_SECRET_KEY must be provided together",
            ));
        }

        let daemon_cert_path = reader.optional("BACKUP_DAEMON_CERT_PATH");
        let daemon_key_path = reader.optional("BACKUP_DAEMON_KEY_PATH");
        let daemon_ca_cert_path = reader.optional("BACKUP_DAEMON_CA_CERT_PATH");
        if daemon_cert_path.is_some() != daemon_key_path.is_some() {
            errors.push(ConfigError::new(
                "BACKUP_DAEMON_CERT_PATH",
                "BACKUP_DAEMON_CERT_PATH and BACKUP_DAEMON_KEY_PATH must be provided together",
            ));
        }
        if daemon_ca_cert_path.is_some() && daemon_cert_path.is_none() {
            errors.push(ConfigError::new(
                "BACKUP_DAEMON_CA_CERT_PATH",
                "mTLS requires BACKUP_DAEMON_CERT_PATH and BACKUP_DAEMON_KEY_PATH as well as the CA",
            ));
        }

        let full_cron = reader.non_empty("BACKUP_FULL_CRON", "0 2 * * 0");
        let delta_cron = reader.non_empty("BACKUP_DELTA_CRON", "0 2 * * 1-6");
        let drill_cron = reader.non_empty("BACKUP_DRILL_CRON", "0 4 * * 0");
        for (key, expression) in [
            ("BACKUP_FULL_CRON", &full_cron),
            ("BACKUP_DELTA_CRON", &delta_cron),
            ("BACKUP_DRILL_CRON", &drill_cron),
        ] {
            if !crate::cron::is_valid_cron_expression(expression) {
                errors.push(ConfigError::new(
                    key,
                    "must be a five-field cron expression",
                ));
            }
        }

        let pg_sslmode = reader.non_empty("PG_SSLMODE", "prefer");
        if !SSLMODES.contains(&pg_sslmode.as_str()) {
            errors.push(ConfigError::new(
                "PG_SSLMODE",
                "must be one of disable, allow, prefer, require, verify-ca, verify-full",
            ));
        }

        let object_storage_daemon_url = reader.optional("OBJECT_STORAGE_DAEMON_URL");
        if let Some(url) = &object_storage_daemon_url {
            if !looks_like_url(url) {
                errors.push(ConfigError::new(
                    "OBJECT_STORAGE_DAEMON_URL",
                    "must be a URL",
                ));
            }
        }
        let object_storage_kek_keyring = reader.string("OBJECT_STORAGE_KEK_KEYRING", "");
        if object_storage_daemon_url.is_some() && object_storage_kek_keyring.trim().is_empty() {
            errors.push(ConfigError::new(
                "OBJECT_STORAGE_KEK_KEYRING",
                "is required when OBJECT_STORAGE_DAEMON_URL is set (restore drills decrypt sampled objects)",
            ));
        }
        let object_storage_tls_client_cert_path =
            reader.optional("OBJECT_STORAGE_TLS_CLIENT_CERT_PATH");
        let object_storage_tls_client_key_path =
            reader.optional("OBJECT_STORAGE_TLS_CLIENT_KEY_PATH");
        if object_storage_tls_client_cert_path.is_some()
            != object_storage_tls_client_key_path.is_some()
        {
            errors.push(ConfigError::new(
                "OBJECT_STORAGE_TLS_CLIENT_CERT_PATH",
                "OBJECT_STORAGE_TLS_CLIENT_CERT_PATH and OBJECT_STORAGE_TLS_CLIENT_KEY_PATH must be provided together",
            ));
        }

        let primary_s3_bucket_value = primary_s3_bucket.clone().unwrap_or_default();
        let local_repo_default = if engine_mode == "pg-native" {
            "/var/lib/pg-backup/repo"
        } else {
            ""
        };

        let config = Self {
            compression,
            encryption_key_hex,
            primary_s3_endpoint: primary_s3_endpoint.clone().unwrap_or_default(),
            primary_s3_bucket: primary_s3_bucket_value.clone(),
            primary_s3_access_key,
            primary_s3_secret_key,
            core_s3_prefix: reader.optional("BACKUP_CORE_S3_PREFIX").unwrap_or_else(|| {
                if primary_s3_bucket_value.is_empty() {
                    String::new()
                } else {
                    join_prefix(&primary_s3_bucket_value, "postgres_core")
                }
            }),
            audit_s3_prefix: reader
                .optional("BACKUP_AUDIT_S3_PREFIX")
                .unwrap_or_else(|| {
                    if primary_s3_bucket_value.is_empty() {
                        String::new()
                    } else {
                        join_prefix(&primary_s3_bucket_value, "audit_db")
                    }
                }),
            secondary_ssh_target: reader.optional("BACKUP_SECONDARY_SSH_TARGET"),
            local_repo_dir: reader
                .optional("BACKUP_LOCAL_REPO_DIR")
                .unwrap_or_else(|| local_repo_default.to_owned()),
            wal_spool_dir: reader.non_empty("BACKUP_WAL_SPOOL_DIR", "/var/lib/pg-backup/wal_spool"),
            staging_dir: reader.non_empty("BACKUP_STAGING_DIR", "/var/lib/pg-backup/staging"),
            wal_client_cns: reader.non_empty("BACKUP_WAL_CLIENT_CNS", "wal-archive-client"),
            wal_push_max_bytes: guarded!(
                64 * 1024 * 1024,
                reader.u64("BACKUP_WAL_PUSH_MAX_BYTES", 64 * 1024 * 1024, 1, u64::MAX)
            ),
            wal_streaming_enabled: guarded!(
                true,
                reader.boolean("BACKUP_WAL_STREAMING_ENABLED", true)
            ),
            stream_alert_bytes: guarded!(
                256 * 1024 * 1024,
                reader.u64("BACKUP_STREAM_ALERT_BYTES", 256 * 1024 * 1024, 1, u64::MAX)
            ),
            secondary_mirror_delete: guarded!(
                false,
                reader.boolean("BACKUP_SECONDARY_MIRROR_DELETE", false)
            ),
            full_cron,
            delta_cron,
            drill_cron,
            retention_full_count: guarded!(8, reader.u32("BACKUP_RETENTION_FULL_COUNT", 8, 1)),
            retention_wal_days: guarded!(14, reader.u32("BACKUP_RETENTION_WAL_DAYS", 14, 1)),
            alert_lag_seconds: guarded!(300, reader.u32("BACKUP_ALERT_LAG_SECONDS", 300, 1)),
            daemon_port: guarded!(4090, reader.u16("BACKUP_DAEMON_PORT", 4090, 1, 65535)),
            bind_host: reader.non_empty("BACKUP_DAEMON_BIND_HOST", "127.0.0.1"),
            daemon_cert_path,
            daemon_key_path,
            daemon_ca_cert_path,
            allowed_client_cns: reader.non_empty("BACKUP_ALLOWED_CLIENT_CNS", "backup-client"),
            walg_env_file: reader.optional("WALG_ENV_FILE"),
            walg_env_file_audit: reader.optional("WALG_ENV_FILE_AUDIT"),
            pg_primary_host: reader.non_empty("PG_PRIMARY_HOST", "127.0.0.1"),
            pg_primary_port: guarded!(5432, reader.u16("PG_PRIMARY_PORT", 5432, 1, 65535)),
            pg_primary_user: reader.non_empty("PG_PRIMARY_USER", "postgres"),
            pg_primary_password: reader.string("PG_PRIMARY_PASSWORD", ""),
            pg_primary_db_name: reader.non_empty("PG_PRIMARY_DB_NAME", "payment_gateway_prod"),
            pg_audit_db_name: reader.non_empty("PG_AUDIT_DB_NAME", "pg_audit_db"),
            pg_audit_host: reader.optional("PG_AUDIT_HOST"),
            pg_audit_user: reader.optional("PG_AUDIT_USER"),
            pg_audit_password: reader.string("PG_AUDIT_PASSWORD", ""),
            pg_audit_port: guarded!(5434, reader.u16("PG_AUDIT_PORT", 5434, 1, 65535)),
            pg_log_db_name: reader.optional("PG_LOG_DB_NAME"),
            pg_replication_user: reader.optional("PG_REPLICATION_USER"),
            pg_replication_password: reader.string("PG_REPLICATION_PASSWORD", ""),
            pg_replication_slot: reader.non_empty("PG_REPLICATION_SLOT", "pg_backup_core"),
            pg_audit_replication_slot: reader
                .non_empty("PG_AUDIT_REPLICATION_SLOT", "pg_backup_audit"),
            pg_sslmode,
            pg_replica_nodes: reader.string("PG_REPLICA_NODES", ""),
            pg_data_dir: reader.non_empty("PG_DATA_DIR", "/var/lib/postgresql/18/main"),
            pg_audit_data_dir: reader.optional("PG_AUDIT_DATA_DIR"),
            walg_bin: reader.non_empty("WALG_BIN", "wal-g"),
            barman_bin: reader.non_empty("BARMAN_BIN", "barman"),
            barman_cloud_bin: reader.non_empty("BARMAN_CLOUD_BIN", "barman-cloud-backup"),
            barman_server: reader.optional("BARMAN_SERVER"),
            barman_audit_server: reader.optional("BARMAN_AUDIT_SERVER").unwrap_or_default(),
            pg_bin_dir: reader.non_empty("PG_BIN_DIR", "/usr/lib/postgresql/18/bin"),
            catalog_path: reader
                .non_empty("BACKUP_CATALOG_PATH", "/var/lib/pg-backup/catalog.json"),
            scratch_dir: reader.non_empty("BACKUP_SCRATCH_DIR", "/var/lib/pg-backup/scratch"),
            scratch_port: guarded!(55432, reader.u16("BACKUP_SCRATCH_PORT", 55432, 1, 65535)),
            scratch_audit_dir: String::new(),
            scratch_audit_port: guarded!(
                55433,
                reader.u16("BACKUP_SCRATCH_AUDIT_PORT", 55433, 1, 65535)
            ),
            allow_insecure_http: guarded!(
                false,
                reader.boolean("BACKUP_ALLOW_INSECURE_HTTP", false)
            ),
            command_timeout_ms: guarded!(
                30 * 60 * 1000,
                reader.u64("BACKUP_COMMAND_TIMEOUT_MS", 30 * 60 * 1000, 1, u64::MAX)
            ),
            recovery_timeout_ms: guarded!(
                10 * 60 * 1000,
                reader.u64("BACKUP_RECOVERY_TIMEOUT_MS", 10 * 60 * 1000, 1, u64::MAX)
            ),
            scheduler_enabled: guarded!(true, reader.boolean("SCHEDULER_ENABLED", true)),
            scheduler_tick_ms: guarded!(
                30_000,
                reader.u64("SCHEDULER_TICK_MS", 30_000, 1, u64::MAX)
            ),
            redis_url: reader.optional("REDIS_URL"),
            redis_cli_bin: reader.non_empty("REDIS_CLI_BIN", "redis-cli"),
            object_storage_daemon_url,
            object_storage_allow_insecure_http: guarded!(
                false,
                reader.boolean("OBJECT_STORAGE_ALLOW_INSECURE_HTTP", false)
            ),
            object_storage_tls_ca_path: reader.optional("OBJECT_STORAGE_TLS_CA_PATH"),
            object_storage_tls_client_cert_path,
            object_storage_tls_client_key_path,
            object_storage_root_dir: reader.optional("OBJECT_STORAGE_ROOT_DIR"),
            object_storage_kek_keyring,
            object_storage_active_kek_version: guarded!(
                1,
                reader.u32("OBJECT_STORAGE_ACTIVE_KEK_VERSION", 1, 1)
            ),
            object_storage_verify_parity: guarded!(
                true,
                reader.boolean("OBJECT_STORAGE_VERIFY_PARITY", true)
            ),
            object_storage_drill_sample: guarded!(
                10,
                reader.u32("OBJECT_STORAGE_DRILL_SAMPLE", 10, 0)
            ),
            engine_mode,
        };

        if !errors.is_empty() {
            return Err(ConfigErrors(errors));
        }

        let mut config = config;
        config.scratch_audit_dir = reader
            .optional("BACKUP_SCRATCH_AUDIT_DIR")
            .unwrap_or_else(|| join_prefix(&config.scratch_dir, "audit"));
        config.barman_audit_server = reader
            .optional("BARMAN_AUDIT_SERVER")
            .unwrap_or_else(|| config.pg_audit_db_name.clone());
        Ok(config)
    }

    pub fn load(env: &Env) -> Result<Self, ConfigErrors> {
        Self::from_env(env)
    }

    pub fn load_default() -> Result<Self, ConfigErrors> {
        let env = Env::load_default().map_err(|error| {
            ConfigErrors(vec![ConfigError::new("DOTENV_PATH", error.to_string())])
        })?;
        Self::from_env(&env)
    }

    /// Secret values that must never appear in an HTTP response or a log line.
    #[must_use]
    pub fn secret_values(&self) -> Vec<String> {
        [
            self.encryption_key_hex.as_str(),
            self.primary_s3_access_key.as_str(),
            self.primary_s3_secret_key.as_str(),
            self.pg_primary_password.as_str(),
            self.pg_audit_password.as_str(),
            self.pg_replication_password.as_str(),
            self.object_storage_kek_keyring.as_str(),
        ]
        .into_iter()
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect()
    }

    #[must_use]
    pub fn allow_insecure_http(&self) -> bool {
        self.allow_insecure_http
    }

    /// TLS is used unless `BACKUP_ALLOW_INSECURE_HTTP=true` (development/tests only).
    pub fn tls_paths(&self) -> Result<Option<pg_mtls::ServerTlsPaths>, String> {
        if self.allow_insecure_http {
            return Ok(None);
        }
        let cert = self.daemon_cert_path.clone().ok_or_else(|| {
            "TLS requires BACKUP_DAEMON_CERT_PATH and BACKUP_DAEMON_KEY_PATH; \
             set BACKUP_ALLOW_INSECURE_HTTP=true only for local tests/development"
                .to_owned()
        })?;
        let key = self
            .daemon_key_path
            .clone()
            .ok_or_else(|| "TLS requires BACKUP_DAEMON_KEY_PATH".to_owned())?;
        let ca = self.daemon_ca_cert_path.clone().ok_or_else(|| {
            "mTLS requires BACKUP_DAEMON_CA_CERT_PATH; \
             set BACKUP_ALLOW_INSECURE_HTTP=true only for local tests/development"
                .to_owned()
        })?;
        Ok(Some(pg_mtls::ServerTlsPaths {
            ca_cert: ca.into(),
            server_cert: cert.into(),
            server_key: key.into(),
        }))
    }
}

/// A deliberately small five-field cron validator (no `@macros` or seconds).
#[must_use]
pub fn is_valid_cron(value: &str) -> bool {
    crate::cron::is_valid_cron_expression(value)
}

/// `parseCsv` — comma separated, trimmed, empty entries dropped.
#[must_use]
pub fn parse_csv(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(str::to_owned)
        .collect()
}

/// True when the daemon is wired to the shared object-storage vault.
#[must_use]
pub fn object_storage_backup_configured(config: &Config) -> bool {
    config.object_storage_daemon_url.is_some() || config.object_storage_root_dir.is_some()
}

/// A dedicated audit cluster has its own data directory or its own host.
///
/// `PG_AUDIT_PORT` is deliberately not part of the decision: it defaults to 5434 and would make
/// every shared deployment look dedicated.
#[must_use]
pub fn is_audit_dedicated_cluster(config: &Config) -> bool {
    config.pg_audit_data_dir.is_some()
        || config
            .pg_audit_host
            .as_ref()
            .is_some_and(|host| host != &config.pg_primary_host)
}

#[must_use]
pub fn is_audit_configured(config: &Config) -> bool {
    !config.pg_audit_db_name.trim().is_empty()
}

#[must_use]
pub fn is_log_db_configured(config: &Config) -> bool {
    config
        .pg_log_db_name
        .as_ref()
        .is_some_and(|name| !name.trim().is_empty())
}

#[must_use]
pub fn cluster_topology(config: &Config) -> &'static str {
    if is_audit_dedicated_cluster(config) {
        "dedicated-audit"
    } else {
        "shared-audit"
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PgEndpoint {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
}

/// Host/port/user/password of the cluster that holds the audit database.
#[must_use]
pub fn audit_endpoint(config: &Config) -> PgEndpoint {
    if is_audit_dedicated_cluster(config) {
        PgEndpoint {
            host: config
                .pg_audit_host
                .clone()
                .unwrap_or_else(|| config.pg_primary_host.clone()),
            port: config.pg_audit_port,
            user: config
                .pg_audit_user
                .clone()
                .unwrap_or_else(|| config.pg_primary_user.clone()),
            password: if config.pg_audit_password.is_empty() {
                config.pg_primary_password.clone()
            } else {
                config.pg_audit_password.clone()
            },
        }
    } else {
        PgEndpoint {
            host: config.pg_primary_host.clone(),
            port: config.pg_primary_port,
            user: config
                .pg_audit_user
                .clone()
                .unwrap_or_else(|| config.pg_primary_user.clone()),
            password: if config.pg_audit_password.is_empty() {
                config.pg_primary_password.clone()
            } else {
                config.pg_audit_password.clone()
            },
        }
    }
}

/// Replication credentials, falling back to the primary role.
#[must_use]
pub fn replication_credentials(config: &Config) -> (String, String) {
    (
        config
            .pg_replication_user
            .clone()
            .unwrap_or_else(|| config.pg_primary_user.clone()),
        if config.pg_replication_password.is_empty() {
            config.pg_primary_password.clone()
        } else {
            config.pg_replication_password.clone()
        },
    )
}

/// Replaces values that look like credentials, even when they are embedded in text.
#[must_use]
pub fn redact_text(text: &str, secret_values: &[String]) -> String {
    let mut secrets: Vec<&String> = secret_values
        .iter()
        .filter(|value| value.len() >= 4)
        .collect();
    secrets.sort_by_key(|value| std::cmp::Reverse(value.len()));
    let mut redacted = text.to_owned();
    for secret in secrets {
        redacted = redacted.replace(secret.as_str(), "[REDACTED]");
    }
    redact_credential_pairs(&redacted)
}

/// `(password|passwd|secret|token|api[_-]?key|access[_-]?key|authorization)(\s*[=:]\s*)(value)`.
fn redact_credential_pairs(text: &str) -> String {
    const KEYS: [&str; 7] = [
        "password",
        "passwd",
        "secret",
        "token",
        "api_key",
        "access_key",
        "authorization",
    ];
    let mut output = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let mut matched: Option<(usize, usize)> = None;
        for key in KEYS {
            let len = key.len();
            if index + len < bytes.len()
                && text[index..index + len].eq_ignore_ascii_case(key)
                && !bytes[index + len].is_ascii_alphanumeric()
            {
                let mut cursor = index + len;
                while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
                    cursor += 1;
                }
                if cursor < bytes.len() && (bytes[cursor] == b'=' || bytes[cursor] == b':') {
                    cursor += 1;
                    while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
                        cursor += 1;
                    }
                    let value_start = cursor;
                    if cursor < bytes.len() && (bytes[cursor] == b'"' || bytes[cursor] == b'\'') {
                        let quote = bytes[cursor];
                        cursor += 1;
                        while cursor < bytes.len() && bytes[cursor] != quote {
                            cursor += 1;
                        }
                        if cursor < bytes.len() {
                            cursor += 1;
                        }
                    } else {
                        while cursor < bytes.len()
                            && !bytes[cursor].is_ascii_whitespace()
                            && bytes[cursor] != b','
                            && bytes[cursor] != b';'
                        {
                            cursor += 1;
                        }
                    }
                    matched = Some((value_start, cursor));
                    break;
                }
            }
        }
        match matched {
            Some((value_start, value_end)) => {
                output.push_str(&text[index..value_start]);
                output.push_str("[REDACTED]");
                index = value_end;
            }
            None => {
                let character = text[index..].chars().next().unwrap_or(' ');
                output.push(character);
                index += character.len_utf8();
            }
        }
    }
    output
}

const SECRET_KEY_PATTERN: [&str; 10] = [
    "password",
    "passwd",
    "secret",
    "token",
    "api_key",
    "api-key",
    "access_key",
    "access-key",
    "encryption_key",
    "private_key",
];

#[must_use]
fn key_is_secret(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    SECRET_KEY_PATTERN
        .iter()
        .any(|pattern| lower.contains(pattern) && !lower.contains("public_key"))
        || lower.contains("authorization")
}

/// Recursively removes credential-shaped keys/values from a JSON value before it is returned.
#[must_use]
pub fn redact_sensitive_data(value: &Value, secret_values: &[String]) -> Value {
    match value {
        Value::String(text) => Value::String(redact_text(text, secret_values)),
        Value::Array(entries) => Value::Array(
            entries
                .iter()
                .map(|entry| redact_sensitive_data(entry, secret_values))
                .collect(),
        ),
        Value::Object(map) => {
            let mut result = serde_json::Map::new();
            for (key, entry) in map {
                if key_is_secret(key) {
                    result.insert(key.clone(), Value::String("[REDACTED]".to_owned()));
                } else {
                    result.insert(key.clone(), redact_sensitive_data(entry, secret_values));
                }
            }
            Value::Object(result)
        }
        other => other.clone(),
    }
}

/// `redactSecrets`: redacts by key name only.
#[must_use]
pub fn redact_secrets(value: &Value) -> Value {
    redact_sensitive_data(value, &[])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_env() -> Env {
        Env::default()
            .with_value("BACKUP_ENGINE_MODE", "pg-native")
            .with_value(
                "BACKUP_ENCRYPTION_KEY_HEX",
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            )
    }

    #[test]
    fn defaults_match_the_ts_daemon() {
        let config = Config::from_env(&base_env()).expect("config");
        assert_eq!(config.daemon_port, 4090);
        assert_eq!(config.bind_host, "127.0.0.1");
        assert_eq!(config.full_cron, "0 2 * * 0");
        assert_eq!(config.local_repo_dir, "/var/lib/pg-backup/repo");
        assert_eq!(config.scratch_audit_dir, "/var/lib/pg-backup/scratch/audit");
        assert_eq!(config.barman_audit_server, config.pg_audit_db_name);
        assert!(!is_audit_dedicated_cluster(&config));
        assert_eq!(cluster_topology(&config), "shared-audit");
    }

    #[test]
    fn rejects_unknown_engines_bad_keys_and_one_sided_credentials() {
        let mut env = base_env().with_value("BACKUP_ENGINE_MODE", "pg_basebackup");
        assert!(Config::from_env(&env).is_err());
        env = base_env().with_value("BACKUP_ENCRYPTION_KEY_HEX", "not-hex");
        assert!(Config::from_env(&env).is_err());
        env = base_env()
            .with_value("BACKUP_ENGINE_MODE", "wal-g")
            .with_value("BACKUP_PRIMARY_S3_ENDPOINT", "https://s3.example.com")
            .with_value("BACKUP_PRIMARY_S3_ACCESS_KEY", "key");
        assert!(Config::from_env(&env).is_err());
    }

    #[test]
    fn wal_g_and_barman_require_an_s3_endpoint() {
        for mode in ["wal-g", "barman"] {
            let env = base_env().with_value("BACKUP_ENGINE_MODE", mode);
            let error = Config::from_env(&env).expect_err("s3 required");
            assert!(error.to_string().contains("BACKUP_PRIMARY_S3_ENDPOINT"));
        }
    }

    #[test]
    fn redaction_removes_secret_values_and_credential_pairs() {
        let secrets = vec!["super-secret-password".to_owned()];
        let text = redact_text("password=super-secret-password token: abc", &secrets);
        assert!(!text.contains("super-secret-password"));
        assert!(!text.contains("abc"));
        let redacted = redact_sensitive_data(
            &serde_json::json!({"nested": {"secret": "abc", "keep": "yes"}}),
            &secrets,
        );
        assert_eq!(redacted["nested"]["secret"], "[REDACTED]");
        assert_eq!(redacted["nested"]["keep"], "yes");
    }
}

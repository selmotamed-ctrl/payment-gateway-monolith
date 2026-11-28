//! Importer: `deploy/deploy.env` -> [`PgctlConfig`].
//!
//! Port of `deploy/lib/configSchema.ts` (`parseDeployEnv`, the `nodeId@sshHost:sshPort:privateIp:servicePort`
//! grammar) and the `deploy/deploy.env.example` key set (chapter 7 §7, D0-T02).
//!
//! # Mapping table
//!
//! The table below is authoritative: [`ENV_KEY_MAP`] holds the same pairs, and a test asserts that
//! importing the repository's `deploy/deploy.env.example` consumes every listed key.
//!
//! | `deploy.env` | `pgctl.toml` |
//! | :--- | :--- |
//! | `DEPLOY_ENV` | `deployment.environment` (`production` default) |
//! | `DEPLOY_MODE` | `deployment.mode` |
//! | `KEEP_RELEASES` | `deployment.keep_releases` |
//! | `DEPLOY_NAME` | `deployment.name` |
//! | `ROTATE_MTLS_CERTS` / `MTLS_VALIDITY_DAYS` / `MTLS_RENEW_WITHIN_DAYS` | `tls.rotate` / `tls.leaf_days` / `tls.renew_within_days` |
//! | `LAN_ALLOWED_CIDRS` | `network.lan_allowlist` |
//! | `CORE_NODES` / `ADMIN_NODES` / `MERCHANT_NODES` / `CHECKOUT_NODES` | `hosts[]` with roles `core`/`admin`/`merchant`/`checkout` |
//! | `CORE_SSH_HOST`,`CORE_SSH_PORT`,`CORE_SSH_USER`,`CORE_PRIVATE_IP` (same for ADMIN/MERCHANT/CHECKOUT/DB) | legacy `hosts[]` entries when the node array is empty |
//! | `PG_PRIMARY_NODE` / `PG_REPLICA_NODES` / `REDIS_NODES` / `AUDIT_DB_NODE` / `LOG_DB_NODE` / `BACKUP_NODE` / `OBJECT_STORAGE_NODE` / `FAKE_RAILS_NODE` | `hosts[]` with the matching storage role |
//! | `CORE_PORT` / `SANDBOX_CORE_PORT` | `services.core.port` / `services.core.sandbox_port` |
//! | `ADMIN_BACK_PORT` / `ADMIN_NGINX_LAN_PORT` | `services.edges.admin.port` / `.nginx_port` |
//! | `MERCHANT_BACK_PORT` / `MERCHANT_HTTPS_PORT` / `MERCHANT_LAN_PORT` | `services.edges.merchant.port` / `.nginx_port` / `.lan_port` |
//! | `CHECKOUT_BACK_PORT` / `CHECKOUT_HTTPS_PORT` / `CHECKOUT_LAN_PORT` | `services.edges.checkout.port` / `.nginx_port` / `.lan_port` |
//! | `FAKE_RAILS_ENABLED` / `FAKE_RAILS_BACK_PORT` / `FAKE_RAILS_NGINX_PORT` / `FAKE_RAILS_ALLOW_IN_PRODUCTION` / `FAKE_RAILS_DOMAIN` | `services.fake_rails.*` |
//! | `BACKUP_ENABLED` / `BACKUP_DAEMON_PORT` | `services.backup.enabled` / `.port` |
//! | `OBJECT_STORAGE_ENABLED` / `OBJECT_STORAGE_DAEMON_PORT` | `services.object_storage.enabled` / `.port` |
//! | `DB_ENGINE`,`DB_PORT`,`DB_NAME`,`DB_USER`,`DB_PRIVATE_IP` | `database.mode = "external"`, `.port`, `.name`, `.owner_role`, `.host` |
//! | `PG_MANAGE_VIA_SSH`,`PG_DB_NAME`,`PG_DB_USER`,`PG_APP_USER`,`PG_REPLICATION_USER` | `database.mode`, `.name`, `.owner_role`, `.app_role`, `.replication_role` |
//! | `PGBOUNCER_ENABLED` / `PGBOUNCER_PORT` | `database.pgbouncer` / `.pgbouncer_port` |
//! | `REDIS_NODES` / `REDIS_URL` / `REDIS_PASSWORD` | `redis.enabled`, `.host`, `.port`, `.tls`, `.password` |
//! | `OBJECT_STORAGE_ROOT_DIR` / `OBJECT_STORAGE_DAEMON_BIND_HOST` / `OBJECT_STORAGE_ACTIVE_KEK_VERSION` / `OBJECT_STORAGE_ALLOW_INSECURE_HTTP` / `OBJECT_STORAGE_ALLOWED_CLIENT_CNS` / `OBJECT_STORAGE_TRASH_RETENTION_DAYS` / `OBJECT_STORAGE_GC_GRACE_HOURS` | `object_storage.*` |
//! | `BACKUP_ENGINE_MODE` (`auto` -> `pg-native`) / `BACKUP_LOCAL_REPO_DIR` / `BACKUP_FULL_CRON` / `BACKUP_DELTA_CRON` / `BACKUP_DRILL_CRON` / `BACKUP_RETENTION_FULL_COUNT` / `BACKUP_RETENTION_WAL_DAYS` / `BACKUP_PRIMARY_S3_*` / `BACKUP_S3_MODE` / `BACKUP_ALLOW_INSECURE_HTTP` | `backup.*` |
//! | `MERCHANT_DOMAIN` / `CHECKOUT_DOMAIN` | `services.edges.merchant.public_host` / `.checkout.public_host`, and `tls.certbot_domains` |
//! | `MERCHANT_SSL_MODE` / `CHECKOUT_SSL_MODE` | `tls.mode` |
//! | `CORE_BACK_URLS` / `SANDBOX_CORE_BACK_URLS` / `TRUSTED_PROXY_CIDRS` / `CORS_ORIGINS` | `network.*` |
//! | `SANDBOX_ENABLED` / `SANDBOX_DB_NAME` / `SANDBOX_NODE` | `sandbox.enabled` / `.db_name` / `.host` |
//! | `RUN_PRISMA_SEED` / `RUN_SYNTHETIC_HISTORY_SEED` / `SYNTHETIC_SEED_PROFILE` | `seed.run_base` / `.run_synthetic` / `.profile` |
//! | `AGE_FILE` / `SYSTEMD_CREDENTIALS` | `secrets.age_file` / `.systemd_credentials` |
//!
//! # Secrets
//!
//! A secret value is never copied into the document. The importer records a *reference*
//! (`secret:<lowercase-key>`) and reports the key name through
//! [`ImportOutcome::extracted_secrets`] so `pgctl config import` can write it into `secrets.age`.
//! Keys with no TOML home go to [`PgctlConfig::extra`] and are reported as `UNMAPPED` warnings —
//! nothing is dropped silently, and no value is ever echoed in a problem message.

#![forbid(unsafe_code)]

use std::collections::{BTreeMap, BTreeSet};

use crate::model::{
    BackupEngine, DatabaseMode, Environment, Host, ImplKind, PgctlConfig, Role, S3Mode,
    SeedProfile, TlsMode,
};
use crate::problem::{codes, ConfigProblem};
use crate::validate::{is_fqdn, is_pan_key, looks_like_card_pan, weak_secret_reason};

/// Environment keys the importer understands and where each one lands.
///
/// This is the machine-readable copy of the mapping table in the module documentation. It is
/// documentation and a test fixture, not a dispatch table: the importer reads each key by name so
/// the compiler checks the target field.
pub const ENV_KEY_MAP: &[(&str, &str)] = &[
    ("DEPLOY_ENV", "deployment.environment"),
    ("DEPLOY_MODE", "deployment.mode"),
    ("KEEP_RELEASES", "deployment.keep_releases"),
    ("DEPLOY_NAME", "deployment.name"),
    ("ROTATE_MTLS_CERTS", "tls.rotate"),
    ("MTLS_VALIDITY_DAYS", "tls.leaf_days"),
    ("MTLS_RENEW_WITHIN_DAYS", "tls.renew_within_days"),
    ("LAN_ALLOWED_CIDRS", "network.lan_allowlist"),
    ("CORE_NODES", "hosts"),
    ("ADMIN_NODES", "hosts"),
    ("MERCHANT_NODES", "hosts"),
    ("CHECKOUT_NODES", "hosts"),
    ("CORE_SSH_HOST", "hosts"),
    ("CORE_SSH_PORT", "hosts"),
    ("CORE_SSH_USER", "hosts"),
    ("CORE_PRIVATE_IP", "hosts"),
    ("ADMIN_SSH_HOST", "hosts"),
    ("ADMIN_PRIVATE_IP", "hosts"),
    ("MERCHANT_SSH_HOST", "hosts"),
    ("MERCHANT_PRIVATE_IP", "hosts"),
    ("CHECKOUT_SSH_HOST", "hosts"),
    ("CHECKOUT_PRIVATE_IP", "hosts"),
    ("DB_SSH_HOST", "hosts"),
    ("DB_PRIVATE_IP", "hosts"),
    ("PG_PRIMARY_NODE", "database.host"),
    ("PG_REPLICA_NODES", "hosts"),
    ("REDIS_NODES", "redis.host"),
    ("AUDIT_DB_NODE", "hosts"),
    ("LOG_DB_NODE", "hosts"),
    ("BACKUP_NODE", "hosts"),
    ("OBJECT_STORAGE_NODE", "hosts"),
    ("FAKE_RAILS_NODE", "hosts"),
    ("CORE_PORT", "services.core.port"),
    ("SANDBOX_CORE_PORT", "services.core.sandbox_port"),
    ("ADMIN_BACK_PORT", "services.edges.admin.port"),
    ("ADMIN_NGINX_LAN_PORT", "services.edges.admin.nginx_port"),
    ("MERCHANT_BACK_PORT", "services.edges.merchant.port"),
    ("MERCHANT_HTTPS_PORT", "services.edges.merchant.nginx_port"),
    ("MERCHANT_LAN_PORT", "services.edges.merchant.lan_port"),
    ("MERCHANT_DOMAIN", "services.edges.merchant.public_host"),
    ("CHECKOUT_BACK_PORT", "services.edges.checkout.port"),
    ("CHECKOUT_HTTPS_PORT", "services.edges.checkout.nginx_port"),
    ("CHECKOUT_LAN_PORT", "services.edges.checkout.lan_port"),
    ("CHECKOUT_DOMAIN", "services.edges.checkout.public_host"),
    ("MERCHANT_SSL", "tls.mode"),
    ("MERCHANT_SSL_MODE", "tls.mode"),
    ("CHECKOUT_SSL", "tls.mode"),
    ("CHECKOUT_SSL_MODE", "tls.mode"),
    ("FAKE_RAILS_ENABLED", "services.fake_rails.enabled"),
    ("FAKE_RAILS_BACK_PORT", "services.fake_rails.port"),
    ("FAKE_RAILS_NGINX_PORT", "services.fake_rails.nginx_port"),
    (
        "FAKE_RAILS_ALLOW_IN_PRODUCTION",
        "services.fake_rails.allow_in_production",
    ),
    ("FAKE_RAILS_DOMAIN", "services.fake_rails.public_host"),
    ("BACKUP_ENABLED", "services.backup.enabled"),
    ("BACKUP_DAEMON_PORT", "services.backup.port"),
    ("OBJECT_STORAGE_ENABLED", "services.object_storage.enabled"),
    (
        "OBJECT_STORAGE_MANAGE_VIA_SSH",
        "services.object_storage.enabled",
    ),
    ("OBJECT_STORAGE_DAEMON_PORT", "services.object_storage.port"),
    ("OBJECT_STORAGE_ROOT_DIR", "object_storage.root"),
    ("OBJECT_STORAGE_DAEMON_BIND_HOST", "object_storage.bind"),
    (
        "OBJECT_STORAGE_ACTIVE_KEK_VERSION",
        "object_storage.active_kek_version",
    ),
    (
        "OBJECT_STORAGE_ALLOW_INSECURE_HTTP",
        "object_storage.allow_insecure_http",
    ),
    (
        "OBJECT_STORAGE_ALLOWED_CLIENT_CNS",
        "object_storage.allowed_client_cns",
    ),
    (
        "OBJECT_STORAGE_TRASH_RETENTION_DAYS",
        "object_storage.trash_retention_days",
    ),
    (
        "OBJECT_STORAGE_GC_GRACE_HOURS",
        "object_storage.gc_grace_hours",
    ),
    ("DB_ENGINE", "database.mode"),
    ("DB_PORT", "database.port"),
    ("DB_NAME", "database.name"),
    ("DB_USER", "database.owner_role"),
    ("PG_MANAGE_VIA_SSH", "database.mode"),
    ("PG_DB_NAME", "database.name"),
    ("PG_DB_USER", "database.owner_role"),
    ("PG_APP_USER", "database.app_role"),
    ("PG_REPLICATION_USER", "database.replication_role"),
    ("PGBOUNCER_ENABLED", "database.pgbouncer"),
    ("PGBOUNCER_PORT", "database.pgbouncer_port"),
    ("REDIS_URL", "redis.host"),
    ("BACKUP_ENGINE_MODE", "backup.engine"),
    ("BACKUP_LOCAL_REPO_DIR", "backup.local_repo"),
    ("BACKUP_PRIMARY_S3_ENDPOINT", "backup.endpoint"),
    ("BACKUP_PRIMARY_S3_BUCKET", "backup.bucket"),
    ("BACKUP_S3_MODE", "backup.s3_mode"),
    ("BACKUP_ALLOW_INSECURE_HTTP", "backup.allow_insecure_http"),
    ("BACKUP_FULL_CRON", "backup.schedule.full"),
    ("BACKUP_DELTA_CRON", "backup.schedule.incremental"),
    ("BACKUP_DRILL_CRON", "backup.schedule.drill"),
    ("BACKUP_RETENTION_FULL_COUNT", "backup.retention.full_count"),
    ("BACKUP_RETENTION_WAL_DAYS", "backup.retention.wal_days"),
    ("CORE_BACK_URLS", "network.core_back_urls"),
    ("SANDBOX_CORE_BACK_URLS", "network.sandbox_core_back_urls"),
    ("TRUSTED_PROXY_CIDRS", "network.trusted_proxies"),
    ("CORS_ORIGINS", "network.cors_origins"),
    ("SANDBOX_ENABLED", "sandbox.enabled"),
    ("SANDBOX_DB_NAME", "sandbox.db_name"),
    ("RUN_PRISMA_SEED", "seed.run_base"),
    ("RUN_SYNTHETIC_HISTORY_SEED", "seed.run_synthetic"),
    ("SYNTHETIC_SEED_PROFILE", "seed.profile"),
    ("AGE_FILE", "secrets.age_file"),
    ("SYSTEMD_CREDENTIALS", "secrets.systemd_credentials"),
    // Secret keys: the value is extracted to a reference, the name is reported.
    ("KMS_MASTER_KEY", "secret:kms_master_key"),
    ("DB_PASSWORD", "database.owner_password"),
    ("DATABASE_URL", "database.url"),
    ("PG_DB_PASSWORD", "database.owner_password"),
    ("PG_APP_PASSWORD", "database.app_password"),
    ("PG_REPLICATION_PASSWORD", "database.replication_password"),
    ("REDIS_PASSWORD", "redis.password"),
    ("OBJECT_STORAGE_KEK_KEYRING", "object_storage.kek"),
    (
        "BACKUP_ENCRYPTION_KEY_HEX",
        "secret:backup_encryption_key_hex",
    ),
    ("BACKUP_PRIMARY_S3_ACCESS_KEY", "backup.access_key"),
    ("BACKUP_PRIMARY_S3_SECRET_KEY", "backup.secret_key"),
    (
        "FAKE_RAILS_ADMIN_PASSWORD",
        "secret:fake_rails_admin_password",
    ),
    ("FAKE_RAILS_JWT_SECRET", "secret:fake_rails_jwt_secret"),
    ("FAKE_RAILS_SEEDER_TOKEN", "secret:fake_rails_seeder_token"),
    (
        "FAKE_RAILS_CONTROL_TOKEN",
        "secret:fake_rails_control_token",
    ),
    ("SMTP_PASSWORD", "secret:smtp_password"),
    ("SMS_WEBHOOK_SECRET", "secret:sms_webhook_secret"),
    ("GOOGLE_CLIENT_SECRET", "secret:google_client_secret"),
];

/// One entry of `nodeId@sshHost:sshPort:privateIp:servicePort` (port of [`NodeSpec`]).
///
/// [`NodeSpec`]: https://example.invalid
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedNode {
    /// Node id.
    pub node_id: String,
    /// Address the orchestrator connects to.
    pub ssh_host: String,
    /// SSH port.
    pub ssh_port: u16,
    /// LAN address advertised to peers.
    pub private_ip: String,
    /// Service listener.
    pub service_port: u16,
}

/// Result of an import.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportOutcome {
    /// The mapped document.
    pub config: PgctlConfig,
    /// Import findings: unmapped keys, extracted secrets, weak secrets, PAN guard, bad nodes.
    pub problems: Vec<ConfigProblem>,
    /// Keys that went to [`PgctlConfig::extra`] (no TOML home).
    pub unmapped: Vec<String>,
    /// Secret keys whose *value* was not copied. Names only.
    pub extracted_secrets: Vec<String>,
}

/// Import a parsed environment map, returning only the document.
#[must_use]
pub fn import_env(env: &BTreeMap<String, String>) -> PgctlConfig {
    import_env_detailed(env).config
}

/// Import a parsed environment map and keep the findings.
///
/// Port of `deploy/lib/configSchema.ts:loadDeployConfig` (parse, map, guard, report), split so the
/// document and the findings can be inspected separately.
#[must_use]
pub fn import_env_detailed(env: &BTreeMap<String, String>) -> ImportOutcome {
    let mut config = PgctlConfig::default();
    let mut reader = Reader::new(env);
    let mut problems = Vec::new();
    let mut extracted = Vec::new();

    import_deployment(&mut reader, &mut config, &mut problems);
    import_tls(&mut reader, &mut config, &mut problems);
    import_network(&mut reader, &mut config);
    import_secrets(&mut reader, &mut config, &mut problems);
    import_database(&mut reader, &mut config, &mut problems, &mut extracted);
    import_redis(&mut reader, &mut config, &mut problems, &mut extracted);
    import_backup(&mut reader, &mut config, &mut problems, &mut extracted);
    import_object_storage(&mut reader, &mut config, &mut problems, &mut extracted);
    import_services(&mut reader, &mut config, &mut problems);
    import_hosts(&mut reader, &mut config, &mut problems, &mut extracted);
    import_fake_rails_secrets(&mut reader, &mut extracted);
    import_sandbox_and_seed(&mut reader, &mut config, &mut problems);

    // Every remaining key either becomes a non-secret fallback or a reported secret name.
    for (key, value) in env {
        if reader.consumed.contains(key) || value.trim().is_empty() {
            continue;
        }
        if is_secret_key(key) {
            extracted.push(key.clone());
            problems.push(ConfigProblem::warning(
                codes::SECRET_EXTRACTED,
                format!("secrets.{key}"),
                format!(
                    "{key} has no TOML home; its value was not copied - store it in secrets.age"
                ),
            ));
        } else {
            config.extra.insert(key.clone(), value.clone());
            problems.push(ConfigProblem::warning(
                codes::UNMAPPED,
                format!("extra.{key}"),
                format!("{key} has no pgctl.toml home; kept in extra for review"),
            ));
        }
    }

    // Weak secrets are checked while the values still exist (they never enter the document).
    for key in raw_secret_keys(env) {
        if let Some(value) = env.get(&key) {
            if value.trim().is_empty() {
                continue;
            }
            if let Some(reason) = weak_secret_reason(value) {
                problems.push(ConfigProblem::warning(
                    codes::WEAK_SECRET,
                    format!("secrets.{key}"),
                    format!("{key} {reason}"),
                ));
            }
        }
    }

    // PAN guard over the raw environment, exactly like `loadDeployConfig`.
    for (key, value) in env {
        if is_pan_key(key) {
            problems.push(ConfigProblem::error(
                codes::PAN_RAIL_GUARD,
                format!("env.{key}"),
                format!(
                    "{key} is refused: card PAN/CVV rails are out of PCI scope (docs/pci-scope.md)"
                ),
            ));
        } else if looks_like_card_pan(value) {
            problems.push(ConfigProblem::error(
                codes::PAN_RAIL_GUARD,
                format!("env.{key}"),
                format!("{key} holds card-PAN-shaped data (Luhn-valid 13-19 digits); refused"),
            ));
        }
    }

    problems.sort_by(|left, right| {
        (left.code, &left.path, &left.message).cmp(&(right.code, &right.path, &right.message))
    });
    problems.dedup();
    let unmapped = config.extra.keys().cloned().collect();
    ImportOutcome {
        config,
        problems,
        unmapped,
        extracted_secrets: extracted,
    }
}

/// Parse `deploy.env` text. Port of `parseDeployEnv`:
///
/// - a quoted value ends at its closing quote, so an inline `# "auto" | "fresh"` comment is not
///   part of the value;
/// - an unquoted value stops at ` #`;
/// - blank lines, comments and lines without `=` are ignored;
/// - the last duplicate wins.
#[must_use]
pub fn parse_env_source(source: &str) -> BTreeMap<String, String> {
    let mut values = BTreeMap::new();
    for raw_line in source.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((raw_key, raw_value)) = line.split_once('=') else {
            continue;
        };
        let key = raw_key.trim();
        if key.is_empty() {
            continue;
        }
        let value = raw_value.trim();
        let value = if let Some(rest) = value.strip_prefix('"') {
            rest.split('"').next().unwrap_or(rest)
        } else if let Some(rest) = value.strip_prefix('\'') {
            rest.split('\'').next().unwrap_or(rest)
        } else if let Some(index) = value.find(" #") {
            value[..index].trim()
        } else {
            value
        };
        values.insert(key.to_owned(), value.to_owned());
    }
    values
}

/// Read and parse an environment file.
pub fn parse_env_file(path: &std::path::Path) -> Result<BTreeMap<String, String>, std::io::Error> {
    let text = std::fs::read_to_string(path)?;
    Ok(parse_env_source(&text))
}

/// Port of `parseNodeList`: comma separated `nodeId@sshHost:sshPort:privateIp:servicePort`.
pub fn parse_node_list(value: &str) -> Result<Vec<ParsedNode>, String> {
    let mut nodes = Vec::new();
    let mut ids = BTreeSet::new();
    let mut endpoints = BTreeSet::new();
    for raw_entry in value.split(',') {
        let entry = raw_entry.trim();
        if entry.is_empty() {
            continue;
        }
        let Some((node_id, rest)) = entry.split_once('@') else {
            return Err(format!(
                "node '{entry}' must use nodeId@sshHost:sshPort:privateIp:servicePort"
            ));
        };
        if node_id.is_empty() || rest.is_empty() {
            return Err(format!(
                "node '{entry}' must use nodeId@sshHost:sshPort:privateIp:servicePort"
            ));
        }
        let parts: Vec<&str> = rest.split(':').collect();
        if parts.len() != 4 {
            return Err(format!(
                "node '{entry}' must have exactly sshHost:sshPort:privateIp:servicePort after '@'"
            ));
        }
        let ssh_host = parts[0].trim();
        let private_ip = parts[2].trim();
        if !is_valid_node_id(node_id) {
            return Err(format!("node id '{node_id}' is invalid"));
        }
        check_ipv4(ssh_host, &format!("node '{node_id}' sshHost"))?;
        check_ipv4(private_ip, &format!("node '{node_id}' privateIp"))?;
        let ssh_port = parse_port(parts[1].trim(), &format!("node '{node_id}' sshPort"))?;
        let service_port = parse_port(parts[3].trim(), &format!("node '{node_id}' servicePort"))?;
        if !ids.insert(node_id.to_owned()) {
            return Err(format!("duplicate node id '{node_id}'"));
        }
        let endpoint = format!("{private_ip}:{service_port}");
        if !endpoints.insert(endpoint.clone()) {
            return Err(format!("duplicate endpoint '{endpoint}' in node list"));
        }
        nodes.push(ParsedNode {
            node_id: node_id.to_owned(),
            ssh_host: ssh_host.to_owned(),
            ssh_port,
            private_ip: private_ip.to_owned(),
            service_port,
        });
    }
    Ok(nodes)
}

fn is_valid_node_id(value: &str) -> bool {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-'))
}

fn check_ipv4(value: &str, label: &str) -> Result<(), String> {
    let ok = value.split('.').count() == 4
        && value
            .split('.')
            .all(|octet| !octet.is_empty() && octet.len() <= 3 && octet.parse::<u8>().is_ok());
    if ok {
        Ok(())
    } else {
        Err(format!("{label}: '{value}' must be an IPv4 address"))
    }
}

fn parse_port(value: &str, label: &str) -> Result<u16, String> {
    if value.is_empty() || !value.chars().all(|ch| ch.is_ascii_digit()) {
        return Err(format!("{label}: '{value}' must be a port number"));
    }
    value
        .parse::<u16>()
        .map_err(|_| format!("{label}: '{value}' is out of range"))
}

/// True when a key holds a secret value that must be moved to `secrets.age` instead of the TOML.
#[must_use]
pub fn is_secret_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    if upper.ends_with("_PATH") || upper.ends_with("_DIR") || upper.ends_with("_ID") {
        return false;
    }
    // Names that contain a secret word but are plain configuration.
    const NOT_SECRET: &[&str] = &[
        "SYNTHETIC_SEED_KEY",
        "KMS_MASTER_KEY_ID",
        "BACKUP_WALG_SHA256",
    ];
    if NOT_SECRET.contains(&upper.as_str()) {
        return false;
    }
    const EXPLICIT: &[&str] = &[
        "KMS_MASTER_KEY",
        "KMS_MASTER_KEY_HEX",
        "DB_PASSWORD",
        "DATABASE_URL",
        "PG_DB_PASSWORD",
        "PG_APP_PASSWORD",
        "PG_REPLICATION_PASSWORD",
        "LEADER_ELECTION_DATABASE_URL",
        "REDIS_PASSWORD",
        "AUDIT_DB_PASSWORD",
        "LOG_DB_PASSWORD",
        "BACKUP_ENCRYPTION_KEY_HEX",
        "BACKUP_PRIMARY_S3_ACCESS_KEY",
        "BACKUP_PRIMARY_S3_SECRET_KEY",
        "OBJECT_STORAGE_KEK_KEYRING",
        "FAKE_RAILS_ADMIN_PASSWORD",
        "FAKE_RAILS_JWT_SECRET",
        "FAKE_RAILS_SEEDER_TOKEN",
        "FAKE_RAILS_CONTROL_TOKEN",
        "SMTP_PASSWORD",
        "SMS_WEBHOOK_SECRET",
        "GOOGLE_CLIENT_SECRET",
    ];
    if EXPLICIT.contains(&upper.as_str()) {
        return true;
    }
    upper.ends_with("_PASSWORD")
        || upper.ends_with("_PASSWD")
        || upper.ends_with("_SECRET")
        || upper.ends_with("_TOKEN")
        || upper.ends_with("_KEY")
        || upper.ends_with("_KEYRING")
        || upper.ends_with("_KEY_HEX")
}

fn raw_secret_keys(env: &BTreeMap<String, String>) -> Vec<String> {
    env.keys()
        .filter(|key| is_secret_key(key))
        .cloned()
        .collect()
}

struct Reader<'a> {
    env: &'a BTreeMap<String, String>,
    consumed: BTreeSet<String>,
}

impl<'a> Reader<'a> {
    fn new(env: &'a BTreeMap<String, String>) -> Self {
        Self {
            env,
            consumed: BTreeSet::new(),
        }
    }

    /// Read a key, mark it consumed and return `None` for a blank value (TS `.default()`).
    fn raw(&mut self, key: &str) -> Option<String> {
        self.consumed.insert(key.to_owned());
        self.env
            .get(key)
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    }

    /// Peek without consuming (tier SSH user defaults).
    fn peek(&self, key: &str) -> Option<&str> {
        self.env.get(key).map(String::as_str)
    }
}

fn take_port(reader: &mut Reader<'_>, key: &str, problems: &mut Vec<ConfigProblem>) -> Option<u16> {
    let value = reader.raw(key)?;
    match value.parse::<u16>() {
        Ok(port) if port > 0 => Some(port),
        _ => {
            problems.push(ConfigProblem::error(
                codes::INVALID_ENV_VALUE,
                key,
                "must be a port between 1 and 65535",
            ));
            None
        }
    }
}

fn take_u32(reader: &mut Reader<'_>, key: &str, problems: &mut Vec<ConfigProblem>) -> Option<u32> {
    let value = reader.raw(key)?;
    match value.parse::<u32>() {
        Ok(number) => Some(number),
        Err(_) => {
            problems.push(ConfigProblem::error(
                codes::INVALID_ENV_VALUE,
                key,
                "must be an unsigned integer",
            ));
            None
        }
    }
}

fn take_u16(reader: &mut Reader<'_>, key: &str, problems: &mut Vec<ConfigProblem>) -> Option<u16> {
    let value = reader.raw(key)?;
    match value.parse::<u16>() {
        Ok(number) => Some(number),
        Err(_) => {
            problems.push(ConfigProblem::error(
                codes::INVALID_ENV_VALUE,
                key,
                "must be an unsigned integer",
            ));
            None
        }
    }
}

fn take_bool(
    reader: &mut Reader<'_>,
    key: &str,
    problems: &mut Vec<ConfigProblem>,
) -> Option<bool> {
    let value = reader.raw(key)?;
    match value.to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" | "on" => Some(true),
        "false" | "0" | "no" | "off" => Some(false),
        _ => {
            problems.push(ConfigProblem::error(
                codes::INVALID_ENV_VALUE,
                key,
                "must be true/false, 1/0 or yes/no",
            ));
            None
        }
    }
}

fn take_secret(reader: &mut Reader<'_>, key: &str, extracted: &mut Vec<String>) -> Option<String> {
    reader.raw(key)?;
    extracted.push(key.to_owned());
    Some(format!("secret:{}", key.to_ascii_lowercase()))
}

fn non_empty(reader: &Reader<'_>, key: &str) -> bool {
    reader
        .peek(key)
        .is_some_and(|value| !value.trim().is_empty())
}

fn split_list(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(str::to_owned)
        .collect()
}

fn import_deployment(
    reader: &mut Reader<'_>,
    config: &mut PgctlConfig,
    problems: &mut Vec<ConfigProblem>,
) {
    if let Some(value) = reader.raw("DEPLOY_ENV") {
        config.deployment.environment = match value.to_ascii_lowercase().as_str() {
            "production" => Environment::Production,
            "staging" => Environment::Staging,
            "development" => Environment::Development,
            "test" => Environment::Test,
            other => {
                problems.push(ConfigProblem::error(
                    codes::INVALID_ENV_VALUE,
                    "DEPLOY_ENV",
                    format!("'{other}' must be production, staging, development or test"),
                ));
                Environment::Production
            }
        };
    }
    if let Some(value) = reader.raw("DEPLOY_MODE") {
        config.deployment.mode = match value.to_ascii_lowercase().as_str() {
            "auto" => crate::model::DeployMode::Auto,
            "fresh" => crate::model::DeployMode::Fresh,
            "update" => crate::model::DeployMode::Update,
            "rolling_update" | "rolling-update" => crate::model::DeployMode::RollingUpdate,
            other => {
                problems.push(ConfigProblem::error(
                    codes::INVALID_ENV_VALUE,
                    "DEPLOY_MODE",
                    format!("'{other}' must be auto, fresh, update or rolling_update"),
                ));
                config.deployment.mode
            }
        };
    }
    if let Some(value) = take_u32(reader, "KEEP_RELEASES", problems) {
        config.deployment.keep_releases = value;
    }
    if let Some(value) = reader.raw("DEPLOY_NAME") {
        config.deployment.name = value;
    }
}

fn import_tls(
    reader: &mut Reader<'_>,
    config: &mut PgctlConfig,
    problems: &mut Vec<ConfigProblem>,
) {
    if let Some(value) = take_bool(reader, "ROTATE_MTLS_CERTS", problems) {
        config.tls.rotate = value;
    }
    if let Some(value) = take_u16(reader, "MTLS_VALIDITY_DAYS", problems) {
        config.tls.leaf_days = value;
    }
    if let Some(value) = take_u16(reader, "MTLS_RENEW_WITHIN_DAYS", problems) {
        config.tls.renew_within_days = value;
    }
    let mut modes = Vec::new();
    for (key, portal) in [
        ("MERCHANT_SSL_MODE", "merchant"),
        ("CHECKOUT_SSL_MODE", "checkout"),
    ] {
        if let Some(value) = reader.raw(key) {
            let mode = match value.to_ascii_lowercase().as_str() {
                "certbot" => Some(TlsMode::Certbot),
                "custom" => Some(TlsMode::Custom),
                "self_signed" | "self-signed" => Some(TlsMode::SelfSigned),
                other => {
                    problems.push(ConfigProblem::error(
                        codes::INVALID_ENV_VALUE,
                        key,
                        format!("'{other}' must be certbot, custom or self_signed"),
                    ));
                    None
                }
            };
            if let Some(mode) = mode {
                modes.push((portal, mode));
            }
        }
    }
    for (key, portal) in [("MERCHANT_SSL", "merchant"), ("CHECKOUT_SSL", "checkout")] {
        if let Some(enabled) = take_bool(reader, key, problems) {
            if !enabled {
                problems.push(ConfigProblem::warning(
                    codes::PRODUCTION_REQUIRES_TLS,
                    key,
                    format!("{portal} serves plain HTTP; production validation will refuse it"),
                ));
                modes.push((portal, TlsMode::SelfSigned));
            }
        }
    }
    if let Some((_, first_mode)) = modes.first() {
        if modes.iter().any(|(_, mode)| mode != first_mode) {
            problems.push(ConfigProblem::warning(
                codes::INVALID_ENV_VALUE,
                "tls.mode",
                "MERCHANT_SSL_MODE and CHECKOUT_SSL_MODE differ; pgctl.toml has one public TLS mode, using the merchant one",
            ));
        }
        config.tls.mode = *first_mode;
    }
    if let Some(value) = reader.raw("MERCHANT_DOMAIN") {
        config.services.edges.merchant.public_host = Some(value);
    }
    if let Some(value) = reader.raw("CHECKOUT_DOMAIN") {
        config.services.edges.checkout.public_host = Some(value);
    }
    for host in [
        config.services.edges.merchant.public_host.clone(),
        config.services.edges.checkout.public_host.clone(),
        config.services.fake_rails.public_host.clone(),
    ]
    .into_iter()
    .flatten()
    {
        if is_fqdn(&host)
            && !config
                .tls
                .certbot_domains
                .iter()
                .any(|existing| existing.eq_ignore_ascii_case(&host))
        {
            config.tls.certbot_domains.push(host);
        }
    }
}

fn import_network(reader: &mut Reader<'_>, config: &mut PgctlConfig) {
    if let Some(value) = reader.raw("LAN_ALLOWED_CIDRS") {
        config.network.lan_allowlist = split_list(&value);
    }
    if let Some(value) = reader.raw("TRUSTED_PROXY_CIDRS") {
        config.network.trusted_proxies = split_list(&value);
    }
    if let Some(value) = reader.raw("CORS_ORIGINS") {
        config.network.cors_origins = split_list(&value);
    }
    if let Some(value) = reader.raw("CORE_BACK_URLS") {
        config.network.core_back_urls = split_list(&value);
    }
    if let Some(value) = reader.raw("SANDBOX_CORE_BACK_URLS") {
        config.network.sandbox_core_back_urls = split_list(&value);
    }
}

fn import_secrets(
    reader: &mut Reader<'_>,
    config: &mut PgctlConfig,
    problems: &mut Vec<ConfigProblem>,
) {
    if let Some(value) = reader.raw("AGE_FILE") {
        config.secrets.age_file = Some(value);
    }
    if let Some(value) = reader.raw("SYSTEMD_CREDENTIALS") {
        match parse_boolish(&value) {
            Some(parsed) => config.secrets.systemd_credentials = parsed,
            None => problems.push(ConfigProblem::error(
                codes::INVALID_ENV_VALUE,
                "SYSTEMD_CREDENTIALS",
                "must be true/false, 1/0 or yes/no",
            )),
        }
    }
}

fn parse_boolish(value: &str) -> Option<bool> {
    match value.to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" | "on" => Some(true),
        "false" | "0" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn import_database(
    reader: &mut Reader<'_>,
    config: &mut PgctlConfig,
    problems: &mut Vec<ConfigProblem>,
    extracted: &mut Vec<String>,
) {
    let managed = take_bool(reader, "PG_MANAGE_VIA_SSH", problems);
    if managed == Some(true) {
        config.database.mode = DatabaseMode::Managed;
        config.database.tls = true;
    }
    if let Some(value) = reader.raw("DB_ENGINE") {
        if !value.eq_ignore_ascii_case("postgresql") {
            problems.push(ConfigProblem::error(
                codes::DATABASE_ENGINE_UNSUPPORTED,
                "DB_ENGINE",
                "PostgreSQL 18 is the only supported runtime database",
            ));
        }
    }
    if let Some(value) = take_port(reader, "DB_PORT", problems) {
        config.database.port = value;
    }
    if let Some(value) = reader.raw("DB_NAME") {
        config.database.name = value;
    }
    if let Some(value) = reader.raw("DB_USER") {
        config.database.owner_role = value;
    }
    if let Some(value) = take_secret(reader, "DB_PASSWORD", extracted) {
        config.database.owner_password = Some(value);
    }
    if let Some(value) = reader.raw("DB_PRIVATE_IP") {
        config.database.host = Some(value);
    }
    if let Some(value) = take_secret(reader, "DATABASE_URL", extracted) {
        config.database.url = Some(value);
        let raw = reader.env.get("DATABASE_URL").cloned().unwrap_or_default();
        apply_database_url(config, &raw);
    }

    // The PostgreSQL 18 storage tier is authoritative when configured (TS `pgStorageConfigured`:
    // PG_MANAGE_VIA_SSH, a primary/replica node array, or PG_DB_PASSWORD). A stray PG_DB_NAME on an
    // external database is reported instead of silently renaming it.
    let pg_configured = managed == Some(true)
        || non_empty(reader, "PG_PRIMARY_NODE")
        || non_empty(reader, "PG_REPLICA_NODES")
        || non_empty(reader, "PG_DB_PASSWORD");
    if let Some(value) = reader.raw("PG_DB_NAME") {
        if pg_configured {
            config.database.name = value;
        } else {
            problems.push(ConfigProblem::warning(
                codes::IGNORED_ENV_KEY,
                "PG_DB_NAME",
                "has no effect until the PostgreSQL 18 storage tier is configured; DB_NAME wins",
            ));
        }
    }
    if let Some(value) = reader.raw("PG_DB_USER") {
        if pg_configured {
            config.database.owner_role = value;
        } else {
            problems.push(ConfigProblem::warning(
                codes::IGNORED_ENV_KEY,
                "PG_DB_USER",
                "has no effect until the PostgreSQL 18 storage tier is configured; DB_USER wins",
            ));
        }
    }
    if let Some(value) = take_secret(reader, "PG_DB_PASSWORD", extracted) {
        config.database.owner_password = Some(value);
    }
    if let Some(value) = reader.raw("PG_APP_USER") {
        if pg_configured {
            config.database.app_role = value;
        } else {
            problems.push(ConfigProblem::warning(
                codes::IGNORED_ENV_KEY,
                "PG_APP_USER",
                "has no effect until the PostgreSQL 18 storage tier is configured",
            ));
        }
    }
    if let Some(value) = take_secret(reader, "PG_APP_PASSWORD", extracted) {
        config.database.app_password = Some(value);
    }
    if let Some(value) = reader.raw("PG_REPLICATION_USER") {
        if pg_configured {
            config.database.replication_role = value;
        } else {
            problems.push(ConfigProblem::warning(
                codes::IGNORED_ENV_KEY,
                "PG_REPLICATION_USER",
                "has no effect until the PostgreSQL 18 storage tier is configured",
            ));
        }
    }
    if let Some(value) = take_secret(reader, "PG_REPLICATION_PASSWORD", extracted) {
        config.database.replication_password = Some(value);
    }
    if let Some(value) = take_bool(reader, "PGBOUNCER_ENABLED", problems) {
        config.database.pgbouncer = value;
    }
    if let Some(value) = take_port(reader, "PGBOUNCER_PORT", problems) {
        config.database.pgbouncer_port = value;
    }
    if let Some(value) = reader.raw("LEADER_ELECTION_DATABASE_URL") {
        // It may carry a password; never copy it.
        if value.contains('@') {
            extracted.push("LEADER_ELECTION_DATABASE_URL".to_owned());
            problems.push(ConfigProblem::warning(
                codes::SECRET_EXTRACTED,
                "secrets.LEADER_ELECTION_DATABASE_URL",
                "LEADER_ELECTION_DATABASE_URL contains credentials; its value was not copied",
            ));
        } else {
            config
                .extra
                .insert("LEADER_ELECTION_DATABASE_URL".to_owned(), value);
        }
    }
    if config.database.mode == DatabaseMode::Managed {
        config.database.tls = true;
    }
}

fn apply_database_url(config: &mut PgctlConfig, raw: &str) {
    let Some(rest) = raw
        .strip_prefix("postgresql://")
        .or_else(|| raw.strip_prefix("postgres://"))
    else {
        return;
    };
    let (authority, query) = match rest.split_once('?') {
        Some((authority, query)) => (authority, Some(query)),
        None => (rest, None),
    };
    let (authority, database) = match authority.split_once('/') {
        Some((authority, database)) => (authority, Some(database)),
        None => (authority, None),
    };
    let host_port = authority.rsplit('@').next().unwrap_or(authority);
    let (host, port) = match host_port.rsplit_once(':') {
        Some((host, port)) => (host, port.parse::<u16>().ok()),
        None => (host_port, None),
    };
    if !host.is_empty() && host != config.database.host.as_deref().unwrap_or("") {
        config.database.host = Some(host.trim_matches(['[', ']']).to_owned());
    }
    if let Some(port) = port {
        config.database.port = port;
    }
    if let Some(database) = database.filter(|name| !name.is_empty()) {
        config.database.name = database.to_owned();
    }
    if query.is_some_and(|query| query.contains("sslmode=")) {
        config.database.tls = true;
    }
}

fn import_redis(
    reader: &mut Reader<'_>,
    config: &mut PgctlConfig,
    problems: &mut Vec<ConfigProblem>,
    extracted: &mut Vec<String>,
) {
    if let Some(value) = take_secret(reader, "REDIS_PASSWORD", extracted) {
        config.redis.password = Some(value);
    }
    if let Some(value) = reader.raw("REDIS_URL") {
        if value.contains('@') {
            extracted.push("REDIS_URL".to_owned());
            problems.push(ConfigProblem::warning(
                codes::SECRET_EXTRACTED,
                "secrets.REDIS_URL",
                "REDIS_URL contains credentials; only host, port and TLS were copied",
            ));
        }
        if value.starts_with("redis://") || value.starts_with("rediss://") {
            apply_redis_url(config, &value);
        } else {
            problems.push(ConfigProblem::error(
                codes::INVALID_ENV_VALUE,
                "REDIS_URL",
                "must start with redis:// or rediss://",
            ));
        }
    }
}

fn apply_redis_url(config: &mut PgctlConfig, raw: &str) {
    let (tls, rest) = if let Some(rest) = raw.strip_prefix("rediss://") {
        (true, rest)
    } else if let Some(rest) = raw.strip_prefix("redis://") {
        (false, rest)
    } else {
        return;
    };
    config.redis.enabled = true;
    config.redis.tls = tls;
    let authority = rest.split('/').next().unwrap_or(rest);
    let host_port = authority.rsplit('@').next().unwrap_or(authority);
    let (host, port) = match host_port.rsplit_once(':') {
        Some((host, port)) => (host, port.parse::<u16>().ok()),
        None => (host_port, None),
    };
    if !host.is_empty() {
        config.redis.host = Some(host.to_owned());
    }
    if let Some(port) = port {
        config.redis.port = port;
    }
}

fn import_backup(
    reader: &mut Reader<'_>,
    config: &mut PgctlConfig,
    problems: &mut Vec<ConfigProblem>,
    extracted: &mut Vec<String>,
) {
    if let Some(value) = take_bool(reader, "BACKUP_ENABLED", problems) {
        config.services.backup.enabled = value;
    }
    if let Some(value) = reader.raw("BACKUP_ENGINE_MODE") {
        config.backup.engine = match value.to_ascii_lowercase().as_str() {
            "pg-native" => BackupEngine::PgNative,
            "wal-g" => BackupEngine::WalG,
            "barman" => BackupEngine::Barman,
            // `auto` resolves to pg-native (ADR-0004 / resolveBackupEngineMode).
            "auto" => BackupEngine::PgNative,
            other => {
                problems.push(ConfigProblem::error(
                    codes::INVALID_ENV_VALUE,
                    "BACKUP_ENGINE_MODE",
                    format!("'{other}' must be pg-native, wal-g, barman or auto"),
                ));
                config.backup.engine
            }
        };
    }
    if let Some(value) = reader.raw("BACKUP_LOCAL_REPO_DIR") {
        config.backup.local_repo = value;
    }
    if let Some(value) = reader.raw("BACKUP_PRIMARY_S3_ENDPOINT") {
        config.backup.endpoint = Some(value);
    }
    if let Some(value) = reader.raw("BACKUP_PRIMARY_S3_BUCKET") {
        config.backup.bucket = Some(value);
    }
    if let Some(value) = reader.raw("BACKUP_S3_MODE") {
        config.backup.s3_mode = match value.to_ascii_lowercase().as_str() {
            "auto" => S3Mode::Auto,
            "external" => S3Mode::External,
            "managed-minio" => S3Mode::ManagedMinio,
            other => {
                problems.push(ConfigProblem::error(
                    codes::INVALID_ENV_VALUE,
                    "BACKUP_S3_MODE",
                    format!("'{other}' must be auto, external or managed-minio"),
                ));
                config.backup.s3_mode
            }
        };
    }
    if let Some(value) = take_bool(reader, "BACKUP_ALLOW_INSECURE_HTTP", problems) {
        config.backup.allow_insecure_http = value;
    }
    if let Some(value) = take_secret(reader, "BACKUP_PRIMARY_S3_ACCESS_KEY", extracted) {
        config.backup.access_key = Some(value);
    }
    if let Some(value) = take_secret(reader, "BACKUP_PRIMARY_S3_SECRET_KEY", extracted) {
        config.backup.secret_key = Some(value);
    }
    let _ = take_secret(reader, "BACKUP_ENCRYPTION_KEY_HEX", extracted);
    if let Some(value) = reader.raw("BACKUP_FULL_CRON") {
        config.backup.schedule.full = value;
    }
    if let Some(value) = reader.raw("BACKUP_DELTA_CRON") {
        config.backup.schedule.incremental = value;
    }
    if let Some(value) = reader.raw("BACKUP_DRILL_CRON") {
        config.backup.schedule.drill = value;
    }
    if let Some(value) = take_u32(reader, "BACKUP_RETENTION_FULL_COUNT", problems) {
        config.backup.retention.full_count = value;
    }
    if let Some(value) = take_u32(reader, "BACKUP_RETENTION_WAL_DAYS", problems) {
        config.backup.retention.wal_days = value;
    }
    if let Some(value) = take_port(reader, "BACKUP_DAEMON_PORT", problems) {
        config.services.backup.port = value;
    }
}

fn import_object_storage(
    reader: &mut Reader<'_>,
    config: &mut PgctlConfig,
    problems: &mut Vec<ConfigProblem>,
    extracted: &mut Vec<String>,
) {
    if let Some(value) = take_bool(reader, "OBJECT_STORAGE_ENABLED", problems) {
        config.services.object_storage.enabled = value;
    }
    if let Some(value) = take_bool(reader, "OBJECT_STORAGE_MANAGE_VIA_SSH", problems) {
        if value {
            config.services.object_storage.enabled = true;
        }
    }
    if let Some(value) = take_port(reader, "OBJECT_STORAGE_DAEMON_PORT", problems) {
        config.services.object_storage.port = value;
    }
    if let Some(value) = reader.raw("OBJECT_STORAGE_ROOT_DIR") {
        config.object_storage.root = value;
    }
    if let Some(value) = reader.raw("OBJECT_STORAGE_DAEMON_BIND_HOST") {
        config.object_storage.bind = value;
    }
    if let Some(value) = take_secret(reader, "OBJECT_STORAGE_KEK_KEYRING", extracted) {
        config.object_storage.kek = Some(value);
    }
    if let Some(value) = take_u32(reader, "OBJECT_STORAGE_ACTIVE_KEK_VERSION", problems) {
        config.object_storage.active_kek_version = value;
    }
    if let Some(value) = take_bool(reader, "OBJECT_STORAGE_ALLOW_INSECURE_HTTP", problems) {
        config.object_storage.allow_insecure_http = value;
    }
    if let Some(value) = reader.raw("OBJECT_STORAGE_ALLOWED_CLIENT_CNS") {
        config.object_storage.allowed_client_cns = split_list(&value);
    }
    if let Some(value) = take_u32(reader, "OBJECT_STORAGE_TRASH_RETENTION_DAYS", problems) {
        config.object_storage.trash_retention_days = value;
    }
    if let Some(value) = take_u32(reader, "OBJECT_STORAGE_GC_GRACE_HOURS", problems) {
        config.object_storage.gc_grace_hours = value;
    }
}

fn import_services(
    reader: &mut Reader<'_>,
    config: &mut PgctlConfig,
    problems: &mut Vec<ConfigProblem>,
) {
    if let Some(value) = take_port(reader, "CORE_PORT", problems) {
        config.services.core.port = value;
    }
    if let Some(value) = take_port(reader, "SANDBOX_CORE_PORT", problems) {
        config.services.core.sandbox_port = value;
    }
    if let Some(value) = take_port(reader, "ADMIN_BACK_PORT", problems) {
        config.services.edges.admin.port = value;
    }
    if let Some(value) = take_port(reader, "ADMIN_NGINX_LAN_PORT", problems) {
        config.services.edges.admin.nginx_port = value;
    }
    if let Some(value) = take_port(reader, "MERCHANT_BACK_PORT", problems) {
        config.services.edges.merchant.port = value;
    }
    if let Some(value) = take_port(reader, "MERCHANT_HTTPS_PORT", problems) {
        config.services.edges.merchant.nginx_port = value;
    }
    if let Some(value) = take_port(reader, "MERCHANT_LAN_PORT", problems) {
        config.services.edges.merchant.lan_port = if value == 0 { None } else { Some(value) };
    }
    if let Some(value) = take_port(reader, "CHECKOUT_BACK_PORT", problems) {
        config.services.edges.checkout.port = value;
    }
    if let Some(value) = take_port(reader, "CHECKOUT_HTTPS_PORT", problems) {
        config.services.edges.checkout.nginx_port = value;
    }
    if let Some(value) = take_port(reader, "CHECKOUT_LAN_PORT", problems) {
        config.services.edges.checkout.lan_port = if value == 0 { None } else { Some(value) };
    }
    if let Some(value) = take_bool(reader, "FAKE_RAILS_ENABLED", problems) {
        config.services.fake_rails.enabled = value;
    }
    if let Some(value) = take_port(reader, "FAKE_RAILS_BACK_PORT", problems) {
        config.services.fake_rails.port = value;
    }
    if let Some(value) = take_port(reader, "FAKE_RAILS_NGINX_PORT", problems) {
        config.services.fake_rails.nginx_port = value;
    }
    if let Some(value) = take_bool(reader, "FAKE_RAILS_ALLOW_IN_PRODUCTION", problems) {
        config.services.fake_rails.allow_in_production = value;
    }
    if let Some(value) = reader.raw("FAKE_RAILS_DOMAIN") {
        config.services.fake_rails.public_host = Some(value);
    }
    // Every service starts on the TS implementation until the port says otherwise.
    config.services.core.implementation = ImplKind::Ts;
    config.services.edges.implementation = ImplKind::Ts;
    config.services.fake_rails.implementation = ImplKind::Ts;
    config.services.backup.implementation = ImplKind::Ts;
    config.services.object_storage.implementation = ImplKind::Ts;
}

fn import_fake_rails_secrets(reader: &mut Reader<'_>, extracted: &mut Vec<String>) {
    for key in [
        "FAKE_RAILS_ADMIN_PASSWORD",
        "FAKE_RAILS_JWT_SECRET",
        "FAKE_RAILS_SEEDER_TOKEN",
        "FAKE_RAILS_CONTROL_TOKEN",
    ] {
        let _ = take_secret(reader, key, extracted);
    }
}

fn import_sandbox_and_seed(
    reader: &mut Reader<'_>,
    config: &mut PgctlConfig,
    problems: &mut Vec<ConfigProblem>,
) {
    if let Some(value) = take_bool(reader, "SANDBOX_ENABLED", problems) {
        config.sandbox.enabled = value;
    }
    if let Some(value) = reader.raw("SANDBOX_DB_NAME") {
        config.sandbox.db_name = value;
    }
    if let Some(value) = reader.raw("SANDBOX_NODE") {
        match parse_node_list(&value) {
            Ok(mut nodes) if nodes.len() == 1 => {
                if let Some(node) = nodes.pop() {
                    config.sandbox.host = Some(node.private_ip);
                }
            }
            Ok(_) => problems.push(ConfigProblem::error(
                codes::INVALID_NODE_LIST,
                "SANDBOX_NODE",
                "must describe exactly one node",
            )),
            Err(message) => problems.push(ConfigProblem::error(
                codes::INVALID_NODE_LIST,
                "SANDBOX_NODE",
                message,
            )),
        }
    }
    if let Some(value) = take_bool(reader, "RUN_PRISMA_SEED", problems) {
        config.seed.run_base = value;
    }
    if let Some(value) = take_bool(reader, "RUN_SYNTHETIC_HISTORY_SEED", problems) {
        config.seed.run_synthetic = value;
    }
    if let Some(value) = reader.raw("SYNTHETIC_SEED_PROFILE") {
        config.seed.profile = match value.to_ascii_uppercase().as_str() {
            "COMPACT" => SeedProfile::Compact,
            "STANDARD" => SeedProfile::Standard,
            "STRESS" => SeedProfile::Stress,
            other => {
                problems.push(ConfigProblem::error(
                    codes::INVALID_ENV_VALUE,
                    "SYNTHETIC_SEED_PROFILE",
                    format!("'{other}' must be COMPACT, STANDARD or STRESS"),
                ));
                config.seed.profile
            }
        };
    }
}

fn import_hosts(
    reader: &mut Reader<'_>,
    config: &mut PgctlConfig,
    problems: &mut Vec<ConfigProblem>,
    extracted: &mut Vec<String>,
) {
    // Tier SSH users apply to every node of the array (the TS grammar carries no user).
    let core_user = reader.peek("CORE_SSH_USER").unwrap_or("ubuntu").to_owned();
    let pg_user = reader.peek("PG_SSH_USER").unwrap_or("ubuntu").to_owned();
    let redis_user = reader.peek("REDIS_SSH_USER").unwrap_or("ubuntu").to_owned();
    let audit_user = reader
        .peek("AUDIT_DB_SSH_USER")
        .unwrap_or("ubuntu")
        .to_owned();
    let log_user = reader
        .peek("LOG_DB_SSH_USER")
        .unwrap_or("ubuntu")
        .to_owned();
    let backup_user = reader
        .peek("BACKUP_SSH_USER")
        .unwrap_or("ubuntu")
        .to_owned();
    let object_user = reader
        .peek("OBJECT_STORAGE_SSH_USER")
        .unwrap_or("ubuntu")
        .to_owned();
    let fake_rails_user = reader
        .peek("FAKE_RAILS_SSH_USER")
        .unwrap_or("ubuntu")
        .to_owned();

    // The primary node also carries the database endpoint and, with PgBouncer, the pooler role.
    if let Some(value) = reader.raw("PG_PRIMARY_NODE") {
        match parse_node_list(&value) {
            Ok(nodes) => {
                if nodes.len() > 1 {
                    problems.push(ConfigProblem::error(
                        codes::INVALID_NODE_LIST,
                        "PG_PRIMARY_NODE",
                        "must describe exactly one primary",
                    ));
                }
                if let Some(node) = nodes.first() {
                    upsert_host(config, node, Role::PgPrimary, &pg_user);
                    config.database.host = Some(node.private_ip.clone());
                    config.database.port = node.service_port;
                }
            }
            Err(message) => problems.push(ConfigProblem::error(
                codes::INVALID_NODE_LIST,
                "PG_PRIMARY_NODE",
                message,
            )),
        }
    }

    for (key, role, user) in [
        ("CORE_NODES", Role::Core, &core_user),
        ("ADMIN_NODES", Role::Admin, &core_user),
        ("MERCHANT_NODES", Role::Merchant, &core_user),
        ("CHECKOUT_NODES", Role::Checkout, &core_user),
        ("PG_REPLICA_NODES", Role::PgReplica, &pg_user),
        ("REDIS_NODES", Role::Redis, &redis_user),
        ("AUDIT_DB_NODE", Role::AuditDb, &audit_user),
        ("LOG_DB_NODE", Role::LogDb, &log_user),
        ("BACKUP_NODE", Role::Backup, &backup_user),
        ("OBJECT_STORAGE_NODE", Role::ObjectStorage, &object_user),
        ("FAKE_RAILS_NODE", Role::FakeRails, &fake_rails_user),
    ] {
        if let Some(value) = reader.raw(key) {
            match parse_node_list(&value) {
                Ok(nodes) => {
                    for node in nodes {
                        upsert_host(config, &node, role, user);
                    }
                }
                Err(message) => {
                    problems.push(ConfigProblem::error(codes::INVALID_NODE_LIST, key, message))
                }
            }
        }
    }

    // Redis node arrays also enable the cache tier and carry its endpoint.
    if config.redis.host.is_none() {
        let redis_endpoint = config
            .hosts_with_role(Role::Redis)
            .first()
            .map(|host| (host.peer_address().to_owned(), host.service_port));
        if let Some((address, port)) = redis_endpoint {
            config.redis.enabled = true;
            config.redis.host = Some(address);
            if let Some(port) = port {
                config.redis.port = port;
            }
        }
    }

    // Backup/object-storage activity is implied by their node arrays.
    if config.first_host_with_role(Role::Backup).is_some() {
        config.services.backup.enabled = true;
    }
    if config.first_host_with_role(Role::ObjectStorage).is_some() {
        config.services.object_storage.enabled = true;
    }
    if config.first_host_with_role(Role::Redis).is_some() {
        config.redis.enabled = true;
    }

    // Legacy single-host fields, used only when the array of that tier is empty.
    let core_service_port = config.services.core.port;
    let fake_rails_port = config.services.fake_rails.port;
    let fake_rails_enabled = config.services.fake_rails.enabled;
    import_legacy_host(
        reader,
        config,
        Role::Core,
        "CORE",
        Some(core_service_port),
        problems,
    );
    import_legacy_host(reader, config, Role::Admin, "ADMIN", None, problems);
    import_legacy_host(reader, config, Role::Merchant, "MERCHANT", None, problems);
    import_legacy_host(reader, config, Role::Checkout, "CHECKOUT", None, problems);
    import_legacy_db_host(reader, config, problems);
    if fake_rails_enabled {
        import_legacy_host(
            reader,
            config,
            Role::FakeRails,
            "FAKE_RAILS",
            Some(fake_rails_port),
            problems,
        );
    }

    if config.database.pgbouncer {
        let mut poolers: Vec<(String, u16)> = Vec::new();
        for host in &config.hosts {
            if host.has_role(Role::PgPrimary) || host.has_role(Role::PgReplica) {
                poolers.push((
                    host.name.clone(),
                    host.service_port.unwrap_or(config.database.port),
                ));
            }
        }
        for (name, _) in poolers {
            if let Some(host) = config.hosts.iter_mut().find(|host| host.name == name) {
                if !host.has_role(Role::Pgbouncer) {
                    host.roles.push(Role::Pgbouncer);
                }
            }
        }
    }
    attach_ssh_settings(reader, config, extracted);
}

/// Per-tier SSH key and sudo password (chapter 7 §5: per-node credentials, sudo over stdin).
fn attach_ssh_settings(
    reader: &mut Reader<'_>,
    config: &mut PgctlConfig,
    extracted: &mut Vec<String>,
) {
    const TIERS: &[(&str, &[Role])] = &[
        ("CORE", &[Role::Core]),
        ("ADMIN", &[Role::Admin]),
        ("MERCHANT", &[Role::Merchant]),
        ("CHECKOUT", &[Role::Checkout]),
        ("DB", &[Role::Db]),
        ("PG", &[Role::PgPrimary, Role::PgReplica]),
        ("REDIS", &[Role::Redis]),
        ("AUDIT_DB", &[Role::AuditDb]),
        ("LOG_DB", &[Role::LogDb]),
        ("BACKUP", &[Role::Backup]),
        ("OBJECT_STORAGE", &[Role::ObjectStorage]),
        ("FAKE_RAILS", &[Role::FakeRails]),
    ];
    for (prefix, roles) in TIERS {
        if let Some(key) = reader.raw(&format!("{prefix}_SSH_KEY_PATH")) {
            for host in &mut config.hosts {
                if roles.iter().any(|role| host.has_role(*role)) && host.ssh_key.is_none() {
                    host.ssh_key = Some(key.clone());
                }
            }
        }
        let sudo_key = format!("{prefix}_SUDO_PASSWORD");
        if reader.raw(&sudo_key).is_some() {
            let reference = format!("secret:{}", sudo_key.to_ascii_lowercase());
            for host in &mut config.hosts {
                if roles.iter().any(|role| host.has_role(*role)) && host.sudo_password.is_none() {
                    host.sudo_password = Some(reference.clone());
                }
            }
            extracted.push(sudo_key);
        }
    }
}

fn import_legacy_host(
    reader: &mut Reader<'_>,
    config: &mut PgctlConfig,
    role: Role,
    prefix: &str,
    service_port: Option<u16>,
    problems: &mut Vec<ConfigProblem>,
) {
    let host_key = format!("{prefix}_SSH_HOST");
    let Some(address) = reader.raw(&host_key) else {
        // Consume the rest so they are reported as unmapped, not silently skipped.
        for suffix in ["SSH_PORT", "SSH_USER", "PRIVATE_IP"] {
            let _ = reader.raw(&format!("{prefix}_{suffix}"));
        }
        return;
    };
    if config.first_host_with_role(role).is_some() {
        return;
    }
    let ssh_port = take_port(reader, &format!("{prefix}_SSH_PORT"), problems).unwrap_or(22);
    let ssh_user = reader
        .raw(&format!("{prefix}_SSH_USER"))
        .unwrap_or_else(|| "ubuntu".to_owned());
    let private_ip = reader
        .raw(&format!("{prefix}_PRIVATE_IP"))
        .unwrap_or_else(|| address.clone());
    config.hosts.push(Host {
        name: format!("{}-1", role.as_str()),
        address,
        ssh_port,
        ssh_user,
        roles: vec![role],
        private_ip,
        public_ip: String::new(),
        service_port,
        ssh_key: None,
        sudo_password: None,
    });
}

fn import_legacy_db_host(
    reader: &mut Reader<'_>,
    config: &mut PgctlConfig,
    problems: &mut Vec<ConfigProblem>,
) {
    let Some(address) = reader.raw("DB_SSH_HOST") else {
        for suffix in ["SSH_PORT", "SSH_USER", "PRIVATE_IP"] {
            let _ = reader.raw(&format!("DB_{suffix}"));
        }
        return;
    };
    if config.first_host_with_role(Role::Db).is_some() {
        return;
    }
    let ssh_port = take_port(reader, "DB_SSH_PORT", problems).unwrap_or(22);
    let ssh_user = reader
        .raw("DB_SSH_USER")
        .unwrap_or_else(|| "ubuntu".to_owned());
    let private_ip = reader
        .raw("DB_PRIVATE_IP")
        .unwrap_or_else(|| address.clone());
    let service_port = config.database.port;
    config.hosts.push(Host {
        name: "db-1".to_owned(),
        address,
        ssh_port,
        ssh_user,
        roles: vec![Role::Db],
        private_ip,
        public_ip: String::new(),
        service_port: Some(service_port),
        ssh_key: None,
        sudo_password: None,
    });
}

fn upsert_host(config: &mut PgctlConfig, node: &ParsedNode, role: Role, ssh_user: &str) {
    if let Some(host) = config.hosts.iter_mut().find(|host| {
        host.address == node.ssh_host && host.ssh_port == node.ssh_port && host.ssh_user == ssh_user
    }) {
        if host.name.is_empty() {
            host.name = node.node_id.clone();
        }
        if host.private_ip.is_empty() {
            host.private_ip = node.private_ip.clone();
        }
        if host.service_port.is_none() {
            host.service_port = Some(node.service_port);
        }
        if !host.roles.contains(&role) {
            host.roles.push(role);
        }
        return;
    }
    config.hosts.push(Host {
        name: node.node_id.clone(),
        address: node.ssh_host.clone(),
        ssh_port: node.ssh_port,
        ssh_user: ssh_user.to_owned(),
        roles: vec![role],
        private_ip: node.private_ip.clone(),
        public_ip: String::new(),
        service_port: Some(node.service_port),
        ssh_key: None,
        sudo_password: None,
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::validate::validate;

    fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect()
    }

    fn example_source() -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../deploy/deploy.env.example");
        std::fs::read_to_string(&path).expect("deploy/deploy.env.example is part of the repository")
    }

    #[test]
    fn env_parser_handles_quotes_and_inline_comments() {
        let source = "\
# comment
DEPLOY_MODE=\"auto\"                  # \"auto\" | \"fresh\" | \"update\"
DEPLOY_ENV=production # fail-safe
DB_PASSWORD='p#ss word'
IGNORED_LINE
EMPTY=
";
        let parsed = parse_env_source(source);
        assert_eq!(parsed.get("DEPLOY_MODE").map(String::as_str), Some("auto"));
        assert_eq!(
            parsed.get("DEPLOY_ENV").map(String::as_str),
            Some("production")
        );
        assert_eq!(
            parsed.get("DB_PASSWORD").map(String::as_str),
            Some("p#ss word")
        );
        assert_eq!(parsed.get("EMPTY").map(String::as_str), Some(""));
        assert!(!parsed.contains_key("IGNORED_LINE"));
    }

    #[test]
    fn node_grammar_matches_the_ts_errors() {
        let nodes = parse_node_list(
            "core-1@10.0.0.11:22:10.0.0.11:4000,core-2@10.0.0.12:2222:10.0.0.12:4010",
        )
        .expect("valid node list");
        assert_eq!(nodes.len(), 2);
        assert_eq!(nodes[1].ssh_port, 2222);
        assert_eq!(nodes[1].service_port, 4010);

        assert!(parse_node_list("core-1@10.0.0.11:22:10.0.0.11").is_err());
        assert!(parse_node_list(
            "core-1@10.0.0.11:22:10.0.0.11:4000,core-1@10.0.0.12:22:10.0.0.12:4000"
        )
        .is_err());
        assert!(parse_node_list(
            "core-1@10.0.0.11:22:10.0.0.11:4000,core-2@10.0.0.11:22:10.0.0.11:4000"
        )
        .is_err());
        assert!(parse_node_list("bad id@10.0.0.11:22:10.0.0.11:4000").is_err());
        assert!(parse_node_list("core-1@10.0.0.999:22:10.0.0.11:4000").is_err());
        assert!(parse_node_list("")
            .expect("empty list is allowed")
            .is_empty());
    }

    #[test]
    fn the_repository_example_imports_cleanly() {
        let source = example_source();
        let parsed = parse_env_source(&source);
        let outcome = import_env_detailed(&parsed);
        assert!(
            !crate::problem::has_errors(&outcome.problems),
            "{:?}",
            outcome.problems
        );

        let config = &outcome.config;
        assert_eq!(config.deployment.environment, Environment::Production);
        assert_eq!(config.deployment.mode, crate::model::DeployMode::Auto);
        assert_eq!(config.services.core.port, 4000);
        assert_eq!(config.services.core.sandbox_port, 4005);
        assert_eq!(config.services.edges.admin.port, 4101);
        assert_eq!(config.services.edges.admin.nginx_port, 8443);
        assert_eq!(config.services.edges.merchant.port, 4102);
        assert_eq!(config.services.edges.merchant.lan_port, Some(8081));
        assert_eq!(config.services.edges.checkout.port, 4103);
        assert_eq!(config.services.edges.checkout.lan_port, Some(8082));
        assert_eq!(config.services.fake_rails.port, 4104);
        assert_eq!(config.services.fake_rails.nginx_port, 8444);
        assert_eq!(config.database.port, 5432);
        assert_eq!(config.database.name, "payment_gateway_prod");
        assert_eq!(config.database.owner_role, "gw_core_user");
        assert_eq!(config.database.host.as_deref(), Some("10.10.0.10"));
        assert_eq!(config.backup.engine, BackupEngine::PgNative);
        assert_eq!(config.services.backup.port, 4090);
        assert_eq!(config.services.object_storage.port, 4095);
        assert_eq!(config.tls.mode, TlsMode::Certbot);
        assert!(config
            .tls
            .certbot_domains
            .iter()
            .any(|domain| domain == "merchant.yourdomain.ly"));
        assert_eq!(config.seed.profile, SeedProfile::Compact);
        assert_eq!(config.hosts_with_role(Role::Core)[0].address, "10.10.0.20");
        assert_eq!(
            config.hosts_with_role(Role::Merchant)[0].private_ip,
            "10.10.0.40"
        );
        assert_eq!(config.hosts_with_role(Role::Db).len(), 1);

        // The document never carries a secret value, and the TOML never carries it either.
        let toml = toml::to_string_pretty(config).expect("serialisable");
        assert!(!toml.contains("change-me"), "{toml}");
        let json = serde_json::to_string(config).expect("serialisable");
        assert!(!json.contains("change-me-strong-db-password"));
        assert_eq!(
            config.database.owner_password.as_deref(),
            Some("secret:db_password")
        );
        assert!(outcome
            .extracted_secrets
            .iter()
            .any(|key| key == "DB_PASSWORD"));
        assert!(outcome
            .extracted_secrets
            .iter()
            .any(|key| key == "KMS_MASTER_KEY"));
    }

    #[test]
    fn every_documented_key_is_consumed_by_the_example() {
        let parsed = parse_env_source(&example_source());
        let outcome = import_env_detailed(&parsed);
        for (key, target) in ENV_KEY_MAP {
            if !parsed.contains_key(*key) {
                continue;
            }
            if parsed
                .get(*key)
                .map(|value| value.trim().is_empty())
                .unwrap_or(true)
            {
                continue;
            }
            assert!(
                !outcome.unmapped.iter().any(|entry| entry == key),
                "{key} is documented as mapped but landed in extra"
            );
            if target.starts_with("secret:") {
                assert!(
                    outcome.extracted_secrets.iter().any(|entry| entry == key),
                    "{key} is documented as a secret but was not extracted"
                );
            }
        }
    }

    #[test]
    fn unmapped_keys_land_in_extra_with_a_warning() {
        let outcome = import_env_detailed(&env(&[
            ("DEPLOY_ENV", "development"),
            ("ADMIN_SHOW_HELP_PANELS", "true"),
            ("ROLLING_BATCH_SIZE", "2"),
        ]));
        assert_eq!(
            outcome
                .config
                .extra
                .get("ADMIN_SHOW_HELP_PANELS")
                .map(String::as_str),
            Some("true")
        );
        assert!(outcome.problems.iter().any(|problem| {
            problem.code == codes::UNMAPPED && problem.path == "extra.ADMIN_SHOW_HELP_PANELS"
        }));
        assert!(outcome.unmapped.contains(&"ROLLING_BATCH_SIZE".to_owned()));
    }

    #[test]
    fn secrets_are_referenced_and_never_stored() {
        let outcome = import_env_detailed(&env(&[
            ("PG_MANAGE_VIA_SSH", "true"),
            ("PG_PRIMARY_NODE", "pg-pri@10.0.0.21:22:10.0.0.21:5432"),
            ("PG_DB_PASSWORD", "Kf9#mQ2vLx7$Rw4nZt8B"),
            ("PG_APP_PASSWORD", "aVeryLongSecretPassword99"),
        ]));
        let config = &outcome.config;
        assert_eq!(config.database.mode, DatabaseMode::Managed);
        assert_eq!(
            config.database.owner_password.as_deref(),
            Some("secret:pg_db_password")
        );
        assert_eq!(
            config.database.app_password.as_deref(),
            Some("secret:pg_app_password")
        );
        let json = serde_json::to_string(&config).expect("serialisable");
        assert!(!json.contains("Kf9#mQ2vLx7"), "{json}");
        assert_eq!(
            outcome.extracted_secrets,
            vec!["PG_DB_PASSWORD".to_owned(), "PG_APP_PASSWORD".to_owned()]
        );
        // These keys have a TOML home, so they are extracted as references without the
        // "no home" warning; the value still never reaches the document.
        assert!(outcome
            .problems
            .iter()
            .all(|problem| problem.code != codes::SECRET_EXTRACTED));
    }

    #[test]
    fn weak_and_pan_secrets_are_reported_without_echoing_values() {
        let outcome = import_env_detailed(&env(&[
            ("DEPLOY_ENV", "development"),
            ("DB_PASSWORD", "change-me-strong-db-password"),
            ("PAN_RAIL", "edfali"),
            ("SMOKE", "4111 1111 1111 1111"),
        ]));
        assert!(outcome
            .problems
            .iter()
            .any(|problem| problem.code == codes::WEAK_SECRET && !problem.is_error()));
        assert_eq!(
            outcome
                .problems
                .iter()
                .filter(|problem| problem.code == codes::PAN_RAIL_GUARD)
                .count(),
            2
        );
        for problem in &outcome.problems {
            assert!(
                !problem.message.contains("change-me-strong"),
                "{}",
                problem.message
            );
        }
    }

    #[test]
    fn backup_auto_resolves_to_pg_native_and_s3_mode_is_kept() {
        let outcome = import_env_detailed(&env(&[
            ("BACKUP_ENABLED", "true"),
            ("BACKUP_ENGINE_MODE", "auto"),
            ("BACKUP_S3_MODE", "managed-minio"),
            ("BACKUP_FULL_CRON", "0 3 * * 0"),
        ]));
        assert_eq!(outcome.config.backup.engine, BackupEngine::PgNative);
        assert_eq!(outcome.config.backup.s3_mode, S3Mode::ManagedMinio);
        assert_eq!(outcome.config.backup.schedule.full, "0 3 * * 0");
        assert!(outcome.config.services.backup.enabled);
    }

    #[test]
    fn storage_nodes_and_pgbouncer_roles_merge_by_ssh_endpoint() {
        let outcome = import_env_detailed(&env(&[
            ("PG_MANAGE_VIA_SSH", "true"),
            ("PG_PRIMARY_NODE", "pg-pri@10.0.0.21:22:10.0.0.21:5432"),
            ("PG_REPLICA_NODES", "pg-rep-1@10.0.0.22:22:10.0.0.22:5432"),
            ("PGBOUNCER_ENABLED", "true"),
            ("PGBOUNCER_PORT", "6432"),
        ]));
        let config = &outcome.config;
        assert_eq!(config.hosts.len(), 2);
        assert!(config.hosts[0].has_role(Role::PgPrimary));
        assert!(config.hosts[0].has_role(Role::Pgbouncer));
        assert!(config.hosts[1].has_role(Role::PgReplica));
        assert!(config.hosts[1].has_role(Role::Pgbouncer));
        assert_eq!(config.database.pgbouncer_port, 6432);
        assert_eq!(config.database.name, "payment_gateway_prod");
    }

    #[test]
    fn a_multi_node_fleet_imports_every_host() {
        let outcome = import_env_detailed(&env(&[
            (
                "CORE_NODES",
                "core-1@10.0.0.11:22:10.0.0.11:4000,core-2@10.0.0.12:22:10.0.0.12:4000",
            ),
            ("ADMIN_NODES", "admin-1@10.0.0.30:22:10.0.0.30:4101"),
            ("OBJECT_STORAGE_NODE", "obj-1@10.0.0.50:22:10.0.0.50:4095"),
            (
                "OBJECT_STORAGE_KEK_KEYRING",
                "v1:00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
            ),
        ]));
        let config = &outcome.config;
        assert_eq!(config.hosts_with_role(Role::Core).len(), 2);
        assert_eq!(config.hosts_with_role(Role::Admin)[0].name, "admin-1");
        assert!(config.services.object_storage.enabled);
        assert_eq!(
            config.object_storage.kek.as_deref(),
            Some("secret:object_storage_kek_keyring")
        );
        assert!(
            !crate::problem::has_errors(&outcome.problems),
            "{:?}",
            outcome.problems
        );
    }

    #[test]
    fn sandbox_node_becomes_the_sandbox_host() {
        let outcome = import_env_detailed(&env(&[
            ("SANDBOX_ENABLED", "true"),
            ("SANDBOX_DB_NAME", "pg_sandbox"),
            ("SANDBOX_NODE", "sandbox-1@10.0.0.70:22:10.0.0.70:4005"),
        ]));
        assert!(outcome.config.sandbox.enabled);
        assert_eq!(outcome.config.sandbox.db_name, "pg_sandbox");
        assert_eq!(outcome.config.sandbox.host.as_deref(), Some("10.0.0.70"));
    }

    #[test]
    fn a_database_url_is_parsed_but_never_stored() {
        let outcome = import_env_detailed(&env(&[
            ("DATABASE_URL", "postgresql://gw_core_user:s3cret@db.internal:5433/payment_gateway_prod?sslmode=require"),
        ]));
        let config = &outcome.config;
        assert_eq!(config.database.url.as_deref(), Some("secret:database_url"));
        assert_eq!(config.database.host.as_deref(), Some("db.internal"));
        assert_eq!(config.database.port, 5433);
        assert_eq!(config.database.name, "payment_gateway_prod");
        assert!(config.database.tls);
        assert!(!serde_json::to_string(config)
            .expect("serialisable")
            .contains("s3cret"));
    }

    #[test]
    fn ssh_key_and_sudo_are_attached_to_the_tier_hosts() {
        let outcome = import_env_detailed(&env(&[
            ("CORE_NODES", "core-1@10.0.0.11:22:10.0.0.11:4000"),
            ("CORE_SSH_KEY_PATH", "~/.ssh/pg_core"),
            ("CORE_SUDO_PASSWORD", "Kf9mQ2vLx7Rw4nZt8B"),
            ("PG_PRIMARY_NODE", "pg-pri@10.0.0.21:22:10.0.0.21:5432"),
            ("PG_SSH_KEY_PATH", "~/.ssh/pg_db"),
        ]));
        let core = outcome
            .config
            .hosts_with_role(Role::Core)
            .first()
            .copied()
            .expect("core host");
        assert_eq!(core.ssh_key.as_deref(), Some("~/.ssh/pg_core"));
        assert_eq!(
            core.sudo_password.as_deref(),
            Some("secret:core_sudo_password")
        );
        let primary = outcome
            .config
            .hosts_with_role(Role::PgPrimary)
            .first()
            .copied()
            .expect("pg host");
        assert_eq!(primary.ssh_key.as_deref(), Some("~/.ssh/pg_db"));
        assert!(outcome
            .extracted_secrets
            .iter()
            .any(|key| key == "CORE_SUDO_PASSWORD"));
        assert!(!serde_json::to_string(&outcome.config)
            .expect("serialisable")
            .contains("Kf9mQ2vLx7Rw4nZt8B"));
    }

    #[test]
    fn invalid_values_become_findings_not_panics() {
        let outcome = import_env_detailed(&env(&[
            ("DEPLOY_ENV", "qa"),
            ("CORE_PORT", "not-a-port"),
            ("CORE_NODES", "broken"),
            ("BACKUP_ENGINE_MODE", "rsync"),
            ("SYNTHETIC_SEED_PROFILE", "HUGE"),
        ]));
        let codes: Vec<&str> = outcome
            .problems
            .iter()
            .map(|problem| problem.code)
            .collect();
        assert!(codes.contains(&codes::INVALID_ENV_VALUE));
        assert!(codes.contains(&codes::INVALID_NODE_LIST));
        assert!(outcome.problems.iter().all(|problem| problem.is_error()));
    }

    #[test]
    fn imported_example_validates_without_errors() {
        let parsed = parse_env_source(&example_source());
        let problems = validate(&import_env(&parsed));
        assert!(!crate::problem::has_errors(&problems), "{problems:?}");
    }
}

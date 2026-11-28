//! `pgctl.toml`: the declarative desired state of a payment-gateway deployment.
//!
//! Ports: `deploy/lib/configSchema.ts` (validation and the `deploy.env` importer),
//! `deploy/lib/hostPlanner.ts` (ports and role names), `deploy/deploy.env.example` (the key set)
//! and chapter 7 §7 / D0-T01 / D0-T02.
//!
//! Three capabilities live here:
//!
//! 1. [`model`] — a `serde`/`schemars` document that rejects unknown keys at every level and never
//!    carries a secret value (only `secret:<name>` references);
//! 2. [`validate`] — the cross-field rules of the TypeScript engine (production guard, PAN guard,
//!    `pg_*` role names, port collisions, shared-storage guard, TLS, CIDRs, certificate SANs) plus
//!    the new rules of chapter 7 §7, each with a stable [`problem::codes`] code;
//! 3. [`import_env`] — a lossless importer from `deploy/deploy.env`: mapped keys land in their
//!    field, secrets are reported by name and never copied, and every other key is kept in
//!    [`model::PgctlConfig::extra`] with an `UNMAPPED` warning.
//!
//! ```no_run
//! use pg_deploy_config::{load_toml_file, validate};
//!
//! let Ok(config) = load_toml_file(std::path::Path::new("pgctl.toml")) else {
//!     return;
//! };
//! for problem in validate(&config) {
//!     eprintln!("{problem}");
//! }
//! ```

#![forbid(unsafe_code)]

pub mod import_env;
pub mod model;
pub mod ports;
pub mod problem;
pub mod schema;
pub mod validate;

pub use import_env::{
    import_env, import_env_detailed, parse_env_file, parse_env_source, parse_node_list,
    ImportOutcome, ParsedNode, ENV_KEY_MAP,
};
pub use model::{
    AdminEdge, Backup, BackupEngine, BackupRetention, BackupSchedule, BackupService, CoreService,
    Database, DatabaseMode, DeployMode, Deployment, Edges, Environment, FakeRailsService, Host,
    ImplKind, Network, ObjectStorage, ObjectStorageService, PgctlConfig, PublicEdge, Redis, Role,
    S3Mode, Sandbox, Secrets, Seed, SeedProfile, Services, Tls, TlsMode, Watch, CONFIG_VERSION,
};
pub use ports::*;
pub use problem::{codes, has_errors, ConfigProblem, Severity};
pub use schema::{json_schema, json_schema_pretty};
pub use validate::{
    is_cidr, is_cron_like, is_fqdn, is_http_origin, is_http_url, is_https_url, is_identifier,
    is_pan_key, is_safe_abs_path, is_secret_reference, is_unix_user, looks_like_card_pan,
    luhn_valid, pan_rail_guard, validate, weak_secret_reason, SECRET_FIELDS,
};

use std::path::Path;

/// Errors from reading, writing or parsing `pgctl.toml`.
#[derive(Debug)]
pub enum ConfigError {
    /// The file could not be read.
    Io {
        path: String,
        source: std::io::Error,
    },
    /// TOML syntax or an unknown key.
    Toml { message: String },
    /// The document could not be serialised (a bug, not an operator error).
    Serialize { message: String },
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io { path, source } => write!(f, "cannot read {path}: {source}"),
            Self::Toml { message } => write!(f, "invalid pgctl.toml: {message}"),
            Self::Serialize { message } => write!(f, "cannot serialise pgctl.toml: {message}"),
        }
    }
}

impl std::error::Error for ConfigError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            _ => None,
        }
    }
}

/// Parse TOML text. Unknown keys fail here, before any host is contacted.
pub fn load_toml_str(source: &str) -> Result<PgctlConfig, ConfigError> {
    toml::from_str::<PgctlConfig>(source).map_err(|error| ConfigError::Toml {
        message: error.to_string(),
    })
}

/// Read and parse `pgctl.toml`.
pub fn load_toml_file(path: &Path) -> Result<PgctlConfig, ConfigError> {
    let source = std::fs::read_to_string(path).map_err(|source| ConfigError::Io {
        path: path.display().to_string(),
        source,
    })?;
    load_toml_str(&source)
}

/// Serialise a document as TOML. [`PgctlConfig::extra`] is deliberately not written.
pub fn to_toml_pretty(config: &PgctlConfig) -> Result<String, ConfigError> {
    toml::to_string_pretty(config).map_err(|error| ConfigError::Serialize {
        message: error.to_string(),
    })
}

/// Write `pgctl.toml` atomically with mode 0600 (it can name secret references and hosts).
pub fn save_toml_file(path: &Path, config: &PgctlConfig) -> Result<(), ConfigError> {
    let text = to_toml_pretty(config)?;
    let tmp = path.with_extension("toml.pgctl-tmp");
    std::fs::write(&tmp, text.as_bytes()).map_err(|source| ConfigError::Io {
        path: tmp.display().to_string(),
        source,
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let permissions = std::fs::Permissions::from_mode(0o600);
        std::fs::set_permissions(&tmp, permissions).map_err(|source| ConfigError::Io {
            path: tmp.display().to_string(),
            source,
        })?;
    }
    std::fs::rename(&tmp, path).map_err(|source| ConfigError::Io {
        path: path.display().to_string(),
        source,
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use model::Environment;

    #[test]
    fn a_minimal_document_parses() {
        let config = load_toml_str(
            r#"
version = 1
[deployment]
name = "pg-prod"
environment = "staging"
[services.core]
impl = "rs"
port = 4010
[[hosts]]
name = "core-1"
address = "10.0.0.11"
roles = ["core"]
private_ip = "10.0.0.11"
"#,
        )
        .expect("valid document");
        assert_eq!(config.deployment.name, "pg-prod");
        assert_eq!(config.deployment.environment, Environment::Staging);
        assert_eq!(config.services.core.implementation, ImplKind::Rs);
        assert_eq!(config.hosts[0].roles, vec![Role::Core]);
    }

    #[test]
    fn unknown_keys_and_syntax_errors_are_reported() {
        let error = load_toml_str("version = 1\nwtf = true\n").expect_err("unknown key");
        assert!(error.to_string().contains("wtf"), "{error}");
        let error = load_toml_str("[deployment\n").expect_err("bad syntax");
        assert!(error.to_string().contains("invalid pgctl.toml"));
    }

    #[test]
    fn save_and_load_round_trip() {
        let mut config = PgctlConfig::new(Environment::Development);
        config.deployment.name = "round-trip".to_owned();
        config.hosts.push(Host {
            name: "core-1".to_owned(),
            address: "127.0.0.1".to_owned(),
            roles: vec![Role::Core],
            private_ip: "127.0.0.1".to_owned(),
            ..Host::default()
        });
        let unique = format!(
            "pgctl-config-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
        );
        let path = std::env::temp_dir().join(format!("{unique}.toml"));
        save_toml_file(&path, &config).expect("saved");
        let loaded = load_toml_file(&path).expect("loaded");
        assert_eq!(loaded, config);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path)
                .expect("metadata")
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn saving_never_writes_extra_or_secret_values() {
        let mut config = PgctlConfig::default();
        config
            .extra
            .insert("ADMIN_SHOW_HELP_PANELS".to_owned(), "true".to_owned());
        config.database.owner_password = Some("secret:pg_db_password".to_owned());
        let text = to_toml_pretty(&config).expect("serialisable");
        assert!(!text.contains("ADMIN_SHOW_HELP_PANELS"));
        assert!(text.contains("secret:pg_db_password"));
    }

    #[test]
    fn public_helpers_are_reachable() {
        assert!(luhn_valid("4111111111111111"));
        assert!(is_cidr("10.0.0.0/8"));
        assert!(is_secret_reference("secret:db"));
        assert!(!has_errors(&[]));
        assert_eq!(CONFIG_VERSION, 1);
        assert!(!ports::VERIFIED_PORTS.is_empty());
        assert!(!ENV_KEY_MAP.is_empty());
    }
}

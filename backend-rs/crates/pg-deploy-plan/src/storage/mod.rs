//! Storage provisioners (D5): PostgreSQL 18, PgBouncer, Redis/Valkey, audit/log databases and
//! ClamAV.
//!
//! Every provisioner is an **idempotent converge module** in pure form: read facts, render the
//! desired configuration, diff, apply, reload or restart only when needed, verify
//! (chapter 7 §9). This crate produces the plan (files, units, SQL and verification) and never
//! opens an SSH connection, reads a secret or touches a host; the executor is wired in D1/D5
//! after the service and SSH integration.
//!
//! ```no_run
//! use pg_deploy_plan::storage::{load_storage_file, plan_storage, ProvisionMode, ProvisionTarget};
//!
//! let Ok(loaded) = load_storage_file(std::path::Path::new("pgctl.toml")) else {
//!     return;
//! };
//! let plan = plan_storage(
//!     &loaded.config,
//!     &loaded.overrides,
//!     ProvisionTarget::Postgres,
//!     ProvisionMode::Update,
//! );
//! println!("{}", plan.to_json_pretty());
//! ```
//!
//! Secrets are never part of a plan: configuration files carry `{{secret:<name>}}` and SQL uses
//! psql variables (`:'name'`), both resolved by the executor from the encrypted store.

#![forbid(unsafe_code)]

pub mod audit_log;
pub mod clamav;
pub mod model;
pub mod pgbouncer;
pub mod postgres;
pub mod redact;
pub mod redis;
pub mod render;
pub mod settings;
pub mod steps;
#[cfg(test)]
mod tests;

use std::path::Path;

use serde::Deserialize;
use sha2::{Digest, Sha256};

use pg_deploy_config::PgctlConfig;

pub use audit_log::plan_audit_log;
pub use clamav::plan_clamav;
pub use model::{
    codes, FileSpec, ProvisionFinding, ProvisionHost, ProvisionMode, ProvisionPlan, ProvisionStep,
    ProvisionTarget, RestartPolicy, ScriptSpec, SqlSpec, StepApply, StepKind, UnitAction,
    VerifyExpect, VerifySpec, PROVISION_PLAN_SCHEMA,
};
pub use pgbouncer::plan_pgbouncer;
pub use postgres::plan_postgres;
pub use redis::plan_redis;
pub use settings::{
    ClamavMode, ClientCertMode, HaMode, HostRef, IoMethod, PgRoles, PgSource, PgbouncerSettings,
    PostgresSettings, RedisEngine, RedisSettings, SentinelMode, StorageOverrides, StorageSettings,
    SyncCommit, TierSettings, TlsVerify, Topology,
};
pub use steps::sha256_hex;

/// Generator string rendered into files and plans.
pub const GENERATOR: &str = concat!("pgctl ", env!("CARGO_PKG_VERSION"));

/// Bare version (for `# managed by pgctl <version>` headers).
pub const GENERATOR_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Build the plan for one storage component.
///
/// Findings (blocking and advisory) are part of the plan: an invalid document still produces a
/// JSON document with the reasons, so `pgctl provision plan` never hides a problem behind an
/// empty step list.
#[must_use]
pub fn plan_storage(
    config: &PgctlConfig,
    overrides: &StorageOverrides,
    target: ProvisionTarget,
    mode: ProvisionMode,
) -> ProvisionPlan {
    let settings = StorageSettings::resolve(config, overrides);
    let topology = Topology::from_config(config);
    match target {
        ProvisionTarget::Postgres => plan_postgres(config, &settings, &topology, mode),
        ProvisionTarget::Pgbouncer => plan_pgbouncer(config, &settings, &topology, mode),
        ProvisionTarget::Redis => plan_redis(config, &settings, &topology, mode),
        ProvisionTarget::AuditLog => plan_audit_log(config, &settings, &topology, mode),
        ProvisionTarget::Clamav => plan_clamav(config, &settings, &topology, mode),
    }
}

/// Build every plan, in provisioning order (PostgreSQL, PgBouncer, Redis, audit/log, ClamAV).
#[must_use]
pub fn plan_all_storage(
    config: &PgctlConfig,
    overrides: &StorageOverrides,
    mode: ProvisionMode,
) -> Vec<ProvisionPlan> {
    ProvisionTarget::ALL
        .iter()
        .map(|target| plan_storage(config, overrides, *target, mode))
        .collect()
}

/// SHA-256 identity of a plan, excluding the fingerprint field itself.
#[must_use]
pub fn fingerprint_of(plan: &ProvisionPlan) -> String {
    #[derive(serde::Serialize)]
    struct Identity<'a> {
        schema: &'static str,
        environment: &'a str,
        target: ProvisionTarget,
        mode: ProvisionMode,
        hosts: &'a [ProvisionHost],
        findings: &'a [ProvisionFinding],
        notes: &'a [String],
    }
    let identity = Identity {
        schema: plan.schema,
        environment: &plan.environment,
        target: plan.target,
        mode: plan.mode,
        hosts: &plan.hosts,
        findings: &plan.findings,
        notes: &plan.notes,
    };
    let bytes = serde_json::to_vec(&identity).unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let digest = hasher.finalize();
    let mut text = String::with_capacity(7 + digest.len() * 2);
    text.push_str("sha256:");
    for byte in digest {
        text.push_str(&format!("{byte:02x}"));
    }
    text
}

/// `pgctl.toml` plus the `[storage]` overlay.
#[derive(Debug, Clone, PartialEq)]
pub struct StorageConfigFile {
    /// The document `pg_deploy_config` understands.
    pub config: PgctlConfig,
    /// The D5 settings that crate does not model yet.
    pub overrides: StorageOverrides,
}

/// Errors from reading or parsing a document with `[storage]` sections.
#[derive(Debug, thiserror::Error)]
pub enum StorageConfigError {
    /// The file could not be read.
    #[error("cannot read {path}: {message}")]
    Io {
        /// Path attempted.
        path: String,
        /// OS error.
        message: String,
    },
    /// TOML syntax or an unknown key.
    #[error("invalid pgctl.toml: {message}")]
    Toml {
        /// Parser or deserialiser message.
        message: String,
    },
    /// A component is defined twice (`[storage.postgres]` and `[postgres]`).
    #[error("define {section} in exactly one place ([storage.{section}] or [{section}])")]
    DuplicateSection {
        /// Component name.
        section: String,
    },
}

const STORAGE_SECTIONS: [&str; 5] = ["postgres", "pgbouncer", "clamav", "audit", "log"];

/// Read a `pgctl.toml` that may contain the D5 `[storage]` overlay.
///
/// The canonical form is `[storage.postgres]`, `[storage.pgbouncer]`, `[storage.redis]`,
/// `[storage.audit]`, `[storage.log]` and `[storage.clamav]`; the top-level `[postgres]`,
/// `[pgbouncer]`, `[clamav]`, `[audit]` and `[log]` tables are accepted as aliases (the spelling
/// of chapter 7 §7). They are removed before `PgctlConfig` deserialises, because that document
/// rejects unknown keys by design. `[redis]` stays part of `PgctlConfig`; only the new keys
/// (`engine`, `acl`, `maxmemory`, `ha`, ...) live under `[storage.redis]`.
pub fn load_storage_file(path: &Path) -> Result<StorageConfigFile, StorageConfigError> {
    let text = std::fs::read_to_string(path).map_err(|error| StorageConfigError::Io {
        path: path.display().to_string(),
        message: error.to_string(),
    })?;
    parse_storage_document(&text)
}

/// Parse a `[storage]` document from a string (the file loader and tests share this).
pub fn parse_storage_document(text: &str) -> Result<StorageConfigFile, StorageConfigError> {
    let mut value: toml::Value =
        toml::from_str(text).map_err(|error| StorageConfigError::Toml {
            message: error.to_string(),
        })?;
    let Some(root) = value.as_table_mut() else {
        return Err(StorageConfigError::Toml {
            message: "the document root must be a table".to_owned(),
        });
    };
    let storage_table = match root.remove("storage") {
        Some(toml::Value::Table(table)) => table,
        Some(_) => {
            return Err(StorageConfigError::Toml {
                message: "[storage] must be a table".to_owned(),
            });
        }
        None => toml::Table::new(),
    };
    for section in STORAGE_SECTIONS {
        if storage_table.contains_key(section) && root.contains_key(section) {
            return Err(StorageConfigError::DuplicateSection {
                section: section.to_owned(),
            });
        }
    }
    let mut merged = storage_table;
    for section in STORAGE_SECTIONS {
        if let Some(alias) = root.remove(section) {
            merged.insert(section.to_owned(), alias);
        }
    }
    let overrides: StorageOverrides = if merged.is_empty() {
        StorageOverrides::default()
    } else {
        StorageOverrides::deserialize(toml::Value::Table(merged)).map_err(|error| {
            StorageConfigError::Toml {
                message: error.to_string(),
            }
        })?
    };
    let config = PgctlConfig::deserialize(value).map_err(|error| StorageConfigError::Toml {
        message: error.to_string(),
    })?;
    Ok(StorageConfigFile { config, overrides })
}

#[cfg(test)]
mod unit_tests {
    use super::*;

    #[test]
    fn the_generator_is_versioned() {
        assert!(GENERATOR.starts_with("pgctl "));
        assert_eq!(GENERATOR_VERSION, env!("CARGO_PKG_VERSION"));
    }
}

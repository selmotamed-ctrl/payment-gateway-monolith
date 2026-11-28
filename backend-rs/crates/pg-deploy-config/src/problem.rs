//! Validation findings with stable codes.
//!
//! Port of the `string[]` problem list of `deploy/lib/configSchema.ts` (`validateDeployConfig`,
//! `panRailGuardProblems`, `weakSecretProblems`) into a typed finding. Codes are stable: scripts,
//! tests and the Guide reference them, so their spelling must not change.

#![forbid(unsafe_code)]

use std::fmt;

use serde::Serialize;

/// How serious a finding is.
///
/// `Error` makes `pgctl config validate` and `pgctl plan` exit 1; `Warning` is reported but does
/// not block. This mirrors the TS engine, which returned a flat problem list and refused the
/// deploy whenever it was non-empty, plus the new non-blocking checks of chapter 7 §7.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    /// The configuration cannot be applied.
    Error,
    /// The configuration can be applied, but the operator should look at it.
    Warning,
}

impl Severity {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::Warning => "warning",
        }
    }

    #[must_use]
    pub fn is_error(self) -> bool {
        matches!(self, Self::Error)
    }
}

impl fmt::Display for Severity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One validation finding.
///
/// `path` is a dotted TOML path (`services.core.port`, `hosts[1].roles`, `extra.DB_NAME`); it is
/// deliberately not a Rust field path, because that is what an operator edits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConfigProblem {
    /// Stable machine-readable code (see [`codes`]).
    pub code: &'static str,
    /// Dotted TOML path of the offending value.
    pub path: String,
    /// Human-readable explanation. Never contains a secret value.
    pub message: String,
    /// Error or warning.
    pub severity: Severity,
}

impl ConfigProblem {
    #[must_use]
    pub fn new(
        code: &'static str,
        path: impl Into<String>,
        message: impl Into<String>,
        severity: Severity,
    ) -> Self {
        Self {
            code,
            path: path.into(),
            message: message.into(),
            severity,
        }
    }

    /// A blocking finding.
    #[must_use]
    pub fn error(code: &'static str, path: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(code, path, message, Severity::Error)
    }

    /// A non-blocking finding.
    #[must_use]
    pub fn warning(
        code: &'static str,
        path: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self::new(code, path, message, Severity::Warning)
    }

    #[must_use]
    pub fn is_error(&self) -> bool {
        self.severity.is_error()
    }
}

impl fmt::Display for ConfigProblem {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} [{}] {}: {}",
            self.severity, self.code, self.path, self.message
        )
    }
}

/// True when any finding blocks the deployment.
#[must_use]
pub fn has_errors(problems: &[ConfigProblem]) -> bool {
    problems.iter().any(ConfigProblem::is_error)
}

/// The distinct codes present in a finding list, sorted.
#[must_use]
pub fn codes_of(problems: &[ConfigProblem]) -> Vec<&'static str> {
    let mut codes: Vec<&'static str> = problems.iter().map(|problem| problem.code).collect();
    codes.sort_unstable();
    codes.dedup();
    codes
}

/// Stable validation codes.
///
/// Names follow the TS prefix style (`MULTI_NODE_SHARED_STORAGE_REQUIRED`,
/// `PAN_RAIL_GUARD`, `FAKE_RAILS_PRODUCTION_GUARD_BLOCKED`) where the TS engine already had one,
/// so an operator's runbook keeps working after the port.
pub mod codes {
    // Structure and hosts.
    pub const INVALID_VERSION: &str = "INVALID_VERSION";
    pub const NO_HOSTS: &str = "NO_HOSTS";
    pub const DUPLICATE_HOST: &str = "DUPLICATE_HOST";
    pub const INVALID_HOST_ADDRESS: &str = "INVALID_HOST_ADDRESS";
    pub const INVALID_SSH_USER: &str = "INVALID_SSH_USER";
    pub const INVALID_IP: &str = "INVALID_IP";
    pub const NO_ROLES: &str = "NO_ROLES";
    pub const NO_HOST_FOR_ROLE: &str = "NO_HOST_FOR_ROLE";

    // Database.
    pub const RESERVED_ROLE_NAME: &str = "RESERVED_ROLE_NAME";
    pub const INVALID_DATABASE_NAME: &str = "INVALID_DATABASE_NAME";
    pub const DATABASE_ENGINE_UNSUPPORTED: &str = "DATABASE_ENGINE_UNSUPPORTED";
    pub const DATABASE_HOST_REQUIRED: &str = "DATABASE_HOST_REQUIRED";
    pub const STORAGE_TLS_REQUIRED: &str = "STORAGE_TLS_REQUIRED";
    pub const APP_ROLE_INVALID: &str = "APP_ROLE_INVALID";

    // Ports.
    pub const INVALID_SERVICE_PORT: &str = "INVALID_SERVICE_PORT";
    pub const PORT_COLLISION: &str = "PORT_COLLISION";

    // Production guards.
    pub const PRODUCTION_REQUIRES_TLS: &str = "PRODUCTION_REQUIRES_TLS";
    pub const FAKE_RAILS_PRODUCTION_GUARD_BLOCKED: &str = "FAKE_RAILS_PRODUCTION_GUARD_BLOCKED";
    pub const SEED_PRODUCTION_GUARD: &str = "SEED_PRODUCTION_GUARD";
    pub const OBJECT_STORAGE_INSECURE_HTTP_FORBIDDEN: &str =
        "OBJECT_STORAGE_INSECURE_HTTP_FORBIDDEN";
    pub const BACKUP_INSECURE_HTTP_FORBIDDEN: &str = "BACKUP_INSECURE_HTTP_FORBIDDEN";
    pub const REDIS_TLS_REQUIRED_IN_PRODUCTION: &str = "REDIS_TLS_REQUIRED_IN_PRODUCTION";

    // Object storage.
    pub const OBJECT_STORAGE_HOST_REQUIRED: &str = "OBJECT_STORAGE_HOST_REQUIRED";
    pub const OBJECT_STORAGE_HOST_DUPLICATE: &str = "OBJECT_STORAGE_HOST_DUPLICATE";
    pub const OBJECT_STORAGE_ROOT_UNSAFE: &str = "OBJECT_STORAGE_ROOT_UNSAFE";
    pub const OBJECT_STORAGE_KEK_REQUIRED: &str = "OBJECT_STORAGE_KEK_REQUIRED";
    pub const OBJECT_STORAGE_KEK_MUST_BE_REFERENCE: &str = "OBJECT_STORAGE_KEK_MUST_BE_REFERENCE";
    pub const OBJECT_STORAGE_CLIENT_CN_REQUIRED: &str = "OBJECT_STORAGE_CLIENT_CN_REQUIRED";
    pub const MULTI_NODE_SHARED_STORAGE_REQUIRED: &str = "MULTI_NODE_SHARED_STORAGE_REQUIRED";

    // TLS and network.
    pub const INVALID_DOMAIN: &str = "INVALID_DOMAIN";
    pub const CERT_SAN_MISMATCH: &str = "CERT_SAN_MISMATCH";
    pub const INVALID_CIDR: &str = "INVALID_CIDR";
    pub const INVALID_CORS_ORIGIN: &str = "INVALID_CORS_ORIGIN";
    pub const CORE_BACK_URL_INVALID: &str = "CORE_BACK_URL_INVALID";

    // Sandbox and seeds.
    pub const SANDBOX_DB_NAME_CONFLICT: &str = "SANDBOX_DB_NAME_CONFLICT";
    pub const SANDBOX_REQUIRES_FAKE_RAILS: &str = "SANDBOX_REQUIRES_FAKE_RAILS";

    // Backup.
    pub const BACKUP_S3_INCOMPLETE: &str = "BACKUP_S3_INCOMPLETE";
    pub const BACKUP_RETENTION_INVALID: &str = "BACKUP_RETENTION_INVALID";
    pub const PATH_INVALID: &str = "PATH_INVALID";
    pub const CRON_INVALID: &str = "CRON_INVALID";

    // Secrets and card data.
    pub const PAN_RAIL_GUARD: &str = "PAN_RAIL_GUARD";
    pub const SECRET_REFERENCE_INVALID: &str = "SECRET_REFERENCE_INVALID";
    pub const WEAK_SECRET: &str = "WEAK_SECRET";
    pub const SECRET_EXTRACTED: &str = "SECRET_EXTRACTED";

    // Importer.
    pub const INVALID_NODE_LIST: &str = "INVALID_NODE_LIST";
    pub const UNMAPPED: &str = "UNMAPPED";
    pub const INVALID_ENV_VALUE: &str = "INVALID_ENV_VALUE";
    pub const IGNORED_ENV_KEY: &str = "IGNORED_ENV_KEY";
    pub const WATCH_INVALID: &str = "WATCH_INVALID";
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_and_warning_severity_is_distinguishable() {
        let error = ConfigProblem::error(codes::PAN_RAIL_GUARD, "extra.PAN_RAIL", "refused");
        let warning = ConfigProblem::warning(codes::UNMAPPED, "extra.FOO", "no home");
        assert!(error.is_error());
        assert!(!warning.is_error());
        assert_eq!(error.severity.to_string(), "error");
        assert_eq!(warning.severity.to_string(), "warning");
        assert!(has_errors(&[error, warning]));
    }

    #[test]
    fn display_carries_code_path_and_message() {
        let problem = ConfigProblem::error(
            codes::PORT_COLLISION,
            "services.admin.port",
            "port 4101 is claimed twice",
        );
        assert_eq!(
            problem.to_string(),
            "error [PORT_COLLISION] services.admin.port: port 4101 is claimed twice"
        );
    }

    #[test]
    fn codes_are_sorted_and_deduplicated() {
        let problems = vec![
            ConfigProblem::warning(codes::UNMAPPED, "extra.A", "a"),
            ConfigProblem::error(codes::PAN_RAIL_GUARD, "extra.PAN", "b"),
            ConfigProblem::warning(codes::UNMAPPED, "extra.B", "c"),
        ];
        assert_eq!(
            codes_of(&problems),
            vec![codes::PAN_RAIL_GUARD, codes::UNMAPPED]
        );
    }
}

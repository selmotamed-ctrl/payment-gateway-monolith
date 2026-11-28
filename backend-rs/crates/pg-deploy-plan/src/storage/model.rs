//! Data model of a storage provision plan (D5).
//!
//! A plan is pure data: the desired files, SQL, package sets and convergence scripts for one
//! storage component on one or more hosts. Nothing here opens an SSH connection or reads the
//! filesystem, so `pgctl provision plan` is deterministic and the JSON can be golden-compared.
//!
//! Secrets never appear in the model. A step that needs one names it in `secret_refs` and its
//! content carries a `{{secret:<name>}}` placeholder that the executor resolves from the encrypted
//! store at apply time (chapter 7 §8).

#![forbid(unsafe_code)]

use std::fmt;

use pg_deploy_config::Severity;
use serde::{Deserialize, Serialize};

/// JSON schema identifier of a rendered plan.
pub const PROVISION_PLAN_SCHEMA: &str = "pgctl.provision-plan/v1";

/// A storage component `pgctl provision` knows how to plan.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProvisionTarget {
    /// PostgreSQL 18 primary/replicas (D5-T01).
    Postgres,
    /// PgBouncer connection pooler (D5-T02).
    Pgbouncer,
    /// Redis or Valkey cache/velocity tier (D5-T03).
    Redis,
    /// The dedicated audit and operational log databases (D5-T05).
    AuditLog,
    /// ClamAV `clamd` used by the KYB scanner (D5-T04).
    Clamav,
}

impl ProvisionTarget {
    /// Every target, in the order the TS deploy provisions them.
    pub const ALL: [Self; 5] = [
        Self::Postgres,
        Self::Pgbouncer,
        Self::Redis,
        Self::AuditLog,
        Self::Clamav,
    ];

    /// Parse the CLI spelling (`postgres|pgbouncer|redis|audit-log|clamav`).
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "postgres" => Some(Self::Postgres),
            "pgbouncer" => Some(Self::Pgbouncer),
            "redis" => Some(Self::Redis),
            "audit-log" => Some(Self::AuditLog),
            "clamav" => Some(Self::Clamav),
            _ => None,
        }
    }

    /// The CLI spelling.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Postgres => "postgres",
            Self::Pgbouncer => "pgbouncer",
            Self::Redis => "redis",
            Self::AuditLog => "audit-log",
            Self::Clamav => "clamav",
        }
    }
}

impl fmt::Display for ProvisionTarget {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Fresh installation or convergence of an existing one.
///
/// The difference is deliberate and small: a fresh plan includes repository/cluster creation,
/// an update plan still renders the full desired configuration and every idempotent SQL role
/// statement, so replaying it converges drift. Both are deterministic for the same input.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProvisionMode {
    /// Install packages, create the cluster or database and apply everything.
    Fresh,
    /// Converge an existing installation; no destructive or bootstrap-only step.
    #[default]
    Update,
}

impl ProvisionMode {
    /// Parse the CLI spelling.
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "fresh" => Some(Self::Fresh),
            "update" => Some(Self::Update),
            _ => None,
        }
    }

    /// The CLI spelling.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fresh => "fresh",
            Self::Update => "update",
        }
    }
}

impl fmt::Display for ProvisionMode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// A non-blocking (or blocking) finding produced while planning.
///
/// The shape matches [`pg_deploy_config::ConfigProblem`] so one renderer can print both. `path`
/// is the dotted TOML path of the setting the operator should look at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProvisionFinding {
    /// Stable machine-readable code (see [`codes`]).
    pub code: String,
    /// Dotted configuration path (`storage.postgres.ram_gb`).
    pub path: String,
    /// Human-readable explanation. Never contains a secret value.
    pub message: String,
    /// Blocking or advisory.
    pub severity: Severity,
}

impl ProvisionFinding {
    /// A blocking finding.
    #[must_use]
    pub fn error(code: &str, path: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            path: path.into(),
            message: message.into(),
            severity: Severity::Error,
        }
    }

    /// An advisory finding.
    #[must_use]
    pub fn warning(code: &str, path: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            path: path.into(),
            message: message.into(),
            severity: Severity::Warning,
        }
    }

    /// True when the finding blocks `provision apply`.
    #[must_use]
    pub fn is_error(&self) -> bool {
        self.severity.is_error()
    }
}

impl fmt::Display for ProvisionFinding {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{} [{}] {}: {}",
            self.severity, self.code, self.path, self.message
        )
    }
}

/// One planned remote action.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProvisionStep {
    /// Stable step id, unique inside one host plan.
    pub id: String,
    /// What the step does, in operator language.
    pub description: String,
    /// Category, used for grouping in `--json` consumers.
    pub kind: StepKind,
    /// True when the step content references a secret (and must never be logged verbatim).
    pub sensitive: bool,
    /// Least-disruptive service action needed after the step.
    pub restart: RestartPolicy,
    /// Stable convergence predicate: two plans with the same value need no remote work.
    pub idempotency_check: String,
    /// The action.
    pub apply: StepApply,
}

/// Step categories.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StepKind {
    /// Package-manager work.
    Packages,
    /// Distribution repository configuration.
    Repository,
    /// Cluster/database bootstrap (`pg_createcluster`, `initdb`).
    Cluster,
    /// A rendered configuration file.
    ConfigFile,
    /// `pg_hba.conf`.
    HbaFile,
    /// Internal-CA certificate/key material and its ownership.
    TlsMaterial,
    /// SQL (roles, databases, grants, DDL).
    Sql,
    /// A cron drop-in.
    Cron,
    /// A PgBouncer/redis unit or drop-in.
    Unit,
    /// A service lifecycle action.
    Service,
    /// A host firewall rule.
    Firewall,
    /// A read-only health or configuration assertion.
    Verify,
    /// A read-only fact probe whose result re-renders the plan at apply time.
    Probe,
    /// Sentinel instance configuration.
    Sentinel,
}

/// How disruptive the step is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RestartPolicy {
    /// Nothing is bounced.
    None,
    /// `systemctl reload` / SIGHUP when the file changed.
    Reload,
    /// `systemctl restart` only when the rendered content changed.
    RestartIfChanged,
    /// Force a restart (postmaster-level setting).
    Restart,
}

/// The action of one step.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum StepApply {
    /// Install the packages that are missing (idempotent on both families).
    Packages {
        /// Debian/Ubuntu package names.
        debian: Vec<String>,
        /// Arch-family package names.
        arch: Vec<String>,
    },
    /// Write a file as root (or the given owner) and converge ownership/mode.
    WriteFile(FileSpec),
    /// Run a bash script (`bash -euo pipefail -c`).
    RunScript(ScriptSpec),
    /// Run SQL through `psql -v ON_ERROR_STOP=1`, as the database superuser.
    Sql(SqlSpec),
    /// Enable/start/reload/restart a systemd unit.
    Systemd {
        /// Unit name.
        unit: String,
        /// Action.
        action: UnitAction,
    },
    /// Assert a command output.
    Verify(VerifySpec),
}

/// A rendered configuration file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileSpec {
    /// Absolute remote path.
    pub path: String,
    /// Mode bits (`0640`).
    pub mode: u32,
    /// Owner account.
    pub owner: String,
    /// Group.
    pub group: String,
    /// Content with `{{secret:<name>}}` placeholders where a secret is needed.
    pub content: String,
    /// Secret names the executor must resolve before writing the file.
    pub secret_refs: Vec<String>,
}

/// A bash script.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ScriptSpec {
    /// Whether it runs through `sudo -S` (password on stdin).
    pub privileged: bool,
    /// Script text (`bash -euo pipefail`).
    pub script: String,
    /// Secret names the executor must resolve (psql variables, stdin, env).
    pub secret_refs: Vec<String>,
}

/// SQL executed against one database.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SqlSpec {
    /// Database to connect to.
    pub database: String,
    /// Path of the private 0600 script file (removed after the run).
    pub path: String,
    /// Mode bits of the script file.
    pub mode: u32,
    /// SQL text; secret values are psql variables (`:'name'`), never literals.
    pub content: String,
    /// Secret names the executor passes as psql variables.
    pub secret_refs: Vec<String>,
}

/// A service action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum UnitAction {
    /// `systemctl daemon-reload`.
    DaemonReload,
    /// `systemctl enable --now`.
    EnableNow,
    /// `systemctl start`.
    Start,
    /// `systemctl reload` (SIGHUP).
    Reload,
    /// `systemctl restart`.
    Restart,
    /// `systemctl disable --now`.
    DisableNow,
}

/// A verification command and its expected outcome.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct VerifySpec {
    /// Command to run.
    pub command: String,
    /// What counts as success.
    pub expect: VerifyExpect,
}

/// Expected result of a verification command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum VerifyExpect {
    /// Exit status 0.
    ExitZero,
    /// Trimmed stdout equals this value.
    Equals {
        /// Expected text.
        value: String,
    },
    /// Stdout contains this text.
    Contains {
        /// Expected substring.
        value: String,
    },
}

/// All steps for one host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProvisionHost {
    /// Node id from `hosts[]`.
    pub id: String,
    /// SSH address.
    pub address: String,
    /// Role in this plan (`primary`, `replica:db-2`, `pgbouncer`, `redis`, `sentinel:1`, ...).
    pub role: String,
    /// Provisioner-owned service name (`pg-postgres-primary`).
    pub service: String,
    /// Listener this plan manages.
    pub port: u16,
    /// PostgreSQL cluster name, when the host runs one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cluster: Option<String>,
    /// Ordered steps.
    pub steps: Vec<ProvisionStep>,
}

/// A complete plan for one target.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProvisionPlan {
    /// Schema id ([`PROVISION_PLAN_SCHEMA`]).
    pub schema: &'static str,
    /// Generator and version.
    pub generator: &'static str,
    /// Environment the plan was rendered for.
    pub environment: String,
    /// Component.
    pub target: ProvisionTarget,
    /// Fresh or update.
    pub mode: ProvisionMode,
    /// SHA-256 over the host/step content: equal for equal inputs.
    pub fingerprint: String,
    /// Blocking and advisory findings.
    pub findings: Vec<ProvisionFinding>,
    /// Hosts, in deterministic order.
    pub hosts: Vec<ProvisionHost>,
    /// Operator notes (deviations, deferred features).
    pub notes: Vec<String>,
}

impl ProvisionPlan {
    /// Number of blocking findings.
    #[must_use]
    pub fn error_count(&self) -> usize {
        self.findings
            .iter()
            .filter(|finding| finding.is_error())
            .count()
    }

    /// Number of advisory findings.
    #[must_use]
    pub fn warning_count(&self) -> usize {
        self.findings
            .iter()
            .filter(|finding| !finding.is_error())
            .count()
    }

    /// True when the plan may be applied.
    #[must_use]
    pub fn is_applicable(&self) -> bool {
        self.error_count() == 0
    }

    /// Total steps across hosts.
    #[must_use]
    pub fn step_count(&self) -> usize {
        self.hosts.iter().map(|host| host.steps.len()).sum()
    }

    /// The redacted JSON representation printed by `pgctl provision plan`.
    ///
    /// The model never carries a secret value, and this method additionally masks anything that
    /// looks like an inline credential (defence in depth for hand-built plans and future
    /// executors). See [`super::redact`].
    #[must_use]
    pub fn to_json_value(&self) -> serde_json::Value {
        let raw = serde_json::to_value(self).unwrap_or(serde_json::Value::Null);
        super::redact::redact_value(&raw)
    }

    /// Pretty redacted JSON.
    #[must_use]
    pub fn to_json_pretty(&self) -> String {
        serde_json::to_string_pretty(&self.to_json_value())
            .unwrap_or_else(|_| "{\"schema\":\"pgctl.provision-plan/v1\"}".to_owned())
    }

    /// Human summary lines for a terminal.
    #[must_use]
    pub fn summary_lines(&self) -> Vec<String> {
        let mut lines = vec![format!(
            "{} {} plan ({}): {} host(s), {} step(s), {} error(s), {} warning(s)",
            self.environment,
            self.target,
            self.mode,
            self.hosts.len(),
            self.step_count(),
            self.error_count(),
            self.warning_count()
        )];
        for host in &self.hosts {
            lines.push(format!(
                "  {} ({}) {} on :{} ({} step(s))",
                host.id,
                host.address,
                host.role,
                host.port,
                host.steps.len()
            ));
        }
        for finding in &self.findings {
            lines.push(format!("  {finding}"));
        }
        for note in &self.notes {
            lines.push(format!("  note: {note}"));
        }
        lines.push(format!("  fingerprint {}", self.fingerprint));
        lines
    }
}

/// Stable finding codes.
///
/// Codes are part of the CLI contract (scripts and tests match them), so their spelling must not
/// change. The `PROVISION_` prefix keeps them apart from `pg_deploy_config::problem::codes`.
pub mod codes {
    /// No host carries the role the target needs.
    pub const HOST_MISSING: &str = "PROVISION_HOST_MISSING";
    /// A host address is not an IP/CIDR candidate.
    pub const INVALID_ADDRESS: &str = "PROVISION_INVALID_ADDRESS";
    /// PostgreSQL major is not 18.
    pub const POSTGRES_VERSION: &str = "PROVISION_POSTGRES_VERSION";
    /// `ram_gb` outside 1..=4096.
    pub const POSTGRES_RAM: &str = "PROVISION_POSTGRES_RAM";
    /// `max_connections` is below the reserved floor.
    pub const POSTGRES_MAX_CONNECTIONS: &str = "PROVISION_POSTGRES_MAX_CONNECTIONS";
    /// A PostgreSQL role name is reserved or malformed.
    pub const POSTGRES_ROLE: &str = "PROVISION_POSTGRES_ROLE";
    /// Two PostgreSQL roles are the same.
    pub const POSTGRES_ROLE_DUPLICATE: &str = "PROVISION_POSTGRES_ROLE_DUPLICATE";
    /// No password reference for a managed role.
    pub const POSTGRES_SECRET_MISSING: &str = "PROVISION_POSTGRES_SECRET_MISSING";
    /// More replicas (or slots) than `max_replication_slots`.
    pub const POSTGRES_SLOTS: &str = "PROVISION_POSTGRES_SLOTS";
    /// PgBouncer port collides with PostgreSQL.
    pub const PORT_COLLISION: &str = "PROVISION_PORT_COLLISION";
    /// PgBouncer listener port outside 1..=65535.
    pub const PORT_RANGE: &str = "PROVISION_PORT_RANGE";
    /// Computed PgBouncer pools exceed `max_connections - reserved`.
    pub const PGBOUNCER_BUDGET: &str = "PROVISION_PGBOUNCER_BUDGET";
    /// `max_prepared_statements` below the design floor (256) while enabled.
    pub const PGBOUNCER_PREPARED: &str = "PROVISION_PGBOUNCER_PREPARED";
    /// Client/server TLS verification is downgraded.
    pub const TLS_DOWNGRADE: &str = "PROVISION_TLS_DOWNGRADE";
    /// Redis memory size is not `<number><unit>`.
    pub const REDIS_MAXMEMORY: &str = "PROVISION_REDIS_MAXMEMORY";
    /// Redis is enabled without a host.
    pub const REDIS_HOST: &str = "PROVISION_REDIS_HOST";
    /// Sentinel requested with fewer than three instances.
    pub const REDIS_SENTINEL: &str = "PROVISION_REDIS_SENTINEL";
    /// Audit/log database name collides with the application database.
    pub const AUDITLOG_DATABASE: &str = "PROVISION_AUDITLOG_DATABASE";
    /// An audit/log role is reserved or malformed.
    pub const AUDITLOG_ROLE: &str = "PROVISION_AUDITLOG_ROLE";
    /// The shared audit/log owner role has two different passwords.
    pub const AUDITLOG_OWNER_PASSWORD: &str = "PROVISION_AUDITLOG_OWNER_PASSWORD";
    /// ClamAV TCP is not loopback only.
    pub const CLAMAV_BIND: &str = "PROVISION_CLAMAV_BIND";
    /// ClamAV stream/file limit below the 25 MB KYB upload.
    pub const CLAMAV_STREAM: &str = "PROVISION_CLAMAV_STREAM";
    /// Patroni HA is not implemented in D5.
    pub const PATRONI_NOT_IMPLEMENTED: &str = "PROVISION_PATRONI_NOT_IMPLEMENTED";
    /// A certificate file must be issued by `pgctl pki` (D4-T02) before apply.
    pub const PKI_LEAF_REQUIRED: &str = "PROVISION_PKI_LEAF_REQUIRED";
    /// A configuration error from `pg_deploy_config::validate`.
    pub const CONFIG_INVALID: &str = "PROVISION_CONFIG_INVALID";
}

impl Default for ProvisionPlan {
    fn default() -> Self {
        Self {
            schema: PROVISION_PLAN_SCHEMA,
            generator: super::GENERATOR,
            environment: "development".to_owned(),
            target: ProvisionTarget::Postgres,
            mode: ProvisionMode::Update,
            fingerprint: String::new(),
            findings: Vec::new(),
            hosts: Vec::new(),
            notes: Vec::new(),
        }
    }
}

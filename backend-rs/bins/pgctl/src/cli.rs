//! Command line surface (`clap` 4).
//!
//! Port of the CLI of `deploy/deploy.ts` (flags) and chapter 7 §3 (command names). Only the D0
//! subset is implemented; every other documented command parses and exits with the precondition
//! code (3) instead of pretending to work.
//!
//! ```text
//! pgctl version
//! pgctl config validate --file pgctl.toml
//! pgctl config import --env-file deploy/deploy.env --out pgctl.toml
//! pgctl config schema
//! pgctl plan --file pgctl.toml [--json]
//! pgctl provision plan --file pgctl.toml --target postgres [--mode fresh|update]
//! pgctl release build|sign|verify
//! pgctl pki dev
//! pgctl local up|smoke
//! pgctl lab …
//! pgctl stress …
//! ```

#![forbid(unsafe_code)]

use std::path::PathBuf;

use clap::{Args, Parser, Subcommand};

/// `pgctl` — declarative deploy engine for the payment gateway.
#[derive(Debug, Parser)]
#[command(
    name = "pgctl",
    version,
    about = "Declarative deploy engine for the payment gateway (Rust port, D0-D5 plans)",
    long_about = None,
    propagate_version = true
)]
pub struct Cli {
    /// Emit machine-readable JSON where the command supports it.
    #[arg(long, global = true)]
    pub json: bool,
    /// Verbose diagnostics on stderr. Secret values are always redacted.
    #[arg(long, global = true)]
    pub verbose: bool,
    /// Default `pgctl.toml` for commands that accept a config.
    #[arg(long, global = true, value_name = "PATH")]
    pub config: Option<PathBuf>,
    /// The command.
    #[command(subcommand)]
    pub command: Command,
}

/// Top-level commands.
#[derive(Debug, Subcommand)]
pub enum Command {
    /// Print the version and the supported configuration schema.
    Version,
    /// Inspect, import and validate `pgctl.toml`.
    Config {
        /// `pgctl config <command>`.
        #[command(subcommand)]
        command: ConfigCommand,
    },
    /// Print the desired-state plan (no remote changes).
    Plan(PlanArgs),
    /// Plan (and later apply) the storage provisioners (D5).
    Provision {
        /// `pgctl provision <command>`.
        #[command(subcommand)]
        command: ProvisionCommand,
    },
    /// Pin host keys and inspect SSH targets.
    Hosts {
        /// `pgctl hosts <command>`.
        #[command(subcommand)]
        command: HostsCommand,
    },
    /// Install, start and verify a Rust service unit.
    Service {
        /// `pgctl service <command>`.
        #[command(subcommand)]
        command: ServiceCommand,
    },
    /// Record a release locally and print the switch steps (no remote changes).
    Deploy(DeployArgs),
    /// Switch back to a previous release from the local state.
    Rollback(RollbackArgs),
    /// Evaluate the post-deploy watch window and the rollback decision.
    Watch(WatchArgs),
    /// Render `route-table.json` from the plan.
    RouteTable(RouteTableArgs),
    /// Render the worker handover document.
    Workers {
        /// `pgctl workers <command>`.
        #[command(subcommand)]
        command: WorkersCommand,
    },
    /// Push a rendered artefact to its hosts (dry-run by default).
    Push(PushArgs),
    /// Build, sign and verify release artefacts.
    Release {
        /// `pgctl release <command>`.
        #[command(subcommand)]
        command: ReleaseCommand,
    },
    /// Issue, renew and inspect certificates.
    Pki {
        /// `pgctl pki <command>`.
        #[command(subcommand)]
        command: PkiCommand,
    },
    /// Local development stack.
    Local {
        /// `pgctl local <command>`.
        #[command(subcommand)]
        command: LocalCommand,
    },
    /// Lab harness (test-matrix port).
    Lab {
        /// `pgctl lab <command>`.
        #[command(subcommand)]
        command: LabCommand,
    },
    /// Deploy stress scenarios.
    Stress {
        /// `pgctl stress <command>`.
        #[command(subcommand)]
        command: StressCommand,
    },
}

/// `pgctl config …`.
#[derive(Debug, Subcommand)]
pub enum ConfigCommand {
    /// Validate a document and print every finding (`check` is an alias).
    #[command(alias = "check")]
    Validate(ValidateArgs),
    /// Convert a `deploy/deploy.env` file into `pgctl.toml`.
    Import(ImportArgs),
    /// Print the JSON Schema.
    Schema,
}

/// `pgctl config validate`.
#[derive(Debug, Args)]
pub struct ValidateArgs {
    /// Path to `pgctl.toml`.
    #[arg(long, value_name = "PATH")]
    pub file: PathBuf,
}

/// `pgctl config import`.
#[derive(Debug, Args)]
pub struct ImportArgs {
    /// Path to the legacy `deploy.env`.
    #[arg(long, value_name = "PATH")]
    pub env_file: PathBuf,
    /// Where to write the generated `pgctl.toml` (mode 0600).
    #[arg(long, value_name = "PATH")]
    pub out: PathBuf,
}

/// `pgctl plan`.
#[derive(Debug, Args)]
pub struct PlanArgs {
    /// Path to `pgctl.toml`; defaults to the global `--config`.
    #[arg(long, value_name = "PATH")]
    pub file: Option<PathBuf>,
}

/// `pgctl provision …`.
#[derive(Debug, Subcommand)]
pub enum ProvisionCommand {
    /// Print the provision plan as JSON (no remote changes).
    Plan(ProvisionPlanArgs),
    /// Apply a provision plan (refused until the D1 service/SSH integration lands).
    Apply(ProvisionApplyArgs),
}

/// `pgctl provision plan`.
#[derive(Debug, Args)]
pub struct ProvisionPlanArgs {
    /// Path to `pgctl.toml` (may contain `[storage.*]`); defaults to the global `--config`.
    #[arg(long, value_name = "PATH")]
    pub file: Option<PathBuf>,
    /// Storage component: postgres, pgbouncer, redis, audit-log or clamav.
    #[arg(long, value_name = "TARGET")]
    pub target: String,
    /// fresh (install/clone) or update (converge); defaults to update.
    #[arg(long, value_name = "MODE", default_value = "update")]
    pub mode: String,
    /// Refused until the provisioner executor is wired (D1/D5); the plan is still printed.
    #[arg(long)]
    pub execute: bool,
    /// Write the JSON plan to this path as well.
    #[arg(long, value_name = "PATH")]
    pub out: Option<PathBuf>,
}

/// `pgctl provision apply`.
#[derive(Debug, Args)]
pub struct ProvisionApplyArgs {
    /// Path to `pgctl.toml`.
    #[arg(long, value_name = "PATH")]
    pub file: Option<PathBuf>,
    /// Storage component: postgres, pgbouncer, redis, audit-log or clamav.
    #[arg(long, value_name = "TARGET")]
    pub target: String,
    /// fresh or update.
    #[arg(long, value_name = "MODE", default_value = "update")]
    pub mode: String,
    /// Write the JSON plan to this path as well.
    #[arg(long, value_name = "PATH")]
    pub out: Option<PathBuf>,
}

/// `pgctl release …`.
#[derive(Debug, Subcommand)]
pub enum ReleaseCommand {
    /// Build `bin/`, rendered configuration, manifest, SBOM and the tar.zst archive.
    #[command(disable_version_flag = true)]
    Build(ReleaseBuildArgs),
    /// Sign an archive with minisign (`<archive>.minisig`).
    Sign(ReleaseSignArgs),
    /// Verify an archive signature with minisign.
    Verify(ReleaseVerifyArgs),
}

/// `pgctl release build`.
#[derive(Debug, Args)]
pub struct ReleaseBuildArgs {
    /// Output directory (archive, manifest and checksum).
    #[arg(long, value_name = "PATH")]
    pub out: PathBuf,
    /// Directory holding the compiled binaries.
    #[arg(long, value_name = "PATH")]
    pub bin_dir: Option<PathBuf>,
    /// Release version (default: crate version).
    #[arg(long)]
    pub version: Option<String>,
    /// Git commit (default: `GIT_COMMIT` or `git rev-parse --short HEAD`).
    #[arg(long)]
    pub commit: Option<String>,
    /// Target triple (default: `TARGET` or arch-os).
    #[arg(long)]
    pub target: Option<String>,
    /// Fixed build timestamp (default: `SOURCE_DATE_EPOCH` or now).
    #[arg(long)]
    pub epoch: Option<u64>,
    /// Worker owner rendered into `workers.json` (`ts` or `rs`).
    #[arg(long)]
    pub workers: Option<String>,
    /// Configuration rendered into the archive (defaults to the global `--config`).
    #[arg(long, value_name = "PATH")]
    pub file: Option<PathBuf>,
}

/// `pgctl release sign`.
#[derive(Debug, Args)]
pub struct ReleaseSignArgs {
    /// Archive to sign.
    #[arg(long, value_name = "PATH")]
    pub file: PathBuf,
    /// Secret key (`~/.minisign/minisign.key` by default). Password comes from `MINISIGN_PASSWORD`.
    #[arg(long, value_name = "PATH")]
    pub key: Option<PathBuf>,
    /// Trusted comment (default: `pgctl release <file name>`).
    #[arg(long)]
    pub trusted_comment: Option<String>,
}

/// `pgctl release verify`.
#[derive(Debug, Args)]
pub struct ReleaseVerifyArgs {
    /// Archive to verify.
    #[arg(long, value_name = "PATH")]
    pub file: PathBuf,
    /// Public key (`~/.minisign/minisign.pub` by default).
    #[arg(long, value_name = "PATH")]
    pub public_key: Option<PathBuf>,
}

/// `pgctl hosts …`.
#[derive(Debug, Subcommand)]
pub enum HostsCommand {
    /// Connect, show the server key fingerprint and pin it after confirmation.
    Enrol(EnrolArgs),
}

/// `pgctl hosts enrol`.
#[derive(Debug, Args)]
pub struct EnrolArgs {
    /// Configuration.
    #[arg(long, value_name = "PATH")]
    pub file: Option<PathBuf>,
    /// Host name from `hosts[]`.
    #[arg(long)]
    pub host: String,
    /// Expected SHA-256 fingerprint; must match the server key.
    #[arg(long)]
    pub fingerprint: Option<String>,
    /// Pin without a fingerprint after the operator compared it out of band.
    #[arg(long)]
    pub yes: bool,
    /// Known-hosts file (default: `~/.config/pgctl/known_hosts`).
    #[arg(long, value_name = "PATH")]
    pub known_hosts: Option<PathBuf>,
}

/// `pgctl service …`.
#[derive(Debug, Subcommand)]
pub enum ServiceCommand {
    /// Install, enable and verify a Rust service unit on its host.
    Install(ServiceInstallArgs),
}

/// `pgctl service install`.
#[derive(Debug, Args)]
pub struct ServiceInstallArgs {
    /// Configuration.
    #[arg(long, value_name = "PATH")]
    pub file: Option<PathBuf>,
    /// Planned service name (`pg-object-storage-daemon`).
    pub name: String,
    /// Actually connect and apply (default: print the steps).
    #[arg(long)]
    pub execute: bool,
    /// Known-hosts file.
    #[arg(long, value_name = "PATH")]
    pub known_hosts: Option<PathBuf>,
    /// Runtime directory for the per-host lock.
    #[arg(long, value_name = "PATH")]
    pub state_dir: Option<PathBuf>,
    /// Environment variable holding the sudo password (never argv).
    #[arg(long, default_value = "PGCTL_SUDO_PASSWORD")]
    pub sudo_password_env: String,
}

/// `pgctl deploy`.
#[derive(Debug, Args)]
pub struct DeployArgs {
    /// Release archive.
    #[arg(long, value_name = "PATH")]
    pub archive: PathBuf,
    /// Manifest (default: `manifest.json` next to the archive).
    #[arg(long, value_name = "PATH")]
    pub manifest: Option<PathBuf>,
    /// State file (default: XDG state directory).
    #[arg(long, value_name = "PATH")]
    pub state: Option<PathBuf>,
    /// Print the steps without recording the release.
    #[arg(long)]
    pub dry_run: bool,
}

/// `pgctl rollback`.
#[derive(Debug, Args)]
pub struct RollbackArgs {
    /// Release version or `version-commit` (default: previous release).
    #[arg(long)]
    pub to: Option<String>,
    /// State file.
    #[arg(long, value_name = "PATH")]
    pub state: Option<PathBuf>,
    /// Print the steps without changing the state.
    #[arg(long)]
    pub dry_run: bool,
    /// Current database schema version, checked against the target manifest.
    #[arg(long)]
    pub current_schema: Option<u32>,
}

/// `pgctl watch`.
#[derive(Debug, Args)]
pub struct WatchArgs {
    /// Configuration with `[deployment.watch]`.
    #[arg(long, value_name = "PATH")]
    pub file: Option<PathBuf>,
    /// JSON array of samples (`at_unix`, `requests`, `errors`, `p95_ms`, `worker_errors`).
    #[arg(long, value_name = "PATH")]
    pub samples: PathBuf,
    /// Evaluation instant (Unix seconds); defaults to the newest sample.
    #[arg(long)]
    pub now: Option<u64>,
}

/// `pgctl route-table`.
#[derive(Debug, Args)]
pub struct RouteTableArgs {
    /// Configuration.
    #[arg(long, value_name = "PATH")]
    pub file: Option<PathBuf>,
    /// Directory for `route-table.json` (default: current directory).
    #[arg(long, value_name = "PATH")]
    pub out: Option<PathBuf>,
}

/// `pgctl workers …`.
#[derive(Debug, Subcommand)]
pub enum WorkersCommand {
    /// Hand the listed workers (default: all) to one implementation.
    Handover(WorkersHandoverArgs),
}

/// `pgctl workers handover`.
#[derive(Debug, Args)]
pub struct WorkersHandoverArgs {
    /// Configuration.
    #[arg(long, value_name = "PATH")]
    pub file: Option<PathBuf>,
    /// Target implementation (`ts` or `rs`).
    #[arg(long)]
    pub to: String,
    /// Restrict the handover to these worker names (repeatable).
    #[arg(long = "worker")]
    pub workers: Vec<String>,
    /// Directory for `workers.json` (default: current directory).
    #[arg(long, value_name = "PATH")]
    pub out: Option<PathBuf>,
}

/// `pgctl push`.
#[derive(Debug, Args)]
pub struct PushArgs {
    /// Configuration.
    #[arg(long, value_name = "PATH")]
    pub file: Option<PathBuf>,
    /// Artefact: `route-table` or `workers`.
    #[arg(long)]
    pub artifact: String,
    /// Directory holding the rendered artefact (default: current directory).
    #[arg(long, value_name = "PATH")]
    pub source_dir: Option<PathBuf>,
    /// Actually connect and apply (default: print the steps).
    #[arg(long)]
    pub execute: bool,
    /// Known-hosts file.
    #[arg(long, value_name = "PATH")]
    pub known_hosts: Option<PathBuf>,
    /// Runtime directory for the per-host lock.
    #[arg(long, value_name = "PATH")]
    pub state_dir: Option<PathBuf>,
    /// Environment variable holding the sudo password (never argv).
    #[arg(long, default_value = "PGCTL_SUDO_PASSWORD")]
    pub sudo_password_env: String,
}

/// `pgctl pki …`.
#[derive(Debug, Subcommand)]
pub enum PkiCommand {
    /// Create the root CA and the per-environment intermediate CA.
    Init(PkiInitArgs),
    /// Issue leaves for the configured topology, or one custom leaf.
    Issue(PkiIssueArgs),
    /// Re-issue leaves inside the renewal window, keeping the same CA.
    Renew(PkiRenewArgs),
    /// Revoke a certificate and regenerate the signed CRL.
    Revoke(PkiRevokeArgs),
    /// Print the certificate inventory (serial, fingerprint, expiry, roles).
    Inventory(PkiInventoryArgs),
    /// Check the chain, expiry, SANs, revocation and file modes; exit 1 with precise problems.
    Verify(PkiVerifyArgs),
    /// Create a complete local development PKI (repo checkout only).
    Dev(PkiDevArgs),
    /// Print the storage TLS plan section for PostgreSQL, PgBouncer and Redis.
    Storage(PkiStorageArgs),
}

/// `pgctl pki init`.
#[derive(Debug, Args)]
pub struct PkiInitArgs {
    /// PKI directory (default: `[tls].pki_dir` from the global `--config`, else `/etc/pg/pki`).
    #[arg(long, value_name = "PATH")]
    pub dir: Option<PathBuf>,
    /// Root CA lifetime in days.
    #[arg(long, default_value_t = 3650)]
    pub root_days: u16,
    /// Intermediate CA lifetime in days.
    #[arg(long, default_value_t = 1095)]
    pub intermediate_days: u16,
    /// Replace the CA and re-issue every non-revoked leaf (invalidates the old chain).
    #[arg(long)]
    pub rotate: bool,
    /// Evaluate as if the clock were this Unix instant.
    #[arg(long)]
    pub now: Option<i64>,
}

/// `pgctl pki issue`.
#[derive(Debug, Args)]
pub struct PkiIssueArgs {
    /// PKI directory (default: `[tls].pki_dir` from `--file`/`--config`).
    #[arg(long, value_name = "PATH")]
    pub dir: Option<PathBuf>,
    /// `pgctl.toml` (the whole topology catalogue).
    #[arg(long, value_name = "PATH")]
    pub file: Option<PathBuf>,
    /// Issue only this catalogue entry (or name the custom leaf).
    #[arg(long)]
    pub name: Option<String>,
    /// Common name for a custom leaf.
    #[arg(long)]
    pub cn: Option<String>,
    /// DNS SAN for a custom leaf (repeatable).
    #[arg(long = "dns", value_name = "NAME")]
    pub dns: Vec<String>,
    /// IP SAN for a custom leaf (repeatable).
    #[arg(long = "ip", value_name = "ADDR")]
    pub ip: Vec<String>,
    /// `server`, `client` or `server-client`.
    #[arg(long)]
    pub kind: Option<String>,
    /// Lifetime in days (default: `[tls].leaf_days`, else 90).
    #[arg(long)]
    pub days: Option<u16>,
    /// Re-issue even when the existing certificate is outside the renewal window.
    #[arg(long)]
    pub force: bool,
}

/// `pgctl pki renew`.
#[derive(Debug, Args)]
pub struct PkiRenewArgs {
    /// PKI directory.
    #[arg(long, value_name = "PATH")]
    pub dir: Option<PathBuf>,
    /// Renewal window in days (default: `[tls].renew_within_days`, else 30; 0 disables).
    #[arg(long)]
    pub within_days: Option<u16>,
    /// Evaluate as if the clock were this Unix instant (tests and reproducible checks).
    #[arg(long)]
    pub now: Option<i64>,
}

/// `pgctl pki revoke`.
#[derive(Debug, Args)]
pub struct PkiRevokeArgs {
    /// PKI directory.
    #[arg(long, value_name = "PATH")]
    pub dir: Option<PathBuf>,
    /// File stem of the certificate to revoke.
    #[arg(long)]
    pub name: Option<String>,
    /// Hex serial of the certificate to revoke (colons allowed).
    #[arg(long)]
    pub serial: Option<String>,
    /// Reason code (unspecified, key-compromise, ca-compromise, affiliation-changed, superseded,
    /// cessation-of-operation, certificate-hold, privilege-withdrawn, aa-compromise).
    #[arg(long, default_value = "unspecified")]
    pub reason: String,
    /// Evaluate as if the clock were this Unix instant.
    #[arg(long)]
    pub now: Option<i64>,
}

/// `pgctl pki inventory`.
#[derive(Debug, Args)]
pub struct PkiInventoryArgs {
    /// PKI directory.
    #[arg(long, value_name = "PATH")]
    pub dir: Option<PathBuf>,
    /// Also rewrite `inventory.json` (the file is always deterministic).
    #[arg(long)]
    pub write: bool,
}

/// `pgctl pki verify`.
#[derive(Debug, Args)]
pub struct PkiVerifyArgs {
    /// PKI directory.
    #[arg(long, value_name = "PATH")]
    pub dir: Option<PathBuf>,
    /// `pgctl.toml`: verify every certificate the topology requires (CN/SAN drift fails).
    #[arg(long, value_name = "PATH")]
    pub file: Option<PathBuf>,
    /// Renewal window in days (default: `[tls].renew_within_days`, else 30).
    #[arg(long)]
    pub within_days: Option<u16>,
    /// Evaluate as if the clock were this Unix instant.
    #[arg(long)]
    pub now: Option<i64>,
}

/// `pgctl pki dev`.
#[derive(Debug, Args)]
pub struct PkiDevArgs {
    /// Output directory (default: `<repo>/core-back/certs`).
    #[arg(long, value_name = "PATH")]
    pub dir: Option<PathBuf>,
    /// Leaf lifetime in days (default 825, matching `generate-mtls-certs`).
    #[arg(long)]
    pub days: Option<u16>,
    /// Replace the dev CA and re-issue every leaf.
    #[arg(long)]
    pub rotate: bool,
    /// Re-issue leaves even when they are still valid.
    #[arg(long)]
    pub force: bool,
    /// Evaluate as if the clock were this Unix instant.
    #[arg(long)]
    pub now: Option<i64>,
}

/// `pgctl pki storage`.
#[derive(Debug, Args)]
pub struct PkiStorageArgs {
    /// Override the PKI directory used in the printed paths.
    #[arg(long, value_name = "PATH")]
    pub dir: Option<PathBuf>,
    /// `pgctl.toml` (or the global `--config`).
    #[arg(long, value_name = "PATH")]
    pub file: Option<PathBuf>,
}

/// `pgctl local …`.
#[derive(Debug, Subcommand)]
pub enum LocalCommand {
    /// Start the local stack (not implemented in this build).
    Up {
        /// Profile (`core`, `merchant-demo`, `full`).
        #[arg(long, value_name = "PROFILE")]
        profile: Option<String>,
    },
    /// Run the HTTP smoke test (not implemented in this build).
    Smoke,
}

/// `pgctl lab …`.
#[derive(Debug, Subcommand)]
pub enum LabCommand {
    /// Validate a lab description.
    Validate,
    /// Print the lab plan.
    Plan,
    /// Bootstrap the lab hosts.
    Bootstrap,
    /// Run the gates.
    Run,
    /// Tear the lab down.
    Teardown,
}

/// `pgctl stress …`.
#[derive(Debug, Subcommand)]
pub enum StressCommand {
    /// Run one scenario.
    Run {
        /// Scenario name.
        #[arg(long, value_name = "NAME")]
        scenario: String,
    },
    /// List the scenarios.
    List,
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    #[test]
    fn the_command_tree_is_valid() {
        Cli::command().debug_assert();
    }

    #[test]
    fn documented_commands_parse() {
        let cases: &[&[&str]] = &[
            &["pgctl", "version"],
            &["pgctl", "config", "validate", "--file", "pgctl.toml"],
            &[
                "pgctl",
                "config",
                "import",
                "--env-file",
                "deploy.env",
                "--out",
                "pgctl.toml",
            ],
            &["pgctl", "config", "schema"],
            &["pgctl", "plan", "--file", "pgctl.toml", "--json"],
            &["pgctl", "--config", "pgctl.toml", "plan"],
            &[
                "pgctl",
                "release",
                "build",
                "--out",
                "/tmp/release",
                "--bin-dir",
                "target/release",
                "--version",
                "1.2.3",
                "--commit",
                "abc1234",
                "--epoch",
                "0",
            ],
            &["pgctl", "release", "sign", "--file", "release.tar.zst"],
            &["pgctl", "release", "verify", "--file", "release.tar.zst"],
            &[
                "pgctl",
                "hosts",
                "enrol",
                "--file",
                "pgctl.toml",
                "--host",
                "core-1",
                "--yes",
            ],
            &[
                "pgctl",
                "service",
                "install",
                "--file",
                "pgctl.toml",
                "pg-object-storage-daemon",
                "--execute",
            ],
            &[
                "pgctl",
                "deploy",
                "--archive",
                "pg-release-1-abc.tar.zst",
                "--dry-run",
            ],
            &["pgctl", "rollback", "--to", "1-abc", "--dry-run"],
            &[
                "pgctl",
                "watch",
                "--file",
                "pgctl.toml",
                "--samples",
                "samples.json",
            ],
            &[
                "pgctl",
                "route-table",
                "--file",
                "pgctl.toml",
                "--out",
                "/tmp",
            ],
            &[
                "pgctl",
                "workers",
                "handover",
                "--file",
                "pgctl.toml",
                "--to",
                "rs",
            ],
            &[
                "pgctl",
                "push",
                "--file",
                "pgctl.toml",
                "--artifact",
                "route-table",
            ],
            &["pgctl", "pki", "init", "--dir", "/tmp/pki"],
            &["pgctl", "pki", "init", "--dir", "/tmp/pki", "--rotate"],
            &["pgctl", "pki", "issue", "--file", "pgctl.toml"],
            &[
                "pgctl",
                "pki",
                "issue",
                "--name",
                "core-back",
                "--cn",
                "core-back.internal",
                "--dns",
                "core-back.internal",
                "--ip",
                "127.0.0.1",
                "--kind",
                "server",
                "--days",
                "90",
                "--force",
            ],
            &[
                "pgctl",
                "pki",
                "renew",
                "--dir",
                "/tmp/pki",
                "--within-days",
                "30",
                "--now",
                "1800000000",
            ],
            &[
                "pgctl",
                "pki",
                "revoke",
                "--name",
                "admin-back-client",
                "--reason",
                "key-compromise",
            ],
            &["pgctl", "pki", "inventory", "--dir", "/tmp/pki", "--json"],
            &["pgctl", "pki", "verify", "--file", "pgctl.toml"],
            &["pgctl", "pki", "dev", "--dir", "/tmp/pki"],
            &["pgctl", "pki", "storage", "--file", "pgctl.toml"],
            &["pgctl", "local", "up", "--profile", "merchant-demo"],
            &["pgctl", "local", "smoke"],
            &["pgctl", "lab", "run"],
            &["pgctl", "stress", "run", "--scenario", "noop-redeploy"],
            &["pgctl", "stress", "list"],
        ];
        for args in cases {
            Cli::try_parse_from(*args).unwrap_or_else(|error| panic!("{args:?}: {error}"));
        }
    }

    #[test]
    fn a_missing_subcommand_is_a_usage_error() {
        let error = Cli::try_parse_from(["pgctl"]).expect_err("no subcommand");
        assert_eq!(error.exit_code(), 2);
    }
}

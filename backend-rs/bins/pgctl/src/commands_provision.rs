//! `pgctl provision plan|apply` — the D5 storage provisioner surface.
//!
//! The planner is pure (`pg_deploy_plan::storage`), so this module only loads the document,
//! parses the target/mode and prints the redacted JSON plan. `--execute` and `provision apply`
//! are deliberately refused until the D1 service/SSH integration is wired: the plan is still
//! printed, so an operator can review exactly what would run.

#![forbid(unsafe_code)]

use std::path::{Path, PathBuf};

use pg_deploy_plan::storage::{
    load_storage_file, plan_storage, ProvisionMode, ProvisionPlan, ProvisionTarget,
};

use crate::cli::{Cli, ProvisionApplyArgs, ProvisionCommand, ProvisionPlanArgs};
use crate::commands::{Report, EXIT_FAILURE, EXIT_OK, EXIT_PRECONDITION};
use crate::redact;
use crate::util;

/// `pgctl provision …`.
#[must_use]
pub fn run(cli: &Cli, command: &ProvisionCommand) -> Report {
    match command {
        ProvisionCommand::Plan(args) => run_plan(cli, args, false),
        ProvisionCommand::Apply(args) => run_apply(cli, args),
    }
}

fn run_plan(cli: &Cli, args: &ProvisionPlanArgs, apply: bool) -> Report {
    execute(
        cli,
        args.file.clone(),
        &args.target,
        &args.mode,
        args.execute || apply,
        args.out.as_deref(),
    )
}

fn run_apply(cli: &Cli, args: &ProvisionApplyArgs) -> Report {
    execute(
        cli,
        args.file.clone(),
        &args.target,
        &args.mode,
        true,
        args.out.as_deref(),
    )
}

fn execute(
    cli: &Cli,
    file: Option<PathBuf>,
    target: &str,
    mode: &str,
    execute: bool,
    out: Option<&Path>,
) -> Report {
    let Some(path) = file.or_else(|| cli.config.clone()) else {
        return Report::usage(
            "provision plan requires --file <pgctl.toml> (or the global --config)",
        );
    };
    let Some(target) = ProvisionTarget::parse(target) else {
        return Report::usage(format!(
            "unknown --target; expected one of {}",
            ProvisionTarget::ALL
                .iter()
                .map(|target| target.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    };
    let Some(mode) = ProvisionMode::parse(mode) else {
        return Report::usage("--mode must be fresh or update");
    };
    let loaded = match load_storage_file(&path) {
        Ok(loaded) => loaded,
        Err(error) => return Report::failure(redact::redact_line(&error.to_string())),
    };
    let plan = plan_storage(&loaded.config, &loaded.overrides, target, mode);
    let json = plan.to_json_pretty();
    let stdout = vec![json.clone()];
    let mut stderr: Vec<String> = plan
        .findings
        .iter()
        .map(|finding| redact::redact_line(&finding.to_string()))
        .collect();
    if let Some(out) = out {
        let payload = format!("{json}\n");
        if let Err(error) = util::write_atomic(out, payload.as_bytes(), 0o600) {
            return Report::failure(format!("{}: {error}", out.display()));
        }
        // Keep stdout valid JSON: the file notice belongs on stderr.
        stderr.push(format!("wrote {}", out.display()));
    }
    if execute {
        stderr.push(format!(
            "{} {} plan is ready ({} host(s), {} step(s)); provisioner execution is refused until the D1 service/SSH integration lands — nothing was changed",
            plan.environment,
            plan.target,
            plan.hosts.len(),
            plan.step_count()
        ));
        return Report {
            exit: EXIT_PRECONDITION,
            stdout,
            stderr,
        };
    }
    Report {
        exit: exit_for(&plan),
        stdout,
        stderr,
    }
}

fn exit_for(plan: &ProvisionPlan) -> u8 {
    if plan.error_count() > 0 {
        EXIT_FAILURE
    } else {
        EXIT_OK
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::Cli;
    use clap::Parser;

    fn cli(args: &[&str]) -> Cli {
        Cli::try_parse_from(args).unwrap_or_else(|error| panic!("{args:?}: {error}"))
    }

    fn document() -> &'static str {
        r#"
version = 1
[deployment]
environment = "test"
[[hosts]]
name = "db-1"
address = "10.0.0.21"
private_ip = "10.0.0.21"
roles = ["pg-primary", "pgbouncer", "audit-db", "log-db"]
[[hosts]]
name = "core-1"
address = "10.0.0.11"
private_ip = "10.0.0.11"
roles = ["core"]
[database]
mode = "managed"
host = "10.0.0.21"
owner_password = "secret:pg_db_password"
app_password = "secret:pg_app_password"
replication_password = "secret:pg_replication_password"
pgbouncer = true
tls = true
[storage.postgres]
ram_gb = 16
[storage.audit]
owner_password = "secret:pgw_owner_password"
writer_password = "secret:audit_writer_password"
[storage.log]
owner_password = "secret:pgw_owner_password"
writer_password = "secret:log_writer_password"
[storage.clamav]
mode = "managed"
"#
    }

    fn temp_document() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("pgctl.toml"), document()).expect("document");
        dir
    }

    #[test]
    fn provision_plan_prints_json_for_every_target() {
        let dir = temp_document();
        let path = dir.path().join("pgctl.toml");
        for target in ProvisionTarget::ALL {
            let report = crate::commands::execute(&cli(&[
                "pgctl",
                "provision",
                "plan",
                "--file",
                path.to_str().unwrap_or_default(),
                "--target",
                target.as_str(),
            ]));
            assert_eq!(report.exit, EXIT_OK, "{target}: {report:?}");
            let json: serde_json::Value =
                serde_json::from_str(&report.stdout[0]).expect("plan is JSON");
            assert_eq!(json["schema"], "pgctl.provision-plan/v1");
            assert_eq!(json["target"], target.as_str());
            assert_eq!(json["mode"], "update");
            if target == ProvisionTarget::Postgres {
                assert!(json["hosts"]
                    .as_array()
                    .is_some_and(|hosts| !hosts.is_empty()));
            }
        }
    }

    #[test]
    fn fresh_mode_changes_the_plan_and_execute_is_refused_with_the_plan() {
        let dir = temp_document();
        let path = dir.path().join("pgctl.toml");
        let update = crate::commands::execute(&cli(&[
            "pgctl",
            "provision",
            "plan",
            "--file",
            path.to_str().unwrap_or_default(),
            "--target",
            "postgres",
        ]));
        let fresh = crate::commands::execute(&cli(&[
            "pgctl",
            "provision",
            "plan",
            "--file",
            path.to_str().unwrap_or_default(),
            "--target",
            "postgres",
            "--mode",
            "fresh",
        ]));
        assert_eq!(update.exit, EXIT_OK);
        assert_eq!(fresh.exit, EXIT_OK);
        assert_ne!(update.stdout[0], fresh.stdout[0]);
        assert!(fresh.stdout[0].contains("pgdg-repository"));

        let refused = crate::commands::execute(&cli(&[
            "pgctl",
            "provision",
            "plan",
            "--file",
            path.to_str().unwrap_or_default(),
            "--target",
            "postgres",
            "--execute",
        ]));
        assert_eq!(refused.exit, EXIT_PRECONDITION);
        assert!(refused.stdout[0].contains("pgctl.provision-plan/v1"));
        assert!(refused
            .stderr
            .iter()
            .any(|line| line.contains("refused until the D1")));
    }

    #[test]
    fn provision_apply_is_refused() {
        let dir = temp_document();
        let path = dir.path().join("pgctl.toml");
        let report = crate::commands::execute(&cli(&[
            "pgctl",
            "provision",
            "apply",
            "--file",
            path.to_str().unwrap_or_default(),
            "--target",
            "redis",
        ]));
        assert_eq!(report.exit, EXIT_PRECONDITION);
        assert!(report
            .stderr
            .iter()
            .any(|line| line.contains("refused until the D1")));
    }

    #[test]
    fn invalid_target_mode_and_file_are_usage_errors() {
        let dir = temp_document();
        let path = dir.path().join("pgctl.toml");
        let report = crate::commands::execute(&cli(&[
            "pgctl",
            "provision",
            "plan",
            "--file",
            path.to_str().unwrap_or_default(),
            "--target",
            "mysql",
        ]));
        assert_eq!(report.exit, crate::commands::EXIT_USAGE);
        let report = crate::commands::execute(&cli(&[
            "pgctl",
            "provision",
            "plan",
            "--file",
            path.to_str().unwrap_or_default(),
            "--target",
            "postgres",
            "--mode",
            "sideways",
        ]));
        assert_eq!(report.exit, crate::commands::EXIT_USAGE);
        let report = crate::commands::execute(&cli(&[
            "pgctl",
            "provision",
            "plan",
            "--file",
            dir.path().join("missing.toml").to_str().unwrap_or_default(),
            "--target",
            "postgres",
        ]));
        assert_eq!(report.exit, crate::commands::EXIT_FAILURE);
    }

    #[test]
    fn an_invalid_document_still_prints_the_plan_and_fails() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("pgctl.toml");
        std::fs::write(
            &path,
            r#"
version = 1
[deployment]
environment = "test"
[[hosts]]
name = "db-1"
address = "10.0.0.21"
private_ip = "10.0.0.21"
roles = ["pg-primary"]
[database]
mode = "managed"
host = "10.0.0.21"
owner_password = "secret:pg_db_password"
[storage.postgres]
ram_gb = 0
roles = { owner = "pg_bad", app = "pgw_app_login", app_group = "pgw_app", replication = "gw_replicator" }
"#,
        )
        .expect("document");
        let report = crate::commands::execute(&cli(&[
            "pgctl",
            "provision",
            "plan",
            "--file",
            path.to_str().unwrap_or_default(),
            "--target",
            "postgres",
        ]));
        assert_eq!(report.exit, EXIT_FAILURE);
        assert!(report.stdout[0].contains("PROVISION_POSTGRES_ROLE"));
        assert!(report.stdout[0].contains("PROVISION_POSTGRES_RAM"));
    }

    #[test]
    fn the_out_flag_writes_the_same_plan() {
        let dir = temp_document();
        let path = dir.path().join("pgctl.toml");
        let out = dir.path().join("plan.json");
        let report = crate::commands::execute(&cli(&[
            "pgctl",
            "provision",
            "plan",
            "--file",
            path.to_str().unwrap_or_default(),
            "--target",
            "audit-log",
            "--out",
            out.to_str().unwrap_or_default(),
        ]));
        assert_eq!(report.exit, EXIT_OK, "{report:?}");
        let written = std::fs::read_to_string(&out).expect("plan file");
        assert!(written.contains("pgctl.provision-plan/v1"));
        assert!(!written.contains("\\\"secret:"));
    }
}

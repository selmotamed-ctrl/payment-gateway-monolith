//! Command implementations.
//!
//! Everything returns a [`Report`] instead of printing directly, so the exit-code contract
//! (chapter 3 §10: 0 success, 1 failure, 2 usage, 3 precondition) is testable without capturing
//! stdout. `main` prints the report and maps it to a process exit code.

#![forbid(unsafe_code)]

use std::path::Path;

use pg_deploy_config::{
    import_env_detailed, json_schema_pretty, load_toml_file, parse_env_file, save_toml_file,
    validate, ConfigProblem, PgctlConfig, Severity,
};
use pg_deploy_plan::plan;

use crate::cli::{Cli, Command, ConfigCommand, ReleaseCommand};
use crate::redact;

/// Success.
pub const EXIT_OK: u8 = 0;
/// The command ran and failed (invalid config, IO error, failed check).
pub const EXIT_FAILURE: u8 = 1;
/// The command line is wrong.
pub const EXIT_USAGE: u8 = 2;
/// A precondition is missing: the feature is not implemented in this build, or the environment
/// cannot satisfy the command.
pub const EXIT_PRECONDITION: u8 = 3;

/// What a command produced.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Report {
    /// Process exit code.
    pub exit: u8,
    /// Lines for stdout.
    pub stdout: Vec<String>,
    /// Lines for stderr.
    pub stderr: Vec<String>,
}

impl Report {
    /// A successful report with stdout lines.
    #[must_use]
    pub fn ok(stdout: Vec<String>) -> Self {
        Self {
            exit: EXIT_OK,
            stdout,
            stderr: Vec::new(),
        }
    }

    /// A failed report (exit 1) with a stderr line.
    #[must_use]
    pub fn failure(message: impl Into<String>) -> Self {
        Self {
            exit: EXIT_FAILURE,
            stdout: Vec::new(),
            stderr: vec![message.into()],
        }
    }

    /// A usage error (exit 2).
    #[must_use]
    pub fn usage(message: impl Into<String>) -> Self {
        Self {
            exit: EXIT_USAGE,
            stdout: Vec::new(),
            stderr: vec![message.into()],
        }
    }

    /// A precondition failure (exit 3): a documented feature that this build does not implement.
    #[must_use]
    pub fn not_implemented(what: &str) -> Self {
        Self {
            exit: EXIT_PRECONDITION,
            stdout: Vec::new(),
            stderr: vec![format!(
                "{what} is not implemented in this build (D0); nothing was changed"
            )],
        }
    }
}

/// Run the parsed command.
#[must_use]
pub fn execute(cli: &Cli) -> Report {
    match &cli.command {
        Command::Version => {
            if cli.json {
                let payload = serde_json::json!({
                    "name": "pgctl",
                    "version": env!("CARGO_PKG_VERSION"),
                    "config_schema_version": pg_deploy_config::CONFIG_VERSION,
                    "milestone": "D0-D5-plans",
                });
                Report::ok(vec![
                    serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".to_owned())
                ])
            } else {
                Report::ok(vec![format!(
                    "pgctl {} (pgctl.toml schema v{}, deploy engine D0-D4)",
                    env!("CARGO_PKG_VERSION"),
                    pg_deploy_config::CONFIG_VERSION
                )])
            }
        }
        Command::Config { command } => match command {
            ConfigCommand::Validate(args) => run_validate(cli, &args.file),
            ConfigCommand::Import(args) => run_import(cli, &args.env_file, &args.out),
            ConfigCommand::Schema => {
                Report::ok(json_schema_pretty().lines().map(str::to_owned).collect())
            }
        },
        Command::Plan(args) => {
            let Some(path) = args.file.clone().or_else(|| cli.config.clone()) else {
                return Report::usage(
                    "plan requires --file <PATH> (or the global --config <PATH>)",
                );
            };
            run_plan(cli, &path)
        }
        Command::Provision { command } => crate::commands_provision::run(cli, command),
        Command::Hosts { command } => crate::commands_ops::run_hosts(cli, command),
        Command::Service { command } => crate::commands_ops::run_service(cli, command),
        Command::Deploy(args) => crate::commands_release::run_deploy(cli, args),
        Command::Rollback(args) => crate::commands_release::run_rollback(cli, args),
        Command::Watch(args) => crate::commands_release::run_watch(cli, args),
        Command::RouteTable(args) => crate::commands_ops::run_route_table(cli, args),
        Command::Workers { command } => crate::commands_ops::run_workers(cli, command),
        Command::Push(args) => crate::commands_ops::run_push(cli, args),
        Command::Release { command } => match command {
            ReleaseCommand::Build(args) => crate::commands_release::run_release_build(cli, args),
            ReleaseCommand::Sign(args) => crate::commands_release::run_release_sign(cli, args),
            ReleaseCommand::Verify(args) => crate::commands_release::run_release_verify(cli, args),
        },
        Command::Pki { command } => crate::pki::commands::run(cli, command),
        Command::Local { .. } => Report::not_implemented("pgctl local"),
        Command::Lab { .. } => Report::not_implemented("pgctl lab"),
        Command::Stress { .. } => Report::not_implemented("pgctl stress"),
    }
}

fn run_validate(cli: &Cli, path: &Path) -> Report {
    let config = match load_toml_file(path) {
        Ok(config) => config,
        Err(error) => return Report::failure(redact::redact_line(&error.to_string())),
    };
    let problems = validate(&config);
    let errors = problems.iter().filter(|problem| problem.is_error()).count();
    let warnings = problems.len() - errors;
    let mut report = Report {
        exit: if errors > 0 { EXIT_FAILURE } else { EXIT_OK },
        stdout: Vec::new(),
        stderr: Vec::new(),
    };
    if cli.json {
        let payload = serde_json::json!({
            "file": path.display().to_string(),
            "ok": errors == 0,
            "errors": errors,
            "warnings": warnings,
            "problems": problems,
        });
        report
            .stdout
            .push(serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".to_owned()));
    } else {
        for problem in &problems {
            let line = redact::redact_line(&problem.to_string());
            if problem.is_error() {
                report.stderr.push(line);
            } else {
                report.stdout.push(line);
            }
        }
        report.stdout.push(if errors == 0 {
            format!(
                "{}: ok ({errors} error(s), {warnings} warning(s))",
                path.display()
            )
        } else {
            format!(
                "{}: failed ({errors} error(s), {warnings} warning(s))",
                path.display()
            )
        });
    }
    report
}

fn run_import(cli: &Cli, env_file: &Path, out: &Path) -> Report {
    let env = match parse_env_file(env_file) {
        Ok(env) => env,
        Err(error) => {
            return Report::failure(format!("cannot read {}: {error}", env_file.display()))
        }
    };
    let outcome = import_env_detailed(&env);
    let errors: Vec<&ConfigProblem> = outcome
        .problems
        .iter()
        .filter(|problem| problem.is_error())
        .collect();
    let mut report = Report {
        exit: if errors.is_empty() {
            EXIT_OK
        } else {
            EXIT_FAILURE
        },
        stdout: Vec::new(),
        stderr: Vec::new(),
    };

    if !errors.is_empty() {
        for problem in &errors {
            report
                .stderr
                .push(redact::redact_line(&problem.to_string()));
        }
        report.stderr.push(format!(
            "{} key(s) were not imported; fix the findings above and run the import again",
            errors.len()
        ));
        if cli.json {
            report.stdout.push(
                serde_json::to_string_pretty(&serde_json::json!({
                    "ok": false,
                    "problems": outcome.problems,
                }))
                .unwrap_or_else(|_| "{}".to_owned()),
            );
        }
        return report;
    }

    if let Err(error) = save_toml_file(out, &outcome.config) {
        return Report::failure(redact::redact_line(&error.to_string()));
    }

    let secret_names = outcome.extracted_secrets.len();
    let unmapped = outcome.unmapped.len();
    let empty_values = env.values().filter(|value| value.trim().is_empty()).count();
    let secret_inputs = env
        .iter()
        .filter(|(key, value)| {
            pg_deploy_config::import_env::is_secret_key(key.as_str()) && !value.trim().is_empty()
        })
        .count();
    let mapped = env
        .len()
        .saturating_sub(empty_values)
        .saturating_sub(unmapped)
        .saturating_sub(secret_inputs);

    if cli.json {
        report.stdout.push(
            serde_json::to_string_pretty(&serde_json::json!({
                "ok": true,
                "out": out.display().to_string(),
                "mapped": mapped,
                "unmapped": outcome.unmapped,
                "extracted_secrets": outcome.extracted_secrets,
                "problems": outcome.problems,
            }))
            .unwrap_or_else(|_| "{}".to_owned()),
        );
    } else {
        report
            .stdout
            .push(format!("wrote {} (mode 0600)", out.display()));
        report.stdout.push(format!(
            "{mapped} key(s) mapped, {unmapped} unmapped, {secret_names} secret(s) extracted"
        ));
        if !outcome.unmapped.is_empty() {
            report.stdout.push(format!(
                "unmapped keys were kept in [extra] for review: {}",
                outcome.unmapped.join(", ")
            ));
        }
        if !outcome.extracted_secrets.is_empty() {
            report.stdout.push(format!(
                "secret values were NOT written; store these in secrets.age: {}",
                outcome.extracted_secrets.join(", ")
            ));
        }
        for problem in outcome
            .problems
            .iter()
            .filter(|problem| problem.severity == Severity::Warning)
        {
            report
                .stdout
                .push(redact::redact_line(&problem.to_string()));
        }
    }
    report
}

fn run_plan(cli: &Cli, path: &Path) -> Report {
    let config: PgctlConfig = match load_toml_file(path) {
        Ok(config) => config,
        Err(error) => return Report::failure(redact::redact_line(&error.to_string())),
    };
    let desired = plan(&config);
    // D4-T02: the storage TLS section is part of the deploy plan. Paths and SANs come from the
    // certificate catalogue, so the storage provisioners consume one source of truth.
    let storage_tls = crate::pki::storage::plan_for_config(&config, None);
    let mut report = Report {
        exit: if desired.has_errors() {
            EXIT_FAILURE
        } else {
            EXIT_OK
        },
        stdout: Vec::new(),
        stderr: Vec::new(),
    };
    if cli.json {
        match serde_json::to_value(&desired) {
            Ok(mut value) => {
                if let Ok(section) = serde_json::to_value(&storage_tls) {
                    value["pki"] = section;
                }
                report
                    .stdout
                    .push(serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{}".to_owned()));
            }
            Err(_) => report
                .stdout
                .push(serde_json::to_string_pretty(&desired).unwrap_or_else(|_| "{}".to_owned())),
        }
    } else {
        report.stdout.push(format!(
            "Topology: {} host(s), {} service(s)",
            desired.hosts.len(),
            desired.services.len()
        ));
        for host in &desired.hosts {
            report.stdout.push(format!(
                "  {}  {}:{}  [{}]",
                host.name,
                host.address,
                host.ssh_port,
                host.roles
                    .iter()
                    .map(|role| role.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
            for service in &host.services {
                if let Some(planned) = desired.service(service) {
                    report.stdout.push(format!(
                        "    - {} :{}  ({} -> {})",
                        planned.name,
                        planned.port,
                        planned.impl_.as_str(),
                        planned.systemd_unit
                    ));
                }
            }
        }
        report.stdout.push(format!(
            "PKI: {} (root + intermediate CA, {} storage client certificate(s)); storage TLS: {} PostgreSQL, {} PgBouncer, {} Redis endpoint(s) — see 'pgctl pki storage'",
            storage_tls.dir,
            storage_tls.clients.len(),
            storage_tls.postgres.len(),
            storage_tls.pgbouncer.len(),
            storage_tls.redis.len()
        ));
    }
    for warning in &desired.warnings {
        let line = format!(
            "{} [{}] {}: {}",
            warning.severity, warning.code, warning.path, warning.message
        );
        if warning.severity.is_error() {
            report.stderr.push(redact::redact_line(&line));
        } else if !cli.json {
            // In JSON mode stdout must stay a single JSON document; the warnings are already in
            // `plan.warnings`.
            report.stdout.push(redact::redact_line(&line));
        }
    }
    if !cli.json {
        report.stdout.push(format!(
            "{} error(s), {} warning(s)",
            desired
                .warnings
                .iter()
                .filter(|warning| warning.severity.is_error())
                .count(),
            desired
                .warnings
                .iter()
                .filter(|warning| !warning.severity.is_error())
                .count()
        ));
    }
    report
}

/// Write a report and return its exit code.
pub fn print(report: &Report) -> u8 {
    use std::io::Write;
    let mut stdout = std::io::stdout().lock();
    for line in &report.stdout {
        let _ = writeln!(stdout, "{line}");
    }
    let _ = stdout.flush();
    let mut stderr = std::io::stderr().lock();
    for line in &report.stderr {
        let _ = writeln!(stderr, "{line}");
    }
    let _ = stderr.flush();
    report.exit
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    fn cli(args: &[&str]) -> Cli {
        Cli::try_parse_from(args).unwrap_or_else(|error| panic!("{args:?}: {error}"))
    }

    fn temp_path(name: &str) -> std::path::PathBuf {
        let unique = format!(
            "pgctl-cmd-{}-{}-{name}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default()
        );
        let dir = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    const VALID: &str = r#"
version = 1
[deployment]
environment = "development"
[[hosts]]
name = "core-1"
address = "10.0.0.11"
ssh_user = "deploy"
roles = ["core"]
private_ip = "10.0.0.11"
"#;

    #[test]
    fn version_is_successful_in_both_modes() {
        let report = execute(&cli(&["pgctl", "version"]));
        assert_eq!(report.exit, EXIT_OK);
        assert!(report.stdout[0].contains("pgctl"));
        let report = execute(&cli(&["pgctl", "version", "--json"]));
        assert_eq!(report.exit, EXIT_OK);
        let parsed: serde_json::Value =
            serde_json::from_str(&report.stdout[0]).expect("valid JSON");
        assert_eq!(parsed["name"], "pgctl");
        assert_eq!(parsed["config_schema_version"], 1);
    }

    #[test]
    fn validate_reports_success_and_failure() {
        let dir = temp_path("validate");
        let good = dir.join("good.toml");
        std::fs::write(&good, VALID).expect("write");
        let report = execute(&cli(&[
            "pgctl",
            "config",
            "validate",
            "--file",
            good.to_str().unwrap_or_default(),
        ]));
        assert_eq!(report.exit, EXIT_OK, "{report:?}");
        assert!(report.stdout.iter().any(|line| line.contains("ok")));

        let bad = dir.join("bad.toml");
        std::fs::write(&bad, "version = 1\n[deployment]\nenvironment = \"production\"\n[tls]\nmode = \"self-signed\"\n[[hosts]]\nname = \"core-1\"\naddress = \"10.0.0.11\"\nroles = [\"core\"]\nprivate_ip = \"10.0.0.11\"\n").expect("write");
        let report = execute(&cli(&[
            "pgctl",
            "config",
            "validate",
            "--file",
            bad.to_str().unwrap_or_default(),
        ]));
        assert_eq!(report.exit, EXIT_FAILURE);
        assert!(report
            .stderr
            .iter()
            .any(|line| line.contains("PRODUCTION_REQUIRES_TLS")));
    }

    #[test]
    fn validate_a_missing_file_fails_without_a_panic() {
        let report = execute(&cli(&[
            "pgctl",
            "config",
            "validate",
            "--file",
            "/nonexistent/pgctl.toml",
        ]));
        assert_eq!(report.exit, EXIT_FAILURE);
        assert!(report.stderr[0].contains("cannot read"));
    }

    #[test]
    fn validate_json_is_machine_readable() {
        let dir = temp_path("validate-json");
        let good = dir.join("good.toml");
        std::fs::write(&good, VALID).expect("write");
        let report = execute(&cli(&[
            "pgctl",
            "config",
            "validate",
            "--file",
            good.to_str().unwrap_or_default(),
            "--json",
        ]));
        assert_eq!(report.exit, EXIT_OK);
        let parsed: serde_json::Value =
            serde_json::from_str(&report.stdout[0]).expect("valid JSON");
        assert_eq!(parsed["ok"], true);
    }

    #[test]
    fn import_writes_a_secret_free_document_that_validates() {
        let dir = temp_path("import");
        let env = dir.join("deploy.env");
        std::fs::write(
            &env,
            "\
DEPLOY_ENV=\"development\"
CORE_SSH_HOST=\"10.0.0.11\"
CORE_SSH_USER=\"deploy\"
CORE_PRIVATE_IP=\"10.0.0.11\"
CORE_PORT=\"4000\"
ADMIN_SSH_HOST=\"10.0.0.30\"
ADMIN_SSH_USER=\"deploy\"
ADMIN_PRIVATE_IP=\"10.0.0.30\"
DB_MANAGE_VIA_SSH=\"false\"
DB_NAME=\"payment_gateway_prod\"
DB_USER=\"gw_core_user\"
DB_PASSWORD=\"Kf9mQ2vLx7Rw4nZt8B\"
DATABASE_URL=\"postgresql://gw_core_user:Kf9mQ2vLx7@10.0.0.21:5432/payment_gateway_prod\"
",
        )
        .expect("write env");
        let out = dir.join("pgctl.toml");
        let report = execute(&cli(&[
            "pgctl",
            "config",
            "import",
            "--env-file",
            env.to_str().unwrap_or_default(),
            "--out",
            out.to_str().unwrap_or_default(),
        ]));
        assert_eq!(report.exit, EXIT_OK, "{report:?}");
        let text = std::fs::read_to_string(&out).expect("written");
        assert!(
            !text.contains("Kf9mQ2vLx7"),
            "a secret value leaked into pgctl.toml"
        );
        assert!(text.contains("secret:db_password"));
        assert!(report
            .stdout
            .iter()
            .any(|line| line.contains("secret values were NOT written")));

        let report = execute(&cli(&[
            "pgctl",
            "config",
            "validate",
            "--file",
            out.to_str().unwrap_or_default(),
        ]));
        assert_eq!(report.exit, EXIT_OK, "{report:?}");
    }

    #[test]
    fn import_refuses_card_data_and_writes_nothing() {
        let dir = temp_path("import-pan");
        let env = dir.join("deploy.env");
        std::fs::write(&env, "DEPLOY_ENV=development\nPAN_RAIL=edfali\n").expect("write env");
        let out = dir.join("pgctl.toml");
        let report = execute(&cli(&[
            "pgctl",
            "config",
            "import",
            "--env-file",
            env.to_str().unwrap_or_default(),
            "--out",
            out.to_str().unwrap_or_default(),
        ]));
        assert_eq!(report.exit, EXIT_FAILURE);
        assert!(report
            .stderr
            .iter()
            .any(|line| line.contains("PAN_RAIL_GUARD")));
        assert!(!out.exists());
    }

    #[test]
    fn import_a_missing_env_file_fails() {
        let report = execute(&cli(&[
            "pgctl",
            "config",
            "import",
            "--env-file",
            "/nonexistent/deploy.env",
            "--out",
            "/tmp/never.toml",
        ]));
        assert_eq!(report.exit, EXIT_FAILURE);
        assert!(report.stderr[0].contains("cannot read"));
    }

    #[test]
    fn schema_prints_json() {
        let report = execute(&cli(&["pgctl", "config", "schema"]));
        assert_eq!(report.exit, EXIT_OK);
        let joined = report.stdout.join("\n");
        let parsed: serde_json::Value = serde_json::from_str(&joined).expect("valid JSON schema");
        assert!(parsed.is_object());
    }

    #[test]
    fn plan_requires_a_file() {
        let report = execute(&cli(&["pgctl", "plan"]));
        assert_eq!(report.exit, EXIT_USAGE);
        assert!(report.stderr[0].contains("requires --file"));
    }

    #[test]
    fn plan_prints_human_and_json_forms() {
        let dir = temp_path("plan");
        let file = dir.join("pgctl.toml");
        std::fs::write(&file, VALID).expect("write");
        let path = file.to_str().unwrap_or_default().to_owned();

        let report = execute(&cli(&["pgctl", "plan", "--file", &path]));
        assert_eq!(report.exit, EXIT_OK, "{report:?}");
        let text = report.stdout.join("\n");
        assert!(text.contains("pg-core-back"));
        assert!(text.contains(":4000"));

        let report = execute(&cli(&["pgctl", "plan", "--file", &path, "--json"]));
        assert_eq!(report.exit, EXIT_OK);
        let parsed: serde_json::Value =
            serde_json::from_str(&report.stdout[0]).expect("valid JSON plan");
        assert!(parsed["services"].is_array());
        assert_eq!(parsed["services"][0]["host"], "core-1");
    }

    #[test]
    fn plan_json_embeds_the_storage_tls_section() {
        let dir = temp_path("plan-pki");
        let file = dir.join("pgctl.toml");
        std::fs::write(&file, VALID).expect("write");
        let report = execute(&cli(&[
            "pgctl",
            "plan",
            "--file",
            file.to_str().unwrap_or_default(),
            "--json",
        ]));
        assert_eq!(report.exit, EXIT_OK, "{report:?}");
        let parsed: serde_json::Value =
            serde_json::from_str(&report.stdout[0]).expect("valid JSON plan");
        assert_eq!(parsed["pki"]["section"], "storage-tls");
        assert!(parsed["pki"]["guidance"].is_array());
        assert!(parsed["pki"]["ca_chain_file"]
            .as_str()
            .is_some_and(|path| path.ends_with("ca-chain.crt")));
    }

    #[test]
    fn plan_uses_the_global_config_flag() {
        let dir = temp_path("plan-global");
        let file = dir.join("pgctl.toml");
        std::fs::write(&file, VALID).expect("write");
        let report = execute(&cli(&[
            "pgctl",
            "--config",
            file.to_str().unwrap_or_default(),
            "plan",
        ]));
        assert_eq!(report.exit, EXIT_OK, "{report:?}");
    }

    #[test]
    fn an_invalid_document_plans_but_fails() {
        let dir = temp_path("plan-invalid");
        let file = dir.join("pgctl.toml");
        std::fs::write(
            &file,
            "version = 1\n[deployment]\nenvironment = \"production\"\n[tls]\nmode = \"self-signed\"\n[[hosts]]\nname = \"core-1\"\naddress = \"10.0.0.11\"\nroles = [\"core\"]\nprivate_ip = \"10.0.0.11\"\n",
        )
        .expect("write");
        let report = execute(&cli(&[
            "pgctl",
            "plan",
            "--file",
            file.to_str().unwrap_or_default(),
        ]));
        assert_eq!(report.exit, EXIT_FAILURE);
        assert!(report
            .stderr
            .iter()
            .any(|line| line.contains("PRODUCTION_REQUIRES_TLS")));
    }

    #[test]
    fn unimplemented_commands_exit_with_the_precondition_code() {
        for args in [
            vec!["pgctl", "local", "up"],
            vec!["pgctl", "local", "smoke"],
            vec!["pgctl", "lab", "run"],
            vec!["pgctl", "stress", "list"],
        ] {
            let report = execute(&cli(&args));
            assert_eq!(report.exit, EXIT_PRECONDITION, "{args:?}");
            assert!(report.stderr[0].contains("not implemented"), "{args:?}");
        }
    }
}

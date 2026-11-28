//! Release, deploy, rollback and watch commands (D1-T01, D3-T03).

#![forbid(unsafe_code)]

use std::path::{Path, PathBuf};

use pg_deploy_config::{load_toml_file, PgctlConfig};
use pg_deploy_plan::WorkerTarget;

use crate::cli::{
    Cli, DeployArgs, ReleaseBuildArgs, ReleaseSignArgs, ReleaseVerifyArgs, RollbackArgs, WatchArgs,
};
use crate::commands::{Report, EXIT_FAILURE, EXIT_OK, EXIT_PRECONDITION};
use crate::release::{build, load_manifest, sign_file, verify_file, BuildOptions};
use crate::state::{ReleaseRecord, ReleaseState};
use crate::util;
use crate::watch::{evaluate, WatchDecision, WatchPolicy, WatchSample};

/// Global `--config` fallback.
fn config_path(cli: &Cli, file: &Option<PathBuf>) -> Result<Option<PathBuf>, Report> {
    let path = file.clone().or_else(|| cli.config.clone());
    if let Some(path) = &path {
        if !path.is_file() {
            return Err(Report::failure(format!("{}: no such file", path.display())));
        }
    }
    Ok(path)
}

fn load_config(cli: &Cli, file: &Option<PathBuf>) -> Result<Option<PgctlConfig>, Report> {
    let Some(path) = config_path(cli, file)? else {
        return Ok(None);
    };
    load_toml_file(&path)
        .map(Some)
        .map_err(|error| Report::failure(error.to_string()))
}

/// `$HOME`
fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn git_commit() -> String {
    if let Ok(commit) = std::env::var("GIT_COMMIT") {
        if !commit.trim().is_empty() {
            return commit.trim().to_owned();
        }
    }
    let output = std::process::Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output();
    match output {
        Ok(output) if output.status.success() => {
            String::from_utf8_lossy(&output.stdout).trim().to_owned()
        }
        _ => "unknown".to_owned(),
    }
}

fn source_date_epoch() -> Option<u64> {
    std::env::var("SOURCE_DATE_EPOCH")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
}

/// `pgctl release build`.
#[must_use]
pub fn run_release_build(cli: &Cli, args: &ReleaseBuildArgs) -> Report {
    let config = match load_config(cli, &args.file) {
        Ok(config) => config,
        Err(report) => return report,
    };
    let version = args
        .version
        .clone()
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_owned());
    let commit = args.commit.clone().unwrap_or_else(git_commit);
    let target = args.target.clone().unwrap_or_else(|| {
        std::env::var("TARGET")
            .unwrap_or_else(|_| format!("{}-{}", std::env::consts::ARCH, std::env::consts::OS))
    });
    let built_at_unix = args
        .epoch
        .or_else(source_date_epoch)
        .unwrap_or_else(util::now_unix);
    let workers_target = match args.workers.as_deref() {
        Some(value) => match WorkerTarget::parse(value) {
            Some(target) => target,
            None => return Report::usage("--workers must be ts or rs"),
        },
        None => config
            .as_ref()
            .map(|config| {
                if config.services.core.implementation == pg_deploy_config::ImplKind::Rs {
                    WorkerTarget::Rs
                } else {
                    WorkerTarget::Ts
                }
            })
            .unwrap_or(WorkerTarget::Ts),
    };
    let options = BuildOptions {
        out_dir: args.out.clone(),
        bin_dir: args
            .bin_dir
            .clone()
            .unwrap_or_else(|| PathBuf::from("target/release")),
        version,
        commit,
        target,
        built_at_unix,
        config,
        workers_target,
    };
    match build(&options) {
        Ok(output) => {
            if cli.json {
                match serde_json::to_string_pretty(&output.manifest) {
                    Ok(text) => Report::ok(vec![text]),
                    Err(error) => Report::failure(error.to_string()),
                }
            } else {
                Report::ok(vec![
                    format!("release {}", output.manifest.release_id()),
                    format!("archive  {}", output.archive.display()),
                    format!("manifest {}", output.manifest_path.display()),
                    format!("checksum {}", output.checksum_path.display()),
                    format!("sha256   {}", output.checksum),
                    format!(
                        "{} binaries, {} files, sbom {}",
                        output.manifest.binaries.len(),
                        output.manifest.files.len(),
                        output.manifest.sbom
                    ),
                ])
            }
        }
        Err(error) => Report::failure(error.to_string()),
    }
}

/// `pgctl release sign`.
#[must_use]
pub fn run_release_sign(cli: &Cli, args: &ReleaseSignArgs) -> Report {
    let key = args
        .key
        .clone()
        .unwrap_or_else(|| home().join(".minisign/minisign.key"));
    let password = std::env::var("MINISIGN_PASSWORD")
        .ok()
        .filter(|password| !password.is_empty());
    let comment = args.trusted_comment.clone().unwrap_or_else(|| {
        let name = args
            .file
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "release".to_owned());
        format!("pgctl release {name}")
    });
    match sign_file(&args.file, &key, password, &comment) {
        Ok(signature) => {
            if cli.json {
                let payload = serde_json::json!({
                    "file": args.file.display().to_string(),
                    "signature": signature.display().to_string(),
                    "trusted_comment": comment,
                });
                Report::ok(vec![
                    serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".to_owned())
                ])
            } else {
                Report::ok(vec![format!(
                    "signed {} -> {}",
                    args.file.display(),
                    signature.display()
                )])
            }
        }
        Err(error) => Report::failure(error.to_string()),
    }
}

/// `pgctl release verify`.
#[must_use]
pub fn run_release_verify(cli: &Cli, args: &ReleaseVerifyArgs) -> Report {
    let public_key = args
        .public_key
        .clone()
        .unwrap_or_else(|| home().join(".minisign/minisign.pub"));
    match verify_file(&args.file, &public_key) {
        Ok(info) => {
            if cli.json {
                let payload = serde_json::json!({
                    "file": args.file.display().to_string(),
                    "signature": info.signature_path.display().to_string(),
                    "trusted_comment": info.trusted_comment,
                    "sha256": info.sha256,
                });
                Report::ok(vec![
                    serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".to_owned())
                ])
            } else {
                Report::ok(vec![
                    format!("verified {} (minisign)", args.file.display()),
                    format!("sha256 {}", info.sha256),
                    format!("comment {}", info.trusted_comment),
                ])
            }
        }
        Err(error) => Report::failure(error.to_string()),
    }
}

fn state_path(explicit: &Option<PathBuf>) -> PathBuf {
    explicit.clone().unwrap_or_else(ReleaseState::default_path)
}

fn switch_steps(record: &ReleaseRecord) -> Vec<String> {
    vec![
        format!(
            "1. verify release {} exists on every host: {}",
            record.release_id(),
            record.archive
        ),
        format!(
            "2. switch /opt/pg/current -> /opt/pg/releases/{}",
            record.release_id()
        ),
        "3. systemctl daemon-reload && restart the services changed by this release".to_owned(),
        "4. run the verification suite and the post-deploy watch window".to_owned(),
        "5. migrations are never rolled back automatically (N-1 rule)".to_owned(),
    ]
}

/// `pgctl deploy` (state recording only; remote changes belong to `apply`).
#[must_use]
pub fn run_deploy(cli: &Cli, args: &DeployArgs) -> Report {
    let manifest_path = args.manifest.clone().unwrap_or_else(|| {
        args.archive
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("manifest.json")
    });
    let manifest = match load_manifest(&manifest_path) {
        Ok(manifest) => manifest,
        Err(error) => return Report::failure(error),
    };
    if !args.archive.is_file() {
        return Report::failure(format!("{}: no such archive", args.archive.display()));
    }
    // The checksum sidecar, when present, must match the archive.
    let checksum_path = PathBuf::from(format!("{}.sha256", args.archive.display()));
    if checksum_path.is_file() {
        let expected = std::fs::read_to_string(&checksum_path)
            .ok()
            .and_then(|text| text.split_whitespace().next().map(str::to_owned));
        let actual = util::sha256_file(&args.archive).ok();
        if let (Some(expected), Some(actual)) = (expected, actual) {
            if expected != actual {
                return Report::failure(format!(
                    "{}: archive sha256 does not match {}",
                    args.archive.display(),
                    checksum_path.display()
                ));
            }
        }
    }
    let record = ReleaseRecord {
        version: manifest.version.clone(),
        commit: manifest.commit.clone(),
        archive: args.archive.display().to_string(),
        manifest: manifest_path.display().to_string(),
        installed_at_unix: util::now_unix(),
        schema_min: manifest.schema_min,
        schema_max: manifest.schema_max,
    };
    let path = state_path(&args.state);
    let mut state = match ReleaseState::load(&path) {
        Ok(state) => state,
        Err(error) => return Report::failure(error),
    };
    if !args.dry_run {
        state.record(record.clone());
        if let Err(error) = state.save(&path) {
            return Report::failure(error);
        }
    }
    let mut lines = vec![format!(
        "release {} ({})",
        record.release_id(),
        if args.dry_run { "dry run" } else { "recorded" }
    )];
    lines.extend(switch_steps(&record));
    if cli.json {
        let payload = serde_json::json!({
            "record": record,
            "dry_run": args.dry_run,
            "state": path.display().to_string(),
        });
        return Report::ok(vec![
            serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".to_owned())
        ]);
    }
    Report::ok(lines)
}

/// `pgctl rollback`.
#[must_use]
pub fn run_rollback(cli: &Cli, args: &RollbackArgs) -> Report {
    let path = state_path(&args.state);
    let mut state = match ReleaseState::load(&path) {
        Ok(state) => state,
        Err(error) => return Report::failure(error),
    };
    let target = match args.to.as_deref() {
        Some(wanted) => match state.find(wanted) {
            Some(record) => record.clone(),
            None => {
                return Report::failure(format!("release '{wanted}' is not in {}", path.display()))
            }
        },
        None => match state.previous() {
            Some(record) => record.clone(),
            None => return Report::failure("there is no previous release to roll back to"),
        },
    };
    if let Some(current_schema) = args.current_schema {
        if let Some(schema_max) = target.schema_max {
            if schema_max < current_schema {
                return Report::failure(format!(
                    "release {} supports schema up to {schema_max} but the database is at {current_schema}; migrations are not rolled back",
                    target.release_id()
                ));
            }
        }
    }
    if !args.dry_run {
        if let Err(error) = state.rollback_to(args.to.as_deref()) {
            return Report::failure(error);
        }
        if let Err(error) = state.save(&path) {
            return Report::failure(error);
        }
    }
    if cli.json {
        let payload = serde_json::json!({
            "target": target,
            "dry_run": args.dry_run,
            "state": path.display().to_string(),
        });
        return Report::ok(vec![
            serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".to_owned())
        ]);
    }
    let mut lines = vec![format!(
        "rollback to {} ({})",
        target.release_id(),
        if args.dry_run {
            "dry run"
        } else {
            "state updated"
        }
    )];
    lines.extend(switch_steps(&target));
    Report::ok(lines)
}

/// `pgctl watch`.
#[must_use]
pub fn run_watch(cli: &Cli, args: &WatchArgs) -> Report {
    let Some(config) = (match load_config(cli, &args.file) {
        Ok(config) => config,
        Err(report) => return report,
    }) else {
        return Report::usage("watch requires --file <pgctl.toml> (or the global --config)");
    };
    let text = match std::fs::read_to_string(&args.samples) {
        Ok(text) => text,
        Err(error) => return Report::failure(format!("{}: {error}", args.samples.display())),
    };
    let samples: Vec<WatchSample> = match serde_json::from_str(&text) {
        Ok(samples) => samples,
        Err(error) => return Report::failure(format!("{}: {error}", args.samples.display())),
    };
    let now = args
        .now
        .or_else(|| samples.iter().map(|sample| sample.at_unix).max())
        .unwrap_or_else(util::now_unix);
    let policy = WatchPolicy::from_settings(&config.deployment.watch);
    let report = evaluate(&policy, now, &samples);
    if cli.json {
        return Report::ok(vec![
            serde_json::to_string_pretty(&report).unwrap_or_else(|_| "{}".to_owned())
        ]);
    }
    let mut lines = vec![
        format!("decision   {}", decision_label(report.decision)),
        format!("samples    {}", report.samples),
        format!(
            "errors     {} / {} ({} bps, limit {} bps)",
            report.errors, report.requests, report.error_bps, policy.max_error_bps
        ),
        format!(
            "p95        {} ms (limit {} ms)",
            report.max_p95_ms, policy.max_p95_ms
        ),
        format!(
            "workers    {} errors (limit {})",
            report.worker_errors, policy.max_worker_errors
        ),
    ];
    for reason in &report.reasons {
        lines.push(format!("reason     {reason}"));
    }
    let exit = match report.decision {
        WatchDecision::Rollback => EXIT_PRECONDITION,
        // A breach without auto-rollback is a failed check: alert with the failure code.
        WatchDecision::Continue if report.breached => EXIT_FAILURE,
        _ => EXIT_OK,
    };
    let mut result = Report {
        exit,
        stdout: lines,
        stderr: Vec::new(),
    };
    if report.decision == WatchDecision::Rollback {
        result.stderr.push(format!(
            "rollback recommended for release {}: {}",
            config.deployment.release.as_deref().unwrap_or("current"),
            report.reasons.join("; ")
        ));
    }
    result
}

fn decision_label(decision: WatchDecision) -> &'static str {
    match decision {
        WatchDecision::Continue => "continue",
        WatchDecision::Healthy => "healthy",
        WatchDecision::Rollback => "rollback",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    fn cli(args: &[&str]) -> Cli {
        Cli::try_parse_from(args).unwrap_or_else(|error| panic!("{args:?}: {error}"))
    }

    fn fake_bin(dir: &Path) {
        std::fs::create_dir_all(dir).expect("bin");
        for name in crate::release::build::RELEASE_BINARIES {
            std::fs::write(dir.join(name), format!("# {name}\n")).expect("binary");
        }
    }

    fn build_release(dir: &Path, version: &str, commit: &str) -> PathBuf {
        let out = dir.join(format!("out-{version}"));
        let report = crate::commands::execute(&cli(&[
            "pgctl",
            "release",
            "build",
            "--out",
            out.to_str().unwrap_or_default(),
            "--bin-dir",
            dir.join("bin").to_str().unwrap_or_default(),
            "--epoch",
            "0",
            "--version",
            version,
            "--commit",
            commit,
        ]));
        assert_eq!(report.exit, 0, "{report:?}");
        out
    }

    #[test]
    fn build_deploy_and_rollback_flow() {
        let dir = tempfile::tempdir().expect("tempdir");
        fake_bin(&dir.path().join("bin"));
        let first = build_release(dir.path(), "1", "aaa");
        let second = build_release(dir.path(), "2", "bbb");
        let state = dir.path().join("state.json");

        for (out, version, commit) in [(&first, "1", "aaa"), (&second, "2", "bbb")] {
            let archive = out.join(format!("pg-release-{version}-{commit}.tar.zst"));
            let report = crate::commands::execute(&cli(&[
                "pgctl",
                "deploy",
                "--archive",
                archive.to_str().unwrap_or_default(),
                "--manifest",
                out.join("manifest.json").to_str().unwrap_or_default(),
                "--state",
                state.to_str().unwrap_or_default(),
            ]));
            assert_eq!(report.exit, 0, "{report:?}");
        }
        assert_eq!(
            ReleaseState::load(&state)
                .expect("state")
                .current
                .map(|r| r.version),
            Some("2".to_owned())
        );

        let report = crate::commands::execute(&cli(&[
            "pgctl",
            "rollback",
            "--state",
            state.to_str().unwrap_or_default(),
        ]));
        assert_eq!(report.exit, 0, "{report:?}");
        assert_eq!(
            ReleaseState::load(&state)
                .expect("state")
                .current
                .map(|r| r.version),
            Some("1".to_owned())
        );

        let report = crate::commands::execute(&cli(&[
            "pgctl",
            "rollback",
            "--to",
            "2-bbb",
            "--state",
            state.to_str().unwrap_or_default(),
        ]));
        assert_eq!(report.exit, 0);
        assert_eq!(
            ReleaseState::load(&state)
                .expect("state")
                .current
                .map(|r| r.version),
            Some("2".to_owned())
        );

        let report = crate::commands::execute(&cli(&[
            "pgctl",
            "rollback",
            "--to",
            "nope",
            "--state",
            state.to_str().unwrap_or_default(),
        ]));
        assert_eq!(report.exit, 1);
    }

    #[test]
    fn watch_uses_the_configured_policy() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config = dir.path().join("pgctl.toml");
        std::fs::write(
            &config,
            "version = 1\n[deployment]\nenvironment = \"development\"\n[deployment.watch]\nwindow_minutes = 10\nmax_error_bps = 500\nmax_p95_ms = 1500\nmax_worker_errors = 10\nauto_rollback = true\n",
        )
        .expect("config");
        let samples = dir.path().join("samples.json");
        std::fs::write(
            &samples,
            r#"[{"at_unix":400,"requests":100,"errors":0,"p95_ms":100,"worker_errors":0},{"at_unix":990,"requests":100,"errors":1,"p95_ms":110,"worker_errors":0}]"#,
        )
        .expect("samples");
        let report = crate::commands::execute(&cli(&[
            "pgctl",
            "watch",
            "--file",
            config.to_str().unwrap_or_default(),
            "--samples",
            samples.to_str().unwrap_or_default(),
            "--now",
            "1000",
        ]));
        assert_eq!(report.exit, 0, "{report:?}");
        assert!(report.stdout.iter().any(|line| line.contains("healthy")));

        std::fs::write(
            &samples,
            r#"[{"at_unix":400,"requests":100,"errors":0,"p95_ms":100,"worker_errors":0},{"at_unix":990,"requests":100,"errors":20,"p95_ms":110,"worker_errors":0}]"#,
        )
        .expect("samples");
        let report = crate::commands::execute(&cli(&[
            "pgctl",
            "watch",
            "--file",
            config.to_str().unwrap_or_default(),
            "--samples",
            samples.to_str().unwrap_or_default(),
            "--now",
            "1000",
        ]));
        assert_eq!(report.exit, crate::commands::EXIT_PRECONDITION);
        assert!(report
            .stderr
            .iter()
            .any(|line| line.contains("rollback recommended")));
    }

    #[test]
    fn switch_steps_mention_the_release_and_the_n_1_rule() {
        let record = ReleaseRecord {
            version: "2".to_owned(),
            commit: "abc".to_owned(),
            archive: "/a".to_owned(),
            manifest: "/m".to_owned(),
            installed_at_unix: 0,
            schema_min: None,
            schema_max: None,
        };
        let steps = switch_steps(&record).join("\n");
        assert!(steps.contains("/opt/pg/releases/2-abc"));
        assert!(steps.contains("migrations are never rolled back"));
    }
}

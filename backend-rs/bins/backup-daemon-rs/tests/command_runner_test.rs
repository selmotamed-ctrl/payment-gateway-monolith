//! Port of `deploy/backup-daemon/test/commandRunner.test.ts`.

mod common;

use backup_daemon::command_runner::{CommandError, CommandRunner, RunOptions, SpawnCommandRunner};

#[tokio::test]
async fn dry_run_records_commands_without_spawning_them() {
    let runner = SpawnCommandRunner::new(true, None);
    let result = runner
        .run(
            "wal-g",
            &[
                "backup-push".to_owned(),
                "/var/lib/postgresql/18/main".to_owned(),
            ],
            RunOptions {
                env: vec![
                    ("WALG_S3_PREFIX".to_owned(), "s3://bucket".to_owned()),
                    ("AWS_SECRET_ACCESS_KEY".to_owned(), "hidden".to_owned()),
                ],
                input: None,
                timeout_ms: Some(1234),
            },
        )
        .await
        .expect("dry run");
    assert_eq!(result.code, 0);
    let recorded = runner.recorded();
    assert_eq!(recorded.len(), 1);
    assert_eq!(recorded[0].command, "wal-g");
    assert_eq!(recorded[0].args[0], "backup-push");
    assert_eq!(
        recorded[0].env_keys,
        vec!["WALG_S3_PREFIX", "AWS_SECRET_ACCESS_KEY"]
    );
    assert_eq!(recorded[0].timeout_ms, Some(1234));
}

#[tokio::test]
async fn arguments_are_argv_and_never_through_a_shell() {
    use std::sync::Arc;

    let runner: Arc<dyn CommandRunner> = Arc::new(SpawnCommandRunner::new(false, None));
    let args = vec![
        "%s\\n".to_owned(),
        "one two".to_owned(),
        "semi;colon".to_owned(),
        "$(not-a-substitution)".to_owned(),
    ];
    let result = runner
        .run("printf", &args, RunOptions::default())
        .await
        .expect("printf");
    assert_eq!(result.code, 0);
    let lines: Vec<&str> = result.stdout.lines().collect();
    assert_eq!(
        lines,
        vec!["one two", "semi;colon", "$(not-a-substitution)"]
    );
}

#[tokio::test]
async fn kills_and_reports_commands_that_exceed_their_timeout() {
    let runner = SpawnCommandRunner::new(false, None);
    let error = runner
        .run(
            "sleep",
            &["5".to_owned()],
            RunOptions {
                timeout_ms: Some(20),
                ..RunOptions::default()
            },
        )
        .await
        .expect_err("timeout");
    assert!(matches!(error, CommandError::Timeout { .. }));
    assert_eq!(error.code(), 124);
}

#[tokio::test]
async fn a_missing_binary_is_reported_without_panicking() {
    let runner = SpawnCommandRunner::new(false, None);
    let error = runner
        .run(
            "definitely-not-a-real-binary-xyz",
            &[],
            RunOptions::default(),
        )
        .await
        .expect_err("missing");
    assert!(matches!(error, CommandError::Io(_)));
    assert!(error.to_string().contains("could not start"));
}

//! Every external command goes through this interface. Port of
//! `deploy/backup-daemon/src/commandRunner.ts`.
//!
//! Arguments are passed as an argv array, so there is no shell involved and no opportunity for
//! interpolation or injection. Secrets only ever travel in the child's environment and are never
//! recorded: a dry run records the environment KEY names, exactly like the TS runner.

use std::future::Future;
use std::pin::Pin;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use tokio::process::Command;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Debug, Clone, Default)]
pub struct RunOptions {
    pub env: Vec<(String, String)>,
    pub input: Option<Vec<u8>>,
    pub timeout_ms: Option<u64>,
}

impl RunOptions {
    #[must_use]
    pub fn with_env(mut self, env: Vec<(String, String)>) -> Self {
        self.env = env;
        self
    }

    #[must_use]
    pub fn with_input(mut self, input: Vec<u8>) -> Self {
        self.input = Some(input);
        self
    }

    #[must_use]
    pub fn with_timeout(mut self, timeout_ms: Option<u64>) -> Self {
        self.timeout_ms = timeout_ms;
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandResult {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DryRunRecord {
    pub command: String,
    pub args: Vec<String>,
    pub env_keys: Vec<String>,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommandError {
    Timeout {
        command: String,
        args: Vec<String>,
        timeout_ms: u64,
        stdout: String,
        stderr: String,
    },
    Io(String),
}

impl CommandError {
    #[must_use]
    pub fn code(&self) -> i32 {
        match self {
            Self::Timeout { .. } => 124,
            Self::Io(_) => 1,
        }
    }
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Timeout {
                command,
                timeout_ms,
                ..
            } => write!(
                formatter,
                "command timed out after {timeout_ms}ms: {command}"
            ),
            Self::Io(message) => write!(formatter, "{message}"),
        }
    }
}

impl std::error::Error for CommandError {}

pub trait CommandRunner: Send + Sync {
    fn run<'a>(
        &'a self,
        command: &'a str,
        args: &'a [String],
        options: RunOptions,
    ) -> BoxFuture<'a, Result<CommandResult, CommandError>>;
}

pub struct SpawnCommandRunner {
    dry_run: bool,
    default_timeout_ms: Option<u64>,
    base_env: Option<Vec<(String, String)>>,
    recorded: std::sync::Mutex<Vec<DryRunRecord>>,
}

impl SpawnCommandRunner {
    #[must_use]
    pub fn new(dry_run: bool, default_timeout_ms: Option<u64>) -> Self {
        Self {
            dry_run,
            default_timeout_ms,
            base_env: None,
            recorded: std::sync::Mutex::new(Vec::new()),
        }
    }

    #[must_use]
    pub fn with_base_env(mut self, base_env: Vec<(String, String)>) -> Self {
        self.base_env = Some(base_env);
        self
    }

    pub fn recorded(&self) -> Vec<DryRunRecord> {
        self.recorded
            .lock()
            .map(|entries| entries.clone())
            .unwrap_or_default()
    }
}

impl CommandRunner for SpawnCommandRunner {
    fn run<'a>(
        &'a self,
        command: &'a str,
        args: &'a [String],
        options: RunOptions,
    ) -> BoxFuture<'a, Result<CommandResult, CommandError>> {
        Box::pin(async move {
            let timeout_ms = options.timeout_ms.or(self.default_timeout_ms);
            if self.dry_run {
                let record = DryRunRecord {
                    command: command.to_owned(),
                    args: args.to_vec(),
                    env_keys: options.env.iter().map(|(key, _)| key.clone()).collect(),
                    timeout_ms,
                };
                if let Ok(mut recorded) = self.recorded.lock() {
                    recorded.push(record);
                }
                return Ok(CommandResult {
                    code: 0,
                    stdout: String::new(),
                    stderr: String::new(),
                });
            }

            let mut process = Command::new(command);
            process.args(args);
            if let Some(base) = &self.base_env {
                process.envs(base.iter().map(|(key, value)| (key, value)));
            }
            process.envs(options.env.iter().map(|(key, value)| (key, value)));
            process.stdout(Stdio::piped());
            process.stderr(Stdio::piped());
            process.stdin(if options.input.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            });
            process.kill_on_drop(true);

            let mut child = process
                .spawn()
                .map_err(|error| CommandError::Io(format!("{command} could not start: {error}")))?;
            if let Some(input) = options.input.clone() {
                if let Some(mut stdin) = child.stdin.take() {
                    tokio::spawn(async move {
                        let _ = stdin.write_all(&input).await;
                        let _ = stdin.shutdown().await;
                    });
                }
            }

            let wait = child.wait_with_output();
            let output = match timeout_ms {
                Some(limit) if limit > 0 => {
                    match tokio::time::timeout(Duration::from_millis(limit), wait).await {
                        Ok(result) => result.map_err(|error| {
                            CommandError::Io(format!("{command} failed: {error}"))
                        })?,
                        Err(_) => {
                            // `child` was moved into the dropped wait future and `kill_on_drop`
                            // terminates the process.
                            return Err(CommandError::Timeout {
                                command: command.to_owned(),
                                args: args.to_vec(),
                                timeout_ms: limit,
                                stdout: String::new(),
                                stderr: String::new(),
                            });
                        }
                    }
                }
                _ => wait
                    .await
                    .map_err(|error| CommandError::Io(format!("{command} failed: {error}")))?,
            };

            Ok(CommandResult {
                code: output
                    .status
                    .code()
                    .unwrap_or(if output.status.success() { 0 } else { 1 }),
                stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[tokio::test]
    async fn dry_run_records_without_spawning() {
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
        assert_eq!(recorded[0].command, "wal-g");
        assert_eq!(
            recorded[0].env_keys,
            vec!["WALG_S3_PREFIX", "AWS_SECRET_ACCESS_KEY"]
        );
    }

    #[tokio::test]
    async fn arguments_reach_the_child_without_a_shell() {
        let runner: Arc<dyn CommandRunner> = Arc::new(SpawnCommandRunner::new(false, None));
        let args = [
            "one two".to_owned(),
            "semi;colon".to_owned(),
            "$(not-a-substitution)".to_owned(),
        ];
        let result = runner
            .run(
                "printf",
                &[
                    "%s\\n".to_owned(),
                    args[0].clone(),
                    args[1].clone(),
                    args[2].clone(),
                ],
                RunOptions::default(),
            )
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
    async fn commands_that_exceed_their_timeout_are_killed() {
        let runner = SpawnCommandRunner::new(false, None);
        let error = runner
            .run(
                "sleep",
                &["5".to_owned()],
                RunOptions {
                    timeout_ms: Some(50),
                    ..RunOptions::default()
                },
            )
            .await
            .expect_err("timeout");
        assert!(matches!(error, CommandError::Timeout { .. }));
        assert_eq!(error.code(), 124);
    }
}

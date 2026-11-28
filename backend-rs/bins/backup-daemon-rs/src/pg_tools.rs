//! Pure builders for the PostgreSQL 18 client tools the native engine drives. Port of
//! `deploy/backup-daemon/src/pgTools.ts`.
//!
//! Passwords only ever travel in the child's environment (`PGPASSWORD`), never on the command line,
//! so they cannot show up in `ps` or in error text.

use std::path::{Path, PathBuf};

use crate::command_runner::{CommandResult, CommandRunner, RunOptions};
use crate::config::{audit_endpoint, replication_credentials, Config, PgEndpoint};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PgCluster {
    Core,
    Audit,
}

impl PgCluster {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Core => "core",
            Self::Audit => "audit",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ToolCommand {
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub timeout_ms: u64,
}

#[must_use]
pub fn pg_bin(config: &Config, tool: &str) -> String {
    Path::new(&config.pg_bin_dir)
        .join(tool)
        .to_string_lossy()
        .into_owned()
}

#[must_use]
pub fn connection_env(_config: &Config, password: &str, sslmode: &str) -> Vec<(String, String)> {
    let mut env = Vec::new();
    if !password.is_empty() {
        env.push(("PGPASSWORD".to_owned(), password.to_owned()));
    }
    env.push(("PGSSLMODE".to_owned(), sslmode.to_owned()));
    env.push(("PGCONNECT_TIMEOUT".to_owned(), "15".to_owned()));
    env.push(("PGAPPNAME".to_owned(), "pg-backup-daemon".to_owned()));
    env
}

/// The core cluster and (when dedicated) the audit cluster, as seen by the replication tools.
#[must_use]
pub fn replication_endpoint(config: &Config, cluster: PgCluster) -> PgEndpoint {
    let (user, password) = replication_credentials(config);
    if cluster == PgCluster::Audit {
        let audit = audit_endpoint(config);
        PgEndpoint {
            host: audit.host,
            port: audit.port,
            user,
            password,
        }
    } else {
        PgEndpoint {
            host: config.pg_primary_host.clone(),
            port: config.pg_primary_port,
            user,
            password,
        }
    }
}

#[must_use]
pub fn sql_endpoint(config: &Config, cluster: PgCluster) -> PgEndpoint {
    if cluster == PgCluster::Audit {
        audit_endpoint(config)
    } else {
        PgEndpoint {
            host: config.pg_primary_host.clone(),
            port: config.pg_primary_port,
            user: config.pg_primary_user.clone(),
            password: config.pg_primary_password.clone(),
        }
    }
}

fn base(
    config: &Config,
    tool: &str,
    endpoint: &PgEndpoint,
) -> (String, Vec<String>, Vec<(String, String)>, u64) {
    (
        pg_bin(config, tool),
        vec![
            "-h".to_owned(),
            endpoint.host.clone(),
            "-p".to_owned(),
            endpoint.port.to_string(),
            "-U".to_owned(),
            endpoint.user.clone(),
            "-w".to_owned(),
        ],
        connection_env(config, &endpoint.password, &config.pg_sslmode),
        config.command_timeout_ms,
    )
}

#[derive(Debug, Clone, Default)]
pub struct BaseBackupOptions {
    pub destination: PathBuf,
    pub label: String,
    /// Path to the previous backup's `backup_manifest` (PostgreSQL 17+ incremental backup).
    pub incremental_from: Option<PathBuf>,
}

#[must_use]
pub fn build_base_backup_command(
    config: &Config,
    cluster: PgCluster,
    options: &BaseBackupOptions,
) -> ToolCommand {
    let (command, connection, env, timeout_ms) = base(
        config,
        "pg_basebackup",
        &replication_endpoint(config, cluster),
    );
    let mut args = connection;
    args.extend([
        "-D".to_owned(),
        options.destination.to_string_lossy().into_owned(),
        "--format=tar".to_owned(),
        "--checkpoint=fast".to_owned(),
        "--manifest-checksums=SHA256".to_owned(),
        "--wal-method=stream".to_owned(),
        format!("--label={}", options.label),
        "--no-password".to_owned(),
    ]);
    if let Some(incremental_from) = &options.incremental_from {
        args.push(format!(
            "--incremental={}",
            incremental_from.to_string_lossy()
        ));
    }
    ToolCommand {
        command,
        args,
        env,
        timeout_ms,
    }
}

#[must_use]
pub fn build_verify_backup_command(config: &Config, backup_dir: &Path) -> ToolCommand {
    ToolCommand {
        command: pg_bin(config, "pg_verifybackup"),
        args: vec![
            "--format=tar".to_owned(),
            backup_dir.to_string_lossy().into_owned(),
        ],
        env: Vec::new(),
        timeout_ms: config.command_timeout_ms,
    }
}

#[must_use]
pub fn build_combine_backup_command(
    config: &Config,
    input_dirs: &[PathBuf],
    output_dir: &Path,
) -> ToolCommand {
    let mut args = vec!["-o".to_owned(), output_dir.to_string_lossy().into_owned()];
    args.extend(
        input_dirs
            .iter()
            .map(|path| path.to_string_lossy().into_owned()),
    );
    ToolCommand {
        command: pg_bin(config, "pg_combinebackup"),
        args,
        env: Vec::new(),
        timeout_ms: config.command_timeout_ms,
    }
}

#[must_use]
pub fn build_receive_wal_command(
    config: &Config,
    cluster: PgCluster,
    spool_dir: &Path,
    slot: &str,
) -> ToolCommand {
    let (command, connection, env, _) = base(
        config,
        "pg_receivewal",
        &replication_endpoint(config, cluster),
    );
    let mut args = connection;
    args.extend([
        "-D".to_owned(),
        spool_dir.to_string_lossy().into_owned(),
        format!("--slot={slot}"),
        // Flush WAL to disk as it arrives so the .partial file always reflects committed data.
        "--synchronous".to_owned(),
        "--status-interval=1".to_owned(),
        "--no-password".to_owned(),
    ]);
    ToolCommand {
        command,
        args,
        env,
        timeout_ms: 0,
    }
}

#[must_use]
pub fn build_create_slot_command(config: &Config, cluster: PgCluster, slot: &str) -> ToolCommand {
    let (command, connection, env, timeout_ms) = base(
        config,
        "pg_receivewal",
        &replication_endpoint(config, cluster),
    );
    let mut args = connection;
    args.extend([
        format!("--slot={slot}"),
        "--create-slot".to_owned(),
        "--if-not-exists".to_owned(),
        "--no-password".to_owned(),
    ]);
    ToolCommand {
        command,
        args,
        env,
        timeout_ms,
    }
}

#[must_use]
pub fn build_dump_command(
    config: &Config,
    cluster: PgCluster,
    database: &str,
    output_file: &Path,
) -> ToolCommand {
    let endpoint = sql_endpoint(config, cluster);
    ToolCommand {
        command: pg_bin(config, "pg_dump"),
        args: vec![
            "-h".to_owned(),
            endpoint.host.clone(),
            "-p".to_owned(),
            endpoint.port.to_string(),
            "-U".to_owned(),
            endpoint.user.clone(),
            "-w".to_owned(),
            "-d".to_owned(),
            database.to_owned(),
            "--format=custom".to_owned(),
            "--compress=zstd:6".to_owned(),
            "--no-password".to_owned(),
            "--file".to_owned(),
            output_file.to_string_lossy().into_owned(),
        ],
        env: connection_env(config, &endpoint.password, &config.pg_sslmode),
        timeout_ms: config.command_timeout_ms,
    }
}

#[must_use]
pub fn build_restore_list_command(config: &Config, dump_file: &Path) -> ToolCommand {
    ToolCommand {
        command: pg_bin(config, "pg_restore"),
        args: vec![
            "--list".to_owned(),
            dump_file.to_string_lossy().into_owned(),
        ],
        env: Vec::new(),
        timeout_ms: config.command_timeout_ms,
    }
}

#[derive(Debug, Clone)]
pub struct RestoreTarget {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub database: String,
}

#[must_use]
pub fn build_restore_dump_command(
    config: &Config,
    dump_file: &Path,
    target: &RestoreTarget,
) -> ToolCommand {
    ToolCommand {
        command: pg_bin(config, "pg_restore"),
        args: vec![
            "-h".to_owned(),
            target.host.clone(),
            "-p".to_owned(),
            target.port.to_string(),
            "-U".to_owned(),
            target.user.clone(),
            "-d".to_owned(),
            target.database.clone(),
            "--no-owner".to_owned(),
            "--no-privileges".to_owned(),
            "--exit-on-error".to_owned(),
            dump_file.to_string_lossy().into_owned(),
        ],
        env: vec![("PGSSLMODE".to_owned(), "prefer".to_owned())],
        timeout_ms: config.command_timeout_ms,
    }
}

/// Runs a built tool command and returns a redaction-friendly error on a non-zero exit.
pub async fn run_tool(
    runner: &dyn CommandRunner,
    command: &ToolCommand,
    label: &str,
) -> Result<CommandResult, String> {
    let result = runner
        .run(
            &command.command,
            &command.args,
            RunOptions {
                env: command.env.clone(),
                input: None,
                timeout_ms: if command.timeout_ms > 0 {
                    Some(command.timeout_ms)
                } else {
                    None
                },
            },
        )
        .await
        .map_err(|error| format!("{label} failed: {error}"))?;
    if result.code != 0 {
        let detail = if !result.stderr.trim().is_empty() {
            result.stderr.trim()
        } else if !result.stdout.trim().is_empty() {
            result.stdout.trim()
        } else {
            &format!("exit code {}", result.code)
        };
        return Err(format!(
            "{label} failed: {}",
            detail.chars().take(500).collect::<String>()
        ));
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pg_config::Env;

    fn config() -> Config {
        Config::from_env(
            &Env::default()
                .with_value("BACKUP_ENGINE_MODE", "pg-native")
                .with_value(
                    "BACKUP_ENCRYPTION_KEY_HEX",
                    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                ),
        )
        .expect("config")
    }

    #[test]
    fn base_backup_uses_the_pg18_incremental_flag_and_no_password_on_argv() {
        let command = build_base_backup_command(
            &config(),
            PgCluster::Core,
            &BaseBackupOptions {
                destination: PathBuf::from("/var/lib/pg-backup/staging/bkp_1"),
                label: "bkp_1".to_owned(),
                incremental_from: Some(PathBuf::from(
                    "/var/lib/pg-backup/manifests/backup_manifest",
                )),
            },
        );
        assert!(command.args.contains(&"--format=tar".to_owned()));
        assert!(command
            .args
            .contains(&"--incremental=/var/lib/pg-backup/manifests/backup_manifest".to_owned()));
        assert!(!command.args.iter().any(|arg| arg.contains("PGPASSWORD")));
    }
}

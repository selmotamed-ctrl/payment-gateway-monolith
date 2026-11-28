//! `wal-fetch` binary: `wal-fetch <target> <file> <dest>`.
//!
//! See [`fetch`] for the restore_command contract. This file only parses arguments, maps outcomes
//! to exit codes and writes diagnostics to stderr.

#![forbid(unsafe_code)]

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

mod fetch;

use std::path::PathBuf;

use clap::Parser;

use fetch::{parse_target, success_line, Target};

/// Fetch one WAL segment from the archive (PostgreSQL `restore_command`).
#[derive(Debug, Parser)]
#[command(
    name = "wal-fetch",
    version,
    about = "Fetch a WAL segment from the archive (restore_command compatible)"
)]
struct Cli {
    /// Archive target: a directory, a file:// URL, or s3://bucket/prefix.
    target: String,
    /// Segment file name (PostgreSQL %f).
    file: String,
    /// Destination path (PostgreSQL %p).
    dest: PathBuf,
    /// Suppress the SHA-256 success line (PostgreSQL ignores stdout either way).
    #[arg(long, short, env = "WAL_FETCH_QUIET")]
    quiet: bool,
}

fn main() -> std::process::ExitCode {
    let cli = Cli::parse();
    match parse_target(&cli.target) {
        Target::Local(directory) => match fetch::fetch_local(&directory, &cli.file, &cli.dest) {
            Ok(outcome) => {
                if !cli.quiet {
                    eprintln!("{}", success_line(&outcome));
                }
                std::process::ExitCode::from(fetch::EXIT_OK)
            }
            Err(error) => {
                eprintln!("wal-fetch: {error}");
                std::process::ExitCode::from(fetch::EXIT_FAILURE)
            }
        },
        Target::S3(url) => {
            eprintln!(
                "wal-fetch: S3_NOT_CONFIGURED: '{url}' needs the S3 client of the backup daemon; this build only fetches from a local repository"
            );
            std::process::ExitCode::from(fetch::EXIT_PRECONDITION)
        }
        Target::Unsupported(url) => {
            eprintln!(
                "wal-fetch: UNSUPPORTED_TARGET: '{url}' is not a local directory or s3:// URL"
            );
            std::process::ExitCode::from(fetch::EXIT_PRECONDITION)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cli_parses_the_postgres_contract() {
        let cli = Cli::try_parse_from([
            "wal-fetch",
            "/var/lib/pg-backup/repo/wal",
            "000000010000000000000001",
            "/var/lib/postgresql/18/main/pg_wal/000000010000000000000001",
        ])
        .expect("parses");
        assert_eq!(cli.file, "000000010000000000000001");
        assert!(!cli.quiet);
        let cli =
            Cli::try_parse_from(["wal-fetch", "-q", "file:///wal", "x", "y"]).expect("parses");
        assert!(cli.quiet);
    }
}

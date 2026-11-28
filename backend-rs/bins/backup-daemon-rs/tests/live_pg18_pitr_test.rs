//! Optional live PostgreSQL 18 drill. Ignored by default; enable with
//! `BACKUP_LIVE_PG_TEST=1 cargo test -p backup-daemon-rs --test live_pg18_pitr_test -- --ignored`.
//!
//! It starts its own scratch cluster on a free port under a temp directory and never touches the
//! development/test database on 127.0.0.1:55432.

mod common;

use std::sync::Arc;

use backup_daemon::command_runner::{CommandRunner, RunOptions, SpawnCommandRunner};

fn pg_bin(tool: &str) -> String {
    std::env::var("PG_BIN_DIR").unwrap_or_else(|_| "/usr/lib/postgresql/18/bin".to_owned())
        + "/"
        + tool
}

#[tokio::test]
#[ignore = "requires PostgreSQL 18 client/server binaries and BACKUP_LIVE_PG_TEST=1"]
async fn a_scratch_cluster_starts_queries_and_stops_without_touching_any_existing_cluster() {
    if std::env::var("BACKUP_LIVE_PG_TEST").as_deref() != Ok("1") {
        return;
    }
    let directory = tempfile::tempdir().expect("tempdir");
    let data = directory.path().join("data");
    let runner: Arc<dyn CommandRunner> = Arc::new(SpawnCommandRunner::new(false, Some(60_000)));
    let initdb = runner
        .run(
            &pg_bin("initdb"),
            &[
                "-D".to_owned(),
                data.to_string_lossy().into_owned(),
                "-U".to_owned(),
                "postgres".to_owned(),
                "--auth=trust".to_owned(),
                "--no-locale".to_owned(),
                "-E".to_owned(),
                "UTF8".to_owned(),
            ],
            RunOptions::default(),
        )
        .await
        .expect("initdb");
    assert_eq!(initdb.code, 0, "{}", initdb.stderr);
    let port = common::free_port();
    let start = runner
        .run(
            &pg_bin("pg_ctl"),
            &[
                "-D".to_owned(),
                data.to_string_lossy().into_owned(),
                "-l".to_owned(),
                data.join("postgresql.log").to_string_lossy().into_owned(),
                "-o".to_owned(),
                format!(
                    "-p {port} -c listen_addresses=127.0.0.1 -c unix_socket_directories={}",
                    data.to_string_lossy()
                ),
                "-w".to_owned(),
                "start".to_owned(),
            ],
            RunOptions::default(),
        )
        .await
        .expect("pg_ctl start");
    assert_eq!(start.code, 0, "{}", start.stderr);
    let query = runner
        .run(
            &pg_bin("psql"),
            &[
                "-h".to_owned(),
                "127.0.0.1".to_owned(),
                "-p".to_owned(),
                port.to_string(),
                "-U".to_owned(),
                "postgres".to_owned(),
                "-d".to_owned(),
                "postgres".to_owned(),
                "-X".to_owned(),
                "-A".to_owned(),
                "-t".to_owned(),
                "-c".to_owned(),
                "SELECT 1;".to_owned(),
            ],
            RunOptions::default(),
        )
        .await
        .expect("psql");
    assert_eq!(query.stdout.trim(), "1");
    let stop = runner
        .run(
            &pg_bin("pg_ctl"),
            &[
                "-D".to_owned(),
                data.to_string_lossy().into_owned(),
                "-m".to_owned(),
                "fast".to_owned(),
                "-w".to_owned(),
                "stop".to_owned(),
            ],
            RunOptions::default(),
        )
        .await
        .expect("pg_ctl stop");
    assert_eq!(stop.code, 0, "{}", stop.stderr);
}

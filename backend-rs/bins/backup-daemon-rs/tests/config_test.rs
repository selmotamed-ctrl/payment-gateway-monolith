//! Port of `deploy/backup-daemon/test/config.test.ts`.

mod common;

use backup_daemon::config::{
    audit_endpoint, cluster_topology, is_audit_configured, is_audit_dedicated_cluster,
    is_log_db_configured, is_valid_cron, redact_secrets, redact_sensitive_data, redact_text,
    replication_credentials, Config,
};
use common::{make_config, ENCRYPTION_KEY_HEX, PG_PASSWORD, S3_ACCESS_KEY, S3_SECRET_KEY};
use serde_json::json;

#[test]
fn applies_production_safe_defaults() {
    let config = make_config(&[]);
    assert_eq!(config.engine_mode, "wal-g");
    assert_eq!(config.compression, "zstd");
    assert_eq!(config.daemon_port, 4090);
    assert_eq!(config.bind_host, "127.0.0.1");
    assert_eq!(config.scratch_port, 55432);
    assert_eq!(config.full_cron, "0 2 * * 0");
    assert_eq!(config.delta_cron, "0 2 * * 1-6");
    assert_eq!(config.drill_cron, "0 4 * * 0");
    assert_eq!(config.retention_full_count, 8);
    assert_eq!(config.retention_wal_days, 14);
    assert_eq!(config.walg_bin, "wal-g");
    assert_eq!(config.barman_bin, "barman");
    assert_eq!(config.pg_bin_dir, "/usr/lib/postgresql/18/bin");
    assert_eq!(config.catalog_path, "/var/lib/pg-backup/catalog.json");
    assert_eq!(config.scratch_dir, "/var/lib/pg-backup/scratch");
    assert_eq!(config.scratch_audit_dir, "/var/lib/pg-backup/scratch/audit");
    assert_eq!(config.scratch_audit_port, 55433);
    assert_eq!(
        config.core_s3_prefix,
        "s3://libya-pg-backups-primary/prod/postgres_core"
    );
    assert_eq!(
        config.audit_s3_prefix,
        "s3://libya-pg-backups-primary/prod/audit_db"
    );
    assert_eq!(config.barman_audit_server, config.pg_audit_db_name);
    assert!(config.scheduler_enabled);
    assert_eq!(config.scheduler_tick_ms, 30_000);
    assert!(!config.allow_insecure_http);
}

#[test]
fn allows_explicit_prefixes_audit_scratch_and_scheduler_overrides() {
    let config = make_config(&[
        ("BACKUP_CORE_S3_PREFIX", "s3://custom/core"),
        ("BACKUP_AUDIT_S3_PREFIX", "s3://custom/audit"),
        ("BACKUP_SCRATCH_AUDIT_DIR", "/tmp/audit-drill"),
        ("BACKUP_SCRATCH_AUDIT_PORT", "55999"),
        ("BARMAN_AUDIT_SERVER", "audit-barman"),
        ("SCHEDULER_ENABLED", "no"),
        ("SCHEDULER_TICK_MS", "5000"),
    ]);
    assert_eq!(config.core_s3_prefix, "s3://custom/core");
    assert_eq!(config.audit_s3_prefix, "s3://custom/audit");
    assert_eq!(config.scratch_audit_dir, "/tmp/audit-drill");
    assert_eq!(config.scratch_audit_port, 55999);
    assert_eq!(config.barman_audit_server, "audit-barman");
    assert!(!config.scheduler_enabled);
    assert_eq!(config.scheduler_tick_ms, 5000);
}

#[test]
fn accepts_barman_mode_and_environment_overrides() {
    let config = make_config(&[
        ("BACKUP_ENGINE_MODE", "barman"),
        ("BACKUP_COMPRESSION", "lz4"),
        ("BACKUP_DAEMON_PORT", "4190"),
        ("BACKUP_ALLOW_INSECURE_HTTP", "yes"),
        (
            "BACKUP_SECONDARY_SSH_TARGET",
            "vault@198.51.100.99:/mnt/offsite",
        ),
    ]);
    assert_eq!(config.engine_mode, "barman");
    assert_eq!(config.compression, "lz4");
    assert_eq!(config.daemon_port, 4190);
    assert!(config.allow_insecure_http);
    assert_eq!(
        config.secondary_ssh_target.as_deref(),
        Some("vault@198.51.100.99:/mnt/offsite")
    );
}

#[test]
fn rejects_unknown_engines_malformed_keys_bad_cron_and_one_sided_s3_credentials() {
    for overrides in [
        vec![("BACKUP_ENGINE_MODE", "pg_basebackup")],
        vec![("BACKUP_ENCRYPTION_KEY_HEX", "not-hex")],
        vec![("BACKUP_ENCRYPTION_KEY_HEX", "abababababababab")],
        vec![("BACKUP_FULL_CRON", "every sunday")],
        vec![("BACKUP_PRIMARY_S3_SECRET_KEY", "")],
        vec![("BACKUP_DAEMON_CERT_PATH", "/tmp/server.crt")],
    ] {
        let mut env = common::base_env();
        for (key, value) in overrides {
            env = env.with_value(key, value);
        }
        assert!(Config::from_env(&env).is_err());
    }
}

#[test]
fn validates_cron_expressions_used_by_the_schedule() {
    assert!(is_valid_cron("0 2 * * 0"));
    assert!(is_valid_cron("*/5 0-6 1,15 * 1-5"));
    assert!(!is_valid_cron("0 2 * *"));
    assert!(!is_valid_cron("0 2 * * sunday"));
}

#[test]
fn exports_the_same_result_from_load_and_validate() {
    let env = common::base_env();
    let left = Config::from_env(&env).expect("valid");
    let right = Config::from_env(&env).expect("valid");
    assert_eq!(left.engine_mode, right.engine_mode);
    assert_eq!(left.catalog_path, right.catalog_path);
    assert_eq!(left.local_repo_dir, right.local_repo_dir);
    assert_eq!(ENCRYPTION_KEY_HEX.len(), 64);
}

#[test]
fn redacts_credentials_from_objects_and_free_text() {
    let config = make_config(&[]);
    let redacted = redact_secrets(&json!({
        "BACKUP_ENCRYPTION_KEY_HEX": config.encryption_key_hex,
        "BACKUP_PRIMARY_S3_ACCESS_KEY": config.primary_s3_access_key,
        "BACKUP_PRIMARY_S3_SECRET_KEY": config.primary_s3_secret_key,
        "PG_PRIMARY_PASSWORD": config.pg_primary_password,
        "BACKUP_PRIMARY_S3_BUCKET": config.primary_s3_bucket,
    }));
    assert_eq!(redacted["BACKUP_ENCRYPTION_KEY_HEX"], "[REDACTED]");
    assert_eq!(redacted["BACKUP_PRIMARY_S3_ACCESS_KEY"], "[REDACTED]");
    assert_eq!(redacted["BACKUP_PRIMARY_S3_SECRET_KEY"], "[REDACTED]");
    assert_eq!(redacted["PG_PRIMARY_PASSWORD"], "[REDACTED]");
    assert_eq!(
        redacted["BACKUP_PRIMARY_S3_BUCKET"],
        config.primary_s3_bucket
    );

    let secrets = config.secret_values();
    assert!(secrets.contains(&PG_PASSWORD.to_owned()));
    assert!(secrets.contains(&S3_ACCESS_KEY.to_owned()));
    assert!(secrets.contains(&S3_SECRET_KEY.to_owned()));
    assert!(!redact_text(&format!("password={PG_PASSWORD}"), &secrets).contains(PG_PASSWORD));
    assert!(!redact_text(&format!("token: {S3_SECRET_KEY}"), &secrets).contains(S3_SECRET_KEY));
    assert_eq!(
        redact_sensitive_data(&json!({"nested": {"secret": "abc", "keep": "yes"}}), &[]),
        json!({"nested": {"secret": "[REDACTED]", "keep": "yes"}})
    );
}

#[test]
fn pg_native_boots_with_a_local_repository_only() {
    let config = make_config(&[
        ("BACKUP_ENGINE_MODE", "pg-native"),
        ("BACKUP_PRIMARY_S3_ENDPOINT", ""),
        ("BACKUP_PRIMARY_S3_BUCKET", ""),
        ("BACKUP_PRIMARY_S3_ACCESS_KEY", ""),
        ("BACKUP_PRIMARY_S3_SECRET_KEY", ""),
    ]);
    assert_eq!(config.local_repo_dir, "/var/lib/pg-backup/repo");
    assert_eq!(config.primary_s3_endpoint, "");
    assert_eq!(config.core_s3_prefix, "");
}

#[test]
fn wal_g_and_barman_still_require_an_s3_endpoint_and_bucket() {
    for mode in ["wal-g", "barman"] {
        let mut env = common::base_env()
            .with_value("BACKUP_ENGINE_MODE", mode)
            .with_value("BACKUP_PRIMARY_S3_ENDPOINT", "")
            .with_value("BACKUP_PRIMARY_S3_BUCKET", "");
        env = env.with_value("BACKUP_PRIMARY_S3_ACCESS_KEY", "");
        env = env.with_value("BACKUP_PRIMARY_S3_SECRET_KEY", "");
        assert!(Config::from_env(&env)
            .expect_err("s3 required")
            .to_string()
            .contains("BACKUP_PRIMARY_S3_"));
    }
    assert_eq!(
        make_config(&[("BACKUP_ENGINE_MODE", "wal-g")]).local_repo_dir,
        ""
    );
}

#[test]
fn an_endpoint_without_a_bucket_is_rejected() {
    let env = common::base_env()
        .with_value("BACKUP_ENGINE_MODE", "pg-native")
        .with_value("BACKUP_PRIMARY_S3_BUCKET", "");
    assert!(Config::from_env(&env)
        .expect_err("pair required")
        .to_string()
        .contains("provided together"));
}

#[test]
fn the_wal_stream_alert_threshold_defaults_to_256_mib() {
    let config = make_config(&[("BACKUP_ENGINE_MODE", "pg-native")]);
    assert_eq!(config.stream_alert_bytes, 256 * 1024 * 1024);
    assert_eq!(
        make_config(&[
            ("BACKUP_ENGINE_MODE", "pg-native"),
            ("BACKUP_STREAM_ALERT_BYTES", "1048576"),
        ])
        .stream_alert_bytes,
        1_048_576
    );
}

#[test]
fn wal_and_control_client_allow_lists_are_separate() {
    let config = make_config(&[("BACKUP_ENGINE_MODE", "pg-native")]);
    assert_eq!(config.wal_client_cns, "wal-archive-client");
    assert_eq!(config.allowed_client_cns, "backup-client");
    assert_eq!(config.wal_push_max_bytes, 64 * 1024 * 1024);
}

#[test]
fn replication_and_audit_passwords_are_secrets() {
    let config = make_config(&[
        ("BACKUP_ENGINE_MODE", "pg-native"),
        ("PG_REPLICATION_PASSWORD", "repl-secret-pw"),
        ("PG_AUDIT_PASSWORD", "audit-secret-pw"),
    ]);
    let secrets = config.secret_values();
    assert!(secrets.contains(&"repl-secret-pw".to_owned()));
    assert!(secrets.contains(&"audit-secret-pw".to_owned()));
}

#[test]
fn cluster_topology_helpers_match_the_ts_rules() {
    let config = make_config(&[]);
    assert_eq!(config.pg_audit_port, 5434);
    assert_eq!(config.pg_primary_port, 5432);
    assert!(!is_audit_dedicated_cluster(&config));
    assert_eq!(cluster_topology(&config), "shared-audit");
    assert!(is_audit_configured(&config));
    assert!(!is_log_db_configured(&config));

    assert!(is_audit_dedicated_cluster(&make_config(&[(
        "PG_AUDIT_DATA_DIR",
        "/var/lib/postgresql/18/audit"
    )])));
    assert!(is_audit_dedicated_cluster(&make_config(&[
        ("PG_PRIMARY_HOST", "10.0.0.5"),
        ("PG_AUDIT_HOST", "10.0.0.6"),
    ])));
    assert!(!is_audit_dedicated_cluster(&make_config(&[
        ("PG_PRIMARY_HOST", "10.0.0.5"),
        ("PG_AUDIT_HOST", "10.0.0.5"),
    ])));
    assert!(is_log_db_configured(&make_config(&[(
        "PG_LOG_DB_NAME",
        "pg_log_db"
    )])));
}

#[test]
fn audit_endpoint_and_replication_credentials_fall_back_sensibly() {
    let shared = audit_endpoint(&make_config(&[("PG_PRIMARY_HOST", "10.0.0.5")]));
    assert_eq!(shared.host, "10.0.0.5");
    assert_eq!(shared.port, 5432);
    assert_eq!(shared.user, "postgres");

    let dedicated = audit_endpoint(&make_config(&[
        ("PG_PRIMARY_HOST", "10.0.0.5"),
        ("PG_AUDIT_HOST", "10.0.0.6"),
        ("PG_AUDIT_PORT", "5434"),
        ("PG_AUDIT_USER", "audit_app"),
        ("PG_AUDIT_PASSWORD", "ap"),
    ]));
    assert_eq!(dedicated.host, "10.0.0.6");
    assert_eq!(dedicated.port, 5434);
    assert_eq!(dedicated.user, "audit_app");
    assert_eq!(dedicated.password, "ap");
    assert_eq!(
        audit_endpoint(&make_config(&[
            ("PG_PRIMARY_HOST", "10.0.0.5"),
            ("PG_AUDIT_HOST", "10.0.0.6"),
        ]))
        .password,
        PG_PASSWORD
    );

    assert_eq!(
        replication_credentials(&make_config(&[])),
        ("postgres".to_owned(), PG_PASSWORD.to_owned())
    );
    assert_eq!(
        replication_credentials(&make_config(&[
            ("PG_REPLICATION_USER", "repl"),
            ("PG_REPLICATION_PASSWORD", "rp"),
        ])),
        ("repl".to_owned(), "rp".to_owned())
    );
}

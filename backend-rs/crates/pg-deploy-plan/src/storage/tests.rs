//! Cross-cutting D5 tests: determinism, fresh/update/replica/TLS plans, invalid input and the
//! security assertions the deploy engine must never regress.

use pg_deploy_config::{DatabaseMode, Environment, Host, PgctlConfig, Role};

use super::*;

fn host(name: &str, address: &str, roles: &[Role]) -> Host {
    Host {
        name: name.to_owned(),
        address: address.to_owned(),
        private_ip: address.to_owned(),
        roles: roles.to_vec(),
        ..Host::default()
    }
}

fn config() -> PgctlConfig {
    let mut config = PgctlConfig::new(Environment::Test);
    config.database.mode = DatabaseMode::Managed;
    config.database.host = Some("10.0.0.21".to_owned());
    config.database.name = "payment_gateway_prod".to_owned();
    config.database.owner_role = "gw_core_user".to_owned();
    config.database.app_role = "pgw_app_login".to_owned();
    config.database.replication_role = "gw_replicator".to_owned();
    config.database.owner_password = Some("secret:pg_db_password".to_owned());
    config.database.app_password = Some("secret:pg_app_password".to_owned());
    config.database.replication_password = Some("secret:pg_replication_password".to_owned());
    config.database.pgbouncer = true;
    config.database.tls = true;
    config.redis.enabled = true;
    config.redis.tls = true;
    config.redis.password = Some("secret:redis_password".to_owned());
    config.hosts = vec![
        host(
            "db-1",
            "10.0.0.21",
            &[Role::PgPrimary, Role::Pgbouncer, Role::AuditDb, Role::LogDb],
        ),
        host("db-2", "10.0.0.22", &[Role::PgReplica]),
        host("core-1", "10.0.0.11", &[Role::Core]),
        host("redis-1", "10.0.0.40", &[Role::Redis]),
        host("backup-1", "10.0.0.50", &[Role::Backup]),
    ];
    config
}

fn overrides() -> StorageOverrides {
    let mut overrides = StorageOverrides::default();
    overrides.postgres.ram_gb = Some(16);
    overrides.audit.owner_password = Some("secret:pgw_owner_password".to_owned());
    overrides.audit.writer_password = Some("secret:audit_writer_password".to_owned());
    overrides.log.owner_password = Some("secret:pgw_owner_password".to_owned());
    overrides.log.writer_password = Some("secret:log_writer_password".to_owned());
    overrides.redis.core_password = Some("secret:redis_core_password".to_owned());
    overrides.redis.worker_password = Some("secret:redis_worker_password".to_owned());
    overrides.redis.backup_password = Some("secret:redis_backup_password".to_owned());
    overrides
}

fn plans(mode: ProvisionMode) -> Vec<ProvisionPlan> {
    plan_all_storage(&config(), &overrides(), mode)
}

#[test]
fn every_target_is_deterministic_for_the_same_input() {
    for target in ProvisionTarget::ALL {
        let one = plan_storage(&config(), &overrides(), target, ProvisionMode::Fresh);
        let two = plan_storage(&config(), &overrides(), target, ProvisionMode::Fresh);
        assert_eq!(one, two, "{target} is not deterministic");
        assert_eq!(one.fingerprint, two.fingerprint);
        assert_eq!(one.schema, PROVISION_PLAN_SCHEMA);
        assert_eq!(one.to_json_pretty(), two.to_json_pretty());
        assert!(!one.fingerprint.is_empty());
    }
}

#[test]
fn fresh_update_and_replica_plans_differ_as_designed() {
    let fresh = plan_storage(
        &config(),
        &overrides(),
        ProvisionTarget::Postgres,
        ProvisionMode::Fresh,
    );
    let update = plan_storage(
        &config(),
        &overrides(),
        ProvisionTarget::Postgres,
        ProvisionMode::Update,
    );
    assert_ne!(fresh.fingerprint, update.fingerprint);
    let fresh_ids: Vec<&str> = fresh.hosts[0]
        .steps
        .iter()
        .map(|step| step.id.as_str())
        .collect();
    assert!(fresh_ids.contains(&"pgdg-repository"));
    assert!(fresh_ids.contains(&"create-cluster"));
    let update_ids: Vec<&str> = update.hosts[0]
        .steps
        .iter()
        .map(|step| step.id.as_str())
        .collect();
    assert!(!update_ids.contains(&"pgdg-repository"));
    assert!(!update_ids.contains(&"create-cluster"));
    assert!(update_ids.contains(&"detect-cluster"));
    assert_eq!(fresh.hosts[0].role, "primary");
    assert_eq!(fresh.hosts[1].role, "replica:db-2");
    assert!(fresh.hosts[1]
        .steps
        .iter()
        .any(|step| step.id == "pg-basebackup"));
}

#[test]
fn tls_plan_has_cert_paths_and_hostssl_only_hba() {
    let plan = plan_storage(
        &config(),
        &overrides(),
        ProvisionTarget::Postgres,
        ProvisionMode::Update,
    );
    let text = plan.to_json_pretty();
    assert!(text.contains("/etc/postgresql/18/main/tls/server.crt"));
    assert!(text.contains("/etc/postgresql/18/main/tls/server.key"));
    assert!(text.contains("ssl_ca_file"));
    assert!(text.contains("ssl_crl_file"));
    assert!(text.contains("hostssl"));
    assert!(!text.contains("host all"));
    assert!(!text.contains("host     all"));
    assert!(text.contains("clientcert=verify-ca"));
    let pgbouncer = plan_storage(
        &config(),
        &overrides(),
        ProvisionTarget::Pgbouncer,
        ProvisionMode::Update,
    );
    let text = pgbouncer.to_json_pretty();
    assert!(text.contains("server_tls_sslmode = verify-full"));
    assert!(text.contains("client_tls_sslmode = verify-full"));
    assert!(text.contains("client_tls_ca_file"));
}

#[test]
fn plans_never_contain_a_secret_value() {
    let config = config();
    let text = serde_json::to_string(&plans(ProvisionMode::Update)).unwrap_or_default();
    // The plan only ever carries names, never the `secret:<name>` reference (let alone a value).
    assert!(!text.contains("\"secret:pg_db_password\""));
    assert!(!text.contains("\"secret:pg_app_password\""));
    assert!(!text.contains("\"secret:pg_replication_password\""));
    assert!(!text.contains("\"secret:redis_core_password\""));
    assert!(!text.contains("hunter2"));
    // Secrets that a rendered file needs are named for the executor.
    assert!(text.contains("pg_db_password"));
    assert!(text.contains("\"sensitive\":true"));
    let _ = config;
}

#[test]
fn invalid_ram_roles_ports_and_memory_block_the_plan() {
    let config = config();
    let mut invalid = overrides();
    invalid.postgres.ram_gb = Some(5000);
    invalid.postgres.roles = Some(PgRoles {
        owner: "pg_owner".to_owned(),
        app: "postgres".to_owned(),
        app_group: "pgw_app".to_owned(),
        replication: "gw_replicator".to_owned(),
    });
    invalid.pgbouncer.port = Some(5432);
    invalid.redis.port = Some(5432);
    invalid.redis.maxmemory = Some("lots".to_owned());
    invalid.clamav.mode = Some(ClamavMode::Managed);
    invalid.clamav.address = Some("0.0.0.0:3310".to_owned());
    let plan = plan_storage(
        &config,
        &invalid,
        ProvisionTarget::Postgres,
        ProvisionMode::Update,
    );
    let codes: Vec<&str> = plan
        .findings
        .iter()
        .map(|finding| finding.code.as_str())
        .collect();
    assert!(codes.contains(&codes::POSTGRES_RAM), "{codes:?}");
    assert!(codes.contains(&codes::POSTGRES_ROLE), "{codes:?}");
    assert!(codes.contains(&codes::PORT_COLLISION), "{codes:?}");
    let plan = plan_storage(
        &config,
        &invalid,
        ProvisionTarget::Redis,
        ProvisionMode::Update,
    );
    let codes: Vec<&str> = plan
        .findings
        .iter()
        .map(|finding| finding.code.as_str())
        .collect();
    assert!(codes.contains(&codes::REDIS_MAXMEMORY), "{codes:?}");
    assert!(codes.contains(&codes::PORT_COLLISION), "{codes:?}");
    let plan = plan_storage(
        &config,
        &invalid,
        ProvisionTarget::Clamav,
        ProvisionMode::Update,
    );
    let codes: Vec<&str> = plan
        .findings
        .iter()
        .map(|finding| finding.code.as_str())
        .collect();
    assert!(codes.contains(&codes::CLAMAV_BIND), "{codes:?}");
}

#[test]
fn a_literal_password_is_rejected_and_never_rendered() {
    let mut config = config();
    config.database.owner_password = Some("hunter2".to_owned());
    let plan = plan_storage(
        &config,
        &overrides(),
        ProvisionTarget::Postgres,
        ProvisionMode::Update,
    );
    assert!(plan
        .findings
        .iter()
        .any(|finding| finding.code == codes::POSTGRES_SECRET_MISSING));
    let text = plan.to_json_pretty();
    assert!(!text.contains("hunter2"));
}

#[test]
fn redis_plan_is_tls_only_and_audit_is_append_only() {
    let all = plans(ProvisionMode::Update);
    let redis = all
        .iter()
        .find(|plan| plan.target == ProvisionTarget::Redis)
        .map(ProvisionPlan::to_json_pretty)
        .unwrap_or_default();
    assert!(redis.contains("port 0"));
    assert!(redis.contains("tls-port 6379"));
    assert!(redis.contains("appendonly yes"));
    assert!(redis.contains("volatile-ttl"));
    assert!(redis.contains("user default off"));
    let audit = all
        .iter()
        .find(|plan| plan.target == ProvisionTarget::AuditLog)
        .map(ProvisionPlan::to_json_pretty)
        .unwrap_or_default();
    assert!(audit.contains("forbid_audit_mutation"));
    assert!(audit.contains("trg_audit_immutable"));
    assert!(audit.contains("has_table_privilege"));
}

#[test]
fn a_plan_with_an_inline_credential_is_redacted_on_output() {
    let mut plan = ProvisionPlan {
        target: ProvisionTarget::Redis,
        ..ProvisionPlan::default()
    };
    plan.hosts.push(ProvisionHost {
        id: "redis-1".to_owned(),
        address: "10.0.0.40".to_owned(),
        role: "redis".to_owned(),
        service: "pg-redis".to_owned(),
        port: 6379,
        cluster: None,
        steps: vec![ProvisionStep {
            id: "bad".to_owned(),
            description: "hand-built step".to_owned(),
            kind: StepKind::ConfigFile,
            sensitive: true,
            restart: RestartPolicy::None,
            idempotency_check: "sha256:bad".to_owned(),
            apply: StepApply::WriteFile(FileSpec {
                path: "/etc/pg-redis/redis.conf".to_owned(),
                mode: 0o640,
                owner: "root".to_owned(),
                group: "root".to_owned(),
                content: "requirepass hunter2\n".to_owned(),
                secret_refs: Vec::new(),
            }),
        }],
    });
    plan.fingerprint = fingerprint_of(&plan);
    let text = plan.to_json_pretty();
    assert!(!text.contains("hunter2"));
    assert!(text.contains("{{redacted}}"));
}

#[test]
fn storage_overlays_resolve_and_keep_defaults() {
    let config = config();
    let mut overrides = overrides();
    overrides.postgres.io_method = Some(IoMethod::IoUring);
    overrides.postgres.max_connections = Some(600);
    overrides.postgres.client_cert = Some(ClientCertMode::Off);
    overrides.pgbouncer.default_pool_size = Some(80);
    overrides.redis.engine = Some(RedisEngine::Valkey);
    overrides.redis.maxmemory = Some("8gb".to_owned());
    overrides.clamav.mode = Some(ClamavMode::Disabled);
    let settings = StorageSettings::resolve(&config, &overrides);
    assert_eq!(settings.postgres.ram_gb, Some(16));
    assert_eq!(settings.postgres.io_method, IoMethod::IoUring);
    assert_eq!(settings.postgres.max_connections, 600);
    assert_eq!(settings.postgres.client_cert, ClientCertMode::Off);
    assert_eq!(settings.pgbouncer.default_pool_size, 80);
    assert_eq!(settings.redis.engine, RedisEngine::Valkey);
    assert_eq!(settings.redis.maxmemory, "8gb");
    // Defaults the overlay does not mention stay at the TS value.
    assert_eq!(settings.postgres.work_mem_mb, 32);
    assert_eq!(settings.postgres.max_slot_wal_keep_size, "64GB");
    assert_eq!(settings.redis.maxmemory_policy, "volatile-ttl");
}

#[test]
fn a_toml_document_with_storage_sections_loads() {
    let document = r#"
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
ram_gb = 24
io_method = "io_uring"
[storage.redis]
engine = "valkey"
acl = true
[storage.clamav]
mode = "managed"
stream_max_mb = 48
"#;
    let loaded = parse_storage_document(document).expect("document parses");
    assert_eq!(loaded.overrides.postgres.ram_gb, Some(24));
    assert_eq!(loaded.overrides.postgres.io_method, Some(IoMethod::IoUring));
    assert_eq!(loaded.overrides.redis.engine, Some(RedisEngine::Valkey));
    assert_eq!(loaded.overrides.clamav.mode, Some(ClamavMode::Managed));
    assert_eq!(loaded.config.hosts.len(), 1);
    assert_eq!(loaded.config.database.mode, DatabaseMode::Managed);
}

#[test]
fn top_level_aliases_are_accepted_and_duplicates_are_refused() {
    let alias = r#"
version = 1
[deployment]
environment = "test"
[postgres]
ram_gb = 8
[pgbouncer]
max_client_conn = 900
"#;
    let loaded = parse_storage_document(alias).expect("alias parses");
    assert_eq!(loaded.overrides.postgres.ram_gb, Some(8));
    assert_eq!(loaded.overrides.pgbouncer.max_client_conn, Some(900));

    let duplicate = r#"
version = 1
[deployment]
environment = "test"
[postgres]
ram_gb = 8
[storage.postgres]
ram_gb = 16
"#;
    let error = parse_storage_document(duplicate).expect_err("duplicate section");
    assert!(matches!(
        error,
        StorageConfigError::DuplicateSection { ref section } if section == "postgres"
    ));
}

#[test]
fn the_plan_shape_is_stable_for_consumers() {
    let plan = plan_storage(
        &config(),
        &overrides(),
        ProvisionTarget::Postgres,
        ProvisionMode::Fresh,
    );
    let value = plan.to_json_value();
    assert_eq!(value["schema"], PROVISION_PLAN_SCHEMA);
    assert_eq!(value["target"], "postgres");
    assert_eq!(value["mode"], "fresh");
    assert!(value["hosts"].is_array());
    assert!(value["findings"].is_array());
    assert!(value["fingerprint"].is_string());
    let step = &value["hosts"][0]["steps"][0];
    assert!(step["id"].is_string());
    assert!(step["kind"].is_string());
    assert!(step["idempotency_check"].is_string());
    assert!(step["apply"]["kind"].is_string());
}

#[test]
fn step_checks_are_content_hashes_so_a_converged_host_is_a_no_op() {
    let plan = plan_storage(
        &config(),
        &overrides(),
        ProvisionTarget::Postgres,
        ProvisionMode::Update,
    );
    let files: Vec<&ProvisionStep> = plan.hosts[0]
        .steps
        .iter()
        .filter(|step| matches!(step.apply, StepApply::WriteFile(_)))
        .collect();
    assert!(!files.is_empty());
    for step in files {
        assert!(
            step.idempotency_check.starts_with("sha256:"),
            "{} is not content-addressed",
            step.id
        );
    }
    let again = plan_storage(
        &config(),
        &overrides(),
        ProvisionTarget::Postgres,
        ProvisionMode::Update,
    );
    let again_files: Vec<&str> = again.hosts[0]
        .steps
        .iter()
        .filter(|step| matches!(step.apply, StepApply::WriteFile(_)))
        .map(|step| step.idempotency_check.as_str())
        .collect();
    let first: Vec<&str> = plan.hosts[0]
        .steps
        .iter()
        .filter(|step| matches!(step.apply, StepApply::WriteFile(_)))
        .map(|step| step.idempotency_check.as_str())
        .collect();
    assert_eq!(first, again_files);
}

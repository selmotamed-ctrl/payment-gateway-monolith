//! PgBouncer provisioner plan (D5-T02, S-DB-11, S-DB-12).
//!
//! Port of `pgbouncerIni`, `pgbouncerUserlist`, `pgbouncerTlsCommand`, `applyPgbouncer` and the
//! TS PgBouncer unit drop-in. Differences: an internal-CA certificate replaces the per-host
//! self-signed one, the auth file holds SCRAM verifiers instead of plaintext passwords, and a full
//! pgctl-owned unit overrides the packaged one so `KillSignal=SIGINT` and the hardening flags are
//! always present.

#![forbid(unsafe_code)]

use pg_deploy_config::PgctlConfig;

use super::model::{
    codes, ProvisionFinding, ProvisionHost, ProvisionMode, ProvisionPlan, ProvisionStep,
    ProvisionTarget, RestartPolicy, StepKind, UnitAction, VerifyExpect,
};
use super::postgres::tls_material_script;
use super::render::{
    pgbouncer_apply_script, pgbouncer_ini, pgbouncer_ownership_script, pgbouncer_unit,
    pgbouncer_userlist, pooler_login_script, secret_name,
};
use super::settings::{validate_storage, HostRef, StorageSettings, Topology};
use super::steps::{file_step, packages_step, script_step, systemd_step, verify_step};
use super::{fingerprint_of, GENERATOR};

/// PgBouncer TLS directory.
pub const PGBOUNCER_TLS_DIR: &str = "/etc/pgbouncer/tls";

/// Build the PgBouncer plan.
#[must_use]
pub fn plan_pgbouncer(
    config: &PgctlConfig,
    settings: &StorageSettings,
    topology: &Topology,
    mode: ProvisionMode,
) -> ProvisionPlan {
    let mut plan = ProvisionPlan {
        environment: config.deployment.environment.as_str().to_owned(),
        target: ProvisionTarget::Pgbouncer,
        mode,
        generator: GENERATOR,
        ..ProvisionPlan::default()
    };
    plan.findings = validate_storage(settings, topology, config);
    if !settings.pgbouncer.enabled {
        plan.notes.push(
            "database.pgbouncer = false: the pooler is not part of this deployment".to_owned(),
        );
        plan.fingerprint = fingerprint_of(&plan);
        return plan;
    }
    if !config.database.is_managed() {
        plan.findings.push(ProvisionFinding::error(
            codes::HOST_MISSING,
            "database.mode",
            "the PgBouncer plan needs the managed PostgreSQL primary it pools; an external database is not provisioned by pgctl",
        ));
        plan.fingerprint = fingerprint_of(&plan);
        return plan;
    }
    let Some(primary) = &topology.primary else {
        plan.findings.push(ProvisionFinding::error(
            codes::HOST_MISSING,
            "hosts",
            "PgBouncer needs the PostgreSQL primary host",
        ));
        plan.fingerprint = fingerprint_of(&plan);
        return plan;
    };
    let pooler_hosts = if topology.pgbouncer.is_empty() {
        // The override enabled the pooler on a host that does not carry the role; co-locate it
        // with the primary rather than refusing a self-consistent single-host deployment.
        plan.notes.push(
            "no host carries the pgbouncer role: the pooler is co-located with the primary"
                .to_owned(),
        );
        vec![HostRef {
            port: settings.pgbouncer.port,
            ..primary.clone()
        }]
    } else {
        topology.pgbouncer.clone()
    };
    plan.notes.push(format!(
        "computed server pool budget: {} connection(s) (limit max_connections - 20 = {})",
        settings.pgbouncer.server_pool_budget(&settings.postgres),
        settings.postgres.max_connections.saturating_sub(20)
    ));
    plan.notes.push(
        "the executor passes changed = false when every file step reported unchanged; the plan renders the desired files"
            .to_owned(),
    );
    plan.notes.push(
        "client_tls_sslmode = verify-full requires a client certificate whose CN matches the database user (D4-T02); PgBouncer presents its server certificate as the client certificate to PostgreSQL"
            .to_owned(),
    );
    let cluster = if primary.port == 5432 {
        "main".to_owned()
    } else {
        super::postgres::cluster_for("primary", &primary.id, primary.port).name
    };
    for host in &pooler_hosts {
        plan.hosts.push(ProvisionHost {
            id: host.id.clone(),
            address: host.address.clone(),
            role: "pgbouncer".to_owned(),
            service: "pg-pgbouncer".to_owned(),
            port: host.port,
            cluster: Some(cluster.clone()),
            steps: pgbouncer_steps(settings, host, primary, mode),
        });
    }
    plan.fingerprint = fingerprint_of(&plan);
    plan
}

fn pgbouncer_steps(
    settings: &StorageSettings,
    host: &HostRef,
    primary: &HostRef,
    _mode: ProvisionMode,
) -> Vec<ProvisionStep> {
    let mut pgbouncer = settings.pgbouncer.clone();
    pgbouncer.port = host.port;
    let listen = listen_addr(&pgbouncer.listen_addr, &host.private_ip);
    let ini = pgbouncer_ini(
        &settings.postgres,
        &pgbouncer,
        &settings.postgres.database,
        primary.port,
        &listen,
        PGBOUNCER_TLS_DIR,
    );
    let mut steps = vec![packages_step(
        "install-pgbouncer",
        "install PgBouncer",
        &["pgbouncer"],
        &["pgbouncer"],
    )];
    steps.push(script_step(
        "verify-tls-material",
        format!("verify the internal-CA material under {PGBOUNCER_TLS_DIR}"),
        StepKind::TlsMaterial,
        true,
        tls_material_script(PGBOUNCER_TLS_DIR, "postgres", "postgres", false),
        RestartPolicy::None,
        Vec::new(),
    ));
    steps.push(file_step(
        "pgbouncer-ini",
        "write /etc/pgbouncer/pgbouncer.ini (transaction + session aliases, TLS, pool budgets)",
        StepKind::ConfigFile,
        "/etc/pgbouncer/pgbouncer.ini",
        0o640,
        "root",
        "root",
        ini,
        RestartPolicy::Reload,
        Vec::new(),
    ));
    let (userlist, secrets) = pgbouncer_userlist(&settings.postgres);
    steps.push(file_step(
        "pgbouncer-userlist",
        "write /etc/pgbouncer/userlist.txt with SCRAM-SHA-256 verifiers (no plaintext)",
        StepKind::ConfigFile,
        "/etc/pgbouncer/userlist.txt",
        0o600,
        "root",
        "root",
        userlist,
        RestartPolicy::Reload,
        secrets,
    ));
    steps.push(file_step(
        "pgbouncer-unit",
        "write the pgctl PgBouncer unit (KillSignal=SIGINT, 15 s stop, hardening)",
        StepKind::Unit,
        "/etc/systemd/system/pgbouncer.service",
        0o644,
        "root",
        "root",
        pgbouncer_unit(),
        RestartPolicy::RestartIfChanged,
        Vec::new(),
    ));
    steps.push(systemd_step(
        "pgbouncer-daemon-reload",
        "systemctl daemon-reload after the unit override",
        "pgbouncer",
        UnitAction::DaemonReload,
    ));
    steps.push(script_step(
        "pgbouncer-ownership",
        "resolve the PgBouncer unit user and converge config/TLS ownership",
        StepKind::Service,
        true,
        pgbouncer_ownership_script(),
        RestartPolicy::None,
        Vec::new(),
    ));
    steps.push(script_step(
        "apply-pgbouncer",
        format!(
            "start, reload or restart PgBouncer and wait for :{}",
            pgbouncer.port
        ),
        StepKind::Service,
        true,
        pgbouncer_apply_script(pgbouncer.port, true, false, false),
        RestartPolicy::RestartIfChanged,
        Vec::new(),
    ));
    steps.push(verify_step(
        "verify-pg-isready",
        "the pooler accepts TCP connections",
        format!("pg_isready -h 127.0.0.1 -p {}", pgbouncer.port),
        VerifyExpect::ExitZero,
    ));
    if let Some(password) = secret_name(&settings.postgres.owner_password) {
        let (script, refs) = pooler_login_script(
            pgbouncer.port,
            &settings.postgres.database,
            &settings.postgres.roles.owner,
            &password,
        );
        steps.push(script_step(
            "verify-owner-login",
            "the owner can log in through the transaction alias",
            StepKind::Verify,
            false,
            script,
            RestartPolicy::None,
            refs,
        ));
        let (script, refs) = pooler_login_script(
            pgbouncer.port,
            &pgbouncer.session_alias,
            &settings.postgres.roles.owner,
            &password,
        );
        steps.push(script_step(
            "verify-session-alias",
            "the session alias serves leader election and migrations",
            StepKind::Verify,
            false,
            script,
            RestartPolicy::None,
            refs,
        ));
    }
    if let Some(password) = secret_name(&settings.postgres.app_password) {
        let (script, refs) = pooler_login_script(
            pgbouncer.port,
            &settings.postgres.database,
            &settings.postgres.roles.app,
            &password,
        );
        steps.push(script_step(
            "verify-app-login",
            "the runtime login (pgw_app member) can log in through the transaction alias",
            StepKind::Verify,
            false,
            script,
            RestartPolicy::None,
            refs,
        ));
    }
    steps
}

fn listen_addr(configured: &str, private_ip: &str) -> String {
    if !configured.is_empty() {
        return configured.to_owned();
    }
    if private_ip.is_empty() || private_ip == "127.0.0.1" {
        "127.0.0.1".to_owned()
    } else {
        format!("{private_ip},127.0.0.1")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::settings::StorageSettings;
    use pg_deploy_config::{DatabaseMode, Environment, Host, PgctlConfig, Role};

    fn config() -> PgctlConfig {
        let mut config = PgctlConfig::new(Environment::Test);
        config.database.mode = DatabaseMode::Managed;
        config.database.owner_password = Some("secret:pg_db_password".to_owned());
        config.database.app_password = Some("secret:pg_app_password".to_owned());
        config.database.replication_password = Some("secret:pg_replication_password".to_owned());
        config.database.pgbouncer = true;
        config.hosts = vec![
            Host {
                name: "db-1".to_owned(),
                address: "10.0.0.21".to_owned(),
                private_ip: "10.0.0.21".to_owned(),
                roles: vec![Role::PgPrimary, Role::Pgbouncer],
                ..Host::default()
            },
            Host {
                name: "core-1".to_owned(),
                address: "10.0.0.11".to_owned(),
                private_ip: "10.0.0.11".to_owned(),
                roles: vec![Role::Core],
                ..Host::default()
            },
        ];
        config.database.host = Some("10.0.0.21".to_owned());
        config
    }

    #[test]
    fn pgbouncer_plan_has_aliases_tls_and_login_checks() {
        let config = config();
        let settings = StorageSettings::from_config(&config);
        let topology = Topology::from_config(&config);
        let plan = plan_pgbouncer(&config, &settings, &topology, ProvisionMode::Fresh);
        assert_eq!(plan.hosts.len(), 1);
        let text = serde_json::to_string(&plan).unwrap_or_default();
        assert!(text.contains("pgw_session"));
        assert!(text.contains("pool_mode=session"));
        assert!(text.contains("server_tls_sslmode = verify-full"));
        assert!(text.contains("client_tls_sslmode = verify-full"));
        assert!(text.contains("KillSignal=SIGINT"));
        assert!(text.contains("SCRAM-SHA-256"));
        assert!(text.contains("verify-owner-login"));
        assert!(text.contains("verify-session-alias"));
        assert!(text.contains("verify-app-login"));
        assert!(
            text.contains("[ 1 = 1 ]"),
            "policy booleans are numeric in shell"
        );
        assert!(!text.contains("[ true = 1 ]"));
        assert!(
            !text.contains("\"secret:pg_db_password\""),
            "only the secret name is present, never the reference value"
        );
    }

    #[test]
    fn pool_budget_is_checked_and_reported() {
        let config = config();
        let mut settings = StorageSettings::from_config(&config);
        settings.pgbouncer.default_pool_size = 400;
        let topology = Topology::from_config(&config);
        let plan = plan_pgbouncer(&config, &settings, &topology, ProvisionMode::Update);
        assert!(plan
            .findings
            .iter()
            .any(|finding| finding.code == codes::PGBOUNCER_BUDGET));
        assert!(plan
            .notes
            .iter()
            .any(|note| note.contains("server pool budget")));
    }

    #[test]
    fn disabled_pooler_is_a_no_op_with_a_note() {
        let mut config = config();
        config.database.pgbouncer = false;
        let settings = StorageSettings::from_config(&config);
        let topology = Topology::from_config(&config);
        let plan = plan_pgbouncer(&config, &settings, &topology, ProvisionMode::Update);
        assert!(plan.hosts.is_empty());
        assert!(plan.notes.iter().any(|note| note.contains("not part")));
    }
}

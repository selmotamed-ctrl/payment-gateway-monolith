//! Audit and log database provisioner plan (D5-T05).
//!
//! Port of `provisionAuditAndLogDb` (`deploy/provisioners/auditAndLogDbProvisioner.ts`): the
//! append-only audit database (hash chain + immutability trigger) and the monthly-partitioned
//! operational log database, with owner/writer roles and least-privilege grants.
//!
//! When the audit/log host is the same cluster as the managed primary (same address and port),
//! the primary plan owns `postgresql.conf` and `pg_hba.conf`; this plan then only runs the SQL and
//! the verification, exactly like the TS `sharesManagedPrimary` guard.
//!
//! Chapter 7 §9 moves the DDL into `db/audit/*.sql` migrations at P10-T02; until then it is the
//! verbatim TS DDL rendered into a private 0600 script (no secret value: roles use psql variables).

#![forbid(unsafe_code)]

use pg_deploy_config::PgctlConfig;

use super::model::{
    codes, ProvisionFinding, ProvisionHost, ProvisionMode, ProvisionPlan, ProvisionStep,
    ProvisionTarget, RestartPolicy, StepKind, VerifyExpect,
};
use super::postgres::{
    cluster_for, create_cluster_script, postgres_apply_script, tls_material_script, ClusterSpec,
};
use super::render::{
    audit_ddl, ensure_log_partitions_sql, log_ddl, postgres_conf, tier_repository_sql,
};
use super::settings::{validate_storage, HostRef, StorageSettings, TierSettings, Topology};
use super::steps::{file_step, packages_step, probe_step, script_step, sql_step, verify_step};
use super::{fingerprint_of, GENERATOR};

/// Build the audit/log database plan.
#[must_use]
pub fn plan_audit_log(
    config: &PgctlConfig,
    settings: &StorageSettings,
    topology: &Topology,
    mode: ProvisionMode,
) -> ProvisionPlan {
    let mut plan = ProvisionPlan {
        environment: config.deployment.environment.as_str().to_owned(),
        target: ProvisionTarget::AuditLog,
        mode,
        generator: GENERATOR,
        ..ProvisionPlan::default()
    };
    plan.findings = validate_storage(settings, topology, config);
    if topology.audit.is_none() && topology.log.is_none() {
        plan.notes.push(
            "no host carries the audit-db or log-db role: both databases are not part of this deployment"
                .to_owned(),
        );
        plan.fingerprint = fingerprint_of(&plan);
        return plan;
    }
    if topology.audit.is_some() && settings.audit.owner_password.is_none() {
        plan.findings.push(ProvisionFinding::error(
            codes::POSTGRES_SECRET_MISSING,
            "storage.audit.owner_password",
            "the audit database needs an owner password reference (secret:<name>)",
        ));
    }
    if topology.audit.is_some() && settings.audit.writer_password.is_none() {
        plan.findings.push(ProvisionFinding::error(
            codes::POSTGRES_SECRET_MISSING,
            "storage.audit.writer_password",
            "the audit database needs a writer password reference (secret:<name>)",
        ));
    }
    if topology.log.is_some() && settings.log.owner_password.is_none() {
        plan.findings.push(ProvisionFinding::error(
            codes::POSTGRES_SECRET_MISSING,
            "storage.log.owner_password",
            "the log database needs an owner password reference (secret:<name>)",
        ));
    }
    if topology.log.is_some() && settings.log.writer_password.is_none() {
        plan.findings.push(ProvisionFinding::error(
            codes::POSTGRES_SECRET_MISSING,
            "storage.log.writer_password",
            "the log database needs a writer password reference (secret:<name>)",
        ));
    }
    if topology.audit.is_some() {
        let cluster = shared_cluster(topology, topology.audit.as_ref(), TierKind::Audit);
        plan.notes.push(if cluster.is_some() {
            "the audit database shares the managed primary cluster: its config/HBA belong to the postgres plan"
                .to_owned()
        } else {
            "the audit database runs on its own managed cluster".to_owned()
        });
        let host = topology.audit.clone().unwrap_or_default();
        plan.hosts.push(tier_host(
            &host,
            "audit",
            "pg-audit-db",
            &settings.audit,
            settings,
            topology,
            cluster,
            mode,
            TierKind::Audit,
        ));
    }
    if topology.log.is_some() {
        let cluster = shared_cluster(topology, topology.log.as_ref(), TierKind::Log);
        plan.notes.push(if cluster.is_some() {
            "the log database shares an already-managed cluster: only its SQL and verification run here"
                .to_owned()
        } else {
            "the log database runs on its own managed cluster".to_owned()
        });
        let host = topology.log.clone().unwrap_or_default();
        plan.hosts.push(tier_host(
            &host,
            "log",
            "pg-log-db",
            &settings.log,
            settings,
            topology,
            cluster,
            mode,
            TierKind::Log,
        ));
    }
    plan.fingerprint = fingerprint_of(&plan);
    plan
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TierKind {
    Audit,
    Log,
}

impl TierKind {
    fn role(self) -> &'static str {
        match self {
            Self::Audit => "audit",
            Self::Log => "log",
        }
    }

    fn ddl(self, writer: &str) -> String {
        match self {
            Self::Audit => audit_ddl(writer),
            Self::Log => log_ddl(writer),
        }
    }
}

fn same_endpoint(left: &HostRef, right: &HostRef) -> bool {
    left.private_ip == right.private_ip && left.port == right.port
}

/// The cluster a tier reuses instead of creating its own, or `None` when it owns one.
///
/// The primary always wins; then the audit database. Two tiers on one host and port are one
/// PostgreSQL cluster (one `postgresql.conf`, one `pg_hba.conf`, one WAL stream), so the second
/// tier must not create another cluster on the same listener.
fn shared_cluster(
    topology: &Topology,
    tier: Option<&HostRef>,
    kind: TierKind,
) -> Option<ClusterSpec> {
    let tier = tier?;
    if let Some(primary) = &topology.primary {
        if same_endpoint(primary, tier) {
            return Some(cluster_for("primary", &primary.id, primary.port));
        }
    }
    if kind == TierKind::Log {
        if let Some(audit) = &topology.audit {
            if same_endpoint(audit, tier) {
                return Some(cluster_for("audit", &audit.id, audit.port));
            }
        }
    }
    None
}

#[allow(clippy::too_many_arguments)]
fn tier_host(
    host: &HostRef,
    role: &str,
    service: &str,
    tier: &TierSettings,
    settings: &StorageSettings,
    topology: &Topology,
    cluster: Option<ClusterSpec>,
    mode: ProvisionMode,
    kind: TierKind,
) -> ProvisionHost {
    let shared = cluster.is_some();
    let cluster = cluster.unwrap_or_else(|| cluster_for(kind.role(), &host.id, host.port));
    let steps = tier_steps(settings, tier, &cluster, host, topology, shared, mode, kind);
    ProvisionHost {
        id: host.id.clone(),
        address: host.address.clone(),
        role: role.to_owned(),
        service: service.to_owned(),
        port: host.port,
        cluster: Some(cluster.name.clone()),
        steps,
    }
}

#[allow(clippy::too_many_arguments)]
fn tier_steps(
    settings: &StorageSettings,
    tier: &TierSettings,
    cluster: &ClusterSpec,
    host: &HostRef,
    topology: &Topology,
    shared: bool,
    mode: ProvisionMode,
    kind: TierKind,
) -> Vec<ProvisionStep> {
    let postgres = &settings.postgres;
    let tls_dir = cluster.tls_dir();
    let mut steps = Vec::new();
    let sources = tier_sources(topology);
    if !shared {
        let (common_debian, common_arch) = super::postgres::postgres_common_packages();
        steps.push(packages_step(
            "install-postgresql-common",
            "install postgresql-common so the implicit main cluster can be disabled",
            common_debian,
            common_arch,
        ));
        steps.push(script_step(
            "disable-main-cluster",
            "disable Debian's initdb-without-checksums main cluster",
            StepKind::Cluster,
            true,
            super::postgres::disable_main_cluster_script(),
            RestartPolicy::None,
            Vec::new(),
        ));
        steps.push(packages_step(
            "install-postgresql",
            "install PostgreSQL 18 server, client, contrib and liburing",
            &[
                "postgresql-18",
                "postgresql-client-18",
                "postgresql-contrib-18",
                "liburing2",
            ],
            &["postgresql", "liburing"],
        ));
        if mode == ProvisionMode::Fresh {
            steps.push(script_step(
                "create-cluster",
                format!(
                    "create the {} cluster on :{} with data checksums",
                    cluster.name, cluster.port
                ),
                StepKind::Cluster,
                true,
                create_cluster_script(cluster),
                RestartPolicy::None,
                Vec::new(),
            ));
        } else {
            steps.push(probe_step(
                "detect-cluster",
                format!("detect the {} cluster", cluster.name),
                format!(
                    "pg_lsclusters -h 2>/dev/null | awk '$2==\"{}\" {{print $1, $2, $4}}' || true",
                    cluster.name
                ),
            ));
        }
        steps.push(script_step(
            "verify-tls-material",
            format!("verify the internal-CA material under {tls_dir}"),
            StepKind::TlsMaterial,
            true,
            tls_material_script(&tls_dir, "postgres", "postgres", true),
            RestartPolicy::None,
            Vec::new(),
        ));
        steps.push(file_step(
            "postgresql-conf",
            format!("write {}/postgresql.conf", cluster.config_dir),
            StepKind::ConfigFile,
            format!("{}/postgresql.conf", cluster.config_dir),
            0o644,
            "postgres",
            "postgres",
            postgres_conf(
                postgres,
                &super::postgres::listen_addresses(&host.private_ip),
                &cluster.data_dir,
                &cluster.hba_path,
                cluster.port,
                &tls_dir,
                &[],
                false,
            ),
            RestartPolicy::Reload,
            Vec::new(),
        ));
        steps.push(file_step(
            "pg-hba",
            "write hostssl-only pg_hba.conf (core, backup and the primary only)",
            StepKind::HbaFile,
            &cluster.hba_path,
            0o640,
            "postgres",
            "postgres",
            super::render::pg_hba(postgres, &sources, &[]),
            RestartPolicy::Reload,
            Vec::new(),
        ));
        steps.push(script_step(
            "apply-cluster",
            format!("start, reload or restart {}", cluster.service),
            StepKind::Service,
            true,
            postgres_apply_script(&cluster.service, cluster.port),
            RestartPolicy::RestartIfChanged,
            Vec::new(),
        ));
    } else {
        steps.push(verify_step(
            "verify-shared-cluster",
            "the shared primary cluster is reachable",
            format!("pg_isready -h 127.0.0.1 -p {}", cluster.port),
            VerifyExpect::ExitZero,
        ));
    }
    let (repository, secrets) = tier_repository_sql(
        &tier.database,
        &tier.owner_role,
        &tier.writer_role,
        &tier.owner_password,
        &tier.writer_password,
    );
    steps.push(sql_step(
        "roles-database",
        format!(
            "create/refresh the owner and writer roles and the {} database",
            tier.database
        ),
        "postgres",
        format!(
            "/var/lib/postgresql/.pgctl-{}-bootstrap/bootstrap.sql",
            kind.role()
        ),
        repository,
        secrets,
    ));
    steps.push(sql_step(
        "ddl",
        format!("apply the {} DDL (idempotent)", tier.database),
        &tier.database,
        format!("/var/lib/postgresql/.pgctl-{}-ddl/ddl.sql", kind.role()),
        kind.ddl(&tier.writer_role),
        Vec::new(),
    ));
    if kind == TierKind::Log {
        steps.push(sql_step(
            "partitions",
            "create the monthly partitions and the retention function",
            &tier.database,
            format!(
                "/var/lib/postgresql/.pgctl-{}-ddl/partitions.sql",
                kind.role()
            ),
            ensure_log_partitions_sql(tier.partitions_ahead, tier.retention_months),
            Vec::new(),
        ));
        steps.push(file_step(
            "partition-cron",
            "install the log partition maintenance cron",
            StepKind::Cron,
            "/etc/cron.d/pg-log-partitions",
            0o644,
            "root",
            "root",
            log_partition_cron(tier, cluster.port),
            RestartPolicy::None,
            Vec::new(),
        ));
    }
    steps.push(verify_step(
        "verify-tables",
        format!("the {} tables exist", kind.role()),
        psql(cluster.port, &tier.database, table_check(kind)),
        VerifyExpect::Equals {
            value: "t".to_owned(),
        },
    ));
    steps.push(verify_step(
        "verify-writer-grants",
        "the writer role may INSERT but not UPDATE (append-only)",
        psql(
            cluster.port,
            &tier.database,
            &format!(
                "SELECT has_table_privilege('{}', '{}', 'INSERT')::text || '/' || has_table_privilege('{}', '{}', 'UPDATE')::text",
                tier.writer_role,
                primary_table(kind),
                tier.writer_role,
                primary_table(kind)
            ),
        ),
        VerifyExpect::Equals {
            value: "true/false".to_owned(),
        },
    ));
    match kind {
        TierKind::Audit => {
            steps.push(verify_step(
                "verify-immutability-trigger",
                "the audit immutability trigger is installed",
                psql(
                    cluster.port,
                    &tier.database,
                    "SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_audit_immutable'",
                ),
                VerifyExpect::Equals {
                    value: "1".to_owned(),
                },
            ));
            steps.push(verify_step(
                "verify-chain",
                "the audit hash chain verifies",
                psql(
                    cluster.port,
                    &tier.database,
                    "SELECT valid FROM verify_audit_chain()",
                ),
                VerifyExpect::Equals {
                    value: "t".to_owned(),
                },
            ));
        }
        TierKind::Log => {
            steps.push(verify_step(
                "verify-partitions",
                "at least one monthly partition exists for both log tables",
                psql(
                    cluster.port,
                    &tier.database,
                    "SELECT (SELECT count(*) FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhparent WHERE c.relname = 'attempt_step_logs') > 0 AND (SELECT count(*) FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhparent WHERE c.relname = 'http_access_logs') > 0",
                ),
                VerifyExpect::Equals {
                    value: "t".to_owned(),
                },
            ));
        }
    }
    steps.push(verify_step(
        "verify-owner",
        "the owner role owns the database",
        psql(
            cluster.port,
            "postgres",
            &format!(
                "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = '{}'",
                tier.database.replace('\'', "")
            ),
        ),
        VerifyExpect::Equals {
            value: tier.owner_role.clone(),
        },
    ));
    steps
}

fn tier_sources(topology: &Topology) -> Vec<String> {
    let mut sources: Vec<String> = topology
        .core
        .iter()
        .chain(topology.backup.iter())
        .map(|host| host.private_ip.clone())
        .filter(|address| super::settings::parse_address(address).is_some())
        .collect();
    if let Some(primary) = &topology.primary {
        if super::settings::parse_address(&primary.private_ip).is_some() {
            sources.push(primary.private_ip.clone());
        }
    }
    sources.sort();
    sources.dedup();
    sources
}

fn psql(port: u16, database: &str, sql: &str) -> String {
    format!(
        "runuser -u postgres -- psql -p {port} -d {database} -tAc {}",
        super::render::shell_quote(sql)
    )
}

fn table_check(kind: TierKind) -> &'static str {
    match kind {
        TierKind::Audit => "SELECT to_regclass('public.audit_records') IS NOT NULL",
        TierKind::Log => "SELECT to_regclass('public.attempt_step_logs') IS NOT NULL",
    }
}

fn primary_table(kind: TierKind) -> &'static str {
    match kind {
        TierKind::Audit => "audit_records",
        TierKind::Log => "attempt_step_logs",
    }
}

fn log_partition_cron(tier: &TierSettings, port: u16) -> String {
    format!(
        "15 1 * * * root runuser -u postgres -- psql -p {port} -d {} -c 'SELECT ensure_log_partitions({}, {})' >/var/log/pg-log-partitions.log 2>&1\n",
        tier.database, tier.partitions_ahead, tier.retention_months
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::settings::StorageSettings;
    use pg_deploy_config::{DatabaseMode, Environment, Host, PgctlConfig, Role};

    fn config(shared: bool) -> PgctlConfig {
        let mut config = PgctlConfig::new(Environment::Test);
        config.database.mode = DatabaseMode::Managed;
        config.database.owner_password = Some("secret:pg_db_password".to_owned());
        config.database.app_password = Some("secret:pg_app_password".to_owned());
        config.database.replication_password = Some("secret:pg_replication_password".to_owned());
        config.hosts = vec![
            Host {
                name: "db-1".to_owned(),
                address: "10.0.0.21".to_owned(),
                private_ip: "10.0.0.21".to_owned(),
                roles: vec![Role::PgPrimary],
                ..Host::default()
            },
            Host {
                name: "core-1".to_owned(),
                address: "10.0.0.11".to_owned(),
                private_ip: "10.0.0.11".to_owned(),
                roles: vec![Role::Core],
                ..Host::default()
            },
            Host {
                name: "backup-1".to_owned(),
                address: "10.0.0.50".to_owned(),
                private_ip: "10.0.0.50".to_owned(),
                roles: vec![Role::Backup],
                ..Host::default()
            },
        ];
        if shared {
            config.hosts[0].roles.push(Role::AuditDb);
            config.hosts[0].roles.push(Role::LogDb);
        } else {
            config.hosts.push(Host {
                name: "db-audit".to_owned(),
                address: "10.0.0.23".to_owned(),
                private_ip: "10.0.0.23".to_owned(),
                service_port: Some(5433),
                roles: vec![Role::AuditDb, Role::LogDb],
                ..Host::default()
            });
        }
        config.database.host = Some("10.0.0.21".to_owned());
        config
    }

    fn settings(config: &PgctlConfig) -> StorageSettings {
        let mut settings = StorageSettings::from_config(config);
        settings.audit.owner_password = Some("secret:pgw_owner_password".to_owned());
        settings.audit.writer_password = Some("secret:audit_writer_password".to_owned());
        settings.log.owner_password = Some("secret:pgw_owner_password".to_owned());
        settings.log.writer_password = Some("secret:log_writer_password".to_owned());
        settings
    }

    #[test]
    fn audit_and_log_have_ddl_roles_and_security_assertions() {
        let config = config(false);
        let settings = settings(&config);
        let topology = Topology::from_config(&config);
        let plan = plan_audit_log(&config, &settings, &topology, ProvisionMode::Fresh);
        assert_eq!(plan.hosts.len(), 2);
        let text = serde_json::to_string(&plan).unwrap_or_default();
        assert!(text.contains("audit_records"));
        assert!(text.contains("forbid_audit_mutation"));
        assert!(text.contains("trg_audit_immutable"));
        assert!(text.contains("ensure_log_partitions"));
        assert!(text.contains("has_table_privilege"));
        assert!(text.contains("true/false"));
        assert!(text.contains("verify-chain"));
        assert!(text.contains("hostssl"));
        assert!(text.contains("listen_addresses = '127.0.0.1,10.0.0.23'"));
        assert!(
            !text.contains("listen_addresses = '*'"),
            "loopback must be bound"
        );
        assert!(!text.contains("host all"));
        assert!(!text.contains("\"secret:audit_writer_password\""));
    }

    #[test]
    fn a_shared_cluster_skips_config_and_hba() {
        let config = config(true);
        let settings = settings(&config);
        let topology = Topology::from_config(&config);
        let plan = plan_audit_log(&config, &settings, &topology, ProvisionMode::Update);
        for host in &plan.hosts {
            assert!(!host.steps.iter().any(|step| step.id == "postgresql-conf"));
            assert!(!host.steps.iter().any(|step| step.id == "create-cluster"));
            assert!(host
                .steps
                .iter()
                .any(|step| step.id == "verify-shared-cluster"));
        }
        assert!(plan.notes.iter().any(|note| note.contains("shares")));
        let log = plan
            .hosts
            .iter()
            .find(|host| host.role == "log")
            .expect("log host");
        let audit = plan
            .hosts
            .iter()
            .find(|host| host.role == "audit")
            .expect("audit host");
        assert_eq!(log.cluster, audit.cluster, "one cluster, one config");
        assert!(log
            .steps
            .iter()
            .any(|step| step.id == "verify-shared-cluster"));
        assert!(!log.steps.iter().any(|step| step.id == "postgresql-conf"));
    }

    #[test]
    fn the_shared_owner_role_must_have_one_password() {
        let config = config(false);
        let mut settings = settings(&config);
        settings.audit.owner_password = Some("secret:audit_owner_password".to_owned());
        let topology = Topology::from_config(&config);
        let plan = plan_audit_log(&config, &settings, &topology, ProvisionMode::Update);
        assert!(plan
            .findings
            .iter()
            .any(|finding| finding.code == codes::AUDITLOG_OWNER_PASSWORD));
        settings.log.owner_password = Some("secret:audit_owner_password".to_owned());
        let plan = plan_audit_log(&config, &settings, &topology, ProvisionMode::Update);
        assert!(!plan
            .findings
            .iter()
            .any(|finding| finding.code == codes::AUDITLOG_OWNER_PASSWORD));
    }

    #[test]
    fn missing_passwords_block_the_plan() {
        let config = config(false);
        let mut settings = StorageSettings::from_config(&config);
        settings.audit.owner_password = None;
        settings.audit.writer_password = None;
        settings.log.owner_password = None;
        settings.log.writer_password = None;
        let topology = Topology::from_config(&config);
        let plan = plan_audit_log(&config, &settings, &topology, ProvisionMode::Update);
        assert!(plan
            .findings
            .iter()
            .any(|finding| finding.code == codes::POSTGRES_SECRET_MISSING));
    }
}

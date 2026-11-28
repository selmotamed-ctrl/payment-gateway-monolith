//! PostgreSQL 18 provisioner plan (D5-T01, S-DB-05/S-DB-11/S-DB-12).
//!
//! Port of `provisionPostgres18` (`deploy/provisioners/postgres18Provisioner.ts`). The planner
//! reads facts at apply time (memory, io_uring, existing cluster, replicas) and re-renders before
//! writing; this static plan uses the configured values and marks the fact probes explicitly.
//!
//! Parity notes:
//! - memory sizing, cluster naming, HBA policy, role bootstrap, slot naming and the
//!   start/reload/`pending_restart` convergence are the TS rules;
//! - certificates are issued by `pgctl pki` (D4-T02) instead of a self-signed `openssl req`;
//! - `io_method = auto` renders `worker` and the apply phase may select `io_uring` after the probe;
//! - `archive_command` is never written here (the backup provisioner owns the WAL stream).

#![forbid(unsafe_code)]

use std::collections::BTreeSet;

use pg_deploy_config::PgctlConfig;

use super::model::{
    codes, ProvisionFinding, ProvisionHost, ProvisionMode, ProvisionPlan, ProvisionStep,
    ProvisionTarget, RestartPolicy, StepKind, VerifyExpect,
};
use super::render::{
    pg_hba, postgres_bootstrap_sql, postgres_conf, replica_basebackup_script, replica_pgpass,
    secret_name, shell_quote, ReplicaDirs,
};
use super::settings::{validate_storage, HostRef, PostgresSettings, StorageSettings, Topology};
use super::steps::{file_step, packages_step, probe_step, script_step, sql_step, verify_step};
use super::{fingerprint_of, GENERATOR};

/// One PostgreSQL cluster on one host (port of `PgCluster`/`pgClusterFor`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClusterSpec {
    /// Cluster name (`main`, `replica_db_2`, `audit`, `log`).
    pub name: String,
    /// Listener.
    pub port: u16,
    /// Data directory.
    pub data_dir: String,
    /// Configuration directory.
    pub config_dir: String,
    /// `pg_hba.conf`.
    pub hba_path: String,
    /// systemd unit (`postgresql@18-main`).
    pub service: String,
}

impl ClusterSpec {
    /// TLS directory next to `pg_hba.conf`.
    #[must_use]
    pub fn tls_dir(&self) -> String {
        format!("{}/tls", self.config_dir)
    }
}

fn sanitize(value: &str) -> String {
    let mut name: String = value
        .to_ascii_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '_' })
        .collect();
    if name.is_empty() || !name.starts_with(|ch: char| ch.is_ascii_lowercase()) {
        name = format!("c_{name}");
    }
    name.truncate(60);
    name
}

/// Cluster naming rule of the TS engine: 5432 keeps `main`, every other role gets its own named
/// cluster so two roles never share a data directory, WAL stream or unit.
#[must_use]
pub fn cluster_for(role: &str, host_id: &str, port: u16) -> ClusterSpec {
    let name = if port == 5432 {
        "main".to_owned()
    } else if role == "replica" {
        sanitize(&format!("replica_{host_id}"))
    } else {
        sanitize(role)
    };
    let config_dir = format!("/etc/postgresql/{}/{name}", super::settings::POSTGRES_MAJOR);
    ClusterSpec {
        data_dir: format!(
            "/var/lib/postgresql/{}/{name}",
            super::settings::POSTGRES_MAJOR
        ),
        hba_path: format!("{config_dir}/pg_hba.conf"),
        service: format!("postgresql@{}-{name}", super::settings::POSTGRES_MAJOR),
        name,
        port,
        config_dir,
    }
}

/// PostgreSQL replica slot name (port of `slotName`): 63 bytes, lowercase, no dashes.
#[must_use]
pub fn slot_name(host_id: &str, index: usize) -> String {
    let raw = if host_id.is_empty() {
        format!("replica_{}", index + 1)
    } else {
        host_id.to_owned()
    };
    let mut name: String = raw
        .to_ascii_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '_' })
        .collect();
    if !name.starts_with(|ch: char| ch.is_ascii_lowercase()) {
        name = format!("r_{name}");
    }
    name.truncate(63);
    name
}

/// Build the PostgreSQL plan.
#[must_use]
pub fn plan_postgres(
    config: &PgctlConfig,
    settings: &StorageSettings,
    topology: &Topology,
    mode: ProvisionMode,
) -> ProvisionPlan {
    let mut plan = ProvisionPlan {
        environment: config.deployment.environment.as_str().to_owned(),
        target: ProvisionTarget::Postgres,
        mode,
        generator: GENERATOR,
        ..ProvisionPlan::default()
    };
    plan.findings = validate_storage(settings, topology, config);
    let Some(primary) = &topology.primary else {
        plan.findings.push(ProvisionFinding::error(
            codes::HOST_MISSING,
            "hosts",
            "no host carries the pg-primary role and database.host is empty",
        ));
        plan.fingerprint = fingerprint_of(&plan);
        return plan;
    };
    if !config.database.is_managed() {
        plan.notes.push(
            "database.mode = external: pgctl only verifies connectivity; it never installs PostgreSQL"
                .to_owned(),
        );
        plan.fingerprint = fingerprint_of(&plan);
        return plan;
    }
    plan.notes.push(
        "certificates are issued by pgctl pki (D4-T02) and installed before the cluster starts; no self-signed material is generated"
            .to_owned(),
    );
    plan.notes.push(
        "hostssl rules require a client certificate for application links; place per-service leaves under /etc/pg/credentials/pg-client/ before applying (D4-T02)"
            .to_owned(),
    );
    if settings.postgres.io_method == super::settings::IoMethod::Auto {
        plan.notes.push(
            "io_method = auto renders worker here; the apply phase re-renders as io_uring when the kernel and liburing support it"
                .to_owned(),
        );
    }
    if settings.postgres.ram_gb.is_none() {
        plan.notes.push(
            "storage.postgres.ram_gb is unset: the plan uses the 32 GB reference profile and the apply phase sizes from the host's /proc/meminfo"
                .to_owned(),
        );
    }
    plan.notes.push(
        "archive_command and WAL retention belong to the backup provisioner; this plan never writes them"
            .to_owned(),
    );
    if mode == ProvisionMode::Update {
        plan.notes.push(
            "update assumes the cluster already exists; use --mode fresh on a new host".to_owned(),
        );
    }

    let primary_cluster = cluster_for("primary", &primary.id, primary.port);
    let replica_slots: Vec<(String, String)> = topology
        .replicas
        .iter()
        .enumerate()
        .map(|(index, replica)| (slot_name(&replica.id, index), replica.id.clone()))
        .collect();
    let sync_names: Vec<String> = if settings.postgres.sync_standbys
        && !topology.replicas.is_empty()
        && !matches!(
            settings.postgres.synchronous_commit,
            super::settings::SyncCommit::Off
        ) {
        replica_slots.iter().map(|(slot, _)| slot.clone()).collect()
    } else {
        Vec::new()
    };
    let mut host_findings = Vec::new();
    let app_sources = app_sources(settings, topology, &mut host_findings);
    let replication_sources = replication_sources(settings, topology, &mut host_findings);
    plan.findings.append(&mut host_findings);

    let primary_steps = primary_steps(
        settings,
        &primary_cluster,
        primary,
        &app_sources,
        &replication_sources,
        &replica_slots,
        &sync_names,
        mode,
    );
    plan.hosts.push(ProvisionHost {
        id: primary.id.clone(),
        address: primary.address.clone(),
        role: "primary".to_owned(),
        service: "pg-postgres-primary".to_owned(),
        port: primary.port,
        cluster: Some(primary_cluster.name.clone()),
        steps: primary_steps,
    });

    for (index, replica) in topology.replicas.iter().enumerate() {
        let cluster = cluster_for("replica", &replica.id, replica.port);
        let slot = slot_name(&replica.id, index);
        let steps = replica_steps(
            settings,
            primary,
            replica,
            &cluster,
            &slot,
            &app_sources,
            mode,
        );
        plan.hosts.push(ProvisionHost {
            id: replica.id.clone(),
            address: replica.address.clone(),
            role: format!("replica:{}", replica.id),
            service: format!("pg-postgres-replica-{}", replica.id),
            port: replica.port,
            cluster: Some(cluster.name.clone()),
            steps,
        });
    }

    if settings.postgres.ha == super::settings::HaMode::ManualStandby {
        plan.notes.push(
            "manual-standby: promote with `pg_ctl promote` (or `pgctl db failover` in D5-T06); this plan sets no failover manager"
                .to_owned(),
        );
    }
    plan.fingerprint = fingerprint_of(&plan);
    plan
}

fn app_sources(
    settings: &StorageSettings,
    topology: &Topology,
    findings: &mut Vec<ProvisionFinding>,
) -> Vec<String> {
    let mut addresses = BTreeSet::new();
    let mut refs: Vec<&HostRef> = Vec::new();
    if let Some(primary) = &topology.primary {
        refs.push(primary);
    }
    refs.extend(topology.replicas.iter());
    refs.extend(topology.core.iter());
    refs.extend(topology.pgbouncer.iter());
    refs.extend(topology.backup.iter());
    if let Some(audit) = &topology.audit {
        refs.push(audit);
    }
    if let Some(log) = &topology.log {
        refs.push(log);
    }
    for host in refs {
        push_source(&host.private_ip, findings, &mut addresses);
    }
    let _ = settings;
    addresses.into_iter().collect()
}

fn replication_sources(
    _settings: &StorageSettings,
    topology: &Topology,
    findings: &mut Vec<ProvisionFinding>,
) -> Vec<String> {
    let mut addresses = BTreeSet::new();
    for replica in &topology.replicas {
        push_source(&replica.private_ip, findings, &mut addresses);
    }
    for backup in &topology.backup {
        push_source(&backup.private_ip, findings, &mut addresses);
    }
    addresses.into_iter().collect()
}

fn push_source(
    address: &str,
    findings: &mut Vec<ProvisionFinding>,
    addresses: &mut BTreeSet<String>,
) {
    if super::settings::parse_address(address).is_some() {
        addresses.insert(address.to_owned());
    } else {
        findings.push(ProvisionFinding::error(
            codes::INVALID_ADDRESS,
            "hosts[].private_ip",
            format!("'{address}' is not an IPv4/IPv6 literal required by pg_hba.conf"),
        ));
    }
}

#[allow(clippy::too_many_arguments)]
fn primary_steps(
    settings: &StorageSettings,
    cluster: &ClusterSpec,
    primary: &HostRef,
    app_sources: &[String],
    replication_sources: &[String],
    replicas: &[(String, String)],
    sync_names: &[String],
    mode: ProvisionMode,
) -> Vec<ProvisionStep> {
    let postgres = &settings.postgres;
    let listen = listen_addresses(&primary.private_ip);
    let tls_dir = cluster.tls_dir();
    let mut steps = base_probes(postgres);
    if mode == ProvisionMode::Fresh && postgres.source == super::settings::PgSource::Pgdg {
        steps.push(script_step(
            "pgdg-repository",
            "configure the PGDG apt repository (pinned PostgreSQL 18)",
            StepKind::Repository,
            true,
            pgdg_repository_script(),
            RestartPolicy::None,
            Vec::new(),
        ));
    }
    let (common_debian, common_arch) = postgres_common_packages();
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
        disable_main_cluster_script(),
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
                "create cluster {} on :{} with data checksums",
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
            format!("detect cluster {} and its PostgreSQL major", cluster.name),
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
            &listen,
            &cluster.data_dir,
            &cluster.hba_path,
            cluster.port,
            &tls_dir,
            sync_names,
            false,
        ),
        RestartPolicy::Reload,
        Vec::new(),
    ));
    steps.push(file_step(
        "pg-hba",
        "write hostssl-only pg_hba.conf",
        StepKind::HbaFile,
        &cluster.hba_path,
        0o640,
        "postgres",
        "postgres",
        pg_hba(postgres, app_sources, replication_sources),
        RestartPolicy::Reload,
        Vec::new(),
    ));
    steps.push(script_step(
        "apply-cluster",
        format!(
            "start, reload or restart {} only when needed, then wait for pg_isready",
            cluster.service
        ),
        StepKind::Service,
        true,
        postgres_apply_script(&cluster.service, cluster.port),
        RestartPolicy::RestartIfChanged,
        Vec::new(),
    ));
    let (bootstrap_sql, secrets) = postgres_bootstrap_sql(postgres, replicas);
    let sql_path = format!(
        "/var/lib/postgresql/.pgctl-bootstrap/{}/bootstrap.sql",
        cluster.name
    );
    steps.push(sql_step(
        "roles-databases",
        format!(
            "create/refresh role passwords, {} and replication slots (idempotent)",
            postgres.database
        ),
        "postgres",
        &sql_path,
        bootstrap_sql,
        secrets,
    ));
    steps.push(file_step(
        "journal-partition-cron",
        "install the journal partition cron (kept until E removes it)",
        StepKind::Cron,
        "/etc/cron.d/pg-journal-partitions",
        0o644,
        "root",
        "root",
        journal_partition_cron(postgres, cluster.port),
        RestartPolicy::None,
        Vec::new(),
    ));
    steps.push(verify_step(
        "verify-pg-isready",
        format!("PostgreSQL on :{} accepts connections", cluster.port),
        format!("pg_isready -h 127.0.0.1 -p {}", cluster.port),
        VerifyExpect::ExitZero,
    ));
    steps.push(verify_step(
        "verify-ssl",
        "TLS is enabled",
        psql_command(cluster.port, "postgres", "SHOW ssl"),
        VerifyExpect::Equals {
            value: "on".to_owned(),
        },
    ));
    if postgres.data_checksums {
        steps.push(verify_step(
            "verify-data-checksums",
            "initdb data checksums are enabled",
            psql_command(cluster.port, "postgres", "SHOW data_checksums"),
            VerifyExpect::Equals {
                value: "on".to_owned(),
            },
        ));
        steps.push(verify_step(
            "verify-checksum-version",
            "pg_controldata reports checksum version 1",
            format!(
                "pg_controldata {} | awk -F: '/Data page checksum version/ {{gsub(/ /,\"\",$2); print $2}}'",
                cluster.data_dir
            ),
            VerifyExpect::Equals {
                value: "1".to_owned(),
            },
        ));
    }
    steps.push(verify_step(
        "verify-io-method",
        "the running server uses the planned I/O method",
        psql_command(cluster.port, "postgres", "SHOW io_method"),
        VerifyExpect::Equals {
            value: postgres.io_method.rendered().to_owned(),
        },
    ));
    steps.push(verify_step(
        "verify-roles",
        "owner, runtime login, group and replication role exist",
        psql_command(
            cluster.port,
            "postgres",
            &format!(
                "SELECT count(*) FROM pg_roles WHERE rolname IN ('{}','{}','{}','{}')",
                postgres.roles.owner,
                postgres.roles.app,
                postgres.roles.app_group,
                postgres.roles.replication
            ),
        ),
        VerifyExpect::Equals {
            value: expected_role_count(postgres).to_string(),
        },
    ));
    let _ = secret_name(&postgres.owner_password);
    steps
}

fn replica_steps(
    settings: &StorageSettings,
    primary: &HostRef,
    replica: &HostRef,
    cluster: &ClusterSpec,
    slot: &str,
    app_sources: &[String],
    mode: ProvisionMode,
) -> Vec<ProvisionStep> {
    let postgres = &settings.postgres;
    let listen = listen_addresses(&replica.private_ip);
    let tls_dir = cluster.tls_dir();
    let mut steps = base_probes(postgres);
    let (common_debian, common_arch) = postgres_common_packages();
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
        disable_main_cluster_script(),
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
                "create replica cluster {} on :{} with data checksums",
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
            format!("detect replica cluster {}", cluster.name),
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
            &listen,
            &cluster.data_dir,
            &cluster.hba_path,
            cluster.port,
            &tls_dir,
            &[],
            true,
        ),
        RestartPolicy::Reload,
        Vec::new(),
    ));
    steps.push(file_step(
        "pg-hba",
        "write hostssl-only pg_hba.conf (no inbound replication on a standby)",
        StepKind::HbaFile,
        &cluster.hba_path,
        0o640,
        "postgres",
        "postgres",
        pg_hba(postgres, app_sources, &[]),
        RestartPolicy::Reload,
        Vec::new(),
    ));
    let (pgpass, secrets) = replica_pgpass(postgres, &primary.private_ip, primary.port);
    steps.push(file_step(
        "pgpass",
        "write ~postgres/.pgpass for pg_basebackup (mode 0600, streamed, never argv)",
        StepKind::ConfigFile,
        "/var/lib/postgresql/.pgpass",
        0o600,
        "postgres",
        "postgres",
        pgpass,
        RestartPolicy::None,
        secrets,
    ));
    let dirs = ReplicaDirs {
        cluster: &cluster.name,
        data_dir: &cluster.data_dir,
        config_dir: &cluster.config_dir,
        tls_dir: &tls_dir,
    };
    steps.push(script_step(
        "pg-basebackup",
        format!(
            "clone {} from {} into {} (slot {slot}) unless already a standby",
            cluster.name, primary.private_ip, cluster.data_dir
        ),
        StepKind::Cluster,
        true,
        replica_basebackup_script(postgres, &primary.private_ip, primary.port, slot, &dirs),
        RestartPolicy::RestartIfChanged,
        Vec::new(),
    ));
    steps.push(script_step(
        "apply-cluster",
        format!("reload {} and wait for pg_isready", cluster.service),
        StepKind::Service,
        true,
        postgres_apply_script(&cluster.service, cluster.port),
        RestartPolicy::RestartIfChanged,
        Vec::new(),
    ));
    steps.push(verify_step(
        "verify-recovery",
        "the node is in recovery (a real standby)",
        psql_command(cluster.port, "postgres", "SELECT pg_is_in_recovery()"),
        VerifyExpect::Equals {
            value: "t".to_owned(),
        },
    ));
    steps
}

fn expected_role_count(postgres: &PostgresSettings) -> usize {
    let mut count = 1; // owner
    if postgres.app_password.is_some() {
        count += 2; // runtime login + DML group
    }
    if postgres.replication_password.is_some() {
        count += 1;
    }
    count
}

fn base_probes(postgres: &PostgresSettings) -> Vec<ProvisionStep> {
    let mut steps = vec![
        probe_step(
            "probe-memory",
            "read the host RAM so the apply phase can size shared_buffers when ram_gb is unset",
            "awk '/^MemTotal:/ { printf \"%d\\n\", $2 / 1048576 }' /proc/meminfo",
        ),
        probe_step(
            "probe-io-uring",
            "detect io_uring support (kernel >= 5.6 and liburing present)",
            "test -e /proc/sys/kernel/io_uring_disabled && printf 'worker\\n' || (ldconfig -p 2>/dev/null | grep -q liburing && printf 'io_uring\\n' || printf 'worker\\n')",
        ),
    ];
    if postgres.io_method == super::settings::IoMethod::IoUring {
        steps.push(verify_step(
            "verify-io-uring-available",
            "the kernel exposes io_uring before the server is restarted",
            "test -e /proc/sys/kernel/io_uring_disabled && exit 1 || ldconfig -p | grep -q liburing",
            VerifyExpect::ExitZero,
        ));
    }
    steps
}

pub(crate) fn listen_addresses(private_ip: &str) -> String {
    let mut addresses: Vec<&str> = vec!["127.0.0.1"];
    if !private_ip.is_empty() && private_ip != "127.0.0.1" {
        addresses.push(private_ip);
    }
    addresses.join(",")
}

fn psql_command(port: u16, database: &str, sql: &str) -> String {
    format!(
        "runuser -u postgres -- psql -p {port} -d {database} -tAc {}",
        shell_quote(sql)
    )
}

fn journal_partition_cron(postgres: &PostgresSettings, port: u16) -> String {
    format!(
        "30 1 * * * root runuser -u postgres -- psql -p {port} -d {} -c 'SELECT ensure_journal_line_partitions(18)' >/var/log/pg-journal-partitions.log 2>&1\n",
        postgres.database
    )
}

/// PGDG repository (chapter 7 §9). `source = distro` skips this step in the planner.
#[must_use]
pub fn pgdg_repository_script() -> String {
    format!(
        "set -eu
if command -v apt-get >/dev/null 2>&1; then
  . /etc/os-release
  install -d -m 0755 /usr/share/postgresql-common/pgdg
  if ! command -v curl >/dev/null 2>&1; then apt-get update -y && DEBIAN_FRONTEND=noninteractive apt-get install -y curl ca-certificates; fi
  curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc {key}
  echo \"deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] {url} ${{VERSION_CODENAME}}-pgdg main\" > /etc/apt/sources.list.d/pgdg.list
  apt-get update -y
fi",
        key = shell_quote(super::settings::PGDG_KEY_URL),
        url = super::settings::PGDG_APT_URL
    )
}

/// `postgresql-common` plus the tools the repository/tests need, installed before the server so
/// Debian's automatic `main` cluster can be disabled first (it would otherwise be created without
/// data checksums).
#[must_use]
pub fn postgres_common_packages() -> (&'static [&'static str], &'static [&'static str]) {
    (
        &["postgresql-common", "ca-certificates", "curl"],
        &["ca-certificates", "curl"],
    )
}

/// Stop Debian/Ubuntu's package post-install from creating an unchecked `main` cluster.
#[must_use]
pub fn disable_main_cluster_script() -> String {
    "set -eu
if [ -f /etc/postgresql-common/createcluster.conf ]; then
  if grep -Eq '^[#[:space:]]*create_main_cluster' /etc/postgresql-common/createcluster.conf; then
    sed -i 's/^[#[:space:]]*create_main_cluster.*/create_main_cluster = false/' /etc/postgresql-common/createcluster.conf
  else
    printf 'create_main_cluster = false\\n' >> /etc/postgresql-common/createcluster.conf
  fi
fi".to_owned()
}

/// Create the cluster with data checksums (Debian `pg_createcluster` or Arch `initdb`).
#[must_use]
pub fn create_cluster_script(cluster: &ClusterSpec) -> String {
    let data = shell_quote(&cluster.data_dir);
    let unit = shell_quote(&cluster.service);
    format!(
        "set -eu
if command -v pg_createcluster >/dev/null 2>&1; then
  pg_lsclusters -h | awk '{{print $2}}' | grep -qx {name} || pg_createcluster {major} {name} -p {port} -- --data-checksums --encoding=UTF8
else
  install -d -m 0755 {config}
  install -d -m 0700 -o postgres -g postgres {data}
  if [ ! -s {data}/PG_VERSION ]; then runuser -u postgres -- initdb -D {data} --data-checksums --encoding=UTF8; fi
  install -d -m 0755 -o postgres -g postgres /run/postgresql
  for f in postgresql.conf pg_hba.conf; do
    if [ -f {data}/$f ] && [ ! -L {data}/$f ]; then mv {data}/$f {config}/$f; fi
    ln -sfn {config}/$f {data}/$f
  done
  cat > /etc/systemd/system/{service}.service <<UNIT
[Unit]
Description=PostgreSQL {major} {name}
After=network.target

[Service]
Type=simple
User=postgres
Group=postgres
RuntimeDirectory=postgresql
RuntimeDirectoryMode=2775
ExecStart=/usr/bin/postgres -D {data} -p {port}
ExecReload=/bin/kill -HUP \\$MAINPID
KillSignal=SIGINT
TimeoutStopSec=60s
Restart=on-failure

[Install]
WantedBy=multi-user.target
UNIT
fi
systemctl daemon-reload
systemctl enable {service} >/dev/null 2>&1 || true",
        name = cluster.name,
        major = super::settings::POSTGRES_MAJOR,
        port = cluster.port,
        config = shell_quote(&cluster.config_dir),
        service = unit
    )
}

/// Verify internal-CA material and converge ownership (D4-T02).
#[must_use]
pub fn tls_material_script(tls_dir: &str, owner: &str, group: &str, require_crl: bool) -> String {
    let dir = shell_quote(tls_dir);
    let files = if require_crl {
        "server.crt server.key ca.crt crl.pem"
    } else {
        "server.crt server.key ca.crt"
    };
    let chmod_crl = if require_crl {
        format!("chmod 0644 {dir}/crl.pem")
    } else {
        String::new()
    };
    format!(
        "set -eu
install -d -m 0750 -o {owner} -g {group} {dir}
for f in {files}; do
  if [ ! -s {dir}/$f ]; then echo \"missing {dir}/$f: issue the storage leaf with 'pgctl pki' (D4-T02)\" >&2; exit 1; fi
done
chown {owner}:{group} {dir}/server.crt {dir}/server.key {dir}/ca.crt
[ ! -s {dir}/crl.pem ] || chown {owner}:{group} {dir}/crl.pem
chmod 0600 {dir}/server.key
chmod 0644 {dir}/server.crt {dir}/ca.crt
{chmod_crl}"
    )
}

/// Start/reload/restart with the least disruption (port of `postgresApplyScript`).
#[must_use]
pub fn postgres_apply_script(unit: &str, port: u16) -> String {
    format!(
        "set -u
unit={}
psql=\"runuser -u postgres -- psql -p {port} -d postgres -Atc\"
if ! systemctl is-active --quiet \"$unit\"; then
  systemctl reset-failed \"$unit\" >/dev/null 2>&1 || true
  systemctl enable --now \"$unit\" 2>/dev/null || systemctl start \"$unit\"
  echo __PG_APPLY__=started
else
  t0=$($psql 'SELECT pg_conf_load_time()' 2>/dev/null || echo none)
  systemctl reload \"$unit\" || kill -HUP \"$(systemctl show -p MainPID --value \"$unit\")\"
  for i in $(seq 1 25); do t1=$($psql 'SELECT pg_conf_load_time()' 2>/dev/null || echo none); [ \"$t1\" != \"$t0\" ] && break; sleep 0.2; done
  pending=$($psql 'SELECT count(*) FROM pg_settings WHERE pending_restart' 2>/dev/null || echo unknown)
  if [ \"$pending\" != 0 ]; then systemctl restart \"$unit\"; echo __PG_APPLY__=restarted; else echo __PG_APPLY__=reloaded; fi
fi
for i in $(seq 1 60); do pg_isready -h 127.0.0.1 -p {port} >/dev/null 2>&1 && exit 0; sleep 1; done
echo 'PostgreSQL did not accept connections within 60s' >&2; exit 1",
        shell_quote(unit)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::settings::{PgRoles, StorageSettings, Topology};
    use pg_deploy_config::{DatabaseMode, Environment, Host, PgctlConfig, Role};

    fn config() -> PgctlConfig {
        let mut config = PgctlConfig::new(Environment::Test);
        config.database.mode = DatabaseMode::Managed;
        config.database.name = "payment_gateway_prod".to_owned();
        config.database.owner_password = Some("secret:pg_db_password".to_owned());
        config.database.app_password = Some("secret:pg_app_password".to_owned());
        config.database.replication_password = Some("secret:pg_replication_password".to_owned());
        config.database.pgbouncer = true;
        config.database.tls = true;
        config.hosts = vec![
            Host {
                name: "db-1".to_owned(),
                address: "10.0.0.21".to_owned(),
                private_ip: "10.0.0.21".to_owned(),
                roles: vec![Role::PgPrimary, Role::Pgbouncer],
                ..Host::default()
            },
            Host {
                name: "db-2".to_owned(),
                address: "10.0.0.22".to_owned(),
                private_ip: "10.0.0.22".to_owned(),
                roles: vec![Role::PgReplica],
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
        config.database.host = Some("10.0.0.21".to_owned());
        config
    }

    fn settings(config: &PgctlConfig) -> StorageSettings {
        let mut settings = StorageSettings::from_config(config);
        settings.postgres.roles = PgRoles {
            owner: "gw_core_user".to_owned(),
            app: "pgw_app_login".to_owned(),
            app_group: "pgw_app".to_owned(),
            replication: "gw_replicator".to_owned(),
        };
        settings.postgres.ram_gb = Some(16);
        settings
    }

    #[test]
    fn cluster_naming_matches_the_ts_rule() {
        assert_eq!(cluster_for("primary", "db-1", 5432).name, "main");
        assert_eq!(cluster_for("audit", "db-1", 5433).name, "audit");
        assert_eq!(cluster_for("replica", "db-2", 5433).name, "replica_db_2");
        assert_eq!(slot_name("db-2", 0), "db_2");
        assert_eq!(slot_name("db-2", 1), "db_2");
        assert_eq!(slot_name("", 0), "replica_1");
    }

    #[test]
    fn fresh_and_update_plans_are_deterministic_and_ordered() {
        let config = config();
        let settings = settings(&config);
        let topology = Topology::from_config(&config);
        let fresh = plan_postgres(&config, &settings, &topology, ProvisionMode::Fresh);
        let again = plan_postgres(&config, &settings, &topology, ProvisionMode::Fresh);
        assert_eq!(fresh, again);
        assert_eq!(fresh.fingerprint, again.fingerprint);
        assert_eq!(fresh.hosts.len(), 2);
        assert_eq!(fresh.hosts[0].role, "primary");
        assert!(fresh.hosts[0]
            .steps
            .iter()
            .any(|step| step.id == "pgdg-repository"));
        assert!(fresh.hosts[0]
            .steps
            .iter()
            .any(|step| step.id == "apply-cluster"));
        let update = plan_postgres(&config, &settings, &topology, ProvisionMode::Update);
        assert_ne!(fresh.fingerprint, update.fingerprint);
        assert!(!update.hosts[0]
            .steps
            .iter()
            .any(|step| step.id == "pgdg-repository"));
        assert!(update.hosts[0]
            .steps
            .iter()
            .any(|step| step.id == "detect-cluster"));
        assert_eq!(
            update,
            plan_postgres(&config, &settings, &topology, ProvisionMode::Update)
        );
    }

    #[test]
    fn replica_plan_clones_with_a_slot_and_verifies_recovery() {
        let config = config();
        let settings = settings(&config);
        let topology = Topology::from_config(&config);
        let plan = plan_postgres(&config, &settings, &topology, ProvisionMode::Fresh);
        let replica = &plan.hosts[1];
        let ids: Vec<&str> = replica.steps.iter().map(|step| step.id.as_str()).collect();
        assert!(ids.contains(&"pgpass"));
        assert!(ids.contains(&"pg-basebackup"));
        assert!(ids.contains(&"verify-recovery"));
        let basebackup = replica
            .steps
            .iter()
            .find(|step| step.id == "pg-basebackup")
            .map(|step| format!("{:?}", step.apply))
            .unwrap_or_default();
        assert!(basebackup.contains("verify-full"));
        assert!(basebackup.contains("pg_basebackup"));
        assert!(
            basebackup.contains("application_name=%s") && basebackup.contains("db_2"),
            "synchronous_standby_names matches application_name, not the slot name"
        );
        assert!(basebackup.contains("primary_conninfo"));
        let pgpass = replica
            .steps
            .iter()
            .find(|step| step.id == "pgpass")
            .map(|step| format!("{:?}", step.apply))
            .unwrap_or_default();
        assert!(pgpass.contains("{{secret:pg_replication_password}}"));
        let primary_sql = plan.hosts[0]
            .steps
            .iter()
            .find(|step| step.id == "roles-databases")
            .map(|step| format!("{:?}", step.apply))
            .unwrap_or_default();
        assert!(primary_sql.contains("pg_create_physical_replication_slot"));
        assert!(primary_sql.contains("db_2"));
    }

    #[test]
    fn hba_has_only_hostssl_and_scopes_replication() {
        let config = config();
        let settings = settings(&config);
        let topology = Topology::from_config(&config);
        let plan = plan_postgres(&config, &settings, &topology, ProvisionMode::Update);
        let hba = plan.hosts[0]
            .steps
            .iter()
            .find(|step| step.id == "pg-hba")
            .map(|step| format!("{:?}", step.apply))
            .unwrap_or_default();
        assert!(!hba.contains("host all"));
        assert!(hba.contains("hostssl replication     gw_replicator"));
        assert!(hba.contains("10.0.0.22/32"), "replica may replicate");
        assert!(hba.contains("10.0.0.50/32"), "backup may replicate");
        assert!(hba.contains("10.0.0.11/32"), "core may connect");
        assert!(hba.contains("clientcert=verify-ca"));
    }

    #[test]
    fn apply_scripts_use_numeric_booleans() {
        let script = postgres_apply_script("postgresql@18-main", 5432);
        assert!(!script.contains("true ="), "{script}");
        assert!(!script.contains("false ="), "{script}");
    }

    #[test]
    fn invalid_roles_ram_and_ports_block_the_plan() {
        let config = config();
        let mut settings = settings(&config);
        settings.postgres.roles.owner = "pg_owner".to_owned();
        settings.postgres.ram_gb = Some(0);
        settings.pgbouncer.default_pool_size = 500;
        let topology = Topology::from_config(&config);
        let plan = plan_postgres(&config, &settings, &topology, ProvisionMode::Update);
        assert!(plan.error_count() >= 3);
        assert!(plan
            .findings
            .iter()
            .any(|finding| finding.code == codes::POSTGRES_ROLE));
        assert!(plan
            .findings
            .iter()
            .any(|finding| finding.code == codes::POSTGRES_RAM));
        assert!(plan
            .findings
            .iter()
            .any(|finding| finding.code == codes::PGBOUNCER_BUDGET));
    }

    #[test]
    fn sync_standby_names_are_rendered_only_when_enabled_with_a_replica() {
        let config = config();
        let settings = settings(&config);
        let topology = Topology::from_config(&config);
        let conf = |settings: &StorageSettings| {
            plan_postgres(&config, settings, &topology, ProvisionMode::Update).hosts[0]
                .steps
                .iter()
                .find(|step| step.id == "postgresql-conf")
                .map(|step| format!("{:?}", step.apply))
                .unwrap_or_default()
        };
        assert!(
            !conf(&settings).contains("synchronous_standby_names"),
            "sync standbys are opt-in to avoid stalling a fresh primary"
        );
        let mut enabled = settings.clone();
        enabled.postgres.sync_standbys = true;
        assert!(conf(&enabled).contains("synchronous_standby_names"));
        let mut off = enabled.clone();
        off.postgres.synchronous_commit = super::super::settings::SyncCommit::Off;
        assert!(!conf(&off).contains("synchronous_standby_names"));
    }
}

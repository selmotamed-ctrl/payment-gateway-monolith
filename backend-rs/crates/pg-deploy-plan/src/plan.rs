//! Host and service planner.
//!
//! Port of `deploy/lib/hostPlanner.ts` (`planHosts`): roles are grouped by SSH endpoint, each node
//! of a tier gets its own service name, and the listener ports are the ones the TypeScript engine
//! uses today. The plan is pure data: `pgctl plan` prints it, `pgctl apply` (D1+) consumes it, and
//! no SSH connection is opened here.
//!
//! Naming rules reproduced from the TS planner:
//!
//! - a single-node tier keeps the historical unsuffixed name (`pg-core-back`);
//! - a multi-node tier suffixes every node, including the first (`pg-core-back-core-1`);
//! - replicas of one tier on one host are numbered (`pg-core-back-1`, `pg-core-back-2`);
//! - the sandbox core is always `pg-core-sandbox`, on `sandbox.host` or the first core host;
//! - storage components are `pg-postgres-primary`, `pg-postgres-replica-<node>`, `pg-pgbouncer`,
//!   `pg-redis`, `pg-audit-db`, `pg-log-db`, `pg-backup-daemon`,
//!   `pg-object-storage-daemon`;
//! - nginx sites are services too (`pg-admin-nginx`, `pg-merchant-nginx`,
//!   `pg-checkout-nginx`, `pg-fake-rails-nginx`) so verification can probe them.

#![forbid(unsafe_code)]

use serde::Serialize;

use pg_deploy_config::{
    validate, ImplKind, PgctlConfig, Role, Severity, CORE_RS_COEXIST_PORT,
    CORE_RS_COEXIST_SANDBOX_PORT,
};

use crate::verify::CheckKind;

/// Port order used to sort hosts for deployment: storage, then core, then fake rails, then the
/// edges (port of the TS `ROLE_ORDER`).
#[must_use]
pub fn role_order(role: Role) -> u8 {
    match role {
        Role::Db
        | Role::PgPrimary
        | Role::PgReplica
        | Role::Pgbouncer
        | Role::Redis
        | Role::AuditDb
        | Role::LogDb
        | Role::Backup
        | Role::ObjectStorage => 1,
        Role::Core => 2,
        Role::FakeRails => 3,
        Role::Admin => 4,
        Role::Merchant => 5,
        Role::Checkout => 6,
    }
}

/// Execution plane of a core pool.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Plane {
    /// Live traffic.
    Live,
    /// Sandbox traffic.
    Sandbox,
}

/// The upstream pool(s) of one plane: the TypeScript core, the Rust core, or both during coexistence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CorePool {
    /// Plane.
    pub plane: Plane,
    /// TypeScript core service names (multi-node tiers have one per node).
    pub ts: Vec<String>,
    /// Rust core service names.
    pub rust: Vec<String>,
    /// Health/upstream URLs in deterministic order (TypeScript first, then Rust).
    pub urls: Vec<String>,
}

/// A non-blocking finding produced while planning (including every configuration error, so an
/// invalid document cannot be planned silently).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PlanWarning {
    /// Stable code (a validation code, or one of [`plan_codes`]).
    pub code: String,
    /// Dotted TOML path or service name.
    pub path: String,
    /// Explanation.
    pub message: String,
    /// Severity inherited from validation, or `Warning` for planner findings.
    pub severity: Severity,
}

/// Planner-only codes.
pub mod plan_codes {
    /// A role has no host; the service was placed on the first host.
    pub const NO_HOST_FOR_ROLE: &str = "NO_HOST_FOR_ROLE";
    /// The document has no hosts at all.
    pub const NO_HOSTS: &str = "NO_HOSTS";
    /// A service is disabled in the document.
    pub const SERVICE_DISABLED: &str = "SERVICE_DISABLED";
}

/// One machine and the services placed on it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PlannedHost {
    /// Node id.
    pub name: String,
    /// SSH address.
    pub address: String,
    /// SSH port.
    pub ssh_port: u16,
    /// SSH/unix account.
    pub ssh_user: String,
    /// LAN address for SANs, firewall and health checks.
    pub private_ip: String,
    /// Public address (empty when the host does not terminate public vhosts).
    pub public_ip: String,
    /// Roles in document order.
    pub roles: Vec<Role>,
    /// Names of the services placed here, sorted.
    pub services: Vec<String>,
    /// Deploy order (lower first).
    pub deploy_order: u8,
}

/// One unit to install, start and verify.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PlannedService {
    /// Service name (`pg-core-back`, `pg-core-back-core-1`, `pg-core-sandbox`, ...).
    pub name: String,
    /// Host name it runs on (`unassigned` when the document has no host).
    pub host: String,
    /// TS, Rust or both. Storage/nginx services report `ts` (no Rust binary owns them yet).
    #[serde(rename = "impl")]
    pub impl_: ImplKind,
    /// Listener port.
    pub port: u16,
    /// systemd unit name (`postgresql`, `pgbouncer`, `redis`, `nginx`, or the service name).
    pub systemd_unit: String,
    /// Services that must be healthy first, filtered to names that exist in the plan.
    pub depends_on: Vec<String>,
    /// Instances represented by this name (1 unless a single host runs several replicas).
    pub replicas: u16,
    /// Core upstream URLs this edge backend must use (live plane).
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub upstreams: Vec<String>,
    /// Core upstream URLs of the sandbox plane.
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub sandbox_upstreams: Vec<String>,
}

/// The complete desired state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Plan {
    /// Hosts, sorted by deploy order then name.
    pub hosts: Vec<PlannedHost>,
    /// Services, sorted by name.
    pub services: Vec<PlannedService>,
    /// Upstream pools per plane (coexistence-aware).
    pub core_pools: Vec<CorePool>,
    /// Validation errors and planner warnings.
    pub warnings: Vec<PlanWarning>,
}

impl Plan {
    /// Look a service up by name.
    #[must_use]
    pub fn service(&self, name: &str) -> Option<&PlannedService> {
        self.services.iter().find(|service| service.name == name)
    }

    /// Look a host up by name.
    #[must_use]
    pub fn host(&self, name: &str) -> Option<&PlannedHost> {
        self.hosts.iter().find(|host| host.name == name)
    }

    /// Health checks for this plan (chapter 7 §13).
    #[must_use]
    pub fn verification(&self) -> Vec<crate::verify::VerificationCheck> {
        crate::verify::verification_checks(self)
    }

    /// True when any warning came from a configuration error.
    #[must_use]
    pub fn has_errors(&self) -> bool {
        self.warnings
            .iter()
            .any(|warning| warning.severity.is_error())
    }
}

/// Plan a document.
///
/// Port of `deploy/lib/hostPlanner.ts:planHosts`. Never panics and never fails: an invalid document
/// is still planned from its defaults, with every validation error attached to [`Plan::warnings`].
#[must_use]
pub fn plan(config: &PgctlConfig) -> Plan {
    let mut builder = Builder::new(config);
    builder.plan_storage();
    builder.plan_core();
    builder.plan_edges();
    builder.plan_fake_rails();
    // Object storage before the backup daemon: the daemon depends on the vault.
    builder.plan_object_storage();
    builder.plan_backup();
    builder.finish()
}

struct Builder<'a> {
    config: &'a PgctlConfig,
    services: Vec<PlannedService>,
    warnings: Vec<PlanWarning>,
    hosts: Vec<PlannedHost>,
}

impl<'a> Builder<'a> {
    fn new(config: &'a PgctlConfig) -> Self {
        let mut warnings = Vec::new();
        for problem in validate(config) {
            warnings.push(PlanWarning {
                code: problem.code.to_owned(),
                path: problem.path,
                message: problem.message,
                severity: problem.severity,
            });
        }
        if config.hosts.is_empty() {
            warnings.push(PlanWarning {
                code: plan_codes::NO_HOSTS.to_owned(),
                path: "hosts".to_owned(),
                message: "the document has no hosts; every service is planned as unassigned"
                    .to_owned(),
                severity: Severity::Error,
            });
        }
        let hosts = config
            .hosts
            .iter()
            .map(|host| PlannedHost {
                name: host.name.clone(),
                address: host.address.clone(),
                ssh_port: host.ssh_port,
                ssh_user: host.ssh_user.clone(),
                private_ip: if host.private_ip.is_empty() {
                    host.address.clone()
                } else {
                    host.private_ip.clone()
                },
                public_ip: host.public_ip.clone(),
                roles: host.roles.clone(),
                services: Vec::new(),
                deploy_order: host
                    .roles
                    .iter()
                    .copied()
                    .map(role_order)
                    .min()
                    .unwrap_or(9),
            })
            .collect::<Vec<_>>();
        Self {
            config,
            services: Vec::new(),
            warnings,
            hosts,
        }
    }

    fn warn(&mut self, code: &str, path: String, message: String) {
        self.warnings.push(PlanWarning {
            code: code.to_owned(),
            path,
            message,
            severity: Severity::Warning,
        });
    }

    fn hosts_with_role(&self, role: Role) -> Vec<String> {
        self.hosts
            .iter()
            .filter(|host| host.roles.contains(&role))
            .map(|host| host.name.clone())
            .collect()
    }

    fn fallback_host(&self) -> Option<String> {
        self.hosts.first().map(|host| host.name.clone())
    }

    fn port_for(&self, host: &str, role: Role, default: u16) -> u16 {
        self.config
            .hosts
            .iter()
            .find(|candidate| candidate.name == host)
            .and_then(|candidate| {
                if candidate.roles.contains(&role) {
                    candidate.service_port
                } else {
                    None
                }
            })
            .unwrap_or(default)
    }

    /// Place a tier. Returns `(name, host)` pairs.
    fn placement(&mut self, base: &str, role: Role, replicas: u16) -> Vec<(String, String)> {
        let mut candidates = self.hosts_with_role(role);
        if candidates.is_empty() {
            // Prefer the first core host: a compute role with no host of its own is far more likely
            // to belong beside the core than on a database or backup box.
            let fallback = self
                .hosts_with_role(Role::Core)
                .first()
                .cloned()
                .or_else(|| self.fallback_host());
            self.warn(
                plan_codes::NO_HOST_FOR_ROLE,
                base.to_owned(),
                match &fallback {
                    Some(host) => format!(
                        "no host carries role \"{}\"; {base} is planned on {host}",
                        role.as_str()
                    ),
                    None => format!(
                        "no host carries role \"{}\"; {base} is unassigned",
                        role.as_str()
                    ),
                },
            );
            candidates = vec![fallback.unwrap_or_else(|| "unassigned".to_owned())];
        }
        let replicas = replicas.max(1);
        if candidates.len() > 1 {
            candidates
                .into_iter()
                .map(|host| {
                    let name = format!("{base}-{}", slug(&host));
                    (name, host)
                })
                .collect()
        } else if replicas > 1 {
            let host = candidates.remove(0);
            (1..=replicas)
                .map(|index| (format!("{base}-{index}"), host.clone()))
                .collect()
        } else {
            let host = candidates.remove(0);
            vec![(base.to_owned(), host)]
        }
    }

    // A planned service is a plain data row; a builder struct for seven fields would be noise.
    #[allow(clippy::too_many_arguments)]
    fn push(
        &mut self,
        name: String,
        host: String,
        impl_: ImplKind,
        port: u16,
        unit: &str,
        depends_on: Vec<String>,
        replicas: u16,
    ) {
        let systemd_unit = if unit.is_empty() {
            name.clone()
        } else {
            unit.to_owned()
        };
        self.services.push(PlannedService {
            name,
            host,
            impl_,
            port,
            systemd_unit,
            depends_on,
            replicas,
            upstreams: Vec::new(),
            sandbox_upstreams: Vec::new(),
        });
    }

    fn names_starting_with(&self, prefix: &str) -> Vec<String> {
        self.services
            .iter()
            .filter(|service| service.name.starts_with(prefix))
            .map(|service| service.name.clone())
            .collect()
    }

    fn plan_storage(&mut self) {
        // Copy the scalar settings first: the planner mutates `self.services` while it reads them.
        let database_port = self.config.database.port;
        let database_managed = self.config.database.is_managed();
        let pgbouncer = self.config.database.pgbouncer;
        let pgbouncer_port = self.config.database.pgbouncer_port;
        let redis_enabled = self.config.redis.enabled;
        let redis_port = self.config.redis.port;

        let primary_hosts = self.hosts_with_role(Role::PgPrimary);
        if database_managed || !primary_hosts.is_empty() {
            let placements = if primary_hosts.len() > 1 {
                // Validation reports this; plan the first deterministically.
                vec![(
                    String::from("pg-postgres-primary"),
                    primary_hosts[0].clone(),
                )]
            } else if let Some(host) = primary_hosts.first() {
                vec![(String::from("pg-postgres-primary"), host.clone())]
            } else {
                let mut placed = self.placement("pg-postgres-primary", Role::PgPrimary, 1);
                placed.truncate(1);
                placed
            };
            for (name, host) in placements {
                let port = self.port_for(&host, Role::PgPrimary, database_port);
                self.push(name, host, ImplKind::Ts, port, "postgresql", Vec::new(), 1);
            }
        }

        let replicas = self.hosts_with_role(Role::PgReplica);
        for host in replicas {
            let port = self.port_for(&host, Role::PgReplica, database_port);
            self.push(
                format!("pg-postgres-replica-{}", slug(&host)),
                host,
                ImplKind::Ts,
                port,
                "postgresql",
                vec!["pg-postgres-primary".to_owned()],
                1,
            );
        }

        if pgbouncer {
            let mut pooler_hosts = self.hosts_with_role(Role::Pgbouncer);
            if pooler_hosts.is_empty() {
                pooler_hosts = self.hosts_with_role(Role::PgPrimary);
            }
            if pooler_hosts.is_empty() {
                pooler_hosts = self
                    .placement("pg-pgbouncer", Role::Pgbouncer, 1)
                    .into_iter()
                    .map(|(_, host)| host)
                    .collect();
            }
            let multi = pooler_hosts.len() > 1;
            for host in pooler_hosts {
                let port = self.port_for(&host, Role::Pgbouncer, pgbouncer_port);
                let name = if multi {
                    format!("pg-pgbouncer-{}", slug(&host))
                } else {
                    "pg-pgbouncer".to_owned()
                };
                self.push(
                    name,
                    host,
                    ImplKind::Ts,
                    port,
                    "pgbouncer",
                    vec!["pg-postgres-primary".to_owned()],
                    1,
                );
            }
        }

        if let Some(host) = self.hosts_with_role(Role::AuditDb).first().cloned() {
            let port = self.port_for(&host, Role::AuditDb, database_port);
            self.push(
                "pg-audit-db".to_owned(),
                host,
                ImplKind::Ts,
                port,
                "postgresql",
                Vec::new(),
                1,
            );
        }
        if let Some(host) = self.hosts_with_role(Role::LogDb).first().cloned() {
            let port = self.port_for(&host, Role::LogDb, database_port);
            self.push(
                "pg-log-db".to_owned(),
                host,
                ImplKind::Ts,
                port,
                "postgresql",
                Vec::new(),
                1,
            );
        }

        if redis_enabled {
            let mut hosts = self.hosts_with_role(Role::Redis);
            if hosts.is_empty() {
                hosts = self
                    .placement("pg-redis", Role::Redis, 1)
                    .into_iter()
                    .map(|(_, host)| host)
                    .collect();
            }
            let multi = hosts.len() > 1;
            for host in hosts {
                let port = self.port_for(&host, Role::Redis, redis_port);
                let name = if multi {
                    format!("pg-redis-{}", slug(&host))
                } else {
                    "pg-redis".to_owned()
                };
                self.push(name, host, ImplKind::Ts, port, "redis", Vec::new(), 1);
            }
        }
    }

    fn plan_core(&mut self) {
        let core_enabled = self.config.services.core.enabled;
        let implementation = self.config.services.core.implementation;
        let core_port = self.config.services.core.port;
        let sandbox_port = self.config.services.core.sandbox_port;
        let core_replicas = self.config.services.core.replicas;
        let pgbouncer = self.config.database.pgbouncer;
        let fake_rails_enabled = self.config.services.fake_rails.enabled;

        if !core_enabled {
            self.warn(
                plan_codes::SERVICE_DISABLED,
                "services.core".to_owned(),
                "the Live core is disabled; edges would have no upstream".to_owned(),
            );
            return;
        }
        let mut dependencies = Vec::new();
        if pgbouncer {
            dependencies.push("pg-pgbouncer".to_owned());
        } else if self
            .services
            .iter()
            .any(|service| service.name == "pg-postgres-primary")
        {
            dependencies.push("pg-postgres-primary".to_owned());
        }
        if self
            .services
            .iter()
            .any(|service| service.name == "pg-redis")
        {
            dependencies.push("pg-redis".to_owned());
        }
        let placements = self.placement("pg-core-back", Role::Core, core_replicas);
        let multi = placements.len() > 1;
        for (name, host) in placements {
            let port = if multi {
                core_port
            } else {
                self.port_for(&host, Role::Core, core_port)
            };
            self.plan_core_instance(&name, &host, implementation, port, &dependencies);
        }

        if self.config.sandbox.enabled {
            let wanted = self.config.sandbox.host.clone();
            let host = wanted
                .as_deref()
                .and_then(|wanted| {
                    self.hosts
                        .iter()
                        .find(|host| {
                            host.name == wanted
                                || host.address == wanted
                                || host.private_ip == wanted
                        })
                        .map(|host| host.name.clone())
                })
                .or_else(|| self.hosts_with_role(Role::Core).first().cloned())
                .or_else(|| self.fallback_host())
                .unwrap_or_else(|| "unassigned".to_owned());
            let matched = wanted.as_ref().is_some_and(|wanted| {
                self.hosts.iter().any(|candidate| {
                    candidate.name == *wanted
                        || candidate.address == *wanted
                        || candidate.private_ip == *wanted
                })
            });
            if wanted.is_some() && !matched {
                self.warn(
                    plan_codes::NO_HOST_FOR_ROLE,
                    "sandbox.host".to_owned(),
                    "sandbox.host does not match a host; the sandbox core is planned on the first core host"
                        .to_owned(),
                );
            }
            let mut sandbox_dependencies = Vec::new();
            if fake_rails_enabled {
                sandbox_dependencies.push("pg-fake-rails-back".to_owned());
            }
            if pgbouncer {
                sandbox_dependencies.push("pg-pgbouncer".to_owned());
            } else if self
                .services
                .iter()
                .any(|service| service.name == "pg-postgres-primary")
            {
                sandbox_dependencies.push("pg-postgres-primary".to_owned());
            }
            self.plan_core_instance(
                "pg-core-sandbox",
                &host,
                implementation,
                sandbox_port,
                &sandbox_dependencies,
            );
        }
    }

    /// One core instance, honouring `impl = ts | rs | both` (chapter 7 §10: the Rust core listens on
    /// 4010/4015 beside the TypeScript core on 4000/4005 when both run).
    fn plan_core_instance(
        &mut self,
        base: &str,
        host: &str,
        implementation: ImplKind,
        port: u16,
        dependencies: &[String],
    ) {
        match implementation {
            ImplKind::Both => {
                let rust_port = if base.contains("sandbox") {
                    CORE_RS_COEXIST_SANDBOX_PORT
                } else {
                    CORE_RS_COEXIST_PORT
                };
                self.push(
                    base.to_owned(),
                    host.to_owned(),
                    ImplKind::Ts,
                    port,
                    "",
                    dependencies.to_vec(),
                    1,
                );
                self.push(
                    format!("{base}-rs"),
                    host.to_owned(),
                    ImplKind::Rs,
                    rust_port,
                    "",
                    dependencies.to_vec(),
                    1,
                );
            }
            other => self.push(
                base.to_owned(),
                host.to_owned(),
                other,
                port,
                "",
                dependencies.to_vec(),
                1,
            ),
        }
    }

    fn plan_edges(&mut self) {
        if !self.config.services.edges.enabled {
            self.warn(
                plan_codes::SERVICE_DISABLED,
                "services.edges".to_owned(),
                "the edge tier is disabled".to_owned(),
            );
            return;
        }
        let implementation = self.config.services.edges.implementation;
        let replicas = self.config.services.edges.replicas;
        let admin = self.config.services.edges.admin.clone();
        let merchant = self.config.services.edges.merchant.clone();
        let checkout = self.config.services.edges.checkout.clone();
        let mut core_dependencies = self.names_starting_with("pg-core-back");
        core_dependencies.extend(self.names_starting_with("pg-core-sandbox"));
        if admin.enabled {
            self.plan_edge(
                "admin",
                Role::Admin,
                implementation,
                replicas,
                &core_dependencies,
                admin.port,
                admin.nginx_port,
            );
        }
        if merchant.enabled {
            self.plan_edge(
                "merchant",
                Role::Merchant,
                implementation,
                replicas,
                &core_dependencies,
                merchant.port,
                merchant.nginx_port,
            );
        }
        if checkout.enabled {
            self.plan_edge(
                "checkout",
                Role::Checkout,
                implementation,
                replicas,
                &core_dependencies,
                checkout.port,
                checkout.nginx_port,
            );
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn plan_edge(
        &mut self,
        portal: &str,
        role: Role,
        implementation: ImplKind,
        replicas: u16,
        core_dependencies: &[String],
        backend_port: u16,
        nginx_port: u16,
    ) {
        let placements = self.placement(&format!("pg-{portal}-back"), role, replicas);
        let multi = placements.len() > 1;
        let mut backends = Vec::new();
        for (name, host) in placements {
            let port = if multi {
                backend_port
            } else {
                self.port_for(&host, role, backend_port)
            };
            backends.push(name.clone());
            self.push(
                name,
                host,
                implementation,
                port,
                "",
                core_dependencies.to_vec(),
                1,
            );
        }
        // One nginx site per backend node, named after the backend.
        for backend in backends {
            let host = self
                .services
                .iter()
                .find(|service| service.name == backend)
                .map(|service| service.host.clone())
                .unwrap_or_else(|| "unassigned".to_owned());
            let name = backend.replacen("-back", "-nginx", 1);
            self.push(
                name,
                host,
                implementation,
                nginx_port,
                "nginx",
                vec![backend],
                1,
            );
        }
    }

    fn plan_fake_rails(&mut self) {
        let enabled = self.config.services.fake_rails.enabled;
        let implementation = self.config.services.fake_rails.implementation;
        let port = self.config.services.fake_rails.port;
        let nginx_port = self.config.services.fake_rails.nginx_port;
        let replicas = self.config.services.fake_rails.replicas;
        if !enabled {
            return;
        }
        let placements = self.placement("pg-fake-rails-back", Role::FakeRails, replicas);
        let multi = placements.len() > 1;
        for (name, host) in placements {
            let backend_port = if multi {
                port
            } else {
                self.port_for(&host, Role::FakeRails, port)
            };
            self.push(
                name.clone(),
                host.clone(),
                implementation,
                backend_port,
                "",
                Vec::new(),
                1,
            );
            self.push(
                name.replacen("-back", "-nginx", 1),
                host,
                implementation,
                nginx_port,
                "nginx",
                vec![name],
                1,
            );
        }
    }

    fn plan_backup(&mut self) {
        let enabled = self.config.services.backup.enabled;
        let implementation = self.config.services.backup.implementation;
        let port = self.config.services.backup.port;
        if !enabled {
            return;
        }
        let placements = self.placement("pg-backup-daemon", Role::Backup, 1);
        let mut dependencies = Vec::new();
        if self
            .services
            .iter()
            .any(|service| service.name == "pg-postgres-primary")
        {
            dependencies.push("pg-postgres-primary".to_owned());
        }
        if self
            .services
            .iter()
            .any(|service| service.name == "pg-object-storage-daemon")
        {
            dependencies.push("pg-object-storage-daemon".to_owned());
        }
        for (name, host) in placements {
            let backend_port = self.port_for(&host, Role::Backup, port);
            self.push(
                name,
                host,
                implementation,
                backend_port,
                "",
                dependencies.clone(),
                1,
            );
        }
    }

    fn plan_object_storage(&mut self) {
        let enabled = self.config.services.object_storage.enabled;
        let implementation = self.config.services.object_storage.implementation;
        let port = self.config.services.object_storage.port;
        if !enabled {
            return;
        }
        let placements = self.placement("pg-object-storage-daemon", Role::ObjectStorage, 1);
        for (name, host) in placements {
            let backend_port = self.port_for(&host, Role::ObjectStorage, port);
            self.push(name, host, implementation, backend_port, "", Vec::new(), 1);
        }
    }

    fn finish(mut self) -> Plan {
        self.services
            .sort_by(|left, right| left.name.cmp(&right.name));
        let names: Vec<String> = self
            .services
            .iter()
            .map(|service| service.name.clone())
            .collect();
        for service in &mut self.services {
            service
                .depends_on
                .retain(|dependency| names.contains(dependency));
            service.depends_on.sort();
            service.depends_on.dedup();
        }
        let core_pools = self.build_core_pools();
        let live_urls = core_pools
            .iter()
            .find(|pool| pool.plane == Plane::Live)
            .map(|pool| pool.urls.clone())
            .unwrap_or_default();
        let sandbox_urls = core_pools
            .iter()
            .find(|pool| pool.plane == Plane::Sandbox)
            .map(|pool| pool.urls.clone())
            .unwrap_or_default();
        for service in &mut self.services {
            if is_edge_backend(&service.name) {
                service.upstreams = live_urls.clone();
                service.sandbox_upstreams = sandbox_urls.clone();
            }
        }
        for host in &mut self.hosts {
            host.services = self
                .services
                .iter()
                .filter(|service| service.host == host.name)
                .map(|service| service.name.clone())
                .collect();
            host.services.sort();
        }
        self.hosts.sort_by(|left, right| {
            left.deploy_order
                .cmp(&right.deploy_order)
                .then_with(|| left.name.cmp(&right.name))
        });
        Plan {
            hosts: self.hosts,
            services: self.services,
            core_pools,
            warnings: self.warnings,
        }
    }

    fn build_core_pools(&self) -> Vec<CorePool> {
        let mut pools = Vec::new();
        for (plane, base) in [
            (Plane::Live, "pg-core-back"),
            (Plane::Sandbox, "pg-core-sandbox"),
        ] {
            let mut members: Vec<&PlannedService> = self
                .services
                .iter()
                .filter(|service| belongs_to_core(&service.name, base))
                .collect();
            members.sort_by(|left, right| left.name.cmp(&right.name));
            if members.is_empty() {
                continue;
            }
            let ts: Vec<String> = members
                .iter()
                .filter(|service| service.impl_ != ImplKind::Rs)
                .map(|service| service.name.clone())
                .collect();
            let rust: Vec<String> = members
                .iter()
                .filter(|service| service.impl_ == ImplKind::Rs)
                .map(|service| service.name.clone())
                .collect();
            let mut urls = Vec::new();
            for name in ts.iter().chain(rust.iter()) {
                if let Some(service) = members.iter().find(|service| &service.name == name) {
                    if let Some(host) = self.hosts.iter().find(|host| host.name == service.host) {
                        urls.push(url_for(&host.private_ip, service.port));
                    }
                }
            }
            pools.push(CorePool {
                plane,
                ts,
                rust,
                urls,
            });
        }
        pools
    }
}

/// True when a service name belongs to a core tier (`pg-core-back`, `pg-core-back-core-1-rs`, ...).
fn belongs_to_core(name: &str, base: &str) -> bool {
    match name.strip_prefix(base) {
        Some("") => true,
        Some(rest) => rest.starts_with('-'),
        None => false,
    }
}

/// Edge backends receive the core pool URLs in their environment.
fn is_edge_backend(name: &str) -> bool {
    name.starts_with("pg-admin-back")
        || name.starts_with("pg-merchant-back")
        || name.starts_with("pg-checkout-back")
}

/// `https://<ip>:<port>` with IPv6 brackets.
fn url_for(ip: &str, port: u16) -> String {
    if ip.contains(':') && !ip.starts_with('[') {
        format!("https://[{ip}]:{port}")
    } else {
        format!("https://{ip}:{port}")
    }
}

/// Lowercase slug used in service and host suffixes (port of the TS `slug`).
#[must_use]
pub fn slug(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.trim().to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-') {
            out.push(ch);
        } else {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-').to_owned();
    if trimmed.is_empty() {
        "node".to_owned()
    } else {
        trimmed
    }
}

/// The health-check kind a service gets (used by [`crate::verify`]).
#[must_use]
pub fn check_kind_for(service: &str) -> CheckKind {
    if service.starts_with("pg-core")
        || service == "pg-backup-daemon"
        || service == "pg-object-storage-daemon"
    {
        CheckKind::MtlsHealth
    } else if service.ends_with("-nginx") {
        if service.starts_with("pg-fake-rails") {
            CheckKind::HttpHealth
        } else {
            CheckKind::HttpsHealth
        }
    } else if service.ends_with("-back") {
        CheckKind::HttpHealth
    } else {
        CheckKind::TcpConnect
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pg_deploy_config::{Environment, Host, PgctlConfig};

    fn host(name: &str, role: Role, address: &str) -> Host {
        Host {
            name: name.to_owned(),
            address: address.to_owned(),
            roles: vec![role],
            private_ip: address.to_owned(),
            ..Host::default()
        }
    }

    fn single_host() -> PgctlConfig {
        let mut config = PgctlConfig::new(Environment::Development);
        config.hosts = vec![
            host("db-1", Role::PgPrimary, "10.0.0.21"),
            host("core-1", Role::Core, "10.0.0.11"),
            host("admin-1", Role::Admin, "10.0.0.30"),
            host("merchant-1", Role::Merchant, "203.0.113.10"),
            host("checkout-1", Role::Checkout, "203.0.113.20"),
        ];
        config.database.mode = pg_deploy_config::DatabaseMode::Managed;
        config.database.host = Some("10.0.0.21".to_owned());
        config.database.tls = true;
        config
    }

    #[test]
    fn default_services_use_the_verified_ports() {
        let plan = plan(&single_host());
        assert_eq!(
            plan.service("pg-postgres-primary").map(|s| s.port),
            Some(5432)
        );
        assert_eq!(plan.service("pg-core-back").map(|s| s.port), Some(4000));
        assert_eq!(plan.service("pg-admin-back").map(|s| s.port), Some(4101));
        assert_eq!(plan.service("pg-merchant-back").map(|s| s.port), Some(4102));
        assert_eq!(plan.service("pg-checkout-back").map(|s| s.port), Some(4103));
        assert_eq!(plan.service("pg-admin-nginx").map(|s| s.port), Some(8443));
        assert_eq!(plan.service("pg-merchant-nginx").map(|s| s.port), Some(443));
        assert_eq!(plan.service("pg-checkout-nginx").map(|s| s.port), Some(443));
        assert_eq!(
            plan.service("pg-postgres-primary")
                .map(|s| s.systemd_unit.as_str()),
            Some("postgresql")
        );
    }

    #[test]
    fn sandbox_fake_rails_backup_and_object_storage_are_planned() {
        let mut config = single_host();
        config.sandbox.enabled = true;
        config.services.fake_rails.enabled = true;
        config.services.fake_rails.allow_in_production = true;
        config.services.backup.enabled = true;
        config.services.object_storage.enabled = true;
        config
            .hosts
            .push(host("backup-1", Role::Backup, "10.0.0.60"));
        config
            .hosts
            .push(host("obj-1", Role::ObjectStorage, "10.0.0.50"));
        config.database.pgbouncer = true;
        config.redis.enabled = true;
        config.hosts.push(host("redis-1", Role::Redis, "10.0.0.70"));
        let plan = plan(&config);

        assert_eq!(plan.service("pg-core-sandbox").map(|s| s.port), Some(4005));
        assert_eq!(
            plan.service("pg-fake-rails-back").map(|s| s.port),
            Some(4104)
        );
        assert_eq!(
            plan.service("pg-fake-rails-nginx").map(|s| s.port),
            Some(8444)
        );
        assert_eq!(plan.service("pg-backup-daemon").map(|s| s.port), Some(4090));
        assert_eq!(
            plan.service("pg-object-storage-daemon").map(|s| s.port),
            Some(4095)
        );
        assert_eq!(plan.service("pg-pgbouncer").map(|s| s.port), Some(6432));
        assert_eq!(plan.service("pg-redis").map(|s| s.port), Some(6379));
        assert_eq!(
            plan.service("pg-core-sandbox").map(|s| s.host.as_str()),
            Some("core-1")
        );
        assert!(plan
            .service("pg-backup-daemon")
            .expect("backup planned")
            .depends_on
            .contains(&"pg-object-storage-daemon".to_owned()));
    }

    #[test]
    fn a_multi_node_tier_suffixes_every_node_including_the_first() {
        let mut config = single_host();
        config.hosts.push(host("core-2", Role::Core, "10.0.0.12"));
        let plan = plan(&config);
        let names: Vec<&str> = plan
            .services
            .iter()
            .map(|service| service.name.as_str())
            .filter(|name| name.starts_with("pg-core-back"))
            .collect();
        assert_eq!(names, vec!["pg-core-back-core-1", "pg-core-back-core-2"]);
        assert!(plan.service("pg-core-back").is_none());
    }

    #[test]
    fn one_host_with_two_replicas_is_numbered() {
        let mut config = single_host();
        config.services.core.replicas = 2;
        let plan = plan(&config);
        assert!(plan.service("pg-core-back-1").is_some());
        assert!(plan.service("pg-core-back-2").is_some());
        assert!(plan.service("pg-core-back").is_none());
    }

    #[test]
    fn host_service_ports_override_the_defaults() {
        let mut config = single_host();
        config.hosts[1].service_port = Some(4010);
        let plan = plan(&config);
        assert_eq!(plan.service("pg-core-back").map(|s| s.port), Some(4010));
    }

    #[test]
    fn every_dependency_exists_and_hosts_list_their_services() {
        let mut config = single_host();
        config.services.fake_rails.enabled = true;
        config.services.fake_rails.allow_in_production = true;
        config.sandbox.enabled = true;
        let plan = plan(&config);
        let names: Vec<&str> = plan
            .services
            .iter()
            .map(|service| service.name.as_str())
            .collect();
        for service in &plan.services {
            for dependency in &service.depends_on {
                assert!(
                    names.contains(&dependency.as_str()),
                    "{} -> {dependency}",
                    service.name
                );
            }
        }
        for host in &plan.hosts {
            for service in &host.services {
                assert!(names.contains(&service.as_str()));
                assert_eq!(
                    plan.service(service).map(|s| s.host.as_str()),
                    Some(host.name.as_str())
                );
            }
        }
        // Edges depend on the core (and the sandbox core when enabled).
        let admin = plan.service("pg-admin-back").expect("admin planned");
        assert!(admin.depends_on.contains(&"pg-core-back".to_owned()));
        assert!(admin.depends_on.contains(&"pg-core-sandbox".to_owned()));
    }

    #[test]
    fn missing_role_falls_back_with_a_warning_instead_of_failing() {
        let mut config = PgctlConfig::new(Environment::Development);
        config.hosts = vec![host("core-1", Role::Core, "10.0.0.11")];
        let plan = plan(&config);
        assert_eq!(
            plan.service("pg-admin-back").map(|s| s.host.as_str()),
            Some("core-1")
        );
        assert!(plan
            .warnings
            .iter()
            .any(|warning| warning.code == plan_codes::NO_HOST_FOR_ROLE));
    }

    #[test]
    fn no_hosts_plans_unassigned_services_with_an_error() {
        let plan = plan(&PgctlConfig::default());
        assert!(plan.hosts.is_empty());
        assert_eq!(
            plan.service("pg-core-back").map(|s| s.host.as_str()),
            Some("unassigned")
        );
        assert!(
            plan.has_errors(),
            "validation errors must be attached to the plan"
        );
    }

    #[test]
    fn validation_errors_are_carried_as_warnings() {
        let mut config = single_host();
        config.services.edges.admin.port = 4000;
        let plan = plan(&config);
        assert!(plan
            .warnings
            .iter()
            .any(|warning| warning.code == "PORT_COLLISION"));
        assert!(plan.has_errors());
    }

    #[test]
    fn storage_is_only_planned_when_it_exists() {
        let mut config = single_host();
        config.database.mode = pg_deploy_config::DatabaseMode::External;
        config
            .hosts
            .retain(|host| !host.roles.contains(&Role::PgPrimary));
        let plan = plan(&config);
        assert!(plan.service("pg-postgres-primary").is_none());
        assert!(plan.service("pg-core-back").is_some());
    }

    #[test]
    fn slugs_are_stable() {
        assert_eq!(slug("Core 1"), "core-1");
        assert_eq!(slug("--"), "node");
        assert_eq!(slug("obj_1.edge"), "obj_1.edge");
    }

    #[test]
    fn host_order_matches_the_ts_role_order() {
        let mut config = single_host();
        config
            .hosts
            .push(host("fake-1", Role::FakeRails, "10.0.0.40"));
        config.services.fake_rails.enabled = true;
        config.services.fake_rails.allow_in_production = true;
        let plan = plan(&config);
        let order: Vec<&str> = plan.hosts.iter().map(|host| host.name.as_str()).collect();
        assert_eq!(
            order,
            vec![
                "db-1",
                "core-1",
                "fake-1",
                "admin-1",
                "merchant-1",
                "checkout-1"
            ]
        );
    }
}

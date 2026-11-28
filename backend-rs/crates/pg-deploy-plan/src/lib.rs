//! Desired-state planner, systemd renderer and verification list for `pgctl`.
//!
//! Ports: `deploy/lib/hostPlanner.ts` (`planHosts`, role grouping, service names and ports),
//! `deploy/deploy.ts` (step order and restart decisions) and chapter 7 §10/§13.
//!
//! `pg-deploy-plan` is pure: it reads a [`pg_deploy_config::PgctlConfig`] and returns data. No SSH,
//! no filesystem, no clock, so `pgctl plan --json` is deterministic and golden-comparable with the
//! TypeScript planner (D0-T03).
//!
//! ```no_run
//! use pg_deploy_config::load_toml_file;
//! use pg_deploy_plan::plan;
//!
//! let Ok(config) = load_toml_file(std::path::Path::new("pgctl.toml")) else {
//!     return;
//! };
//! let desired = plan(&config);
//! for service in &desired.services {
//!     println!("{} on {}:{}", service.name, service.host, service.port);
//! }
//! ```

#![forbid(unsafe_code)]

pub mod diff;
pub mod plan;
pub mod route;
pub mod storage;
pub mod systemd;
pub mod verify;

pub use diff::{plan_diff, ChangeKind, PlanDiff, RestartPlan, ServiceDiff, ServiceView};
pub use plan::{
    check_kind_for, plan, plan_codes, role_order, slug, CorePool, Plan, PlanWarning, Plane,
    PlannedHost, PlannedService,
};
pub use route::{
    route_table, route_table_json, workers_document, workers_json, CoreRoutes, EdgeRoutes,
    RouteTable, WorkerEntry, WorkerTarget, WorkersDocument, GENERATOR, ROUTE_TABLE_SCHEMA,
    WORKERS_SCHEMA,
};
pub use storage::{
    plan_all_storage, plan_storage, ProvisionFinding, ProvisionHost, ProvisionMode, ProvisionPlan,
    ProvisionStep, ProvisionTarget, StorageConfigFile, StorageOverrides, StorageSettings,
};
pub use systemd::{
    credentials_for, is_provisioner_managed, render_systemd_unit,
    render_systemd_unit_with_credentials, writable_path, Credential,
};
pub use verify::{verification_checks, CheckKind, VerificationCheck};

#[cfg(test)]
mod tests {
    use super::*;
    use pg_deploy_config::{Environment, Host, PgctlConfig, Role, Severity};

    fn example() -> PgctlConfig {
        let mut config = PgctlConfig::new(Environment::Development);
        config.hosts = vec![
            Host {
                name: "db-1".to_owned(),
                address: "10.0.0.21".to_owned(),
                roles: vec![Role::PgPrimary],
                private_ip: "10.0.0.21".to_owned(),
                ..Host::default()
            },
            Host {
                name: "core-1".to_owned(),
                address: "10.0.0.11".to_owned(),
                roles: vec![Role::Core],
                private_ip: "10.0.0.11".to_owned(),
                ..Host::default()
            },
            Host {
                name: "admin-1".to_owned(),
                address: "10.0.0.30".to_owned(),
                roles: vec![Role::Admin],
                private_ip: "10.0.0.30".to_owned(),
                ..Host::default()
            },
        ];
        config.database.mode = pg_deploy_config::DatabaseMode::Managed;
        config.database.host = Some("10.0.0.21".to_owned());
        config.database.tls = true;
        config
    }

    #[test]
    fn the_public_api_composes() {
        let config = example();
        let desired = plan(&config);
        assert!(!desired.services.is_empty());
        let units: Vec<String> = desired.services.iter().map(render_systemd_unit).collect();
        assert!(units.iter().any(|unit| unit.contains("core-rs")));
        let checks = verification_checks(&desired);
        assert!(!checks.is_empty());
        let diff = plan_diff(&desired, &desired);
        assert!(diff.is_empty());
        assert!(desired
            .warnings
            .iter()
            .all(|warning| warning.severity == Severity::Warning));
        assert_eq!(role_order(Role::Core), 2);
        assert_eq!(slug("Core 1"), "core-1");
        assert_eq!(check_kind_for("pg-core-back"), CheckKind::MtlsHealth);
        assert!(is_provisioner_managed("pg-postgres-primary"));
        assert_eq!(plan_codes::NO_HOSTS, "NO_HOSTS");
    }
}

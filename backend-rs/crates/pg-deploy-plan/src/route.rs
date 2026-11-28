//! Route table and worker handover documents (D2-T02).
//!
//! During coexistence (`impl = "both"`) each edge receives both core pools (TypeScript on 4000/4005,
//! Rust on 4010/4015) and each worker is owned by exactly one implementation. These documents are
//! the artefacts `pgctl route-table` and `pgctl workers handover` render and push:
//!
//! - `route-table.json`: the upstream pools per edge, live and sandbox, in deterministic order;
//! - `workers.json`: every configured worker with the implementation that owns it.
//!
//! Both are plain JSON (no timestamps, no host ordering surprises) so they can be diffed and
//! golden-tested.

#![forbid(unsafe_code)]

use serde::Serialize;

use pg_deploy_config::{ImplKind, PgctlConfig};

use crate::plan::{Plan, Plane};

/// Document version of `route-table.json`.
pub const ROUTE_TABLE_SCHEMA: u32 = 1;
/// Document version of `workers.json`.
pub const WORKERS_SCHEMA: u32 = 1;
/// Generator marker so a stale file is recognisable.
pub const GENERATOR: &str = "pgctl";

/// One core plane in the route table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CoreRoutes {
    /// `live` or `sandbox`.
    pub plane: &'static str,
    /// TypeScript core services.
    pub ts: Vec<String>,
    /// Rust core services.
    pub rust: Vec<String>,
    /// Upstream URLs (TypeScript first, then Rust).
    pub urls: Vec<String>,
}

/// One edge's upstream pools.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EdgeRoutes {
    /// Edge backend service name (`pg-admin-back`, ...).
    pub name: String,
    /// Host name.
    pub host: String,
    /// Live core pool.
    pub upstreams: Vec<String>,
    /// Sandbox core pool (empty without a sandbox plane).
    pub sandbox_upstreams: Vec<String>,
}

/// `route-table.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RouteTable {
    /// Document version.
    pub schema: u32,
    /// Always `pgctl`.
    pub generator: &'static str,
    /// Installation name.
    pub deployment: String,
    /// Environment.
    pub environment: String,
    /// Core pools, live first.
    pub cores: Vec<CoreRoutes>,
    /// Edge pools, sorted by name.
    pub edges: Vec<EdgeRoutes>,
}

/// Which implementation owns the workers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerTarget {
    /// TypeScript (PM2) owns them.
    Ts,
    /// Rust (systemd) owns them.
    Rs,
}

impl WorkerTarget {
    /// Parse `ts`/`rs` (`rust` accepted as an alias).
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        match value.to_ascii_lowercase().as_str() {
            "ts" => Some(Self::Ts),
            "rs" | "rust" => Some(Self::Rs),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ts => "ts",
            Self::Rs => "rs",
        }
    }

    fn implementation(self) -> ImplKind {
        match self {
            Self::Ts => ImplKind::Ts,
            Self::Rs => ImplKind::Rs,
        }
    }
}

/// One worker assignment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorkerEntry {
    /// Worker name (`OutboxRelayWorker`, ...).
    pub name: String,
    /// Owning implementation (`ts` or `rs`).
    pub implementation: ImplKind,
}

/// `workers.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorkersDocument {
    /// Document version.
    pub schema: u32,
    /// Always `pgctl`.
    pub generator: &'static str,
    /// Installation name.
    pub deployment: String,
    /// Target implementation.
    pub target: &'static str,
    /// Workers, sorted and deduplicated.
    pub workers: Vec<WorkerEntry>,
}

/// Build the route table for a plan.
#[must_use]
pub fn route_table(config: &PgctlConfig, plan: &Plan) -> RouteTable {
    let cores = plan
        .core_pools
        .iter()
        .map(|pool| CoreRoutes {
            plane: match pool.plane {
                Plane::Live => "live",
                Plane::Sandbox => "sandbox",
            },
            ts: pool.ts.clone(),
            rust: pool.rust.clone(),
            urls: pool.urls.clone(),
        })
        .collect();
    let mut edges: Vec<EdgeRoutes> = plan
        .services
        .iter()
        .filter(|service| !service.upstreams.is_empty() || !service.sandbox_upstreams.is_empty())
        .map(|service| EdgeRoutes {
            name: service.name.clone(),
            host: service.host.clone(),
            upstreams: service.upstreams.clone(),
            sandbox_upstreams: service.sandbox_upstreams.clone(),
        })
        .collect();
    edges.sort_by(|left, right| left.name.cmp(&right.name));
    RouteTable {
        schema: ROUTE_TABLE_SCHEMA,
        generator: GENERATOR,
        deployment: config.deployment.name.clone(),
        environment: config.deployment.environment.as_str().to_owned(),
        cores,
        edges,
    }
}

/// Serialise the route table: pretty JSON with a trailing newline, stable field order.
pub fn route_table_json(config: &PgctlConfig, plan: &Plan) -> serde_json::Result<String> {
    let mut text = serde_json::to_string_pretty(&route_table(config, plan))?;
    text.push('\n');
    Ok(text)
}

/// Build the worker handover document.
#[must_use]
pub fn workers_document(config: &PgctlConfig, target: WorkerTarget) -> WorkersDocument {
    let mut names = config.services.core.workers.clone();
    names.sort();
    names.dedup();
    WorkersDocument {
        schema: WORKERS_SCHEMA,
        generator: GENERATOR,
        deployment: config.deployment.name.clone(),
        target: target.as_str(),
        workers: names
            .into_iter()
            .map(|name| WorkerEntry {
                name,
                implementation: target.implementation(),
            })
            .collect(),
    }
}

/// Serialise the worker document.
pub fn workers_json(config: &PgctlConfig, target: WorkerTarget) -> serde_json::Result<String> {
    let mut text = serde_json::to_string_pretty(&workers_document(config, target))?;
    text.push('\n');
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plan::plan;
    use pg_deploy_config::{Environment, Host, Role};

    fn host(name: &str, role: Role, ip: &str) -> Host {
        Host {
            name: name.to_owned(),
            address: ip.to_owned(),
            roles: vec![role],
            private_ip: ip.to_owned(),
            ..Host::default()
        }
    }

    fn mixed() -> PgctlConfig {
        let mut config = PgctlConfig::new(Environment::Development);
        config.deployment.name = "lab".to_owned();
        config.hosts = vec![
            host("core-1", Role::Core, "10.0.0.11"),
            host("admin-1", Role::Admin, "10.0.0.30"),
            host("merchant-1", Role::Merchant, "10.0.0.40"),
            host("checkout-1", Role::Checkout, "10.0.0.50"),
        ];
        config.services.core.implementation = ImplKind::Both;
        config.sandbox.enabled = true;
        config.services.core.workers = vec![
            "OutboxRelayWorker".to_owned(),
            "LedgerCheckpointWorker".to_owned(),
            "OutboxRelayWorker".to_owned(),
        ];
        config
    }

    #[test]
    fn mixed_impl_plans_both_cores_and_pools() {
        let config = mixed();
        let desired = plan(&config);
        assert_eq!(desired.service("pg-core-back").map(|s| s.port), Some(4000));
        assert_eq!(
            desired.service("pg-core-back").map(|s| s.impl_),
            Some(ImplKind::Ts)
        );
        assert_eq!(
            desired.service("pg-core-back-rs").map(|s| s.port),
            Some(4010)
        );
        assert_eq!(
            desired.service("pg-core-back-rs").map(|s| s.impl_),
            Some(ImplKind::Rs)
        );
        assert_eq!(
            desired.service("pg-core-sandbox-rs").map(|s| s.port),
            Some(4015)
        );
        let live = desired
            .core_pools
            .iter()
            .find(|pool| pool.plane == Plane::Live)
            .expect("live pool");
        assert_eq!(live.urls.len(), 2);
        assert_eq!(live.urls[0], "https://10.0.0.11:4000");
        assert_eq!(live.urls[1], "https://10.0.0.11:4010");
        let admin = desired.service("pg-admin-back").expect("admin");
        assert_eq!(admin.upstreams, live.urls);
        assert_eq!(
            admin.sandbox_upstreams,
            vec![
                "https://10.0.0.11:4005".to_owned(),
                "https://10.0.0.11:4015".to_owned()
            ]
        );
    }

    #[test]
    fn route_table_is_deterministic_and_lists_edges() {
        let config = mixed();
        let desired = plan(&config);
        let first = route_table_json(&config, &desired).expect("json");
        let second = route_table_json(&config, &desired).expect("json");
        assert_eq!(first, second);
        assert!(first.ends_with('\n'));
        let parsed: serde_json::Value = serde_json::from_str(&first).expect("valid json");
        assert_eq!(parsed["schema"], 1);
        assert_eq!(parsed["generator"], "pgctl");
        assert_eq!(parsed["deployment"], "lab");
        assert_eq!(parsed["cores"][0]["plane"], "live");
        let edges = parsed["edges"].as_array().expect("edges");
        assert_eq!(edges.len(), 3);
        let names: Vec<&str> = edges
            .iter()
            .filter_map(|edge| edge["name"].as_str())
            .collect();
        assert_eq!(
            names,
            vec!["pg-admin-back", "pg-checkout-back", "pg-merchant-back"]
        );
    }

    #[test]
    fn workers_handover_is_sorted_and_targeted() {
        let config = mixed();
        let text = workers_json(&config, WorkerTarget::Rs).expect("json");
        let parsed: serde_json::Value = serde_json::from_str(&text).expect("valid json");
        assert_eq!(parsed["schema"], 1);
        assert_eq!(parsed["target"], "rs");
        assert_eq!(parsed["workers"][0]["name"], "LedgerCheckpointWorker");
        assert_eq!(parsed["workers"][0]["implementation"], "rs");
        assert_eq!(parsed["workers"].as_array().expect("workers").len(), 2);
        let ts = workers_document(&config, WorkerTarget::Ts);
        assert_eq!(ts.workers[0].implementation, ImplKind::Ts);
        assert_eq!(WorkerTarget::parse("rust"), Some(WorkerTarget::Rs));
        assert_eq!(WorkerTarget::parse("nope"), None);
    }

    #[test]
    fn a_typescript_only_plan_has_one_url_per_plane() {
        let mut config = mixed();
        config.services.core.implementation = ImplKind::Ts;
        let desired = plan(&config);
        let live = desired
            .core_pools
            .iter()
            .find(|pool| pool.plane == Plane::Live)
            .expect("live pool");
        assert_eq!(live.urls, vec!["https://10.0.0.11:4000".to_owned()]);
        assert!(live.rust.is_empty());
        assert!(desired.service("pg-core-back-rs").is_none());
    }
}

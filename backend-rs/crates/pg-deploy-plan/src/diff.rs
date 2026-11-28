//! Plan diff for `update`, rolling and restart decisions.
//!
//! Port of the "what changed" logic that the TypeScript engine spread across `deploy.ts`: which
//! service is new, which disappeared, which moved host or port, and whether the change can use the
//! single-node zero-downtime hand-off of chapter 7 §10 (SO_REUSEPORT, new process binds the same
//! port, health, drain, swap) or must roll in batches because the tier has several replicas.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;

use serde::Serialize;

use pg_deploy_config::ImplKind;

use crate::plan::{Plan, PlannedService};

/// What happened to one service.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChangeKind {
    /// The service is not running yet.
    Added,
    /// The service is no longer desired.
    Removed,
    /// The service exists with at least one different field.
    Changed,
    /// Identical.
    Unchanged,
}

/// How to apply the change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RestartPlan {
    /// Nothing to do.
    Nothing,
    /// Start a new service.
    Start,
    /// Stop a service that is no longer desired.
    Stop,
    /// Single instance: start the new one beside the old (SO_REUSEPORT), drain, swap.
    ZeroDowntime,
    /// Several replicas: apply in rolling batches.
    Rolling,
}

/// The comparable fields of a service.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ServiceView {
    /// Service name.
    pub name: String,
    /// Host name.
    pub host: String,
    /// Listener port.
    pub port: u16,
    /// Implementation.
    #[serde(rename = "impl")]
    pub implementation: ImplKind,
    /// Instances.
    pub replicas: u16,
}

impl ServiceView {
    fn of(service: &PlannedService) -> Self {
        Self {
            name: service.name.clone(),
            host: service.host.clone(),
            port: service.port,
            implementation: service.impl_,
            replicas: service.replicas,
        }
    }
}

/// One service difference.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ServiceDiff {
    /// Service name.
    pub name: String,
    /// Added, removed, changed or unchanged.
    pub kind: ChangeKind,
    /// Changed fields (`host`, `port`, `impl`, `replicas`), empty when not `Changed`.
    pub fields: Vec<&'static str>,
    /// Previous state.
    pub previous: Option<ServiceView>,
    /// Desired state.
    pub desired: Option<ServiceView>,
    /// How to apply it.
    pub restart: RestartPlan,
}

/// The whole diff.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PlanDiff {
    /// Differences, including `Unchanged` entries, sorted by name.
    pub changes: Vec<ServiceDiff>,
    /// Names that did not change.
    pub unchanged: Vec<String>,
    /// True when at least one changed tier needs rolling batches.
    pub requires_rolling: bool,
    /// True when anything at all must be started, stopped or restarted.
    pub requires_restart: bool,
}

impl PlanDiff {
    /// True when `current` and `desired` are identical.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.changes
            .iter()
            .all(|change| change.kind == ChangeKind::Unchanged)
    }

    /// Only the services that changed, added or removed.
    #[must_use]
    pub fn actionable(&self) -> Vec<&ServiceDiff> {
        self.changes
            .iter()
            .filter(|change| change.kind != ChangeKind::Unchanged)
            .collect()
    }
}

/// Compare two plans by service name.
#[must_use]
pub fn plan_diff(current: &Plan, desired: &Plan) -> PlanDiff {
    let current_by_name: BTreeMap<&str, &PlannedService> = current
        .services
        .iter()
        .map(|service| (service.name.as_str(), service))
        .collect();
    let desired_by_name: BTreeMap<&str, &PlannedService> = desired
        .services
        .iter()
        .map(|service| (service.name.as_str(), service))
        .collect();

    let mut names: Vec<&str> = current_by_name.keys().copied().collect();
    names.extend(desired_by_name.keys().copied());
    names.sort_unstable();
    names.dedup();

    let mut changes = Vec::new();
    let mut unchanged = Vec::new();
    for name in names {
        let previous = current_by_name.get(name).copied();
        let target = desired_by_name.get(name).copied();
        let diff = match (previous, target) {
            (None, Some(target)) => ServiceDiff {
                name: name.to_owned(),
                kind: ChangeKind::Added,
                fields: Vec::new(),
                previous: None,
                desired: Some(ServiceView::of(target)),
                restart: RestartPlan::Start,
            },
            (Some(previous), None) => ServiceDiff {
                name: name.to_owned(),
                kind: ChangeKind::Removed,
                fields: Vec::new(),
                previous: Some(ServiceView::of(previous)),
                desired: None,
                restart: RestartPlan::Stop,
            },
            (Some(previous), Some(target)) => {
                let mut fields = Vec::new();
                if previous.host != target.host {
                    fields.push("host");
                }
                if previous.port != target.port {
                    fields.push("port");
                }
                if previous.impl_ != target.impl_ {
                    fields.push("impl");
                }
                if previous.replicas != target.replicas {
                    fields.push("replicas");
                }
                if fields.is_empty() {
                    unchanged.push(name.to_owned());
                    ServiceDiff {
                        name: name.to_owned(),
                        kind: ChangeKind::Unchanged,
                        fields,
                        previous: Some(ServiceView::of(previous)),
                        desired: Some(ServiceView::of(target)),
                        restart: RestartPlan::Nothing,
                    }
                } else {
                    ServiceDiff {
                        name: name.to_owned(),
                        kind: ChangeKind::Changed,
                        fields,
                        previous: Some(ServiceView::of(previous)),
                        desired: Some(ServiceView::of(target)),
                        restart: if target.replicas > 1 {
                            RestartPlan::Rolling
                        } else {
                            RestartPlan::ZeroDowntime
                        },
                    }
                }
            }
            (None, None) => continue,
        };
        changes.push(diff);
    }

    let requires_rolling = changes
        .iter()
        .any(|change| change.restart == RestartPlan::Rolling);
    let requires_restart = changes
        .iter()
        .any(|change| !matches!(change.restart, RestartPlan::Nothing));
    PlanDiff {
        changes,
        unchanged,
        requires_rolling,
        requires_restart,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plan::{Plan, PlannedService};
    use pg_deploy_config::Severity;

    fn service(
        name: &str,
        host: &str,
        port: u16,
        implementation: ImplKind,
        replicas: u16,
    ) -> PlannedService {
        PlannedService {
            name: name.to_owned(),
            host: host.to_owned(),
            impl_: implementation,
            port,
            systemd_unit: name.to_owned(),
            depends_on: Vec::new(),
            replicas,
            upstreams: Vec::new(),
            sandbox_upstreams: Vec::new(),
        }
    }

    fn plan_of(services: Vec<PlannedService>) -> Plan {
        Plan {
            hosts: Vec::new(),
            services,
            core_pools: Vec::new(),
            warnings: Vec::new(),
        }
    }

    #[test]
    fn identical_plans_have_no_changes() {
        let plan = plan_of(vec![service(
            "pg-core-back",
            "core-1",
            4000,
            ImplKind::Ts,
            1,
        )]);
        let diff = plan_diff(&plan, &plan);
        assert!(diff.is_empty());
        assert!(!diff.requires_restart);
        assert!(!diff.requires_rolling);
        assert_eq!(diff.unchanged, vec!["pg-core-back".to_owned()]);
    }

    #[test]
    fn added_and_removed_services_are_classified() {
        let current = plan_of(vec![service(
            "pg-core-back",
            "core-1",
            4000,
            ImplKind::Ts,
            1,
        )]);
        let desired = plan_of(vec![
            service("pg-core-back", "core-1", 4000, ImplKind::Ts, 1),
            service("pg-core-sandbox", "core-1", 4005, ImplKind::Ts, 1),
        ]);
        let diff = plan_diff(&current, &desired);
        let sandbox = diff
            .changes
            .iter()
            .find(|change| change.name == "pg-core-sandbox")
            .expect("sandbox diff");
        assert_eq!(sandbox.kind, ChangeKind::Added);
        assert_eq!(sandbox.restart, RestartPlan::Start);
        assert!(diff.requires_restart);

        let removed = plan_diff(&desired, &current);
        let sandbox = removed
            .changes
            .iter()
            .find(|change| change.name == "pg-core-sandbox")
            .expect("sandbox diff");
        assert_eq!(sandbox.kind, ChangeKind::Removed);
        assert_eq!(sandbox.restart, RestartPlan::Stop);
    }

    #[test]
    fn changed_fields_are_listed_and_single_instances_are_zero_downtime() {
        let current = plan_of(vec![service(
            "pg-admin-back",
            "admin-1",
            4101,
            ImplKind::Ts,
            1,
        )]);
        let desired = plan_of(vec![service(
            "pg-admin-back",
            "admin-2",
            4102,
            ImplKind::Rs,
            1,
        )]);
        let diff = plan_diff(&current, &desired);
        let change = &diff.changes[0];
        assert_eq!(change.kind, ChangeKind::Changed);
        assert_eq!(change.fields, vec!["host", "port", "impl"]);
        assert_eq!(change.restart, RestartPlan::ZeroDowntime);
        assert!(!diff.requires_rolling);
        assert!(diff.requires_restart);
        assert_eq!(diff.actionable().len(), 1);
    }

    #[test]
    fn multi_replica_changes_roll() {
        let current = plan_of(vec![service(
            "pg-core-back",
            "core-1",
            4000,
            ImplKind::Ts,
            2,
        )]);
        let desired = plan_of(vec![service(
            "pg-core-back",
            "core-1",
            4000,
            ImplKind::Rs,
            2,
        )]);
        let diff = plan_diff(&current, &desired);
        assert_eq!(diff.changes[0].fields, vec!["impl"]);
        assert_eq!(diff.changes[0].restart, RestartPlan::Rolling);
        assert!(diff.requires_rolling);
    }

    #[test]
    fn replica_count_changes_are_reported() {
        let current = plan_of(vec![service(
            "pg-core-back-1",
            "core-1",
            4000,
            ImplKind::Ts,
            1,
        )]);
        let desired = plan_of(vec![service(
            "pg-core-back-1",
            "core-1",
            4000,
            ImplKind::Ts,
            3,
        )]);
        let diff = plan_diff(&current, &desired);
        assert_eq!(diff.changes[0].fields, vec!["replicas"]);
        assert_eq!(diff.changes[0].restart, RestartPlan::Rolling);
    }

    #[test]
    fn warnings_do_not_affect_the_diff() {
        let mut plan = plan_of(vec![service(
            "pg-core-back",
            "core-1",
            4000,
            ImplKind::Ts,
            1,
        )]);
        plan.warnings.push(crate::plan::PlanWarning {
            code: "X".to_owned(),
            path: "x".to_owned(),
            message: "x".to_owned(),
            severity: Severity::Warning,
        });
        assert!(plan_diff(&plan, &plan).is_empty());
    }
}

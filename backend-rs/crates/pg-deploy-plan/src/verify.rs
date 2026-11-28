//! Verification checks: the health and TCP probes of chapter 7 §13.
//!
//! Port of `deploy/lib/healthVerifier.ts` (endpoint list): every planned service yields one check,
//! with the URL or address the deploy verifier must probe. The plan already knows each host's
//! private and public address, so this module needs no configuration.

#![forbid(unsafe_code)]

use serde::Serialize;

use crate::plan::{check_kind_for, Plan};

/// The probe to run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CheckKind {
    /// `GET https://<ip>:<port>/health` with a client certificate (core, daemons).
    MtlsHealth,
    /// `GET http://<ip>:<port>/health` (edge backends behind nginx, Fake Rails).
    HttpHealth,
    /// `GET https://<host>:<port>/health` through the public/LAN vhost.
    HttpsHealth,
    /// `TcpConnect` to the listener (PostgreSQL, PgBouncer, Redis).
    TcpConnect,
}

impl CheckKind {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MtlsHealth => "mtls-health",
            Self::HttpHealth => "http-health",
            Self::HttpsHealth => "https-health",
            Self::TcpConnect => "tcp-connect",
        }
    }
}

/// One verification target.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct VerificationCheck {
    /// Stable check name: `<service>.health` or `<service>.tcp`.
    pub name: String,
    /// Service it verifies.
    pub service: String,
    /// Host name.
    pub host: String,
    /// Probe kind.
    pub kind: CheckKind,
    /// HTTP(S) URL for a health check.
    pub url: Option<String>,
    /// `ip:port` for a TCP check.
    pub address: Option<String>,
}

/// Build the verification list for a plan.
///
/// Port of the endpoint list of `deploy/lib/healthVerifier.ts`. Services planned on `unassigned`
/// (no host in the document) are skipped: there is nothing to reach, and the plan already carries
/// the error.
#[must_use]
pub fn verification_checks(plan: &Plan) -> Vec<VerificationCheck> {
    let mut checks = Vec::new();
    for service in &plan.services {
        let Some(host) = plan.host(&service.host) else {
            continue;
        };
        let kind = check_kind_for(&service.name);
        let use_public = service.name.ends_with("-nginx") && !host.public_ip.is_empty();
        let ip = if use_public {
            &host.public_ip
        } else {
            &host.private_ip
        };
        let address_ip = bracketed(ip);
        let (name, url, address) = match kind {
            CheckKind::MtlsHealth => (
                format!("{}.health", service.name),
                Some(format!("https://{address_ip}:{}/health", service.port)),
                None,
            ),
            CheckKind::HttpHealth => (
                format!("{}.health", service.name),
                Some(format!("http://{address_ip}:{}/health", service.port)),
                None,
            ),
            CheckKind::HttpsHealth => (
                format!("{}.health", service.name),
                Some(format!("https://{address_ip}:{}/health", service.port)),
                None,
            ),
            CheckKind::TcpConnect => (
                format!("{}.tcp", service.name),
                None,
                Some(format!("{address_ip}:{}", service.port)),
            ),
        };
        checks.push(VerificationCheck {
            name,
            service: service.name.clone(),
            host: service.host.clone(),
            kind,
            url,
            address,
        });
    }
    checks.sort_by(|left, right| left.name.cmp(&right.name));
    checks
}

fn bracketed(ip: &str) -> String {
    if ip.contains(':') && !ip.starts_with('[') {
        format!("[{ip}]")
    } else {
        ip.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plan::{plan, PlannedHost, PlannedService};
    use pg_deploy_config::{Environment, Host, ImplKind, PgctlConfig, Role};

    fn host(name: &str, role: Role, address: &str) -> Host {
        Host {
            name: name.to_owned(),
            address: address.to_owned(),
            roles: vec![role],
            private_ip: address.to_owned(),
            ..Host::default()
        }
    }

    fn fixture() -> PgctlConfig {
        let mut config = PgctlConfig::new(Environment::Development);
        config.hosts = vec![
            host("db-1", Role::PgPrimary, "10.0.0.21"),
            host("core-1", Role::Core, "10.0.0.11"),
            host("admin-1", Role::Admin, "10.0.0.30"),
            Host {
                public_ip: "203.0.113.10".to_owned(),
                ..host("merchant-1", Role::Merchant, "10.0.0.40")
            },
        ];
        config.database.mode = pg_deploy_config::DatabaseMode::Managed;
        config.database.host = Some("10.0.0.21".to_owned());
        config.database.tls = true;
        config.database.pgbouncer = true;
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
        config
    }

    fn by_name<'a>(checks: &'a [VerificationCheck], name: &str) -> &'a VerificationCheck {
        checks
            .iter()
            .find(|check| check.name == name)
            .unwrap_or_else(|| panic!("{name} is missing"))
    }

    #[test]
    fn core_and_daemons_are_probed_over_mtls() {
        let checks = verification_checks(&plan(&fixture()));
        let core = by_name(&checks, "pg-core-back.health");
        assert_eq!(core.kind, CheckKind::MtlsHealth);
        assert_eq!(core.url.as_deref(), Some("https://10.0.0.11:4000/health"));
        let backup = by_name(&checks, "pg-backup-daemon.health");
        assert_eq!(backup.url.as_deref(), Some("https://10.0.0.60:4090/health"));
        let storage = by_name(&checks, "pg-object-storage-daemon.health");
        assert_eq!(
            storage.url.as_deref(),
            Some("https://10.0.0.50:4095/health")
        );
    }

    #[test]
    fn storage_listeners_are_tcp_probes() {
        let checks = verification_checks(&plan(&fixture()));
        assert_eq!(
            by_name(&checks, "pg-postgres-primary.tcp")
                .address
                .as_deref(),
            Some("10.0.0.21:5432")
        );
        assert_eq!(
            by_name(&checks, "pg-pgbouncer.tcp").address.as_deref(),
            Some("10.0.0.21:6432")
        );
    }

    #[test]
    fn public_vhosts_use_the_public_address() {
        let checks = verification_checks(&plan(&fixture()));
        assert_eq!(
            by_name(&checks, "pg-merchant-nginx.health").url.as_deref(),
            Some("https://203.0.113.10:443/health")
        );
        // Admin has no public address: its LAN vhost is probed on the private IP.
        assert_eq!(
            by_name(&checks, "pg-admin-nginx.health").url.as_deref(),
            Some("https://10.0.0.30:8443/health")
        );
    }

    #[test]
    fn edge_backends_and_fake_rails_are_plain_http() {
        let checks = verification_checks(&plan(&fixture()));
        assert_eq!(
            by_name(&checks, "pg-admin-back.health").url.as_deref(),
            Some("http://10.0.0.30:4101/health")
        );
        assert_eq!(
            by_name(&checks, "pg-fake-rails-back.health").url.as_deref(),
            Some("http://10.0.0.11:4104/health"),
            "no fake-rails host: the planner falls back to the first host"
        );
        assert_eq!(
            by_name(&checks, "pg-fake-rails-nginx.health")
                .url
                .as_deref(),
            Some("http://10.0.0.11:8444/health")
        );
    }

    #[test]
    fn every_service_has_exactly_one_check() {
        let plan = plan(&fixture());
        let checks = verification_checks(&plan);
        assert_eq!(checks.len(), plan.services.len());
        let mut names = std::collections::BTreeSet::new();
        for check in &checks {
            assert!(
                names.insert(check.name.clone()),
                "duplicate check {}",
                check.name
            );
            assert!(
                check.url.is_some() ^ check.address.is_some(),
                "{}",
                check.name
            );
        }
        let sorted: Vec<&str> = checks.iter().map(|check| check.name.as_str()).collect();
        let mut expected = sorted.clone();
        expected.sort_unstable();
        assert_eq!(sorted, expected);
    }

    #[test]
    fn ipv6_addresses_are_bracketed() {
        let plan = Plan {
            hosts: vec![PlannedHost {
                name: "core-1".to_owned(),
                address: "::1".to_owned(),
                ssh_port: 22,
                ssh_user: "deploy".to_owned(),
                private_ip: "::1".to_owned(),
                public_ip: String::new(),
                roles: vec![Role::Core],
                services: Vec::new(),
                deploy_order: 2,
            }],
            services: vec![PlannedService {
                name: "pg-core-back".to_owned(),
                host: "core-1".to_owned(),
                impl_: ImplKind::Rs,
                port: 4000,
                systemd_unit: "pg-core-back".to_owned(),
                depends_on: Vec::new(),
                replicas: 1,
                upstreams: Vec::new(),
                sandbox_upstreams: Vec::new(),
            }],
            core_pools: Vec::new(),
            warnings: Vec::new(),
        };
        let checks = verification_checks(&plan);
        assert_eq!(checks[0].url.as_deref(), Some("https://[::1]:4000/health"));
    }

    #[test]
    fn unassigned_services_are_skipped() {
        let plan = Plan {
            hosts: Vec::new(),
            services: vec![PlannedService {
                name: "pg-core-back".to_owned(),
                host: "unassigned".to_owned(),
                impl_: ImplKind::Ts,
                port: 4000,
                systemd_unit: "pg-core-back".to_owned(),
                depends_on: Vec::new(),
                replicas: 1,
                upstreams: Vec::new(),
                sandbox_upstreams: Vec::new(),
            }],
            core_pools: Vec::new(),
            warnings: Vec::new(),
        };
        assert!(verification_checks(&plan).is_empty());
    }
}

//! systemd unit rendering.
//!
//! Port of the unit generation of `deploy/lib/hostPlanner.ts` + `deploy.ts` and the templates of
//! chapter 7 §10. Rust services are rendered here; PostgreSQL, PgBouncer, Redis and nginx are
//! provisioner-managed, so their "unit" is an explanatory stub that `pgctl apply` never writes.
//!
//! Templates are plain `format!` strings (no minijinja yet, no placeholders left behind):
//! `ExecStart` always points at `/opt/pg/current`, never at an absolute release path, which is the
//! fix for the PM2 rollback trap (§12, GAP-039).

#![forbid(unsafe_code)]

use crate::plan::PlannedService;

/// One systemd `LoadCredential=` entry: the service reads the file from `$CREDENTIALS_DIRECTORY/<id>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Credential {
    /// Credential id inside the unit (`tls-ca`, `kek`, ...).
    pub id: String,
    /// Absolute path on the host, root-owned 0400.
    pub path: String,
}

impl Credential {
    fn new(id: &str, service: &str, file: &str) -> Self {
        Self {
            id: id.to_owned(),
            path: format!("/etc/pg/credentials/{service}/{file}"),
        }
    }
}

/// Credentials each Rust service receives through `LoadCredential=` (AD-13, chapter 7 §8).
///
/// The files are installed by the PKI/secrets steps (D4); until then systemd refuses to start the
/// unit, which is the intended fail-closed behaviour.
#[must_use]
pub fn credentials_for(service_name: &str) -> Vec<Credential> {
    let mut credentials = Vec::new();
    let mut push = |id: &str, file: &str| {
        credentials.push(Credential::new(id, service_name, file));
    };
    if service_name.starts_with("pg-core") {
        push("tls-ca", "internal-ca.crt");
        push("tls-server-cert", "core-back.crt");
        push("tls-server-key", "core-back.key");
        push("kms-master-key", "kms_master_key");
    } else if service_name.starts_with("pg-admin-back") {
        push("tls-ca", "internal-ca.crt");
        push("tls-client-cert", "admin-back-client.crt");
        push("tls-client-key", "admin-back-client.key");
    } else if service_name.starts_with("pg-merchant-back") {
        push("tls-ca", "internal-ca.crt");
        push("tls-client-cert", "merchant-back-client.crt");
        push("tls-client-key", "merchant-back-client.key");
    } else if service_name.starts_with("pg-checkout-back") {
        push("tls-ca", "internal-ca.crt");
        push("tls-client-cert", "checkout-back-client.crt");
        push("tls-client-key", "checkout-back-client.key");
    } else if service_name.starts_with("pg-fake-rails-back") {
        push("tls-ca", "internal-ca.crt");
        push("jwt-secret", "fake_rails_jwt_secret");
        push("seeder-token", "fake_rails_seeder_token");
    } else if service_name.starts_with("pg-backup-daemon") {
        push("tls-ca", "internal-ca.crt");
        push("tls-server-cert", "backup-daemon.crt");
        push("tls-server-key", "backup-daemon.key");
        push("backup-key", "backup_encryption_key");
    } else if service_name.starts_with("pg-object-storage-daemon") {
        push("tls-ca", "internal-ca.crt");
        push("tls-server-cert", "object-storage-daemon.crt");
        push("tls-server-key", "object-storage-daemon.key");
        push("kek", "object_storage_kek_keyring");
    }
    credentials
}

/// Writable state directory of a Rust service (used by the install step and `ReadWritePaths`).
#[must_use]
pub fn writable_path(service_name: &str) -> Option<&'static str> {
    runtime_for(service_name).map(|runtime| runtime.writable)
}

/// Runtime facts of one Rust service binary.
struct Runtime {
    binary: &'static str,
    user: &'static str,
    writable: &'static str,
    memory_deny_write_execute: bool,
}

/// Map a planned service to its Rust binary, service account and writable state directory.
fn runtime_for(name: &str) -> Option<Runtime> {
    if name.starts_with("pg-core-back") || name.starts_with("pg-core-sandbox") {
        return Some(Runtime {
            binary: "core-rs",
            user: "pgcore",
            writable: "/var/lib/pg-core",
            // A wasmtime-enabled core needs W+X (E-F07); keep the door open.
            memory_deny_write_execute: false,
        });
    }
    if name.starts_with("pg-admin-back") {
        return Some(Runtime {
            binary: "admin-edge",
            user: "pgadmin",
            writable: "/var/lib/pg-admin",
            memory_deny_write_execute: true,
        });
    }
    if name.starts_with("pg-merchant-back") {
        return Some(Runtime {
            binary: "merchant-edge",
            user: "pgmerchant",
            writable: "/var/lib/pg-merchant",
            memory_deny_write_execute: true,
        });
    }
    if name.starts_with("pg-checkout-back") {
        return Some(Runtime {
            binary: "checkout-edge",
            user: "pgcheckout",
            writable: "/var/lib/pg-checkout",
            memory_deny_write_execute: true,
        });
    }
    if name.starts_with("pg-fake-rails-back") {
        return Some(Runtime {
            binary: "fake-rails-rs",
            user: "pgfakerails",
            writable: "/var/lib/pg-fake-rails",
            memory_deny_write_execute: true,
        });
    }
    if name.starts_with("pg-backup-daemon") {
        return Some(Runtime {
            binary: "backup-daemon-rs",
            user: "pgbackup",
            writable: "/var/lib/pg-backup",
            memory_deny_write_execute: true,
        });
    }
    if name.starts_with("pg-object-storage-daemon") {
        return Some(Runtime {
            binary: "object-storage-daemon-rs",
            user: "pgobjstore",
            writable: "/var/lib/pg-object-storage",
            memory_deny_write_execute: true,
        });
    }
    None
}

/// True when `pg-deploy-provision` (not the release) owns the unit: PostgreSQL, PgBouncer, Redis
/// and nginx.
#[must_use]
pub fn is_provisioner_managed(service_name: &str) -> bool {
    runtime_for(service_name).is_none()
}

/// Render the unit file of a planned service.
///
/// Port of the unit generation in `deploy/deploy.ts` (PM2 ecosystem → systemd) and chapter 7 §10.
///
/// A Rust service gets a complete hardened unit; a provisioner-managed component gets a
/// comment-only stub that documents its distro unit and listener (nothing else is safe to write:
/// writing an `ExecStart` for PostgreSQL would replace the packaged unit).
#[must_use]
pub fn render_systemd_unit(service: &PlannedService) -> String {
    render_systemd_unit_with_credentials(service, &credentials_for(&service.name))
}

/// Render a unit with an explicit credential list.
#[must_use]
pub fn render_systemd_unit_with_credentials(
    service: &PlannedService,
    credentials: &[Credential],
) -> String {
    match runtime_for(&service.name) {
        Some(runtime) => render_rust_unit(service, &runtime, credentials),
        None => render_provisioner_stub(service),
    }
}

fn render_rust_unit(
    service: &PlannedService,
    runtime: &Runtime,
    credentials: &[Credential],
) -> String {
    let mut credential_lines = String::new();
    for credential in credentials {
        credential_lines.push_str(&format!(
            "LoadCredential={}:{}\n",
            credential.id, credential.path
        ));
    }
    format!(
        "\
# managed by pgctl, do not edit
# listener: SO_REUSEPORT is set by the service (chapter 7 §10); the unit keeps a 15 s drain and restarts.
[Unit]
Description={name} ({impl_} implementation, port {port})
Documentation=file:/opt/pg/releases/current/manifest.json
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=notify
User={user}
Group={user}
EnvironmentFile=/etc/pg/{name}/config.env
ExecStart=/opt/pg/current/bin/{binary} serve
{credentials}Restart=always
RestartSec=3
TimeoutStopSec=15
LimitNOFILE=1048576
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths={writable}
CapabilityBoundingSet=
SystemCallFilter=@system-service
MemoryDenyWriteExecute={mdwe}
# credentials: /etc/pg/credentials/{name}/ is delivered through LoadCredential by pgctl

[Install]
WantedBy=multi-user.target
",
        name = service.name,
        impl_ = service.impl_.as_str(),
        port = service.port,
        user = runtime.user,
        binary = runtime.binary,
        writable = runtime.writable,
        credentials = credential_lines,
        mdwe = if runtime.memory_deny_write_execute {
            "yes"
        } else {
            "no"
        },
    )
}

fn render_provisioner_stub(service: &PlannedService) -> String {
    format!(
        "\
# managed by pgctl, do not edit
# provisioner-managed: {name} is installed and configured by pg-deploy-provision.
# unit: {unit}
# host: {host}
# listen: {port}
",
        name = service.name,
        unit = service.systemd_unit,
        host = service.host,
        port = service.port,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plan::{plan, PlannedService};
    use pg_deploy_config::{Environment, Host, ImplKind, PgctlConfig, Role};

    fn service(name: &str, port: u16, unit: &str) -> PlannedService {
        PlannedService {
            name: name.to_owned(),
            host: "core-1".to_owned(),
            impl_: ImplKind::Rs,
            port,
            systemd_unit: unit.to_owned(),
            depends_on: Vec::new(),
            replicas: 1,
            upstreams: Vec::new(),
            sandbox_upstreams: Vec::new(),
        }
    }

    #[test]
    fn a_core_unit_is_hardened_and_references_current() {
        let unit = render_systemd_unit(&service("pg-core-back", 4000, "pg-core-back"));
        assert!(
            unit.contains("ExecStart=/opt/pg/current/bin/core-rs serve"),
            "{unit}"
        );
        assert!(unit.contains("Type=notify"));
        assert!(unit.contains("EnvironmentFile=/etc/pg/pg-core-back/config.env"));
        assert!(unit.contains("User=pgcore"));
        assert!(unit.contains("NoNewPrivileges=yes"));
        assert!(unit.contains("ProtectSystem=strict"));
        assert!(unit.contains("ReadWritePaths=/var/lib/pg-core"));
        assert!(
            unit.contains("MemoryDenyWriteExecute=no"),
            "core may embed wasmtime"
        );
        assert!(!unit.contains('{'), "no placeholder may survive: {unit}");
        assert!(unit.ends_with('\n'));
    }

    #[test]
    fn every_rust_service_has_its_own_binary_and_account() {
        let cases = [
            ("pg-admin-back", "admin-edge", "pgadmin"),
            ("pg-merchant-back", "merchant-edge", "pgmerchant"),
            ("pg-checkout-back", "checkout-edge", "pgcheckout"),
            ("pg-fake-rails-back", "fake-rails-rs", "pgfakerails"),
            ("pg-backup-daemon", "backup-daemon-rs", "pgbackup"),
            (
                "pg-object-storage-daemon",
                "object-storage-daemon-rs",
                "pgobjstore",
            ),
            ("pg-core-sandbox", "core-rs", "pgcore"),
        ];
        let mut binaries = std::collections::BTreeSet::new();
        for (name, binary, user) in cases {
            let unit = render_systemd_unit(&service(name, 4000, name));
            assert!(
                unit.contains(&format!("ExecStart=/opt/pg/current/bin/{binary} serve")),
                "{name}"
            );
            assert!(unit.contains(&format!("User={user}")), "{name}");
            // Only the core may need W+X (wasmtime, E-F07); every other Rust service keeps the
            // stricter default.
            let expected = if binary == "core-rs" { "no" } else { "yes" };
            assert!(
                unit.contains(&format!("MemoryDenyWriteExecute={expected}")),
                "{name}"
            );
            binaries.insert(binary);
        }
        assert_eq!(binaries.len(), 7);
    }

    #[test]
    fn suffixed_instances_keep_their_own_unit_name_and_config_dir() {
        let unit =
            render_systemd_unit(&service("pg-core-back-core-2", 4000, "pg-core-back-core-2"));
        assert!(unit.contains("EnvironmentFile=/etc/pg/pg-core-back-core-2/config.env"));
        assert!(unit.contains("Description=pg-core-back-core-2"));
    }

    #[test]
    fn storage_and_nginx_are_provisioner_managed_stubs() {
        for (name, unit_name) in [
            ("pg-postgres-primary", "postgresql"),
            ("pg-pgbouncer", "pgbouncer"),
            ("pg-redis", "redis"),
            ("pg-admin-nginx", "nginx"),
        ] {
            assert!(is_provisioner_managed(name), "{name}");
            let unit = render_systemd_unit(&service(name, 5432, unit_name));
            assert!(unit.starts_with("# managed by pgctl"), "{unit}");
            assert!(unit.contains("provisioner-managed"), "{unit}");
            assert!(unit.contains(&format!("unit: {unit_name}")), "{unit}");
            assert!(!unit.contains("ExecStart"), "{unit}");
        }
        assert!(!is_provisioner_managed("pg-core-back"));
    }

    #[test]
    fn credentials_are_delivered_through_load_credential() {
        let credentials = credentials_for("pg-object-storage-daemon");
        let ids: Vec<&str> = credentials
            .iter()
            .map(|credential| credential.id.as_str())
            .collect();
        assert_eq!(
            ids,
            vec!["tls-ca", "tls-server-cert", "tls-server-key", "kek"]
        );
        assert_eq!(
            credentials[0].path,
            "/etc/pg/credentials/pg-object-storage-daemon/internal-ca.crt"
        );
        let unit = render_systemd_unit(&service(
            "pg-object-storage-daemon",
            4095,
            "pg-object-storage-daemon",
        ));
        assert!(unit.contains(
            "LoadCredential=tls-ca:/etc/pg/credentials/pg-object-storage-daemon/internal-ca.crt"
        ));
        assert!(unit.contains("LoadCredential=kek:"));
        assert!(unit.contains("SO_REUSEPORT is set by the service"));
        assert_eq!(
            writable_path("pg-object-storage-daemon"),
            Some("/var/lib/pg-object-storage")
        );
        assert!(credentials_for("pg-admin-back")
            .iter()
            .any(|credential| credential.id == "tls-client-cert"));
        assert!(credentials_for("pg-postgres-primary").is_empty());
    }

    #[test]
    fn units_render_for_a_real_plan() {
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
        ];
        config.database.mode = pg_deploy_config::DatabaseMode::Managed;
        config.database.host = Some("10.0.0.21".to_owned());
        config.database.tls = true;
        let plan = plan(&config);
        for service in &plan.services {
            let unit = render_systemd_unit(service);
            assert!(!unit.is_empty());
            assert!(!unit.contains('{'), "{}: {unit}", service.name);
            if unit.contains("[Service]") {
                assert!(
                    unit.contains("ExecStart=/opt/pg/current/"),
                    "{}",
                    service.name
                );
            }
        }
    }
}

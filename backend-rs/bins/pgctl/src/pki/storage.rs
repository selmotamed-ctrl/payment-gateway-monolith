//! Storage TLS plan (D4-T02 / S-SEC-06).
//!
//! The TypeScript engine settles for a self-signed PostgreSQL certificate (`sslmode=no-verify`),
//! an unverified PgBouncer server leg and plaintext Redis. `pgctl` signs the storage servers with
//! the internal intermediate instead and gives clients the `pg-client` / `redis-client`
//! certificates, so every link can run `verify-full`.
//!
//! This module is the **documented plan section**: `pgctl pki storage` prints it, and
//! `pgctl plan --json` embeds it under `pki`. Every path and SAN the D5 provisioners need is here,
//! so the storage provisioners do not have to re-derive identities. `pgctl` never touches the
//! TypeScript deploy engine.

use std::collections::BTreeMap;
use std::path::Path;

use pg_deploy_config::{PgctlConfig, Role};
use serde::Serialize;

use crate::util::sanitize_component;

use super::catalog::{topology_specs, CertificateSpec};
use super::issue::PkiPaths;

/// Section key used by `pgctl plan --json`.
pub const PLAN_SECTION: &str = "storage-tls";

/// One storage server endpoint.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StorageEndpoint {
    /// Host name (node id, or the external host for an operator-managed server).
    pub host: String,
    /// Listener port.
    pub port: u16,
    /// Certificate name (`postgres-db-1`).
    pub certificate: String,
    /// Whether `pgctl` provisions this server (false for an external database host).
    pub managed: bool,
    /// Local certificate path (operator host / PKI directory).
    pub server_cert: String,
    /// Local private key path.
    pub server_key: String,
    /// Local CA trust anchor.
    pub ca_file: String,
    /// Local root + intermediate bundle (`ssl_ca_file` / `sslrootcert`).
    pub ca_chain_file: String,
    /// Local signed CRL (`ssl_crl_file`).
    pub crl_file: String,
    /// Local client certificate for this storage link.
    pub client_cert: String,
    /// Local client key.
    pub client_key: String,
    /// DNS and IP SANs the certificate carries.
    pub sans: Vec<String>,
    /// Where each file is installed on the server.
    pub install: BTreeMap<String, String>,
    /// Connection settings a client must use (`sslmode=verify-full&...`).
    pub client_settings: String,
}

/// A client certificate referenced by the plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StorageClient {
    /// File stem / CN.
    pub name: String,
    /// Local certificate path.
    pub cert: String,
    /// Local key path.
    pub key: String,
    /// Who uses it.
    pub used_by: Vec<String>,
}

/// The complete storage TLS section.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StorageTlsPlan {
    /// `storage-tls` (stable section key).
    pub section: String,
    /// PKI directory.
    pub dir: String,
    /// Root CA path.
    pub ca_file: String,
    /// Root + intermediate bundle.
    pub ca_chain_file: String,
    /// Signed CRL.
    pub crl_file: String,
    /// PostgreSQL servers (primary, replicas, audit and log clusters).
    pub postgres: Vec<StorageEndpoint>,
    /// PgBouncer listeners.
    pub pgbouncer: Vec<StorageEndpoint>,
    /// Redis / Valkey listeners.
    pub redis: Vec<StorageEndpoint>,
    /// Client certificates used by storage links.
    pub clients: Vec<StorageClient>,
    /// Operational guidance for the D5 provisioners and client configuration.
    pub guidance: Vec<String>,
}

impl StorageTlsPlan {
    /// Number of server endpoints in the section.
    #[must_use]
    pub fn endpoint_count(&self) -> usize {
        self.postgres.len() + self.pgbouncer.len() + self.redis.len()
    }

    /// Whether there is anything to report.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.endpoint_count() == 0
    }
}

fn path_text(path: &Path) -> String {
    path.display().to_string()
}

fn sans_for(spec: &CertificateSpec) -> Vec<String> {
    spec.san_strings()
}

struct EndpointRequest<'a> {
    host: &'a str,
    port: u16,
    managed: bool,
    install: BTreeMap<String, String>,
    client_name: &'a str,
    client_settings: String,
}

fn endpoint(
    paths: &PkiPaths,
    spec: &CertificateSpec,
    request: EndpointRequest<'_>,
) -> StorageEndpoint {
    StorageEndpoint {
        host: request.host.to_owned(),
        port: request.port,
        certificate: spec.name.clone(),
        managed: request.managed,
        server_cert: path_text(&paths.cert_path(&spec.name)),
        server_key: path_text(&paths.key_path(&spec.name)),
        ca_file: path_text(&paths.root_cert()),
        ca_chain_file: path_text(&paths.chain()),
        crl_file: path_text(&paths.crl()),
        client_cert: path_text(&paths.cert_path(request.client_name)),
        client_key: path_text(&paths.key_path(request.client_name)),
        sans: sans_for(spec),
        install: request.install,
        client_settings: request.client_settings,
    }
}

fn postgres_install(host: &str) -> BTreeMap<String, String> {
    let cluster = sanitize_component(host);
    let directory = format!("/etc/postgresql/18/{cluster}/tls");
    BTreeMap::from([
        ("directory".to_owned(), directory.clone()),
        ("server_cert".to_owned(), format!("{directory}/server.crt")),
        ("server_key".to_owned(), format!("{directory}/server.key")),
        ("ca_file".to_owned(), format!("{directory}/ca.crt")),
        ("crl_file".to_owned(), format!("{directory}/crl.pem")),
    ])
}

fn pgbouncer_install() -> BTreeMap<String, String> {
    BTreeMap::from([
        ("directory".to_owned(), "/etc/pgbouncer/tls".to_owned()),
        (
            "server_cert".to_owned(),
            "/etc/pgbouncer/tls/server.crt".to_owned(),
        ),
        (
            "server_key".to_owned(),
            "/etc/pgbouncer/tls/server.key".to_owned(),
        ),
        ("ca_file".to_owned(), "/etc/pgbouncer/tls/ca.crt".to_owned()),
        (
            "crl_file".to_owned(),
            "/etc/pgbouncer/tls/crl.pem".to_owned(),
        ),
    ])
}

fn redis_install() -> BTreeMap<String, String> {
    BTreeMap::from([
        ("directory".to_owned(), "/etc/redis/tls".to_owned()),
        (
            "server_cert".to_owned(),
            "/etc/redis/tls/server.crt".to_owned(),
        ),
        (
            "server_key".to_owned(),
            "/etc/redis/tls/server.key".to_owned(),
        ),
        ("ca_file".to_owned(), "/etc/redis/tls/ca.crt".to_owned()),
        ("crl_file".to_owned(), "/etc/redis/tls/crl.pem".to_owned()),
    ])
}

/// The client-side `verify-full` settings. The CA is the bundle every client host receives from
/// the PKI directory (not the storage server's installed copy), and the client certificate is the
/// least-privilege leaf for that link.
fn verify_full(client_name: &str, pki_dir: &str) -> String {
    format!(
        "sslmode=verify-full&sslrootcert={pki_dir}/ca-chain.crt&sslcert={pki_dir}/{client_name}.crt&sslkey={pki_dir}/{client_name}.key"
    )
}

fn host_roles(config: &PgctlConfig, role: Role) -> Vec<&pg_deploy_config::Host> {
    config
        .hosts
        .iter()
        .filter(|host| host.has_role(role))
        .collect()
}

/// Build the storage TLS plan from the desired state.
///
/// `dir_override` replaces `[tls].pki_dir` (used by `pgctl pki storage --dir` and tests).
#[must_use]
pub fn plan_for_config(config: &PgctlConfig, dir_override: Option<&Path>) -> StorageTlsPlan {
    let dir = dir_override
        .map(Path::to_path_buf)
        .unwrap_or_else(|| std::path::PathBuf::from(&config.tls.pki_dir));
    let paths = PkiPaths::new(dir);
    let pki_dir = path_text(paths.dir());
    let specs = topology_specs(config, config.tls.leaf_days.max(1));
    let spec_for = |prefix: &str, host: &str| -> Option<&CertificateSpec> {
        let wanted = format!("{prefix}-{}", sanitize_component(host));
        specs.iter().find(|spec| spec.name == wanted)
    };

    let mut postgres = Vec::new();
    let mut pgbouncer = Vec::new();
    let mut redis = Vec::new();

    let mut pg_hosts: Vec<&pg_deploy_config::Host> = config
        .hosts
        .iter()
        .filter(|host| {
            host.has_role(Role::PgPrimary)
                || host.has_role(Role::PgReplica)
                || host.has_role(Role::AuditDb)
                || host.has_role(Role::LogDb)
        })
        .collect();
    pg_hosts.sort_by(|left, right| left.name.cmp(&right.name));
    if pg_hosts.is_empty() {
        if let Some(host) = config.database.host.as_deref() {
            if config.database.is_managed() {
                if let Some(spec) = spec_for("postgres", host) {
                    let install = postgres_install(host);
                    let settings = verify_full("pg-client", &pki_dir);
                    postgres.push(endpoint(
                        &paths,
                        spec,
                        EndpointRequest {
                            host,
                            port: config.database.port,
                            managed: false,
                            install,
                            client_name: "pg-client",
                            client_settings: settings,
                        },
                    ));
                }
            }
        }
    } else {
        for host in pg_hosts {
            let Some(spec) = spec_for("postgres", &host.name) else {
                continue;
            };
            let install = postgres_install(&host.name);
            let settings = verify_full("pg-client", &pki_dir);
            postgres.push(endpoint(
                &paths,
                spec,
                EndpointRequest {
                    host: &host.name,
                    port: config.database.port,
                    managed: true,
                    install,
                    client_name: "pg-client",
                    client_settings: settings,
                },
            ));
        }
    }

    let mut pgbouncer_hosts: Vec<&pg_deploy_config::Host> = host_roles(config, Role::Pgbouncer);
    pgbouncer_hosts.sort_by(|left, right| left.name.cmp(&right.name));
    if pgbouncer_hosts.is_empty() {
        if config.database.pgbouncer {
            if let Some(host) = config.database.host.as_deref() {
                if let Some(spec) = spec_for("pgbouncer", host) {
                    let install = pgbouncer_install();
                    let settings = verify_full("pg-client", &pki_dir);
                    pgbouncer.push(endpoint(
                        &paths,
                        spec,
                        EndpointRequest {
                            host,
                            port: config.database.pgbouncer_port,
                            managed: false,
                            install,
                            client_name: "pg-client",
                            client_settings: settings,
                        },
                    ));
                }
            }
        }
    } else {
        for host in pgbouncer_hosts {
            let Some(spec) = spec_for("pgbouncer", &host.name) else {
                continue;
            };
            let install = pgbouncer_install();
            let settings = verify_full("pg-client", &pki_dir);
            pgbouncer.push(endpoint(
                &paths,
                spec,
                EndpointRequest {
                    host: &host.name,
                    port: config.database.pgbouncer_port,
                    managed: true,
                    install,
                    client_name: "pg-client",
                    client_settings: settings,
                },
            ));
        }
    }

    let mut redis_hosts: Vec<&pg_deploy_config::Host> = host_roles(config, Role::Redis);
    redis_hosts.sort_by(|left, right| left.name.cmp(&right.name));
    if redis_hosts.is_empty() {
        if let Some(host) = config.redis.host.as_deref() {
            if let Some(spec) = spec_for("redis", host) {
                let install = redis_install();
                let settings = format!(
                    "rediss://<user>:<password>@{host}:{}/{} (TLS with ca-chain.crt, redis-client certificate)",
                    config.redis.port, config.redis.db
                );
                redis.push(endpoint(
                    &paths,
                    spec,
                    EndpointRequest {
                        host,
                        port: config.redis.port,
                        managed: false,
                        install,
                        client_name: "redis-client",
                        client_settings: settings,
                    },
                ));
            }
        }
    } else {
        for host in redis_hosts {
            let Some(spec) = spec_for("redis", &host.name) else {
                continue;
            };
            let install = redis_install();
            let settings = format!(
                "rediss://<user>:<password>@{}:{}/{} (TLS with ca-chain.crt, redis-client certificate)",
                host.peer_address(),
                config.redis.port,
                config.redis.db
            );
            redis.push(endpoint(
                &paths,
                spec,
                EndpointRequest {
                    host: &host.name,
                    port: config.redis.port,
                    managed: true,
                    install,
                    client_name: "redis-client",
                    client_settings: settings,
                },
            ));
        }
    }

    let mut clients = Vec::new();
    for (name, used_by) in [
        ("pg-client", vec!["core", "backup", "migrations"]),
        ("audit-db-client", vec!["core-audit-writer"]),
        ("log-db-client", vec!["core-log-writer"]),
        ("redis-client", vec!["core", "workers"]),
        ("wal-archive-client", vec!["postgres archive_command"]),
        ("backup-client", vec!["backup control"]),
        ("object-storage-client", vec!["core", "backup"]),
    ] {
        clients.push(StorageClient {
            name: name.to_owned(),
            cert: path_text(&paths.cert_path(name)),
            key: path_text(&paths.key_path(name)),
            used_by: used_by.into_iter().map(str::to_owned).collect(),
        });
    }

    let mut guidance = vec![
        "PostgreSQL and PgBouncer clients use sslmode=verify-full with sslrootcert pointing at ca-chain.crt and the pg-client certificate; never sslmode=no-verify outside the local dev loop.".to_owned(),
        "PostgreSQL: ssl_ca_file = ca-chain.crt, ssl_crl_file = crl.pem, hostssl rows use clientcert=verify-full; the server certificate is signed by the internal intermediate, not self-signed.".to_owned(),
        "PgBouncer: server_tls_sslmode = verify-full and client_tls_sslmode = verify-full with ca.crt, server.crt/server.key and crl.pem installed under /etc/pgbouncer/tls.".to_owned(),
        "Redis/Valkey: tls-port with port 0, tls-auth-clients yes, tls-ca-cert-file ca-chain.crt, tls-cert-file/tls-key-file from /etc/redis/tls; clients use rediss:// with the redis-client certificate.".to_owned(),
        "Negative check: a connection with the root CA removed, or with a certificate issued by another CA, must fail the handshake (TLS verification, not just encryption).".to_owned(),
    ];
    if !config.database.tls {
        guidance.push(
            "database.tls is false: a managed PostgreSQL cluster is hostssl-only in this design; set [database].tls = true before applying."
                .to_owned(),
        );
    }
    if config.redis.enabled && !config.redis.tls {
        guidance.push(
            "redis.tls is false: the cache/velocity tier would run plaintext; set [redis].tls = true and use the redis-client certificate."
                .to_owned(),
        );
    }
    if redis.is_empty() {
        guidance.push(
            "Redis is not deployed in this plan; when it is enabled, set [redis].tls = true (the TypeScript engine ran it plaintext)."
                .to_owned(),
        );
    }
    if postgres.is_empty() && pgbouncer.is_empty() {
        guidance.push(
            "No managed PostgreSQL/PgBouncer host is in the plan; the storage server certificates are issued once the roles exist."
                .to_owned(),
        );
    }

    StorageTlsPlan {
        section: PLAN_SECTION.to_owned(),
        dir: pki_dir,
        ca_file: path_text(&paths.root_cert()),
        ca_chain_file: path_text(&paths.chain()),
        crl_file: path_text(&paths.crl()),
        postgres,
        pgbouncer,
        redis,
        clients,
        guidance,
    }
}

#[cfg(test)]
mod tests {
    use pg_deploy_config::{DatabaseMode, Environment, Host, Role};

    use super::*;

    fn config() -> PgctlConfig {
        let mut config = PgctlConfig::new(Environment::Development);
        config.tls.pki_dir = "/etc/pg/pki".to_owned();
        config.hosts = vec![
            Host {
                name: "db-1".to_owned(),
                address: "10.0.0.21".to_owned(),
                private_ip: "10.0.0.21".to_owned(),
                roles: vec![Role::PgPrimary, Role::Pgbouncer],
                ..Host::default()
            },
            Host {
                name: "redis-1".to_owned(),
                address: "10.0.0.31".to_owned(),
                private_ip: "10.0.0.31".to_owned(),
                roles: vec![Role::Redis],
                ..Host::default()
            },
        ];
        config.database.mode = DatabaseMode::Managed;
        config.database.pgbouncer = true;
        config.database.tls = true;
        config.redis.enabled = true;
        config.redis.tls = true;
        config
    }

    #[test]
    fn plan_lists_every_storage_endpoint_with_paths_and_sans() {
        let plan = plan_for_config(&config(), None);
        assert_eq!(plan.section, "storage-tls");
        assert_eq!(plan.postgres.len(), 1);
        assert_eq!(plan.pgbouncer.len(), 1);
        assert_eq!(plan.redis.len(), 1);
        assert_eq!(plan.endpoint_count(), 3);

        let postgres = &plan.postgres[0];
        assert_eq!(postgres.host, "db-1");
        assert_eq!(postgres.certificate, "postgres-db-1");
        assert_eq!(postgres.server_cert, "/etc/pg/pki/postgres-db-1.crt");
        assert_eq!(postgres.server_key, "/etc/pg/pki/postgres-db-1.key");
        assert!(postgres.sans.contains(&"IP:10.0.0.21".to_owned()));
        assert!(postgres.sans.contains(&"DNS:db-1".to_owned()));
        assert_eq!(
            postgres.install.get("server_cert").map(String::as_str),
            Some("/etc/postgresql/18/db-1/tls/server.crt")
        );
        assert!(postgres.client_settings.contains("sslmode=verify-full"));
        assert!(postgres.client_settings.contains("sslrootcert="));
        assert!(postgres.client_settings.contains("pg-client.crt"));

        assert_eq!(plan.pgbouncer[0].host, "db-1");
        assert_eq!(plan.pgbouncer[0].port, config().database.pgbouncer_port);
        assert_eq!(plan.redis[0].host, "redis-1");
        assert!(plan.redis[0].client_settings.starts_with("rediss://"));
        assert!(plan
            .guidance
            .iter()
            .any(|line| line.contains("verify-full")));
        assert!(plan.clients.iter().any(|client| client.name == "pg-client"));
    }

    #[test]
    fn plan_is_deterministic() {
        let config = config();
        let first = plan_for_config(&config, None);
        let second = plan_for_config(&config, None);
        assert_eq!(first, second);
        let first_json = serde_json::to_string_pretty(&first).expect("json");
        let second_json = serde_json::to_string_pretty(&second).expect("json");
        assert_eq!(first_json, second_json);
    }

    #[test]
    fn external_storage_and_no_redis_are_reported() {
        let mut config = PgctlConfig::new(Environment::Development);
        config.tls.pki_dir = "/srv/pki".to_owned();
        config.database.mode = DatabaseMode::Managed;
        config.database.host = Some("db.external.test".to_owned());
        config.database.pgbouncer = true;
        let plan = plan_for_config(&config, None);
        assert_eq!(plan.postgres.len(), 1);
        assert_eq!(plan.postgres[0].host, "db.external.test");
        assert!(!plan.postgres[0].managed);
        assert!(plan.pgbouncer[0].client_settings.contains("verify-full"));
        assert!(plan.redis.is_empty());
        assert!(plan
            .guidance
            .iter()
            .any(|line| line.contains("Redis is not deployed")));
    }

    #[test]
    fn dir_override_changes_paths() {
        let plan = plan_for_config(&config(), Some(Path::new("/tmp/pki-test")));
        assert_eq!(plan.dir, "/tmp/pki-test");
        assert_eq!(
            plan.postgres[0].server_cert,
            "/tmp/pki-test/postgres-db-1.crt"
        );
        assert!(plan.postgres[0].client_cert.ends_with("/pg-client.crt"));
    }
}

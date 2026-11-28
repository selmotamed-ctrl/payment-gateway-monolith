//! The certificate catalogue: who exists and which identity each leaf carries.
//!
//! The CN/SAN rules are not invented here; they reproduce the allow-lists the services already
//! enforce:
//!
//! - `pg-mtls::allowed_channel_cns` binds the core's `/internal/{admin,merchant,checkout}` channels
//!   to exactly `admin-back`, `merchant-back` and `checkout-back`;
//! - the backup daemon accepts `backup-client` for control operations, `wal-archive-client` for
//!   `PUT /v1/wal/*` only and `backup-admin` for policy changes (`S-SEC-09`);
//! - the object-storage daemon defaults to `object-storage-client,backup-daemon,backup-client`;
//! - the edge→core TLS 1.3 handshake verifies the core certificate's IP SAN, because edges reach
//!   the core by private IP.
//!
//! `pgctl pki issue --config pgctl.toml` builds the catalogue from the host roles. The table in
//! `bins/pgctl/README.md` documents it; `catalog::dev_specs` is the local/CI set that replaces
//! `core-back/scripts/generate-mtls-certs.ts`.

use std::collections::BTreeSet;
use std::net::IpAddr;

use pg_deploy_config::{PgctlConfig, Role};
use serde::{Deserialize, Serialize};

use crate::util::sanitize_component;

/// What a certificate may be used for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CertKind {
    /// A CA certificate (root or intermediate); never issued as a leaf.
    Ca,
    /// `serverAuth` only.
    Server,
    /// `clientAuth` only.
    Client,
    /// Both `serverAuth` and `clientAuth` (core, backup daemon, object-storage daemon).
    ServerClient,
}

impl CertKind {
    /// Serialized name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ca => "ca",
            Self::Server => "server",
            Self::Client => "client",
            Self::ServerClient => "server-client",
        }
    }

    /// Parse a CLI value.
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "ca" => Some(Self::Ca),
            "server" | "server-auth" => Some(Self::Server),
            "client" | "client-auth" => Some(Self::Client),
            "server-client" | "both" | "server+client" => Some(Self::ServerClient),
            _ => None,
        }
    }

    /// Whether the certificate can authenticate a server.
    #[must_use]
    pub fn is_server(self) -> bool {
        matches!(self, Self::Server | Self::ServerClient | Self::Ca)
    }

    /// Whether the certificate can authenticate a client.
    #[must_use]
    pub fn is_client(self) -> bool {
        matches!(self, Self::Client | Self::ServerClient | Self::Ca)
    }
}

/// One leaf certificate to issue: the single source of truth for `issue`, `renew` and `rotate`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CertificateSpec {
    /// File stem (`core-back`, `admin-back-client`, `postgres-db-1`).
    pub name: String,
    /// Subject common name.
    pub cn: String,
    /// DNS subject alternative names (without the `DNS:` prefix).
    pub dns_sans: Vec<String>,
    /// IP subject alternative names (without the `IP:` prefix).
    pub ip_sans: Vec<String>,
    /// Usage.
    pub kind: CertKind,
    /// Inventory roles (`core`, `edge`, `postgres`, `client`, `server`, ...).
    pub roles: Vec<String>,
    /// Requested lifetime in days.
    pub days: u16,
}

impl CertificateSpec {
    /// A spec with no SANs; callers add them and call [`CertificateSpec::normalize`].
    #[must_use]
    pub fn new(name: impl Into<String>, cn: impl Into<String>, kind: CertKind, days: u16) -> Self {
        let name = name.into();
        Self {
            cn: cn.into(),
            roles: vec![kind.as_str().to_owned()],
            name,
            dns_sans: Vec::new(),
            ip_sans: Vec::new(),
            kind,
            days,
        }
    }

    /// Add a role.
    #[must_use]
    pub fn with_roles(mut self, roles: &[&str]) -> Self {
        self.roles = roles.iter().map(|role| (*role).to_owned()).collect();
        self
    }

    /// Add a DNS SAN.
    #[must_use]
    pub fn with_dns(mut self, name: &str) -> Self {
        self.dns_sans.push(name.to_owned());
        self
    }

    /// Add an IP SAN when the value parses as an IP address.
    #[must_use]
    pub fn with_ip(mut self, value: &str) -> Self {
        if value.parse::<IpAddr>().is_ok() {
            self.ip_sans.push(value.to_owned());
        }
        self
    }

    /// Add an IP or DNS SAN depending on the value.
    #[must_use]
    pub fn with_host_san(self, value: &str) -> Self {
        let value = value.trim();
        if value.is_empty() {
            return self;
        }
        match value.parse::<IpAddr>() {
            Ok(_) => self.with_ip(value),
            Err(_) => self.with_dns(value),
        }
    }

    /// Sort, de-duplicate and validate the spec.
    pub fn normalize(&mut self) -> Result<(), String> {
        self.name = self.name.trim().to_owned();
        self.cn = self.cn.trim().to_owned();
        if self.name.is_empty() {
            return Err("certificate name is empty".to_owned());
        }
        if !self
            .name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
        {
            return Err(format!(
                "certificate name '{}' may only contain A-Z, a-z, 0-9, '.', '_' and '-'",
                self.name
            ));
        }
        if self.cn.is_empty() {
            return Err(format!("certificate '{}' has an empty CN", self.name));
        }
        self.dns_sans.retain(|entry| !entry.trim().is_empty());
        self.ip_sans.retain(|entry| !entry.trim().is_empty());
        self.dns_sans.sort();
        self.dns_sans.dedup();
        self.ip_sans.sort();
        self.ip_sans.dedup();
        self.roles.sort();
        self.roles.dedup();
        if self.days == 0 {
            return Err(format!(
                "certificate '{}' must be valid for at least one day",
                self.name
            ));
        }
        if matches!(self.kind, CertKind::Server | CertKind::ServerClient)
            && self.dns_sans.is_empty()
            && self.ip_sans.is_empty()
        {
            return Err(format!(
                "server certificate '{}' needs at least one DNS or IP SAN (TLS 1.3 clients verify the hostname)",
                self.name
            ));
        }
        Ok(())
    }

    /// SANs in the `DNS:name` / `IP:addr` form used by inventory and the README table.
    #[must_use]
    pub fn san_strings(&self) -> Vec<String> {
        self.dns_sans
            .iter()
            .map(|name| format!("DNS:{name}"))
            .chain(self.ip_sans.iter().map(|ip| format!("IP:{ip}")))
            .collect()
    }

    /// Raw SAN values for `rcgen` (it infers the SAN type from the string).
    #[must_use]
    pub fn san_values(&self) -> Vec<String> {
        self.dns_sans
            .iter()
            .cloned()
            .chain(self.ip_sans.iter().cloned())
            .collect()
    }
}

/// The fixed leaf certificates every deployment bundle contains, independent of topology.
///
/// `(file stem, CN, kind, roles)`.
pub const STATIC_CLIENTS: &[(&str, &str, CertKind, &[&str])] = &[
    (
        "admin-back-client",
        "admin-back",
        CertKind::Client,
        &["admin", "client", "edge"],
    ),
    (
        "merchant-back-client",
        "merchant-back",
        CertKind::Client,
        &["merchant", "client", "edge"],
    ),
    (
        "checkout-back-client",
        "checkout-back",
        CertKind::Client,
        &["checkout", "client", "edge"],
    ),
    (
        "fake-rails-client",
        "fake-rails-client",
        CertKind::Client,
        &["fake-rails", "client", "control"],
    ),
    (
        "pg-client",
        "pg-client",
        CertKind::Client,
        &["postgres", "client", "storage"],
    ),
    (
        "audit-db-client",
        "audit-db-client",
        CertKind::Client,
        &["postgres", "client", "audit", "storage"],
    ),
    (
        "log-db-client",
        "log-db-client",
        CertKind::Client,
        &["postgres", "client", "log", "storage"],
    ),
    (
        "redis-client",
        "redis-client",
        CertKind::Client,
        &["redis", "client", "storage"],
    ),
    (
        "backup-client",
        "backup-client",
        CertKind::Client,
        &["backup", "client"],
    ),
    (
        "backup-admin",
        "backup-admin",
        CertKind::Client,
        &["backup", "client", "policy"],
    ),
    (
        "wal-archive-client",
        "wal-archive-client",
        CertKind::Client,
        &["backup", "client", "wal"],
    ),
    (
        "object-storage-client",
        "object-storage-client",
        CertKind::Client,
        &["object-storage", "client", "storage"],
    ),
];

/// IP and DNS identities of a host role.
fn host_identities(config: &PgctlConfig, role: Role) -> (Vec<String>, Vec<String>) {
    let mut ips = Vec::new();
    let mut dns = Vec::new();
    for host in config.hosts.iter().filter(|host| host.has_role(role)) {
        let peer = host.peer_address();
        match peer.parse::<IpAddr>() {
            Ok(_) => ips.push(peer.to_owned()),
            Err(_) => dns.push(peer.to_owned()),
        }
        // The node name is stable and resolvable on managed LANs; `verify-full` may use it.
        dns.push(host.name.clone());
        if !host.public_ip.trim().is_empty() {
            match host.public_ip.parse::<IpAddr>() {
                Ok(_) => ips.push(host.public_ip.clone()),
                Err(_) => dns.push(host.public_ip.clone()),
            }
        }
    }
    (ips, dns)
}

/// The fallback identity when no host carries the role: the planner places the service on the
/// first core host (or the first host at all), so the certificate must cover that address too.
fn fallback_identity(config: &PgctlConfig) -> Option<String> {
    config
        .hosts
        .iter()
        .find(|host| host.has_role(Role::Core))
        .or_else(|| config.hosts.first())
        .map(|host| host.peer_address().to_owned())
}

fn add_host_san(spec: &mut CertificateSpec, value: &str) {
    let value = value.trim();
    if value.is_empty() {
        return;
    }
    match value.parse::<IpAddr>() {
        Ok(_) => spec.ip_sans.push(value.to_owned()),
        Err(_) => spec.dns_sans.push(value.to_owned()),
    }
}

fn push_spec(specs: &mut Vec<CertificateSpec>, mut spec: CertificateSpec) {
    if spec.normalize().is_ok() && !specs.iter().any(|existing| existing.name == spec.name) {
        specs.push(spec);
    }
}

/// Build the production leaf catalogue from the configured topology.
///
/// Missing optional components are simply absent (no fake-rails, backup or object-storage role);
/// storage server certificates follow the PostgreSQL/PgBouncer/Redis roles and the external
/// `[database]` / `[redis]` hosts, so a split or external topology is covered too.
#[must_use]
pub fn topology_specs(config: &PgctlConfig, leaf_days: u16) -> Vec<CertificateSpec> {
    let mut specs: Vec<CertificateSpec> = Vec::new();

    // Core server: every core private IP plus the sandbox host the edges reach.
    let (mut core_ips, mut core_dns) = host_identities(config, Role::Core);
    if core_ips.is_empty() && core_dns.is_empty() {
        if let Some(fallback) = fallback_identity(config) {
            match fallback.parse::<IpAddr>() {
                Ok(_) => core_ips.push(fallback),
                Err(_) => core_dns.push(fallback),
            }
        }
    }
    if config.sandbox.enabled {
        if let Some(host) = config.sandbox.host.as_deref() {
            match host.trim().parse::<IpAddr>() {
                Ok(_) => core_ips.push(host.trim().to_owned()),
                Err(_) => core_dns.push(host.trim().to_owned()),
            }
        }
    }
    core_ips.push("127.0.0.1".to_owned());
    core_ips.push("::1".to_owned());
    core_dns.push("core-back.internal".to_owned());
    core_dns.push("core-back".to_owned());
    let mut core = CertificateSpec::new(
        "core-back",
        "core-back.internal",
        CertKind::ServerClient,
        leaf_days,
    )
    .with_roles(&["core", "server"]);
    core.ip_sans = core_ips;
    core.dns_sans = core_dns;
    push_spec(&mut specs, core);

    // Fake Rails: its Nginx vhost is a TLS server for the tester portal.
    let mut fake_ips = vec!["127.0.0.1".to_owned(), "::1".to_owned()];
    let mut fake_dns = vec!["localhost".to_owned()];
    let (role_ips, role_dns) = host_identities(config, Role::FakeRails);
    fake_ips.extend(role_ips);
    fake_dns.extend(role_dns);
    let fake_cn = config
        .services
        .fake_rails
        .public_host
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "_")
        .unwrap_or("fakerails.internal");
    if fake_cn.parse::<IpAddr>().is_ok() {
        fake_ips.push(fake_cn.to_owned());
    } else {
        fake_dns.push(fake_cn.to_owned());
    }
    let mut fake = CertificateSpec::new("fake-rails", fake_cn, CertKind::Server, leaf_days)
        .with_roles(&["fake-rails", "server"]);
    fake.ip_sans = fake_ips;
    fake.dns_sans = fake_dns;
    push_spec(&mut specs, fake);

    // Backup daemon and object-storage daemon: mTLS servers, also usable as clients.
    for (name, cn, role, roles) in [
        (
            "backup-daemon",
            "backup-daemon.internal",
            Role::Backup,
            &["backup", "server"][..],
        ),
        (
            "object-storage-daemon",
            "object-storage-daemon.internal",
            Role::ObjectStorage,
            &["object-storage", "server"][..],
        ),
    ] {
        let (mut ips, mut dns) = host_identities(config, role);
        if ips.is_empty() && dns.is_empty() {
            if let Some(fallback) = fallback_identity(config) {
                match fallback.parse::<IpAddr>() {
                    Ok(_) => ips.push(fallback),
                    Err(_) => dns.push(fallback),
                }
            }
        }
        ips.push("127.0.0.1".to_owned());
        ips.push("::1".to_owned());
        dns.push(cn.to_owned());
        let mut spec =
            CertificateSpec::new(name, cn, CertKind::ServerClient, leaf_days).with_roles(roles);
        spec.ip_sans = ips;
        spec.dns_sans = dns;
        push_spec(&mut specs, spec);
    }

    // Fixed clients (edge channel CNs, storage clients, backup control/WAL/policy clients).
    for (name, cn, kind, roles) in STATIC_CLIENTS {
        push_spec(
            &mut specs,
            CertificateSpec::new(*name, *cn, *kind, leaf_days).with_roles(roles),
        );
    }

    // Storage server certificates. PostgreSQL, PgBouncer and Redis become internal-CA leaves
    // instead of the self-signed certificates the TypeScript engine generated (S-SEC-06).
    let mut storage_hosts: BTreeSet<String> = BTreeSet::new();
    for host in &config.hosts {
        if host.has_role(Role::PgPrimary)
            || host.has_role(Role::PgReplica)
            || host.has_role(Role::AuditDb)
            || host.has_role(Role::LogDb)
        {
            storage_hosts.insert(host.name.clone());
        }
    }
    for name in storage_hosts {
        if let Some(host) = config.hosts.iter().find(|host| host.name == name) {
            push_spec(&mut specs, postgres_spec(host, leaf_days));
        }
    }
    if config.database.is_managed() && !specs.iter().any(|spec| spec.name.starts_with("postgres-"))
    {
        if let Some(value) = config.database.host.as_deref() {
            push_spec(
                &mut specs,
                external_storage_spec("postgres", value, &["postgres", "server"], leaf_days),
            );
        }
    }

    let pgbouncer_hosts: Vec<&pg_deploy_config::Host> = config
        .hosts
        .iter()
        .filter(|host| host.has_role(Role::Pgbouncer))
        .collect();
    if pgbouncer_hosts.is_empty() {
        if config.database.pgbouncer {
            if let Some(value) = config.database.host.as_deref() {
                push_spec(
                    &mut specs,
                    external_storage_spec("pgbouncer", value, &["pgbouncer", "server"], leaf_days),
                );
            }
        }
    } else {
        for host in pgbouncer_hosts {
            push_spec(
                &mut specs,
                storage_server_spec("pgbouncer", host, &["pgbouncer", "server"], leaf_days),
            );
        }
    }

    let redis_hosts: Vec<&pg_deploy_config::Host> = config
        .hosts
        .iter()
        .filter(|host| host.has_role(Role::Redis))
        .collect();
    if redis_hosts.is_empty() {
        if let Some(value) = config.redis.host.as_deref() {
            push_spec(
                &mut specs,
                external_storage_spec("redis", value, &["redis", "server"], leaf_days),
            );
        }
    } else {
        for host in redis_hosts {
            push_spec(
                &mut specs,
                storage_server_spec("redis", host, &["redis", "server"], leaf_days),
            );
        }
    }

    // Clients may connect through [database].host / [redis].host, which can differ from the node
    // name (a DNS alias or a VIP): every storage server certificate must cover it.
    if let Some(host) = config.database.host.as_deref() {
        for spec in specs
            .iter_mut()
            .filter(|spec| spec.name.starts_with("postgres-"))
        {
            add_host_san(spec, host);
            let _ = spec.normalize();
        }
    }
    if let Some(host) = config.redis.host.as_deref() {
        for spec in specs
            .iter_mut()
            .filter(|spec| spec.name.starts_with("redis-"))
        {
            add_host_san(spec, host);
            let _ = spec.normalize();
        }
    }

    specs.sort_by(|left, right| left.name.cmp(&right.name));
    specs
}

fn postgres_spec(host: &pg_deploy_config::Host, leaf_days: u16) -> CertificateSpec {
    storage_server_spec("postgres", host, &["postgres", "server"], leaf_days)
}

fn storage_server_spec(
    prefix: &str,
    host: &pg_deploy_config::Host,
    roles: &[&str],
    leaf_days: u16,
) -> CertificateSpec {
    let object = sanitize_component(&host.name);
    let mut spec = CertificateSpec::new(
        format!("{prefix}-{object}"),
        host.name.clone(),
        CertKind::Server,
        leaf_days,
    )
    .with_roles(roles);
    spec.ip_sans = vec!["127.0.0.1".to_owned(), "::1".to_owned()];
    spec.dns_sans = vec!["localhost".to_owned()];
    spec = spec.with_host_san(host.peer_address());
    if host.peer_address() != host.name {
        spec = spec.with_dns(&host.name);
    }
    if !host.public_ip.trim().is_empty() {
        spec = spec.with_host_san(&host.public_ip);
    }
    spec
}

fn external_storage_spec(
    prefix: &str,
    value: &str,
    roles: &[&str],
    leaf_days: u16,
) -> CertificateSpec {
    let value = value.trim();
    let object = sanitize_component(value);
    let (name, cn) = if value.parse::<IpAddr>().is_ok() {
        (format!("{prefix}-{object}"), format!("{prefix}.internal"))
    } else {
        (format!("{prefix}-{object}"), value.to_owned())
    };
    let mut spec = CertificateSpec::new(name, cn, CertKind::Server, leaf_days).with_roles(roles);
    spec.ip_sans = vec!["127.0.0.1".to_owned(), "::1".to_owned()];
    spec.dns_sans = vec!["localhost".to_owned()];
    spec = spec.with_host_san(value);
    spec
}

/// The local development / CI bundle written by `pgctl pki dev`.
///
/// Output file names match `core-back/scripts/generate-mtls-certs.ts` (`internal-ca.crt`,
/// `core-back.crt`, `admin-back-client.crt`, ...) so existing local tests keep working. The CN of
/// the dev server is `core-back`, exactly like the script; production uses `core-back.internal`.
#[must_use]
pub fn dev_specs(days: u16) -> Vec<CertificateSpec> {
    let mut specs = Vec::new();

    let mut core = CertificateSpec::new("core-back", "core-back", CertKind::ServerClient, days)
        .with_roles(&["core", "server"]);
    core.dns_sans = vec!["core-back.internal".to_owned(), "core-back".to_owned()];
    core.ip_sans = vec!["127.0.0.1".to_owned(), "::1".to_owned()];
    specs.push(core);

    for (name, cn, kind, roles) in STATIC_CLIENTS {
        specs.push(CertificateSpec::new(*name, *cn, *kind, days).with_roles(roles));
    }

    for (name, cn) in [
        ("fake-rails", "fakerails.internal"),
        ("backup-daemon", "backup-daemon.internal"),
        ("object-storage-daemon", "object-storage-daemon.internal"),
    ] {
        let mut spec = CertificateSpec::new(name, cn, CertKind::ServerClient, days);
        spec.dns_sans = vec![cn.to_owned(), "localhost".to_owned()];
        spec.ip_sans = vec!["127.0.0.1".to_owned(), "::1".to_owned()];
        specs.push(spec);
    }

    for (prefix, cn, roles) in [
        ("postgres", "localhost", &["postgres", "server"][..]),
        ("pgbouncer", "localhost", &["pgbouncer", "server"][..]),
        ("redis", "localhost", &["redis", "server"][..]),
    ] {
        let mut spec = CertificateSpec::new(format!("{prefix}-local"), cn, CertKind::Server, days)
            .with_roles(roles);
        spec.dns_sans = vec!["localhost".to_owned()];
        spec.ip_sans = vec!["127.0.0.1".to_owned(), "::1".to_owned()];
        specs.push(spec);
    }

    for spec in &mut specs {
        // Dev defaults are known-valid, so normalize cannot fail; ignore the result here and let
        // `issue` surface a precise error if a caller built a bad spec.
        let _ = spec.normalize();
    }
    specs.sort_by(|left, right| left.name.cmp(&right.name));
    specs
}

#[cfg(test)]
mod tests {
    use pg_deploy_config::{Environment, Host, Role};

    use super::*;

    fn config_with(hosts: Vec<Host>) -> PgctlConfig {
        let mut config = PgctlConfig::new(Environment::Development);
        config.hosts = hosts;
        config
    }

    fn host(name: &str, ip: &str, roles: &[Role]) -> Host {
        Host {
            name: name.to_owned(),
            address: ip.to_owned(),
            private_ip: ip.to_owned(),
            roles: roles.to_vec(),
            ..Host::default()
        }
    }

    #[test]
    fn topology_covers_core_edges_and_storage() {
        let mut config = config_with(vec![
            host("core-1", "10.0.0.11", &[Role::Core]),
            host("db-1", "10.0.0.21", &[Role::PgPrimary, Role::Pgbouncer]),
            host("redis-1", "10.0.0.31", &[Role::Redis]),
            host("backup-1", "10.0.0.41", &[Role::Backup]),
            host("obj-1", "10.0.0.51", &[Role::ObjectStorage]),
        ]);
        config.services.fake_rails.enabled = true;
        config.services.fake_rails.public_host = Some("rails.example.test".to_owned());
        config.database.mode = pg_deploy_config::DatabaseMode::Managed;
        config.redis.enabled = true;

        let specs = topology_specs(&config, 90);
        let by_name = |name: &str| {
            specs
                .iter()
                .find(|spec| spec.name == name)
                .unwrap_or_else(|| panic!("{name} missing from {specs:?}"))
        };

        let core = by_name("core-back");
        assert_eq!(core.cn, "core-back.internal");
        assert!(core.ip_sans.contains(&"10.0.0.11".to_owned()));
        assert!(core.ip_sans.contains(&"127.0.0.1".to_owned()));
        assert_eq!(core.kind, CertKind::ServerClient);

        // CNs the core channel guard checks, exactly.
        assert_eq!(by_name("admin-back-client").cn, "admin-back");
        assert_eq!(by_name("merchant-back-client").cn, "merchant-back");
        assert_eq!(by_name("checkout-back-client").cn, "checkout-back");

        assert_eq!(by_name("fake-rails").cn, "rails.example.test");
        assert_eq!(by_name("backup-daemon").cn, "backup-daemon.internal");
        assert_eq!(
            by_name("object-storage-daemon").cn,
            "object-storage-daemon.internal"
        );
        assert!(by_name("postgres-db-1")
            .ip_sans
            .contains(&"10.0.0.21".to_owned()));
        assert!(by_name("pgbouncer-db-1")
            .ip_sans
            .contains(&"10.0.0.21".to_owned()));
        assert!(by_name("redis-redis-1")
            .ip_sans
            .contains(&"10.0.0.31".to_owned()));

        // Everything the daemons accept by CN must exist.
        for required in [
            "pg-client",
            "redis-client",
            "backup-client",
            "backup-admin",
            "wal-archive-client",
            "object-storage-client",
            "audit-db-client",
            "log-db-client",
            "fake-rails-client",
        ] {
            assert_eq!(by_name(required).cn, required);
        }
        assert!(specs
            .iter()
            .all(|spec| !spec.san_values().is_empty() || spec.kind == CertKind::Client));
    }

    #[test]
    fn external_storage_gets_server_certificates() {
        let mut config = config_with(vec![host("core-1", "10.0.0.11", &[Role::Core])]);
        config.database.mode = pg_deploy_config::DatabaseMode::Managed;
        config.database.host = Some("db.external.test".to_owned());
        config.database.pgbouncer = true;
        config.redis.host = Some("10.0.0.31".to_owned());

        let specs = topology_specs(&config, 90);
        let postgres = specs
            .iter()
            .find(|spec| spec.name.starts_with("postgres-"))
            .expect("postgres certificate");
        assert!(postgres.dns_sans.contains(&"db.external.test".to_owned()));
        let redis = specs
            .iter()
            .find(|spec| spec.name.starts_with("redis-"))
            .expect("redis certificate");
        assert!(redis.ip_sans.contains(&"10.0.0.31".to_owned()));
    }

    #[test]
    fn database_host_alias_is_covered_by_the_postgres_certificate() {
        let mut config = config_with(vec![host("db-1", "10.0.0.21", &[Role::PgPrimary])]);
        config.database.mode = pg_deploy_config::DatabaseMode::Managed;
        config.database.host = Some("pg.example.internal".to_owned());
        let specs = topology_specs(&config, 90);
        let postgres = specs
            .iter()
            .find(|spec| spec.name == "postgres-db-1")
            .expect("postgres");
        assert!(postgres
            .dns_sans
            .contains(&"pg.example.internal".to_owned()));
        assert!(postgres.ip_sans.contains(&"10.0.0.21".to_owned()));
    }

    #[test]
    fn server_specs_require_a_san_and_valid_names() {
        let mut spec = CertificateSpec::new("srv", "srv.internal", CertKind::Server, 90);
        assert!(spec.normalize().is_err());
        spec.dns_sans.push("srv.internal".to_owned());
        assert!(spec.normalize().is_ok());

        let mut bad = CertificateSpec::new("bad name", "x", CertKind::Client, 90);
        assert!(bad.normalize().is_err());
        let mut zero = CertificateSpec::new("zero", "zero", CertKind::Client, 0);
        assert!(zero.normalize().is_err());
    }

    #[test]
    fn dev_bundle_matches_the_typescript_script() {
        let specs = dev_specs(825);
        let core = specs
            .iter()
            .find(|spec| spec.name == "core-back")
            .expect("core-back");
        assert_eq!(core.cn, "core-back");
        assert!(core.dns_sans.contains(&"core-back.internal".to_owned()));
        assert!(core.ip_sans.contains(&"127.0.0.1".to_owned()));
        for name in [
            "admin-back-client",
            "merchant-back-client",
            "checkout-back-client",
            "postgres-local",
            "pgbouncer-local",
            "redis-local",
        ] {
            assert!(specs.iter().any(|spec| spec.name == name), "{name}");
        }
    }

    #[test]
    fn names_are_unique_and_sorted() {
        let mut config = config_with(vec![
            host("core-1", "10.0.0.11", &[Role::Core]),
            host("db-1", "10.0.0.21", &[Role::PgPrimary]),
        ]);
        config.services.fake_rails.enabled = true;
        let specs = topology_specs(&config, 90);
        let mut names: Vec<&str> = specs.iter().map(|spec| spec.name.as_str()).collect();
        let unique = names.len();
        names.dedup();
        assert_eq!(names.len(), unique, "duplicate certificate name");
        let mut sorted = names.clone();
        sorted.sort_unstable();
        assert_eq!(names, sorted);
    }
}

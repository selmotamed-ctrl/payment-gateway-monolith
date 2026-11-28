//! Redis / Valkey provisioner plan (D5-T03, S-SEC-06).
//!
//! Port of `provisionRedis` (`deploy/provisioners/redisProvisioner.ts`) plus the target rules:
//! TLS-only listener (`port 0` + `tls-port`), `tls-auth-clients yes`, ACL users `core`, `worker`
//! and `backup`, AOF `everysec`, `volatile-ttl` eviction (a revoked session must not be evicted
//! like a cache entry) and optional three-instance Sentinel.
//!
//! Differences from the TS engine, recorded in `DEVIATIONS.md`: one pgctl-owned configuration
//! path (`/etc/pg-redis/redis.conf`) replaces the three distro paths and the unit drop-in points
//! the packaged unit at it, so Redis and Valkey converge identically.

#![forbid(unsafe_code)]

use std::collections::BTreeSet;

use pg_deploy_config::PgctlConfig;

use super::model::{
    codes, ProvisionFinding, ProvisionHost, ProvisionMode, ProvisionPlan, ProvisionStep,
    ProvisionTarget, RestartPolicy, StepKind, UnitAction, VerifyExpect,
};
use super::render::{
    redis_acl, redis_apply_script, redis_conf, redis_dropin, redis_firewall_script, secret_name,
    sentinel_conf, sentinel_unit,
};
use super::settings::{
    validate_storage, HostRef, RedisSettings, SentinelMode, StorageSettings, Topology,
};
use super::steps::{file_step, packages_step, script_step, systemd_step, verify_step};
use super::{fingerprint_of, GENERATOR};

/// Redis TLS directory.
pub const REDIS_TLS_DIR: &str = "/etc/pg-redis/tls";
/// Redis configuration directory.
pub const REDIS_CONFIG_DIR: &str = "/etc/pg-redis";
/// Sentinel monitor name.
pub const SENTINEL_MONITOR: &str = "pg-redis";

/// Build the Redis/Valkey plan.
#[must_use]
pub fn plan_redis(
    config: &PgctlConfig,
    settings: &StorageSettings,
    topology: &Topology,
    mode: ProvisionMode,
) -> ProvisionPlan {
    let mut plan = ProvisionPlan {
        environment: config.deployment.environment.as_str().to_owned(),
        target: ProvisionTarget::Redis,
        mode,
        generator: GENERATOR,
        ..ProvisionPlan::default()
    };
    plan.findings = validate_storage(settings, topology, config);
    if !settings.redis.enabled {
        plan.notes.push(
            "redis.enabled = false: the cache/velocity tier is not part of this deployment"
                .to_owned(),
        );
        plan.fingerprint = fingerprint_of(&plan);
        return plan;
    }
    if topology.redis.is_empty() {
        plan.findings.push(ProvisionFinding::error(
            codes::REDIS_HOST,
            "redis.host",
            "redis is enabled but no host carries the redis role",
        ));
        plan.fingerprint = fingerprint_of(&plan);
        return plan;
    }
    if !settings.redis.tls {
        plan.notes.push(
            "TLS is disabled for Redis: the TS engine used plaintext, but production requires tls = true (S-SEC-06)"
                .to_owned(),
        );
    }
    if settings.redis.acl {
        plan.notes.push(
            "ACL users core/worker/backup replace requirepass; passwords are rendered as {{secret:<name>}} and resolved at apply time"
                .to_owned(),
        );
    }
    let sources = source_addresses(topology, &mut plan.findings);
    for host in &topology.redis {
        plan.hosts.push(ProvisionHost {
            id: host.id.clone(),
            address: host.address.clone(),
            role: "redis".to_owned(),
            service: "pg-redis".to_owned(),
            port: host.port,
            cluster: None,
            steps: redis_steps(settings, host, &sources),
        });
    }
    if settings.redis.ha == SentinelMode::Sentinel {
        let sentinels = sentinel_targets(&settings.redis, topology);
        for (index, (id, address, bind_ip, sentinel_port)) in sentinels.iter().enumerate() {
            let sentinel_port = *sentinel_port;
            plan.hosts.push(ProvisionHost {
                id: id.clone(),
                address: address.clone(),
                role: format!("sentinel:{}", index + 1),
                service: format!("pg-redis-sentinel-{}", index + 1),
                port: sentinel_port,
                cluster: None,
                steps: sentinel_steps(
                    settings,
                    &topology.redis[0],
                    bind_ip,
                    u8::try_from(index + 1).unwrap_or(1),
                    sentinel_port,
                ),
            });
        }
    }
    plan.fingerprint = fingerprint_of(&plan);
    plan
}

fn source_addresses(topology: &Topology, findings: &mut Vec<ProvisionFinding>) -> Vec<String> {
    let mut addresses = BTreeSet::new();
    for host in topology.core.iter().chain(topology.backup.iter()) {
        if super::settings::parse_address(&host.private_ip).is_some() {
            addresses.insert(host.private_ip.clone());
        } else {
            findings.push(ProvisionFinding::error(
                codes::INVALID_ADDRESS,
                "hosts[].private_ip",
                format!(
                    "'{}' is not an IPv4/IPv6 literal for the Redis firewall allowlist",
                    host.private_ip
                ),
            ));
        }
    }
    addresses.into_iter().collect()
}

/// `(id, ssh address, bind ip)` for every Sentinel instance.
fn sentinel_targets(
    settings: &RedisSettings,
    topology: &Topology,
) -> Vec<(String, String, String, u16)> {
    if settings.sentinel_hosts.is_empty() {
        let host = &topology.redis[0];
        return (0..3)
            .map(|index| {
                (
                    format!("sentinel-{}", index + 1),
                    host.address.clone(),
                    host.private_ip.clone(),
                    settings.sentinel_port + u16::try_from(index).unwrap_or(0),
                )
            })
            .collect();
    }
    settings
        .sentinel_hosts
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let mut parts = entry.split(':');
            let address = parts.next().unwrap_or(entry).to_owned();
            let port = parts
                .next()
                .and_then(|port| port.parse::<u16>().ok())
                .unwrap_or(settings.sentinel_port + u16::try_from(index).unwrap_or(0));
            (
                format!("sentinel-{}", index + 1),
                address.clone(),
                address,
                port,
            )
        })
        .collect()
}

fn redis_steps(
    settings: &StorageSettings,
    host: &HostRef,
    sources: &[String],
) -> Vec<ProvisionStep> {
    let redis = &settings.redis;
    let (debian, arch) = redis.engine.packages();
    let mut steps = vec![packages_step(
        "install-redis",
        format!("install the {} package", redis.engine.as_str()),
        debian,
        arch,
    )];
    if redis.tls {
        steps.push(script_step(
            "verify-tls-material",
            format!("verify the internal-CA material under {REDIS_TLS_DIR}"),
            StepKind::TlsMaterial,
            true,
            redis_tls_script(),
            RestartPolicy::None,
            Vec::new(),
        ));
    }
    steps.push(file_step(
        "redis-conf",
        format!("write {REDIS_CONFIG_DIR}/redis.conf"),
        StepKind::ConfigFile,
        format!("{REDIS_CONFIG_DIR}/redis.conf"),
        0o640,
        "root",
        "root",
        redis_conf(
            redis,
            &host.private_ip,
            REDIS_TLS_DIR,
            &format!("{REDIS_CONFIG_DIR}/users.acl"),
        ),
        RestartPolicy::RestartIfChanged,
        if redis.acl {
            Vec::new()
        } else {
            secret_name(&redis.password).into_iter().collect()
        },
    ));
    if redis.acl {
        let (acl, secrets) = redis_acl(redis);
        steps.push(file_step(
            "redis-acl",
            format!("write {REDIS_CONFIG_DIR}/users.acl (core, worker, backup)"),
            StepKind::ConfigFile,
            format!("{REDIS_CONFIG_DIR}/users.acl"),
            0o600,
            "root",
            "root",
            acl,
            RestartPolicy::RestartIfChanged,
            secrets,
        ));
    }
    for unit in redis.engine.unit_candidates() {
        steps.push(file_step(
            &format!("redis-dropin-{unit}"),
            format!("point {unit}.service at the pgctl configuration"),
            StepKind::Unit,
            format!("/etc/systemd/system/{unit}.service.d/zz-pgctl.conf"),
            0o644,
            "root",
            "root",
            redis_dropin(redis.engine),
            RestartPolicy::RestartIfChanged,
            Vec::new(),
        ));
    }
    steps.push(systemd_step(
        "redis-daemon-reload",
        "systemctl daemon-reload after the drop-ins",
        "redis-server",
        UnitAction::DaemonReload,
    ));
    steps.push(script_step(
        "redis-ownership",
        "create the state directory and give the unit user ownership of config, ACL and TLS",
        StepKind::Service,
        true,
        redis_ownership_script(&redis.data_dir),
        RestartPolicy::None,
        Vec::new(),
    ));
    steps.push(script_step(
        "redis-firewall",
        "allow the Redis port from the core and backup hosts only",
        StepKind::Firewall,
        true,
        redis_firewall_script(sources, redis.port),
        RestartPolicy::None,
        Vec::new(),
    ));
    steps.push(script_step(
        "apply-redis",
        format!(
            "start or restart Redis only when the configuration changed and wait for PING on :{}",
            redis.port
        ),
        StepKind::Service,
        true,
        redis_apply_script(
            "",
            redis.port,
            redis.tls,
            redis.acl,
            "core",
            REDIS_TLS_DIR,
            true,
            false,
        ),
        RestartPolicy::RestartIfChanged,
        if redis.acl {
            vec!["redis_core_password".to_owned()]
        } else {
            secret_name(&redis.password).into_iter().collect()
        },
    ));
    let (ping_script, ping_secrets) = redis_checked_script(redis, "core", "PING", "grep -qx PONG");
    steps.push(script_step(
        "verify-ping",
        "the TLS listener answers PING with the core ACL user",
        StepKind::Verify,
        false,
        ping_script,
        RestartPolicy::None,
        ping_secrets,
    ));
    if redis.tls {
        steps.push(verify_step(
            "verify-tls-only",
            "the plaintext port is closed (port 0)",
            format!(
                "if redis-cli -p {} PING >/dev/null 2>&1; then echo 'plaintext Redis answered: TLS-only is not enforced' >&2; exit 1; fi",
                redis.port
            ),
            VerifyExpect::ExitZero,
        ));
        let (acl_script, acl_secrets) =
            redis_checked_script(redis, "core", "ACL LIST", "grep -q '^user default off'");
        steps.push(script_step(
            "verify-acl",
            "the default user is disabled",
            StepKind::Verify,
            false,
            acl_script,
            RestartPolicy::None,
            acl_secrets,
        ));
    }
    steps
}

fn sentinel_steps(
    settings: &StorageSettings,
    redis_host: &HostRef,
    bind_ip: &str,
    instance: u8,
    sentinel_port: u16,
) -> Vec<ProvisionStep> {
    let mut redis = settings.redis.clone();
    redis.port = redis_host.port;
    let redis = &redis;
    let unit = format!("pg-redis-sentinel-{instance}");
    let conf_path = format!("{REDIS_CONFIG_DIR}/sentinel-{instance}.conf");
    let (config, secrets) = (
        sentinel_conf(
            redis,
            bind_ip,
            &redis_host.private_ip,
            REDIS_TLS_DIR,
            sentinel_port,
            SENTINEL_MONITOR,
        ),
        if redis.acl {
            vec![secret_name(&redis.core_password)
                .unwrap_or_else(|| "redis_core_password".to_owned())]
        } else {
            vec![secret_name(&redis.password).unwrap_or_else(|| "redis_password".to_owned())]
        },
    );
    vec![
        packages_step(
            "install-sentinel",
            "the Sentinel instances use the same Redis/Valkey package",
            redis.engine.packages().0,
            redis.engine.packages().1,
        ),
        script_step(
            "verify-tls-material",
            format!("verify the internal-CA material under {REDIS_TLS_DIR}"),
            StepKind::TlsMaterial,
            true,
            redis_tls_script(),
            RestartPolicy::None,
            Vec::new(),
        ),
        file_step(
            "sentinel-conf",
            format!("write {conf_path}"),
            StepKind::Sentinel,
            &conf_path,
            0o640,
            "root",
            "root",
            config,
            RestartPolicy::RestartIfChanged,
            secrets,
        ),
        file_step(
            "sentinel-unit",
            format!("write the {unit} unit"),
            StepKind::Unit,
            format!("/etc/systemd/system/{unit}.service"),
            0o644,
            "root",
            "root",
            sentinel_unit(redis.engine, instance),
            RestartPolicy::RestartIfChanged,
            Vec::new(),
        ),
        systemd_step(
            "sentinel-daemon-reload",
            "systemctl daemon-reload",
            &unit,
            UnitAction::DaemonReload,
        ),
        script_step(
            "apply-sentinel",
            format!("start or restart {unit} and wait for the monitor"),
            StepKind::Service,
            true,
            sentinel_apply_script(&unit, &conf_path, sentinel_port, redis.tls),
            RestartPolicy::RestartIfChanged,
            Vec::new(),
        ),
        verify_step(
            "verify-monitor",
            format!("{unit} knows the master address"),
            format!(
                "redis-cli {} -p {sentinel_port} SENTINEL get-master-addr-by-name {SENTINEL_MONITOR}",
                if redis.tls {
                    format!("--tls --cacert {REDIS_TLS_DIR}/ca.crt")
                } else {
                    String::new()
                }
            ),
            VerifyExpect::Contains {
                value: redis_host.private_ip.clone(),
            },
        ),
    ]
}

/// A `redis-cli` check that needs the ACL password: the executor sets `REDISCLI_AUTH` from the
/// named secret, the script never carries it.
fn redis_checked_script(
    redis: &RedisSettings,
    user: &str,
    arguments: &str,
    filter: &str,
) -> (String, Vec<String>) {
    let tls = if redis.tls {
        format!("--tls --cacert {REDIS_TLS_DIR}/ca.crt")
    } else {
        String::new()
    };
    let user_argument = if redis.acl {
        format!("--user {user}")
    } else {
        String::new()
    };
    let secret = if redis.acl {
        secret_name(&redis.core_password).unwrap_or_else(|| "redis_core_password".to_owned())
    } else {
        secret_name(&redis.password).unwrap_or_else(|| "redis_password".to_owned())
    };
    (
        format!(
            "set -eu\nREDISCLI_AUTH=\"${{REDISCLI_AUTH:?REDISCLI_AUTH must be set by the executor}}\"\nredis-cli {tls} {user_argument} -p {} {arguments} | {filter}",
            redis.port
        ),
        vec![secret],
    )
}

/// Internal-CA material for Redis (D4-T02).
#[must_use]
pub fn redis_tls_script() -> String {
    super::postgres::tls_material_script(REDIS_TLS_DIR, "root", "root", false)
}

/// Resolve the installed unit user and converge ownership.
#[must_use]
pub fn redis_ownership_script(data_dir: &str) -> String {
    format!(
        "set -eu
unit=''
for u in redis-server redis valkey; do for d in /etc/systemd/system /usr/lib/systemd/system /lib/systemd/system; do if [ -f \"$d/$u.service\" ] && [ ! -L \"$d/$u.service\" ]; then unit=\"$u\"; break 2; fi; done; done
[ -n \"$unit\" ] || unit=redis-server
owner=\"$(systemctl show -p User --value \"$unit\" 2>/dev/null || true)\"
[ -n \"$owner\" ] || owner=redis
id \"$owner\" >/dev/null 2>&1 || owner=valkey
id \"$owner\" >/dev/null 2>&1 || owner=root
install -d -m 0750 {dir}
install -d -m 0750 {tls}
install -d -m 0750 -o \"$owner\" -g \"$owner\" {data}
chown -R \"$owner:\" {dir}
chmod 0640 {dir}/redis.conf
chmod 0600 {dir}/users.acl 2>/dev/null || true
if [ -s {tls}/server.key ]; then chmod 0600 {tls}/server.key; fi
if [ -s {tls}/server.crt ]; then chmod 0644 {tls}/server.crt; fi
if [ -s {tls}/ca.crt ]; then chmod 0644 {tls}/ca.crt; fi
if [ -s {tls}/crl.pem ]; then chmod 0644 {tls}/crl.pem; fi",
        dir = REDIS_CONFIG_DIR,
        tls = REDIS_TLS_DIR,
        data = data_dir,
    )
}

/// Sentinel convergence: start if down, restart when the file changed.
#[must_use]
pub fn sentinel_apply_script(unit: &str, conf_path: &str, port: u16, tls: bool) -> String {
    let tls_args = if tls {
        format!("--tls --cacert {REDIS_TLS_DIR}/ca.crt")
    } else {
        String::new()
    };
    format!(
        "set -u
install -d -m 0750 /var/lib/pg-redis
marker=/var/lib/pg-redis/.{unit}.applied
desired=$(sha256sum {conf_path} | cut -d' ' -f1)
if ! systemctl is-active --quiet {unit}; then
  systemctl enable {unit} >/dev/null 2>&1 || true
  systemctl start {unit}
  echo __PG_APPLY__=started
elif [ -f \"$marker\" ] && [ \"$(cat \"$marker\")\" = \"$desired\" ]; then
  echo __PG_APPLY__=unchanged
  exit 0
else
  systemctl restart {unit}
  echo __PG_APPLY__=restarted
fi
printf '%s\\n' \"$desired\" > \"$marker\"
for i in $(seq 1 30); do redis-cli {tls_args} -p {port} SENTINEL get-master-addr-by-name {SENTINEL_MONITOR} >/dev/null 2>&1 && exit 0; sleep 1; done
echo 'Sentinel did not answer within 30s' >&2; exit 1"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::settings::StorageSettings;
    use pg_deploy_config::{Environment, Host, PgctlConfig, Role};

    fn config() -> PgctlConfig {
        let mut config = PgctlConfig::new(Environment::Test);
        config.redis.enabled = true;
        config.redis.tls = true;
        config.redis.password = Some("secret:redis_password".to_owned());
        config.hosts = vec![
            Host {
                name: "redis-1".to_owned(),
                address: "10.0.0.40".to_owned(),
                private_ip: "10.0.0.40".to_owned(),
                roles: vec![Role::Redis],
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
        config
    }

    #[test]
    fn redis_plan_is_tls_only_with_acl_and_aof() {
        let config = config();
        let settings = StorageSettings::from_config(&config);
        let topology = Topology::from_config(&config);
        let plan = plan_redis(&config, &settings, &topology, ProvisionMode::Fresh);
        assert_eq!(plan.hosts.len(), 1);
        let text = serde_json::to_string(&plan).unwrap_or_default();
        assert!(text.contains("tls-port 6379"));
        assert!(text.contains("port 0"));
        assert!(text.contains("tls-auth-clients yes"));
        assert!(text.contains("appendonly yes"));
        assert!(text.contains("volatile-ttl"));
        assert!(text.contains("users.acl"));
        assert!(text.contains("verify-tls-only"));
        assert!(text.contains("ufw allow from 10.0.0.11"));
        assert!(!text.contains("10.0.0.40 to any port"));
        assert!(!text.contains("[ true = 1 ]"));
        assert!(!text.contains("[ false = 1 ]"));
    }

    #[test]
    fn sentinel_plan_has_three_instances_only_when_requested() {
        let config = config();
        let mut settings = StorageSettings::from_config(&config);
        settings.redis.ha = SentinelMode::Sentinel;
        let topology = Topology::from_config(&config);
        let plan = plan_redis(&config, &settings, &topology, ProvisionMode::Update);
        let sentinels: Vec<&ProvisionHost> = plan
            .hosts
            .iter()
            .filter(|host| host.role.starts_with("sentinel"))
            .collect();
        assert_eq!(sentinels.len(), 3);
        assert!(plan.notes.iter().all(|note| !note.contains("not part")));
        let mut two = settings.clone();
        two.redis.sentinel_hosts = vec!["10.0.0.41".to_owned(), "10.0.0.42".to_owned()];
        let plan = plan_redis(&config, &two, &topology, ProvisionMode::Update);
        assert!(plan
            .findings
            .iter()
            .any(|finding| finding.code == codes::REDIS_SENTINEL));
    }

    #[test]
    fn disabled_redis_is_a_no_op() {
        let mut config = config();
        config.redis.enabled = false;
        let settings = StorageSettings::from_config(&config);
        let topology = Topology::from_config(&config);
        let plan = plan_redis(&config, &settings, &topology, ProvisionMode::Update);
        assert!(plan.hosts.is_empty());
        assert!(plan.notes.iter().any(|note| note.contains("not part")));
    }
}

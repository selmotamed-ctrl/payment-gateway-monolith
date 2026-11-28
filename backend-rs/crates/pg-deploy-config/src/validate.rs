//! Validation: the cross-field rules of `deploy/lib/configSchema.ts` plus the new rules of
//! chapter 7 §7.
//!
//! The TypeScript engine returned a flat `string[]`; here every finding carries a stable code and
//! a dotted TOML path so `pgctl config validate` and CI can act on it. Messages never contain a
//! secret value: the model only holds references, and the importer reports secret *names* only.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::net::IpAddr;

use ipnet::IpNet;

use crate::model::{DatabaseMode, Host, PgctlConfig, Role, S3Mode, TlsMode};
use crate::problem::{codes, ConfigProblem};

/// The placeholder markers of `weakSecretReason` (port verbatim).
const PLACEHOLDER_MARKERS: &[&str] = &[
    "change-me",
    "changeme",
    "change_me",
    "replace-me",
    "replaceme",
    "replace_me",
    "your-",
    "your_",
    "example",
    "placeholder",
    "password",
    "passwd",
    "admin",
    "default",
    "secret123",
    "xxxx",
];

/// Roles whose passwords are referenced by the model. Exposed for tooling and tests; every path
/// here must be validated as `secret:<name>`.
pub const SECRET_FIELDS: &[&str] = &[
    "database.owner_password",
    "database.app_password",
    "database.replication_password",
    "database.url",
    "redis.password",
    "object_storage.kek",
    "backup.access_key",
    "backup.secret_key",
];

/// True when a value is a reference into the encrypted store (`secret:<name>`).
#[must_use]
pub fn is_secret_reference(value: &str) -> bool {
    value.strip_prefix("secret:").is_some_and(|name| {
        !name.is_empty()
            && name
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' || ch == '.')
    })
}

/// Luhn mod-10 check for a digit string.
#[must_use]
pub fn luhn_valid(digits: &str) -> bool {
    if digits.is_empty() {
        return false;
    }
    let mut sum = 0u32;
    let mut double = false;
    for byte in digits.bytes().rev() {
        if !byte.is_ascii_digit() {
            return false;
        }
        let mut digit = u32::from(byte - b'0');
        if double {
            digit *= 2;
            if digit > 9 {
                digit -= 9;
            }
        }
        sum += digit;
        double = !double;
    }
    sum.is_multiple_of(10)
}

/// True when the text contains a standalone Luhn-valid 13-19 digit run (card PAN shape).
/// Port of `looksLikeCardPan`, but without the regex crate: the boundary rule (`[\w-]`) is
/// implemented by hand and an underscore is treated like `\w`.
#[must_use]
pub fn looks_like_card_pan(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    let boundary = |ch: char| !(ch.is_ascii_alphanumeric() || ch == '_' || ch == '-');
    let mut index = 0usize;
    while index < chars.len() {
        if !chars[index].is_ascii_digit() {
            index += 1;
            continue;
        }
        if index > 0 && !boundary(chars[index - 1]) {
            index += 1;
            continue;
        }
        let start = index;
        let mut digits = String::new();
        let mut cursor = index;
        while cursor < chars.len() {
            let ch = chars[cursor];
            if ch.is_ascii_digit() {
                digits.push(ch);
                cursor += 1;
            } else if (ch == ' ' || ch == '-')
                && cursor + 1 < chars.len()
                && chars[cursor + 1].is_ascii_digit()
            {
                cursor += 1;
            } else {
                break;
            }
        }
        let ends_cleanly = cursor >= chars.len() || boundary(chars[cursor]);
        if ends_cleanly && (13..=19).contains(&digits.len()) && luhn_valid(&digits) {
            return true;
        }
        index = cursor.max(start + 1);
    }
    false
}

/// Port of the TS `PAN_KEY` guard: a key that names card data is refused outright.
#[must_use]
pub fn is_pan_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    let segments: Vec<&str> = upper.split('_').collect();
    const NAMES: &[&str] = &[
        "PAN",
        "CVV",
        "CVV2",
        "CVC",
        "CVC2",
        "CARD_NUMBER",
        "CARD_NO",
        "PAN_RAIL",
        "PAN_RAILS",
        "CARD_RAIL",
        "CARD_RAILS",
    ];
    NAMES.iter().any(|name| {
        let parts: Vec<&str> = name.split('_').collect();
        segments
            .windows(parts.len())
            .any(|window| window == parts.as_slice())
    })
}

/// Port of `panRailGuardProblems`: deploy configuration must never carry PAN rails or card data
/// (the gateway is out of PCI cardholder-data scope; `docs/pci-scope.md`).
#[must_use]
pub fn pan_rail_guard(values: &BTreeMap<String, String>) -> Vec<ConfigProblem> {
    let mut problems = Vec::new();
    for (key, value) in values {
        if is_pan_key(key) {
            problems.push(ConfigProblem::error(
                codes::PAN_RAIL_GUARD,
                format!("extra.{key}"),
                format!(
                    "{key} is refused: card PAN/CVV rails are out of PCI scope (docs/pci-scope.md)"
                ),
            ));
        } else if looks_like_card_pan(value) {
            problems.push(ConfigProblem::error(
                codes::PAN_RAIL_GUARD,
                format!("extra.{key}"),
                format!("{key} holds card-PAN-shaped data (Luhn-valid 13-19 digits); refused"),
            ));
        }
    }
    problems
}

/// Port of `weakSecretReason`: `Some(reason)` when a secret looks like a placeholder or has low
/// entropy. Used by the importer, where literal values still exist.
#[must_use]
pub fn weak_secret_reason(value: &str) -> Option<String> {
    let lower = value.to_ascii_lowercase();
    if let Some(marker) = PLACEHOLDER_MARKERS
        .iter()
        .find(|marker| lower.contains(*marker))
    {
        return Some(format!(
            "contains the placeholder/guessable word '{marker}' - replace this placeholder with a generated secret (e.g. 'openssl rand -base64 36')"
        ));
    }
    let chars: Vec<char> = value.chars().collect();
    if chars.is_empty() {
        return None;
    }
    if chars.iter().all(|ch| *ch == chars[0]) {
        return Some("is a single repeated character".to_owned());
    }
    for unit in 1..=16usize {
        if chars.len() >= unit * 2
            && chars.len().is_multiple_of(unit)
            && (0..chars.len()).all(|index| chars[index] == chars[index % unit])
        {
            return Some("is a repeated pattern".to_owned());
        }
    }
    let mut ascending = 1usize;
    let mut descending = 1usize;
    for window in chars.windows(2) {
        let delta = window[1] as i32 - window[0] as i32;
        ascending = if delta == 1 { ascending + 1 } else { 1 };
        descending = if delta == -1 { descending + 1 } else { 1 };
        if ascending >= 8 || descending >= 8 {
            return Some("contains a sequential run (e.g. 01234567 / abcdefgh)".to_owned());
        }
    }
    let distinct = chars
        .iter()
        .collect::<std::collections::BTreeSet<_>>()
        .len();
    if chars.len() >= 24 && distinct < 10 {
        return Some("has too few distinct characters (low entropy)".to_owned());
    }
    if chars.len() >= 12 && distinct < 6 {
        return Some("has too few distinct characters (low entropy)".to_owned());
    }
    None
}

/// True for a comma free, whitespace free PostgreSQL identifier (`[A-Za-z0-9_]`, 1..=64).
#[must_use]
pub fn is_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

/// True for an FQDN as the TS `domain` schema accepts it.
#[must_use]
pub fn is_fqdn(value: &str) -> bool {
    if value.len() < 3 || value.len() > 253 || !value.contains('.') {
        return false;
    }
    value.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && label
                .chars()
                .next()
                .is_some_and(|ch| ch.is_ascii_alphanumeric())
            && label
                .chars()
                .last()
                .is_some_and(|ch| ch.is_ascii_alphanumeric())
            && label
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
    })
}

/// True for a CIDR that `ipnet` accepts (IPv4 or IPv6).
#[must_use]
pub fn is_cidr(value: &str) -> bool {
    value.parse::<IpNet>().is_ok()
}

/// True for `http(s)://host[:port]` with no path, query, fragment or userinfo.
#[must_use]
pub fn is_http_origin(value: &str) -> bool {
    let Some(rest) = value
        .strip_prefix("https://")
        .or_else(|| value.strip_prefix("http://"))
    else {
        return false;
    };
    !rest.is_empty()
        && !rest.contains('/')
        && !rest.contains('@')
        && !rest.contains('?')
        && !rest.contains('#')
        && rest
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | ':' | '[' | ']'))
}

/// True for an absolute `https://` URL with a host and no whitespace.
#[must_use]
pub fn is_https_url(value: &str) -> bool {
    value.starts_with("https://") && is_http_url(value)
}

/// True for an absolute `http(s)://` URL with a host and no whitespace; a path is allowed.
#[must_use]
pub fn is_http_url(value: &str) -> bool {
    let Some(rest) = value
        .strip_prefix("https://")
        .or_else(|| value.strip_prefix("http://"))
    else {
        return false;
    };
    let host = rest.split(['/', ':']).next().unwrap_or_default();
    !host.is_empty() && !value.chars().any(char::is_whitespace)
}

/// True for a normalized absolute POSIX path using the TS `SAFE_ABS_PATH` alphabet.
#[must_use]
pub fn is_safe_abs_path(value: &str) -> bool {
    if !value.starts_with('/') || value.len() > 300 {
        return false;
    }
    if value.split('/').any(|part| part == "..") {
        return false;
    }
    if value.contains("//") {
        return false;
    }
    value.chars().all(|ch| {
        ch == '/' || ch == '.' || ch.is_ascii_alphanumeric() || matches!(ch, '_' | '+' | '@' | '-')
    })
}

/// True for a cron field set the TS `cronExpr` schema accepts (charset and length only; the
/// scheduler validates the real syntax at run time).
#[must_use]
pub fn is_cron_like(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 120
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '*' | '/' | ',' | '@' | ' ' | '-'))
}

/// True for a unix account name the TS `unixUser` schema accepts.
#[must_use]
pub fn is_unix_user(value: &str) -> bool {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphabetic() || first == '_' => {}
        _ => return false,
    }
    value.len() <= 64 && chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

/// Validate a whole document.
///
/// Port of `deploy/lib/configSchema.ts:validateDeployConfig` plus the new rules of chapter 7 §7.
/// Deterministic: findings are sorted by code, path and message and duplicates are removed.
#[must_use]
pub fn validate(config: &PgctlConfig) -> Vec<ConfigProblem> {
    let mut problems = Vec::new();
    check_version(config, &mut problems);
    check_hosts(config, &mut problems);
    check_database(config, &mut problems);
    check_ports(config, &mut problems);
    check_production_guards(config, &mut problems);
    check_tls(config, &mut problems);
    check_network(config, &mut problems);
    check_object_storage(config, &mut problems);
    check_shared_storage(config, &mut problems);
    check_backup(config, &mut problems);
    check_sandbox_and_seed(config, &mut problems);
    check_services(config, &mut problems);
    check_secret_references(config, &mut problems);
    check_watch_and_ssh(config, &mut problems);
    problems.extend(pan_rail_guard(&config.extra));
    problems.sort_by(|left, right| {
        (left.code, &left.path, &left.message).cmp(&(right.code, &right.path, &right.message))
    });
    problems.dedup();
    problems
}

fn check_version(config: &PgctlConfig, problems: &mut Vec<ConfigProblem>) {
    if config.version != crate::model::CONFIG_VERSION {
        problems.push(ConfigProblem::error(
            codes::INVALID_VERSION,
            "version",
            format!(
                "must be {} (found {}); a newer pgctl is required for this document",
                crate::model::CONFIG_VERSION,
                config.version
            ),
        ));
    }
}

fn check_hosts(config: &PgctlConfig, problems: &mut Vec<ConfigProblem>) {
    if config.hosts.is_empty() {
        problems.push(ConfigProblem::error(
            codes::NO_HOSTS,
            "hosts",
            "at least one host is required",
        ));
        return;
    }
    let mut names = std::collections::BTreeSet::new();
    for (index, host) in config.hosts.iter().enumerate() {
        let path = format!("hosts[{index}]");
        if host.name.is_empty()
            || !host
                .name
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-'))
        {
            problems.push(ConfigProblem::error(
                codes::INVALID_HOST_ADDRESS,
                format!("{path}.name"),
                "must be a non-empty node id using [A-Za-z0-9_.-]",
            ));
        } else if !names.insert(host.name.clone()) {
            problems.push(ConfigProblem::error(
                codes::DUPLICATE_HOST,
                format!("{path}.name"),
                format!("host name '{}' is used more than once", host.name),
            ));
        }
        check_host_address(host, &path, problems);
        if host.ssh_port == 0 {
            problems.push(ConfigProblem::error(
                codes::INVALID_SERVICE_PORT,
                format!("{path}.ssh_port"),
                "SSH port must be 1..65535",
            ));
        }
        if !is_unix_user(&host.ssh_user) {
            problems.push(ConfigProblem::error(
                codes::INVALID_SSH_USER,
                format!("{path}.ssh_user"),
                "must be a plain unix user name ([A-Za-z0-9_-], starting with a letter or _)",
            ));
        }
        if host.roles.is_empty() {
            problems.push(ConfigProblem::error(
                codes::NO_ROLES,
                format!("{path}.roles"),
                "a host must carry at least one role",
            ));
        }
        for (field, value) in [
            ("private_ip", &host.private_ip),
            ("public_ip", &host.public_ip),
        ] {
            if !value.is_empty() && value.parse::<IpAddr>().is_err() {
                problems.push(ConfigProblem::error(
                    codes::INVALID_IP,
                    format!("{path}.{field}"),
                    format!("'{value}' must be an IPv4 or IPv6 address"),
                ));
            }
        }
        if let Some(port) = host.service_port {
            if port == 0 {
                problems.push(ConfigProblem::error(
                    codes::INVALID_SERVICE_PORT,
                    format!("{path}.service_port"),
                    "service port must be 1..65535",
                ));
            }
        }
    }
}

fn check_host_address(host: &Host, path: &str, problems: &mut Vec<ConfigProblem>) {
    if host.address.is_empty() {
        problems.push(ConfigProblem::error(
            codes::INVALID_HOST_ADDRESS,
            format!("{path}.address"),
            "SSH address is required",
        ));
        return;
    }
    let valid = host.address.parse::<IpAddr>().is_ok()
        || (host.address.len() <= 253
            && !host.address.chars().any(char::is_whitespace)
            && host
                .address
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | ':' | '_')));
    if !valid {
        problems.push(ConfigProblem::error(
            codes::INVALID_HOST_ADDRESS,
            format!("{path}.address"),
            "must be an IP address or a DNS name without whitespace",
        ));
    }
}

fn check_database(config: &PgctlConfig, problems: &mut Vec<ConfigProblem>) {
    let database = &config.database;
    if !is_identifier(&database.name) {
        problems.push(ConfigProblem::error(
            codes::INVALID_DATABASE_NAME,
            "database.name",
            "must be a PostgreSQL identifier ([A-Za-z0-9_], at most 64 characters)",
        ));
    }
    for (field, role) in [
        ("owner_role", &database.owner_role),
        ("app_role", &database.app_role),
        ("replication_role", &database.replication_role),
    ] {
        if !is_identifier(role) {
            problems.push(ConfigProblem::error(
                codes::INVALID_DATABASE_NAME,
                format!("database.{field}"),
                "must be a PostgreSQL identifier ([A-Za-z0-9_], at most 64 characters)",
            ));
        } else if role.to_ascii_lowercase().starts_with("pg_") {
            problems.push(ConfigProblem::error(
                codes::RESERVED_ROLE_NAME,
                format!("database.{field}"),
                "must not start with pg_ (role names with that prefix are reserved by PostgreSQL)",
            ));
        }
    }
    if database.owner_role.eq_ignore_ascii_case("postgres") {
        problems.push(ConfigProblem::error(
            codes::RESERVED_ROLE_NAME,
            "database.owner_role",
            "must not be 'postgres': that is the cluster superuser",
        ));
    }
    if database.app_password.is_some() {
        let app = database.app_role.to_ascii_lowercase();
        if matches!(
            app.as_str(),
            "postgres" | "pgw_app" | "pgw_ledger_maintenance"
        ) {
            problems.push(ConfigProblem::error(
                codes::APP_ROLE_INVALID,
                "database.app_role",
                format!(
                    "'{}' is already a privileged or group role; choose a dedicated LOGIN role",
                    database.app_role
                ),
            ));
        }
        if database.app_role == database.owner_role {
            problems.push(ConfigProblem::error(
                codes::APP_ROLE_INVALID,
                "database.app_role",
                "must differ from owner_role: the application must not run as the database owner",
            ));
        }
        if database.app_role == database.replication_role {
            problems.push(ConfigProblem::error(
                codes::APP_ROLE_INVALID,
                "database.app_role",
                "must differ from replication_role",
            ));
        }
        if database.app_password == database.owner_password {
            problems.push(ConfigProblem::error(
                codes::APP_ROLE_INVALID,
                "database.app_password",
                "must differ from owner_password",
            ));
        }
    }
    if database.is_managed() {
        if database.host.is_none() {
            problems.push(ConfigProblem::error(
                codes::DATABASE_HOST_REQUIRED,
                "database.host",
                "is required when database.mode = 'managed'",
            ));
        }
        if !database.tls {
            problems.push(ConfigProblem::error(
                codes::STORAGE_TLS_REQUIRED,
                "database.tls",
                "must be true for a managed cluster: its pg_hba.conf is hostssl-only",
            ));
        }
    } else if database.host.is_none() && database.url.is_none() {
        problems.push(ConfigProblem::warning(
            codes::DATABASE_HOST_REQUIRED,
            "database.host",
            "neither host nor url is set; the runtime cannot reach an external database",
        ));
    }
    if database.mode == DatabaseMode::External && database.pgbouncer && !database.tls {
        problems.push(ConfigProblem::warning(
            codes::STORAGE_TLS_REQUIRED,
            "database.tls",
            "PgBouncer is configured without TLS; production requires encrypted database traffic",
        ));
    }
}

fn check_ports(config: &PgctlConfig, problems: &mut Vec<ConfigProblem>) {
    let listeners = config.backend_listeners();
    let mut by_port: BTreeMap<u16, Vec<&str>> = BTreeMap::new();
    for (port, path) in &listeners {
        if *port == 0 {
            problems.push(ConfigProblem::error(
                codes::INVALID_SERVICE_PORT,
                path.clone(),
                "port must be 1..65535",
            ));
            continue;
        }
        by_port.entry(*port).or_default().push(path);
    }
    for (port, paths) in by_port {
        if paths.len() > 1 {
            problems.push(ConfigProblem::error(
                codes::PORT_COLLISION,
                paths[1],
                format!(
                    "port {port} is claimed by both {} and {}",
                    paths[0], paths[1]
                ),
            ));
        }
    }
    if config.services.core.enabled
        && config.services.core.sandbox_port == config.services.core.port
    {
        problems.push(ConfigProblem::error(
            codes::PORT_COLLISION,
            "services.core.sandbox_port",
            "must differ from services.core.port",
        ));
    }
}

fn check_production_guards(config: &PgctlConfig, problems: &mut Vec<ConfigProblem>) {
    let fake_rails = &config.services.fake_rails;
    if fake_rails.enabled && !fake_rails.allow_in_production {
        problems.push(ConfigProblem::error(
            codes::FAKE_RAILS_PRODUCTION_GUARD_BLOCKED,
            "services.fake_rails.allow_in_production",
            "set true to run Fake Rails: it runs with NODE_ENV=production under PM2 and its runtime guard keys off that",
        ));
    }
    if config.is_production() {
        if fake_rails.enabled && fake_rails.allow_in_production {
            problems.push(ConfigProblem::error(
                codes::FAKE_RAILS_PRODUCTION_GUARD_BLOCKED,
                "services.fake_rails.enabled",
                "Fake Rails cannot run in a production deployment, even with allow_in_production = true",
            ));
        }
        if config.seed.run_synthetic {
            problems.push(ConfigProblem::error(
                codes::SEED_PRODUCTION_GUARD,
                "seed.run_synthetic",
                "the synthetic history seed is refused in a production deployment",
            ));
        }
        if config.services.object_storage.enabled && config.object_storage.allow_insecure_http {
            problems.push(ConfigProblem::error(
                codes::OBJECT_STORAGE_INSECURE_HTTP_FORBIDDEN,
                "object_storage.allow_insecure_http",
                "must be false in a production deployment",
            ));
        }
        if config.backup_active() && config.backup.allow_insecure_http {
            problems.push(ConfigProblem::error(
                codes::BACKUP_INSECURE_HTTP_FORBIDDEN,
                "backup.allow_insecure_http",
                "must be false in a production deployment; the daemon is mTLS-only",
            ));
        }
        if config.redis.enabled && !config.redis.tls {
            problems.push(ConfigProblem::error(
                codes::REDIS_TLS_REQUIRED_IN_PRODUCTION,
                "redis.tls",
                "must be true in production (chapter 7 §9: Redis/Valkey is TLS-only with ACL users)",
            ));
        }
    }
}

fn check_tls(config: &PgctlConfig, problems: &mut Vec<ConfigProblem>) {
    let tls = &config.tls;
    if config.is_production() && tls.mode == TlsMode::SelfSigned {
        problems.push(ConfigProblem::error(
            codes::PRODUCTION_REQUIRES_TLS,
            "tls.mode",
            "self-signed leaves are refused in production; use certbot, custom certificates or mtls",
        ));
    }
    if tls.leaf_days == 0 {
        problems.push(ConfigProblem::error(
            codes::INVALID_SERVICE_PORT,
            "tls.leaf_days",
            "leaf lifetime must be at least one day",
        ));
    }
    let mut seen = std::collections::BTreeSet::new();
    for (index, domain) in tls.certbot_domains.iter().enumerate() {
        if !is_fqdn(domain) {
            problems.push(ConfigProblem::error(
                codes::INVALID_DOMAIN,
                format!("tls.certbot_domains[{index}]"),
                format!("'{domain}' must be a fully qualified domain name"),
            ));
        } else if !seen.insert(domain.to_ascii_lowercase()) {
            problems.push(ConfigProblem::error(
                codes::INVALID_DOMAIN,
                format!("tls.certbot_domains[{index}]"),
                format!("'{domain}' is listed more than once"),
            ));
        }
    }
    if tls.mode == TlsMode::Certbot && tls.certbot_domains.is_empty() {
        problems.push(ConfigProblem::warning(
            codes::CERT_SAN_MISMATCH,
            "tls.certbot_domains",
            "certbot mode is configured without any domain; nothing can be issued",
        ));
    }
    let mut public_hosts: Vec<(&str, Option<&String>)> = Vec::new();
    let edges = &config.services.edges;
    if edges.enabled {
        if edges.admin.enabled {
            public_hosts.push((
                "services.edges.admin.public_host",
                edges.admin.public_host.as_ref(),
            ));
        }
        if edges.merchant.enabled {
            public_hosts.push((
                "services.edges.merchant.public_host",
                edges.merchant.public_host.as_ref(),
            ));
        }
        if edges.checkout.enabled {
            public_hosts.push((
                "services.edges.checkout.public_host",
                edges.checkout.public_host.as_ref(),
            ));
        }
    }
    if config.services.fake_rails.enabled && tls.mode == TlsMode::Certbot {
        public_hosts.push((
            "services.fake_rails.public_host",
            config.services.fake_rails.public_host.as_ref(),
        ));
    }
    for (path, host) in public_hosts {
        let Some(host) = host else { continue };
        if !is_fqdn(host) {
            problems.push(ConfigProblem::error(
                codes::INVALID_DOMAIN,
                path,
                format!("'{host}' must be a fully qualified domain name"),
            ));
            continue;
        }
        if tls.mode == TlsMode::Certbot
            && !tls
                .certbot_domains
                .iter()
                .any(|domain| domain.eq_ignore_ascii_case(host))
        {
            problems.push(ConfigProblem::error(
                codes::CERT_SAN_MISMATCH,
                path,
                format!("'{host}' is not listed in tls.certbot_domains; the certificate SAN would not cover it"),
            ));
        }
    }
}

fn check_network(config: &PgctlConfig, problems: &mut Vec<ConfigProblem>) {
    for (index, cidr) in config.network.trusted_proxies.iter().enumerate() {
        if !is_cidr(cidr) {
            problems.push(ConfigProblem::error(
                codes::INVALID_CIDR,
                format!("network.trusted_proxies[{index}]"),
                format!("'{cidr}' must be a CIDR (e.g. 10.0.0.0/8, ::1/128)"),
            ));
        }
    }
    for (index, cidr) in config.network.lan_allowlist.iter().enumerate() {
        if !is_cidr(cidr) {
            problems.push(ConfigProblem::error(
                codes::INVALID_CIDR,
                format!("network.lan_allowlist[{index}]"),
                format!("'{cidr}' must be a CIDR (e.g. 10.0.0.0/8, ::1/128)"),
            ));
        }
    }
    for (index, origin) in config.network.cors_origins.iter().enumerate() {
        if !is_http_origin(origin) {
            problems.push(ConfigProblem::error(
                codes::INVALID_CORS_ORIGIN,
                format!("network.cors_origins[{index}]"),
                format!("'{origin}' must be scheme://host[:port] with no path"),
            ));
        }
    }
    for (field, urls) in [
        ("network.core_back_urls", &config.network.core_back_urls),
        (
            "network.sandbox_core_back_urls",
            &config.network.sandbox_core_back_urls,
        ),
    ] {
        for (index, url) in urls.iter().enumerate() {
            if !is_https_url(url) {
                problems.push(ConfigProblem::error(
                    codes::CORE_BACK_URL_INVALID,
                    format!("{field}[{index}]"),
                    format!("'{url}' must be an absolute https:// URL"),
                ));
            }
        }
    }
}

fn check_object_storage(config: &PgctlConfig, problems: &mut Vec<ConfigProblem>) {
    let active = config.object_storage_active();
    if active {
        let hosts = config.hosts_with_role(Role::ObjectStorage);
        if hosts.is_empty() {
            problems.push(ConfigProblem::error(
                codes::OBJECT_STORAGE_HOST_REQUIRED,
                "hosts",
                "a host with role = \"object-storage\" is required when the object storage tier is enabled",
            ));
        } else if hosts.len() > 1 {
            problems.push(ConfigProblem::error(
                codes::OBJECT_STORAGE_HOST_DUPLICATE,
                "hosts",
                "exactly one host may carry role = \"object-storage\"",
            ));
        }
        if config.is_production() && config.object_storage.kek.is_none() {
            problems.push(ConfigProblem::error(
                codes::OBJECT_STORAGE_KEK_REQUIRED,
                "object_storage.kek",
                "is required in production: the vault cannot be written without a KEK",
            ));
        }
        if !config
            .object_storage
            .allowed_client_cns
            .iter()
            .any(|cn| cn == "object-storage-client")
        {
            problems.push(ConfigProblem::error(
                codes::OBJECT_STORAGE_CLIENT_CN_REQUIRED,
                "object_storage.allowed_client_cns",
                "must include object-storage-client",
            ));
        }
    }
    if let Some(kek) = &config.object_storage.kek {
        if !is_secret_reference(kek) {
            problems.push(ConfigProblem::error(
                codes::OBJECT_STORAGE_KEK_MUST_BE_REFERENCE,
                "object_storage.kek",
                "must be a reference (secret:<name>): key material never belongs in pgctl.toml",
            ));
        }
    }
    let root = &config.object_storage.root;
    let under_vault = root
        .strip_prefix("/var/lib/pg-object-storage/")
        .is_some_and(|rest| !rest.is_empty());
    if !under_vault || !is_safe_abs_path(root) {
        problems.push(ConfigProblem::error(
            codes::OBJECT_STORAGE_ROOT_UNSAFE,
            "object_storage.root",
            "must be a normalized absolute path under /var/lib/pg-object-storage/ (never a system path)",
        ));
    }
    if config.object_storage.active_kek_version == 0 {
        problems.push(ConfigProblem::error(
            codes::OBJECT_STORAGE_KEK_REQUIRED,
            "object_storage.active_kek_version",
            "must be at least 1",
        ));
    }
}

fn check_shared_storage(config: &PgctlConfig, problems: &mut Vec<ConfigProblem>) {
    let core_hosts = config.hosts_with_role(Role::Core);
    let backup_host = config.first_host_with_role(Role::Backup);
    let first_core = core_hosts.first().copied();
    let backup_on_separate_host = config.backup_active()
        && backup_host.is_some()
        && first_core.is_some()
        && backup_host.map(|host| host.peer_address())
            != first_core.map(|host| host.peer_address());
    let multi_node = core_hosts.len() > 1;
    if (multi_node || backup_on_separate_host) && !config.object_storage_active() {
        problems.push(ConfigProblem::error(
            codes::MULTI_NODE_SHARED_STORAGE_REQUIRED,
            "hosts",
            "OBJECT_STORAGE_NODE is required when deploying multiple CORE_NODES or a separate BACKUP_NODE: \
             storing objects on individual core nodes is strictly forbidden",
        ));
    }
    if config.services.object_storage.enabled
        && !config
            .hosts
            .iter()
            .any(|host| host.has_role(Role::ObjectStorage))
    {
        problems.push(ConfigProblem::error(
            codes::OBJECT_STORAGE_HOST_REQUIRED,
            "services.object_storage.enabled",
            "the daemon needs a host with role = \"object-storage\"",
        ));
    }
}

fn check_backup(config: &PgctlConfig, problems: &mut Vec<ConfigProblem>) {
    let backup = &config.backup;
    if !is_safe_abs_path(&backup.local_repo) {
        problems.push(ConfigProblem::error(
            codes::PATH_INVALID,
            "backup.local_repo",
            "must be a normalized absolute path",
        ));
    }
    for (field, cron) in [
        ("backup.schedule.full", &backup.schedule.full),
        ("backup.schedule.incremental", &backup.schedule.incremental),
        ("backup.schedule.drill", &backup.schedule.drill),
    ] {
        if !is_cron_like(cron) {
            problems.push(ConfigProblem::error(
                codes::CRON_INVALID,
                field,
                "must be a cron expression (letters, digits and * / , - @ only)",
            ));
        }
    }
    if backup.retention.full_count == 0 {
        problems.push(ConfigProblem::error(
            codes::BACKUP_RETENTION_INVALID,
            "backup.retention.full_count",
            "at least one full backup must be retained",
        ));
    }
    if backup.retention.wal_days == 0 {
        problems.push(ConfigProblem::error(
            codes::BACKUP_RETENTION_INVALID,
            "backup.retention.wal_days",
            "at least one day of WAL must be retained",
        ));
    }
    match (&backup.endpoint, &backup.bucket) {
        (None, Some(_)) => problems.push(ConfigProblem::error(
            codes::BACKUP_S3_INCOMPLETE,
            "backup.endpoint",
            "is required when backup.bucket is set (leave both empty for a local-repo-only pg-native setup)",
        )),
        (Some(_), None) => problems.push(ConfigProblem::error(
            codes::BACKUP_S3_INCOMPLETE,
            "backup.bucket",
            "is required when backup.endpoint is set",
        )),
        _ => {}
    }
    if let Some(endpoint) = &backup.endpoint {
        if !is_http_url(endpoint) {
            problems.push(ConfigProblem::error(
                codes::BACKUP_S3_INCOMPLETE,
                "backup.endpoint",
                "must be an absolute http(s) URL",
            ));
        }
        if backup.s3_mode == S3Mode::ManagedMinio {
            if endpoint.starts_with("https://") {
                problems.push(ConfigProblem::error(
                    codes::BACKUP_S3_INCOMPLETE,
                    "backup.endpoint",
                    "a managed MinIO is installed without TLS; use an http:// endpoint or s3_mode = \"external\"",
                ));
            }
            if endpoint.starts_with("http://") && !backup.allow_insecure_http {
                problems.push(ConfigProblem::error(
                    codes::BACKUP_INSECURE_HTTP_FORBIDDEN,
                    "backup.allow_insecure_http",
                    "must be true for a managed MinIO on an http:// endpoint",
                ));
            }
        }
    }
}

fn check_sandbox_and_seed(config: &PgctlConfig, problems: &mut Vec<ConfigProblem>) {
    if config.sandbox.enabled {
        if config.sandbox.db_name == config.database.name {
            problems.push(ConfigProblem::error(
                codes::SANDBOX_DB_NAME_CONFLICT,
                "sandbox.db_name",
                "must differ from database.name: the sandbox core must never receive the Live database name",
            ));
        }
        if !config.services.fake_rails.enabled {
            problems.push(ConfigProblem::error(
                codes::SANDBOX_REQUIRES_FAKE_RAILS,
                "sandbox.enabled",
                "requires services.fake_rails.enabled = true (the sandbox plane settles through Fake Rails)",
            ));
        }
    }
    if config.seed.run_synthetic && !config.services.fake_rails.enabled {
        problems.push(ConfigProblem::error(
            codes::SANDBOX_REQUIRES_FAKE_RAILS,
            "seed.run_synthetic",
            "requires services.fake_rails.enabled = true",
        ));
    }
}

fn check_services(config: &PgctlConfig, problems: &mut Vec<ConfigProblem>) {
    let warn_missing =
        |problems: &mut Vec<ConfigProblem>, enabled: bool, role: Role, path: &str| {
            if enabled && config.first_host_with_role(role).is_none() {
                problems.push(ConfigProblem::warning(
                    codes::NO_HOST_FOR_ROLE,
                    path,
                    format!(
                    "no host carries role = \"{}\"; the planner will place it on the first host",
                    role.as_str()
                ),
                ));
            }
        };
    warn_missing(
        problems,
        config.services.core.enabled,
        Role::Core,
        "services.core",
    );
    warn_missing(
        problems,
        config.services.edges.enabled && config.services.edges.admin.enabled,
        Role::Admin,
        "services.edges.admin",
    );
    warn_missing(
        problems,
        config.services.edges.enabled && config.services.edges.merchant.enabled,
        Role::Merchant,
        "services.edges.merchant",
    );
    warn_missing(
        problems,
        config.services.edges.enabled && config.services.edges.checkout.enabled,
        Role::Checkout,
        "services.edges.checkout",
    );
    warn_missing(
        problems,
        config.services.fake_rails.enabled,
        Role::FakeRails,
        "services.fake_rails",
    );
    warn_missing(
        problems,
        config.backup_active(),
        Role::Backup,
        "services.backup",
    );
    warn_missing(
        problems,
        config.object_storage_active(),
        Role::ObjectStorage,
        "services.object_storage",
    );
    warn_missing(problems, config.redis.enabled, Role::Redis, "redis");
    if config.services.core.replicas == 0 {
        problems.push(ConfigProblem::error(
            codes::INVALID_SERVICE_PORT,
            "services.core.replicas",
            "at least one replica is required",
        ));
    }
}

fn check_watch_and_ssh(config: &PgctlConfig, problems: &mut Vec<ConfigProblem>) {
    let watch = &config.deployment.watch;
    if !(1..=120).contains(&watch.window_minutes) {
        problems.push(ConfigProblem::error(
            codes::WATCH_INVALID,
            "deployment.watch.window_minutes",
            "must be between 1 and 120 minutes",
        ));
    }
    if !(1..=10_000).contains(&watch.max_error_bps) {
        problems.push(ConfigProblem::error(
            codes::WATCH_INVALID,
            "deployment.watch.max_error_bps",
            "must be between 1 and 10000 basis points",
        ));
    }
    if watch.max_p95_ms == 0 {
        problems.push(ConfigProblem::error(
            codes::WATCH_INVALID,
            "deployment.watch.max_p95_ms",
            "must be at least 1 ms",
        ));
    }
    for (index, host) in config.hosts.iter().enumerate() {
        if let Some(key) = &host.ssh_key {
            if key.trim().is_empty() {
                problems.push(ConfigProblem::error(
                    codes::SECRET_REFERENCE_INVALID,
                    format!("hosts[{index}].ssh_key"),
                    "must be a non-empty private key path",
                ));
            }
        }
        if let Some(reference) = &host.sudo_password {
            if !is_secret_reference(reference) {
                problems.push(ConfigProblem::error(
                    codes::SECRET_REFERENCE_INVALID,
                    format!("hosts[{index}].sudo_password"),
                    "must be a reference (secret:<name>); sudo passwords are never stored in pgctl.toml",
                ));
            }
        }
    }
}

fn check_secret_references(config: &PgctlConfig, problems: &mut Vec<ConfigProblem>) {
    let mut values: Vec<(&str, Option<&String>)> = vec![
        (
            "database.owner_password",
            config.database.owner_password.as_ref(),
        ),
        (
            "database.app_password",
            config.database.app_password.as_ref(),
        ),
        (
            "database.replication_password",
            config.database.replication_password.as_ref(),
        ),
        ("database.url", config.database.url.as_ref()),
        ("redis.password", config.redis.password.as_ref()),
        ("object_storage.kek", config.object_storage.kek.as_ref()),
        ("backup.access_key", config.backup.access_key.as_ref()),
        ("backup.secret_key", config.backup.secret_key.as_ref()),
    ];
    values.retain(|(_, value)| value.is_some());
    for (path, value) in values {
        if let Some(value) = value {
            if !is_secret_reference(value) {
                problems.push(ConfigProblem::error(
                    codes::SECRET_REFERENCE_INVALID,
                    path,
                    "must be a reference (secret:<name>); secrets are never stored in pgctl.toml",
                ));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Backup, BackupEngine, Environment, Host, ObjectStorage, Role, Sandbox};

    fn host(name: &str, role: Role, ip: &str) -> Host {
        Host {
            name: name.to_owned(),
            address: ip.to_owned(),
            roles: vec![role],
            private_ip: ip.to_owned(),
            ..Host::default()
        }
    }

    fn base() -> PgctlConfig {
        let mut config = PgctlConfig::new(Environment::Development);
        config.hosts = vec![
            host("core-1", Role::Core, "10.0.0.11"),
            host("admin-1", Role::Admin, "10.0.0.30"),
            host("web-1", Role::Merchant, "203.0.113.10"),
        ];
        config.hosts[2].roles.push(Role::Checkout);
        config.services.fake_rails.enabled = true;
        config.services.fake_rails.allow_in_production = true;
        config.database.mode = DatabaseMode::Managed;
        config.database.host = Some("10.0.0.21".to_owned());
        config.database.tls = true;
        config.tls.mode = TlsMode::Certbot;
        config.tls.certbot_domains = vec![
            "merchant.example.ly".to_owned(),
            "pay.example.ly".to_owned(),
        ];
        config.services.edges.merchant.public_host = Some("merchant.example.ly".to_owned());
        config.services.edges.checkout.public_host = Some("pay.example.ly".to_owned());
        config
    }

    fn codes(config: &PgctlConfig) -> Vec<&'static str> {
        let mut codes: Vec<&'static str> = validate(config)
            .into_iter()
            .map(|problem| problem.code)
            .collect();
        codes.sort_unstable();
        codes.dedup();
        codes
    }

    #[test]
    fn a_clean_development_document_has_no_errors() {
        let problems = validate(&base());
        assert!(!crate::problem::has_errors(&problems), "{problems:?}");
    }

    #[test]
    fn production_requires_public_tls() {
        let mut config = base();
        config.deployment.environment = Environment::Production;
        config.tls.mode = TlsMode::SelfSigned;
        assert!(codes(&config).contains(&codes::PRODUCTION_REQUIRES_TLS));
    }

    #[test]
    fn fake_rails_needs_opt_in_and_is_refused_in_production() {
        let mut config = base();
        config.services.fake_rails.allow_in_production = false;
        assert!(codes(&config).contains(&codes::FAKE_RAILS_PRODUCTION_GUARD_BLOCKED));

        let mut config = base();
        config.deployment.environment = Environment::Production;
        config.services.fake_rails.allow_in_production = true;
        assert!(codes(&config).contains(&codes::FAKE_RAILS_PRODUCTION_GUARD_BLOCKED));
    }

    #[test]
    fn managed_storage_requires_tls() {
        let mut config = base();
        config.database.tls = false;
        assert!(codes(&config).contains(&codes::STORAGE_TLS_REQUIRED));
    }

    #[test]
    fn reserved_pg_role_names_are_rejected() {
        let mut config = base();
        config.database.owner_role = "pg_owner".to_owned();
        assert!(codes(&config).contains(&codes::RESERVED_ROLE_NAME));
    }

    #[test]
    fn sandbox_database_must_differ_from_live() {
        let mut config = base();
        config.sandbox = Sandbox {
            enabled: true,
            db_name: config.database.name.clone(),
            host: None,
        };
        assert!(codes(&config).contains(&codes::SANDBOX_DB_NAME_CONFLICT));
    }

    #[test]
    fn sandbox_requires_fake_rails() {
        let mut config = base();
        config.services.fake_rails.enabled = false;
        config.sandbox.enabled = true;
        assert!(codes(&config).contains(&codes::SANDBOX_REQUIRES_FAKE_RAILS));
    }

    #[test]
    fn object_storage_requires_a_host_and_a_kek_in_production() {
        let mut config = base();
        config.deployment.environment = Environment::Production;
        config.services.object_storage.enabled = true;
        config.object_storage = ObjectStorage::default();
        let problems = validate(&config);
        assert!(codes(&config).contains(&codes::OBJECT_STORAGE_HOST_REQUIRED));
        assert!(codes(&config).contains(&codes::OBJECT_STORAGE_KEK_REQUIRED));
        assert!(problems.iter().any(|problem| problem.path == "hosts"));
    }

    #[test]
    fn object_storage_kek_must_be_a_reference_and_root_must_be_in_the_vault() {
        let mut config = base();
        config.services.object_storage.enabled = true;
        config
            .hosts
            .push(host("obj-1", Role::ObjectStorage, "10.0.0.50"));
        config.object_storage.kek =
            Some("v1:00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff".to_owned());
        config.object_storage.root = "/etc/pg-object-storage".to_owned();
        let codes = codes(&config);
        assert!(codes.contains(&codes::OBJECT_STORAGE_KEK_MUST_BE_REFERENCE));
        assert!(codes.contains(&codes::OBJECT_STORAGE_ROOT_UNSAFE));
    }

    #[test]
    fn multi_node_requires_shared_storage() {
        let mut config = base();
        config.hosts.push(host("core-2", Role::Core, "10.0.0.12"));
        assert!(codes(&config).contains(&codes::MULTI_NODE_SHARED_STORAGE_REQUIRED));

        let mut config = base();
        config.hosts.push(host("core-2", Role::Core, "10.0.0.12"));
        config.services.object_storage.enabled = true;
        config
            .hosts
            .push(host("obj-1", Role::ObjectStorage, "10.0.0.50"));
        config.object_storage.kek = Some("secret:object_storage_kek_keyring".to_owned());
        assert!(!codes(&config).contains(&codes::MULTI_NODE_SHARED_STORAGE_REQUIRED));
    }

    #[test]
    fn a_separate_backup_host_requires_shared_storage() {
        let mut config = base();
        config.services.backup.enabled = true;
        config
            .hosts
            .push(host("backup-1", Role::Backup, "10.0.0.60"));
        assert!(codes(&config).contains(&codes::MULTI_NODE_SHARED_STORAGE_REQUIRED));
    }

    #[test]
    fn port_collisions_are_reported_per_listener() {
        let mut config = base();
        config.services.edges.admin.port = 4000;
        let problems = validate(&config);
        assert!(problems.iter().any(
            |problem| problem.code == codes::PORT_COLLISION && problem.message.contains("4000")
        ));
        assert!(problems
            .iter()
            .any(|problem| problem.path == "services.edges.admin.port"));
    }

    #[test]
    fn trusted_proxies_and_cors_are_validated() {
        let mut config = base();
        config.network.trusted_proxies = vec!["10.0.0.0/8".to_owned(), "not-a-cidr".to_owned()];
        config.network.cors_origins = vec![
            "https://*.example.ly".to_owned(),
            "https://app.example.ly".to_owned(),
        ];
        let codes = codes(&config);
        assert!(codes.contains(&codes::INVALID_CIDR));
        assert!(codes.contains(&codes::INVALID_CORS_ORIGIN));
    }

    #[test]
    fn certbot_san_must_cover_every_public_host() {
        let mut config = base();
        config.services.edges.merchant.public_host = Some("merchant.other.ly".to_owned());
        assert!(codes(&config).contains(&codes::CERT_SAN_MISMATCH));
    }

    #[test]
    fn pan_keys_and_luhn_values_are_refused() {
        let mut config = base();
        config
            .extra
            .insert("PAN_RAIL".to_owned(), "edfali".to_owned());
        // 4111 1111 1111 1111 is a Luhn-valid test PAN.
        config
            .extra
            .insert("SMOKE_VALUE".to_owned(), "4111 1111 1111 1111".to_owned());
        let problems = validate(&config);
        assert_eq!(
            problems
                .iter()
                .filter(|problem| problem.code == codes::PAN_RAIL_GUARD)
                .count(),
            2
        );
    }

    #[test]
    fn backup_s3_settings_are_cross_checked() {
        let mut config = base();
        config.services.backup.enabled = true;
        config.backup = Backup {
            bucket: Some("s3://pg-backups/prod".to_owned()),
            ..Backup::default()
        };
        assert!(codes(&config).contains(&codes::BACKUP_S3_INCOMPLETE));

        let mut config = base();
        config.services.backup.enabled = true;
        config.backup.engine = BackupEngine::Auto;
        config.backup.endpoint = Some("http://127.0.0.1:9000".to_owned());
        config.backup.bucket = Some("s3://pg-backups/prod".to_owned());
        config.backup.s3_mode = S3Mode::ManagedMinio;
        assert!(codes(&config).contains(&codes::BACKUP_INSECURE_HTTP_FORBIDDEN));
    }

    #[test]
    fn cron_fields_reject_shell_metacharacters() {
        let mut config = base();
        config.backup.schedule.full = "0 2 * * *; rm -rf /".to_owned();
        assert!(codes(&config).contains(&codes::CRON_INVALID));
    }

    #[test]
    fn secret_references_must_use_the_secret_prefix() {
        let mut config = base();
        config.database.owner_password = Some("hunter2-not-a-reference".to_owned());
        assert!(codes(&config).contains(&codes::SECRET_REFERENCE_INVALID));
        config.database.owner_password = Some("secret:pg_db_password".to_owned());
        assert!(!codes(&config).contains(&codes::SECRET_REFERENCE_INVALID));
    }

    #[test]
    fn app_role_must_differ_from_the_owner() {
        let mut config = base();
        config.database.app_password = Some("secret:pg_app_password".to_owned());
        config.database.app_role = config.database.owner_role.clone();
        config.database.owner_password = Some("secret:pg_db_password".to_owned());
        assert!(codes(&config).contains(&codes::APP_ROLE_INVALID));
    }

    #[test]
    fn invalid_documents_report_version_hosts_and_ips() {
        let config = PgctlConfig {
            version: 9,
            hosts: vec![Host {
                name: "bad host".to_owned(),
                address: String::new(),
                roles: Vec::new(),
                private_ip: "10.0.0.999".to_owned(),
                ssh_user: "9root".to_owned(),
                ..Host::default()
            }],
            ..PgctlConfig::default()
        };
        let codes = codes(&config);
        assert!(codes.contains(&codes::INVALID_VERSION));
        assert!(codes.contains(&codes::INVALID_HOST_ADDRESS));
        assert!(codes.contains(&codes::INVALID_SSH_USER));
        assert!(codes.contains(&codes::INVALID_IP));
        assert!(codes.contains(&codes::NO_ROLES));
    }

    #[test]
    fn empty_document_reports_missing_hosts() {
        assert!(codes(&PgctlConfig::default()).contains(&codes::NO_HOSTS));
    }

    #[test]
    fn no_host_for_role_is_a_warning_only() {
        let mut config = base();
        config.services.fake_rails.enabled = true;
        config.redis.enabled = true;
        let problems = validate(&config);
        assert!(problems
            .iter()
            .any(|problem| problem.code == codes::NO_HOST_FOR_ROLE && !problem.is_error()));
    }

    #[test]
    fn luhn_and_pan_detection_match_the_ts_vectors() {
        assert!(luhn_valid("4111111111111111"));
        assert!(!luhn_valid("4111111111111112"));
        assert!(looks_like_card_pan("4111 1111 1111 1111"));
        assert!(looks_like_card_pan("card=4111-1111-1111-1111;"));
        assert!(!looks_like_card_pan("invoice 4111111111111112"));
        assert!(!looks_like_card_pan("order 1234567890123"));
        assert!(
            !looks_like_card_pan("x4111111111111111"),
            "no leading boundary"
        );
        assert!(
            !looks_like_card_pan("4111111111111111x"),
            "no trailing boundary"
        );
    }

    #[test]
    fn weak_secret_reasons_match_the_ts_vectors() {
        assert!(weak_secret_reason("change-me-strong-db-password").is_some());
        assert!(weak_secret_reason("aaaaaaaaaaaaaaaa").is_some());
        assert!(weak_secret_reason("abcabcabcabc").is_some());
        assert!(weak_secret_reason("abcdefghijkl").is_some());
        assert!(weak_secret_reason("0123456789").is_some());
        assert!(weak_secret_reason("Kf9#mQ2vLx7$Rw4nZt8B").is_none());
    }

    #[test]
    fn pan_key_segments_match_whole_words_only() {
        assert!(is_pan_key("CARD_NUMBER"));
        assert!(is_pan_key("PAN_RAILS"));
        assert!(is_pan_key("ACME_CVV2"));
        assert!(!is_pan_key("PANEL_COLOR"));
        assert!(!is_pan_key("CARD_HOLDER_NAME"));
    }

    #[test]
    fn watch_and_ssh_settings_are_validated() {
        let mut config = base();
        config.deployment.watch.window_minutes = 0;
        config.deployment.watch.max_error_bps = 20_000;
        config.hosts[0].sudo_password = Some("literal-password".to_owned());
        let found = codes(&config);
        assert!(found.contains(&codes::WATCH_INVALID));
        assert!(found.contains(&codes::SECRET_REFERENCE_INVALID));
        config.deployment.watch = crate::model::Watch::default();
        config.hosts[0].sudo_password = Some("secret:core_sudo".to_owned());
        assert!(!codes(&config).contains(&codes::WATCH_INVALID));
    }

    #[test]
    fn domain_and_path_helpers() {
        assert!(is_fqdn("merchant.example.ly"));
        assert!(!is_fqdn("localhost"));
        assert!(!is_fqdn("-bad.example.ly"));
        assert!(is_safe_abs_path("/var/lib/pg-object-storage/vault"));
        assert!(!is_safe_abs_path("/var/lib/../etc"));
        assert!(!is_safe_abs_path("relative/path"));
        assert!(is_cidr("::1/128"));
        assert!(!is_cidr("10.0.0.0"));
        assert!(is_https_url("https://10.0.0.11:4000"));
        assert!(!is_https_url("http://10.0.0.11:4000"));
        assert!(is_http_origin("https://app.example.ly:8443"));
        assert!(!is_http_origin("https://app.example.ly/path"));
    }
}

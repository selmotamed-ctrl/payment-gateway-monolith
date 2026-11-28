//! Environment for the admin edge.
//!
//! Port of `admin-back/lib/env/index.ts`: same keys, same defaults, same validation. The values
//! are read once and shared (the TS caches them outside the test environment; the Rust binary has
//! one process per instance, so one load is enough).

#![forbid(unsafe_code)]

use std::path::PathBuf;

use ipnet::IpNet;
use pg_config::Env;
use pg_edge::client_ip::parse_cidr_list;
use pg_http::security::CorsPolicy;

/// Live and Sandbox pools plus TLS material.
#[derive(Debug, Clone)]
pub struct Config {
    pub port: u16,
    pub bind_host: String,
    pub core_urls: Vec<String>,
    pub sandbox_core_urls: Option<Vec<String>>,
    pub mtls_client_cert: PathBuf,
    pub mtls_client_key: PathBuf,
    pub mtls_ca_cert: PathBuf,
    pub request_timeout_ms: u64,
    pub total_deadline_ms: u64,
    pub max_response_bytes: u64,
    pub trusted_proxies: Vec<IpNet>,
    /// `TRUSTED_PROXY_CIDRS` plus loopback, used by the LAN guard (TS `lanGuard.ts`).
    pub lan_trusted_proxies: Vec<IpNet>,
    pub cors: CorsPolicy,
    pub admin_lan: Vec<IpNet>,
    pub authority_hints: Vec<String>,
    pub max_json_bytes: u64,
    pub max_upload_bytes: u64,
    pub upload_allowed_mime: Vec<String>,
    pub admin_rate_limit_max: u64,
    pub admin_rate_limit_window_ms: u64,
    pub upload_rate_limit_max: u64,
    pub backup_job_rate_limit_max: u64,
    pub auth_rate_limit_max: u64,
    pub auth_rate_limit_window_ms: u64,
    pub session_cookie_mode: bool,
    pub session_cookie_secure: bool,
    pub reconciliation_timeout_ms: u64,
    pub release: String,
    pub commit: String,
}

fn invalid(env: &Env, key: &str, reason: &str) -> anyhow::Error {
    anyhow::anyhow!(
        "Invalid environment configuration: {key} {reason} (from {})",
        env.get(key)
            .map_or_else(|| "unset".to_owned(), |_| "environment".to_owned())
    )
}

fn require_https(url: &str, key: &str) -> Result<(), anyhow::Error> {
    let parsed =
        url::Url::parse(url).map_err(|error| anyhow::anyhow!("{key} is malformed: {error}"))?;
    if parsed.scheme() != "https" {
        return Err(anyhow::anyhow!("{key} must be an absolute https URL"));
    }
    Ok(())
}

impl Config {
    pub fn from_env(env: &Env) -> Result<Self, anyhow::Error> {
        let core_urls = match (
            env.get_non_empty("CORE_BACK_URLS"),
            env.get_non_empty("CORE_BACK_URL"),
        ) {
            (Some(list), fallback) => {
                let fallback = fallback.unwrap_or_else(|| {
                    list.split(',').next().unwrap_or_default().trim().to_owned()
                });
                pg_upstream::parse_core_back_urls(Some(&list), &fallback)
                    .map_err(|error| anyhow::anyhow!("{error}"))?
            }
            (None, Some(fallback)) => pg_upstream::parse_core_back_urls(None, &fallback)
                .map_err(|error| anyhow::anyhow!("{error}"))?,
            (None, None) => {
                return Err(invalid(
                    env,
                    "CORE_BACK_URL",
                    "is required (or CORE_BACK_URLS)",
                ));
            }
        };
        for url in &core_urls {
            require_https(url, "CORE_BACK_URLS")?;
        }
        let sandbox_core_urls = match (
            env.get_non_empty("SANDBOX_CORE_BACK_URLS"),
            env.get_non_empty("SANDBOX_CORE_BACK_URL"),
        ) {
            (None, None) => None,
            (list, fallback) => {
                let fallback = fallback.unwrap_or_else(|| {
                    list.as_deref()
                        .unwrap_or_default()
                        .split(',')
                        .next()
                        .unwrap_or_default()
                        .trim()
                        .to_owned()
                });
                let urls = pg_upstream::parse_core_back_urls(list.as_deref(), &fallback)
                    .map_err(|error| anyhow::anyhow!("{error}"))?;
                for url in &urls {
                    require_https(url, "SANDBOX_CORE_BACK_URLS")?;
                }
                Some(urls)
            }
        };
        let path = |key: &str| -> Result<PathBuf, anyhow::Error> {
            env.get_non_empty(key)
                .map(PathBuf::from)
                .ok_or_else(|| invalid(env, key, "is required"))
        };
        let port = env.u16("PORT", 4101)?;
        if port == 0 {
            return Err(invalid(env, "PORT", "must be between 1 and 65535"));
        }
        let bind_host = env
            .get_non_empty("ADMIN_BIND_HOST")
            .unwrap_or_else(|| "127.0.0.1".to_owned());
        if bind_host.len() > 64 {
            return Err(invalid(
                env,
                "ADMIN_BIND_HOST",
                "must be at most 64 characters",
            ));
        }
        let max_json_bytes = env.u64("MAX_JSON_BODY_BYTES", 4 * 1024 * 1024)?;
        if !(1024..=20 * 1024 * 1024).contains(&max_json_bytes) {
            return Err(invalid(
                env,
                "MAX_JSON_BODY_BYTES",
                "must be between 1024 and 20971520",
            ));
        }
        let max_upload_bytes = env.u64("MAX_UPLOAD_BYTES", 20 * 1024 * 1024)?;
        if !(1024..=50 * 1024 * 1024).contains(&max_upload_bytes) {
            return Err(invalid(
                env,
                "MAX_UPLOAD_BYTES",
                "must be between 1024 and 52428800",
            ));
        }
        let request_timeout_ms = env.u64("CORE_REQUEST_TIMEOUT_MS", 60_000)?;
        if !(1000..=300_000).contains(&request_timeout_ms) {
            return Err(invalid(
                env,
                "CORE_REQUEST_TIMEOUT_MS",
                "must be 1000..300000",
            ));
        }
        let total_deadline_ms = env.u64("CORE_TOTAL_DEADLINE_MS", 300_000)?;
        if !(1000..=1_800_000).contains(&total_deadline_ms) {
            return Err(invalid(
                env,
                "CORE_TOTAL_DEADLINE_MS",
                "must be 1000..1800000",
            ));
        }
        let max_response_bytes = env.u64("CORE_MAX_RESPONSE_BYTES", 67_108_864)?;
        if !(1024..=536_870_912).contains(&max_response_bytes) {
            return Err(invalid(
                env,
                "CORE_MAX_RESPONSE_BYTES",
                "must be 1024..536870912",
            ));
        }
        let trusted_raw = env
            .get_non_empty("TRUSTED_PROXY_CIDRS")
            .unwrap_or_else(|| pg_edge::client_ip::TRUSTED_PROXY_DEFAULT.to_owned());
        let trusted_proxies = parse_cidr_list(Some(&trusted_raw));
        let mut lan_trusted_proxies = trusted_proxies.clone();
        for cidr in ["127.0.0.0/8", "::1/128"] {
            if let Some(network) = pg_edge::client_ip::parse_cidr(cidr) {
                if !lan_trusted_proxies.contains(&network) {
                    lan_trusted_proxies.push(network);
                }
            }
        }
        let lan_raw = env.get_non_empty("ADMIN_LAN_CIDRS").unwrap_or_else(|| {
            "127.0.0.1/32,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16".to_owned()
        });
        let admin_lan = parse_cidr_list(Some(&lan_raw));
        if admin_lan.is_empty() {
            return Err(invalid(
                env,
                "ADMIN_LAN_CIDRS",
                "must contain at least one CIDR",
            ));
        }
        let upload_allowed_mime = env
            .get_non_empty("UPLOAD_ALLOWED_MIME")
            .unwrap_or_else(|| "text/csv,application/vnd.ms-excel,application/json".to_owned())
            .split(',')
            .map(|entry| entry.trim().to_lowercase())
            .filter(|entry| !entry.is_empty())
            .collect();
        let authority_hints = env
            .get_non_empty("ADMIN_AUTHORITY_HINTS")
            .map(|raw| {
                raw.split(',')
                    .map(|entry| entry.trim().to_owned())
                    .filter(|entry| !entry.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        Ok(Self {
            port,
            bind_host,
            core_urls,
            sandbox_core_urls,
            mtls_client_cert: path("MTLS_CLIENT_CERT_PATH")?,
            mtls_client_key: path("MTLS_CLIENT_KEY_PATH")?,
            mtls_ca_cert: path("MTLS_CA_CERT_PATH")?,
            request_timeout_ms,
            total_deadline_ms,
            max_response_bytes,
            trusted_proxies,
            lan_trusted_proxies,
            cors: CorsPolicy::from_csv(
                env.get_non_empty("CORS_ALLOWED_ORIGINS")
                    .map(|raw| {
                        raw.split(',')
                            .map(|origin| origin.trim().trim_end_matches('/'))
                            .collect::<Vec<_>>()
                            .join(",")
                    })
                    .as_deref(),
            ),
            admin_lan,
            authority_hints,
            max_json_bytes,
            max_upload_bytes,
            upload_allowed_mime,
            admin_rate_limit_max: env.u64("ADMIN_RATE_LIMIT_MAX", 600)?.max(1),
            admin_rate_limit_window_ms: env.u64("ADMIN_RATE_LIMIT_WINDOW_MS", 60_000)?.max(1000),
            upload_rate_limit_max: env.u64("UPLOAD_RATE_LIMIT_MAX", 20)?.max(1),
            backup_job_rate_limit_max: env.u64("BACKUP_JOB_RATE_LIMIT_MAX", 6)?.max(1),
            auth_rate_limit_max: env.u64("AUTH_RATE_LIMIT_MAX", 10)?.max(1),
            auth_rate_limit_window_ms: env.u64("AUTH_RATE_LIMIT_WINDOW_MS", 900_000)?.max(1000),
            session_cookie_mode: env.bool("SESSION_COOKIE_MODE", false)?,
            session_cookie_secure: env.bool("SESSION_COOKIE_SECURE", true)?,
            reconciliation_timeout_ms: {
                let value = env.u64("RECONCILIATION_TIMEOUT_MS", 120_000)?;
                if !(1000..=600_000).contains(&value) {
                    return Err(invalid(
                        env,
                        "RECONCILIATION_TIMEOUT_MS",
                        "must be between 1000 and 600000",
                    ));
                }
                value
            },
            release: env
                .get_non_empty("APP_RELEASE")
                .unwrap_or_else(|| "dev".to_owned()),
            commit: env
                .get_non_empty("APP_COMMIT")
                .or_else(|| env.get_non_empty("GIT_COMMIT"))
                .unwrap_or_else(|| "unknown".to_owned()),
        })
    }

    /// The 24 MB report-engine JSON cap (`^/api/v1/admin/(sandbox/mirror/)?report-engine(/|$)`).
    #[must_use]
    pub fn json_limit_for(&self, path: &str) -> u64 {
        if report_engine_path(path) {
            return 24 * 1024 * 1024;
        }
        self.max_json_bytes
    }

    /// Whether a Sandbox pool is configured.
    #[must_use]
    pub fn sandbox_configured(&self) -> bool {
        self.sandbox_core_urls.is_some()
    }
}

/// Matches `^/api/v1/admin/(sandbox/mirror/)?report-engine(/|$)`.
#[must_use]
pub fn report_engine_path(path: &str) -> bool {
    let path = path.trim_end_matches('/');
    [
        "/api/v1/admin/report-engine",
        "/api/v1/admin/sandbox/mirror/report-engine",
    ]
    .iter()
    .any(|prefix| path == *prefix || path.starts_with(&format!("{prefix}/")))
}

/// The environment the binary uses. Kept small so tests can build one without a process env.
pub fn load() -> Result<Config, anyhow::Error> {
    let env = Env::load_default().map_err(|error| anyhow::anyhow!("dotenv: {error}"))?;
    Config::from_env(&env)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_env() -> Env {
        Env::process()
            .with_value("CORE_BACK_URL", "https://core.internal:4000")
            .with_value("MTLS_CLIENT_CERT_PATH", "/certs/client.crt")
            .with_value("MTLS_CLIENT_KEY_PATH", "/certs/client.key")
            .with_value("MTLS_CA_CERT_PATH", "/certs/ca.crt")
    }

    #[test]
    fn defaults_match_the_ts_edge() {
        let config = Config::from_env(&base_env()).expect("config");
        assert_eq!(config.port, 4101);
        assert_eq!(config.bind_host, "127.0.0.1");
        assert_eq!(config.max_json_bytes, 4 * 1024 * 1024);
        assert_eq!(config.max_upload_bytes, 20 * 1024 * 1024);
        assert_eq!(config.request_timeout_ms, 60_000);
        assert_eq!(config.total_deadline_ms, 300_000);
        assert_eq!(config.admin_rate_limit_max, 600);
        assert_eq!(config.auth_rate_limit_max, 10);
        assert_eq!(config.upload_rate_limit_max, 20);
        assert_eq!(config.backup_job_rate_limit_max, 6);
        assert_eq!(config.core_urls, vec!["https://core.internal:4000"]);
        assert!(config.sandbox_core_urls.is_none());
    }

    #[test]
    fn report_engine_prefix_gets_24_mb() {
        let config = Config::from_env(&base_env()).expect("config");
        assert_eq!(
            config.json_limit_for("/api/v1/admin/report-engine/specs"),
            24 * 1024 * 1024
        );
        assert_eq!(
            config.json_limit_for("/api/v1/admin/sandbox/mirror/report-engine/catalog"),
            24 * 1024 * 1024
        );
        assert_eq!(
            config.json_limit_for("/api/v1/admin/report-engineers"),
            4 * 1024 * 1024
        );
        assert_eq!(
            config.json_limit_for("/api/v1/admin/report-engine"),
            24 * 1024 * 1024
        );
        assert_eq!(
            config.json_limit_for("/api/v1/admin/merchants"),
            4 * 1024 * 1024
        );
    }

    #[test]
    fn sandbox_pool_never_falls_back_to_live() {
        let env = base_env().with_value("SANDBOX_CORE_BACK_URL", "https://sandbox.internal:4005");
        let config = Config::from_env(&env).expect("config");
        assert_eq!(
            config.sandbox_core_urls.as_deref(),
            Some(&["https://sandbox.internal:4005".to_owned()][..])
        );
        let live_only = Config::from_env(&base_env()).expect("config");
        assert!(!live_only.sandbox_configured());
    }

    #[test]
    fn rejects_plain_http_core_and_reserved_names() {
        let env = base_env().with_value("CORE_BACK_URL", "http://core.internal:4000");
        assert!(Config::from_env(&env).is_err());
        let env = base_env().with_value("ADMIN_LAN_CIDRS", "not-a-cidr");
        assert!(Config::from_env(&env).is_err());
    }
}

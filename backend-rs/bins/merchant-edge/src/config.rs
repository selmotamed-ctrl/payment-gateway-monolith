//! Merchant edge configuration.
//!
//! Port of `merchant-back/lib/env/index.ts` (`envSchema`), including the zod defaults and bounds
//! and the two pools (`CORE_BACK_URLS`, `SANDBOX_CORE_BACK_URLS`). The TypeScript schema reads
//! `process.env` on first access; the Rust service loads it once at startup and refuses to boot
//! with an invalid configuration (`Invalid environment configuration: …`).

#![forbid(unsafe_code)]

use std::fmt;
use std::path::PathBuf;

use ipnet::IpNet;
use pg_config::Env;
use pg_edge::{parse_cidr_list, CorsAllowList, TRUSTED_PROXY_DEFAULT};
use pg_upstream::{CorePoolConfig, PoolConfigError};
use serde_json::{Map, Value};

/// One configuration problem, rendered like a zod issue.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigIssue {
    pub path: String,
    pub code: &'static str,
    pub message: String,
}

impl ConfigIssue {
    fn new(path: &str, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            path: path.to_owned(),
            code,
            message: message.into(),
        }
    }

    #[must_use]
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("path".to_owned(), Value::String(self.path.clone()));
        map.insert("code".to_owned(), Value::String(self.code.to_owned()));
        map.insert("message".to_owned(), Value::String(self.message.clone()));
        Value::Object(map)
    }
}

/// The collected configuration failures.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigError {
    pub issues: Vec<ConfigIssue>,
}

impl ConfigError {
    #[must_use]
    pub fn single(path: &str, message: impl Into<String>) -> Self {
        Self {
            issues: vec![ConfigIssue::new(path, "custom", message)],
        }
    }
}

impl fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let issues = Value::Array(self.issues.iter().map(ConfigIssue::to_json).collect());
        write!(formatter, "Invalid environment configuration: {issues}")
    }
}

impl std::error::Error for ConfigError {}

/// TLS material paths of the merchant edge client certificate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MtlsPaths {
    pub client_cert: PathBuf,
    pub client_key: PathBuf,
    pub ca_cert: PathBuf,
}

/// Everything the edge needs at boot.
#[derive(Debug, Clone)]
pub struct EdgeConfig {
    pub node_env: String,
    pub port: u16,
    pub bind_host: String,
    pub pools: CorePoolConfig,
    pub mtls: MtlsPaths,
    pub request_timeout_ms: u64,
    pub total_deadline_ms: u64,
    pub max_response_bytes: u64,
    pub max_json_body_bytes: u64,
    pub max_upload_bytes: u64,
    pub upload_allowed_mime: Vec<String>,
    pub upload_rate_limit_max: u32,
    pub auth_rate_limit_max: u32,
    pub auth_rate_limit_window_ms: u64,
    pub api_rate_limit_max: u32,
    pub api_rate_limit_window_ms: u64,
    pub external_rate_limit_max: u32,
    pub external_rate_limit_window_ms: u64,
    pub token_default_ttl_days: u32,
    pub token_max_ttl_days: u32,
    pub token_max_scopes: usize,
    pub pg_live_token_prefix: String,
    pub trusted_proxies: Vec<IpNet>,
    pub cors: CorsAllowList,
    pub session_cookie_mode: bool,
    pub session_cookie_secure: bool,
    pub max_streams_per_ip: usize,
    pub pos_stream_timeout_ms: u64,
}

/// A bounded integer read (zod `z.coerce.number().int().min(..).max(..)`).
fn bounded(
    env: &Env,
    key: &str,
    default: u64,
    min: u64,
    max: u64,
    issues: &mut Vec<ConfigIssue>,
) -> u64 {
    match env.get(key) {
        None => default,
        Some(raw) if raw.trim().is_empty() => default,
        Some(raw) => match raw.trim().parse::<u64>() {
            Ok(value) if (min..=max).contains(&value) => value,
            Ok(_) => {
                issues.push(ConfigIssue::new(
                    key,
                    "too_big",
                    format!("must be between {min} and {max}"),
                ));
                default
            }
            Err(_) => {
                issues.push(ConfigIssue::new(key, "invalid_type", "must be an integer"));
                default
            }
        },
    }
}

fn https_url(env: &Env, key: &str, issues: &mut Vec<ConfigIssue>) -> Option<String> {
    let raw = env.get_non_empty(key)?;
    match url::Url::parse(&raw) {
        Ok(parsed) if parsed.scheme() == "https" => Some(raw),
        _ => {
            issues.push(ConfigIssue::new(
                key,
                "invalid_format",
                "must be an absolute https URL",
            ));
            None
        }
    }
}

impl EdgeConfig {
    /// Load and validate the process environment (plus an optional `.env`).
    pub fn load() -> Result<Self, ConfigError> {
        let env = Env::load_default()
            .map_err(|error| ConfigError::single("environment", error.to_string()))?;
        Self::from_env(&env)
    }

    /// Validate an already loaded environment; used by tests and `config validate`.
    pub fn from_env(env: &Env) -> Result<Self, ConfigError> {
        let mut issues = Vec::new();

        let node_env = env
            .get_non_empty("NODE_ENV")
            .unwrap_or_else(|| "development".to_owned());
        if !matches!(node_env.as_str(), "development" | "test" | "production") {
            issues.push(ConfigIssue::new(
                "NODE_ENV",
                "invalid_value",
                "must be one of development, test, production",
            ));
        }

        let port = bounded(env, "PORT", 4102, 1, 65535, &mut issues) as u16;
        let bind_host = env
            .get_non_empty("BIND_HOST")
            .unwrap_or_else(|| "0.0.0.0".to_owned());

        let core_url = https_url(env, "CORE_BACK_URL", &mut issues);
        let core_urls = https_url(env, "CORE_BACK_URLS", &mut issues);
        let sandbox_url = https_url(env, "SANDBOX_CORE_BACK_URL", &mut issues);
        let sandbox_urls = https_url(env, "SANDBOX_CORE_BACK_URLS", &mut issues);

        let pools = match core_url.as_deref() {
            Some(fallback) => match CorePoolConfig::from_values(
                core_urls.as_deref(),
                fallback,
                sandbox_urls.as_deref(),
                sandbox_url.as_deref(),
            ) {
                Ok(pools) => Some(pools),
                Err(error) => {
                    issues.push(pool_issue(error));
                    None
                }
            },
            None => {
                if env.get_non_empty("CORE_BACK_URL").is_none() {
                    issues.push(ConfigIssue::new(
                        "CORE_BACK_URL",
                        "invalid_type",
                        "is required",
                    ));
                }
                None
            }
        };

        let required_path = |key: &str, issues: &mut Vec<ConfigIssue>| -> PathBuf {
            match env.get_non_empty(key) {
                Some(value) => PathBuf::from(value),
                None => {
                    issues.push(ConfigIssue::new(key, "invalid_type", "is required"));
                    PathBuf::new()
                }
            }
        };
        let mtls = MtlsPaths {
            client_cert: required_path("MTLS_CLIENT_CERT_PATH", &mut issues),
            client_key: required_path("MTLS_CLIENT_KEY_PATH", &mut issues),
            ca_cert: required_path("MTLS_CA_CERT_PATH", &mut issues),
        };

        let request_timeout_ms = bounded(
            env,
            "CORE_REQUEST_TIMEOUT_MS",
            30_000,
            1_000,
            300_000,
            &mut issues,
        );
        let total_deadline_ms = bounded(
            env,
            "CORE_TOTAL_DEADLINE_MS",
            300_000,
            1_000,
            1_800_000,
            &mut issues,
        );
        let max_response_bytes = bounded(
            env,
            "CORE_MAX_RESPONSE_BYTES",
            67_108_864,
            1_024,
            536_870_912,
            &mut issues,
        );
        let max_json_body_bytes = bounded(
            env,
            "MAX_JSON_BODY_BYTES",
            2_097_152,
            1_024,
            10_485_760,
            &mut issues,
        );
        let max_upload_bytes = bounded(
            env,
            "MAX_UPLOAD_BYTES",
            10_485_760,
            1_024,
            26_214_400,
            &mut issues,
        );
        let upload_allowed_mime = env
            .get_non_empty("UPLOAD_ALLOWED_MIME")
            .unwrap_or_else(|| "image/png,image/jpeg,application/pdf".to_owned())
            .split(',')
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>();
        let upload_rate_limit_max = bounded(
            env,
            "UPLOAD_RATE_LIMIT_MAX",
            10,
            1,
            u32::MAX as u64,
            &mut issues,
        ) as u32;
        let auth_rate_limit_max = bounded(
            env,
            "AUTH_RATE_LIMIT_MAX",
            20,
            1,
            u32::MAX as u64,
            &mut issues,
        ) as u32;
        let auth_rate_limit_window_ms = bounded(
            env,
            "AUTH_RATE_LIMIT_WINDOW_MS",
            900_000,
            1_000,
            u64::MAX,
            &mut issues,
        );
        let api_rate_limit_max = bounded(
            env,
            "API_RATE_LIMIT_MAX",
            300,
            1,
            u32::MAX as u64,
            &mut issues,
        ) as u32;
        let api_rate_limit_window_ms = bounded(
            env,
            "API_RATE_LIMIT_WINDOW_MS",
            60_000,
            1_000,
            u64::MAX,
            &mut issues,
        );
        let external_rate_limit_max = bounded(
            env,
            "EXTERNAL_RATE_LIMIT_MAX",
            120,
            1,
            u32::MAX as u64,
            &mut issues,
        ) as u32;
        let external_rate_limit_window_ms = bounded(
            env,
            "EXTERNAL_RATE_LIMIT_WINDOW_MS",
            60_000,
            1_000,
            u64::MAX,
            &mut issues,
        );
        let token_default_ttl_days =
            bounded(env, "TOKEN_DEFAULT_TTL_DAYS", 90, 1, 3_650, &mut issues) as u32;
        let token_max_ttl_days =
            bounded(env, "TOKEN_MAX_TTL_DAYS", 365, 1, 3_650, &mut issues) as u32;
        let token_max_scopes = bounded(env, "TOKEN_MAX_SCOPES", 20, 1, 50, &mut issues) as usize;

        let pg_live_token_prefix = env
            .get_non_empty("PG_LIVE_TOKEN_PREFIX")
            .unwrap_or_else(|| "pg_live_".to_owned());
        if pg_live_token_prefix.len() < 4 || pg_live_token_prefix.len() > 32 {
            issues.push(ConfigIssue::new(
                "PG_LIVE_TOKEN_PREFIX",
                "too_small",
                "must be between 4 and 32 characters",
            ));
        }

        let trusted_proxies = parse_cidr_list(Some(
            &env.get_non_empty("TRUSTED_PROXY_CIDRS")
                .unwrap_or_else(|| TRUSTED_PROXY_DEFAULT.to_owned()),
        ));
        let cors = CorsAllowList::from_csv(env.get_non_empty("CORS_ALLOWED_ORIGINS").as_deref());

        let cookie_mode = env
            .get_non_empty("SESSION_COOKIE_MODE")
            .unwrap_or_else(|| "false".to_owned());
        if !matches!(cookie_mode.as_str(), "true" | "false") {
            issues.push(ConfigIssue::new(
                "SESSION_COOKIE_MODE",
                "invalid_value",
                "must be one of true, false",
            ));
        }
        let cookie_secure = env
            .get_non_empty("SESSION_COOKIE_SECURE")
            .unwrap_or_else(|| "true".to_owned());
        if !matches!(cookie_secure.as_str(), "true" | "false") {
            issues.push(ConfigIssue::new(
                "SESSION_COOKIE_SECURE",
                "invalid_value",
                "must be one of true, false",
            ));
        }

        let max_streams_per_ip =
            bounded(env, "MAX_STREAMS_PER_IP", 5, 1, 1_000, &mut issues) as usize;
        let pos_stream_timeout_ms = bounded(
            env,
            "POS_STREAM_TIMEOUT_MS",
            900_000,
            1_000,
            3_600_000,
            &mut issues,
        );

        if let Some(pools) = pools {
            // Validate that every configured URL parses as https (already checked) and that the
            // mTLS material exists: the client is built at boot, unlike the lazy TS agent.
            for (key, path) in [
                ("MTLS_CLIENT_CERT_PATH", &mtls.client_cert),
                ("MTLS_CLIENT_KEY_PATH", &mtls.client_key),
                ("MTLS_CA_CERT_PATH", &mtls.ca_cert),
            ] {
                if !path.as_os_str().is_empty() && !path.is_file() {
                    issues.push(ConfigIssue::new(
                        key,
                        "invalid_type",
                        format!("{} does not exist", path.display()),
                    ));
                }
            }
            if issues.is_empty() {
                return Ok(Self {
                    node_env,
                    port,
                    bind_host,
                    pools,
                    mtls,
                    request_timeout_ms,
                    total_deadline_ms,
                    max_response_bytes,
                    max_json_body_bytes,
                    max_upload_bytes,
                    upload_allowed_mime,
                    upload_rate_limit_max,
                    auth_rate_limit_max,
                    auth_rate_limit_window_ms,
                    api_rate_limit_max,
                    api_rate_limit_window_ms,
                    external_rate_limit_max,
                    external_rate_limit_window_ms,
                    token_default_ttl_days,
                    token_max_ttl_days,
                    token_max_scopes,
                    pg_live_token_prefix,
                    trusted_proxies,
                    cors,
                    session_cookie_mode: cookie_mode == "true",
                    session_cookie_secure: cookie_secure == "true",
                    max_streams_per_ip,
                    pos_stream_timeout_ms,
                });
            }
        }
        Err(ConfigError { issues })
    }

    /// A test/embedded configuration with no environment dependency.
    #[must_use]
    pub fn for_embedding(live: Vec<String>, sandbox: Option<Vec<String>>) -> Self {
        Self {
            node_env: "test".to_owned(),
            port: 0,
            bind_host: "127.0.0.1".to_owned(),
            pools: CorePoolConfig { live, sandbox },
            mtls: MtlsPaths {
                client_cert: PathBuf::new(),
                client_key: PathBuf::new(),
                ca_cert: PathBuf::new(),
            },
            request_timeout_ms: 30_000,
            total_deadline_ms: 300_000,
            max_response_bytes: 67_108_864,
            max_json_body_bytes: 2_097_152,
            max_upload_bytes: 10_485_760,
            upload_allowed_mime: vec![
                "image/png".to_owned(),
                "image/jpeg".to_owned(),
                "application/pdf".to_owned(),
            ],
            upload_rate_limit_max: 10,
            auth_rate_limit_max: 20,
            auth_rate_limit_window_ms: 900_000,
            api_rate_limit_max: 300,
            api_rate_limit_window_ms: 60_000,
            external_rate_limit_max: 120,
            external_rate_limit_window_ms: 60_000,
            token_default_ttl_days: 90,
            token_max_ttl_days: 365,
            token_max_scopes: 20,
            pg_live_token_prefix: "pg_live_".to_owned(),
            trusted_proxies: parse_cidr_list(Some(TRUSTED_PROXY_DEFAULT)),
            cors: CorsAllowList::default(),
            session_cookie_mode: false,
            session_cookie_secure: true,
            max_streams_per_ip: 5,
            pos_stream_timeout_ms: 900_000,
        }
    }
}

fn pool_issue(error: PoolConfigError) -> ConfigIssue {
    ConfigIssue::new("CORE_BACK_URLS", "invalid_format", error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_env() -> Env {
        Env::default()
            .with_value("NODE_ENV", "test")
            .with_value("CORE_BACK_URL", "https://core.internal:4000")
            .with_value("MTLS_CLIENT_CERT_PATH", "cert.pem")
            .with_value("MTLS_CLIENT_KEY_PATH", "key.pem")
            .with_value("MTLS_CA_CERT_PATH", "ca.pem")
    }

    #[test]
    fn defaults_match_the_typescript_schema() {
        // Missing certificate files are rejected when the paths are not empty; point them at
        // files created by the test to exercise the successful branch.
        let dir = tempfile::tempdir().expect("tempdir");
        let cert = dir.path().join("cert.pem");
        let key = dir.path().join("key.pem");
        let ca = dir.path().join("ca.pem");
        for path in [&cert, &key, &ca] {
            std::fs::write(path, b"test").expect("write");
        }
        let env = Env::default()
            .with_value("NODE_ENV", "test")
            .with_value("CORE_BACK_URL", "https://core.internal:4000")
            .with_value("MTLS_CLIENT_CERT_PATH", cert.to_string_lossy().to_string())
            .with_value("MTLS_CLIENT_KEY_PATH", key.to_string_lossy().to_string())
            .with_value("MTLS_CA_CERT_PATH", ca.to_string_lossy().to_string());
        let config = EdgeConfig::from_env(&env).expect("valid");
        assert_eq!(config.port, 4102);
        assert_eq!(config.bind_host, "0.0.0.0");
        assert_eq!(config.max_json_body_bytes, 2_097_152);
        assert_eq!(config.max_upload_bytes, 10_485_760);
        assert_eq!(config.auth_rate_limit_max, 20);
        assert_eq!(config.api_rate_limit_max, 300);
        assert_eq!(config.external_rate_limit_max, 120);
        assert_eq!(config.upload_rate_limit_max, 10);
        assert_eq!(config.token_default_ttl_days, 90);
        assert_eq!(config.token_max_ttl_days, 365);
        assert_eq!(config.token_max_scopes, 20);
        assert!(!config.session_cookie_mode);
        assert!(config.session_cookie_secure);
        assert!(!config.pools.has_sandbox());
        assert_eq!(
            config.upload_allowed_mime,
            vec!["image/png", "image/jpeg", "application/pdf"]
        );
    }

    #[test]
    fn sandbox_pool_is_optional_and_never_falls_back() {
        let dir = tempfile::tempdir().expect("tempdir");
        let cert = dir.path().join("cert.pem");
        std::fs::write(&cert, b"test").expect("write");
        let env = Env::default()
            .with_value("CORE_BACK_URL", "https://core.internal:4000")
            .with_value("SANDBOX_CORE_BACK_URLS", "https://sandbox.internal:4005")
            .with_value("MTLS_CLIENT_CERT_PATH", cert.to_string_lossy().to_string())
            .with_value("MTLS_CLIENT_KEY_PATH", cert.to_string_lossy().to_string())
            .with_value("MTLS_CA_CERT_PATH", cert.to_string_lossy().to_string());
        let config = EdgeConfig::from_env(&env).expect("valid");
        assert!(config.pools.has_sandbox());
        assert_eq!(
            config
                .pools
                .urls(pg_upstream::Plane::Sandbox)
                .expect("sandbox"),
            ["https://sandbox.internal:4005".to_owned()].as_slice()
        );
    }

    #[test]
    fn invalid_values_are_collected_like_zod_issues() {
        let mut env = base_env();
        env = env.with_value("CORE_BACK_URL", "http://plain");
        env = env.with_value("PORT", "70000");
        env = env.with_value("SESSION_COOKIE_MODE", "yes");
        env = env.with_value("MAX_JSON_BODY_BYTES", "1");
        let error = EdgeConfig::from_env(&env).expect_err("invalid");
        let paths = error
            .issues
            .iter()
            .map(|issue| issue.path.as_str())
            .collect::<Vec<_>>();
        assert!(paths.contains(&"CORE_BACK_URL"), "{paths:?}");
        assert!(paths.contains(&"PORT"), "{paths:?}");
        assert!(paths.contains(&"SESSION_COOKIE_MODE"), "{paths:?}");
        assert!(paths.contains(&"MAX_JSON_BODY_BYTES"), "{paths:?}");
        assert!(error
            .to_string()
            .starts_with("Invalid environment configuration:"));
    }

    #[test]
    fn a_missing_core_url_is_reported() {
        let env = Env::default()
            .with_value("MTLS_CLIENT_CERT_PATH", "cert.pem")
            .with_value("MTLS_CLIENT_KEY_PATH", "key.pem")
            .with_value("MTLS_CA_CERT_PATH", "ca.pem");
        let error = EdgeConfig::from_env(&env).expect_err("invalid");
        assert!(error
            .issues
            .iter()
            .any(|issue| issue.path == "CORE_BACK_URL"));
    }

    #[test]
    fn embedding_configuration_is_self_contained() {
        let config = EdgeConfig::for_embedding(
            vec!["https://live".to_owned()],
            Some(vec!["https://sandbox".to_owned()]),
        );
        assert!(config.pools.has_sandbox());
        assert_eq!(config.max_streams_per_ip, 5);
        assert_eq!(config.pos_stream_timeout_ms, 900_000);
    }
}

//! Checkout edge configuration.
//!
//! Port of `checkout-back/lib/env/index.ts` (the zod `envSchema`), including the defaults and the
//! documented ranges, plus `checkout-back/lib/corePools.ts` for the two core pools.
//!
//! Loading is pure: [`CheckoutConfig::load`] takes a [`pg_config::Env`] and returns a value. The
//! TypeScript edge caches the environment outside `NODE_ENV=test`; the Rust edge never caches, so
//! a test process may boot several configurations in one process (the TS `env-isolation` test).

#![forbid(unsafe_code)]

use std::net::IpAddr;
use std::path::PathBuf;
use std::time::Duration;

use ipnet::IpNet;
use pg_config::{ConfigError, Env};
use pg_edge::{parse_cidr_list, CorsAllowList, TRUSTED_PROXY_DEFAULT};
use pg_mtls::ClientTlsPaths;
use pg_upstream::CorePoolConfig;
use url::Url;

/// `APP_RELEASE` default.
pub const DEFAULT_RELEASE: &str = "dev";
/// `APP_COMMIT`/`GIT_COMMIT` default.
pub const DEFAULT_COMMIT: &str = "unknown";
/// `PORT` default (`checkout-back` listens on 4103).
pub const DEFAULT_PORT: u16 = 4103;
/// `BIND_HOST` default.
pub const DEFAULT_BIND_HOST: &str = "0.0.0.0";

/// `CHECKOUT_JSON_LIMIT` (chapter 2 §2): the checkout edge parses at most 1 MiB of JSON.
pub const CHECKOUT_JSON_LIMIT: u64 = pg_edge::CHECKOUT_JSON_LIMIT;
/// `MAX_INBOUND_BODY_BYTES` default: gateways post small notification payloads.
pub const DEFAULT_INBOUND_LIMIT: u64 = 1024 * 1024;
pub const DEFAULT_PAY_RATE_LIMIT_MAX: u64 = 120;
pub const DEFAULT_PAY_RATE_LIMIT_WINDOW_MS: u64 = 60_000;
pub const DEFAULT_INBOUND_RATE_LIMIT_MAX: u64 = 600;
pub const DEFAULT_INBOUND_RATE_LIMIT_WINDOW_MS: u64 = 60_000;
pub const DEFAULT_REQUEST_TIMEOUT_MS: u64 = 30_000;
pub const DEFAULT_TOTAL_DEADLINE_MS: u64 = 300_000;
pub const DEFAULT_MAX_RESPONSE_BYTES: u64 = 64 * 1024 * 1024;
pub const DEFAULT_MAX_STREAMS_PER_IP: usize = 5;
pub const DEFAULT_CHECKOUT_FRONT_BASE_URL: &str = "http://localhost:5103";
pub const DEFAULT_CHECKOUT_FRONT_STATUS_PATH: &str = "/pay/status";

/// The checkout edge's validated configuration.
#[derive(Debug, Clone)]
pub struct CheckoutConfig {
    pub node_env: String,
    pub port: u16,
    pub bind_host: String,
    pub core: CorePoolConfig,
    pub mtls: ClientTlsPaths,
    pub request_timeout: Duration,
    pub total_deadline: Duration,
    pub max_response_bytes: u64,
    pub trusted_proxies: Vec<IpNet>,
    pub cors: CorsAllowList,
    pub max_streams_per_ip: usize,
    pub json_limit: u64,
    pub inbound_limit: u64,
    pub checkout_front_base_url: String,
    pub checkout_front_status_path: String,
    pub pay_rate_limit_max: u64,
    pub pay_rate_limit_window: Duration,
    pub inbound_rate_limit_max: u64,
    pub inbound_rate_limit_window: Duration,
    pub release: String,
    pub commit: String,
    /// `NODE_ENV`, kept for parity checks and logs.
    pub production: bool,
}

impl CheckoutConfig {
    /// Read every key from `env`, applying the TypeScript defaults and ranges.
    pub fn load(env: &Env) -> Result<Self, ConfigError> {
        let node_env = env
            .get_non_empty("NODE_ENV")
            .unwrap_or_else(|| "development".to_owned());
        if !matches!(node_env.as_str(), "development" | "test" | "production") {
            return Err(ConfigError::new(
                "NODE_ENV",
                "must be one of development, test, production",
            ));
        }

        let core_fallback = env.require("CORE_BACK_URL")?;
        require_https_url("CORE_BACK_URL", &core_fallback)?;
        let sandbox_fallback = env.get_non_empty("SANDBOX_CORE_BACK_URL");
        if let Some(value) = &sandbox_fallback {
            require_https_url("SANDBOX_CORE_BACK_URL", value)?;
        }
        let core = CorePoolConfig::from_values(
            env.get_non_empty("CORE_BACK_URLS").as_deref(),
            &core_fallback,
            env.get_non_empty("SANDBOX_CORE_BACK_URLS").as_deref(),
            sandbox_fallback.as_deref(),
        )
        .map_err(|error| ConfigError::new("CORE_BACK_URLS", error.to_string()))?;

        let mtls = ClientTlsPaths {
            ca_cert: PathBuf::from(env.require("MTLS_CA_CERT_PATH")?),
            client_cert: PathBuf::from(env.require("MTLS_CLIENT_CERT_PATH")?),
            client_key: PathBuf::from(env.require("MTLS_CLIENT_KEY_PATH")?),
        };

        let request_timeout =
            Duration::from_millis(env.u64("CORE_REQUEST_TIMEOUT_MS", DEFAULT_REQUEST_TIMEOUT_MS)?);
        if !(1_000..=300_000).contains(&request_timeout.as_millis()) {
            return Err(range_error("CORE_REQUEST_TIMEOUT_MS", 1000, 300000));
        }
        let total_deadline =
            Duration::from_millis(env.u64("CORE_TOTAL_DEADLINE_MS", DEFAULT_TOTAL_DEADLINE_MS)?);
        if !(1_000..=1_800_000).contains(&total_deadline.as_millis()) {
            return Err(range_error("CORE_TOTAL_DEADLINE_MS", 1000, 1800000));
        }
        let max_response_bytes = env.u64("CORE_MAX_RESPONSE_BYTES", DEFAULT_MAX_RESPONSE_BYTES)?;
        if !(1024..=536_870_912).contains(&max_response_bytes) {
            return Err(range_error("CORE_MAX_RESPONSE_BYTES", 1024, 536_870_912));
        }

        let trusted_proxies = parse_cidr_list(Some(
            env.get("TRUSTED_PROXY_CIDRS")
                .as_deref()
                .unwrap_or(TRUSTED_PROXY_DEFAULT),
        ));
        let cors = CorsAllowList::from_csv(env.get("CORS_ALLOWED_ORIGINS").as_deref().or(Some("")));
        let max_streams_per_ip =
            usize::try_from(env.u64("MAX_STREAMS_PER_IP", DEFAULT_MAX_STREAMS_PER_IP as u64)?)
                .unwrap_or(DEFAULT_MAX_STREAMS_PER_IP);
        if !(1..=1000).contains(&max_streams_per_ip) {
            return Err(range_error("MAX_STREAMS_PER_IP", 1, 1000));
        }

        let json_limit = env.u64("MAX_JSON_BODY_BYTES", CHECKOUT_JSON_LIMIT)?;
        if !(1024..=10_485_760).contains(&json_limit) {
            return Err(range_error("MAX_JSON_BODY_BYTES", 1024, 10_485_760));
        }
        let inbound_limit = env.u64("MAX_INBOUND_BODY_BYTES", DEFAULT_INBOUND_LIMIT)?;
        if !(1024..=26_214_400).contains(&inbound_limit) {
            return Err(range_error("MAX_INBOUND_BODY_BYTES", 1024, 26_214_400));
        }

        let checkout_front_base_url = env
            .get_non_empty("CHECKOUT_FRONT_BASE_URL")
            .unwrap_or_else(|| DEFAULT_CHECKOUT_FRONT_BASE_URL.to_owned());
        let parsed = Url::parse(&checkout_front_base_url).map_err(|_| {
            ConfigError::new("CHECKOUT_FRONT_BASE_URL", "must be an absolute http(s) URL")
        })?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err(ConfigError::new(
                "CHECKOUT_FRONT_BASE_URL",
                "must be an absolute http(s) URL",
            ));
        }
        let checkout_front_status_path = env
            .get_non_empty("CHECKOUT_FRONT_STATUS_PATH")
            .unwrap_or_else(|| DEFAULT_CHECKOUT_FRONT_STATUS_PATH.to_owned());
        if checkout_front_status_path.len() > 256 {
            return Err(range_error("CHECKOUT_FRONT_STATUS_PATH", 1, 256));
        }

        let pay_rate_limit_max = env.u64("PAY_RATE_LIMIT_MAX", DEFAULT_PAY_RATE_LIMIT_MAX)?;
        if pay_rate_limit_max < 1 {
            return Err(ConfigError::new("PAY_RATE_LIMIT_MAX", "must be at least 1"));
        }
        let pay_rate_limit_window = Duration::from_millis(
            env.u64("PAY_RATE_LIMIT_WINDOW_MS", DEFAULT_PAY_RATE_LIMIT_WINDOW_MS)?,
        );
        if pay_rate_limit_window.as_millis() < 1_000 {
            return Err(range_error("PAY_RATE_LIMIT_WINDOW_MS", 1000, u64::MAX));
        }
        let inbound_rate_limit_max =
            env.u64("INBOUND_RATE_LIMIT_MAX", DEFAULT_INBOUND_RATE_LIMIT_MAX)?;
        if inbound_rate_limit_max < 1 {
            return Err(ConfigError::new(
                "INBOUND_RATE_LIMIT_MAX",
                "must be at least 1",
            ));
        }
        let inbound_rate_limit_window = Duration::from_millis(env.u64(
            "INBOUND_RATE_LIMIT_WINDOW_MS",
            DEFAULT_INBOUND_RATE_LIMIT_WINDOW_MS,
        )?);
        if inbound_rate_limit_window.as_millis() < 1_000 {
            return Err(range_error("INBOUND_RATE_LIMIT_WINDOW_MS", 1000, u64::MAX));
        }

        let port = env.u16("PORT", DEFAULT_PORT)?;
        if port == 0 {
            return Err(ConfigError::new("PORT", "must be between 1 and 65535"));
        }

        Ok(Self {
            production: node_env == "production",
            node_env,
            port,
            bind_host: env
                .get_non_empty("BIND_HOST")
                .unwrap_or_else(|| DEFAULT_BIND_HOST.to_owned()),
            core,
            mtls,
            request_timeout,
            total_deadline,
            max_response_bytes,
            trusted_proxies,
            cors,
            max_streams_per_ip,
            json_limit,
            inbound_limit,
            checkout_front_base_url,
            checkout_front_status_path,
            pay_rate_limit_max,
            pay_rate_limit_window,
            inbound_rate_limit_max,
            inbound_rate_limit_window,
            release: env
                .get_non_empty("APP_RELEASE")
                .unwrap_or_else(|| DEFAULT_RELEASE.to_owned()),
            commit: env
                .get_non_empty("APP_COMMIT")
                .or_else(|| env.get_non_empty("GIT_COMMIT"))
                .unwrap_or_else(|| DEFAULT_COMMIT.to_owned()),
        })
    }

    /// The live core node list.
    #[must_use]
    pub fn live_urls(&self) -> &[String] {
        &self.core.live
    }

    /// The sandbox core node list, or `None` when the plane is not configured.
    #[must_use]
    pub fn sandbox_urls(&self) -> Option<&[String]> {
        self.core.sandbox.as_deref()
    }

    /// A configuration for unit and integration tests: documented defaults, no `.env` read.
    #[must_use]
    pub fn for_tests(live: Vec<String>, sandbox: Option<Vec<String>>) -> Self {
        Self {
            node_env: "test".to_owned(),
            production: false,
            port: 0,
            bind_host: "127.0.0.1".to_owned(),
            core: CorePoolConfig { live, sandbox },
            mtls: ClientTlsPaths {
                ca_cert: PathBuf::from("/tmp/checkout-edge-tests/ca.crt"),
                client_cert: PathBuf::from("/tmp/checkout-edge-tests/client.crt"),
                client_key: PathBuf::from("/tmp/checkout-edge-tests/client.key"),
            },
            request_timeout: Duration::from_millis(DEFAULT_REQUEST_TIMEOUT_MS),
            total_deadline: Duration::from_millis(DEFAULT_TOTAL_DEADLINE_MS),
            max_response_bytes: DEFAULT_MAX_RESPONSE_BYTES,
            trusted_proxies: parse_cidr_list(Some(TRUSTED_PROXY_DEFAULT)),
            cors: CorsAllowList::default(),
            max_streams_per_ip: DEFAULT_MAX_STREAMS_PER_IP,
            json_limit: CHECKOUT_JSON_LIMIT,
            inbound_limit: DEFAULT_INBOUND_LIMIT,
            checkout_front_base_url: DEFAULT_CHECKOUT_FRONT_BASE_URL.to_owned(),
            checkout_front_status_path: DEFAULT_CHECKOUT_FRONT_STATUS_PATH.to_owned(),
            pay_rate_limit_max: DEFAULT_PAY_RATE_LIMIT_MAX,
            pay_rate_limit_window: Duration::from_millis(DEFAULT_PAY_RATE_LIMIT_WINDOW_MS),
            inbound_rate_limit_max: DEFAULT_INBOUND_RATE_LIMIT_MAX,
            inbound_rate_limit_window: Duration::from_millis(DEFAULT_INBOUND_RATE_LIMIT_WINDOW_MS),
            release: "test".to_owned(),
            commit: "test".to_owned(),
        }
    }

    /// The client IP used to key limiters; `"unknown"` when the peer is unknown.
    #[must_use]
    pub fn limiter_key(&self, client: Option<IpAddr>) -> String {
        client.map_or_else(|| "unknown".to_owned(), rate_limit_ip_key)
    }
}

fn require_https_url(key: &str, value: &str) -> Result<(), ConfigError> {
    match Url::parse(value) {
        Ok(parsed) if parsed.scheme() == "https" => Ok(()),
        _ => Err(ConfigError::new(key, "must be an absolute https URL")),
    }
}

fn range_error(key: &str, min: u64, max: u64) -> ConfigError {
    ConfigError::new(key, format!("must be between {min} and {max}"))
}

/// `express-rate-limit`'s `ipKeyGenerator`: IPv6 addresses are grouped by /56 so a single client
/// cannot rotate addresses inside its own prefix to evade a limit.
#[must_use]
pub fn rate_limit_ip_key(ip: IpAddr) -> String {
    match ip {
        IpAddr::V4(address) => address.to_string(),
        IpAddr::V6(address) => {
            let mut segments = address.segments();
            // Zero every bit after the first 56. /56 covers exactly the first three 16-bit
            // groups plus the high byte of the fourth.
            for (index, segment) in segments.iter_mut().enumerate() {
                match index {
                    0..=2 => {}
                    3 => *segment &= 0xff00,
                    _ => *segment = 0,
                }
            }
            format!("{}/56", std::net::Ipv6Addr::from(segments))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_env() -> Env {
        Env::process()
            .with_value("NODE_ENV", "test")
            .with_value("CORE_BACK_URL", "https://core.live.internal:4000")
            .with_value(
                "CORE_BACK_URLS",
                "https://core-a.internal:4000,https://core-b.internal:4000",
            )
            .with_value(
                "SANDBOX_CORE_BACK_URLS",
                "https://core.sandbox.internal:4005",
            )
            .with_value("MTLS_CA_CERT_PATH", "/tmp/ca.crt")
            .with_value("MTLS_CLIENT_CERT_PATH", "/tmp/client.crt")
            .with_value("MTLS_CLIENT_KEY_PATH", "/tmp/client.key")
            .with_value("TRUSTED_PROXY_CIDRS", "127.0.0.0/8,::1/128")
    }

    #[test]
    fn loads_the_documented_defaults() {
        let config = CheckoutConfig::load(&base_env()).expect("config");
        assert_eq!(config.port, 4103);
        assert_eq!(config.bind_host, "0.0.0.0");
        assert_eq!(config.json_limit, 1_048_576);
        assert_eq!(config.inbound_limit, 1_048_576);
        assert_eq!(config.pay_rate_limit_max, 120);
        assert_eq!(config.pay_rate_limit_window, Duration::from_secs(60));
        assert_eq!(config.inbound_rate_limit_max, 600);
        assert_eq!(config.request_timeout, Duration::from_secs(30));
        assert_eq!(config.total_deadline, Duration::from_secs(300));
        assert_eq!(config.max_response_bytes, 67_108_864);
        assert_eq!(config.max_streams_per_ip, 5);
        assert_eq!(config.checkout_front_status_path, "/pay/status");
        assert!(!config.production);
    }

    #[test]
    fn core_and_sandbox_pools_are_separate() {
        let config = CheckoutConfig::load(&base_env()).expect("config");
        assert_eq!(
            config.live_urls(),
            [
                "https://core-a.internal:4000".to_owned(),
                "https://core-b.internal:4000".to_owned()
            ]
            .as_slice()
        );
        assert_eq!(
            config.sandbox_urls().expect("sandbox"),
            ["https://core.sandbox.internal:4005".to_owned()].as_slice()
        );
    }

    #[test]
    fn missing_sandbox_configuration_is_not_an_error() {
        let env = base_env()
            .with_value("SANDBOX_CORE_BACK_URLS", "")
            .with_value("SANDBOX_CORE_BACK_URL", "");
        let config = CheckoutConfig::load(&env).expect("config");
        assert!(config.sandbox_urls().is_none());
    }

    #[test]
    fn rejects_insecure_and_malformed_core_urls() {
        let env = base_env().with_value("CORE_BACK_URL", "http://core.internal:4000");
        let error = CheckoutConfig::load(&env).expect_err("http");
        assert_eq!(error.key, "CORE_BACK_URL");

        let env = base_env()
            .with_value("CORE_BACK_URL", "https://core.internal:4000")
            .with_value("CORE_BACK_URLS", "https://a.internal:4000,,");
        let error = CheckoutConfig::load(&env).expect_err("empty entry");
        assert_eq!(error.key, "CORE_BACK_URLS");
    }

    #[test]
    fn rejects_out_of_range_limits() {
        let env = base_env().with_value("MAX_JSON_BODY_BYTES", "1023");
        let error = CheckoutConfig::load(&env).expect_err("too small");
        assert_eq!(error.key, "MAX_JSON_BODY_BYTES");

        let env = base_env().with_value("CORE_REQUEST_TIMEOUT_MS", "999");
        let error = CheckoutConfig::load(&env).expect_err("timeout");
        assert_eq!(error.key, "CORE_REQUEST_TIMEOUT_MS");
    }

    #[test]
    fn requires_mtls_material_paths() {
        let env = base_env().with_value("MTLS_CA_CERT_PATH", "");
        let error = CheckoutConfig::load(&env).expect_err("missing ca");
        assert_eq!(error.key, "MTLS_CA_CERT_PATH");
    }

    #[test]
    fn front_base_url_must_be_http_or_https() {
        let env = base_env().with_value("CHECKOUT_FRONT_BASE_URL", "ftp://pay.example");
        let error = CheckoutConfig::load(&env).expect_err("scheme");
        assert_eq!(error.key, "CHECKOUT_FRONT_BASE_URL");
    }

    #[test]
    fn rate_limit_keys_group_ipv6_by_56() {
        let first: IpAddr = "2001:db8:1:2::1".parse().expect("ip");
        let second: IpAddr = "2001:db8:1:2:ffff::9".parse().expect("ip");
        assert_eq!(rate_limit_ip_key(first), rate_limit_ip_key(second));
        assert_eq!(rate_limit_ip_key(first), "2001:db8:1::/56");
        let other: IpAddr = "2001:db8:2::1".parse().expect("ip");
        assert_ne!(rate_limit_ip_key(first), rate_limit_ip_key(other));
        let v4: IpAddr = "203.0.113.9".parse().expect("ip");
        assert_eq!(rate_limit_ip_key(v4), "203.0.113.9");
        assert_eq!(
            CheckoutConfig::load(&base_env())
                .expect("config")
                .limiter_key(None),
            "unknown"
        );
    }

    #[test]
    fn loading_is_not_cached_between_calls() {
        let first = CheckoutConfig::load(&base_env()).expect("first");
        let second = CheckoutConfig::load(
            &base_env().with_value("CORE_BACK_URLS", "https://second.internal:4000"),
        )
        .expect("second");
        assert_eq!(first.live_urls()[0], "https://core-a.internal:4000");
        assert_eq!(
            second.live_urls(),
            ["https://second.internal:4000".to_owned()].as_slice()
        );
        assert_ne!(first.live_urls(), second.live_urls());
        assert_eq!(
            CheckoutConfig::load(
                &base_env().with_value("CORE_BACK_URLS", "https://only.internal:4000")
            )
            .expect("single")
            .live_urls(),
            ["https://only.internal:4000".to_owned()].as_slice()
        );
    }
}

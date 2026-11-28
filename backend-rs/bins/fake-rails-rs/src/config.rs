//! Startup configuration of the standalone Fake Payment Rails service.
//!
//! TS: `lib/env/index.ts`. Three guards are enforced before the listener is created:
//!  1. production opt-in (`FAKE_RAILS_ALLOW_IN_PRODUCTION`),
//!  2. the service must be enabled,
//!  3. the tester credentials, the JWT secret and the seeder token must be strong and distinct.

#![forbid(unsafe_code)]

use std::path::{Path, PathBuf};

use pg_config::Env;

use crate::error::ApiError;

const DEFAULT_PASSWORDS: &[&str] = &[
    "ChangeMe-Strong-Tester-Pass-2026!",
    "changeme",
    "password",
    "tester_admin",
];

const PLACEHOLDER_MARKERS: &[&str] = &[
    "change-me",
    "changeme",
    "change_me",
    "replace-me",
    "replaceme",
    "your-",
    "example",
    "placeholder",
    "password",
    "admin",
    "default",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub node_env: String,
    pub host: String,
    pub port: u16,
    pub log_level: String,
    pub enabled: bool,
    pub allow_in_production: bool,
    pub public_base_url: String,
    pub data_dir: String,
    pub db_path: String,
    pub core_inbound_base_url: String,
    pub admin_user: String,
    pub admin_password: String,
    pub jwt_secret: String,
    pub seeder_token: String,
    pub control_token: Option<String>,
    pub trust_proxy: String,
    pub portal_account_lockout: u32,
    pub allowed_cidrs: String,
    pub webhook_allowed_hosts: String,
    pub webhook_timeout_ms: u64,
    pub max_body_bytes: usize,
    pub portal_rate_limit: u32,
    pub portal_rate_window_ms: i64,
    pub timeout_hang_ms: u64,
    pub timezone: String,
}

impl Config {
    /// Parses and validates the process environment (the service's own `.env` included).
    pub fn from_process_env() -> Result<Self, ApiError> {
        let env = Env::load_default().map_err(|error| {
            ApiError::new(
                500,
                "CONFIG_ERROR",
                format!("could not load the environment: {error}"),
            )
        })?;
        Self::from_env(&env)
    }

    pub fn from_env(env: &Env) -> Result<Self, ApiError> {
        let data_dir = env
            .get_non_empty("FAKE_RAILS_DATA_DIR")
            .unwrap_or_else(|| "shared/data".to_owned());
        let db_path = env.get_non_empty("FAKE_RAILS_DB_PATH").unwrap_or_else(|| {
            Path::new(&data_dir)
                .join("fake-rails.sqlite")
                .to_string_lossy()
                .into_owned()
        });
        let config = Self {
            node_env: env
                .get_non_empty("NODE_ENV")
                .unwrap_or_else(|| "development".to_owned()),
            host: env
                .get_non_empty("HOST")
                .unwrap_or_else(|| "127.0.0.1".to_owned()),
            // TS default (`fake-rails-back/lib/env/index.ts`).
            port: env.u16("PORT", 4104).map_err(config_error)?,
            log_level: env
                .get_non_empty("LOG_LEVEL")
                .unwrap_or_else(|| "info".to_owned()),
            enabled: env.bool("FAKE_RAILS_ENABLED", true).map_err(config_error)?,
            allow_in_production: env
                .bool("FAKE_RAILS_ALLOW_IN_PRODUCTION", false)
                .map_err(config_error)?,
            public_base_url: env
                .get_non_empty("FAKE_RAILS_PUBLIC_BASE_URL")
                .unwrap_or_else(|| "http://127.0.0.1:8444".to_owned()),
            data_dir,
            db_path,
            core_inbound_base_url: env
                .get_non_empty("CORE_INBOUND_BASE_URL")
                .unwrap_or_else(|| "http://127.0.0.1:4103/api/v1/inbound".to_owned()),
            admin_user: env
                .get_non_empty("FAKE_RAILS_ADMIN_USER")
                .unwrap_or_default(),
            admin_password: env
                .get_non_empty("FAKE_RAILS_ADMIN_PASSWORD")
                .unwrap_or_default(),
            jwt_secret: env
                .get_non_empty("FAKE_RAILS_JWT_SECRET")
                .unwrap_or_default(),
            seeder_token: env
                .get_non_empty("FAKE_RAILS_SEEDER_TOKEN")
                .unwrap_or_default(),
            control_token: env.get_non_empty("FAKE_RAILS_CONTROL_TOKEN"),
            trust_proxy: env
                .get_non_empty("FAKE_RAILS_TRUST_PROXY")
                .unwrap_or_else(|| "loopback".to_owned()),
            portal_account_lockout: env
                .u64("FAKE_RAILS_PORTAL_ACCOUNT_LOCKOUT", 5)
                .map_err(config_error)?
                .clamp(1, 1000) as u32,
            allowed_cidrs: env
                .get_non_empty("FAKE_RAILS_ALLOWED_CIDRS")
                .unwrap_or_else(|| "127.0.0.1/32,10.0.0.0/8,192.168.0.0/16".to_owned()),
            webhook_allowed_hosts: env
                .get_non_empty("FAKE_RAILS_WEBHOOK_ALLOWED_HOSTS")
                .unwrap_or_default(),
            webhook_timeout_ms: env
                .u64("FAKE_RAILS_WEBHOOK_TIMEOUT_MS", 10_000)
                .map_err(config_error)?
                .clamp(1, 120_000),
            max_body_bytes: env
                .u64("FAKE_RAILS_MAX_BODY_BYTES", 10 * 1024 * 1024)
                .map_err(config_error)?
                .clamp(1, 50 * 1024 * 1024) as usize,
            portal_rate_limit: env
                .u64("FAKE_RAILS_PORTAL_RATE_LIMIT", 10)
                .map_err(config_error)?
                .clamp(1, 1000) as u32,
            portal_rate_window_ms: env
                .u64("FAKE_RAILS_PORTAL_RATE_WINDOW_MS", 15 * 60_000)
                .map_err(config_error)? as i64,
            timeout_hang_ms: env
                .u64("FAKE_RAILS_TIMEOUT_HANG_MS", 20_000)
                .map_err(config_error)?
                .max(1),
            timezone: env
                .get_non_empty("FAKE_RAILS_TIMEZONE")
                .unwrap_or_else(|| "Africa/Tripoli".to_owned()),
        };
        config.validate()?;
        Ok(config)
    }

    fn validate(&self) -> Result<(), ApiError> {
        if self.node_env == "production" && !self.allow_in_production {
            return Err(ApiError::new(
                500,
                "FAKE_RAILS_PRODUCTION_GUARD_BLOCKED",
                "Set FAKE_RAILS_ALLOW_IN_PRODUCTION=\"true\" to run Fake Rails in production mode",
            ));
        }
        if !self.enabled {
            return Err(ApiError::new(
                500,
                "FAKE_RAILS_DISABLED",
                "FAKE_RAILS_ENABLED must be 'true' to start the service",
            ));
        }
        if self.admin_user.len() < 4 || self.admin_user.len() > 128 {
            return Err(ApiError::new(
                500,
                "FAKE_RAILS_WEAK_CREDENTIALS",
                "FAKE_RAILS_ADMIN_USER must be 4-128 characters",
            ));
        }
        if self.admin_password.len() < 12 || self.admin_password.len() > 512 {
            return Err(ApiError::new(
                500,
                "FAKE_RAILS_WEAK_CREDENTIALS",
                "FAKE_RAILS_ADMIN_PASSWORD must be 12-512 characters",
            ));
        }
        if self.jwt_secret.len() < 32 || self.jwt_secret.len() > 512 {
            return Err(ApiError::new(
                500,
                "FAKE_RAILS_WEAK_CREDENTIALS",
                "FAKE_RAILS_JWT_SECRET must be 32-512 characters",
            ));
        }
        if self.seeder_token.len() < 32 || self.seeder_token.len() > 512 {
            return Err(ApiError::new(
                500,
                "FAKE_RAILS_WEAK_CREDENTIALS",
                "FAKE_RAILS_SEEDER_TOKEN must be 32-512 characters",
            ));
        }
        if DEFAULT_PASSWORDS.contains(&self.admin_password.as_str()) {
            return Err(ApiError::new(
                500,
                "FAKE_RAILS_WEAK_CREDENTIALS",
                "FAKE_RAILS_ADMIN_PASSWORD must not be a default value",
            ));
        }
        for (name, secret) in [
            ("FAKE_RAILS_ADMIN_PASSWORD", &self.admin_password),
            ("FAKE_RAILS_JWT_SECRET", &self.jwt_secret),
            ("FAKE_RAILS_SEEDER_TOKEN", &self.seeder_token),
        ] {
            if let Some(reason) = weak_secret_reason(secret) {
                return Err(ApiError::new(
                    500,
                    "FAKE_RAILS_WEAK_CREDENTIALS",
                    format!("{name} {reason}; replace this placeholder with a generated secret"),
                ));
            }
        }
        if self.jwt_secret == self.seeder_token {
            return Err(ApiError::new(
                500,
                "FAKE_RAILS_WEAK_CREDENTIALS",
                "FAKE_RAILS_JWT_SECRET and FAKE_RAILS_SEEDER_TOKEN must differ",
            ));
        }
        if self.admin_user == self.admin_password {
            return Err(ApiError::new(
                500,
                "FAKE_RAILS_WEAK_CREDENTIALS",
                "the tester username and password must differ",
            ));
        }
        if let Some(token) = &self.control_token {
            if token.len() < 16 || token.len() > 512 {
                return Err(ApiError::new(
                    500,
                    "FAKE_RAILS_WEAK_CREDENTIALS",
                    "FAKE_RAILS_CONTROL_TOKEN must be 16-512 characters",
                ));
            }
        }
        if parse_url(&self.public_base_url).is_none() {
            return Err(ApiError::new(
                500,
                "CONFIG_ERROR",
                "FAKE_RAILS_PUBLIC_BASE_URL must be an absolute URL",
            ));
        }
        if parse_url(&self.core_inbound_base_url).is_none() {
            return Err(ApiError::new(
                500,
                "CONFIG_ERROR",
                "CORE_INBOUND_BASE_URL must be an absolute URL",
            ));
        }
        Ok(())
    }

    /// Test/dev configuration with the same shape as a valid environment. Every secret is
    /// non-placeholder so the production guards are exercised only when a test asks for them.
    #[must_use]
    pub fn test_config(db_path: impl Into<PathBuf>) -> Self {
        Self {
            node_env: "test".to_owned(),
            host: "127.0.0.1".to_owned(),
            port: 4104,
            log_level: "info".to_owned(),
            enabled: true,
            allow_in_production: false,
            public_base_url: "http://127.0.0.1:8444".to_owned(),
            data_dir: "/tmp/fake-rails-rs-test".to_owned(),
            db_path: db_path.into().to_string_lossy().into_owned(),
            core_inbound_base_url: "http://core.lab.internal:4103/api/v1/inbound".to_owned(),
            admin_user: "tester_admin".to_owned(),
            admin_password: "Strong-Tester-Pass-2026!".to_owned(),
            jwt_secret: "jwt-Rk7Qm2Xv9Lp4Zn8Bc3Wd6Th1Yg5Js0Af".to_owned(),
            seeder_token: "seed-Hv3Tn8Yq1Dz6Mk4Pw9Xc2Lb7Rg5Fj0Ua".to_owned(),
            control_token: None,
            trust_proxy: "loopback".to_owned(),
            portal_account_lockout: 5,
            allowed_cidrs: "127.0.0.1/32,10.0.0.0/8,192.168.0.0/16".to_owned(),
            webhook_allowed_hosts: "receiver.lab.internal, hook.lab.internal:9443".to_owned(),
            webhook_timeout_ms: 500,
            max_body_bytes: 10 * 1024 * 1024,
            portal_rate_limit: 10,
            portal_rate_window_ms: 15 * 60_000,
            timeout_hang_ms: 40,
            timezone: "Africa/Tripoli".to_owned(),
        }
    }

    /// Origin used by hosted pages and the SDK scripts (trailing slash removed).
    #[must_use]
    pub fn public_origin(&self) -> String {
        self.public_base_url.trim_end_matches('/').to_owned()
    }
}

fn config_error(error: impl std::fmt::Display) -> ApiError {
    ApiError::new(500, "CONFIG_ERROR", error.to_string())
}

fn parse_url(value: &str) -> Option<url::Url> {
    url::Url::parse(value).ok()
}

/// Mirrors `lib/security/index.ts::weakSecretReason`.
#[must_use]
pub fn weak_secret_reason(value: &str) -> Option<String> {
    let lower = value.to_ascii_lowercase();
    if let Some(marker) = PLACEHOLDER_MARKERS
        .iter()
        .find(|marker| lower.contains(**marker))
    {
        return Some(format!(
            "contains the placeholder/guessable word '{marker}'"
        ));
    }
    let chars: Vec<char> = value.chars().collect();
    for unit in 1..=16usize {
        if chars.len() >= unit * 2
            && chars.len().is_multiple_of(unit)
            && chars.chunks(unit).all(|chunk| chunk == &chars[..unit])
        {
            return Some("is a repeated pattern".to_owned());
        }
    }
    let mut ascending = 1usize;
    let mut descending = 1usize;
    for pair in chars.windows(2) {
        let delta = i32::from(pair[1] as u8) - i32::from(pair[0] as u8);
        ascending = if delta == 1 { ascending + 1 } else { 1 };
        descending = if delta == -1 { descending + 1 } else { 1 };
        if ascending >= 8 || descending >= 8 {
            return Some("contains a sequential run".to_owned());
        }
    }
    let distinct = chars
        .iter()
        .collect::<std::collections::BTreeSet<_>>()
        .len();
    if (chars.len() >= 24 && distinct < 10) || (chars.len() >= 12 && distinct < 6) {
        return Some("has too few distinct characters".to_owned());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weak_secret_detection_matches_ts() {
        assert!(weak_secret_reason("change-me-fake-rails-jwt-secret").is_some());
        assert!(weak_secret_reason("0123456789abcdef0123456789abcdef").is_some());
        assert!(weak_secret_reason("jwt-Rk7Qm2Xv9Lp4Zn8Bc3Wd6Th1Yg5Js0Af").is_none());
    }

    #[test]
    fn test_config_validates() {
        let config = Config::test_config("/tmp/x.sqlite");
        assert!(config.validate().is_ok());
        assert_eq!(config.public_origin(), "http://127.0.0.1:8444");
    }

    #[test]
    fn production_guard_blocks_without_opt_in() {
        let mut config = Config::test_config("/tmp/x.sqlite");
        config.node_env = "production".to_owned();
        let error = config.validate().expect_err("must block");
        assert_eq!(error.code, "FAKE_RAILS_PRODUCTION_GUARD_BLOCKED");
        config.allow_in_production = true;
        assert!(config.validate().is_ok());
    }
}

//! Database URL normalisation.
//!
//! Deploy writes `?sslmode=no-verify`, which node-postgres accepts and sqlx/libpq do not. Map it
//! to "TLS required, certificate not verified" (`PgSslMode::Require`), keep the rest of the URL
//! semantics, and expose the pool knobs (`connection_limit` / `pool_max`).

#![forbid(unsafe_code)]

use std::fmt;
use std::str::FromStr;

use sqlx::postgres::{PgConnectOptions, PgSslMode};

/// TLS mode as configured by the deploy engine. Kept separate because sqlx's `PgSslMode` does
/// not implement `PartialEq`, and the URL contract must be testable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SslMode {
    Disable,
    Prefer,
    Require,
    VerifyCa,
    VerifyFull,
}

impl SslMode {
    #[must_use]
    pub fn to_sqlx(self) -> PgSslMode {
        match self {
            Self::Disable => PgSslMode::Disable,
            Self::Prefer => PgSslMode::Prefer,
            Self::Require => PgSslMode::Require,
            Self::VerifyCa => PgSslMode::VerifyCa,
            Self::VerifyFull => PgSslMode::VerifyFull,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UrlError {
    MissingScheme,
    UnsupportedScheme(String),
    MissingHost,
    MissingDatabase,
    InvalidPort(String),
}

impl fmt::Display for UrlError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingScheme => f.write_str("database URL has no scheme"),
            Self::UnsupportedScheme(scheme) => {
                write!(f, "unsupported database URL scheme {scheme:?}")
            }
            Self::MissingHost => f.write_str("database URL has no host"),
            Self::MissingDatabase => f.write_str("database URL has no database name"),
            Self::InvalidPort(port) => write!(f, "database URL port {port:?} is invalid"),
        }
    }
}

impl std::error::Error for UrlError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApplicationName {
    Core,
    Leader,
    ReportReadonly,
    Custom,
}

impl ApplicationName {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Core => crate::APP_NAME_CORE,
            Self::Leader => crate::APP_NAME_LEADER,
            Self::ReportReadonly => crate::APP_NAME_REPORT_READONLY,
            Self::Custom => "pg-rust",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PoolSettings {
    pub max_connections: u32,
    pub acquire_timeout_ms: u64,
    pub idle_timeout_ms: u64,
    pub statement_cache: u32,
}

impl Default for PoolSettings {
    fn default() -> Self {
        Self {
            max_connections: 20,
            acquire_timeout_ms: 2_000,
            idle_timeout_ms: 30_000,
            statement_cache: 256,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct DatabaseUrl {
    pub raw: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    pub ssl_mode: SslMode,
    pub application_name: String,
    pub pool: PoolSettings,
    /// The original `sslmode` spelling, for diagnostics only.
    pub original_sslmode: Option<String>,
}

/// Parse a URL with the given application name and default pool settings.
pub fn parse_database_url(
    raw: &str,
    application_name: ApplicationName,
) -> Result<DatabaseUrl, UrlError> {
    parse_pool_url(raw, application_name, PoolSettings::default())
}

/// Parse a URL, applying explicit pool defaults when the URL has no knobs.
pub fn parse_pool_url(
    raw: &str,
    application_name: ApplicationName,
    defaults: PoolSettings,
) -> Result<DatabaseUrl, UrlError> {
    let parsed = url::Url::parse(raw).map_err(|_| UrlError::MissingScheme)?;
    let scheme = parsed.scheme();
    if !matches!(scheme, "postgres" | "postgresql") {
        return Err(UrlError::UnsupportedScheme(scheme.to_owned()));
    }
    let host = parsed.host_str().ok_or(UrlError::MissingHost)?.to_owned();
    let port = parsed.port().unwrap_or(5432);
    let database = parsed.path().trim_start_matches('/').to_owned();
    if database.is_empty() {
        return Err(UrlError::MissingDatabase);
    }
    let username = if parsed.username().is_empty() {
        "postgres".to_owned()
    } else {
        parsed.username().to_owned()
    };

    let mut ssl_mode = SslMode::Prefer;
    let mut original_sslmode = None;
    let mut pool = defaults;
    for (key, value) in parsed.query_pairs() {
        match key.as_ref() {
            "sslmode" => {
                original_sslmode = Some(value.to_string());
                ssl_mode = match value.as_ref() {
                    // node-postgres accepts this; sqlx has no equivalent spelling.
                    "no-verify" => SslMode::Require,
                    "require" => SslMode::Require,
                    "verify-ca" => SslMode::VerifyCa,
                    "verify-full" => SslMode::VerifyFull,
                    "disable" => SslMode::Disable,
                    "prefer" | "allow" => SslMode::Prefer,
                    _ => SslMode::Prefer,
                };
            }
            "connection_limit" | "pool_max" | "max_connections" => {
                if let Ok(value) = value.parse::<u32>() {
                    pool.max_connections = value.max(1);
                }
            }
            "pool_connect_timeout_ms" | "connect_timeout_ms" => {
                if let Ok(value) = value.parse::<u64>() {
                    pool.acquire_timeout_ms = value;
                }
            }
            "statement_cache" => {
                if let Ok(value) = value.parse::<u32>() {
                    pool.statement_cache = value;
                }
            }
            _ => {}
        }
    }

    Ok(DatabaseUrl {
        raw: raw.to_owned(),
        host,
        port,
        database,
        username,
        ssl_mode,
        application_name: application_name.as_str().to_owned(),
        pool,
        original_sslmode,
    })
}

impl DatabaseUrl {
    /// sqlx connection options, with UTC pinned in `after_connect` semantics.
    pub fn connect_options(&self) -> Result<PgConnectOptions, UrlError> {
        let options = PgConnectOptions::new()
            .host(&self.host)
            .port(self.port)
            .username(&self.username)
            .database(&self.database)
            .ssl_mode(self.ssl_mode.to_sqlx())
            .application_name(&self.application_name)
            .options([("timezone", "UTC")]);
        Ok(options)
    }

    /// Password from the raw URL (kept out of `Debug`).
    #[must_use]
    pub fn password(&self) -> Option<String> {
        url::Url::parse(&self.raw)
            .ok()
            .and_then(|url| url.password().map(str::to_owned))
    }

    /// A URL with the password removed, safe for logs and `/health`.
    #[must_use]
    pub fn redacted(&self) -> String {
        let Ok(mut url) = url::Url::parse(&self.raw) else {
            return "<invalid-url>".to_owned();
        };
        if url.password().is_some() {
            let _ = url.set_password(Some("[REDACTED]"));
        }
        url.to_string()
    }
}

impl fmt::Display for DatabaseUrl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.redacted())
    }
}

impl FromStr for DatabaseUrl {
    type Err = UrlError;
    fn from_str(raw: &str) -> Result<Self, Self::Err> {
        parse_database_url(raw, ApplicationName::Core)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_verify_maps_to_require() {
        let url = parse_database_url(
            "postgresql://pgw_app:pw@127.0.0.1:6432/payment_gateway_prod?sslmode=no-verify&connection_limit=12",
            ApplicationName::Core,
        )
        .expect("valid");
        assert_eq!(url.ssl_mode, SslMode::Require);
        assert_eq!(url.pool.max_connections, 12);
        assert_eq!(url.application_name, "pg-core-back");
        assert_eq!(url.original_sslmode.as_deref(), Some("no-verify"));
    }

    #[test]
    fn password_is_never_displayed() {
        let url = parse_database_url(
            "postgresql://user:supersecret@db:5432/app",
            ApplicationName::Leader,
        )
        .expect("valid");
        assert!(!url.to_string().contains("supersecret"));
        assert_eq!(url.password().as_deref(), Some("supersecret"));
        assert_eq!(url.application_name, "pg-core-back-leader");
    }

    #[test]
    fn rejects_bad_schemes() {
        assert!(matches!(
            parse_database_url("mysql://x/y", ApplicationName::Core),
            Err(UrlError::UnsupportedScheme(_))
        ));
    }

    #[test]
    fn connect_options_are_built() {
        let url = parse_database_url(
            "postgres://u@localhost/app?sslmode=verify-full",
            ApplicationName::Core,
        )
        .expect("valid");
        let options = url.connect_options().expect("options");
        // The Debug form is the only accessible representation; it must not leak a password.
        assert!(!format!("{options:?}").contains("pw"));
    }
}

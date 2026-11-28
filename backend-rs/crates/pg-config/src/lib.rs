//! Typed environment and credentials loading.
//!
//! Port of `core-back/lib/env/index.ts` (schema shape), `deploy/object-storage-daemon/src/config.ts`
//! and the systemd-credentials extension described in chapter 2 §21 / AD-13.
//!
//! Rules reproduced from the TypeScript services:
//! - a `.env` file never overrides an already-set process variable (dotenvy semantics);
//! - a value read from `$CREDENTIALS_DIRECTORY/<KEY>` wins over the file and the process environment;
//! - booleans are `true/1/yes` (core, edges) or `true/1/yes/on` (daemons), case-insensitive;
//! - configuration errors carry the key name and never the value.

#![forbid(unsafe_code)]

mod credentials;
mod dotenv;
mod object_storage;

pub use credentials::{CredentialsDirectory, SecretValue};
pub use dotenv::{parse_dotenv, DotenvError};
pub use object_storage::{ObjectStorageConfigError, ObjectStorageDaemonConfig};

use std::collections::BTreeMap;
use std::fmt;
use std::path::Path;

/// A single configuration error. The message always names the key, never the value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigError {
    pub key: String,
    pub message: String,
}

impl ConfigError {
    #[must_use]
    pub fn new(key: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            message: message.into(),
        }
    }
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Invalid environment configuration: {}", self.key)
    }
}

impl std::error::Error for ConfigError {}

/// Runtime environment used by every Rust service.
///
/// Loading order (last wins): `.env` file, process environment, systemd credentials.
#[derive(Clone, Default)]
pub struct Env {
    values: BTreeMap<String, String>,
    credentials: Option<CredentialsDirectory>,
}

impl fmt::Debug for Env {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Never print values: some of them are secrets.
        f.debug_struct("Env")
            .field("keys", &self.values.keys().collect::<Vec<_>>())
            .field("credentials", &self.credentials.is_some())
            .finish()
    }
}

impl Env {
    /// Load the process environment only.
    #[must_use]
    pub fn process() -> Self {
        let mut env = Self::default();
        env.merge_process();
        env.credentials = CredentialsDirectory::from_process();
        env
    }

    /// Load a `.env` file (optional) and then the process environment.
    pub fn load(path: Option<&Path>) -> Result<Self, DotenvError> {
        let mut values = BTreeMap::new();
        if let Some(path) = path {
            values.extend(parse_dotenv(path)?);
        }
        let mut env = Self {
            values,
            credentials: None,
        };
        env.merge_process();
        env.credentials = CredentialsDirectory::from_process();
        Ok(env)
    }

    /// Load the file named by `DOTENV_PATH` (or `.env` in the working directory when it exists),
    /// then the process environment. This mirrors the Bun/Node services.
    pub fn load_default() -> Result<Self, DotenvError> {
        let explicit = std::env::var("DOTENV_PATH").ok();
        let path = explicit.map(std::path::PathBuf::from).or_else(|| {
            let candidate = Path::new(".env");
            candidate.is_file().then(|| candidate.to_path_buf())
        });
        Self::load(path.as_deref())
    }

    fn merge_process(&mut self) {
        for (key, value) in std::env::vars() {
            self.values.insert(key, value);
        }
    }

    /// Overrides for tests and embedders. Credentials still win.
    #[must_use]
    pub fn with_value(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.values.insert(key.into(), value.into());
        self
    }

    /// Replace the credentials directory (used by tests).
    #[must_use]
    pub fn with_credentials(mut self, credentials: CredentialsDirectory) -> Self {
        self.credentials = Some(credentials);
        self
    }

    /// Resolve a key with the credentials-directory override.
    #[must_use]
    pub fn get(&self, key: &str) -> Option<String> {
        if let Some(credentials) = &self.credentials {
            if let Some(value) = credentials.read(key) {
                return Some(value);
            }
        }
        self.values.get(key).cloned()
    }

    /// Resolve a secret. The returned value zeroizes on drop and never implements `Display`.
    #[must_use]
    pub fn get_secret(&self, key: &str) -> Option<SecretValue> {
        self.get(key).map(SecretValue::new)
    }

    /// Trimmed value; an empty string is treated as unset, like `z.string().trim().min(1)`.
    #[must_use]
    pub fn get_non_empty(&self, key: &str) -> Option<String> {
        self.get(key)
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    }

    pub fn require(&self, key: &str) -> Result<String, ConfigError> {
        self.get_non_empty(key)
            .ok_or_else(|| ConfigError::new(key, "is required but is not set"))
    }

    /// Parse a boolean with the core/edge accepted spellings (`true/1/yes`, plus `on` for daemons).
    pub fn bool(&self, key: &str, default: bool) -> Result<bool, ConfigError> {
        match self.get(key) {
            None => Ok(default),
            Some(raw) if raw.trim().is_empty() => Ok(default),
            Some(raw) => parse_bool(&raw).ok_or_else(|| {
                ConfigError::new(key, "must be one of true, 1, yes, on, false, 0, no, off")
            }),
        }
    }

    /// Daemon flavour of [`Env::bool`]: an unset or blank value takes the default.
    pub fn daemon_bool(&self, key: &str, default: bool) -> Result<bool, ConfigError> {
        self.bool(key, default)
    }

    pub fn u16(&self, key: &str, default: u16) -> Result<u16, ConfigError> {
        match self.get(key) {
            None => Ok(default),
            Some(raw) if raw.trim().is_empty() => Ok(default),
            Some(raw) => raw
                .trim()
                .parse::<u16>()
                .map_err(|_| ConfigError::new(key, "must be an unsigned 16-bit integer")),
        }
    }

    pub fn u64(&self, key: &str, default: u64) -> Result<u64, ConfigError> {
        match self.get(key) {
            None => Ok(default),
            Some(raw) if raw.trim().is_empty() => Ok(default),
            Some(raw) => raw
                .trim()
                .parse::<u64>()
                .map_err(|_| ConfigError::new(key, "must be an unsigned integer")),
        }
    }

    pub fn i64(&self, key: &str, default: i64) -> Result<i64, ConfigError> {
        match self.get(key) {
            None => Ok(default),
            Some(raw) if raw.trim().is_empty() => Ok(default),
            Some(raw) => raw
                .trim()
                .parse::<i64>()
                .map_err(|_| ConfigError::new(key, "must be an integer")),
        }
    }

    /// Comma-separated list, trimmed, empty entries dropped.
    #[must_use]
    pub fn csv(&self, key: &str) -> Vec<String> {
        self.get(key)
            .map(|raw| {
                raw.split(',')
                    .map(str::trim)
                    .filter(|entry| !entry.is_empty())
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    }

    /// All keys, for diagnostics. Values are never exposed.
    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.values.keys().map(String::as_str)
    }
}

/// Parse the boolean spellings accepted by the TS services.
#[must_use]
pub fn parse_bool(raw: &str) -> Option<bool> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn booleans_match_the_ts_spellings() {
        assert_eq!(parse_bool("TRUE"), Some(true));
        assert_eq!(parse_bool(" on "), Some(true));
        assert_eq!(parse_bool("0"), Some(false));
        assert_eq!(parse_bool("maybe"), None);
    }

    #[test]
    fn blank_means_default() {
        let env = Env::default().with_value("X", "  ");
        assert!(env.bool("X", true).expect("valid"));
    }
}

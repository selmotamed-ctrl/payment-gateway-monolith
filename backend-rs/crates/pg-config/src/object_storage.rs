//! Object-storage daemon configuration.
//!
//! Port of `deploy/object-storage-daemon/src/config.ts` (byte-for-byte rules and error codes).

#![forbid(unsafe_code)]

use std::fmt;

use crate::Env;

/// Validated daemon configuration.
#[derive(Debug, Clone)]
pub struct ObjectStorageDaemonConfig {
    pub bind_host: String,
    pub port: u16,
    pub root_dir: String,
    pub tls_ca_cert_path: Option<String>,
    pub tls_server_cert_path: Option<String>,
    pub tls_server_key_path: Option<String>,
    pub allowed_client_cns: Vec<String>,
    pub require_mtls: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjectStorageConfigError {
    pub code: &'static str,
    pub message: String,
}

impl fmt::Display for ObjectStorageConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ObjectStorageConfigError {}

impl ObjectStorageDaemonConfig {
    /// Load from the environment. Reproduces the override-capable TS loader shape:
    /// `require_mtls` defaults to `NODE_ENV == "production"` unless explicitly set.
    pub fn from_env(env: &Env) -> Result<Self, ObjectStorageConfigError> {
        Self::build(
            env,
            env.get_non_empty("OBJECT_STORAGE_DAEMON_TLS_CA_PATH"),
            env.get_non_empty("OBJECT_STORAGE_DAEMON_TLS_CERT_PATH"),
            env.get_non_empty("OBJECT_STORAGE_DAEMON_TLS_KEY_PATH"),
            None,
            None,
        )
    }

    /// Load with explicit overrides (tests and embedders), matching the TS function.
    pub fn from_env_with_overrides(
        env: &Env,
        tls_ca_cert_path: Option<Option<String>>,
        tls_server_cert_path: Option<Option<String>>,
        tls_server_key_path: Option<Option<String>>,
        allowed_client_cns: Option<Vec<String>>,
        require_mtls: Option<bool>,
    ) -> Result<Self, ObjectStorageConfigError> {
        let ca = match tls_ca_cert_path {
            Some(value) => value,
            None => env.get_non_empty("OBJECT_STORAGE_DAEMON_TLS_CA_PATH"),
        };
        let cert = match tls_server_cert_path {
            Some(value) => value,
            None => env.get_non_empty("OBJECT_STORAGE_DAEMON_TLS_CERT_PATH"),
        };
        let key = match tls_server_key_path {
            Some(value) => value,
            None => env.get_non_empty("OBJECT_STORAGE_DAEMON_TLS_KEY_PATH"),
        };
        Self::build(env, ca, cert, key, allowed_client_cns, require_mtls)
    }

    #[allow(clippy::too_many_arguments)]
    fn build(
        env: &Env,
        ca: Option<String>,
        cert: Option<String>,
        key: Option<String>,
        allowed_client_cns: Option<Vec<String>>,
        require_mtls_override: Option<bool>,
    ) -> Result<Self, ObjectStorageConfigError> {
        let configured = [ca.is_some(), cert.is_some(), key.is_some()];
        let any_tls = configured.iter().any(|value| *value);
        let all_tls = configured.iter().all(|value| *value);

        let explicit_require = env.get_non_empty("OBJECT_STORAGE_REQUIRE_MTLS");
        let node_env = env.get_non_empty("NODE_ENV");
        let require_mtls = match require_mtls_override {
            Some(value) => value,
            None => match explicit_require {
                Some(raw) => crate::parse_bool(&raw).ok_or_else(|| ObjectStorageConfigError {
                    code: "OBJECT_STORAGE_REQUIRE_MTLS_INVALID",
                    message: "must be one of true, 1, yes, on, false, 0, no, off".to_owned(),
                })?,
                None => node_env.as_deref() == Some("production"),
            },
        };

        if any_tls && !all_tls {
            return Err(ObjectStorageConfigError {
                code: "OBJECT_STORAGE_DAEMON_TLS_INCOMPLETE",
                message: "set all of OBJECT_STORAGE_DAEMON_TLS_CA_PATH, OBJECT_STORAGE_DAEMON_TLS_CERT_PATH and OBJECT_STORAGE_DAEMON_TLS_KEY_PATH, or none with OBJECT_STORAGE_REQUIRE_MTLS=false for local development".to_owned(),
            });
        }
        // TS: `overrides?.requireMtls !== false` guards the missing-files error, so an explicit
        // override to false is allowed without TLS files (the effective value is then false).
        let explicit_false = matches!(require_mtls_override, Some(false));
        if require_mtls && !all_tls && !explicit_false {
            return Err(ObjectStorageConfigError {
                code: "OBJECT_STORAGE_DAEMON_MTLS_REQUIRED",
                message: "the shared vault must run with mTLS; supply the CA, server certificate and server key".to_owned(),
            });
        }

        let allowed_client_cns = match allowed_client_cns {
            Some(value) => value,
            None => {
                let raw = env
                    .get_non_empty("OBJECT_STORAGE_ALLOWED_CLIENT_CNS")
                    .unwrap_or_else(|| {
                        "object-storage-client,backup-daemon,backup-client".to_owned()
                    });
                raw.split(',')
                    .map(str::trim)
                    .filter(|entry| !entry.is_empty())
                    .map(str::to_owned)
                    .collect()
            }
        };

        let port = env
            .u16("OBJECT_STORAGE_DAEMON_PORT", 4095)
            .map_err(|error| ObjectStorageConfigError {
                code: "OBJECT_STORAGE_DAEMON_PORT_INVALID",
                message: error.message,
            })?;

        Ok(Self {
            bind_host: env
                .get_non_empty("OBJECT_STORAGE_DAEMON_BIND_HOST")
                .unwrap_or_else(|| "0.0.0.0".to_owned()),
            port,
            root_dir: env
                .get_non_empty("OBJECT_STORAGE_ROOT_DIR")
                .unwrap_or_else(|| "/srv/objects".to_owned()),
            tls_ca_cert_path: ca,
            tls_server_cert_path: cert,
            tls_server_key_path: key,
            allowed_client_cns,
            require_mtls: all_tls && require_mtls,
        })
    }

    /// The TS `baseUrl` host substitution: `0.0.0.0` is reported as loopback.
    #[must_use]
    pub fn host_for_url(&self) -> &str {
        if self.bind_host == "0.0.0.0" {
            "127.0.0.1"
        } else {
            &self.bind_host
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_requires_mtls() {
        let env = Env::default().with_value("NODE_ENV", "production");
        let error = ObjectStorageDaemonConfig::from_env(&env).expect_err("mTLS required");
        assert_eq!(error.code, "OBJECT_STORAGE_DAEMON_MTLS_REQUIRED");
    }

    #[test]
    fn incomplete_tls_is_rejected() {
        let env = Env::default()
            .with_value("OBJECT_STORAGE_DAEMON_TLS_CA_PATH", "/ca.pem")
            .with_value("OBJECT_STORAGE_REQUIRE_MTLS", "false");
        let error = ObjectStorageDaemonConfig::from_env(&env).expect_err("incomplete");
        assert_eq!(error.code, "OBJECT_STORAGE_DAEMON_TLS_INCOMPLETE");
    }

    #[test]
    fn local_defaults() {
        let config = ObjectStorageDaemonConfig::from_env(&Env::default()).expect("valid");
        assert_eq!(config.port, 4095);
        assert_eq!(config.bind_host, "0.0.0.0");
        assert!(!config.require_mtls);
        assert_eq!(
            config.allowed_client_cns,
            vec!["object-storage-client", "backup-daemon", "backup-client"]
        );
    }
}

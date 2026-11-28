//! Internal mTLS material and peer-identity extraction.
//!
//! Port of `core-back/index.ts:199-251`, `core-back/api/middleware/mtlsGuard.ts` and the daemon
//! CN/SAN allow-lists (chapter 2 §1).
//!
//! TLS 1.3 minimum, client certificate required and verified against the internal CA. A missing
//! certificate file produces the legacy startup message until S-OPS-03 changes it in both
//! implementations.

#![forbid(unsafe_code)]

use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::server::WebPkiClientVerifier;
use rustls::{ClientConfig, RootCertStore, ServerConfig};
use thiserror::Error;
use x509_parser::prelude::{FromDer, X509Certificate};

#[derive(Debug, Error)]
pub enum MtlsError {
    #[error("cannot read {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("no certificates found in {path}")]
    NoCertificates { path: PathBuf },
    #[error("no private key found in {path}")]
    NoPrivateKey { path: PathBuf },
    #[error("invalid TLS configuration: {0}")]
    Rustls(String),
    #[error("Run 'bun run generate-mtls-certs' to create the internal certificates")]
    MissingCertificates,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerIdentity {
    /// Common Names from the subject, in certificate order.
    pub common_names: Vec<String>,
    /// DNS SAN entries.
    pub dns_names: Vec<String>,
    /// IP SAN entries as text.
    pub ip_addresses: Vec<String>,
    pub authorized_by_ca: bool,
}

impl PeerIdentity {
    /// First CN, like `Array.isArray(rawCn) ? rawCn[0] : rawCn`.
    #[must_use]
    pub fn primary_cn(&self) -> Option<&str> {
        self.common_names.first().map(String::as_str)
    }

    /// Core rules: authorize by CN only (first CN).
    #[must_use]
    pub fn allowed_by_cn<S: AsRef<str>>(&self, allowed: &[S]) -> bool {
        self.primary_cn()
            .is_some_and(|cn| allowed.iter().any(|entry| entry.as_ref() == cn))
    }

    /// Daemons: authorize by CN **or** DNS SAN.
    #[must_use]
    pub fn allowed_by_cn_or_san<S: AsRef<str>>(&self, allowed: &[S]) -> bool {
        let matches = |value: &str| allowed.iter().any(|entry| entry.as_ref() == value);
        self.common_names.iter().any(|cn| matches(cn))
            || self.dns_names.iter().any(|san| matches(san))
    }
}

/// Extract CN and SANs from a DER certificate.
pub fn peer_identity(cert_der: &[u8], authorized_by_ca: bool) -> Result<PeerIdentity, MtlsError> {
    let (_, certificate) = X509Certificate::from_der(cert_der)
        .map_err(|error| MtlsError::Rustls(format!("invalid peer certificate: {error}")))?;
    let common_names = certificate
        .subject()
        .iter_common_name()
        .filter_map(|attribute| attribute.as_str().ok().map(str::to_owned))
        .collect();
    let mut dns_names = Vec::new();
    let mut ip_addresses = Vec::new();
    if let Ok(Some(san)) = certificate.subject_alternative_name() {
        for name in &san.value.general_names {
            match name {
                x509_parser::extensions::GeneralName::DNSName(name) => {
                    dns_names.push((*name).to_owned());
                }
                x509_parser::extensions::GeneralName::IPAddress(bytes) => {
                    let address = match bytes.len() {
                        4 => Some(std::net::IpAddr::from([
                            bytes[0], bytes[1], bytes[2], bytes[3],
                        ])),
                        16 => {
                            let mut octets = [0_u8; 16];
                            octets.copy_from_slice(bytes);
                            Some(std::net::IpAddr::from(octets))
                        }
                        _ => None,
                    };
                    if let Some(address) = address {
                        ip_addresses.push(address.to_string());
                    }
                }
                _ => {}
            }
        }
    }
    Ok(PeerIdentity {
        common_names,
        dns_names,
        ip_addresses,
        authorized_by_ca,
    })
}

/// Peer certificate bytes as exposed by ntex's `PeerCertDer` connection metadata.
pub fn identity_from_ntex(cert_der: &[u8]) -> Result<PeerIdentity, MtlsError> {
    // Verification is performed by the rustls client verifier; reaching a handler with a peer
    // certificate therefore means the CA accepted it.
    peer_identity(cert_der, true)
}

/// Server certificate material paths.
#[derive(Debug, Clone)]
pub struct ServerTlsPaths {
    pub ca_cert: PathBuf,
    pub server_cert: PathBuf,
    pub server_key: PathBuf,
}

#[derive(Clone)]
pub struct ServerTls {
    pub config: Arc<ServerConfig>,
}

impl std::fmt::Debug for ServerTls {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ServerTls(<rustls config>)")
    }
}

/// Install the ring CryptoProvider once per process (rustls has no default provider compiled in
/// when `aws-lc-rs` is disabled; see DEV-001).
pub fn install_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

/// Build the internal server config: TLS 1.3, client certificate required and verified.
pub fn server_config(paths: &ServerTlsPaths) -> Result<ServerTls, MtlsError> {
    install_crypto_provider();
    let ca = load_certificates(&paths.ca_cert)?;
    let certs = load_certificates(&paths.server_cert)?;
    let key = load_private_key(&paths.server_key)?;
    let mut roots = RootCertStore::empty();
    for certificate in ca {
        roots
            .add(certificate)
            .map_err(|error| MtlsError::Rustls(error.to_string()))?;
    }
    if roots.is_empty() {
        return Err(MtlsError::NoCertificates {
            path: paths.ca_cert.clone(),
        });
    }
    let verifier = WebPkiClientVerifier::builder(Arc::new(roots))
        .build()
        .map_err(|error| MtlsError::Rustls(error.to_string()))?;
    let config = ServerConfig::builder_with_protocol_versions(&[&rustls::version::TLS13])
        .with_client_cert_verifier(verifier)
        .with_single_cert(certs, key)
        .map_err(|error| MtlsError::Rustls(error.to_string()))?;
    Ok(ServerTls {
        config: Arc::new(config),
    })
}

/// Client material for edge→core and daemon mTLS.
#[derive(Debug, Clone)]
pub struct ClientTlsPaths {
    pub ca_cert: PathBuf,
    pub client_cert: PathBuf,
    pub client_key: PathBuf,
}

#[derive(Clone)]
pub struct ClientTls {
    pub config: Arc<ClientConfig>,
}

impl std::fmt::Debug for ClientTls {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ClientTls(<rustls config>)")
    }
}

pub fn client_config(paths: &ClientTlsPaths) -> Result<ClientTls, MtlsError> {
    install_crypto_provider();
    let ca = load_certificates(&paths.ca_cert)?;
    let certs = load_certificates(&paths.client_cert)?;
    let key = load_private_key(&paths.client_key)?;
    let mut roots = RootCertStore::empty();
    for certificate in ca {
        roots
            .add(certificate)
            .map_err(|error| MtlsError::Rustls(error.to_string()))?;
    }
    let config = ClientConfig::builder_with_protocol_versions(&[&rustls::version::TLS13])
        .with_root_certificates(roots)
        .with_client_auth_cert(certs, key)
        .map_err(|error| MtlsError::Rustls(error.to_string()))?;
    Ok(ClientTls {
        config: Arc::new(config),
    })
}

fn load_certificates(path: &Path) -> Result<Vec<CertificateDer<'static>>, MtlsError> {
    if !path.exists() {
        return Err(MtlsError::Io {
            path: path.to_path_buf(),
            source: std::io::Error::new(std::io::ErrorKind::NotFound, "file not found"),
        });
    }
    let file = File::open(path).map_err(|source| MtlsError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    let mut reader = BufReader::new(file);
    let certs: Vec<CertificateDer<'static>> = rustls_pemfile::certs(&mut reader)
        .collect::<Result<_, _>>()
        .map_err(|source| MtlsError::Io {
            path: path.to_path_buf(),
            source,
        })?;
    if certs.is_empty() {
        return Err(MtlsError::NoCertificates {
            path: path.to_path_buf(),
        });
    }
    Ok(certs)
}

fn load_private_key(path: &Path) -> Result<PrivateKeyDer<'static>, MtlsError> {
    if !path.exists() {
        return Err(MtlsError::Io {
            path: path.to_path_buf(),
            source: std::io::Error::new(std::io::ErrorKind::NotFound, "file not found"),
        });
    }
    let file = File::open(path).map_err(|source| MtlsError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    let mut reader = BufReader::new(file);
    rustls_pemfile::private_key(&mut reader)
        .map_err(|source| MtlsError::Io {
            path: path.to_path_buf(),
            source,
        })?
        .ok_or_else(|| MtlsError::NoPrivateKey {
            path: path.to_path_buf(),
        })
}

/// Core channel CN table (chapter 2 §1).
#[must_use]
pub fn allowed_channel_cns(path: &str) -> Option<&'static [&'static str]> {
    if path.starts_with("/internal/sandbox") {
        Some(&["merchant-back", "admin-back"])
    } else if path.starts_with("/internal/admin") {
        Some(&["admin-back"])
    } else if path.starts_with("/internal/merchant") {
        Some(&["merchant-back"])
    } else if path.starts_with("/internal/checkout") {
        Some(&["checkout-back"])
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_table_matches_contract() {
        assert_eq!(
            allowed_channel_cns("/internal/sandbox/whatever"),
            Some(&["merchant-back", "admin-back"][..])
        );
        assert_eq!(
            allowed_channel_cns("/internal/admin/merchants"),
            Some(&["admin-back"][..])
        );
        assert_eq!(allowed_channel_cns("/health"), None);
    }

    #[test]
    fn cn_and_san_rules() {
        let identity = PeerIdentity {
            common_names: vec!["backup-daemon".to_owned()],
            dns_names: vec!["object-storage-client".to_owned()],
            ip_addresses: vec![],
            authorized_by_ca: true,
        };
        assert!(identity.allowed_by_cn(&["backup-daemon"]));
        assert!(!identity.allowed_by_cn(&["object-storage-client"]));
        assert!(identity.allowed_by_cn_or_san(&["object-storage-client"]));
    }
}

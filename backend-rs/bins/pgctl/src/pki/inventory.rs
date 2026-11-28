//! Certificate inspection, the deterministic inventory and chain verification.
//!
//! The inventory is a pure function of the files in the PKI directory: entries are sorted by
//! name, arrays are sorted, and no timestamp is recorded, so two runs over the same files produce
//! byte-identical JSON. `renew` and `pki init --rotate` rebuild their specs from it (falling back
//! to the certificates themselves when the file is missing or stale).

use std::net::IpAddr;
use std::path::Path;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use x509_parser::certificate::X509Certificate;
use x509_parser::extensions::GeneralName;
use x509_parser::prelude::FromDer;

use sha2::{Digest, Sha256};

use crate::util;

use super::catalog::{CertKind, CertificateSpec};
use super::issue::{
    PkiPaths, CA_CHAIN_FILE, CRL_FILE, INTERMEDIATE_CERT_FILE, INTERMEDIATE_KEY_FILE,
    INVENTORY_FILE, REVOCATION_FILE, ROOT_CERT_FILE, ROOT_KEY_FILE,
};
use super::timeutil::{days_until, format_unix_rfc3339};

/// Inventory schema version.
pub const INVENTORY_VERSION: u32 = 1;

/// The parsed identity of one certificate file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CertificateStatus {
    /// Subject common name (first CN).
    pub common_name: String,
    /// Lowercase hex serial.
    pub serial: String,
    /// Lowercase hex SHA-256 of the DER certificate.
    pub fingerprint_sha256: String,
    /// Validity start (Unix seconds).
    pub not_before_unix: i64,
    /// Validity end (Unix seconds).
    pub not_after_unix: i64,
    /// DNS SANs.
    pub dns_sans: Vec<String>,
    /// IP SANs as text.
    pub ip_sans: Vec<String>,
    /// `id-kp-serverAuth`.
    pub eku_server: bool,
    /// `id-kp-clientAuth`.
    pub eku_client: bool,
    /// `basicConstraints CA:TRUE`.
    pub is_ca: bool,
    /// DER of the parsed certificate.
    pub der: Vec<u8>,
}

impl CertificateStatus {
    /// Whole days until expiry relative to `now`.
    #[must_use]
    pub fn days_remaining(&self, now: i64) -> i64 {
        days_until(self.not_after_unix, now)
    }

    /// Verify the signature against an issuer certificate.
    pub fn verify_signed_by(&self, issuer: &Self) -> Result<(), String> {
        let (_, leaf) = X509Certificate::from_der(&self.der)
            .map_err(|error| format!("cannot parse certificate: {error}"))?;
        let (_, authority) = X509Certificate::from_der(&issuer.der)
            .map_err(|error| format!("cannot parse issuer certificate: {error}"))?;
        leaf.verify_signature(Some(authority.public_key()))
            .map_err(|error| format!("signature verification failed: {error}"))
    }

    /// Kind inferred from `basicConstraints` and EKU.
    #[must_use]
    pub fn inferred_kind(&self) -> CertKind {
        if self.is_ca {
            CertKind::Ca
        } else if self.eku_server && self.eku_client {
            CertKind::ServerClient
        } else if self.eku_server {
            CertKind::Server
        } else {
            CertKind::Client
        }
    }
}

/// One certificate row of the inventory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InventoryEntry {
    /// File stem.
    pub name: String,
    /// Usage.
    pub kind: CertKind,
    /// Roles (`core`, `edge`, `postgres`, `client`, `server`, ...).
    pub roles: Vec<String>,
    /// Subject CN.
    pub cn: String,
    /// Lowercase hex serial.
    pub serial: String,
    /// Lowercase hex SHA-256 of the DER certificate.
    pub fingerprint_sha256: String,
    /// RFC 3339 validity start.
    pub not_before: String,
    /// RFC 3339 validity end.
    pub not_after: String,
    /// Requested lifetime in days (used by `renew`/`rotate`).
    pub days: u16,
    /// DNS SANs.
    pub dns_sans: Vec<String>,
    /// IP SANs.
    pub ip_sans: Vec<String>,
    /// Certificate file name relative to the PKI directory.
    pub cert_file: String,
    /// Private key file name, when present.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_file: Option<String>,
    /// Certificate mode as an octal string (`0644`).
    pub cert_mode: String,
    /// Private key mode as an octal string (`0600`), when present.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_mode: Option<String>,
    /// Whether the serial is on the revocation list.
    pub revoked: bool,
}

/// The inventory document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Inventory {
    /// Schema version.
    pub version: u32,
    /// Certificates sorted by name.
    pub certificates: Vec<InventoryEntry>,
}

impl Inventory {
    /// A leaf entry by name.
    #[must_use]
    pub fn entry(&self, name: &str) -> Option<&InventoryEntry> {
        self.certificates.iter().find(|entry| entry.name == name)
    }

    /// One spec per leaf, including revoked ones (verification must still see and report them).
    #[must_use]
    pub fn all_leaf_specs(&self) -> Vec<CertificateSpec> {
        self.certificates
            .iter()
            .filter(|entry| entry.kind != CertKind::Ca)
            .filter_map(spec_of)
            .collect()
    }

    /// One spec per non-revoked leaf, ready for `renew` or `rotate`.
    #[must_use]
    pub fn leaf_specs(&self) -> Vec<CertificateSpec> {
        self.certificates
            .iter()
            .filter(|entry| entry.kind != CertKind::Ca && !entry.revoked)
            .filter_map(spec_of)
            .collect()
    }
}

fn spec_of(entry: &InventoryEntry) -> Option<CertificateSpec> {
    let mut spec = CertificateSpec::new(
        entry.name.clone(),
        entry.cn.clone(),
        entry.kind,
        entry.days.max(1),
    );
    spec.dns_sans = entry.dns_sans.clone();
    spec.ip_sans = entry.ip_sans.clone();
    spec.roles = entry.roles.clone();
    spec.normalize().ok().map(|()| spec)
}

/// Parse the first PEM certificate in `data` (chain files contain the leaf first).
pub fn parse_first_certificate(data: &[u8]) -> Result<CertificateStatus> {
    let pem = x509_parser::pem::parse_x509_pem(data)
        .map_err(|error| anyhow::anyhow!("no PEM certificate found: {error}"))?
        .1;
    parse_der(&pem.contents)
}

/// Parse a DER certificate.
pub fn parse_der(data: &[u8]) -> Result<CertificateStatus> {
    let (_, certificate) = X509Certificate::from_der(data)
        .map_err(|error| anyhow::anyhow!("invalid certificate: {error}"))?;
    let common_name = certificate
        .subject()
        .iter_common_name()
        .filter_map(|attribute| attribute.as_str().ok())
        .next()
        .unwrap_or_default()
        .to_owned();
    let mut dns_sans = Vec::new();
    let mut ip_sans = Vec::new();
    if let Ok(Some(san)) = certificate.subject_alternative_name() {
        for name in &san.value.general_names {
            match name {
                GeneralName::DNSName(name) => dns_sans.push((*name).to_owned()),
                GeneralName::IPAddress(bytes) => {
                    let text = match bytes.len() {
                        4 => Some(IpAddr::from([bytes[0], bytes[1], bytes[2], bytes[3]])),
                        16 => {
                            let mut octets = [0_u8; 16];
                            octets.copy_from_slice(bytes);
                            Some(IpAddr::from(octets))
                        }
                        _ => None,
                    };
                    if let Some(address) = text {
                        ip_sans.push(address.to_string());
                    }
                }
                _ => {}
            }
        }
    }
    dns_sans.sort();
    dns_sans.dedup();
    ip_sans.sort();
    ip_sans.dedup();

    let eku = certificate.extended_key_usage().ok().flatten();
    let (eku_server, eku_client) = eku.map_or((false, false), |value| {
        (
            value.value.server_auth || value.value.any,
            value.value.client_auth || value.value.any,
        )
    });
    let is_ca = certificate
        .basic_constraints()
        .ok()
        .flatten()
        .is_some_and(|constraints| constraints.value.ca);

    // `raw_serial` is the DER INTEGER content and can carry a leading 0x00 used to keep the
    // number positive. The inventory and the revocation list use the minimal big-endian form.
    let mut serial_bytes = certificate.raw_serial();
    while serial_bytes.len() > 1 && serial_bytes[0] == 0 {
        serial_bytes = &serial_bytes[1..];
    }

    Ok(CertificateStatus {
        common_name,
        serial: super::timeutil::serial_hex(serial_bytes),
        fingerprint_sha256: hex_sha256(&certificate),
        not_before_unix: certificate.validity().not_before.timestamp(),
        not_after_unix: certificate.validity().not_after.timestamp(),
        dns_sans,
        ip_sans,
        eku_server,
        eku_client,
        is_ca,
        der: data.to_vec(),
    })
}

fn hex_sha256(certificate: &X509Certificate<'_>) -> String {
    let digest = Sha256::digest(certificate.as_ref());
    super::timeutil::serial_hex(&digest)
}

/// Inspect a certificate file, following the first PEM block of a chain.
pub fn inspect_certificate_file(path: &Path, name: &str) -> Result<CertificateStatus> {
    let data = std::fs::read(path)
        .with_context(|| format!("cannot read certificate '{name}' at {}", path.display()))?;
    parse_first_certificate(&data)
}

/// Build an inventory entry from a parsed certificate and the spec it was issued for.
#[must_use]
pub fn entry_from_status(status: &CertificateStatus, spec: &CertificateSpec) -> InventoryEntry {
    InventoryEntry {
        name: spec.name.clone(),
        kind: spec.kind,
        roles: spec.roles.clone(),
        cn: status.common_name.clone(),
        serial: status.serial.clone(),
        fingerprint_sha256: status.fingerprint_sha256.clone(),
        not_before: format_unix_rfc3339(status.not_before_unix),
        not_after: format_unix_rfc3339(status.not_after_unix),
        days: spec.days.max(1),
        dns_sans: status.dns_sans.clone(),
        ip_sans: status.ip_sans.clone(),
        cert_file: format!("{}.crt", spec.name),
        key_file: None,
        cert_mode: String::new(),
        key_mode: None,
        revoked: false,
    }
}

/// Read `inventory.json`, when it exists and parses.
pub fn read_inventory(paths: &PkiPaths) -> Result<Option<Inventory>> {
    let path = paths.inventory();
    if !path.is_file() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path)
        .with_context(|| format!("cannot read inventory {}", path.display()))?;
    let inventory: Inventory = serde_json::from_str(&text)
        .with_context(|| format!("invalid inventory JSON in {}", path.display()))?;
    Ok(Some(inventory))
}

/// Write the inventory atomically.
pub fn write_inventory(paths: &PkiPaths, inventory: &Inventory) -> Result<()> {
    let text = util::json_pretty(inventory).context("cannot serialise the inventory")?;
    util::write_atomic(&paths.inventory(), text.as_bytes(), 0o644)
        .with_context(|| format!("cannot write {}", paths.inventory().display()))
}

#[cfg(unix)]
fn mode_of(path: &Path) -> String {
    use std::os::unix::fs::PermissionsExt;
    match std::fs::metadata(path) {
        Ok(metadata) => format!("{:04o}", metadata.permissions().mode() & 0o777),
        Err(_) => String::new(),
    }
}

#[cfg(not(unix))]
fn mode_of(path: &Path) -> String {
    let _ = path;
    String::new()
}

/// File stem of a certificate file, when it is a leaf candidate.
fn leaf_stem(name: &str) -> Option<&str> {
    let stem = name.strip_suffix(".crt")?;
    if [
        ROOT_CERT_FILE.trim_end_matches(".crt"),
        INTERMEDIATE_CERT_FILE.trim_end_matches(".crt"),
        CA_CHAIN_FILE.trim_end_matches(".crt"),
        CRL_FILE.trim_end_matches(".pem"),
    ]
    .contains(&stem)
        || name == INVENTORY_FILE
        || name == REVOCATION_FILE
    {
        return None;
    }
    Some(stem)
}

/// Rebuild the specs of every leaf certificate actually present in the directory.
///
/// Metadata (roles, requested days) comes from `fallback` when it has a matching entry; otherwise
/// it is inferred from the certificate and its name.
#[must_use]
pub fn scan_leaf_specs(paths: &PkiPaths, fallback: Option<&Inventory>) -> Vec<CertificateSpec> {
    let mut specs = Vec::new();
    let Ok(entries) = std::fs::read_dir(paths.dir()) else {
        return specs;
    };
    let mut paths_and_names: Vec<(String, std::path::PathBuf)> = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let stem = leaf_stem(&name)?.to_owned();
            Some((stem, entry.path()))
        })
        .collect();
    paths_and_names.sort_by(|left, right| left.0.cmp(&right.0));
    for (stem, path) in paths_and_names {
        let Ok(status) = inspect_certificate_file(&path, &stem) else {
            continue;
        };
        if status.is_ca {
            continue;
        }
        let known = fallback.and_then(|inventory| inventory.entry(&stem));
        let kind = status.inferred_kind();
        let roles = known
            .map(|entry| entry.roles.clone())
            .unwrap_or_else(|| infer_roles(&stem, kind));
        let validity_days = ((status.not_after_unix - status.not_before_unix)
            / super::timeutil::DAY_SECONDS)
            .clamp(1, i64::from(u16::MAX)) as u16;
        let mut spec = CertificateSpec::new(
            stem,
            status.common_name.clone(),
            kind,
            known.map_or(validity_days, |entry| entry.days.max(1)),
        );
        spec.dns_sans = status.dns_sans.clone();
        spec.ip_sans = status.ip_sans.clone();
        spec.roles = roles;
        if spec.normalize().is_ok() {
            specs.push(spec);
        }
    }
    specs
}

fn infer_roles(name: &str, kind: CertKind) -> Vec<String> {
    let mut roles = vec![kind.as_str().to_owned()];
    let add = |roles: &mut Vec<String>, role: &str| {
        if !roles.iter().any(|entry| entry == role) {
            roles.push(role.to_owned());
        }
    };
    if name == "core-back" {
        add(&mut roles, "core");
        add(&mut roles, "server");
    } else if name.starts_with("admin-back-client") {
        add(&mut roles, "admin");
        add(&mut roles, "edge");
        add(&mut roles, "client");
    } else if name.starts_with("merchant-back-client") {
        add(&mut roles, "merchant");
        add(&mut roles, "edge");
        add(&mut roles, "client");
    } else if name.starts_with("checkout-back-client") {
        add(&mut roles, "checkout");
        add(&mut roles, "edge");
        add(&mut roles, "client");
    } else if name == "fake-rails" || name == "fake-rails-client" {
        add(&mut roles, "fake-rails");
    } else if name == "backup-daemon" || name.starts_with("backup-") || name == "wal-archive-client"
    {
        add(&mut roles, "backup");
    } else if name.starts_with("object-storage") {
        add(&mut roles, "object-storage");
    } else if name.starts_with("postgres-") || name.contains("-db-client") || name == "pg-client" {
        add(&mut roles, "postgres");
        add(&mut roles, "storage");
    } else if name.starts_with("pgbouncer-") {
        add(&mut roles, "pgbouncer");
    } else if name.starts_with("redis") {
        add(&mut roles, "redis");
        add(&mut roles, "storage");
    }
    roles.sort();
    roles.dedup();
    roles
}

/// Build the inventory from the files on disk.
///
/// `revoked` is the set of revoked serials, so `revoked` flags stay in sync with the list.
pub fn build_inventory(
    paths: &PkiPaths,
    fallback: Option<&Inventory>,
    revoked: &[String],
) -> Result<Inventory> {
    let mut entries = Vec::new();
    for (name, file, roles, key_file) in [
        (
            ROOT_CERT_FILE.trim_end_matches(".crt"),
            ROOT_CERT_FILE,
            vec!["ca".to_owned(), "root".to_owned()],
            Some(ROOT_KEY_FILE),
        ),
        (
            INTERMEDIATE_CERT_FILE.trim_end_matches(".crt"),
            INTERMEDIATE_CERT_FILE,
            vec!["ca".to_owned(), "intermediate".to_owned()],
            Some(INTERMEDIATE_KEY_FILE),
        ),
    ] {
        let cert_path = paths.dir().join(file);
        if !cert_path.is_file() {
            continue;
        }
        let status = inspect_certificate_file(&cert_path, name)?;
        let cert_mode = mode_of(&cert_path);
        let key_path = key_file.map(|key| paths.dir().join(key));
        let key_mode = key_path
            .as_deref()
            .filter(|path| path.is_file())
            .map(mode_of);
        let validity_days = ((status.not_after_unix - status.not_before_unix)
            / super::timeutil::DAY_SECONDS)
            .clamp(1, i64::from(u16::MAX)) as u16;
        entries.push(InventoryEntry {
            name: name.to_owned(),
            kind: CertKind::Ca,
            roles,
            cn: status.common_name.clone(),
            serial: status.serial.clone(),
            fingerprint_sha256: status.fingerprint_sha256.clone(),
            not_before: format_unix_rfc3339(status.not_before_unix),
            not_after: format_unix_rfc3339(status.not_after_unix),
            days: validity_days,
            dns_sans: status.dns_sans.clone(),
            ip_sans: status.ip_sans.clone(),
            cert_file: file.to_owned(),
            key_file: key_file.map(str::to_owned),
            cert_mode,
            key_mode,
            revoked: revoked.iter().any(|serial| serial == &status.serial),
        });
    }

    for spec in scan_leaf_specs(paths, fallback) {
        let cert_path = paths.cert_path(&spec.name);
        let status = inspect_certificate_file(&cert_path, &spec.name)?;
        let cert_mode = mode_of(&cert_path);
        let key_path = paths.key_path(&spec.name);
        let key_mode = key_path.is_file().then(|| mode_of(&key_path));
        let mut entry = entry_from_status(&status, &spec);
        entry.cert_mode = cert_mode;
        entry.key_file = key_path.is_file().then(|| format!("{}.key", spec.name));
        entry.key_mode = key_mode;
        entry.revoked = revoked.iter().any(|serial| serial == &status.serial);
        entries.push(entry);
    }

    entries.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then_with(|| left.cert_file.cmp(&right.cert_file))
    });
    Ok(Inventory {
        version: INVENTORY_VERSION,
        certificates: entries,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pki::catalog::CertificateSpec;
    use crate::pki::issue::{create_ca, issue_leaf, load_ca, CaOptions};

    fn temp_paths(tag: &str) -> PkiPaths {
        let dir = std::env::temp_dir().join(format!(
            "pgctl-inv-{}-{}-{tag}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or_default()
        ));
        PkiPaths::new(dir)
    }

    #[test]
    fn inventory_is_deterministic_and_ordered() {
        let paths = temp_paths("deterministic");
        let now = 1_800_000_000;
        create_ca(&paths, CaOptions::default(), now).expect("ca");
        let ca = load_ca(&paths).expect("ca");
        let mut core =
            CertificateSpec::new("core-back", "core-back.internal", CertKind::Server, 90);
        core.dns_sans = vec!["core-back.internal".to_owned()];
        core.ip_sans = vec!["127.0.0.1".to_owned()];
        core.normalize().expect("spec");
        issue_leaf(&paths, &ca, &core, now, true, 0).expect("core");
        issue_leaf(
            &paths,
            &ca,
            &CertificateSpec::new("admin-back-client", "admin-back", CertKind::Client, 90),
            now,
            true,
            0,
        )
        .expect("edge");

        let first = build_inventory(&paths, None, &[]).expect("inventory");
        let second = build_inventory(&paths, None, &[]).expect("inventory");
        assert_eq!(
            util::json_pretty(&first).expect("json"),
            util::json_pretty(&second).expect("json")
        );
        let names: Vec<&str> = first
            .certificates
            .iter()
            .map(|entry| entry.name.as_str())
            .collect();
        assert!(
            names.windows(2).all(|window| window[0] <= window[1]),
            "{names:?}"
        );
        assert!(first.entry("core-back").is_some());
        let core = first.entry("core-back").expect("core");
        assert_eq!(core.serial.len(), 32);
        assert_eq!(core.fingerprint_sha256.len(), 64);
        assert!(core.not_after.ends_with('Z'));
        assert!(core.roles.contains(&"core".to_owned()));
        assert_eq!(core.cert_mode, "0644");
        assert_eq!(core.key_mode.as_deref(), Some("0600"));
        assert!(first.entry("internal-ca").is_some());
        assert!(first.entry("intermediate-ca").is_some());

        let _ = std::fs::remove_dir_all(paths.dir());
    }

    #[test]
    fn scan_infers_specs_without_an_inventory() {
        let paths = temp_paths("scan");
        let now = 1_800_000_000;
        create_ca(&paths, CaOptions::default(), now).expect("ca");
        let ca = load_ca(&paths).expect("ca");
        let mut spec = CertificateSpec::new("postgres-db-1", "db-1", CertKind::Server, 90);
        spec.dns_sans = vec!["db-1".to_owned()];
        spec.ip_sans = vec!["10.0.0.21".to_owned()];
        spec.normalize().expect("spec");
        issue_leaf(&paths, &ca, &spec, now, true, 0).expect("issue");
        let specs = scan_leaf_specs(&paths, None);
        let found = specs
            .iter()
            .find(|entry| entry.name == "postgres-db-1")
            .expect("scanned");
        assert_eq!(found.kind, CertKind::Server);
        assert_eq!(found.cn, "db-1");
        assert!(found.ip_sans.contains(&"10.0.0.21".to_owned()));
        assert!(found.days >= 90);
        assert!(found.roles.contains(&"postgres".to_owned()));
        let _ = std::fs::remove_dir_all(paths.dir());
    }

    #[test]
    fn revoked_serials_are_flagged() {
        let paths = temp_paths("revoked-flag");
        let now = 1_800_000_000;
        create_ca(&paths, CaOptions::default(), now).expect("ca");
        let ca = load_ca(&paths).expect("ca");
        issue_leaf(
            &paths,
            &ca,
            &CertificateSpec::new("client", "client", CertKind::Client, 30),
            now,
            true,
            0,
        )
        .expect("issue");
        let status =
            inspect_certificate_file(&paths.cert_path("client"), "client").expect("inspect");
        let inventory = build_inventory(&paths, None, &[status.serial]).expect("inventory");
        assert!(inventory.entry("client").expect("client").revoked);
        let _ = std::fs::remove_dir_all(paths.dir());
    }

    #[test]
    fn chain_verification_rejects_a_foreign_signer() {
        let first = temp_paths("verify-first");
        let second = temp_paths("verify-second");
        let now = 1_800_000_000;
        create_ca(&first, CaOptions::default(), now).expect("ca");
        create_ca(&second, CaOptions::default(), now).expect("ca");
        let ca = load_ca(&second).expect("ca");
        issue_leaf(
            &first,
            &ca,
            &CertificateSpec::new("x", "x", CertKind::Client, 30),
            now,
            true,
            0,
        )
        .expect("issue");
        let leaf = inspect_certificate_file(&first.cert_path("x"), "x").expect("leaf");
        let signer =
            inspect_certificate_file(&second.intermediate_cert(), "intermediate").expect("ca");
        assert!(leaf.verify_signed_by(&signer).is_ok());
        let foreign =
            inspect_certificate_file(&first.intermediate_cert(), "intermediate").expect("ca");
        assert!(leaf.verify_signed_by(&foreign).is_err());
        let _ = std::fs::remove_dir_all(first.dir());
        let _ = std::fs::remove_dir_all(second.dir());
    }
}

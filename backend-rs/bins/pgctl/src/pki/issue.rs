//! In-process issuance: root CA, per-environment intermediate CA and ECDSA P-256 leaves.
//!
//! No openssl binary is needed on the operator workstation (chapter 7 §6). Private keys are
//! written atomically with mode 0600; certificates and the CA chain with 0644.
//!
//! Bundle layout inside the PKI directory:
//!
//! | file | content |
//! | :--- | :--- |
//! | `internal-ca.crt` | root CA only (trust anchor; the name the TypeScript bundle used) |
//! | `internal-ca.key` | root CA key (0600; export to offline storage and remove) |
//! | `intermediate-ca.crt` | per-environment intermediate CA |
//! | `intermediate-ca.key` | intermediate CA key (0600) |
//! | `ca-chain.crt` | root + intermediate (for `ssl_ca_file` / `sslrootcert`) |
//! | `<name>.crt` | leaf **followed by** the intermediate, so a root-only trust store verifies it |
//! | `<name>.key` | leaf key (0600) |
//! | `inventory.json` | deterministic certificate inventory |
//! | `revoked.json` | documented revocation list (also the CRL source) |
//! | `crl.pem` | signed CRL for PostgreSQL `ssl_crl_file` and the Rust daemons |

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use rcgen::{
    date_time_ymd, BasicConstraints, CertificateParams, DistinguishedName, DnType,
    ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair, KeyUsagePurpose, SerialNumber,
};
use sha2::{Digest, Sha256};

use crate::util;

use super::catalog::{CertKind, CertificateSpec};
use super::inventory::{self, InventoryEntry};
use super::timeutil::{days_until, ymd_from_unix, DAY_SECONDS};

/// `date_time_ymd` for the day `days` days after `now`. A macro because the `time::OffsetDateTime`
/// return type is intentionally not a direct dependency of this crate.
macro_rules! date_at {
    ($now:expr, $days:expr) => {{
        let (year, month, day) =
            ymd_from_unix($now.saturating_add(i64::from($days).saturating_mul(DAY_SECONDS)));
        date_time_ymd(year, month, day)
    }};
}

/// Root CA certificate file name (the trust anchor).
pub const ROOT_CERT_FILE: &str = "internal-ca.crt";
/// Root CA private key file name.
pub const ROOT_KEY_FILE: &str = "internal-ca.key";
/// Intermediate CA certificate file name.
pub const INTERMEDIATE_CERT_FILE: &str = "intermediate-ca.crt";
/// Intermediate CA private key file name.
pub const INTERMEDIATE_KEY_FILE: &str = "intermediate-ca.key";
/// Root + intermediate bundle.
pub const CA_CHAIN_FILE: &str = "ca-chain.crt";
/// Deterministic certificate inventory.
pub const INVENTORY_FILE: &str = "inventory.json";
/// Documented revocation list.
pub const REVOCATION_FILE: &str = "revoked.json";
/// Signed certificate revocation list.
pub const CRL_FILE: &str = "crl.pem";

/// Default root CA lifetime (10 years, chapter 7 §6).
pub const DEFAULT_ROOT_DAYS: u16 = 3_650;
/// Default intermediate CA lifetime (3 years).
pub const DEFAULT_INTERMEDIATE_DAYS: u16 = 1_095;
/// Default leaf lifetime (90 days).
pub const DEFAULT_LEAF_DAYS: u16 = 90;

/// Root common name.
pub const ROOT_CN: &str = "Payment Gateway Internal Root CA";
/// Intermediate common name.
pub const INTERMEDIATE_CN: &str = "Payment Gateway Internal Intermediate CA";

/// The files of one PKI directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PkiPaths {
    dir: PathBuf,
}

impl PkiPaths {
    /// Point at a PKI directory.
    #[must_use]
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    /// The directory.
    #[must_use]
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Root CA certificate.
    #[must_use]
    pub fn root_cert(&self) -> PathBuf {
        self.dir.join(ROOT_CERT_FILE)
    }

    /// Root CA key.
    #[must_use]
    pub fn root_key(&self) -> PathBuf {
        self.dir.join(ROOT_KEY_FILE)
    }

    /// Intermediate CA certificate.
    #[must_use]
    pub fn intermediate_cert(&self) -> PathBuf {
        self.dir.join(INTERMEDIATE_CERT_FILE)
    }

    /// Intermediate CA key.
    #[must_use]
    pub fn intermediate_key(&self) -> PathBuf {
        self.dir.join(INTERMEDIATE_KEY_FILE)
    }

    /// Root + intermediate bundle.
    #[must_use]
    pub fn chain(&self) -> PathBuf {
        self.dir.join(CA_CHAIN_FILE)
    }

    /// Inventory JSON.
    #[must_use]
    pub fn inventory(&self) -> PathBuf {
        self.dir.join(INVENTORY_FILE)
    }

    /// Revocation list JSON.
    #[must_use]
    pub fn revocation_list(&self) -> PathBuf {
        self.dir.join(REVOCATION_FILE)
    }

    /// Signed CRL.
    #[must_use]
    pub fn crl(&self) -> PathBuf {
        self.dir.join(CRL_FILE)
    }

    /// Leaf certificate path.
    #[must_use]
    pub fn cert_path(&self, name: &str) -> PathBuf {
        self.dir.join(format!("{name}.crt"))
    }

    /// Leaf key path.
    #[must_use]
    pub fn key_path(&self, name: &str) -> PathBuf {
        self.dir.join(format!("{name}.key"))
    }

    /// Create the directory with mode 0700. Returns whether it was created.
    ///
    /// An existing **empty** directory is tightened to 0700 (the operator pointed pgctl at it); a
    /// directory that already holds files is left alone, so pointing at a populated directory by
    /// mistake never changes its permissions, and `pki verify` reports the mode.
    pub fn ensure_dir(&self) -> Result<bool> {
        let created = !self.dir.exists();
        std::fs::create_dir_all(&self.dir)
            .with_context(|| format!("cannot create PKI directory {}", self.dir.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let empty = std::fs::read_dir(&self.dir)
                .map(|mut entries| entries.next().is_none())
                .unwrap_or(false);
            if created || empty {
                std::fs::set_permissions(&self.dir, std::fs::Permissions::from_mode(0o700))
                    .with_context(|| format!("cannot chmod {}", self.dir.display()))?;
            }
        }
        Ok(created)
    }

    /// Whether the complete CA (root and intermediate) is present.
    #[must_use]
    pub fn ca_exists(&self) -> bool {
        self.root_cert().is_file()
            && self.root_key().is_file()
            && self.intermediate_cert().is_file()
            && self.intermediate_key().is_file()
            && self.chain().is_file()
    }
}

/// The CA material used to sign leaves. The root is validated on load; only the intermediate is
/// needed afterwards (rotation builds a complete new CA in a staging directory).
#[derive(Debug, Clone)]
pub struct LoadedCa {
    /// Intermediate CA PEM.
    pub intermediate_pem: String,
    /// Intermediate CA key PEM.
    pub intermediate_key_pem: String,
}

/// Load and sanity-check the CA files.
pub fn load_ca(paths: &PkiPaths) -> Result<LoadedCa> {
    let read = |path: &Path, label: &str| -> Result<String> {
        std::fs::read_to_string(path).with_context(|| {
            format!(
                "cannot read {label} {} (run 'pgctl pki init')",
                path.display()
            )
        })
    };
    let root_pem = read(&paths.root_cert(), "root CA certificate")?;
    let root_key_pem = read(&paths.root_key(), "root CA key")?;
    let intermediate_pem = read(&paths.intermediate_cert(), "intermediate CA certificate")?;
    let intermediate_key_pem = read(&paths.intermediate_key(), "intermediate CA key")?;
    inventory::parse_first_certificate(root_pem.as_bytes())
        .context("the root CA certificate cannot be parsed")?;
    inventory::parse_first_certificate(intermediate_pem.as_bytes())
        .context("the intermediate CA certificate cannot be parsed")?;
    // Fail now, not halfway through a batch, when a CA key cannot be loaded.
    KeyPair::from_pem(&root_key_pem).context("the root CA key cannot be loaded")?;
    KeyPair::from_pem(&intermediate_key_pem).context("the intermediate CA key cannot be loaded")?;
    Ok(LoadedCa {
        intermediate_pem,
        intermediate_key_pem,
    })
}

/// Root CA lifetime options.
#[derive(Debug, Clone, Copy)]
pub struct CaOptions {
    /// Root CA lifetime in days.
    pub root_days: u16,
    /// Intermediate CA lifetime in days.
    pub intermediate_days: u16,
}

impl Default for CaOptions {
    fn default() -> Self {
        Self {
            root_days: DEFAULT_ROOT_DAYS,
            intermediate_days: DEFAULT_INTERMEDIATE_DAYS,
        }
    }
}

/// Create the root and intermediate CA and the chain bundle.
///
/// Refuses to overwrite an existing CA: rotation is an explicit `pgctl pki init --rotate` because
/// every leaf is invalidated by it.
pub fn create_ca(paths: &PkiPaths, options: CaOptions, now: i64) -> Result<()> {
    paths.ensure_dir()?;
    if paths.root_cert().exists() || paths.intermediate_cert().exists() {
        bail!(
            "a CA already exists in {}; use 'pgctl pki init --rotate' to replace it and re-issue every leaf",
            paths.dir().display()
        );
    }

    let root_key = KeyPair::generate().context("cannot generate the root CA key")?;
    let root = ca_params(ROOT_CN, "root", options.root_days, 1, now, &root_key)?;
    let root_cert = root
        .self_signed(&root_key)
        .context("cannot self-sign the root CA certificate")?;

    let intermediate_key =
        KeyPair::generate().context("cannot generate the intermediate CA key")?;
    let intermediate = ca_params(
        INTERMEDIATE_CN,
        "intermediate",
        options.intermediate_days,
        0,
        now,
        &intermediate_key,
    )?;
    let root_issuer = Issuer::from_params(&root, &root_key);
    let intermediate_cert = intermediate
        .signed_by(&intermediate_key, &root_issuer)
        .context("cannot sign the intermediate CA certificate")?;

    let root_pem = root_cert.pem();
    let intermediate_pem = intermediate_cert.pem();
    util::write_atomic(
        &paths.root_key(),
        root_key.serialize_pem().as_bytes(),
        0o600,
    )
    .context("cannot write the root CA key")?;
    util::write_atomic(&paths.root_cert(), root_pem.as_bytes(), 0o644)
        .context("cannot write the root CA certificate")?;
    util::write_atomic(
        &paths.intermediate_key(),
        intermediate_key.serialize_pem().as_bytes(),
        0o600,
    )
    .context("cannot write the intermediate CA key")?;
    util::write_atomic(
        &paths.intermediate_cert(),
        intermediate_pem.as_bytes(),
        0o644,
    )
    .context("cannot write the intermediate CA certificate")?;
    util::write_atomic(
        &paths.chain(),
        format!("{root_pem}{intermediate_pem}").as_bytes(),
        0o644,
    )
    .context("cannot write the CA chain")?;
    Ok(())
}

fn ca_params(
    common_name: &str,
    ou: &str,
    days: u16,
    path_len: u8,
    now: i64,
    key: &KeyPair,
) -> Result<CertificateParams> {
    let issuer_serial = serial_for(common_name, common_name, key, 0);
    let mut params = CertificateParams::default();
    params.distinguished_name = distinguished_name(common_name, ou);
    params.is_ca = IsCa::Ca(BasicConstraints::Constrained(path_len));
    params.key_usages = vec![
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::CrlSign,
        KeyUsagePurpose::DigitalSignature,
    ];
    params.subject_alt_names = Vec::new();
    params.not_before = date_at!(now, -1);
    params.not_after = date_at!(now, days);
    params.serial_number = Some(issuer_serial);
    params.use_authority_key_identifier_extension = true;
    Ok(params)
}

fn distinguished_name(common_name: &str, ou: &str) -> DistinguishedName {
    let mut name = DistinguishedName::new();
    name.push(DnType::CommonName, common_name);
    name.push(DnType::OrganizationName, "Payment Gateway");
    name.push(DnType::OrganizationalUnitName, ou);
    name
}

/// The serial is a deterministic function of the fresh public key, the identity and the expiry.
/// Every issuance generates a new key, so the serial is unique in practice, and unlike a random
/// serial it can be re-derived from the certificate for debugging.
fn serial_for(name: &str, cn: &str, key: &KeyPair, not_after_unix: i64) -> SerialNumber {
    let mut hasher = Sha256::new();
    hasher.update(name.as_bytes());
    hasher.update([0]);
    hasher.update(cn.as_bytes());
    hasher.update([0]);
    hasher.update(key.public_key_raw());
    hasher.update(not_after_unix.to_be_bytes());
    let digest = hasher.finalize();
    SerialNumber::from_slice(&digest[..16])
}

/// A freshly issued leaf, ready for the inventory.
#[derive(Debug, Clone)]
pub struct IssuedLeaf {
    /// Inventory entry with the parsed certificate.
    pub entry: InventoryEntry,
    /// Whether bytes were written (false when an existing valid certificate was kept).
    pub written: bool,
}

/// Issue one leaf. Overwrites an existing certificate only when `force` is set or when the
/// existing certificate expires inside `renew_within_days`; otherwise it is kept byte-identical.
pub fn issue_leaf(
    paths: &PkiPaths,
    ca: &LoadedCa,
    spec: &CertificateSpec,
    now: i64,
    force: bool,
    renew_within_days: u16,
) -> Result<IssuedLeaf> {
    let cert_path = paths.cert_path(&spec.name);
    let key_path = paths.key_path(&spec.name);
    if cert_path.is_file() && key_path.is_file() && !force {
        let status =
            inventory::inspect_certificate_file(&cert_path, &spec.name).with_context(|| {
                format!("existing certificate {} is unreadable", cert_path.display())
            })?;
        let remaining = days_until(status.not_after_unix, now);
        // A SAN, CN or EKU drift re-issues the leaf even when it is far from expiry: this is what
        // keeps the core IP SAN correct when a node moves to another LAN (TS sanDrift).
        if remaining >= i64::from(renew_within_days).max(1) && spec_matches(&status, spec) {
            return Ok(IssuedLeaf {
                entry: inventory::entry_from_status(&status, spec),
                written: false,
            });
        }
    }

    let key = KeyPair::generate().context("cannot generate the leaf key")?;
    let not_after_unix = now.saturating_add(i64::from(spec.days).saturating_mul(DAY_SECONDS));
    let serial = serial_for(&spec.name, &spec.cn, &key, not_after_unix);
    let mut params = if spec.dns_sans.is_empty() && spec.ip_sans.is_empty() {
        CertificateParams::default()
    } else {
        CertificateParams::new(spec.san_values())
            .with_context(|| format!("invalid SAN for certificate '{}'", spec.name))?
    };
    params.distinguished_name = distinguished_name(&spec.cn, ou_for(spec));
    params.is_ca = IsCa::ExplicitNoCa;
    params.key_usages = vec![
        KeyUsagePurpose::DigitalSignature,
        KeyUsagePurpose::KeyEncipherment,
    ];
    params.extended_key_usages = match spec.kind {
        CertKind::Server => vec![ExtendedKeyUsagePurpose::ServerAuth],
        CertKind::Client => vec![ExtendedKeyUsagePurpose::ClientAuth],
        CertKind::ServerClient => vec![
            ExtendedKeyUsagePurpose::ServerAuth,
            ExtendedKeyUsagePurpose::ClientAuth,
        ],
        CertKind::Ca => bail!(
            "'{}' is a CA spec and cannot be issued as a leaf",
            spec.name
        ),
    };
    params.not_before = date_at!(now, -1);
    params.not_after = date_at!(now, spec.days);
    params.serial_number = Some(serial);
    params.use_authority_key_identifier_extension = true;

    let issuer_key = KeyPair::from_pem(&ca.intermediate_key_pem)
        .context("the intermediate CA key cannot be loaded")?;
    let issuer = Issuer::from_ca_cert_pem(&ca.intermediate_pem, issuer_key)
        .context("the intermediate CA certificate cannot be used as an issuer")?;
    let certificate = params
        .signed_by(&key, &issuer)
        .with_context(|| format!("cannot sign certificate '{}'", spec.name))?;

    paths.ensure_dir()?;
    util::write_atomic(&key_path, key.serialize_pem().as_bytes(), 0o600)
        .with_context(|| format!("cannot write {}", key_path.display()))?;
    // Leaf first, intermediate second: a root-only trust store can still build the path.
    let chain = format!("{}{}", certificate.pem(), ca.intermediate_pem);
    util::write_atomic(&cert_path, chain.as_bytes(), 0o644)
        .with_context(|| format!("cannot write {}", cert_path.display()))?;

    let status = inventory::inspect_certificate_file(&cert_path, &spec.name)?;
    Ok(IssuedLeaf {
        entry: inventory::entry_from_status(&status, spec),
        written: true,
    })
}

fn spec_matches(status: &inventory::CertificateStatus, spec: &CertificateSpec) -> bool {
    status.common_name == spec.cn
        && spec
            .dns_sans
            .iter()
            .all(|required| status.dns_sans.iter().any(|present| present == required))
        && spec
            .ip_sans
            .iter()
            .all(|required| status.ip_sans.iter().any(|present| present == required))
        && status.eku_server == spec.kind.is_server()
        && status.eku_client == spec.kind.is_client()
}

fn ou_for(spec: &CertificateSpec) -> &'static str {
    let has = |role: &str| spec.roles.iter().any(|entry| entry == role);
    if has("core") {
        "core"
    } else if has("edge") {
        "edge"
    } else if has("fake-rails") {
        "fake-rails"
    } else if has("backup") {
        "backup"
    } else if has("object-storage") {
        "object-storage"
    } else if has("postgres") || has("pgbouncer") {
        "postgres"
    } else if has("redis") {
        "redis"
    } else {
        "leaf"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pki::inventory;

    fn temp_paths(tag: &str) -> PkiPaths {
        let dir = std::env::temp_dir().join(format!(
            "pgctl-pki-{}-{}-{tag}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or_default()
        ));
        PkiPaths::new(dir)
    }

    fn now() -> i64 {
        1_800_000_000
    }

    #[test]
    fn ca_has_root_and_intermediate_and_secure_modes() {
        let paths = temp_paths("ca");
        create_ca(&paths, CaOptions::default(), now()).expect("ca");
        for file in [
            paths.root_cert(),
            paths.root_key(),
            paths.intermediate_cert(),
            paths.intermediate_key(),
            paths.chain(),
        ] {
            assert!(file.is_file(), "{}", file.display());
        }
        let root =
            inventory::parse_first_certificate(&std::fs::read(paths.root_cert()).expect("read"))
                .expect("root parses");
        let intermediate = inventory::parse_first_certificate(
            &std::fs::read(paths.intermediate_cert()).expect("read"),
        )
        .expect("intermediate parses");
        assert!(root.is_ca);
        assert!(intermediate.is_ca);
        intermediate
            .verify_signed_by(&root)
            .expect("intermediate is signed by the root");
        assert_eq!(root.common_name, ROOT_CN);
        assert_eq!(intermediate.common_name, INTERMEDIATE_CN);
        assert!(root.days_remaining(now()) > 3_000);
        assert!(intermediate.days_remaining(now()) > 1_000);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for key in [paths.root_key(), paths.intermediate_key()] {
                let mode = std::fs::metadata(&key).expect("meta").permissions().mode() & 0o777;
                assert_eq!(mode, 0o600, "{}", key.display());
            }
            for cert in [paths.root_cert(), paths.intermediate_cert(), paths.chain()] {
                let mode = std::fs::metadata(&cert).expect("meta").permissions().mode() & 0o777;
                assert_eq!(mode, 0o644, "{}", cert.display());
            }
            let mode = std::fs::metadata(paths.dir())
                .expect("meta")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o700);
        }
        let chain = std::fs::read_to_string(paths.chain()).expect("chain");
        assert_eq!(chain.matches("BEGIN CERTIFICATE").count(), 2);

        // A second init never silently replaces the CA.
        let error = create_ca(&paths, CaOptions::default(), now()).expect_err("refuse");
        assert!(error.to_string().contains("--rotate"), "{error}");

        let _ = std::fs::remove_dir_all(paths.dir());
    }

    #[test]
    fn leaf_carries_cn_sans_eku_serial_and_chain() {
        let paths = temp_paths("leaf");
        create_ca(&paths, CaOptions::default(), now()).expect("ca");
        let ca = load_ca(&paths).expect("load");
        let mut spec = CertificateSpec::new(
            "core-back",
            "core-back.internal",
            CertKind::ServerClient,
            90,
        )
        .with_roles(&["core", "server"])
        .with_dns("core-back.internal")
        .with_dns("core-back")
        .with_ip("10.0.0.11")
        .with_ip("127.0.0.1");
        spec.normalize().expect("spec");
        let leaf = issue_leaf(&paths, &ca, &spec, now(), false, 30).expect("issue");
        assert!(leaf.written);
        assert_eq!(leaf.entry.cn, "core-back.internal");
        assert_eq!(leaf.entry.days, 90);
        assert!(!leaf.entry.serial.is_empty());
        assert_eq!(leaf.entry.fingerprint_sha256.len(), 64);
        assert!(leaf
            .entry
            .dns_sans
            .contains(&"core-back.internal".to_owned()));
        assert!(leaf.entry.ip_sans.contains(&"10.0.0.11".to_owned()));
        assert!(leaf.entry.not_after.starts_with("20"));

        let status =
            inventory::inspect_certificate_file(&paths.cert_path("core-back"), "core-back")
                .expect("inspect");
        assert!(status.eku_server);
        assert!(status.eku_client);
        assert!(status
            .verify_signed_by(
                &inventory::parse_first_certificate(
                    &std::fs::read(paths.intermediate_cert()).expect("read")
                )
                .expect("ca")
            )
            .is_ok());

        let chain = std::fs::read_to_string(paths.cert_path("core-back")).expect("cert");
        assert_eq!(chain.matches("BEGIN CERTIFICATE").count(), 2);

        // Re-issue without --force keeps the exact bytes.
        let before = std::fs::read(paths.cert_path("core-back")).expect("read");
        let again = issue_leaf(&paths, &ca, &spec, now(), false, 30).expect("issue");
        assert!(!again.written);
        assert_eq!(
            std::fs::read(paths.cert_path("core-back")).expect("read"),
            before
        );

        let _ = std::fs::remove_dir_all(paths.dir());
    }

    #[test]
    fn issue_without_a_ca_fails_with_a_hint() {
        let paths = temp_paths("no-ca");
        std::fs::create_dir_all(paths.dir()).expect("dir");
        let mut spec = CertificateSpec::new("x", "x", CertKind::Client, 30);
        spec.normalize().expect("spec");
        let error = load_ca(&paths).expect_err("no ca");
        assert!(error.to_string().contains("pgctl pki init"), "{error}");
        let _ = std::fs::remove_dir_all(paths.dir());
    }

    #[test]
    fn serials_differ_between_issuances() {
        let paths = temp_paths("serial");
        create_ca(&paths, CaOptions::default(), now()).expect("ca");
        let ca = load_ca(&paths).expect("load");
        let spec = CertificateSpec::new("client", "client", CertKind::Client, 30);
        let first = issue_leaf(&paths, &ca, &spec, now(), true, 0).expect("first");
        let second = issue_leaf(&paths, &ca, &spec, now(), true, 0).expect("second");
        assert_ne!(first.entry.serial, second.entry.serial);
        let _ = std::fs::remove_dir_all(paths.dir());
    }

    #[test]
    fn ca_spec_cannot_be_issued_as_a_leaf() {
        let paths = temp_paths("ca-leaf");
        create_ca(&paths, CaOptions::default(), now()).expect("ca");
        let ca = load_ca(&paths).expect("load");
        let spec = CertificateSpec::new("bad", "bad", CertKind::Ca, 30);
        let error = issue_leaf(&paths, &ca, &spec, now(), true, 0).expect_err("refuse");
        assert!(error.to_string().contains("CA spec"), "{error}");
        let _ = std::fs::remove_dir_all(paths.dir());
    }

    #[test]
    fn san_drift_reissues_without_force() {
        let paths = temp_paths("drift");
        create_ca(&paths, CaOptions::default(), now()).expect("ca");
        let ca = load_ca(&paths).expect("load");
        let mut spec =
            CertificateSpec::new("core-back", "core-back.internal", CertKind::Server, 90);
        spec.dns_sans = vec!["core-back.internal".to_owned()];
        spec.ip_sans = vec!["10.0.0.11".to_owned()];
        spec.normalize().expect("spec");
        let first = issue_leaf(&paths, &ca, &spec, now(), false, 30).expect("first");
        assert!(first.written);

        spec.ip_sans.push("10.9.9.9".to_owned());
        spec.normalize().expect("spec");
        let second = issue_leaf(&paths, &ca, &spec, now(), false, 30).expect("second");
        assert!(second.written, "SAN drift must re-issue the leaf");
        assert_ne!(first.entry.serial, second.entry.serial);
        assert!(second.entry.ip_sans.contains(&"10.9.9.9".to_owned()));
        let _ = std::fs::remove_dir_all(paths.dir());
    }

    #[test]
    fn ca_chain_contains_both_certificates_and_verifies() {
        let paths = temp_paths("chain");
        create_ca(&paths, CaOptions::default(), now()).expect("ca");
        let ca = load_ca(&paths).expect("load");
        let root = inventory::parse_first_certificate(
            &std::fs::read(paths.root_cert()).expect("read root"),
        )
        .expect("root");
        let intermediate = inventory::parse_first_certificate(ca.intermediate_pem.as_bytes())
            .expect("intermediate");
        intermediate.verify_signed_by(&root).expect("chain");
        assert!(paths.chain().is_file());
        let _ = std::fs::remove_dir_all(paths.dir());
    }
}

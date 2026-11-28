//! Revocation: a documented JSON list plus a signed X.509 CRL.
//!
//! The list (`revoked.json`) is the source of truth and the audit trail: serial, name, reason and
//! the instant. The CRL (`crl.pem`) is derived from it and signed by the intermediate CA, so it can
//! be distributed to PostgreSQL (`ssl_crl_file`) and the Rust daemons without sharing the list
//! format. Re-running `pgctl pki revoke` for an already-revoked certificate is a no-op: the list
//! never grows duplicates and the CRL number only changes when a new serial is added.

use anyhow::{bail, Context, Result};
use rcgen::{
    CertificateRevocationListParams, Issuer, KeyIdMethod, KeyPair, RevocationReason,
    RevokedCertParams, SerialNumber,
};
use serde::{Deserialize, Serialize};

use crate::util;

use super::inventory::{self, CertificateStatus};
use super::issue::PkiPaths;
use super::timeutil::{format_unix_rfc3339, ymd_from_unix, DAY_SECONDS};

/// Revocation-list schema version.
pub const REVOCATION_VERSION: u32 = 1;
/// CRL validity (days). The deploy fetches a new one on every `pki revoke`/`pki renew` run.
pub const CRL_DAYS: u16 = 30;

/// One revoked certificate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RevocationEntry {
    /// Lowercase hex serial.
    pub serial: String,
    /// File stem, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Reason code as the canonical kebab-case string.
    pub reason: String,
    /// RFC 3339 revocation instant.
    pub revoked_at: String,
    /// Revocation instant (Unix seconds), used to rebuild the CRL.
    pub revoked_at_unix: i64,
}

/// The documented revocation list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RevocationList {
    /// Schema version.
    pub version: u32,
    /// CRL number; increments with every newly revoked serial.
    pub crl_number: u32,
    /// Entries sorted by serial.
    pub entries: Vec<RevocationEntry>,
}

impl Default for RevocationList {
    fn default() -> Self {
        Self {
            version: REVOCATION_VERSION,
            crl_number: 0,
            entries: Vec::new(),
        }
    }
}

impl RevocationList {
    /// Whether a serial is revoked.
    #[must_use]
    pub fn is_revoked(&self, serial: &str) -> bool {
        self.entries
            .iter()
            .any(|entry| entry.serial.eq_ignore_ascii_case(serial))
    }

    /// Revoked serials, for the inventory flags.
    #[must_use]
    pub fn serials(&self) -> Vec<String> {
        self.entries
            .iter()
            .map(|entry| entry.serial.clone())
            .collect()
    }
}

/// Which certificate to revoke.
#[derive(Debug, Clone, Copy)]
pub enum RevokeSelector<'a> {
    /// File stem (`admin-back-client`).
    Name(&'a str),
    /// Hex serial (colons and whitespace allowed).
    Serial(&'a str),
}

/// Outcome of `pgctl pki revoke`.
#[derive(Debug, Clone)]
pub struct RevokeOutcome {
    /// Serial that was (or already had been) revoked.
    pub serial: String,
    /// File stem when the certificate file was found.
    pub name: Option<String>,
    /// Whether this call added the entry.
    pub added: bool,
    /// Current CRL number.
    pub crl_number: u32,
    /// CRL path.
    pub crl: String,
}

/// Load the list; a missing file is an empty list.
pub fn load_list(paths: &PkiPaths) -> Result<RevocationList> {
    let path = paths.revocation_list();
    if !path.is_file() {
        return Ok(RevocationList::default());
    }
    let text = std::fs::read_to_string(&path)
        .with_context(|| format!("cannot read {}", path.display()))?;
    let list: RevocationList = serde_json::from_str(&text)
        .with_context(|| format!("invalid revocation list in {}", path.display()))?;
    Ok(list)
}

fn save_list(paths: &PkiPaths, list: &RevocationList) -> Result<()> {
    let text = util::json_pretty(list).context("cannot serialise the revocation list")?;
    util::write_atomic(&paths.revocation_list(), text.as_bytes(), 0o644)
        .with_context(|| format!("cannot write {}", paths.revocation_list().display()))
}

/// Resolve a selector to the certificate file that is actually present.
fn resolve(
    paths: &PkiPaths,
    selector: RevokeSelector<'_>,
) -> Result<(String, Option<String>, CertificateStatus)> {
    match selector {
        RevokeSelector::Name(name) => {
            let path = paths.cert_path(name);
            if !path.is_file() {
                bail!("no certificate named '{name}' in {}", paths.dir().display());
            }
            let status = inventory::inspect_certificate_file(&path, name)?;
            Ok((status.serial.clone(), Some(name.to_owned()), status))
        }
        RevokeSelector::Serial(serial) => {
            let wanted = normalise_serial(serial)?;
            for candidate in candidate_certificate_files(paths)? {
                let status = inventory::inspect_certificate_file(&candidate.1, &candidate.0)?;
                if status.serial.eq_ignore_ascii_case(&wanted) {
                    return Ok((status.serial.clone(), Some(candidate.0), status));
                }
            }
            bail!(
                "no certificate with serial '{wanted}' in {}",
                paths.dir().display()
            );
        }
    }
}

fn candidate_certificate_files(paths: &PkiPaths) -> Result<Vec<(String, std::path::PathBuf)>> {
    let mut out = Vec::new();
    for name in [
        super::issue::ROOT_CERT_FILE,
        super::issue::INTERMEDIATE_CERT_FILE,
    ] {
        let path = paths.dir().join(name);
        if path.is_file() {
            out.push((name.trim_end_matches(".crt").to_owned(), path));
        }
    }
    let Ok(entries) = std::fs::read_dir(paths.dir()) else {
        return Ok(out);
    };
    let mut leaves: Vec<(String, std::path::PathBuf)> = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let file = entry.file_name().to_string_lossy().into_owned();
            let stem = file.strip_suffix(".crt")?.to_owned();
            if [
                super::issue::ROOT_CERT_FILE.trim_end_matches(".crt"),
                super::issue::INTERMEDIATE_CERT_FILE.trim_end_matches(".crt"),
                super::issue::CA_CHAIN_FILE.trim_end_matches(".crt"),
            ]
            .contains(&stem.as_str())
            {
                return None;
            }
            Some((stem, entry.path()))
        })
        .collect();
    leaves.sort_by(|left, right| left.0.cmp(&right.0));
    out.extend(leaves);
    Ok(out)
}

fn normalise_serial(serial: &str) -> Result<String> {
    let cleaned: String = serial
        .chars()
        .filter(|ch| !ch.is_whitespace() && *ch != ':')
        .collect();
    if cleaned.is_empty()
        || !cleaned.len().is_multiple_of(2)
        || !cleaned.chars().all(|ch| ch.is_ascii_hexdigit())
    {
        bail!("'{serial}' is not an even-length hexadecimal serial number");
    }
    Ok(cleaned.to_ascii_lowercase())
}

fn hex_bytes(serial: &str) -> Result<Vec<u8>> {
    let cleaned = normalise_serial(serial)?;
    let mut out = Vec::with_capacity(cleaned.len() / 2);
    let bytes = cleaned.as_bytes();
    for index in (0..bytes.len()).step_by(2) {
        let high = hex_value(bytes[index])?;
        let low = hex_value(bytes[index + 1])?;
        out.push((high << 4) | low);
    }
    Ok(out)
}

fn hex_value(byte: u8) -> Result<u8> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        other => bail!("'{}' is not a hexadecimal digit", char::from(other)),
    }
}

fn reason(value: &str) -> Result<(&'static str, Option<RevocationReason>)> {
    Ok(match value.trim().to_ascii_lowercase().as_str() {
        "" | "unspecified" => ("unspecified", None),
        "key-compromise" | "key_compromise" => ("key-compromise", Some(RevocationReason::KeyCompromise)),
        "ca-compromise" | "ca_compromise" => ("ca-compromise", Some(RevocationReason::CaCompromise)),
        "affiliation-changed" | "affiliation_changed" => (
            "affiliation-changed",
            Some(RevocationReason::AffiliationChanged),
        ),
        "superseded" => ("superseded", Some(RevocationReason::Superseded)),
        "cessation" | "cessation-of-operation" => (
            "cessation-of-operation",
            Some(RevocationReason::CessationOfOperation),
        ),
        "certificate-hold" | "certificate_hold" => {
            ("certificate-hold", Some(RevocationReason::CertificateHold))
        }
        "privilege-withdrawn" | "privilege_withdrawn" => (
            "privilege-withdrawn",
            Some(RevocationReason::PrivilegeWithdrawn),
        ),
        "aa-compromise" | "aa_compromise" => ("aa-compromise", Some(RevocationReason::AaCompromise)),
        other => bail!(
            "unknown revocation reason '{other}' (use unspecified, key-compromise, ca-compromise, affiliation-changed, superseded, cessation-of-operation, certificate-hold, privilege-withdrawn or aa-compromise)"
        ),
    })
}

/// Revoke one certificate and regenerate the CRL.
pub fn revoke(
    paths: &PkiPaths,
    selector: RevokeSelector<'_>,
    reason_text: &str,
    now: i64,
) -> Result<RevokeOutcome> {
    let (canonical_reason, _) = reason(reason_text)?;
    let (serial, name, _status) = resolve(paths, selector)?;
    let mut list = load_list(paths)?;

    let added = if list.is_revoked(&serial) {
        false
    } else {
        list.entries.push(RevocationEntry {
            serial: serial.clone(),
            name: name.clone(),
            reason: canonical_reason.to_owned(),
            revoked_at: format_unix_rfc3339(now),
            revoked_at_unix: now,
        });
        list.entries
            .sort_by(|left, right| left.serial.cmp(&right.serial));
        list.crl_number = list.crl_number.saturating_add(1).max(1);
        true
    };

    if added {
        regenerate_crl(paths, &list, now)?;
        save_list(paths, &list)?;
    } else if !paths.crl().is_file() {
        // The list says revoked but no CRL exists (e.g. files copied around): rebuild it.
        regenerate_crl(paths, &list, now)?;
    }

    Ok(RevokeOutcome {
        serial,
        name,
        added,
        crl_number: list.crl_number,
        crl: paths.crl().display().to_string(),
    })
}

/// Sign the CRL for the current list.
pub fn regenerate_crl(paths: &PkiPaths, list: &RevocationList, now: i64) -> Result<()> {
    let ca = super::issue::load_ca(paths)?;
    let issuer_key = KeyPair::from_pem(&ca.intermediate_key_pem)
        .context("the intermediate CA key cannot be loaded")?;
    let issuer = Issuer::from_ca_cert_pem(&ca.intermediate_pem, issuer_key)
        .context("the intermediate CA certificate cannot sign the CRL")?;

    let mut revoked_certs = Vec::with_capacity(list.entries.len());
    for entry in &list.entries {
        let serial_bytes = hex_bytes(&entry.serial)?;
        let (_, revocation_reason) = reason(&entry.reason)?;
        let (year, month, day) = ymd_from_unix(entry.revoked_at_unix);
        revoked_certs.push(RevokedCertParams {
            serial_number: SerialNumber::from_slice(&serial_bytes),
            revocation_time: rcgen::date_time_ymd(year, month, day),
            reason_code: revocation_reason,
            invalidity_date: None,
        });
    }

    let (this_year, this_month, this_day) = ymd_from_unix(now.saturating_sub(DAY_SECONDS));
    let (next_year, next_month, next_day) =
        ymd_from_unix(now.saturating_add(i64::from(CRL_DAYS) * DAY_SECONDS));
    let params = CertificateRevocationListParams {
        this_update: rcgen::date_time_ymd(this_year, this_month, this_day),
        next_update: rcgen::date_time_ymd(next_year, next_month, next_day),
        crl_number: SerialNumber::from(u64::from(list.crl_number.max(1))),
        issuing_distribution_point: None,
        revoked_certs,
        key_identifier_method: KeyIdMethod::Sha256,
    };
    let crl = params
        .signed_by(&issuer)
        .context("cannot sign the certificate revocation list")?;
    let pem = crl.pem().context("cannot encode the CRL as PEM")?;
    util::write_atomic(&paths.crl(), pem.as_bytes(), 0o644)
        .with_context(|| format!("cannot write {}", paths.crl().display()))?;
    Ok(())
}

/// Verify that `crl.pem` was signed by the given issuer certificate.
pub fn verify_crl_signature(paths: &PkiPaths, issuer: &CertificateStatus, now: i64) -> Result<()> {
    let path = paths.crl();
    let data = std::fs::read(&path).with_context(|| format!("cannot read {}", path.display()))?;
    let pem = x509_parser::pem::parse_x509_pem(&data)
        .map_err(|error| anyhow::anyhow!("cannot parse {}: {error}", path.display()))?
        .1;
    let (_, crl) = x509_parser::parse_x509_crl(&pem.contents)
        .map_err(|error| anyhow::anyhow!("invalid CRL {}: {error}", path.display()))?;
    let (_, issuer_cert) = x509_parser::parse_x509_certificate(&issuer.der)
        .map_err(|error| anyhow::anyhow!("cannot parse the issuer certificate: {error}"))?;
    crl.verify_signature(issuer_cert.public_key())
        .map_err(|error| {
            anyhow::anyhow!("CRL signature does not match the current intermediate CA: {error}")
        })?;
    if let Some(next_update) = crl.next_update() {
        if next_update.timestamp() < now {
            bail!(
                "CRL expired on {}; signing a new one (pki revoke or a CA rotation) sets the next update {CRL_DAYS} days ahead",
                format_unix_rfc3339(next_update.timestamp())
            );
        }
    }
    Ok(())
}

/// Whether `crl.pem` exists and lists `serial` (used by `verify` and tests).
pub fn crl_contains(paths: &PkiPaths, serial: &str) -> Result<bool> {
    let wanted = normalise_serial(serial)?;
    let path = paths.crl();
    if !path.is_file() {
        return Ok(false);
    }
    let data = std::fs::read(&path).with_context(|| format!("cannot read {}", path.display()))?;
    let pem = x509_parser::pem::parse_x509_pem(&data)
        .map_err(|error| anyhow::anyhow!("cannot parse {}: {error}", path.display()))?
        .1;
    let (_, crl) = x509_parser::parse_x509_crl(&pem.contents)
        .map_err(|error| anyhow::anyhow!("invalid CRL {}: {error}", path.display()))?;
    let found = crl.iter_revoked_certificates().any(|entry| {
        let text = entry.serial().to_str_radix(16);
        let width = wanted.len().max(text.len());
        format!("{text:0>width$}").eq_ignore_ascii_case(&wanted)
    });
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pki::catalog::{CertKind, CertificateSpec};
    use crate::pki::inventory::inspect_certificate_file;
    use crate::pki::issue::{create_ca, issue_leaf, load_ca, CaOptions};

    fn temp_paths(tag: &str) -> PkiPaths {
        let dir = std::env::temp_dir().join(format!(
            "pgctl-rev-{}-{}-{tag}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or_default()
        ));
        PkiPaths::new(dir)
    }

    fn setup(tag: &str) -> (PkiPaths, i64) {
        let paths = temp_paths(tag);
        let now = 1_800_000_000;
        create_ca(&paths, CaOptions::default(), now).expect("ca");
        let ca = load_ca(&paths).expect("ca");
        issue_leaf(
            &paths,
            &ca,
            &CertificateSpec::new("admin-back-client", "admin-back", CertKind::Client, 90),
            now,
            true,
            0,
        )
        .expect("issue");
        (paths, now)
    }

    #[test]
    fn revoke_by_name_writes_the_list_and_a_verifiable_crl() {
        let (paths, now) = setup("by-name");
        let status =
            inspect_certificate_file(&paths.cert_path("admin-back-client"), "admin-back-client")
                .expect("inspect");
        let outcome = revoke(
            &paths,
            RevokeSelector::Name("admin-back-client"),
            "key-compromise",
            now,
        )
        .expect("revoke");
        assert!(outcome.added);
        assert_eq!(outcome.crl_number, 1);
        assert_eq!(outcome.serial, status.serial);
        assert!(paths.crl().is_file());
        assert!(crl_contains(&paths, &status.serial).expect("crl"));
        let list = load_list(&paths).expect("list");
        assert_eq!(list.entries.len(), 1);
        assert_eq!(list.entries[0].name.as_deref(), Some("admin-back-client"));
        assert_eq!(list.entries[0].reason, "key-compromise");

        // Idempotent: no duplicate, no CRL-number bump.
        let again = revoke(
            &paths,
            RevokeSelector::Name("admin-back-client"),
            "key-compromise",
            now + 60,
        )
        .expect("revoke");
        assert!(!again.added);
        assert_eq!(again.crl_number, 1);
        assert_eq!(load_list(&paths).expect("list").entries.len(), 1);

        let _ = std::fs::remove_dir_all(paths.dir());
    }

    #[test]
    fn revoke_by_serial_accepts_colons_and_case() {
        let (paths, now) = setup("by-serial");
        let status =
            inspect_certificate_file(&paths.cert_path("admin-back-client"), "admin-back-client")
                .expect("inspect");
        let mut formatted = String::new();
        for (index, chunk) in status.serial.as_bytes().chunks(2).enumerate() {
            if index > 0 {
                formatted.push(':');
            }
            formatted.push_str(
                std::str::from_utf8(chunk)
                    .unwrap_or_default()
                    .to_ascii_uppercase()
                    .as_str(),
            );
        }
        let outcome = revoke(&paths, RevokeSelector::Serial(&formatted), "", now).expect("revoke");
        assert!(outcome.added);
        assert_eq!(outcome.serial, status.serial);
        let _ = std::fs::remove_dir_all(paths.dir());
    }

    #[test]
    fn unknown_serial_and_bad_reason_fail_without_writing() {
        let (paths, now) = setup("unknown");
        let error = revoke(
            &paths,
            RevokeSelector::Serial("0011223344556677"),
            "unspecified",
            now,
        )
        .expect_err("unknown serial");
        assert!(
            error.to_string().contains("no certificate with serial"),
            "{error}"
        );
        assert!(!paths.revocation_list().exists());

        let error = revoke(
            &paths,
            RevokeSelector::Name("admin-back-client"),
            "bogus",
            now,
        )
        .expect_err("bad reason");
        assert!(
            error.to_string().contains("unknown revocation reason"),
            "{error}"
        );
        assert!(!paths.revocation_list().exists());
        let _ = std::fs::remove_dir_all(paths.dir());
    }

    #[test]
    fn crl_number_increments_per_new_serial() {
        let (paths, now) = setup("numbering");
        let ca = load_ca(&paths).expect("ca");
        issue_leaf(
            &paths,
            &ca,
            &CertificateSpec::new("second", "second", CertKind::Client, 90),
            now,
            true,
            0,
        )
        .expect("issue");
        assert_eq!(
            revoke(&paths, RevokeSelector::Name("admin-back-client"), "", now)
                .expect("first")
                .crl_number,
            1
        );
        assert_eq!(
            revoke(&paths, RevokeSelector::Name("second"), "", now)
                .expect("second")
                .crl_number,
            2
        );
        let list = load_list(&paths).expect("list");
        assert_eq!(list.entries.len(), 2);
        assert!(list
            .entries
            .windows(2)
            .all(|window| window[0].serial <= window[1].serial));
        let _ = std::fs::remove_dir_all(paths.dir());
    }

    #[test]
    fn revoked_intermediate_is_in_the_crl() {
        let (paths, now) = setup("ca");
        let intermediate =
            inspect_certificate_file(&paths.intermediate_cert(), "intermediate-ca").expect("ca");
        let outcome = revoke(
            &paths,
            RevokeSelector::Serial(&intermediate.serial),
            "superseded",
            now,
        )
        .expect("revoke");
        assert!(outcome.added);
        assert!(crl_contains(&paths, &intermediate.serial).expect("crl"));
        let _ = std::fs::remove_dir_all(paths.dir());
    }

    #[test]
    fn serial_helpers_validate_input() {
        assert_eq!(normalise_serial("00:Ab:CD").expect("ok"), "00abcd");
        assert!(normalise_serial("abc").is_err());
        assert!(normalise_serial("zz").is_err());
        assert_eq!(hex_bytes("00ff").expect("bytes"), vec![0x00, 0xff]);
    }
}

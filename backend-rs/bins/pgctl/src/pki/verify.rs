//! Chain, expiry, revocation, SAN and permission verification (`pgctl pki verify`).
//!
//! Exit code 1 with precise problems, like the TypeScript `--check-certs`: a missing file, a
//! certificate signing no longer matching the CA, an expired certificate, a certificate inside the
//! renewal window, a revoked serial, a key readable by another user, or a SAN the plan requires
//! and the certificate does not carry.

use std::path::Path;

use anyhow::Result;
use serde::Serialize;

use super::catalog::{CertKind, CertificateSpec};
use super::inventory::{self, CertificateStatus};
use super::issue::PkiPaths;
use super::revocation::{self, RevocationList};
use super::timeutil::days_until;

/// One problem found by `verify`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct VerifyProblem {
    /// Stable code (`MISSING`, `EXPIRED`, `RENEW`, `CHAIN`, `REVOKED`, `KEY_MODE`, ...).
    pub code: String,
    /// Certificate or directory name.
    pub name: String,
    /// Human explanation with the exact file and dates.
    pub message: String,
}

/// One certificate status row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CertificateRow {
    /// File stem.
    pub name: String,
    /// Usage.
    pub kind: CertKind,
    /// Serial (empty when the file is missing/unparseable).
    pub serial: String,
    /// Validity end (RFC 3339), when known.
    pub not_after: String,
    /// Whole days until expiry, when known.
    pub expires_in_days: Option<i64>,
    /// `ok`, `renew`, `expired`, `rotate-ca`, `revoked` or `missing`.
    pub state: String,
    /// Whether the serial is on the revocation list.
    pub revoked: bool,
}

/// The verification result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct VerifyReport {
    /// True when there are no problems.
    pub ok: bool,
    /// PKI directory.
    pub pki_dir: String,
    /// Renewal window.
    pub within_days: u16,
    /// Problems, sorted by name then code.
    pub problems: Vec<VerifyProblem>,
    /// Certificate statuses, sorted by name.
    pub certificates: Vec<CertificateRow>,
}

/// Verification inputs.
pub struct VerifyOptions<'a> {
    /// A leaf inside this window is a problem ("renew").
    pub within_days: u16,
    /// The comparison instant.
    pub now: i64,
    /// The catalogue the topology requires; when absent, the inventory/scan is verified.
    pub expected: Option<&'a [CertificateSpec]>,
}

struct Problems {
    inner: Vec<VerifyProblem>,
}

impl Problems {
    fn new() -> Self {
        Self { inner: Vec::new() }
    }

    fn push(&mut self, code: &str, name: &str, message: String) {
        self.inner.push(VerifyProblem {
            code: code.to_owned(),
            name: name.to_owned(),
            message,
        });
    }

    fn finish(self) -> Vec<VerifyProblem> {
        let mut problems = self.inner;
        problems.sort_by(|left, right| {
            left.name
                .cmp(&right.name)
                .then_with(|| left.code.cmp(&right.code))
        });
        problems
    }
}

fn mode_of(path: &Path) -> Option<u32> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .ok()
            .map(|metadata| metadata.permissions().mode() & 0o777)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        None
    }
}

fn expiry_problem(
    problems: &mut Problems,
    name: &str,
    status: &CertificateStatus,
    now: i64,
    within: u16,
    is_ca: bool,
) {
    let remaining = status.days_remaining(now);
    let not_after = super::timeutil::format_unix_rfc3339(status.not_after_unix);
    if status.not_before_unix > now {
        problems.push(
            "NOT_YET_VALID",
            name,
            format!(
                "not valid before {}",
                super::timeutil::format_unix_rfc3339(status.not_before_unix)
            ),
        );
    } else if remaining <= 0 {
        problems.push(
            if is_ca { "CA_EXPIRED" } else { "EXPIRED" },
            name,
            format!("expired on {not_after}"),
        );
    } else if i64::from(within) > remaining {
        problems.push(
            if is_ca { "ROTATE_CA" } else { "RENEW" },
            name,
            format!(
                "expires in {remaining} day(s) on {not_after}, inside the {within}-day window ({})",
                if is_ca {
                    "run 'pgctl pki init --rotate'"
                } else {
                    "run 'pgctl pki renew'"
                }
            ),
        );
    }
}

fn row(
    name: &str,
    kind: CertKind,
    status: Option<&CertificateStatus>,
    now: i64,
    within: u16,
    revoked: bool,
) -> CertificateRow {
    let Some(status) = status else {
        return CertificateRow {
            name: name.to_owned(),
            kind,
            serial: String::new(),
            not_after: String::new(),
            expires_in_days: None,
            state: "missing".to_owned(),
            revoked,
        };
    };
    let remaining = days_until(status.not_after_unix, now);
    let state = if revoked {
        "revoked"
    } else if remaining <= 0 {
        if kind == CertKind::Ca {
            "rotate-ca"
        } else {
            "expired"
        }
    } else if i64::from(within) > remaining {
        if kind == CertKind::Ca {
            "rotate-ca"
        } else {
            "renew"
        }
    } else {
        "ok"
    };
    CertificateRow {
        name: name.to_owned(),
        kind,
        serial: status.serial.clone(),
        not_after: super::timeutil::format_unix_rfc3339(status.not_after_unix),
        expires_in_days: Some(remaining),
        state: state.to_owned(),
        revoked,
    }
}

/// Verify a PKI directory.
pub fn verify(paths: &PkiPaths, options: &VerifyOptions<'_>) -> Result<VerifyReport> {
    let mut problems = Problems::new();
    let mut rows = Vec::new();

    if !paths.dir().is_dir() {
        problems.push(
            "MISSING",
            "pki",
            format!("the PKI directory {} does not exist", paths.dir().display()),
        );
        return Ok(VerifyReport {
            ok: false,
            pki_dir: paths.dir().display().to_string(),
            within_days: options.within_days,
            problems: problems.finish(),
            certificates: rows,
        });
    }

    let list = match revocation::load_list(paths) {
        Ok(list) => list,
        Err(error) => {
            problems.push("REVOCATION_LIST", "revoked.json", format!("{error:#}"));
            RevocationList::default()
        }
    };
    let is_revoked = |serial: &str| list.is_revoked(serial);

    // ---- CA --------------------------------------------------------------
    let root = read_optional(&paths.root_cert(), "internal-ca", &mut problems);
    let intermediate = read_optional(&paths.intermediate_cert(), "intermediate-ca", &mut problems);
    for (name, status) in [("internal-ca", &root), ("intermediate-ca", &intermediate)] {
        if let Some(status) = status {
            if !status.is_ca {
                problems.push(
                    "NOT_CA",
                    name,
                    "certificate does not carry basicConstraints CA:TRUE".to_owned(),
                );
            }
            expiry_problem(
                &mut problems,
                name,
                status,
                options.now,
                options.within_days,
                true,
            );
            let revoked = is_revoked(&status.serial);
            if revoked {
                problems.push(
                    "REVOKED",
                    name,
                    format!("serial {} is on the revocation list", status.serial),
                );
            }
            rows.push(row(
                name,
                CertKind::Ca,
                Some(status),
                options.now,
                options.within_days,
                revoked,
            ));
        }
    }
    if let (Some(root), Some(intermediate)) = (&root, &intermediate) {
        if let Err(error) = intermediate.verify_signed_by(root) {
            problems.push(
                "CHAIN",
                "intermediate-ca",
                format!("intermediate certificate is not signed by internal-ca: {error}"),
            );
        }
    }
    check_chain_file(paths, &root, &intermediate, &mut problems);

    // ---- leaves ----------------------------------------------------------
    let expected = match options.expected {
        Some(specs) => specs.to_vec(),
        None => {
            let mut specs = match inventory::read_inventory(paths) {
                // Include revoked leaves: verify must report them, unlike renew/rotate.
                Ok(Some(inventory)) => inventory.all_leaf_specs(),
                _ => Vec::new(),
            };
            // A certificate that exists on disk but is missing from a stale inventory is still
            // verified (and would be flagged if it is revoked or malformed).
            for scanned in inventory::scan_leaf_specs(paths, None) {
                if !specs.iter().any(|spec| spec.name == scanned.name) {
                    specs.push(scanned);
                }
            }
            specs
        }
    };
    for spec in &expected {
        let path = paths.cert_path(&spec.name);
        let Some(status) = read_optional(&path, &spec.name, &mut problems) else {
            rows.push(row(
                &spec.name,
                spec.kind,
                None,
                options.now,
                options.within_days,
                false,
            ));
            continue;
        };
        let revoked = is_revoked(&status.serial);
        rows.push(row(
            &spec.name,
            spec.kind,
            Some(&status),
            options.now,
            options.within_days,
            revoked,
        ));
        if revoked {
            problems.push(
                "REVOKED",
                &spec.name,
                format!("serial {} is on the revocation list", status.serial),
            );
        }
        if status.common_name != spec.cn {
            problems.push(
                "CN_MISMATCH",
                &spec.name,
                format!(
                    "CN is '{}' but the catalogue requires '{}'",
                    status.common_name, spec.cn
                ),
            );
        }
        for required in spec.san_strings() {
            let present = required
                .strip_prefix("DNS:")
                .is_some_and(|name| status.dns_sans.iter().any(|entry| entry == name))
                || required
                    .strip_prefix("IP:")
                    .is_some_and(|ip| status.ip_sans.iter().any(|entry| entry == ip));
            if !present {
                let actual: Vec<String> = status
                    .dns_sans
                    .iter()
                    .map(|name| format!("DNS:{name}"))
                    .chain(status.ip_sans.iter().map(|ip| format!("IP:{ip}")))
                    .collect();
                problems.push(
                    "SAN_MISMATCH",
                    &spec.name,
                    format!(
                        "missing {required} (certificate has: {})",
                        if actual.is_empty() {
                            "no SANs".to_owned()
                        } else {
                            actual.join(", ")
                        }
                    ),
                );
            }
        }
        if !revoked {
            expiry_problem(
                &mut problems,
                &spec.name,
                &status,
                options.now,
                options.within_days,
                false,
            );
        }
        if let Some(intermediate) = &intermediate {
            if let Err(error) = status.verify_signed_by(intermediate) {
                problems.push(
                    "CHAIN",
                    &spec.name,
                    format!("certificate is not signed by intermediate-ca: {error}"),
                );
            }
        }
        check_modes(paths, spec, &mut problems);
    }

    for (name, key) in [
        ("internal-ca", paths.root_key()),
        ("intermediate-ca", paths.intermediate_key()),
    ] {
        if let Some(mode) = mode_of(&key) {
            if mode & 0o077 != 0 || mode != 0o600 {
                problems.push(
                    "KEY_MODE",
                    name,
                    format!(
                        "CA private key {} is mode {mode:04o}; it must not be readable or writable by group/other (0600)",
                        key.display()
                    ),
                );
            }
        }
    }

    // ---- directory, CRL and inventory ------------------------------------
    if let Some(mode) = mode_of(paths.dir()) {
        if mode != 0o700 {
            problems.push(
                "DIR_MODE",
                "pki",
                format!(
                    "{} is mode {mode:04o}, expected 0700",
                    paths.dir().display()
                ),
            );
        }
    }
    if !list.entries.is_empty() {
        if !paths.crl().is_file() {
            problems.push(
                "CRL_MISSING",
                "crl.pem",
                "the revocation list is not empty but no signed CRL exists; run 'pgctl pki revoke --rebuild-crl'"
                    .to_owned(),
            );
        } else {
            if let Some(intermediate) = &intermediate {
                if let Err(error) =
                    revocation::verify_crl_signature(paths, intermediate, options.now)
                {
                    problems.push("CRL_SIGNATURE", "crl.pem", format!("{error:#}"));
                }
            }
            for entry in &list.entries {
                match revocation::crl_contains(paths, &entry.serial) {
                    Ok(true) => {}
                    Ok(false) => problems.push(
                        "CRL_STALE",
                        entry.name.as_deref().unwrap_or("crl.pem"),
                        format!("serial {} is on the list but not in crl.pem", entry.serial),
                    ),
                    Err(error) => problems.push("CRL", "crl.pem", format!("{error:#}")),
                }
            }
        }
    }

    rows.sort_by(|left, right| left.name.cmp(&right.name));
    let problems = problems.finish();
    Ok(VerifyReport {
        ok: problems.is_empty(),
        pki_dir: paths.dir().display().to_string(),
        within_days: options.within_days,
        problems,
        certificates: rows,
    })
}

fn read_optional(path: &Path, name: &str, problems: &mut Problems) -> Option<CertificateStatus> {
    if !path.is_file() {
        problems.push(
            "MISSING",
            name,
            format!(
                "{} does not exist (run 'pgctl pki init' and 'pgctl pki issue')",
                path.display()
            ),
        );
        return None;
    }
    match inventory::inspect_certificate_file(path, name) {
        Ok(status) => Some(status),
        Err(error) => {
            problems.push("PARSE", name, format!("{error:#}"));
            None
        }
    }
}

fn check_chain_file(
    paths: &PkiPaths,
    root: &Option<CertificateStatus>,
    intermediate: &Option<CertificateStatus>,
    problems: &mut Problems,
) {
    if root.is_none() || intermediate.is_none() {
        return;
    }
    let path = paths.chain();
    let Ok(text) = std::fs::read_to_string(&path) else {
        problems.push(
            "CHAIN_MISSING",
            "ca-chain.crt",
            format!("{} is missing (root + intermediate bundle)", path.display()),
        );
        return;
    };
    if text.matches("BEGIN CERTIFICATE").count() < 2 {
        problems.push(
            "CHAIN_INCOMPLETE",
            "ca-chain.crt",
            "the bundle must contain the root and the intermediate certificate".to_owned(),
        );
    }
}

fn check_modes(paths: &PkiPaths, spec: &CertificateSpec, problems: &mut Problems) {
    if let Some(mode) = mode_of(&paths.cert_path(&spec.name)) {
        if mode != 0o644 {
            problems.push(
                "CERT_MODE",
                &spec.name,
                format!(
                    "{} is mode {mode:04o}, expected 0644",
                    paths.cert_path(&spec.name).display()
                ),
            );
        }
    }
    if let Some(mode) = mode_of(&paths.key_path(&spec.name)) {
        if mode & 0o077 != 0 {
            problems.push(
                "KEY_MODE",
                &spec.name,
                format!(
                    "private key {} is mode {mode:04o}; it must not be readable or writable by group/other (0600)",
                    paths.key_path(&spec.name).display()
                ),
            );
        } else if mode != 0o600 {
            problems.push(
                "KEY_MODE",
                &spec.name,
                format!(
                    "private key {} is mode {mode:04o}, expected 0600",
                    paths.key_path(&spec.name).display()
                ),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pki::catalog::CertificateSpec;
    use crate::pki::issue::{create_ca, issue_leaf, load_ca, CaOptions};
    use crate::pki::revocation::{revoke, RevokeSelector};
    use crate::pki::timeutil::DAY_SECONDS;

    fn temp_paths(tag: &str) -> PkiPaths {
        let dir = std::env::temp_dir().join(format!(
            "pgctl-verify-{}-{}-{tag}",
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
        let mut core = CertificateSpec::new(
            "core-back",
            "core-back.internal",
            CertKind::ServerClient,
            90,
        );
        core.dns_sans = vec!["core-back.internal".to_owned()];
        core.ip_sans = vec!["10.0.0.11".to_owned(), "127.0.0.1".to_owned()];
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
        (paths, now)
    }

    fn specs() -> Vec<CertificateSpec> {
        let mut core = CertificateSpec::new(
            "core-back",
            "core-back.internal",
            CertKind::ServerClient,
            90,
        );
        core.dns_sans = vec!["core-back.internal".to_owned()];
        core.ip_sans = vec!["10.0.0.11".to_owned(), "127.0.0.1".to_owned()];
        core.normalize().expect("spec");
        let mut client =
            CertificateSpec::new("admin-back-client", "admin-back", CertKind::Client, 90);
        client.normalize().expect("spec");
        vec![core, client]
    }

    #[test]
    fn healthy_pki_has_no_problems() {
        let (paths, now) = setup("healthy");
        let report = verify(
            &paths,
            &VerifyOptions {
                within_days: 30,
                now,
                expected: Some(&specs()),
            },
        )
        .expect("verify");
        assert!(report.ok, "{:?}", report.problems);
        assert_eq!(report.certificates.len(), 4);
        assert!(report.certificates.iter().all(|row| row.state == "ok"));
        let _ = std::fs::remove_dir_all(paths.dir());
    }

    #[test]
    fn expiry_windows_and_expired_leaves_fail() {
        let (paths, now) = setup("expiry");
        let report = verify(
            &paths,
            &VerifyOptions {
                within_days: 30,
                now: now + 70 * DAY_SECONDS,
                expected: Some(&specs()),
            },
        )
        .expect("verify");
        assert!(!report.ok);
        assert!(
            report
                .problems
                .iter()
                .any(|problem| problem.code == "RENEW"),
            "{:?}",
            report.problems
        );

        let report = verify(
            &paths,
            &VerifyOptions {
                within_days: 30,
                now: now + 100 * DAY_SECONDS,
                expected: Some(&specs()),
            },
        )
        .expect("verify");
        assert!(report
            .problems
            .iter()
            .any(|problem| problem.code == "EXPIRED"));
        let _ = std::fs::remove_dir_all(paths.dir());
    }

    #[test]
    fn san_and_cn_drift_fail_with_the_missing_entry() {
        let (paths, now) = setup("san");
        let mut drifted = specs();
        drifted[0].ip_sans.push("10.9.9.9".to_owned());
        drifted[0].normalize().expect("spec");
        let report = verify(
            &paths,
            &VerifyOptions {
                within_days: 30,
                now,
                expected: Some(&drifted),
            },
        )
        .expect("verify");
        assert!(!report.ok);
        let problem = report
            .problems
            .iter()
            .find(|problem| problem.code == "SAN_MISMATCH")
            .expect("san mismatch");
        assert!(
            problem.message.contains("IP:10.9.9.9"),
            "{}",
            problem.message
        );
        let _ = std::fs::remove_dir_all(paths.dir());
    }

    #[test]
    fn revoked_serial_is_a_problem() {
        let (paths, now) = setup("revoked");
        revoke(&paths, RevokeSelector::Name("admin-back-client"), "", now).expect("revoke");
        let report = verify(
            &paths,
            &VerifyOptions {
                within_days: 30,
                now,
                expected: Some(&specs()),
            },
        )
        .expect("verify");
        assert!(!report.ok);
        assert!(report
            .problems
            .iter()
            .any(|problem| problem.code == "REVOKED" && problem.name == "admin-back-client"));
        let _ = std::fs::remove_dir_all(paths.dir());
    }

    #[test]
    fn a_tampered_certificate_fails_chain_verification() {
        let (paths, now) = setup("tamper");
        let path = paths.cert_path("core-back");
        let mut bytes = std::fs::read(&path).expect("read");
        // Flip a byte inside the base64 body; the PEM still parses as text but the DER is invalid,
        // so the file must be rejected (PARSE) or fail the chain check.
        let marker = b"-----BEGIN CERTIFICATE-----";
        let start = bytes
            .windows(marker.len())
            .position(|window| window == marker)
            .expect("pem");
        let index = start + marker.len() + 10;
        bytes[index] = if bytes[index] == b'A' { b'B' } else { b'A' };
        std::fs::write(&path, bytes).expect("write");
        let report = verify(
            &paths,
            &VerifyOptions {
                within_days: 30,
                now,
                expected: Some(&specs()),
            },
        )
        .expect("verify");
        assert!(!report.ok);
        assert!(report
            .problems
            .iter()
            .any(|problem| matches!(problem.code.as_str(), "PARSE" | "CHAIN" | "MISSING")));
        let _ = std::fs::remove_dir_all(paths.dir());
    }

    #[test]
    fn a_readable_private_key_fails() {
        let (paths, now) = setup("mode");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(
                paths.key_path("core-back"),
                std::fs::Permissions::from_mode(0o644),
            )
            .expect("chmod");
        }
        let report = verify(
            &paths,
            &VerifyOptions {
                within_days: 30,
                now,
                expected: Some(&specs()),
            },
        )
        .expect("verify");
        #[cfg(unix)]
        {
            assert!(!report.ok);
            assert!(report
                .problems
                .iter()
                .any(|problem| problem.code == "KEY_MODE"));
        }
        let _ = std::fs::remove_dir_all(paths.dir());
    }

    #[test]
    fn a_missing_certificate_is_reported() {
        let (paths, now) = setup("missing");
        std::fs::remove_file(paths.cert_path("admin-back-client")).expect("remove");
        let report = verify(
            &paths,
            &VerifyOptions {
                within_days: 30,
                now,
                expected: Some(&specs()),
            },
        )
        .expect("verify");
        assert!(report
            .problems
            .iter()
            .any(|problem| problem.code == "MISSING" && problem.name == "admin-back-client"));
        let _ = std::fs::remove_dir_all(paths.dir());
    }
}

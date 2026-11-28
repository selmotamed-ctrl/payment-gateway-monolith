//! `pgctl release sign|verify` using minisign (D1-T01).
//!
//! Signatures are standard `.minisig` files (`minisign` crate, prehashed BLAKE2b like the CLI).
//! Key material never appears in argv: the secret key path is an argument, its password is read
//! from `MINISIGN_PASSWORD` only.

#![forbid(unsafe_code)]

use std::io::BufReader;
use std::path::{Path, PathBuf};

use minisign::{PublicKey, SecretKey, SignatureBox};

use crate::release::ReleaseError;
use crate::util;

/// What a verified signature says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignatureInfo {
    /// Trusted comment (release id / timestamp).
    pub trusted_comment: String,
    /// Signature file path.
    pub signature_path: PathBuf,
    /// Archive SHA-256 (computed while verifying).
    pub sha256: String,
}

/// Sign an archive, writing `<archive>.minisig`.
pub fn sign_file(
    archive: &Path,
    key_path: &Path,
    password: Option<String>,
    trusted_comment: &str,
) -> Result<PathBuf, ReleaseError> {
    if !archive.is_file() {
        return Err(ReleaseError::Sign(format!(
            "{} is not a file",
            archive.display()
        )));
    }
    let key_text = std::fs::read_to_string(util::expand_tilde(key_path))
        .map_err(|error| ReleaseError::io(key_path.display(), error))?;
    let key_box = minisign::SecretKeyBox::from_string(&key_text).map_err(|error| {
        ReleaseError::Sign(format!("cannot load {}: {error}", key_path.display()))
    })?;
    let secret: SecretKey = match password {
        Some(password) => key_box.into_secret_key(Some(password)),
        // No password: the key must be unencrypted. Never prompt in a CLI path.
        None => key_box.into_unencrypted_secret_key(),
    }
    .map_err(|error| {
        ReleaseError::Sign(format!(
            "cannot unlock {}: {error} (set MINISIGN_PASSWORD for an encrypted key)",
            key_path.display()
        ))
    })?;
    let reader =
        std::fs::File::open(archive).map_err(|error| ReleaseError::io(archive.display(), error))?;
    let signature = minisign::sign(
        None,
        &secret,
        BufReader::new(reader),
        Some(trusted_comment),
        Some("pgctl release signature"),
    )
    .map_err(|error| ReleaseError::Sign(error.to_string()))?;
    let path = signature_path(archive);
    util::write_atomic(&path, signature.to_string().as_bytes(), 0o644)
        .map_err(|error| ReleaseError::io(path.display(), error))?;
    Ok(path)
}

/// Verify `<archive>.minisig` against a public key.
pub fn verify_file(archive: &Path, public_key: &Path) -> Result<SignatureInfo, ReleaseError> {
    let signature_path = signature_path(archive);
    let signature = SignatureBox::from_file(&signature_path)
        .map_err(|error| ReleaseError::Verify(format!("{}: {error}", signature_path.display())))?;
    let key = PublicKey::from_file(util::expand_tilde(public_key)).map_err(|error| {
        ReleaseError::Verify(format!("cannot load {}: {error}", public_key.display()))
    })?;
    let reader =
        std::fs::File::open(archive).map_err(|error| ReleaseError::io(archive.display(), error))?;
    minisign::verify(&key, &signature, BufReader::new(reader), true, false, false)
        .map_err(|error| ReleaseError::Verify(error.to_string()))?;
    let trusted_comment = signature
        .trusted_comment()
        .unwrap_or_else(|_| String::new());
    let sha256 =
        util::sha256_file(archive).map_err(|error| ReleaseError::io(archive.display(), error))?;
    Ok(SignatureInfo {
        trusted_comment,
        signature_path,
        sha256,
    })
}

/// `<archive>.minisig`.
#[must_use]
pub fn signature_path(archive: &Path) -> PathBuf {
    let mut name = archive
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "release.tar.zst".to_owned());
    name.push_str(".minisig");
    archive.with_file_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keypair(dir: &Path) -> (PathBuf, PathBuf) {
        let pair = minisign::KeyPair::generate_unencrypted_keypair().expect("keypair");
        let sk_path = dir.join("minisign.key");
        let pk_path = dir.join("minisign.pub");
        let sk_box = pair.sk.to_box(Some("pgctl test key")).expect("sk box");
        let pk_box = pair.pk.to_box().expect("pk box");
        std::fs::write(&sk_path, sk_box.to_string()).expect("write sk");
        std::fs::write(&pk_path, pk_box.to_string()).expect("write pk");
        (sk_path, pk_path)
    }

    #[test]
    fn sign_and_verify_round_trip_and_detect_tampering() {
        let dir = tempfile::tempdir().expect("tempdir");
        let archive = dir.path().join("pg-release-x.tar.zst");
        std::fs::write(&archive, b"release bytes").expect("archive");
        let (sk, pk) = keypair(dir.path());

        let signature = sign_file(&archive, &sk, None, "pgctl release 2026.11.28").expect("sign");
        assert_eq!(signature, dir.path().join("pg-release-x.tar.zst.minisig"));
        assert!(std::fs::read_to_string(&signature)
            .expect("sig")
            .contains("trusted comment"));

        let info = verify_file(&archive, &pk).expect("verify");
        assert_eq!(info.trusted_comment, "pgctl release 2026.11.28");
        assert_eq!(info.sha256, crate::util::sha256_bytes(b"release bytes"));

        std::fs::write(&archive, b"tampered").expect("tamper");
        assert!(verify_file(&archive, &pk).is_err());
    }

    #[test]
    fn signing_a_missing_archive_fails() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (sk, _) = keypair(dir.path());
        let error =
            sign_file(&dir.path().join("nope.tar.zst"), &sk, None, "x").expect_err("missing");
        assert!(matches!(error, ReleaseError::Sign(_)));
    }
}

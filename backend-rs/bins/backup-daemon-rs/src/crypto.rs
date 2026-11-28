//! Authenticated encryption for every backup artifact and WAL segment.
//! Port of `deploy/backup-daemon/src/cryptoEnvelope.ts`.
//!
//! File layout (self-describing, no sidecar needed to decrypt):
//!
//! ```text
//! magic "PGBKv2" (6) | version (1) | salt (16) | iv (12) | ciphertext ... | authTag (16)
//! ```
//!
//! Key hierarchy (HKDF-SHA256, RFC 5869):
//!   payload key  = HKDF(master, salt = random 16 bytes, info = "pg-backup-v2:payload:<target>:<id>")
//!   manifest key = HKDF(master, salt = "pg-backup-v2-catalog", info = "manifest-hmac-sha256")
//!
//! The header plus a `<target>:<id>` context string are bound as GCM additional authenticated
//! data, so a valid ciphertext cannot be moved to another artifact or have its header swapped.
//! Compression (zstd) happens BEFORE encryption.

use std::collections::BTreeMap;
use std::path::Path;

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::fs;
use tokio::process::Command;

use crate::util::{random_bytes, stable_json, temp_sibling};

type HmacSha256 = Hmac<Sha256>;

pub const ENVELOPE_MAGIC: &[u8] = b"PGBKv2";
pub const ENVELOPE_VERSION: u8 = 2;
pub const SALT_BYTES: usize = 16;
pub const IV_BYTES: usize = 12;
pub const TAG_BYTES: usize = 16;
pub const HEADER_BYTES: usize = ENVELOPE_MAGIC.len() + 1 + SALT_BYTES + IV_BYTES;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CryptoError {
    Envelope(String),
    Io(String),
    Hkdf,
    Compression(String),
}

impl std::fmt::Display for CryptoError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Envelope(message) => write!(formatter, "{message}"),
            Self::Io(message) => write!(formatter, "{message}"),
            Self::Hkdf => write!(formatter, "HKDF output length is invalid"),
            Self::Compression(message) => write!(formatter, "{message}"),
        }
    }
}

impl std::error::Error for CryptoError {}

pub fn master_key_from_hex(hex_key: &str) -> Result<Vec<u8>, CryptoError> {
    let normalized = hex_key.trim();
    if normalized.is_empty()
        || !normalized.bytes().all(|byte| byte.is_ascii_hexdigit())
        || !normalized.len().is_multiple_of(2)
        || normalized.len() < 32
    {
        return Err(CryptoError::Envelope(
            "encryption key must be an even-length hex string of at least 16 bytes".to_owned(),
        ));
    }
    hex::decode(normalized)
        .map_err(|_| CryptoError::Envelope("encryption key is not hexadecimal".to_owned()))
}

fn hkdf(ikm: &[u8], salt: &[u8], info: &str) -> Result<Vec<u8>, CryptoError> {
    let hkdf = Hkdf::<Sha256>::new(Some(salt), ikm);
    let mut output = vec![0_u8; 32];
    hkdf.expand(info.as_bytes(), &mut output)
        .map_err(|_| CryptoError::Hkdf)?;
    Ok(output)
}

pub fn derive_payload_key(
    master: &[u8],
    salt: &[u8],
    target: &str,
    id: &str,
) -> Result<Vec<u8>, CryptoError> {
    hkdf(master, salt, &format!("pg-backup-v2:payload:{target}:{id}"))
}

pub fn derive_manifest_key(master: &[u8]) -> Result<Vec<u8>, CryptoError> {
    hkdf(master, b"pg-backup-v2-catalog", "manifest-hmac-sha256")
}

fn aad(header: &[u8], target: &str, id: &str) -> Vec<u8> {
    let mut aad = header.to_vec();
    aad.extend_from_slice(format!("|{target}:{id}").as_bytes());
    aad
}

#[derive(Debug, Clone)]
pub struct EnvelopeContext {
    pub master: Vec<u8>,
    pub target: String,
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SealResult {
    pub salt_hex: String,
    pub iv_hex: String,
    pub auth_tag_hex: String,
    pub sha256_plaintext: String,
    pub sha256_ciphertext: String,
    pub uncompressed_bytes: u64,
    /// Size of the encrypted file on disk.
    pub compressed_bytes: u64,
}

#[derive(Debug, Clone)]
pub struct SealOptions {
    pub master: Vec<u8>,
    pub target: String,
    pub id: String,
    /// `false` for `pg_dump --format=custom` output, which is already compressed.
    pub compress: bool,
    pub level: u8,
}

impl SealOptions {
    #[must_use]
    pub fn new(master: &[u8], target: &str, id: &str) -> Self {
        Self {
            master: master.to_vec(),
            target: target.to_owned(),
            id: id.to_owned(),
            compress: true,
            level: 6,
        }
    }
}

async fn zstd_compress(source: &Path, destination: &Path, level: u8) -> Result<(), CryptoError> {
    let status = Command::new("zstd")
        .arg("-q")
        .arg(format!("-{level}"))
        .arg("-T0")
        .arg("-f")
        .arg("-o")
        .arg(destination)
        .arg(source)
        .status()
        .await
        .map_err(|error| CryptoError::Compression(format!("zstd could not start: {error}")))?;
    if !status.success() {
        return Err(CryptoError::Compression(format!(
            "zstd exited with code {}",
            status.code().unwrap_or(1)
        )));
    }
    Ok(())
}

async fn zstd_decompress(source: &Path, destination: &Path) -> Result<(), CryptoError> {
    let status = Command::new("zstd")
        .arg("-d")
        .arg("-q")
        .arg("-f")
        .arg("-o")
        .arg(destination)
        .arg(source)
        .status()
        .await
        .map_err(|error| CryptoError::Compression(format!("zstd could not start: {error}")))?;
    if !status.success() {
        return Err(CryptoError::Compression(format!(
            "zstd exited with code {}",
            status.code().unwrap_or(1)
        )));
    }
    Ok(())
}

/// source -> sha256(plain) -> [zstd] -> AES-256-GCM -> sha256(cipher) -> temp file -> rename.
///
/// The destination only ever holds a complete, authenticated artifact. The plaintext (and the
/// compressed intermediate) are buffered: the workspace has no `zstd` crate and the CLI writes
/// through files, which is recorded as a deviation from the streaming TS pipeline.
pub async fn seal_file(
    source: &Path,
    dest_path: &Path,
    options: &SealOptions,
) -> Result<SealResult, CryptoError> {
    let plain = fs::read(source)
        .await
        .map_err(|error| CryptoError::Io(format!("{}: {error}", source.display())))?;
    seal_bytes(&plain, dest_path, options).await
}

pub async fn seal_buffer(
    data: &[u8],
    dest_path: &Path,
    options: &SealOptions,
) -> Result<SealResult, CryptoError> {
    seal_bytes(data, dest_path, options).await
}

async fn seal_bytes(
    plain: &[u8],
    dest_path: &Path,
    options: &SealOptions,
) -> Result<SealResult, CryptoError> {
    if let Some(parent) = dest_path.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|error| CryptoError::Io(error.to_string()))?;
    }

    let mut compressed_holder = None;
    let compressed: Vec<u8> = if options.compress {
        let staging = temp_sibling(dest_path).with_extension("zst");
        let plain_path = temp_sibling(dest_path).with_extension("plain");
        fs::write(&plain_path, plain)
            .await
            .map_err(|error| CryptoError::Io(error.to_string()))?;
        let result = zstd_compress(&plain_path, &staging, options.level).await;
        let _ = fs::remove_file(&plain_path).await;
        if let Err(error) = result {
            let _ = fs::remove_file(&staging).await;
            return Err(error);
        }
        let bytes = fs::read(&staging)
            .await
            .map_err(|error| CryptoError::Io(error.to_string()))?;
        compressed_holder = Some(staging);
        bytes
    } else {
        plain.to_vec()
    };

    let salt = random_bytes(SALT_BYTES)?;
    let iv = random_bytes(IV_BYTES)?;
    let mut header = Vec::with_capacity(HEADER_BYTES);
    header.extend_from_slice(ENVELOPE_MAGIC);
    header.push(ENVELOPE_VERSION);
    header.extend_from_slice(&salt);
    header.extend_from_slice(&iv);

    let key = derive_payload_key(&options.master, &salt, &options.target, &options.id)?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| CryptoError::Envelope("invalid payload key".to_owned()))?;
    let mut iv_array = [0_u8; IV_BYTES];
    iv_array.copy_from_slice(&iv);
    let nonce = Nonce::from(iv_array);
    let sealed = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: &compressed,
                aad: &aad(&header, &options.target, &options.id),
            },
        )
        .map_err(|_| CryptoError::Envelope("encryption failed".to_owned()))?;
    if sealed.len() < TAG_BYTES {
        return Err(CryptoError::Envelope(
            "encryption produced no tag".to_owned(),
        ));
    }
    let split = sealed.len() - TAG_BYTES;
    let (body, tag) = sealed.split_at(split);

    let mut ciphertext = header;
    ciphertext.extend_from_slice(body);
    ciphertext.extend_from_slice(tag);

    let tmp = temp_sibling(dest_path);
    let write_result = async {
        use tokio::io::AsyncWriteExt;
        let mut file = fs::File::create(&tmp)
            .await
            .map_err(|error| CryptoError::Io(error.to_string()))?;
        file.write_all(&ciphertext)
            .await
            .map_err(|error| CryptoError::Io(error.to_string()))?;
        file.sync_all()
            .await
            .map_err(|error| CryptoError::Io(error.to_string()))?;
        fs::rename(&tmp, dest_path)
            .await
            .map_err(|error| CryptoError::Io(error.to_string()))
    }
    .await;
    if let Some(holder) = compressed_holder {
        let _ = fs::remove_file(holder).await;
    }
    write_result?;

    Ok(SealResult {
        salt_hex: hex::encode(&salt),
        iv_hex: hex::encode(&iv),
        auth_tag_hex: hex::encode(tag),
        sha256_plaintext: hex::encode(Sha256::digest(plain)),
        sha256_ciphertext: hex::encode(Sha256::digest(&ciphertext)),
        uncompressed_bytes: plain.len() as u64,
        compressed_bytes: ciphertext.len() as u64,
    })
}

#[derive(Debug, Clone)]
pub struct OpenResult {
    pub sha256_plaintext: String,
    pub bytes: u64,
}

/// Descrypts and authenticates an envelope, then decompresses it. Port of `openStream`/`openFile`.
pub async fn open_to_buffer(
    source: &Path,
    master: &[u8],
    target: &str,
    id: &str,
    compress: bool,
) -> Result<Vec<u8>, CryptoError> {
    let ciphertext = fs::read(source)
        .await
        .map_err(|error| CryptoError::Io(format!("{}: {error}", source.display())))?;
    if ciphertext.len() < HEADER_BYTES + TAG_BYTES {
        return Err(CryptoError::Envelope(
            "cipher authentication failed: envelope is truncated".to_owned(),
        ));
    }
    let header = &ciphertext[..HEADER_BYTES];
    if &header[..ENVELOPE_MAGIC.len()] != ENVELOPE_MAGIC {
        return Err(CryptoError::Envelope(
            "not a pg-backup v2 envelope (bad magic)".to_owned(),
        ));
    }
    let version = header[ENVELOPE_MAGIC.len()];
    if version != ENVELOPE_VERSION {
        return Err(CryptoError::Envelope(format!(
            "unsupported envelope version {version}"
        )));
    }
    let salt_start = ENVELOPE_MAGIC.len() + 1;
    let salt = &header[salt_start..salt_start + SALT_BYTES];
    let iv = &header[salt_start + SALT_BYTES..HEADER_BYTES];
    let key = derive_payload_key(master, salt, target, id)?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| CryptoError::Envelope("invalid payload key".to_owned()))?;
    let mut iv_array = [0_u8; IV_BYTES];
    iv_array.copy_from_slice(iv);
    let nonce = Nonce::from(iv_array);
    let body = &ciphertext[HEADER_BYTES..ciphertext.len() - TAG_BYTES];
    let tag = &ciphertext[ciphertext.len() - TAG_BYTES..];
    let mut sealed = body.to_vec();
    sealed.extend_from_slice(tag);
    let compressed = cipher
        .decrypt(
            &nonce,
            Payload {
                msg: &sealed,
                aad: &aad(header, target, id),
            },
        )
        .map_err(|_| {
            CryptoError::Envelope(
                "cipher authentication failed: ciphertext, header or context was modified"
                    .to_owned(),
            )
        })?;

    if !compress {
        return Ok(compressed);
    }
    let staging = tempfile::tempdir().map_err(|error| CryptoError::Io(error.to_string()))?;
    let input = staging.path().join("payload.zst");
    let output = staging.path().join("payload");
    fs::write(&input, &compressed)
        .await
        .map_err(|error| CryptoError::Io(error.to_string()))?;
    zstd_decompress(&input, &output).await?;
    fs::read(&output)
        .await
        .map_err(|error| CryptoError::Io(error.to_string()))
}

/// Decrypts to a temp file and renames it into place only after authentication succeeds.
pub async fn open_to_file(
    source: &Path,
    dest_path: &Path,
    master: &[u8],
    target: &str,
    id: &str,
    compress: bool,
) -> Result<OpenResult, CryptoError> {
    let plain = open_to_buffer(source, master, target, id, compress).await?;
    if let Some(parent) = dest_path.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|error| CryptoError::Io(error.to_string()))?;
    }
    let tmp = temp_sibling(dest_path);
    let write_result = async {
        use tokio::io::AsyncWriteExt;
        let mut file = fs::File::create(&tmp)
            .await
            .map_err(|error| CryptoError::Io(error.to_string()))?;
        file.write_all(&plain)
            .await
            .map_err(|error| CryptoError::Io(error.to_string()))?;
        file.sync_all()
            .await
            .map_err(|error| CryptoError::Io(error.to_string()))?;
        fs::rename(&tmp, dest_path)
            .await
            .map_err(|error| CryptoError::Io(error.to_string()))
    }
    .await;
    if write_result.is_err() {
        let _ = fs::remove_file(&tmp).await;
    }
    write_result?;
    Ok(OpenResult {
        sha256_plaintext: hex::encode(Sha256::digest(&plain)),
        bytes: plain.len() as u64,
    })
}

// ---------------------------------------------------------------------------
// Signed manifests
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManifestEncryption {
    pub algorithm: String,
    pub kdf: String,
    pub salt_hex: String,
    pub iv_hex: String,
    pub auth_tag_hex: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PgVerifyBackup {
    pub verified: bool,
    pub manifest_checksum_algorithm: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRecord {
    pub sha256_ciphertext: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupManifest {
    pub schema_version: u32,
    pub backup_id: String,
    pub target: String,
    pub kind: String,
    pub engine: String,
    pub cluster_topology: String,
    pub started_at: String,
    pub completed_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_lsn: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_lsn: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wal_segment_start: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wal_segment_end: Option<String>,
    /// Backup chain: the manifest id this incremental backup was taken against.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_backup_id: Option<String>,
    pub uncompressed_bytes: u64,
    pub compressed_bytes: u64,
    pub sha256_plaintext: String,
    pub sha256_ciphertext: String,
    pub encryption: ManifestEncryption,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pg_verify_backup: Option<PgVerifyBackup>,
    /// Companion artifacts (logical dumps) recorded as file name -> sha256 of ciphertext.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifacts: Option<BTreeMap<String, ArtifactRecord>>,
    pub storage_targets: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

fn manifest_payload(manifest: &BackupManifest) -> String {
    let mut value = serde_json::to_value(manifest).unwrap_or(Value::Null);
    if let Value::Object(map) = &mut value {
        map.remove("signature");
    }
    stable_json(&value)
}

pub fn sign_manifest(
    manifest: &BackupManifest,
    master: &[u8],
) -> Result<BackupManifest, CryptoError> {
    let key = derive_manifest_key(master)?;
    let mut mac = HmacSha256::new_from_slice(&key)
        .map_err(|_| CryptoError::Envelope("invalid manifest key".to_owned()))?;
    mac.update(manifest_payload(manifest).as_bytes());
    let signature = hex::encode(mac.finalize().into_bytes());
    let mut signed = manifest.clone();
    signed.signature = Some(signature);
    Ok(signed)
}

pub fn verify_manifest_signature(manifest: &BackupManifest, master: &[u8]) -> bool {
    let Some(signature) = manifest.signature.as_deref() else {
        return false;
    };
    if signature.is_empty() {
        return false;
    }
    let Ok(key) = derive_manifest_key(master) else {
        return false;
    };
    let Ok(mut mac) = HmacSha256::new_from_slice(&key) else {
        return false;
    };
    mac.update(manifest_payload(manifest).as_bytes());
    match hex::decode(signature) {
        Ok(actual) => mac.verify_slice(&actual).is_ok(),
        Err(_) => false,
    }
}

/// Signs arbitrary catalog JSON text (used for catalog mirroring).
pub fn sign_text(text: &str, master: &[u8]) -> Result<String, CryptoError> {
    let key = derive_manifest_key(master)?;
    let mut mac = HmacSha256::new_from_slice(&key)
        .map_err(|_| CryptoError::Envelope("invalid manifest key".to_owned()))?;
    mac.update(text.as_bytes());
    Ok(hex::encode(mac.finalize().into_bytes()))
}

pub fn verify_text_signature(text: &str, signature: &str, master: &[u8]) -> bool {
    let Ok(expected) = sign_text(text, master) else {
        return false;
    };
    let expected_bytes = hex::decode(expected).unwrap_or_default();
    let cleaned: String = signature.chars().filter(char::is_ascii_hexdigit).collect();
    let Ok(actual) = hex::decode(cleaned) else {
        return false;
    };
    if actual.len() != expected_bytes.len() {
        return false;
    }
    // Constant-time comparison of the two MACs.
    let mut difference = 0_u8;
    for (left, right) in expected_bytes.iter().zip(actual.iter()) {
        difference |= left ^ right;
    }
    difference == 0
}

fn hmac_key_from_hex(key_hex: &str) -> Vec<u8> {
    let normalized = key_hex.trim();
    if !normalized.is_empty()
        && normalized.bytes().all(|byte| byte.is_ascii_hexdigit())
        && normalized.len().is_multiple_of(2)
    {
        hex::decode(normalized).unwrap_or_else(|_| normalized.as_bytes().to_vec())
    } else {
        normalized.as_bytes().to_vec()
    }
}

/// HMAC-SHA256 over a stable-JSON payload with the raw (hex) key bytes.
pub fn sign_stable_json(payload: &Value, key_hex: &str) -> Result<String, CryptoError> {
    let key = hmac_key_from_hex(key_hex);
    let mut mac = HmacSha256::new_from_slice(&key)
        .map_err(|_| CryptoError::Envelope("invalid HMAC key".to_owned()))?;
    mac.update(stable_json(payload).as_bytes());
    Ok(hex::encode(mac.finalize().into_bytes()))
}

#[must_use]
pub fn verify_stable_json(payload: &Value, signature: &str, key_hex: &str) -> bool {
    let Ok(expected_hex) = sign_stable_json(payload, key_hex) else {
        return false;
    };
    let Ok(expected) = hex::decode(expected_hex) else {
        return false;
    };
    let Ok(actual) = hex::decode(signature) else {
        return false;
    };
    if actual.len() != expected.len() {
        return false;
    }
    let mut difference = 0_u8;
    for (left, right) in expected.iter().zip(actual.iter()) {
        difference |= left ^ right;
    }
    difference == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn master_key_rejects_short_and_malformed_values() {
        assert!(master_key_from_hex("abcd").is_err());
        assert!(master_key_from_hex(&"zz".repeat(16)).is_err());
        assert!(master_key_from_hex(&"a".repeat(33)).is_err());
    }

    #[test]
    fn payload_keys_are_domain_separated() {
        let master = master_key_from_hex(KEY).expect("key");
        let salt = vec![7_u8; SALT_BYTES];
        let base = derive_payload_key(&master, &salt, "postgres_core", "bkp_1").expect("key");
        let variants = [
            derive_payload_key(&master, &salt, "audit_db", "bkp_1").expect("key"),
            derive_payload_key(&master, &salt, "redis", "bkp_1").expect("key"),
            derive_payload_key(&master, &salt, "postgres_core", "bkp_2").expect("key"),
            derive_payload_key(&master, &[8_u8; SALT_BYTES], "postgres_core", "bkp_1")
                .expect("key"),
        ];
        for variant in variants {
            assert_ne!(variant, base);
        }
        assert_ne!(
            derive_manifest_key(&master).expect("key"),
            derive_payload_key(&master, &[0_u8; SALT_BYTES], "catalog", "x").expect("key")
        );
    }
}

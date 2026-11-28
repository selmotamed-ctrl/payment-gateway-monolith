//! Column-encryption vault.
//!
//! Port of `core-back/engine/crypto/Vault.ts`. Stored form: `keyId:b64(iv12):b64(tag16):b64(ct)`.
//! AES-256-GCM with AAD = keyId. Key resolution order is identical to the TS implementation.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::fmt;
use std::sync::OnceLock;

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use rand::RngCore;

use crate::digest::{
    decode_base64_strict, hkdf_sha256, hmac_sha256, sha256, timing_safe_string_equal,
};

pub const VAULT_KEY_ID_REGEX: &str = r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$";
const VAULT_INFO: &[u8] = b"payment-gateway:vault:aes-256-gcm:v1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VaultError {
    InvalidKeyId,
    InvalidPayload(&'static str),
    InvalidKmsKeys(&'static str),
    InvalidMasterKey(&'static str),
    KeyNotFound(String),
    AuthenticationFailed,
    InvalidPlaintext,
    CryptoLength,
}

impl fmt::Display for VaultError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidKeyId => f.write_str("Vault key ID is invalid"),
            Self::InvalidPayload(message) => write!(f, "{message}"),
            Self::InvalidKmsKeys(message) => write!(f, "{message}"),
            Self::InvalidMasterKey(message) => write!(f, "{message}"),
            Self::KeyNotFound(key) => write!(f, "No vault key is available for key ID '{key}'"),
            Self::AuthenticationFailed => f.write_str("Vault payload authentication failed"),
            Self::InvalidPlaintext => f.write_str("Vault plaintext must be a string"),
            Self::CryptoLength => f.write_str("Vault nonce has an invalid length"),
        }
    }
}

impl std::error::Error for VaultError {}

/// `assertValidVaultKeyId`; implemented without a regex dependency.
pub fn assert_valid_key_id(key_id: &str) -> Result<(), VaultError> {
    if key_id.is_empty() || key_id.len() > 64 {
        return Err(VaultError::InvalidKeyId);
    }
    let mut bytes = key_id.bytes();
    let first = bytes.next().ok_or(VaultError::InvalidKeyId)?;
    if !first.is_ascii_alphanumeric() {
        return Err(VaultError::InvalidKeyId);
    }
    if !bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-') {
        return Err(VaultError::InvalidKeyId);
    }
    Ok(())
}

/// A 32-byte AES key.
pub type VaultKey = [u8; 32];

/// Resolve a vault key by id. The environment resolver below is the default; KMS/HSM resolvers
/// plug in through this trait.
pub trait VaultKeyResolver: Send + Sync {
    fn resolve_key(&self, key_id: &str) -> Result<VaultKey, VaultError>;
}

/// Environment-backed resolver (`KMS_KEYS_JSON`, `KMS_MASTER_KEY`).
#[derive(Debug, Default)]
pub struct EnvironmentKeyResolver {
    source: BTreeMap<String, String>,
    material: OnceLock<Result<KeyMaterial, VaultError>>,
}

#[derive(Debug, Default)]
struct KeyMaterial {
    direct_keys: BTreeMap<String, VaultKey>,
    master_key: Option<VaultKey>,
}

impl EnvironmentKeyResolver {
    /// Build from an explicit map (tests, embedders). Mirrors reading `process.env`.
    #[must_use]
    pub fn from_map(env: BTreeMap<String, String>) -> Self {
        Self {
            source: env,
            material: OnceLock::new(),
        }
    }

    /// Build from the process environment.
    #[must_use]
    pub fn from_process_env() -> Self {
        let mut map = BTreeMap::new();
        for key in ["KMS_KEYS_JSON", "KMS_MASTER_KEY"] {
            if let Ok(value) = std::env::var(key) {
                map.insert(key.to_owned(), value);
            }
        }
        Self::from_map(map)
    }

    fn material(&self) -> Result<&KeyMaterial, VaultError> {
        self.material
            .get_or_init(|| load_material(&self.source))
            .as_ref()
            .map_err(Clone::clone)
    }
}

impl VaultKeyResolver for EnvironmentKeyResolver {
    fn resolve_key(&self, key_id: &str) -> Result<VaultKey, VaultError> {
        assert_valid_key_id(key_id)?;
        let material = self.material()?;
        if let Some(key) = material.direct_keys.get(key_id) {
            return Ok(*key);
        }
        if let Some(master) = material.master_key {
            let derived = hkdf_sha256(&master, key_id.as_bytes(), VAULT_INFO, 32)
                .map_err(|_| VaultError::InvalidMasterKey("HKDF failed"))?;
            let mut key = [0_u8; 32];
            key.copy_from_slice(&derived);
            return Ok(key);
        }
        Err(VaultError::KeyNotFound(key_id.to_owned()))
    }
}

fn load_material(source: &BTreeMap<String, String>) -> Result<KeyMaterial, VaultError> {
    let mut direct = BTreeMap::new();
    let mut master = None;
    if let Some(encoded) = source.get("KMS_KEYS_JSON") {
        direct = parse_environment_keys(encoded)?;
    }
    if let Some(master_raw) = source.get("KMS_MASTER_KEY") {
        let trimmed = master_raw.trim();
        if trimmed.starts_with('{') {
            direct = parse_environment_keys(trimmed)?;
        } else if let Some((key_id, encoded)) = trimmed.split_once(':') {
            assert_valid_key_id(key_id)?;
            let key = decode_strict_key(encoded)?;
            direct.insert(key_id.to_owned(), key);
        } else {
            master = Some(normalize_master_key(trimmed.as_bytes())?);
        }
    }
    Ok(KeyMaterial {
        direct_keys: direct,
        master_key: master,
    })
}

fn parse_environment_keys(value: &str) -> Result<BTreeMap<String, VaultKey>, VaultError> {
    let parsed: serde_json::Value = serde_json::from_str(value)
        .map_err(|_| VaultError::InvalidKmsKeys("KMS_KEYS_JSON must contain a JSON object"))?;
    let object = parsed.as_object().ok_or(VaultError::InvalidKmsKeys(
        "KMS_KEYS_JSON must contain a JSON object",
    ))?;
    let mut keys = BTreeMap::new();
    for (key_id, encoded) in object {
        assert_valid_key_id(key_id)?;
        let encoded = encoded.as_str().ok_or(VaultError::InvalidKmsKeys(
            "KMS key values must be base64 strings",
        ))?;
        let bytes = decode_base64_strict(encoded)
            .map_err(|_| VaultError::InvalidKmsKeys("KMS key values must be base64 strings"))?;
        keys.insert(key_id.clone(), to_key(&bytes)?);
    }
    Ok(keys)
}

fn decode_strict_key(value: &str) -> Result<VaultKey, VaultError> {
    let bytes = decode_base64_strict(value)
        .map_err(|_| VaultError::InvalidKmsKeys("KMS key values must be base64 strings"))?;
    to_key(&bytes)
}

fn to_key(bytes: &[u8]) -> Result<VaultKey, VaultError> {
    if bytes.len() != 32 {
        return Err(VaultError::InvalidKmsKeys(
            "KMS key values must decode to 32 bytes",
        ));
    }
    let mut key = [0_u8; 32];
    key.copy_from_slice(bytes);
    Ok(key)
}

/// `normalizeMasterKey`: 32 raw bytes, else canonical base64 decoding to 32 bytes, else SHA-256.
pub fn normalize_master_key(raw: &[u8]) -> Result<VaultKey, VaultError> {
    if raw.len() == 32 {
        return to_key(raw);
    }
    if raw.is_empty() {
        return Err(VaultError::InvalidMasterKey(
            "KMS master key cannot be empty",
        ));
    }
    let text = String::from_utf8_lossy(raw);
    let trimmed = text.trim();
    if let Ok(bytes) = decode_base64_strict(trimmed) {
        if bytes.len() == 32 {
            return to_key(&bytes);
        }
    }
    let digest = sha256(raw);
    to_key(&digest)
}

/// A configured vault.
pub struct Vault<R: VaultKeyResolver> {
    resolver: R,
}

impl<R: VaultKeyResolver> Vault<R> {
    #[must_use]
    pub fn new(resolver: R) -> Self {
        Self { resolver }
    }

    pub fn encrypt_secret(&self, plaintext: &str, key_id: &str) -> Result<String, VaultError> {
        assert_valid_key_id(key_id)?;
        let key = self.resolver.resolve_key(key_id)?;
        let cipher = Aes256Gcm::new_from_slice(&key)
            .map_err(|_| VaultError::InvalidKmsKeys("invalid key"))?;
        let mut iv = [0_u8; 12];
        rand::rng().fill_bytes(&mut iv);
        let nonce = Nonce::from(iv);
        let ciphertext = cipher
            .encrypt(
                &nonce,
                Payload {
                    msg: plaintext.as_bytes(),
                    aad: key_id.as_bytes(),
                },
            )
            .map_err(|_| VaultError::AuthenticationFailed)?;
        // aes-gcm appends the 16-byte tag.
        let split = ciphertext.len() - 16;
        let (body, tag) = ciphertext.split_at(split);
        Ok(format!(
            "{key_id}:{}:{}:{}",
            STANDARD.encode(iv),
            STANDARD.encode(tag),
            STANDARD.encode(body)
        ))
    }

    pub fn decrypt_secret(&self, payload: &str) -> Result<String, VaultError> {
        let parts: Vec<&str> = payload.split(':').collect();
        if parts.len() != 4 {
            return Err(VaultError::InvalidPayload(
                "Vault payload must contain keyId:iv:authTag:ciphertext",
            ));
        }
        let (key_id, iv_encoded, tag_encoded, ciphertext_encoded) =
            (parts[0], parts[1], parts[2], parts[3]);
        assert_valid_key_id(key_id)?;
        let iv = decode_base64_strict(iv_encoded)
            .map_err(|_| VaultError::InvalidPayload("Vault payload contains invalid base64"))?;
        let tag = decode_base64_strict(tag_encoded)
            .map_err(|_| VaultError::InvalidPayload("Vault payload contains invalid base64"))?;
        let ciphertext = decode_base64_strict(ciphertext_encoded)
            .map_err(|_| VaultError::InvalidPayload("Vault payload contains invalid base64"))?;
        if iv.len() != 12 || tag.len() != 16 {
            return Err(VaultError::InvalidPayload(
                "Vault IV or authentication tag has an invalid length",
            ));
        }
        let key = self.resolver.resolve_key(key_id)?;
        let cipher = Aes256Gcm::new_from_slice(&key)
            .map_err(|_| VaultError::InvalidKmsKeys("invalid key"))?;
        let mut sealed = ciphertext;
        sealed.extend_from_slice(&tag);
        let nonce = Nonce::try_from(iv.as_slice()).map_err(|_| VaultError::CryptoLength)?;
        let plaintext = cipher
            .decrypt(
                &nonce,
                Payload {
                    msg: &sealed,
                    aad: key_id.as_bytes(),
                },
            )
            .map_err(|_| VaultError::AuthenticationFailed)?;
        String::from_utf8(plaintext).map_err(|_| VaultError::AuthenticationFailed)
    }

    /// HMAC-SHA256 (hex) under the derived key; used by the audit anchor.
    pub fn sign(&self, data: &str, key_id: &str) -> Result<String, VaultError> {
        assert_valid_key_id(key_id)?;
        let key = self.resolver.resolve_key(key_id)?;
        Ok(hex::encode(hmac_sha256(&key, data.as_bytes())))
    }

    pub fn verify_signature(
        &self,
        data: &str,
        signature: &str,
        key_id: &str,
    ) -> Result<bool, VaultError> {
        // The TS contract is lowercase hex only; an uppercase digest is rejected, not normalised.
        if signature.len() != 64
            || !signature
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Ok(false);
        }
        let expected = self.sign(data, key_id)?;
        Ok(timing_safe_string_equal(
            expected.as_bytes(),
            signature.to_ascii_lowercase().as_bytes(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolver() -> EnvironmentKeyResolver {
        let mut map = BTreeMap::new();
        let key = STANDARD.encode([7_u8; 32]);
        map.insert(
            "KMS_KEYS_JSON".to_owned(),
            format!(r#"{{"test-key":"{key}"}}"#),
        );
        EnvironmentKeyResolver::from_map(map)
    }

    #[test]
    fn round_trip_and_format() {
        let vault = Vault::new(resolver());
        let sealed = vault.encrypt_secret("hello", "test-key").expect("seal");
        assert_eq!(sealed.split(':').count(), 4);
        assert_eq!(vault.decrypt_secret(&sealed).expect("open"), "hello");
    }

    #[test]
    fn wrong_aad_or_tamper_fails() {
        let vault = Vault::new(resolver());
        let sealed = vault.encrypt_secret("hello", "test-key").expect("seal");
        let mut parts: Vec<&str> = sealed.split(':').collect();
        parts[3] = "AAAA";
        assert!(matches!(
            vault.decrypt_secret(&parts.join(":")),
            Err(VaultError::AuthenticationFailed)
        ));
    }

    #[test]
    fn unknown_key_is_rejected() {
        let vault = Vault::new(resolver());
        assert!(matches!(
            vault.encrypt_secret("x", "missing"),
            Err(VaultError::KeyNotFound(_))
        ));
    }

    #[test]
    fn master_key_derivation_is_stable() {
        let master = normalize_master_key(b"a-master-key-that-is-not-32-bytes").expect("key");
        assert_eq!(master, sha256(b"a-master-key-that-is-not-32-bytes")[..]);
    }
}

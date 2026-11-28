//! `pgos1` object envelope.
//!
//! Port of `core-back/lib/objectStorageSdk/crypto.ts:142-154`:
//! `pgos1` | frames `u32be(len) | ciphertext | tag(16)`; chunk nonce
//! `prefix[0..7] | u32be(index) | u8(final)`; AAD `uuidBytes | u32be(index) | u8(final)`;
//! DEK wrapped under the active KEK with AAD `dek:<objectId>:v<N>`.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zeroize::Zeroizing;

const MAGIC: &[u8; 5] = b"pgos1";
pub const DEFAULT_CHUNK_SIZE: usize = 64 * 1024;
pub const MIN_CHUNK_SIZE: usize = 4 * 1024;
pub const MAX_CHUNK_SIZE: usize = 16 * 1024 * 1024;
pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Pgos1Error {
    EmptyPayload,
    InvalidMagic,
    InvalidChunkSize(usize),
    FrameTooLarge(usize),
    Truncated,
    UnknownKek(u32),
    Crypto,
    SizeMismatch,
    HashMismatch,
    BadKeyring(String),
}

impl std::fmt::Display for Pgos1Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyPayload => f.write_str("refusing to encrypt an empty payload"),
            Self::InvalidMagic => f.write_str("missing pgos1 magic"),
            Self::InvalidChunkSize(size) => write!(f, "chunk size {size} is outside 4 KiB..16 MiB"),
            Self::FrameTooLarge(size) => write!(f, "pgos1 frame of {size} bytes exceeds 16 MiB"),
            Self::Truncated => f.write_str("pgos1 stream is truncated"),
            Self::UnknownKek(version) => write!(f, "KEK version {version} is not in the keyring"),
            Self::Crypto => f.write_str("pgos1 authentication failed"),
            Self::SizeMismatch => f.write_str("pgos1 plaintext size does not match metadata"),
            Self::HashMismatch => f.write_str("pgos1 plaintext SHA-256 does not match metadata"),
            Self::BadKeyring(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for Pgos1Error {}

/// Parsed `OBJECT_STORAGE_KEK_KEYRING="v1:<64hex>,v2:<64hex>"`.
#[derive(Debug, Clone)]
pub struct KekKeyring {
    keys: BTreeMap<u32, [u8; 32]>,
    active: u32,
}

impl KekKeyring {
    pub fn parse(spec: &str, active: Option<u32>) -> Result<Self, Pgos1Error> {
        let mut keys = BTreeMap::new();
        for entry in spec.split(',') {
            let entry = entry.trim();
            if entry.is_empty() {
                continue;
            }
            let Some((version, hex_key)) = entry.split_once(':') else {
                return Err(Pgos1Error::BadKeyring(
                    "each keyring entry must be v<N>:<64 hex characters>".to_owned(),
                ));
            };
            let version = version
                .trim()
                .strip_prefix('v')
                .and_then(|value| value.parse::<u32>().ok())
                .ok_or_else(|| {
                    Pgos1Error::BadKeyring("keyring version must look like v1".to_owned())
                })?;
            let bytes = hex::decode(hex_key.trim()).map_err(|_| {
                Pgos1Error::BadKeyring("keyring keys must be 32-byte hex strings".to_owned())
            })?;
            let key: [u8; 32] = bytes.try_into().map_err(|_| {
                Pgos1Error::BadKeyring("keyring keys must be 32-byte hex strings".to_owned())
            })?;
            keys.insert(version, key);
        }
        if keys.is_empty() {
            return Err(Pgos1Error::BadKeyring("keyring is empty".to_owned()));
        }
        let active = match active {
            Some(active) => active,
            None => *keys.keys().next_back().expect("non-empty"),
        };
        if !keys.contains_key(&active) {
            return Err(Pgos1Error::BadKeyring(format!(
                "active KEK version {active} is not in the keyring"
            )));
        }
        for (version, key) in &keys {
            if key.iter().all(|byte| *byte == 0) {
                return Err(Pgos1Error::BadKeyring(format!(
                    "KEK v{version} is all zeroes"
                )));
            }
        }
        Ok(Self { keys, active })
    }

    #[must_use]
    pub fn active_version(&self) -> u32 {
        self.active
    }

    fn key(&self, version: u32) -> Result<[u8; 32], Pgos1Error> {
        self.keys
            .get(&version)
            .copied()
            .ok_or(Pgos1Error::UnknownKek(version))
    }
}

/// The development fallback `SHA-256(DATABASE_URL)`. Refused in production by the caller.
#[must_use]
pub fn dev_kek_from_database_url(database_url: &str) -> [u8; 32] {
    let digest = Sha256::digest(database_url.as_bytes());
    let mut key = [0_u8; 32];
    key.copy_from_slice(&digest);
    key
}

/// Everything the control plane stores next to a `pgos1` blob.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObjectCryptoMetadata {
    pub kek_version: u32,
    pub wrapped_dek: String,
    pub dek_nonce: String,
    pub stream_prefix: String,
    pub chunk_size: u64,
    pub chunk_count: u64,
    pub plaintext_sha256: String,
    pub plaintext_size: u64,
}

/// Encrypt `plaintext` into the `pgos1` stream; returns the bytes and metadata.
pub fn seal_pgos1(
    object_id: Uuid,
    plaintext: &[u8],
    keyring: &KekKeyring,
    chunk_size: Option<usize>,
) -> Result<(Vec<u8>, ObjectCryptoMetadata), Pgos1Error> {
    if plaintext.is_empty() {
        return Err(Pgos1Error::EmptyPayload);
    }
    let chunk_size = chunk_size.unwrap_or(DEFAULT_CHUNK_SIZE);
    if !(MIN_CHUNK_SIZE..=MAX_CHUNK_SIZE).contains(&chunk_size) {
        return Err(Pgos1Error::InvalidChunkSize(chunk_size));
    }
    let mut dek = [0_u8; 32];
    rand::rng().fill_bytes(&mut dek);
    let mut prefix = [0_u8; 7];
    rand::rng().fill_bytes(&mut prefix);
    let cipher = Aes256Gcm::new_from_slice(&dek).map_err(|_| Pgos1Error::Crypto)?;

    let chunks: Vec<&[u8]> = plaintext.chunks(chunk_size).collect();
    let chunk_count = chunks.len();
    let mut output = Vec::with_capacity(plaintext.len() + chunk_count * 21 + MAGIC.len());
    output.extend_from_slice(MAGIC);

    for (index, chunk) in chunks.iter().enumerate() {
        let final_flag = index + 1 == chunk_count;
        let nonce = Nonce::from(chunk_nonce(&prefix, index as u32, final_flag));
        let aad = chunk_aad(object_id, index as u32, final_flag);
        let sealed = cipher
            .encrypt(
                &nonce,
                Payload {
                    msg: chunk,
                    aad: &aad,
                },
            )
            .map_err(|_| Pgos1Error::Crypto)?;
        if chunk.len() > MAX_FRAME_BYTES {
            return Err(Pgos1Error::FrameTooLarge(chunk.len()));
        }
        // TS writes the PLAINTEXT length; the tag follows the ciphertext.
        output.extend_from_slice(&(chunk.len() as u32).to_be_bytes());
        output.extend_from_slice(&sealed);
    }

    let kek = keyring.key(keyring.active_version())?;
    let kek_cipher = Aes256Gcm::new_from_slice(&kek).map_err(|_| Pgos1Error::Crypto)?;
    let mut dek_nonce = [0_u8; 12];
    rand::rng().fill_bytes(&mut dek_nonce);
    let wrap_aad = format!("dek:{object_id}:v{}", keyring.active_version());
    let dek_nonce_value = Nonce::from(dek_nonce);
    let wrapped = kek_cipher
        .encrypt(
            &dek_nonce_value,
            Payload {
                msg: &dek,
                aad: wrap_aad.as_bytes(),
            },
        )
        .map_err(|_| Pgos1Error::Crypto)?;

    let sha = Sha256::digest(plaintext);
    let metadata = ObjectCryptoMetadata {
        kek_version: keyring.active_version(),
        wrapped_dek: base64_encode(&wrapped),
        dek_nonce: base64_encode(&dek_nonce),
        stream_prefix: base64_encode(&prefix),
        chunk_size: chunk_size as u64,
        chunk_count: chunk_count as u64,
        plaintext_sha256: hex::encode(sha),
        plaintext_size: plaintext.len() as u64,
    };
    Ok((output, metadata))
}

/// Decrypt a `pgos1` stream and verify size and SHA-256.
pub fn decrypt_pgos1(
    object_id: Uuid,
    stream: &[u8],
    keyring: &KekKeyring,
    metadata: &ObjectCryptoMetadata,
) -> Result<Vec<u8>, Pgos1Error> {
    if stream.len() < MAGIC.len() || &stream[..MAGIC.len()] != MAGIC {
        return Err(Pgos1Error::InvalidMagic);
    }
    let chunk_size = metadata.chunk_size as usize;
    if !(MIN_CHUNK_SIZE..=MAX_CHUNK_SIZE).contains(&chunk_size) {
        return Err(Pgos1Error::InvalidChunkSize(chunk_size));
    }
    let kek = keyring.key(metadata.kek_version)?;
    let kek_cipher = Aes256Gcm::new_from_slice(&kek).map_err(|_| Pgos1Error::Crypto)?;
    let dek_nonce = base64_decode(&metadata.dek_nonce)?;
    if dek_nonce.len() != 12 {
        return Err(Pgos1Error::Crypto);
    }
    let wrapped = base64_decode(&metadata.wrapped_dek)?;
    let wrap_aad = format!("dek:{object_id}:v{}", metadata.kek_version);
    let dek_nonce_value = Nonce::try_from(dek_nonce.as_slice()).map_err(|_| Pgos1Error::Crypto)?;
    let dek = kek_cipher
        .decrypt(
            &dek_nonce_value,
            Payload {
                msg: &wrapped,
                aad: wrap_aad.as_bytes(),
            },
        )
        .map_err(|_| Pgos1Error::Crypto)?;
    let cipher = Aes256Gcm::new_from_slice(&dek).map_err(|_| Pgos1Error::Crypto)?;
    let prefix = base64_decode(&metadata.stream_prefix)?;
    if prefix.len() != 7 {
        return Err(Pgos1Error::Crypto);
    }
    let prefix: [u8; 7] = prefix.try_into().map_err(|_| Pgos1Error::Crypto)?;

    let mut offset = MAGIC.len();
    let mut plaintext = Vec::with_capacity(metadata.plaintext_size as usize);
    for index in 0..metadata.chunk_count {
        if offset + 4 > stream.len() {
            return Err(Pgos1Error::Truncated);
        }
        let mut len_bytes = [0_u8; 4];
        len_bytes.copy_from_slice(&stream[offset..offset + 4]);
        offset += 4;
        let plain_len = u32::from_be_bytes(len_bytes) as usize;
        if plain_len > MAX_FRAME_BYTES {
            return Err(Pgos1Error::FrameTooLarge(plain_len));
        }
        let sealed_len = plain_len + 16;
        if offset + sealed_len > stream.len() {
            return Err(Pgos1Error::Truncated);
        }
        let sealed = &stream[offset..offset + sealed_len];
        offset += sealed_len;
        let final_flag = index + 1 == metadata.chunk_count;
        let nonce = Nonce::from(chunk_nonce(&prefix, index as u32, final_flag));
        let aad = chunk_aad(object_id, index as u32, final_flag);
        let chunk = cipher
            .decrypt(
                &nonce,
                Payload {
                    msg: sealed,
                    aad: &aad,
                },
            )
            .map_err(|_| Pgos1Error::Crypto)?;
        plaintext.extend_from_slice(&chunk);
    }
    if offset != stream.len() {
        return Err(Pgos1Error::Truncated);
    }
    if plaintext.len() as u64 != metadata.plaintext_size {
        return Err(Pgos1Error::SizeMismatch);
    }
    let sha = Sha256::digest(&plaintext);
    if hex::encode(sha) != metadata.plaintext_sha256 {
        return Err(Pgos1Error::HashMismatch);
    }
    Ok(plaintext)
}

fn chunk_nonce(prefix: &[u8; 7], index: u32, final_flag: bool) -> [u8; 12] {
    let mut nonce = [0_u8; 12];
    nonce[..7].copy_from_slice(prefix);
    nonce[7..11].copy_from_slice(&index.to_be_bytes());
    nonce[11] = u8::from(final_flag);
    nonce
}

fn chunk_aad(object_id: Uuid, index: u32, final_flag: bool) -> Vec<u8> {
    let mut aad = Vec::with_capacity(21);
    aad.extend_from_slice(object_id.as_bytes());
    aad.extend_from_slice(&index.to_be_bytes());
    aad.push(u8::from(final_flag));
    aad
}

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;

fn base64_encode(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

fn base64_decode(value: &str) -> Result<Vec<u8>, Pgos1Error> {
    STANDARD.decode(value).map_err(|_| Pgos1Error::Crypto)
}

// Keep the zeroize intent visible for the DEK buffer.
#[allow(dead_code)]
fn wipe(mut bytes: Zeroizing<Vec<u8>>) {
    bytes.clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keyring() -> KekKeyring {
        KekKeyring::parse(&format!("v1:{}", "11".repeat(32)), Some(1)).expect("keyring")
    }

    #[test]
    fn round_trip_multiple_chunks() {
        let id = Uuid::new_v4();
        let plaintext: Vec<u8> = (0..10_000).map(|index| (index % 251) as u8).collect();
        let (sealed, metadata) = seal_pgos1(id, &plaintext, &keyring(), Some(4096)).expect("seal");
        assert!(sealed.starts_with(b"pgos1"));
        assert_eq!(metadata.chunk_count, 3);
        assert_eq!(
            decrypt_pgos1(id, &sealed, &keyring(), &metadata).expect("open"),
            plaintext
        );
    }

    #[test]
    fn wrong_object_id_fails() {
        let id = Uuid::new_v4();
        let (sealed, metadata) = seal_pgos1(id, b"hello", &keyring(), Some(4096)).expect("seal");
        assert_eq!(
            decrypt_pgos1(Uuid::new_v4(), &sealed, &keyring(), &metadata).expect_err("aad"),
            Pgos1Error::Crypto
        );
    }

    #[test]
    fn tamper_fails() {
        let id = Uuid::new_v4();
        let (mut sealed, metadata) =
            seal_pgos1(id, b"hello", &keyring(), Some(4096)).expect("seal");
        let last = sealed.len() - 1;
        sealed[last] ^= 1;
        assert!(decrypt_pgos1(id, &sealed, &keyring(), &metadata).is_err());
    }

    #[test]
    fn empty_is_refused() {
        assert_eq!(
            seal_pgos1(Uuid::new_v4(), b"", &keyring(), None).expect_err("empty"),
            Pgos1Error::EmptyPayload
        );
    }
}

//! Hashing, HMAC, HKDF and encodings.
//!
//! Port of `core-back/engine/crypto/CryptoEngine.ts:43-104` and `Vault.ts:97-135`.

#![forbid(unsafe_code)]

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use hkdf::Hkdf;
use hmac::{Hmac, KeyInit, Mac};
use sha2::{Digest, Sha256, Sha512};
use subtle::ConstantTimeEq;
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyEncoding {
    Utf8,
    Hex,
    Base64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum OutputEncoding {
    #[default]
    HexLower,
    HexUpper,
    Base64,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum CryptoError {
    #[error("Invalid hexadecimal HMAC key")]
    InvalidHexKey,
    #[error("Invalid base64 HMAC key")]
    InvalidBase64Key,
    #[error("HMAC key must be a string or buffer")]
    InvalidKey,
    #[error("HKDF output length is invalid")]
    InvalidHkdfLength,
}

/// Strict hex decoding (even length, hex digits only).
pub fn decode_hex_strict(value: &str) -> Result<Vec<u8>, CryptoError> {
    if value.is_empty()
        || !value.len().is_multiple_of(2)
        || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(CryptoError::InvalidHexKey);
    }
    hex::decode(value).map_err(|_| CryptoError::InvalidHexKey)
}

/// Strict, canonical base64 decoding: padded, canonical alphabet, and re-encoding must match.
pub fn decode_base64_strict(value: &str) -> Result<Vec<u8>, CryptoError> {
    if !value.len().is_multiple_of(4)
        || !value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/' || byte == b'='
        })
    {
        return Err(CryptoError::InvalidBase64Key);
    }
    let decoded = STANDARD
        .decode(value)
        .map_err(|_| CryptoError::InvalidBase64Key)?;
    if STANDARD.encode(&decoded) != value {
        return Err(CryptoError::InvalidBase64Key);
    }
    Ok(decoded)
}

/// Decode a key with the TS key encodings.
pub fn decode_key(value: &str, encoding: KeyEncoding) -> Result<Vec<u8>, CryptoError> {
    match encoding {
        KeyEncoding::Utf8 => Ok(value.as_bytes().to_vec()),
        KeyEncoding::Hex => decode_hex_strict(value),
        KeyEncoding::Base64 => decode_base64_strict(value),
    }
}

/// Encode a digest in the configured output encoding.
#[must_use]
pub fn encode_output(value: &[u8], encoding: OutputEncoding) -> String {
    match encoding {
        OutputEncoding::HexLower => hex::encode(value),
        OutputEncoding::HexUpper => hex::encode_upper(value),
        OutputEncoding::Base64 => STANDARD.encode(value),
    }
}

#[must_use]
pub fn sha256(data: &[u8]) -> Vec<u8> {
    Sha256::digest(data).to_vec()
}

#[must_use]
pub fn sha256_hex(data: &[u8]) -> String {
    hex::encode(sha256(data))
}

#[must_use]
pub fn sha512(data: &[u8]) -> Vec<u8> {
    Sha512::digest(data).to_vec()
}

#[must_use]
pub fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

#[must_use]
pub fn hmac_sha512(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = Hmac::<Sha512>::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

/// HKDF-SHA256 (node `hkdfSync` equivalent).
pub fn hkdf_sha256(
    ikm: &[u8],
    salt: &[u8],
    info: &[u8],
    length: usize,
) -> Result<Vec<u8>, CryptoError> {
    let hkdf = Hkdf::<Sha256>::new(Some(salt), ikm);
    let mut output = vec![0_u8; length];
    hkdf.expand(info, &mut output)
        .map_err(|_| CryptoError::InvalidHkdfLength)?;
    Ok(output)
}

/// `timingSafeStringEqual`: compare SHA-256 digests in constant time.
#[must_use]
pub fn timing_safe_string_equal(left: &[u8], right: &[u8]) -> bool {
    let left = sha256(left);
    let right = sha256(right);
    left.ct_eq(&right).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_and_hmac_vectors() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        // RFC 4231 test case 2.
        let mac = hmac_sha256(b"Jefe", b"what do ya want for nothing?");
        assert_eq!(
            hex::encode(mac),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    #[test]
    fn strict_base64_rejects_non_canonical() {
        assert!(decode_base64_strict("YQ==").is_ok());
        assert!(decode_base64_strict("YQ").is_err());
        assert!(decode_base64_strict("YR==").is_err());
    }

    #[test]
    fn hkdf_session_key_is_32_bytes() {
        let key =
            hkdf_sha256(b"master", b"payment-gateway-core", b"session-signing", 32).expect("hkdf");
        assert_eq!(key.len(), 32);
    }
}

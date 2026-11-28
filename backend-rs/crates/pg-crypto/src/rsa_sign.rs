//! RSA SHA-256 signing and verification (CryptoEngine parity, chapter 2 §11).

#![forbid(unsafe_code)]

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use rsa::pkcs1::{DecodeRsaPrivateKey, DecodeRsaPublicKey};
use rsa::pkcs1v15::{Signature, SigningKey, VerifyingKey};
use rsa::pkcs8::{DecodePrivateKey, DecodePublicKey};
use rsa::signature::{SignatureEncoding, Signer, Verifier};
use rsa::PublicKey;
use sha2::Sha256;

use crate::canonical::OutputEncoding;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RsaError {
    InvalidPrivateKey,
    InvalidPublicKey,
    InvalidSignature,
}

impl std::fmt::Display for RsaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidPrivateKey => f.write_str("invalid RSA private key"),
            Self::InvalidPublicKey => f.write_str("invalid RSA public key"),
            Self::InvalidSignature => f.write_str("invalid RSA signature"),
        }
    }
}

impl std::error::Error for RsaError {}

fn private_key(pem: &[u8]) -> Result<rsa::PrivateKey, RsaError> {
    let text = std::str::from_utf8(pem).map_err(|_| RsaError::InvalidPrivateKey)?;
    rsa::PrivateKey::from_pkcs8_pem(text)
        .or_else(|_| rsa::PrivateKey::from_pkcs1_pem(text))
        .map_err(|_| RsaError::InvalidPrivateKey)
}

fn public_key(pem: &[u8]) -> Result<PublicKey, RsaError> {
    let text = std::str::from_utf8(pem).map_err(|_| RsaError::InvalidPublicKey)?;
    PublicKey::from_public_key_pem(text)
        .or_else(|_| PublicKey::from_pkcs1_pem(text))
        .map_err(|_| RsaError::InvalidPublicKey)
}

/// CryptoEngine `rsaSha256Sign`. Output defaults to base64 like the TS method; `HEX_LOWER` and
/// `HEX_UPPER` are accepted.
pub fn rsa_sha256_sign(
    private_key_pem: &[u8],
    data: &[u8],
    output: OutputEncoding,
) -> Result<String, RsaError> {
    let key = private_key(private_key_pem)?;
    let signing_key = SigningKey::<Sha256>::new(key);
    let signature = signing_key.sign(data);
    let bytes = signature.to_bytes();
    Ok(match output {
        OutputEncoding::Base64 => STANDARD.encode(bytes),
        OutputEncoding::HexLower => hex::encode(bytes),
        OutputEncoding::HexUpper => hex::encode_upper(bytes),
    })
}

/// CryptoEngine `rsaSha256Verify`.
pub fn rsa_sha256_verify(
    public_key_pem: &[u8],
    data: &[u8],
    signature: &str,
    encoding: OutputEncoding,
) -> Result<bool, RsaError> {
    let key = public_key(public_key_pem)?;
    let verifying_key = VerifyingKey::<Sha256>::new(key);
    let bytes = match encoding {
        OutputEncoding::Base64 => STANDARD
            .decode(signature)
            .map_err(|_| RsaError::InvalidSignature)?,
        OutputEncoding::HexLower | OutputEncoding::HexUpper => {
            hex::decode(signature).map_err(|_| RsaError::InvalidSignature)?
        }
    };
    let signature =
        Signature::try_from(bytes.as_slice()).map_err(|_| RsaError::InvalidSignature)?;
    Ok(verifying_key.verify(data, &signature).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rsa::pkcs8::{EncodePrivateKey, EncodePublicKey};
    use rsa::{Generate, PrivateKey};

    fn keypair() -> (String, String) {
        let key = PrivateKey::generate();
        let public = key.to_public_key();
        (
            key.to_pkcs8_pem(rsa::pkcs8::LineEnding::LF)
                .expect("private pem")
                .to_string(),
            public
                .to_public_key_pem(rsa::pkcs8::LineEnding::LF)
                .expect("public pem"),
        )
    }

    #[test]
    fn signs_and_verifies_base64_and_hex() {
        let (private, public) = keypair();
        for encoding in [
            OutputEncoding::Base64,
            OutputEncoding::HexLower,
            OutputEncoding::HexUpper,
        ] {
            let signature =
                rsa_sha256_sign(private.as_bytes(), b"canonical", encoding).expect("sign");
            assert!(
                rsa_sha256_verify(public.as_bytes(), b"canonical", &signature, encoding)
                    .expect("verify")
            );
            assert!(
                !rsa_sha256_verify(public.as_bytes(), b"changed", &signature, encoding)
                    .expect("verify")
            );
        }
    }
}

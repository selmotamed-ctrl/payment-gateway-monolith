//! Cryptography contracts shared by every service.
//!
//! Ports: `core-back/engine/crypto/Vault.ts`, `core-back/engine/crypto/CryptoEngine.ts`,
//! `core-back/lib/webhooks/standardWebhooks.ts`, `core-back/lib/storageEngine/shardBalances.ts`
//! and the audit-anchor signing rules in chapter 2 §6/§11.
//!
//! Deviation DEV-001: hashing/HMAC/AES use the RustCrypto crates instead of `aws-lc-rs` because the
//! build image has no cmake or NASM. The wire formats and algorithms are unchanged.

#![forbid(unsafe_code)]

pub mod canonical;
pub mod digest;
pub mod fnv;
pub mod redact;
pub mod rsa_sign;
pub mod vault;
pub mod webhooks;

pub use canonical::{
    canonicalize, canonicalize_with, CanonicalizationInput, CanonicalizationMode, CryptoAlgorithm,
    KeyEncoding, OutputEncoding,
};
pub use digest::{
    decode_base64_strict, decode_hex_strict, decode_key, encode_output, hkdf_sha256, hmac_sha256,
    hmac_sha512, sha256, sha256_hex, sha512, timing_safe_string_equal,
};
pub use fnv::fnv1a32_utf16;
pub use redact::{looks_like_pan, redact_payload, redact_text, REDACTED_VALUE};
pub use rsa_sign::{rsa_sha256_sign, rsa_sha256_verify, RsaError};
pub use vault::{assert_valid_key_id, Vault, VaultError, VAULT_KEY_ID_REGEX};
pub use webhooks::{
    sign_standard_webhook, standard_webhook_secret, verify_standard_webhook, WebhookSignatureError,
};

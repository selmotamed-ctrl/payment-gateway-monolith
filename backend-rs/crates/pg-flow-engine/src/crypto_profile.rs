//! Declarative crypto profiles for `CRYPTO_SIGNATURE` step parameters.
//!
//! Port of `CryptoEngine.signCanonicalPayload` / `canonicalize` usage in
//! `core-back/engine/flow/StepExecutor.ts:960-1030` and `core-back/engine/crypto/CryptoEngine.ts`.
//! The canonicalisation itself is [`pg_crypto::canonicalize`]; this module assembles the input from
//! the selected payload and applies the profile's algorithm and encodings.

#![forbid(unsafe_code)]

use pg_crypto::canonical::{CanonicalizationInput, CanonicalizationMode};
use pg_crypto::{
    canonicalize, decode_key, encode_output, hmac_sha256, hmac_sha512, rsa_sha256_sign, sha256,
    CryptoAlgorithm, KeyEncoding, OutputEncoding,
};
use serde_json::{Map, Value};

use crate::error::{codes, EngineError};
use crate::selector::stringify_value;
use crate::transform::SecretResolver;

/// One `crypto_profiles` row, as the step executor needs it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CryptoProfile {
    pub algorithm: CryptoAlgorithm,
    pub canonicalization_mode: CanonicalizationMode,
    pub secret_key_ref: Option<String>,
    pub secret_key_encoding: KeyEncoding,
    pub output_encoding: OutputEncoding,
    pub included_fields: Vec<String>,
    pub excluded_fields: Vec<String>,
    pub template_string: Option<String>,
}

impl CryptoProfile {
    /// A profile with the TS defaults (`UTF8` key, `HEX_LOWER` output).
    #[must_use]
    pub fn new(algorithm: CryptoAlgorithm, mode: CanonicalizationMode) -> Self {
        Self {
            algorithm,
            canonicalization_mode: mode,
            secret_key_ref: None,
            secret_key_encoding: KeyEncoding::Utf8,
            output_encoding: OutputEncoding::HexLower,
            included_fields: Vec::new(),
            excluded_fields: Vec::new(),
            template_string: None,
        }
    }
}

/// Resolves a profile id (`crypto_profile_id`) to its recipe.
pub trait CryptoProfileResolver: Send + Sync {
    fn resolve(&self, id: &str) -> Option<CryptoProfile>;
}

/// Maps a stored profile row onto [`CryptoProfile`]. Unknown algorithm/mode/encoding names are
/// refused, never defaulted.
#[allow(clippy::too_many_arguments)]
pub fn profile_from_parts(
    algorithm: &str,
    canonicalization_mode: &str,
    secret_key_ref: Option<&str>,
    secret_key_encoding: Option<&str>,
    output_encoding: Option<&str>,
    included_fields: &[String],
    excluded_fields: &[String],
    template_string: Option<&str>,
) -> Result<CryptoProfile, EngineError> {
    let algorithm = CryptoAlgorithm::parse(algorithm).ok_or_else(|| {
        EngineError::new(
            400,
            codes::CRYPTO_PROFILE_NOT_FOUND,
            format!("Unknown crypto algorithm '{algorithm}'"),
        )
    })?;
    let canonicalization_mode =
        CanonicalizationMode::parse(canonicalization_mode).ok_or_else(|| {
            EngineError::new(
                400,
                codes::CRYPTO_PROFILE_NOT_FOUND,
                format!("Unknown canonicalization mode '{canonicalization_mode}'"),
            )
        })?;
    let key_encoding = match secret_key_encoding.unwrap_or("UTF8") {
        "UTF8" => KeyEncoding::Utf8,
        "HEX" => KeyEncoding::Hex,
        "BASE64" => KeyEncoding::Base64,
        other => {
            return Err(EngineError::new(
                400,
                codes::CRYPTO_PROFILE_NOT_FOUND,
                format!("Unknown key encoding '{other}'"),
            ))
        }
    };
    let output = match output_encoding.unwrap_or("HEX_LOWER") {
        "HEX_LOWER" => OutputEncoding::HexLower,
        "HEX_UPPER" => OutputEncoding::HexUpper,
        "BASE64" => OutputEncoding::Base64,
        other => {
            return Err(EngineError::new(
                400,
                codes::CRYPTO_PROFILE_NOT_FOUND,
                format!("Unknown output encoding '{other}'"),
            ))
        }
    };
    Ok(CryptoProfile {
        algorithm,
        canonicalization_mode,
        secret_key_ref: secret_key_ref.map(str::to_owned),
        secret_key_encoding: key_encoding,
        output_encoding: output,
        included_fields: included_fields.to_vec(),
        excluded_fields: excluded_fields.to_vec(),
        template_string: template_string.map(str::to_owned),
    })
}

/// The payload a profile signs.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SigningPayload {
    pub fields: Map<String, Value>,
    pub raw_body: Option<String>,
    pub timestamp: Option<String>,
}

/// Builds the signing payload from the selected parameter value and the context roots.
///
/// A selected string is the raw body; a selected object is the field set; anything else is wrapped
/// as `{ value }`, exactly like `cryptoSigningPayload`.
#[must_use]
pub fn signing_payload(selected: Option<&Value>, timestamp: Option<&Value>) -> SigningPayload {
    let timestamp = timestamp
        .filter(|value| value.is_string() || value.is_number())
        .map(stringify_value);
    match selected {
        Some(Value::String(text)) => SigningPayload {
            fields: Map::new(),
            raw_body: Some(text.clone()),
            timestamp,
        },
        Some(Value::Object(map)) => SigningPayload {
            fields: map.clone(),
            raw_body: None,
            timestamp,
        },
        Some(value) => {
            let mut fields = Map::new();
            fields.insert("value".to_owned(), value.clone());
            SigningPayload {
                fields,
                raw_body: None,
                timestamp,
            }
        }
        None => SigningPayload {
            fields: Map::new(),
            raw_body: None,
            timestamp,
        },
    }
}

/// `CryptoEngine.signCanonicalPayload`.
pub fn sign_payload(
    profile: &CryptoProfile,
    payload: &SigningPayload,
    secrets: &dyn SecretResolver,
) -> Result<String, EngineError> {
    let canonical = canonicalize(
        profile.canonicalization_mode,
        &CanonicalizationInput {
            fields: payload.fields.clone(),
            raw_body: payload
                .raw_body
                .as_ref()
                .map(|text| text.as_bytes().to_vec()),
            timestamp: payload.timestamp.clone(),
            included_fields: if profile.included_fields.is_empty() {
                None
            } else {
                Some(profile.included_fields.clone())
            },
            excluded_fields: if profile.excluded_fields.is_empty() {
                None
            } else {
                Some(profile.excluded_fields.clone())
            },
            template_string: profile.template_string.clone(),
            value_separator: None,
        },
    )
    .map_err(|error| {
        EngineError::new(
            400,
            codes::CRYPTO_PROFILE_NOT_FOUND,
            format!("Canonicalization failed: {error}"),
        )
    })?;
    let output = profile.output_encoding;
    match profile.algorithm {
        CryptoAlgorithm::Sha256 => Ok(encode_output(&sha256(canonical.as_bytes()), output)),
        CryptoAlgorithm::HmacSha256 | CryptoAlgorithm::HmacSha512 => {
            let reference = profile.secret_key_ref.as_deref().ok_or_else(|| {
                EngineError::new(
                    400,
                    codes::CRYPTO_PROFILE_REQUIRED,
                    "A secret key reference is required to sign canonical data",
                )
            })?;
            let secret = secrets
                .resolve_secret(reference)
                .map_err(|error| EngineError::with_code(500, "SECRET_RESOLUTION_FAILED", error))?;
            let key = decode_key(
                &String::from_utf8_lossy(&secret),
                profile.secret_key_encoding,
            )
            .map_err(|error| {
                EngineError::new(400, codes::CRYPTO_PROFILE_NOT_FOUND, error.to_string())
            })?;
            let digest = if profile.algorithm == CryptoAlgorithm::HmacSha512 {
                hmac_sha512(&key, canonical.as_bytes())
            } else {
                hmac_sha256(&key, canonical.as_bytes())
            };
            Ok(encode_output(&digest, output))
        }
        CryptoAlgorithm::RsaSha256 => {
            let reference = profile.secret_key_ref.as_deref().ok_or_else(|| {
                EngineError::new(
                    400,
                    codes::CRYPTO_PROFILE_REQUIRED,
                    "A secret key reference is required to sign canonical data",
                )
            })?;
            let secret = secrets
                .resolve_secret(reference)
                .map_err(|error| EngineError::with_code(500, "SECRET_RESOLUTION_FAILED", error))?;
            let encoding = if output == OutputEncoding::Base64 {
                OutputEncoding::Base64
            } else {
                OutputEncoding::HexLower
            };
            rsa_sha256_sign(&secret, canonical.as_bytes(), encoding).map_err(|error| {
                EngineError::new(400, codes::CRYPTO_PROFILE_NOT_FOUND, error.to_string())
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Secrets;

    impl SecretResolver for Secrets {
        fn resolve_secret(&self, reference: &str) -> Result<Vec<u8>, String> {
            if reference == "CREDENTIAL.key" {
                Ok(b"secret".to_vec())
            } else {
                Err("missing".to_owned())
            }
        }
    }

    #[test]
    fn profile_parts_parse_the_stored_names() {
        let profile = profile_from_parts(
            "HMAC_SHA256",
            "SORTED_VALUES_HASH",
            Some("CREDENTIAL.key"),
            Some("UTF8"),
            Some("HEX_UPPER"),
            &[],
            &["hashed".to_owned()],
            None,
        )
        .expect("profile");
        assert_eq!(profile.algorithm, CryptoAlgorithm::HmacSha256);
        assert_eq!(
            profile.canonicalization_mode,
            CanonicalizationMode::SortedValuesHash
        );
        assert_eq!(profile.output_encoding, OutputEncoding::HexUpper);
        assert!(profile_from_parts("NOPE", "RAW_BODY", None, None, None, &[], &[], None).is_err());
        assert!(profile_from_parts(
            "SHA256",
            "RAW_BODY",
            None,
            Some("HEX_WEIRD"),
            None,
            &[],
            &[],
            None
        )
        .is_err());
    }

    #[test]
    fn signing_hmac_matches_the_crypto_engine() {
        let profile = CryptoProfile {
            secret_key_ref: Some("CREDENTIAL.key".to_owned()),
            ..CryptoProfile::new(
                CryptoAlgorithm::HmacSha256,
                CanonicalizationMode::SortedKeyValueAmp,
            )
        };
        let payload = signing_payload(Some(&json!({"b": "2", "a": "1"})), None);
        let signature = sign_payload(&profile, &payload, &Secrets).expect("sign");
        // SORTED_KEY_VALUE_AMP: "a=1&b=2".
        assert_eq!(signature, hex::encode(hmac_sha256(b"secret", b"a=1&b=2")));
    }

    #[test]
    fn signing_sha256_has_no_secret() {
        let mut profile =
            CryptoProfile::new(CryptoAlgorithm::Sha256, CanonicalizationMode::RawBody);
        profile.output_encoding = OutputEncoding::HexLower;
        let payload = signing_payload(Some(&json!("payload")), None);
        assert_eq!(
            sign_payload(&profile, &payload, &Secrets).expect("sign"),
            pg_crypto::sha256_hex(b"payload")
        );
    }

    #[test]
    fn payload_shapes_follow_the_ts_helper() {
        let payload = signing_payload(Some(&json!("raw")), Some(&json!(123)));
        assert_eq!(payload.raw_body.as_deref(), Some("raw"));
        assert!(payload.fields.is_empty());
        assert_eq!(payload.timestamp.as_deref(), Some("123"));
        let payload = signing_payload(Some(&json!({"a": 1})), None);
        assert_eq!(payload.fields.get("a"), Some(&json!(1)));
        let payload = signing_payload(Some(&json!(7)), None);
        assert_eq!(payload.fields.get("value"), Some(&json!(7)));
    }
}

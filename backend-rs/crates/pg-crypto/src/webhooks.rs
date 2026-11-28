//! Standard Webhooks signing and verification (AUTO-34).
//!
//! Port of `core-back/lib/webhooks/standardWebhooks.ts`.

#![forbid(unsafe_code)]

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use chrono::Utc;
use subtle::ConstantTimeEq;

use crate::digest::hmac_sha256;

pub const WEBHOOK_SECRET_PREFIX: &str = "whsec_";
pub const WEBHOOK_SIGNATURE_VERSION: &str = "v1";
pub const DEFAULT_TOLERANCE_SECONDS: i64 = 300;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WebhookSignatureError {
    MissingPrefix,
    KeyTooShort,
    NoSecrets,
}

impl std::fmt::Display for WebhookSignatureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingPrefix => f.write_str("a webhook secret starts with whsec_"),
            Self::KeyTooShort => f.write_str("a webhook secret must carry at least 16 key bytes"),
            Self::NoSecrets => f.write_str("at least one signing secret is required"),
        }
    }
}

impl std::error::Error for WebhookSignatureError {}

fn key_of(secret: &str) -> Result<Vec<u8>, WebhookSignatureError> {
    let encoded = secret
        .strip_prefix(WEBHOOK_SECRET_PREFIX)
        .ok_or(WebhookSignatureError::MissingPrefix)?;
    // Node's Buffer.from(value, "base64") is permissive; keep the same decoding behaviour.
    let key = STANDARD.decode(encoded).unwrap_or_default();
    if key.len() < 16 {
        return Err(WebhookSignatureError::KeyTooShort);
    }
    Ok(key)
}

/// Generate a `whsec_` secret (32 random bytes, padded base64).
#[must_use]
pub fn standard_webhook_secret() -> String {
    use rand::RngCore;
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    format!("{WEBHOOK_SECRET_PREFIX}{}", STANDARD.encode(bytes))
}

/// `v1,<base64>` for one secret.
pub fn sign_standard_webhook(
    id: &str,
    timestamp_seconds: i64,
    body: &str,
    secret: &str,
) -> Result<String, WebhookSignatureError> {
    let key = key_of(secret)?;
    let signed = format!("{id}.{timestamp_seconds}.{body}");
    Ok(format!(
        "{WEBHOOK_SIGNATURE_VERSION},{}",
        STANDARD.encode(hmac_sha256(&key, signed.as_bytes()))
    ))
}

/// The three headers of one attempt, signed with every active secret.
pub fn build_standard_webhook_headers(
    id: &str,
    timestamp_seconds: i64,
    body: &str,
    secrets: &[String],
) -> Result<Vec<(String, String)>, WebhookSignatureError> {
    if secrets.is_empty() {
        return Err(WebhookSignatureError::NoSecrets);
    }
    let signatures = secrets
        .iter()
        .map(|secret| sign_standard_webhook(id, timestamp_seconds, body, secret))
        .collect::<Result<Vec<_>, _>>()?
        .join(" ");
    Ok(vec![
        ("webhook-id".to_owned(), id.to_owned()),
        (
            "webhook-timestamp".to_owned(),
            timestamp_seconds.to_string(),
        ),
        ("webhook-signature".to_owned(), signatures),
    ])
}

/// Verify a received webhook with the default 300 s tolerance.
#[must_use]
pub fn verify_standard_webhook(
    id: Option<&str>,
    timestamp: Option<&str>,
    signatures: Option<&str>,
    body: &str,
    secrets: &[String],
) -> bool {
    verify_standard_webhook_at(
        id,
        timestamp,
        signatures,
        body,
        secrets,
        DEFAULT_TOLERANCE_SECONDS,
        Utc::now().timestamp(),
    )
}

/// Verify with an explicit clock and tolerance (tests, and the guide's receiver snippets).
#[must_use]
pub fn verify_standard_webhook_at(
    id: Option<&str>,
    timestamp: Option<&str>,
    signatures: Option<&str>,
    body: &str,
    secrets: &[String],
    tolerance_seconds: i64,
    now_seconds: i64,
) -> bool {
    let (Some(id), Some(timestamp), Some(signatures)) = (id, timestamp, signatures) else {
        return false;
    };
    if timestamp.is_empty()
        || timestamp.len() > 12
        || !timestamp.bytes().all(|byte| byte.is_ascii_digit())
    {
        return false;
    }
    let Ok(parsed) = timestamp.parse::<i64>() else {
        return false;
    };
    if (now_seconds - parsed).abs() > tolerance_seconds {
        return false;
    }
    let provided: Vec<&str> = signatures
        .split(' ')
        .filter_map(|entry| entry.strip_prefix(&format!("{WEBHOOK_SIGNATURE_VERSION},")))
        .collect();
    for secret in secrets {
        let Ok(expected) = sign_standard_webhook(id, parsed, body, secret) else {
            continue;
        };
        let expected = expected
            .strip_prefix(&format!("{WEBHOOK_SIGNATURE_VERSION},"))
            .unwrap_or("");
        for candidate in &provided {
            if candidate.len() == expected.len()
                && candidate.as_bytes().ct_eq(expected.as_bytes()).into()
            {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signs_and_verifies() {
        let secret = format!("whsec_{}", STANDARD.encode([9_u8; 32]));
        let signature = sign_standard_webhook("evt_1", 1_700_000_000, "{}", &secret).expect("sign");
        assert!(signature.starts_with("v1,"));
        assert!(verify_standard_webhook_at(
            Some("evt_1"),
            Some("1700000000"),
            Some(&signature),
            "{}",
            &[secret],
            300,
            1_700_000_000
        ));
    }

    #[test]
    fn rejects_stale_and_tampered() {
        let secret = format!("whsec_{}", STANDARD.encode([9_u8; 32]));
        let signature = sign_standard_webhook("evt_1", 1_700_000_000, "{}", &secret).expect("sign");
        assert!(!verify_standard_webhook_at(
            Some("evt_1"),
            Some("1700000000"),
            Some(&signature),
            "{\"x\":1}",
            std::slice::from_ref(&secret),
            300,
            1_700_000_000
        ));
        assert!(!verify_standard_webhook_at(
            Some("evt_1"),
            Some("1700000000"),
            Some(&signature),
            "{}",
            &[secret],
            300,
            1_700_001_000
        ));
    }
}

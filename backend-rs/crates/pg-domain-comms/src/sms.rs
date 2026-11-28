//! SMS webhook payloads, signatures and the legacy notification webhook.
//!
//! Ports `core-back/engine/notifications/CommunicationTransport.ts:187-243`
//! (`SmsWebhookTransport`) and `core-back/engine/notifications/NotificationTransport.ts:112-300`
//! (`signNotificationPayload`, `deriveNotificationWebhookSecret`,
//! `WebhookNotificationTransport`, `NOTIFICATION_SIGNATURE_HEADER`,
//! `NOTIFICATION_DELIVERY_HEADER`, `DEFAULT_NOTIFICATION_WEBHOOK_TIMEOUT_MS`).
//!
//! SMS body (exact field order and names of the TS `JSON.stringify`):
//!
//! ```json
//! {"notificationId":"…","eventId":"…","channel":"SMS","to":"+218…","senderId":"…",
//!  "templateCode":"LOGIN_MFA","body":"…","lang":"ar"}
//! ```
//!
//! Headers: `content-type: application/json`, `x-notification-signature: sha256=<hex>` over the
//! exact transmitted bytes, and `x-notification-delivery-id: <notification id>`.
//!
//! Legacy webhook signing key: the platform master key never leaves the process, so the transport
//! derives a purpose-bound key, `hex(HMAC-SHA256(masterKey, "core-back/notification-webhook/v1"))`.
//! The body is `{notificationId,eventId,channel,lang,templateCode,confidentialityClass,recipient,
//! subject,body}` and the signature header is the same `x-notification-signature`.

#![forbid(unsafe_code)]

use pg_crypto::digest::{encode_output, hmac_sha256};
use pg_crypto::OutputEncoding;
use serde::Serialize;

use crate::template::NotificationLocale;

/// The signature header of both webhooks.
pub const NOTIFICATION_SIGNATURE_HEADER: &str = "x-notification-signature";
/// The delivery id header of both webhooks.
pub const NOTIFICATION_DELIVERY_HEADER: &str = "x-notification-delivery-id";
/// `DEFAULT_NOTIFICATION_WEBHOOK_TIMEOUT_MS`.
pub const DEFAULT_NOTIFICATION_WEBHOOK_TIMEOUT_MS: u64 = 5_000;
/// The purpose string of the derived legacy signing key.
pub const LEGACY_WEBHOOK_KEY_INFO: &str = "core-back/notification-webhook/v1";

/// `sha256=<hex>` of the exact body bytes.
#[must_use]
pub fn sign_notification_payload(secret: &str, body: &str) -> String {
    format!(
        "sha256={}",
        encode_output(
            &hmac_sha256(secret.as_bytes(), body.as_bytes()),
            OutputEncoding::HexLower
        )
    )
}

/// Constant-time verification of a received `x-notification-signature`.
#[must_use]
pub fn verify_notification_signature(secret: &str, body: &str, provided: &str) -> bool {
    let expected = sign_notification_payload(secret, body);
    pg_crypto::timing_safe_string_equal(expected.as_bytes(), provided.as_bytes())
}

/// `deriveNotificationWebhookSecret`: a purpose-bound key derived from the master key.
#[must_use]
pub fn derive_notification_webhook_secret(master_key: &str) -> String {
    encode_output(
        &hmac_sha256(master_key.as_bytes(), LEGACY_WEBHOOK_KEY_INFO.as_bytes()),
        OutputEncoding::HexLower,
    )
}

/// The SMS aggregator payload; field order is the TS JSON order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmsPayload<'a> {
    pub notification_id: &'a str,
    pub event_id: &'a str,
    /// Always `"SMS"`; a field so the literal is serialised in the same position as the TS.
    pub channel: &'static str,
    pub to: &'a str,
    pub sender_id: &'a str,
    pub template_code: &'a str,
    pub body: &'a str,
    /// `notification.lang`: `ar` or `en`.
    pub lang: &'a str,
}

impl<'a> SmsPayload<'a> {
    #[must_use]
    pub fn new(
        notification_id: &'a str,
        event_id: &'a str,
        to: &'a str,
        sender_id: &'a str,
        template_code: &'a str,
        body: &'a str,
        locale: NotificationLocale,
    ) -> Self {
        Self {
            notification_id,
            event_id,
            channel: "SMS",
            to,
            sender_id,
            template_code,
            body,
            lang: locale.wire_lower(),
        }
    }

    /// Serialise the exact bytes to sign and transmit.
    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
    }

    /// The two provider headers; the signature covers this payload's own JSON bytes.
    pub fn headers(&self, secret: &str) -> Result<Vec<(&'static str, String)>, serde_json::Error> {
        let body = self.to_json()?;
        Ok(vec![
            ("content-type", "application/json".to_owned()),
            (
                NOTIFICATION_SIGNATURE_HEADER,
                sign_notification_payload(secret, &body),
            ),
            (
                NOTIFICATION_DELIVERY_HEADER,
                self.notification_id.to_owned(),
            ),
        ])
    }
}

/// The legacy provider payload of `WebhookNotificationTransport.deliver`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyNotificationPayload<'a> {
    pub notification_id: &'a str,
    pub event_id: &'a str,
    pub channel: &'a str,
    pub lang: &'a str,
    pub template_code: &'a str,
    pub confidentiality_class: &'a str,
    pub recipient: Option<&'a str>,
    pub subject: Option<&'a str>,
    pub body: &'a str,
}

impl<'a> LegacyNotificationPayload<'a> {
    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
    }
}

/// The legacy HMAC webhook configuration (no transport: the caller owns the HTTP client).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyNotificationWebhook {
    pub url: String,
    /// The derived secret (`derive_notification_webhook_secret`) or the configured secret.
    pub secret: String,
    pub timeout_ms: u64,
}

impl LegacyNotificationWebhook {
    #[must_use]
    pub fn new(url: impl Into<String>, secret: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            secret: secret.into(),
            timeout_ms: DEFAULT_NOTIFICATION_WEBHOOK_TIMEOUT_MS,
        }
    }

    /// Build the webhook from the master key with the derived purpose-bound key.
    #[must_use]
    pub fn from_master_key(url: impl Into<String>, master_key: &str) -> Self {
        Self::new(url, derive_notification_webhook_secret(master_key))
    }

    #[must_use]
    pub fn with_timeout_ms(mut self, timeout_ms: u64) -> Self {
        self.timeout_ms = timeout_ms;
        self
    }

    #[must_use]
    pub fn sign(&self, body: &str) -> String {
        sign_notification_payload(&self.secret, body)
    }

    /// `content-type`, `x-notification-signature`, `x-notification-delivery-id`.
    #[must_use]
    pub fn headers(&self, body: &str, delivery_id: &str) -> Vec<(&'static str, String)> {
        vec![
            ("content-type", "application/json".to_owned()),
            (NOTIFICATION_SIGNATURE_HEADER, self.sign(body)),
            (NOTIFICATION_DELIVERY_HEADER, delivery_id.to_owned()),
        ]
    }

    #[must_use]
    pub fn verify(&self, body: &str, provided: &str) -> bool {
        verify_notification_signature(&self.secret, body, provided)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sms_payload_is_exact() {
        let payload = SmsPayload::new(
            "notif-1",
            "evt-1",
            "+218910000000",
            "PG",
            "LOGIN_MFA",
            "رمز الدخول 123456.",
            NotificationLocale::Ar,
        );
        let json = payload.to_json().expect("json");
        assert_eq!(
            json,
            "{\"notificationId\":\"notif-1\",\"eventId\":\"evt-1\",\"channel\":\"SMS\",\"to\":\"+218910000000\",\"senderId\":\"PG\",\"templateCode\":\"LOGIN_MFA\",\"body\":\"رمز الدخول 123456.\",\"lang\":\"ar\"}"
        );
        let headers = payload.headers("secret").expect("headers");
        assert_eq!(headers[0], ("content-type", "application/json".to_owned()));
        assert_eq!(
            headers[2],
            (NOTIFICATION_DELIVERY_HEADER, "notif-1".to_owned())
        );
        assert!(headers[1].1.starts_with("sha256="));
        assert_eq!(headers[1].1.len(), "sha256=".len() + 64);
    }

    #[test]
    fn signature_matches_the_rfc_4231_vector() {
        // HMAC-SHA256("key", "The quick brown fox jumps over the lazy dog").
        assert_eq!(
            sign_notification_payload("key", "The quick brown fox jumps over the lazy dog"),
            "sha256=f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8"
        );
        let signature = sign_notification_payload("secret", "{}");
        assert!(verify_notification_signature("secret", "{}", &signature));
        assert!(!verify_notification_signature(
            "secret",
            "{\"x\":1}",
            &signature
        ));
        assert!(!verify_notification_signature("other", "{}", &signature));
    }

    #[test]
    fn derivation_is_purpose_bound_and_stable() {
        assert_eq!(
            derive_notification_webhook_secret("master-key"),
            "71c52b9e2f0a42a06d64e5cdcb3cbbf13f7a59d8ff6589521193de16e28a0223"
        );
        assert_ne!(
            derive_notification_webhook_secret("master-key"),
            "master-key"
        );
    }

    #[test]
    fn legacy_payload_field_order_and_headers() {
        let payload = LegacyNotificationPayload {
            notification_id: "n1",
            event_id: "e1",
            channel: "EMAIL",
            lang: "en",
            template_code: "LOGIN_MFA",
            confidentiality_class: "INTERNAL",
            recipient: Some("ops@example.com"),
            subject: Some("Your sign-in code"),
            body: "code 123456",
        };
        assert_eq!(
            payload.to_json().expect("json"),
            "{\"notificationId\":\"n1\",\"eventId\":\"e1\",\"channel\":\"EMAIL\",\"lang\":\"en\",\"templateCode\":\"LOGIN_MFA\",\"confidentialityClass\":\"INTERNAL\",\"recipient\":\"ops@example.com\",\"subject\":\"Your sign-in code\",\"body\":\"code 123456\"}"
        );

        let webhook = LegacyNotificationWebhook::from_master_key(
            "https://provider.example/hook",
            "master-key",
        )
        .with_timeout_ms(1_500);
        assert_eq!(webhook.timeout_ms, 1_500);
        let body = payload.to_json().expect("json");
        let headers = webhook.headers(&body, "n1");
        assert_eq!(headers[2], (NOTIFICATION_DELIVERY_HEADER, "n1".to_owned()));
        assert!(webhook.verify(&body, &headers[1].1));
        assert_eq!(webhook.url, "https://provider.example/hook");
    }

    #[test]
    fn null_recipient_and_subject_are_serialised() {
        let payload = LegacyNotificationPayload {
            notification_id: "n2",
            event_id: "e2",
            channel: "SMS",
            lang: "ar",
            template_code: "LOGIN_MFA",
            confidentiality_class: "INTERNAL",
            recipient: None,
            subject: None,
            body: "x",
        };
        assert!(payload
            .to_json()
            .expect("json")
            .contains("\"recipient\":null,\"subject\":null"));
    }
}

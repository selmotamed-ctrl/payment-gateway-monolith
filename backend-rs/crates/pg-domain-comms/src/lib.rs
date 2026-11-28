//! Communication domain: bilingual templates, the no-tipping-off guard, and provider payloads.
//!
//! Ports `core-back/lib/communication/{templates,policy}.ts`,
//! `core-back/lib/staffInvitation.ts`, `core-back/engine/compliance/tippingOff.ts`,
//! `core-back/engine/notifications/{NotificationTransport,CommunicationTransport}.ts` and the code
//! classification constants of `lib/communication/settings.ts`.
//!
//! No SMTP, HTTP or database access: this crate owns the bytes (templates, rendered bodies, JSON
//! payloads, signatures). The transports live in `pg-workers`.
//!
//! Confidentiality note: every code-owned template is `INTERNAL` (one-time codes and invitation
//! tokens). A non-`INTERNAL` template may never reference an AML variable, and an AML-confidential
//! case may never notify a merchant or customer.
//!
//! Parity note: [`SmsMode::AuthOnly`] is **not** a hard authentication-template filter in the TS
//! runtime. `should_send_sms` reproduces `lib/communication/policy.ts:43-58` exactly: the
//! configured allow-list is consulted before the mode, so a listed non-auth template still sends.
//! Changing that is a numbered `S-SEC` product decision to apply to TS and Rust together; it is not
//! applied here (Track P rule 1/2).

#![forbid(unsafe_code)]

pub mod sms;
pub mod template;
pub mod tipping_off;

pub use sms::{
    derive_notification_webhook_secret, sign_notification_payload, verify_notification_signature,
    LegacyNotificationPayload, LegacyNotificationWebhook, SmsPayload,
    DEFAULT_NOTIFICATION_WEBHOOK_TIMEOUT_MS, LEGACY_WEBHOOK_KEY_INFO, NOTIFICATION_DELIVERY_HEADER,
    NOTIFICATION_SIGNATURE_HEADER,
};
pub use template::{
    extract_template_variables, js_string, render, render_template,
    template_matches_channel_and_language, ConfidentialityClass, NotificationChannel,
    NotificationLocale, NotificationTemplate, RenderedTemplate,
};
pub use tipping_off::{
    assert_no_tipping_off, contains_aml_marker, contains_aml_variable, evaluate,
    is_confidential_template_class, is_sensitive_aml_key, redact_aml_payload, Audience,
    CaseConfidentiality, NotificationContext, TemplateView, TippingOffRefusal,
};

/// `DEFAULT_SMS_TEMPLATES` of `lib/communication/settings.ts:345-352`.
pub const DEFAULT_SMS_TEMPLATES: &[&str] = &[
    "LOGIN_MFA",
    "EMAIL_VERIFICATION",
    "PASSWORD_RESET",
    "PASSWORD_CHANGED",
    "STAFF_INVITATION",
    "SECURITY_ALERT",
];

/// `AUTH_TEMPLATE_CODES` of `lib/communication/policy.ts:25-33`.
pub const AUTH_TEMPLATE_CODES: &[&str] = &[
    "LOGIN_MFA",
    "EMAIL_VERIFICATION",
    "PASSWORD_RESET",
    "PASSWORD_CHANGED",
    "STAFF_INVITATION",
    "LOGIN_CODE",
    "VERIFY_EMAIL",
];

/// `COMMUNICATION_AUTH_TEMPLATE_CODES` of `lib/communication/templates.ts:74`.
pub const COMMUNICATION_AUTH_TEMPLATE_CODES: &[&str] = &[
    "LOGIN_MFA",
    "EMAIL_VERIFICATION",
    "PASSWORD_RESET",
    "PASSWORD_CHANGED",
];

/// `SmsMode` (`communication.policy.smsMode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SmsMode {
    Off,
    AuthOnly,
    CriticalOnly,
    All,
}

impl SmsMode {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Off => "OFF",
            Self::AuthOnly => "AUTH_ONLY",
            Self::CriticalOnly => "CRITICAL_ONLY",
            Self::All => "ALL",
        }
    }

    /// The TS default when the setting is absent or unrecognised.
    #[must_use]
    pub const fn default_mode() -> Self {
        Self::CriticalOnly
    }
}

/// `shouldSendSms` (`lib/communication/policy.ts:43-58`), reproduced in the TS order.
///
/// **TS quirk replicated for parity:** the configured allow-list is consulted *before* the mode, so
/// under `AUTH_ONLY` a template that an administrator put in `smsTemplateCodes` still sends SMS even
/// when it is not an authentication template (for example `PAYMENT_SETTLED`). `AUTH_ONLY` is
/// therefore **not** a hard auth-template filter in the TS runtime. Tightening it is a product
/// decision that must be applied to TS and Rust together as a numbered `S-SEC` item; it is not
/// implemented here.
#[must_use]
pub fn should_send_sms(
    mode: SmsMode,
    template_code: &str,
    configured_codes: &[String],
    sms_configured: bool,
) -> bool {
    if !sms_configured || mode == SmsMode::Off {
        return false;
    }
    let code = template_code.trim().to_ascii_uppercase();
    if mode == SmsMode::All {
        return true;
    }
    if configured_codes
        .iter()
        .any(|entry| entry.trim().eq_ignore_ascii_case(&code))
    {
        return true;
    }
    if mode == SmsMode::AuthOnly {
        return AUTH_TEMPLATE_CODES.contains(&code.as_str());
    }
    // CRITICAL_ONLY: the configured allow-list is the source of truth.
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constants_match_the_ts_lists() {
        assert_eq!(DEFAULT_SMS_TEMPLATES.len(), 6);
        assert_eq!(AUTH_TEMPLATE_CODES.len(), 7);
        assert_eq!(COMMUNICATION_AUTH_TEMPLATE_CODES.len(), 4);
        assert_eq!(SmsMode::default_mode(), SmsMode::CriticalOnly);
    }

    #[test]
    fn sms_policy_matrix_reproduces_the_ts_ordering() {
        let defaults: Vec<String> = DEFAULT_SMS_TEMPLATES
            .iter()
            .map(|code| (*code).to_owned())
            .collect();
        assert!(!should_send_sms(SmsMode::Off, "LOGIN_MFA", &defaults, true));
        assert!(!should_send_sms(
            SmsMode::CriticalOnly,
            "LOGIN_MFA",
            &defaults,
            false
        ));
        assert!(should_send_sms(
            SmsMode::CriticalOnly,
            "login_mfa",
            &defaults,
            true
        ));
        assert!(!should_send_sms(
            SmsMode::CriticalOnly,
            "PAYMENT_SETTLED",
            &defaults,
            true
        ));
        // AUTH_ONLY accepts every auth code, even one outside the allow-list.
        assert!(should_send_sms(
            SmsMode::AuthOnly,
            "VERIFY_EMAIL",
            &[],
            true
        ));
        // TS quirk: the allow-list is checked before the mode, so a listed non-auth template also
        // sends under AUTH_ONLY. Replicated for parity, not intended behaviour.
        assert!(should_send_sms(
            SmsMode::AuthOnly,
            "PAYMENT_SETTLED",
            &["PAYMENT_SETTLED".to_owned()],
            true
        ));
        assert!(!should_send_sms(
            SmsMode::AuthOnly,
            "PAYMENT_SETTLED",
            &defaults,
            true
        ));
        assert!(should_send_sms(SmsMode::All, "PAYMENT_SETTLED", &[], true));
    }
}

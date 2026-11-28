//! Notification templates, locales and `{{var}}` rendering.
//!
//! Port of the code-owned bilingual templates:
//!
//! - `core-back/lib/communication/templates.ts` (LOGIN_MFA, EMAIL_VERIFICATION, PASSWORD_RESET,
//!   PASSWORD_CHANGED; EMAIL and SMS variants; all `INTERNAL`);
//! - `core-back/lib/staffInvitation.ts:33-52` (STAFF_INVITATION, EMAIL, both languages);
//! - `core-back/engine/compliance/tippingOff.ts:7-19` (`VARIABLE_PATTERN`,
//!   `extractTemplateVariables`, `renderTemplate`).
//!
//! `SECURITY_ALERT` is an id only: it appears in `DEFAULT_SMS_TEMPLATES` but no code-owned text
//! exists, so its body always comes from a `notification_templates` row.
//!
//! Every string below is copied byte for byte from the TypeScript. A parity test can render each
//! (template, locale) pair and diff the bytes against `notification-texts.json` (P0-T06).

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// `NotificationChannel`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum NotificationChannel {
    Email,
    Sms,
    InApp,
}

impl NotificationChannel {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Email => "EMAIL",
            Self::Sms => "SMS",
            Self::InApp => "IN_APP",
        }
    }
}

/// `NotificationLang` (the row enum is upper-case; the SMS wire body uses the lower-case form).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum NotificationLocale {
    En,
    Ar,
}

impl NotificationLocale {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::En => "EN",
            Self::Ar => "AR",
        }
    }

    /// `notification.lang` as the SMS payload carries it.
    #[must_use]
    pub const fn wire_lower(self) -> &'static str {
        match self {
            Self::En => "en",
            Self::Ar => "ar",
        }
    }

    #[must_use]
    pub fn from_wire(value: &str) -> Option<Self> {
        match value.trim() {
            "EN" | "en" => Some(Self::En),
            "AR" | "ar" => Some(Self::Ar),
            _ => None,
        }
    }
}

/// `ConfidentialityClass`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ConfidentialityClass {
    Public,
    Merchant,
    Internal,
}

impl ConfidentialityClass {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Public => "PUBLIC",
            Self::Merchant => "MERCHANT",
            Self::Internal => "INTERNAL",
        }
    }

    #[must_use]
    pub const fn is_internal(self) -> bool {
        matches!(self, Self::Internal)
    }
}

/// One code-owned template row (code + channel), with both languages.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum NotificationTemplate {
    #[serde(rename = "LOGIN_MFA/EMAIL")]
    LoginMfaEmail,
    #[serde(rename = "LOGIN_MFA/SMS")]
    LoginMfaSms,
    #[serde(rename = "EMAIL_VERIFICATION/EMAIL")]
    EmailVerificationEmail,
    #[serde(rename = "EMAIL_VERIFICATION/SMS")]
    EmailVerificationSms,
    #[serde(rename = "PASSWORD_RESET/EMAIL")]
    PasswordResetEmail,
    #[serde(rename = "PASSWORD_RESET/SMS")]
    PasswordResetSms,
    #[serde(rename = "PASSWORD_CHANGED/EMAIL")]
    PasswordChangedEmail,
    #[serde(rename = "PASSWORD_CHANGED/SMS")]
    PasswordChangedSms,
    #[serde(rename = "STAFF_INVITATION/EMAIL")]
    StaffInvitationEmail,
    #[serde(rename = "SECURITY_ALERT")]
    SecurityAlert,
}

impl NotificationTemplate {
    pub const ALL: &'static [Self] = &[
        Self::LoginMfaEmail,
        Self::LoginMfaSms,
        Self::EmailVerificationEmail,
        Self::EmailVerificationSms,
        Self::PasswordResetEmail,
        Self::PasswordResetSms,
        Self::PasswordChangedEmail,
        Self::PasswordChangedSms,
        Self::StaffInvitationEmail,
        Self::SecurityAlert,
    ];

    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::LoginMfaEmail | Self::LoginMfaSms => "LOGIN_MFA",
            Self::EmailVerificationEmail | Self::EmailVerificationSms => "EMAIL_VERIFICATION",
            Self::PasswordResetEmail | Self::PasswordResetSms => "PASSWORD_RESET",
            Self::PasswordChangedEmail | Self::PasswordChangedSms => "PASSWORD_CHANGED",
            Self::StaffInvitationEmail => "STAFF_INVITATION",
            Self::SecurityAlert => "SECURITY_ALERT",
        }
    }

    #[must_use]
    pub const fn channel(self) -> NotificationChannel {
        match self {
            Self::LoginMfaSms
            | Self::EmailVerificationSms
            | Self::PasswordResetSms
            | Self::PasswordChangedSms => NotificationChannel::Sms,
            _ => NotificationChannel::Email,
        }
    }

    /// Every code-owned template is `INTERNAL` (one-time codes and invitation tokens).
    #[must_use]
    pub const fn confidentiality(self) -> ConfidentialityClass {
        ConfidentialityClass::Internal
    }

    /// The subject template, when the channel has one.
    ///
    /// The four authentication templates are inserted by `templates.ts` with the SAME subject for
    /// both languages (the flatMap copies `template.subject` into the AR row); only
    /// `STAFF_INVITATION` has a translated subject.
    #[must_use]
    pub const fn subject_template(self, locale: NotificationLocale) -> Option<&'static str> {
        match (self, locale) {
            (Self::LoginMfaEmail, _) => Some("Your sign-in code"),
            (Self::EmailVerificationEmail, _) => Some("Verify your email address"),
            (Self::PasswordResetEmail, _) => Some("Reset your password"),
            (Self::PasswordChangedEmail, _) => Some("Your password was changed"),
            (Self::StaffInvitationEmail, NotificationLocale::En) => {
                Some("You have been invited to the back office")
            }
            (Self::StaffInvitationEmail, NotificationLocale::Ar) => {
                Some("تمت دعوتك إلى لوحة الإدارة")
            }
            _ => None,
        }
    }

    /// The body template of the code-owned row.
    ///
    /// `SECURITY_ALERT` has no code-owned text; it returns `None` and the caller must use the
    /// database row.
    #[must_use]
    pub const fn body_template(self, locale: NotificationLocale) -> Option<&'static str> {
        match (self, locale) {
            (Self::LoginMfaEmail, NotificationLocale::En) => Some(
                "Your sign-in code is {{code}}. It expires in {{ttlMinutes}} minutes. Never share this code with anyone.",
            ),
            (Self::LoginMfaEmail, NotificationLocale::Ar) => Some(
                "رمز الدخول الخاص بك هو {{code}}. تنتهي صلاحيته خلال {{ttlMinutes}} دقيقة. لا تشارك هذا الرمز مع أي شخص.",
            ),
            (Self::LoginMfaSms, NotificationLocale::En) => {
                Some("Your sign-in code is {{code}}. It expires in {{ttlMinutes}} minutes. Never share it.")
            }
            (Self::LoginMfaSms, NotificationLocale::Ar) => {
                Some("رمز الدخول {{code}}. تنتهي صلاحيته خلال {{ttlMinutes}} دقيقة. لا تشاركه مع أحد.")
            }
            (Self::EmailVerificationEmail, NotificationLocale::En) => Some(
                "Welcome to {{platformName}}. Your verification code is {{code}}. It expires in {{ttlMinutes}} minutes.",
            ),
            (Self::EmailVerificationEmail, NotificationLocale::Ar) => Some(
                "مرحباً بك في {{platformName}}. رمز التحقق الخاص بك هو {{code}}. تنتهي صلاحيته خلال {{ttlMinutes}} دقيقة.",
            ),
            (Self::EmailVerificationSms, NotificationLocale::En) => {
                Some("{{platformName}} verification code: {{code}}. Expires in {{ttlMinutes}} minutes.")
            }
            (Self::EmailVerificationSms, NotificationLocale::Ar) => Some(
                "رمز التحقق من {{platformName}}: {{code}}. تنتهي صلاحيته خلال {{ttlMinutes}} دقيقة.",
            ),
            (Self::PasswordResetEmail, NotificationLocale::En) => Some(
                "Use code {{code}} to reset your password. It expires in {{ttlMinutes}} minutes. If you did not ask for this, ignore this message.",
            ),
            (Self::PasswordResetEmail, NotificationLocale::Ar) => Some(
                "استخدم الرمز {{code}} لإعادة تعيين كلمة المرور. تنتهي صلاحيته خلال {{ttlMinutes}} دقيقة. إذا لم تطلب ذلك تجاهل هذه الرسالة.",
            ),
            (Self::PasswordResetSms, NotificationLocale::En) => Some(
                "{{platformName}} password reset code: {{code}}. Expires in {{ttlMinutes}} minutes.",
            ),
            (Self::PasswordResetSms, NotificationLocale::Ar) => Some(
                "رمز إعادة تعيين كلمة المرور من {{platformName}}: {{code}}. تنتهي صلاحيته خلال {{ttlMinutes}} دقيقة.",
            ),
            (Self::PasswordChangedEmail, NotificationLocale::En) => Some(
                "Your password was changed at {{changedAt}}. If this was not you, contact the platform administrator immediately.",
            ),
            (Self::PasswordChangedEmail, NotificationLocale::Ar) => Some(
                "تم تغيير كلمة المرور الخاصة بك في {{changedAt}}. إذا لم تقم بذلك فاتصل بمسؤول المنصة فوراً.",
            ),
            (Self::PasswordChangedSms, NotificationLocale::En) => Some(
                "{{platformName}}: your password was changed at {{changedAt}}. If this was not you, contact support immediately.",
            ),
            (Self::PasswordChangedSms, NotificationLocale::Ar) => Some(
                "{{platformName}}: تم تغيير كلمة المرور في {{changedAt}}. إذا لم تقم بذلك فاتصل بالدعم فوراً.",
            ),
            (Self::StaffInvitationEmail, NotificationLocale::En) => Some(
                "You were invited to the payment gateway back office. Open the back office, choose \"Accept invitation\" and enter this invitation code: {{token}}. You will choose your own password. Sign-in codes are sent to this email address; a phone number is optional and adds SMS as a second channel. The code works once and expires in 7 days. If you did not expect this, ignore this message.",
            ),
            (Self::StaffInvitationEmail, NotificationLocale::Ar) => Some(
                "تمت دعوتك إلى لوحة إدارة بوابة الدفع. افتح لوحة الإدارة واختر \"قبول الدعوة\" ثم أدخل رمز الدعوة التالي: {{token}}. ستختار كلمة المرور الخاصة بك. تُرسل رموز الدخول إلى هذا البريد الإلكتروني، ورقم الهاتف اختياري ويضيف الرسائل النصية كقناة ثانية. يعمل الرمز مرة واحدة وتنتهي صلاحيته بعد 7 أيام. إذا لم تتوقع هذه الدعوة فتجاهل هذه الرسالة.",
            ),
            (Self::SecurityAlert, _) => None,
        }
    }
}

/// A rendered message (subject only for email).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RenderedTemplate {
    pub template_code: String,
    pub locale: NotificationLocale,
    pub subject: Option<String>,
    pub body: String,
    pub confidentiality: ConfidentialityClass,
}

/// Render a code-owned template. Returns `None` only for [`NotificationTemplate::SecurityAlert`],
/// which has no code-owned text.
#[must_use]
pub fn render(
    template: NotificationTemplate,
    locale: NotificationLocale,
    values: &Value,
) -> Option<RenderedTemplate> {
    let body_template = template.body_template(locale)?;
    let subject = template
        .subject_template(locale)
        .map(|subject| render_template(subject, values));
    Some(RenderedTemplate {
        template_code: template.code().to_owned(),
        locale,
        subject,
        body: render_template(body_template, values),
        confidentiality: template.confidentiality(),
    })
}

/// `renderTemplate`: replace every `{{var}}` with the payload value; `null`/missing becomes "".
#[must_use]
pub fn render_template(template: &str, values: &Value) -> String {
    let mut output = String::with_capacity(template.len());
    let mut index = 0;
    while let Some(offset) = template[index..].find("{{") {
        let open = index + offset;
        output.push_str(&template[index..open]);
        match parse_placeholder(template, open) {
            Some((name, end)) => {
                if let Some(value) = values.get(name) {
                    output.push_str(&js_string(value));
                }
                index = end;
            }
            None => {
                output.push_str("{{");
                index = open + 2;
            }
        }
    }
    output.push_str(&template[index..]);
    output
}

/// Parse `{{ name }}` at `start`; returns the literal key and the index after `}}`.
fn parse_placeholder(template: &str, start: usize) -> Option<(&str, usize)> {
    let rest = template.get(start + 2..)?;
    let trimmed = rest.trim_start_matches(char::is_whitespace);
    let name_len = trimmed
        .char_indices()
        .take_while(|(_, character)| {
            character.is_ascii_alphanumeric() || *character == '_' || *character == '.'
        })
        .count();
    if name_len == 0 {
        return None;
    }
    let name = trimmed.get(..name_len)?;
    let after_name = trimmed
        .get(name_len..)?
        .trim_start_matches(char::is_whitespace);
    let closing = after_name.strip_prefix("}}")?;
    let consumed = rest.len() - closing.len();
    Some((name, start + 2 + consumed))
}

/// `extractTemplateVariables`: every placeholder name in order of appearance.
#[must_use]
pub fn extract_template_variables(template: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut index = 0;
    while let Some(offset) = template[index..].find("{{") {
        let open = index + offset;
        match parse_placeholder(template, open) {
            Some((name, end)) => {
                names.push(name.to_owned());
                index = end;
            }
            None => index = open + 2,
        }
    }
    names
}

/// JavaScript `String(value)` for the placeholder replacement.
///
/// `null`/missing never reaches this function (the caller emits nothing). Objects and arrays follow
/// JS: `[1,2]` renders `"1,2"`, an object renders `"[object Object]"`, booleans render
/// `"true"`/`"false"`. Rust's shortest float formatting is used for fractional numbers; TS uses
/// `Number#toString` and differs only for exponent thresholds.
#[must_use]
pub fn js_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(true) => "true".to_owned(),
        Value::Bool(false) => "false".to_owned(),
        Value::Number(number) => number.to_string(),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// `assertTemplateAllowedForChannel`.
#[must_use]
pub fn template_matches_channel_and_language(
    template_channel: NotificationChannel,
    template_language: NotificationLocale,
    channel: NotificationChannel,
    locale: NotificationLocale,
) -> bool {
    template_channel == channel && template_language == locale
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn renders_english_and_arabic_auth_templates() {
        let values = json!({ "code": "123456", "ttlMinutes": 10 });
        let rendered = render(
            NotificationTemplate::LoginMfaEmail,
            NotificationLocale::En,
            &values,
        )
        .expect("template");
        assert_eq!(rendered.subject.as_deref(), Some("Your sign-in code"));
        assert_eq!(
            rendered.body,
            "Your sign-in code is 123456. It expires in 10 minutes. Never share this code with anyone."
        );
        assert_eq!(rendered.confidentiality, ConfidentialityClass::Internal);

        let arabic = render(
            NotificationTemplate::EmailVerificationSms,
            NotificationLocale::Ar,
            &json!({ "platformName": "بوابة الدفع", "code": "654321", "ttlMinutes": 5 }),
        )
        .expect("template");
        assert_eq!(arabic.subject, None);
        assert_eq!(
            arabic.body,
            "رمز التحقق من بوابة الدفع: 654321. تنتهي صلاحيته خلال 5 دقيقة."
        );
        assert_eq!(arabic.locale.wire_lower(), "ar");
    }

    #[test]
    fn unknown_and_null_placeholders_render_empty() {
        let rendered = render(
            NotificationTemplate::PasswordResetEmail,
            NotificationLocale::En,
            &json!({ "code": null, "ttlMinutes": 15 }),
        )
        .expect("template");
        assert!(rendered
            .body
            .starts_with("Use code  to reset your password."));
        assert!(render(
            NotificationTemplate::SecurityAlert,
            NotificationLocale::En,
            &json!({})
        )
        .is_none());
    }

    #[test]
    fn placeholder_grammar_matches_the_ts_regex() {
        let values = json!({ "a_b.c1": "v", "n": 2 });
        assert_eq!(render_template("x {{a_b.c1}} y", &values), "x v y");
        assert_eq!(render_template("x {{  n  }} y", &values), "x 2 y");
        // Invalid names and unterminated braces stay literal.
        assert_eq!(render_template("x {{a-b}}", &values), "x {{a-b}}");
        assert_eq!(render_template("x {{", &values), "x {{");
        assert_eq!(render_template("{{}}", &values), "{{}}");
        assert_eq!(
            extract_template_variables("{{a}} {{ b }} {{a-b}} {{c}}"),
            vec!["a".to_owned(), "b".to_owned(), "c".to_owned()]
        );
    }

    #[test]
    fn js_string_semantics() {
        assert_eq!(js_string(&json!(null)), "");
        assert_eq!(js_string(&json!(true)), "true");
        assert_eq!(js_string(&json!(12)), "12");
        assert_eq!(js_string(&json!("text")), "text");
        assert_eq!(js_string(&json!([1, null, 2])), "1,,2");
        assert_eq!(js_string(&json!({ "a": 1 })), "[object Object]");
    }

    #[test]
    fn every_template_has_both_languages() {
        for template in NotificationTemplate::ALL {
            if *template == NotificationTemplate::SecurityAlert {
                assert!(template.body_template(NotificationLocale::En).is_none());
                continue;
            }
            for locale in [NotificationLocale::En, NotificationLocale::Ar] {
                let body = template
                    .body_template(locale)
                    .unwrap_or_else(|| panic!("{template:?} {locale:?}"));
                assert!(!body.is_empty());
                assert!(
                    !extract_template_variables(body).is_empty(),
                    "{template:?} {locale:?} has no placeholder"
                );
                if template.channel() == NotificationChannel::Email
                    && template.subject_template(locale).is_none()
                {
                    panic!("{template:?} {locale:?} misses its subject");
                }
            }
        }
        assert_eq!(NotificationTemplate::ALL.len(), 10);
    }

    #[test]
    fn channel_and_language_guard() {
        assert!(template_matches_channel_and_language(
            NotificationChannel::Sms,
            NotificationLocale::Ar,
            NotificationChannel::Sms,
            NotificationLocale::Ar
        ));
        assert!(!template_matches_channel_and_language(
            NotificationChannel::Sms,
            NotificationLocale::Ar,
            NotificationChannel::Email,
            NotificationLocale::Ar
        ));
    }
}

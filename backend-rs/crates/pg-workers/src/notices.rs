//! Merchant and staff notices queued by the background automations
//! (`core-back/lib/automationNotices.ts`).
//!
//! Every notice is queued on the notification outbox (rendered and sent by the outbox notification
//! worker) with a stable event id, so a repeated tick, a restart or a second node never sends it
//! twice. The helper only issues statements that cannot fail on a duplicate
//! (`ON CONFLICT DO NOTHING`), so it is safe INSIDE a database transaction.
//!
//! Tipping-off: the templates are `MERCHANT` or `INTERNAL` class and carry no compliance detail;
//! anything touching AML is never sent through here.
//!
//! Deviation from the TypeScript helper: sealing the recipient address is a Vault operation, and
//! `pg-workers` does not depend on `pg-crypto`. A caller that wants EMAIL or SMS delivery injects a
//! [`NoticeAddressCipher`]; without one, the in-app row is still queued (it has no address and stores
//! an empty ciphertext, exactly like TypeScript) and the addressed channel is skipped with a warning
//! instead of being queued undeliverable.

#![forbid(unsafe_code)]

use pg_types::generated::enums::{ConfidentialityClass, NotificationChannel, NotificationLang};
use serde_json::Value;
use sqlx::{PgConnection, Row};
use tracing::warn;
use uuid::Uuid;

use crate::runtime::WorkerError;

/// The Vault associated data TypeScript uses for notification addresses.
pub const NOTICE_ADDRESS_AAD: &str = "notification-address";

/// Placeholder e-mails that are not real destinations (`automationNotices.ts:7-10`).
pub const PLACEHOLDER_ADDRESS_SUFFIXES: [&str; 2] = [
    "@pending.payment-gateway.local",
    "@invited.payment-gateway.local",
];

/// The maximum length of the unique `event_id` (`automationNotices.ts:191`).
pub const MAX_EVENT_ID_LENGTH: usize = 191;

/// One template of a notice (`NoticeTemplate`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoticeTemplate {
    pub channel: NotificationChannel,
    pub lang: NotificationLang,
    pub subject: Option<&'static str>,
    pub body: &'static str,
}

/// A notice definition with its bilingual templates (`NoticeDefinition`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoticeDefinition {
    pub code: &'static str,
    pub audience: ConfidentialityClass,
    pub templates: Vec<NoticeTemplate>,
}

/// `bilingualNotice`: in-app and e-mail templates in English and Arabic.
#[must_use]
pub fn bilingual_notice(
    code: &'static str,
    audience: ConfidentialityClass,
    en: (&'static str, &'static str),
    ar: (&'static str, &'static str),
) -> NoticeDefinition {
    NoticeDefinition {
        code,
        audience,
        templates: vec![
            NoticeTemplate {
                channel: NotificationChannel::InApp,
                lang: NotificationLang::En,
                subject: None,
                body: en.1,
            },
            NoticeTemplate {
                channel: NotificationChannel::Email,
                lang: NotificationLang::En,
                subject: Some(en.0),
                body: en.1,
            },
            NoticeTemplate {
                channel: NotificationChannel::InApp,
                lang: NotificationLang::Ar,
                subject: None,
                body: ar.1,
            },
            NoticeTemplate {
                channel: NotificationChannel::Email,
                lang: NotificationLang::Ar,
                subject: Some(ar.0),
                body: ar.1,
            },
        ],
    }
}

/// `JOIN_REQUEST_DRAFT_EXPIRED_NOTICE` (`JoinRequestExpiryWorker.ts:11`).
#[must_use]
pub fn join_request_draft_expired_notice() -> NoticeDefinition {
    bilingual_notice(
        "JOIN_REQUEST_DRAFT_EXPIRED",
        ConfidentialityClass::Merchant,
        (
            "Your merchant application draft has expired",
            "Your merchant application draft was not submitted within {{days}} days and has expired. You can start a new application at any time.",
        ),
        (
            "انتهت صلاحية مسودة طلب الانضمام",
            "انتهت صلاحية مسودة طلب الانضمام الخاص بك لأنها لم تُرسل خلال {{days}} يوما. يمكنك بدء طلب جديد في أي وقت.",
        ),
    )
}

/// `JOIN_REQUEST_REVIEW_EXPIRED_NOTICE`.
#[must_use]
pub fn join_request_review_expired_notice() -> NoticeDefinition {
    bilingual_notice(
        "JOIN_REQUEST_REVIEW_EXPIRED",
        ConfidentialityClass::Merchant,
        (
            "Your merchant application has expired",
            "We could not complete the review of your merchant application in time and it has expired. Please submit a new application.",
        ),
        (
            "انتهت صلاحية طلب الانضمام",
            "لم نتمكن من إكمال مراجعة طلب الانضمام الخاص بك في الوقت المحدد وانتهت صلاحيته. يرجى تقديم طلب جديد.",
        ),
    )
}

/// `APPROVAL_EXPIRED_NOTICE` (`ExpiryHousekeepingWorker.ts`).
#[must_use]
pub fn approval_expired_notice() -> NoticeDefinition {
    bilingual_notice(
        "APPROVAL_REQUEST_EXPIRED",
        ConfidentialityClass::Internal,
        (
            "Your approval request expired",
            "Your approval request for {{subjectType}} {{subjectId}} was not decided before it expired. Submit it again if the change is still needed.",
        ),
        (
            "انتهت صلاحية طلب الموافقة",
            "انتهت صلاحية طلب الموافقة الخاص بك على {{subjectType}} {{subjectId}} قبل اتخاذ قرار بشأنه. قدّمه من جديد إذا كان التغيير لا يزال مطلوبا.",
        ),
    )
}

/// `STAFF_INVITATION_EXPIRED_NOTICE`.
#[must_use]
pub fn staff_invitation_expired_notice() -> NoticeDefinition {
    bilingual_notice(
        "STAFF_INVITATION_EXPIRED",
        ConfidentialityClass::Internal,
        (
            "A staff invitation expired",
            "The invitation for {{email}} expired before it was accepted. Invite the user again if access is still needed.",
        ),
        (
            "انتهت صلاحية دعوة موظف",
            "انتهت صلاحية الدعوة المرسلة إلى {{email}} قبل قبولها. أرسل دعوة جديدة إذا كان الوصول لا يزال مطلوبا.",
        ),
    )
}

/// `maskNoticeAddress`: a redacted address safe for storage and lists.
#[must_use]
pub fn mask_notice_address(value: Option<&str>) -> String {
    let Some(value) = value.filter(|value| !value.is_empty()) else {
        return "merchant-contact".to_owned();
    };
    if let Some((local, domain)) = value.split_once('@') {
        let local: String = local.chars().take(2).collect();
        return format!("{local}***@{domain}");
    }
    let tail: String = {
        let chars: Vec<char> = value.chars().collect();
        let start = chars.len().saturating_sub(4);
        chars[start..].iter().collect()
    };
    format!("*******{tail}")
}

/// `hasRealAddress`: an address that is not a placeholder.
#[must_use]
pub fn has_real_address(value: Option<&str>) -> bool {
    let Some(value) = value else {
        return false;
    };
    value.contains('@')
        && !PLACEHOLDER_ADDRESS_SUFFIXES
            .iter()
            .any(|suffix| value.ends_with(suffix))
}

/// Seals a notification address for the outbox worker.
///
/// The production implementation will call `pg_crypto` (Vault) with
/// [`NOTICE_ADDRESS_AAD`]; tests and dry environments can provide a passthrough.
pub trait NoticeAddressCipher: Send + Sync {
    fn seal(&self, address: &str, associated_data: &str) -> Result<String, WorkerError>;
}

/// The input of [`queue_notice`] (`QueueNoticeInput`).
pub struct QueueNoticeInput<'a> {
    pub definition: &'a NoticeDefinition,
    /// Unique per (subject, stage): the event id becomes `notice:<event_key>:<channel>`.
    pub event_key: &'a str,
    pub payload: Value,
    /// The recipient user; otherwise the merchant's active `MERCHANT_ADMIN`.
    pub user_id: Option<Uuid>,
    pub merchant_id: Option<Uuid>,
    /// Defaults to `[IN_APP, EMAIL]`.
    pub channels: Option<&'a [NotificationChannel]>,
    pub lang: NotificationLang,
    pub cipher: Option<&'a dyn NoticeAddressCipher>,
}

#[derive(Debug, Clone)]
struct UserContact {
    id: Uuid,
    email: Option<String>,
    phone: Option<String>,
    merchant_id: Option<Uuid>,
}

#[derive(Debug, Clone)]
struct MerchantContact {
    id: Uuid,
    contact_email: Option<String>,
    contact_phone: Option<String>,
}

/// `ensureNoticeTemplates`: four rows per definition, duplicate-safe.
pub async fn ensure_notice_templates(
    conn: &mut PgConnection,
    definitions: &[&NoticeDefinition],
) -> Result<(), WorkerError> {
    for definition in definitions {
        for template in &definition.templates {
            sqlx::query(
                "INSERT INTO notification_templates (
                    id, created_at, updated_at, code, channel, lang, subject_template, body_template,
                    confidentiality_class, version, active
                 ) VALUES ($1, now(), now(), $2, $3::\"NotificationChannel\",
                           $4::\"NotificationLang\", $5, $6, $7::\"ConfidentialityClass\", 1, true)
                 ON CONFLICT (code, channel, lang, version) DO NOTHING",
            )
            .bind(Uuid::now_v7())
            .bind(definition.code)
            .bind(template.channel.as_str())
            .bind(template.lang.as_str())
            .bind(template.subject)
            .bind(template.body)
            .bind(confidentiality_str(definition.audience))
            .execute(&mut *conn)
            .await
            .map_err(notice_error)?;
        }
    }
    Ok(())
}

fn confidentiality_str(class: ConfidentialityClass) -> &'static str {
    match class {
        ConfidentialityClass::Public => "PUBLIC",
        ConfidentialityClass::Merchant => "MERCHANT",
        ConfidentialityClass::Internal => "INTERNAL",
    }
}

async fn load_user(conn: &mut PgConnection, id: Uuid) -> Result<Option<UserContact>, WorkerError> {
    let row = sqlx::query("SELECT id, email, phone, merchant_id FROM users WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(notice_error)?;
    Ok(row.map(|row| UserContact {
        id: row.get("id"),
        email: row.get("email"),
        phone: row.get("phone"),
        merchant_id: row.get("merchant_id"),
    }))
}

async fn load_merchant(
    conn: &mut PgConnection,
    id: Uuid,
) -> Result<Option<MerchantContact>, WorkerError> {
    let row = sqlx::query("SELECT id, contact_email, contact_phone FROM merchants WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(notice_error)?;
    Ok(row.map(|row| MerchantContact {
        id: row.get("id"),
        contact_email: row.get("contact_email"),
        contact_phone: row.get("contact_phone"),
    }))
}

async fn load_merchant_admin(
    conn: &mut PgConnection,
    merchant_id: Uuid,
) -> Result<Option<UserContact>, WorkerError> {
    let row = sqlx::query(
        "SELECT id, email, phone, merchant_id FROM users
          WHERE merchant_id = $1 AND role = 'MERCHANT_ADMIN' AND status = 'ACTIVE'
          ORDER BY created_at ASC LIMIT 1",
    )
    .bind(merchant_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(notice_error)?;
    Ok(row.map(|row| UserContact {
        id: row.get("id"),
        email: row.get("email"),
        phone: row.get("phone"),
        merchant_id: row.get("merchant_id"),
    }))
}

/// Queues the notice; returns how many NEW notifications were created (0 on a repeat).
pub async fn queue_notice(
    conn: &mut PgConnection,
    input: &QueueNoticeInput<'_>,
) -> Result<u32, WorkerError> {
    ensure_notice_templates(conn, &[input.definition]).await?;
    let mut user = match input.user_id {
        Some(id) => load_user(conn, id).await?,
        None => None,
    };
    let merchant_id = input
        .merchant_id
        .or_else(|| user.as_ref().and_then(|user| user.merchant_id));
    let merchant = match merchant_id {
        Some(id) => load_merchant(conn, id).await?,
        None => None,
    };
    if user.is_none() {
        if let Some(merchant) = &merchant {
            user = load_merchant_admin(conn, merchant.id).await?;
        }
    }
    if user.is_none() && merchant.is_none() {
        return Ok(0);
    }
    let email = user
        .as_ref()
        .and_then(|user| user.email.as_deref())
        .filter(|value| has_real_address(Some(value)))
        .map(str::to_owned)
        .or_else(|| {
            merchant
                .as_ref()
                .and_then(|merchant| merchant.contact_email.as_deref())
                .filter(|value| has_real_address(Some(value)))
                .map(str::to_owned)
        });
    let phone = user
        .as_ref()
        .and_then(|user| user.phone.clone())
        .or_else(|| {
            merchant
                .as_ref()
                .and_then(|merchant| merchant.contact_phone.clone())
        });
    let default_channels = [NotificationChannel::InApp, NotificationChannel::Email];
    let channels = input.channels.unwrap_or(&default_channels);
    let mut created = 0_u32;
    for channel in channels {
        let address = match channel {
            NotificationChannel::Email => email.clone(),
            NotificationChannel::Sms => phone.clone(),
            NotificationChannel::InApp => None,
        };
        if matches!(
            channel,
            NotificationChannel::Email | NotificationChannel::Sms
        ) && address.is_none()
        {
            continue;
        }
        let ciphertext = match (&address, input.cipher) {
            (Some(address), Some(cipher)) => cipher.seal(address, NOTICE_ADDRESS_AAD)?,
            (Some(_), None) => {
                warn!(
                    notice = input.definition.code,
                    channel = channel.as_str(),
                    "notice address cipher is not configured; skipping the addressed channel"
                );
                continue;
            }
            (None, _) => String::new(),
        };
        let masked = match channel {
            NotificationChannel::InApp => "in-app".to_owned(),
            _ => mask_notice_address(address.as_deref()),
        };
        let event_id = format!("notice:{}:{}", input.event_key, channel.as_str());
        let event_id: String = event_id.chars().take(MAX_EVENT_ID_LENGTH).collect();
        let affected = sqlx::query(
            "INSERT INTO notifications (
                id, created_at, updated_at, event_id, recipient_user_id, recipient_merchant_id,
                address_masked, address_ciphertext, template_code, channel, lang, payload_json,
                status, attempts
             ) VALUES ($1, now(), now(), $2, $3, $4, $5, $6, $7, $8::\"NotificationChannel\",
                       $9::\"NotificationLang\", $10::jsonb, 'QUEUED', 0)
             ON CONFLICT (event_id) DO NOTHING",
        )
        .bind(Uuid::now_v7())
        .bind(&event_id)
        .bind(user.as_ref().map(|user| user.id))
        .bind(merchant.as_ref().map(|merchant| merchant.id))
        .bind(&masked)
        .bind(&ciphertext)
        .bind(input.definition.code)
        .bind(channel.as_str())
        .bind(input.lang.as_str())
        .bind(&input.payload)
        .execute(&mut *conn)
        .await
        .map_err(notice_error)?
        .rows_affected();
        created += u32::try_from(affected).unwrap_or(0);
    }
    Ok(created)
}

fn notice_error(error: sqlx::Error) -> WorkerError {
    WorkerError::Failed(format!("notice: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masked_addresses_never_contain_the_full_local_part() {
        assert_eq!(
            mask_notice_address(Some("merchant@example.com")),
            "me***@example.com"
        );
        assert_eq!(mask_notice_address(Some("+218912345678")), "*******5678");
        assert_eq!(mask_notice_address(None), "merchant-contact");
    }

    #[test]
    fn placeholder_addresses_are_not_real() {
        assert!(has_real_address(Some("ops@example.com")));
        assert!(!has_real_address(Some("x@pending.payment-gateway.local")));
        assert!(!has_real_address(Some("x@invited.payment-gateway.local")));
        assert!(!has_real_address(Some("")));
        assert!(!has_real_address(None));
    }

    #[test]
    fn a_bilingual_notice_has_four_templates() {
        let notice = join_request_draft_expired_notice();
        assert_eq!(notice.templates.len(), 4);
        assert_eq!(notice.audience, ConfidentialityClass::Merchant);
        assert!(notice
            .templates
            .iter()
            .any(|template| template.lang == NotificationLang::Ar
                && template.channel == NotificationChannel::Email));
        assert!(notice.templates[0].body.contains("{{days}}"));
    }
}

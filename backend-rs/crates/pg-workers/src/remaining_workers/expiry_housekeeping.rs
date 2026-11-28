//! Time-driven housekeeping of rows that expire silently (AUTO-05, AUTO-11),
//! `engine/workers/ExpiryHousekeepingWorker.ts`.
//!
//! Six bounded passes (each at most `max_batches_per_tick` batches of `batch_size` rows per tick,
//! all index-backed), each isolated: a failing pass is reported at the end of the tick but never
//! stops the others.
//!
//! 1. approvals: `DRAFT`/`PENDING_REVIEW` approval requests past `expires_at` become `EXPIRED`
//!    (final), EXCEPT emergency ratifications (their deadline policy belongs to the deadline
//!    worker) and subjects with their own lifecycle; the subject is released exactly like a
//!    rejection and the maker is told.
//! 2. invitations: a staff invitation past `invitation_expires_at` loses its token hash, its
//!    still-queued invitation mail is suppressed and unsealed, the inviter is told.
//! 3. payment links: `PENDING` links past `expires_at` become `EXPIRED` and `link.expired` is
//!    written to the outbox in the same transaction.
//! 4. MFA challenges consumed or expired for more than `mfa_retention_hours` are deleted.
//! 5. secrets: the sealed MFA code / invitation token of a notification that is no longer
//!    `QUEUED` is removed after `secret_scrub_after_minutes`.
//! 6. revocations: `session_revocations` rows of tokens that expired anyway are deleted.

#![forbid(unsafe_code)]

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::NaiveDateTime;
use parking_lot::Mutex;
use pg_types::generated::enums::NotificationLang;
use serde_json::json;
use sqlx::{PgConnection, PgPool, Row};
use tracing::{error, info};
use uuid::Uuid;

use crate::cases::tick_now;
use crate::cases::{write_system_audit, SystemAudit};
use crate::notices::{
    approval_expired_notice, mask_notice_address, queue_notice, staff_invitation_expired_notice,
    NoticeAddressCipher, QueueNoticeInput,
};
use crate::remaining_workers::RemainingWorkerError;
use crate::runtime::{Worker, WorkerContext, WorkerError, WorkerOutcome};

/// Approval subjects the housekeeping NEVER expires, normalized without separators.
///
/// Each has its own lifecycle, deadline and money side effects, and closing its approval would
/// strand it (a drafted chargeback keeps its escrowed reserve until a finance checker decides; an
/// AML case, a regulatory report or a cash-out has its own SLA and states).
pub const APPROVAL_SUBJECTS_WITH_OWN_LIFECYCLE: [&str; 7] = [
    "ADJUSTMENT",
    "CASHOUT",
    "CASHOUTREQUEST",
    "AMLCASE",
    "DISPUTE",
    "KYBDOCUMENT",
    "GLSHARDREPAIR",
];

/// The `APPROVAL_SUBJECT_TYPE_ALIASES` of `lib/approvalQueue.ts:14-32`.
const APPROVAL_SUBJECT_TYPE_ALIASES: [(&str, &str); 17] = [
    ("JOINREQUEST", "JOIN_REQUEST"),
    ("KYBDOCUMENT", "KYB_DOCUMENT"),
    ("OPERATORCASE", "OPERATOR_CASE"),
    ("GATEWAYVERSION", "GATEWAY_VERSION"),
    ("AMLCASE", "AML_CASE"),
    ("AMLRULE", "AML_RULE"),
    ("REPORTINGRULE", "REPORTING_RULE"),
    ("REGULATORYREPORT", "REGULATORY_REPORT"),
    ("REGULATORYREPORTSCHEMA", "REGULATORY_REPORT_SCHEMA"),
    (
        "REPORTINGRULESCHEMABINDING",
        "REPORTING_RULE_SCHEMA_BINDING",
    ),
    ("FILINGADAPTER", "FILING_ADAPTER"),
    ("PLATFORMSETTING", "PLATFORM_SETTING"),
    ("COMMISSIONPROFILE", "COMMISSION_PROFILE"),
    ("VELOCITYRULE", "VELOCITY_RULE"),
    ("CASHOUTREQUEST", "CASHOUT_REQUEST"),
    ("CREDENTIALSET", "CREDENTIAL_SET"),
    ("POSTERMINAL", "POS_TERMINAL"),
];

/// `normalizeApprovalSubjectType`: `CASH OUT` / `cash-out` / `CashOut` all become one code.
#[must_use]
pub fn normalize_approval_subject_type(value: &str) -> String {
    let normalized: String = value
        .trim()
        .chars()
        .map(|character| {
            if character.is_whitespace() || character == '-' {
                '_'
            } else {
                character
            }
        })
        .collect::<String>()
        .to_uppercase();
    let key: String = normalized
        .chars()
        .filter(|character| *character != '_')
        .collect();
    APPROVAL_SUBJECT_TYPE_ALIASES
        .iter()
        .find(|(alias, _)| *alias == key)
        .map_or(normalized, |(_, canonical)| (*canonical).to_owned())
}

/// The six passes (`HousekeepingPass`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum HousekeepingPass {
    Approvals,
    Invitations,
    PaymentLinks,
    MfaChallenges,
    Secrets,
    Revocations,
}

impl HousekeepingPass {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Approvals => "approvals",
            Self::Invitations => "invitations",
            Self::PaymentLinks => "paymentLinks",
            Self::MfaChallenges => "mfaChallenges",
            Self::Secrets => "secrets",
            Self::Revocations => "revocations",
        }
    }
}

/// The pass order of `DEFAULT_PASSES`.
pub const HOUSEKEEPING_PASSES: [HousekeepingPass; 6] = [
    HousekeepingPass::Approvals,
    HousekeepingPass::Invitations,
    HousekeepingPass::PaymentLinks,
    HousekeepingPass::MfaChallenges,
    HousekeepingPass::Secrets,
    HousekeepingPass::Revocations,
];

/// Per-pass counters (`HousekeepingSummary.counts`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HousekeepingCounts {
    pub approvals: u64,
    pub invitations: u64,
    pub payment_links: u64,
    pub mfa_challenges: u64,
    pub secrets: u64,
    pub revocations: u64,
}

impl HousekeepingCounts {
    #[must_use]
    pub fn get(&self, pass: HousekeepingPass) -> u64 {
        match pass {
            HousekeepingPass::Approvals => self.approvals,
            HousekeepingPass::Invitations => self.invitations,
            HousekeepingPass::PaymentLinks => self.payment_links,
            HousekeepingPass::MfaChallenges => self.mfa_challenges,
            HousekeepingPass::Secrets => self.secrets,
            HousekeepingPass::Revocations => self.revocations,
        }
    }

    fn set(&mut self, pass: HousekeepingPass, value: u64) {
        match pass {
            HousekeepingPass::Approvals => self.approvals = value,
            HousekeepingPass::Invitations => self.invitations = value,
            HousekeepingPass::PaymentLinks => self.payment_links = value,
            HousekeepingPass::MfaChallenges => self.mfa_challenges = value,
            HousekeepingPass::Secrets => self.secrets = value,
            HousekeepingPass::Revocations => self.revocations = value,
        }
    }

    #[must_use]
    pub fn total(&self) -> u64 {
        self.approvals
            + self.invitations
            + self.payment_links
            + self.mfa_challenges
            + self.secrets
            + self.revocations
    }
}

/// What one tick did (`HousekeepingSummary`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HousekeepingSummary {
    pub counts: HousekeepingCounts,
    pub failed: Vec<HousekeepingPass>,
}

impl HousekeepingSummary {
    #[must_use]
    pub fn processed(&self) -> u64 {
        self.counts.total()
    }
}

/// The configuration of the worker (`ExpiryHousekeepingWorkerDeps`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpiryHousekeepingConfig {
    pub interval_ms: u64,
    pub batch_size: i64,
    pub max_batches_per_tick: u32,
    /// Hours an MFA challenge is kept after it was consumed or expired.
    pub mfa_retention_hours: i64,
    /// Minutes a finished notification keeps its sealed secret.
    pub secret_scrub_after_minutes: i64,
}

impl Default for ExpiryHousekeepingConfig {
    fn default() -> Self {
        Self {
            interval_ms: 15 * 60 * 1_000,
            batch_size: 200,
            max_batches_per_tick: 5,
            mfa_retention_hours: 24,
            secret_scrub_after_minutes: 60,
        }
    }
}

/// AUTO-05 / AUTO-11: closes approvals nobody decided and purges rows that expire silently.
pub struct ExpiryHousekeepingWorker {
    pool: PgPool,
    config: ExpiryHousekeepingConfig,
    notice_cipher: Option<Arc<dyn NoticeAddressCipher>>,
    last_summary: Mutex<Option<HousekeepingSummary>>,
}

impl ExpiryHousekeepingWorker {
    pub fn new(
        pool: PgPool,
        config: ExpiryHousekeepingConfig,
        notice_cipher: Option<Arc<dyn NoticeAddressCipher>>,
    ) -> Self {
        Self {
            pool,
            config,
            notice_cipher,
            last_summary: Mutex::new(None),
        }
    }

    #[must_use]
    pub fn last_summary(&self) -> Option<HousekeepingSummary> {
        self.last_summary.lock().clone()
    }

    /// Runs the six passes. A pass that fails does not stop the others; the tick then reports an
    /// error, so the health registry and the platform monitor see a failing worker (TS parity).
    pub async fn tick_once(&self) -> Result<HousekeepingSummary, WorkerError> {
        if self.config.batch_size < 1 {
            return Err(RemainingWorkerError::Config(
                "ExpiryHousekeepingWorker: batchSize must be positive".to_owned(),
            )
            .into());
        }
        let now = tick_now();
        let mut counts = HousekeepingCounts::default();
        let mut failed = Vec::new();
        let mut errors = Vec::new();
        for pass in HOUSEKEEPING_PASSES {
            match self.run_pass(pass, now).await {
                Ok(done) => counts.set(pass, done),
                Err(error) => {
                    failed.push(pass);
                    errors.push(format!("{}: {error}", pass.as_str()));
                    error!(
                        pass = pass.as_str(),
                        %error,
                        "expiry housekeeping: pass failed"
                    );
                }
            }
        }
        let summary = HousekeepingSummary { counts, failed };
        *self.last_summary.lock() = Some(summary.clone());
        if !summary.failed.is_empty() {
            return Err(WorkerError::Failed(format!(
                "housekeeping passes failed ({})",
                errors.join("; ")
            )));
        }
        if summary.processed() > 0 {
            info!(
                approvals = summary.counts.approvals,
                invitations = summary.counts.invitations,
                payment_links = summary.counts.payment_links,
                mfa_challenges = summary.counts.mfa_challenges,
                secrets = summary.counts.secrets,
                revocations = summary.counts.revocations,
                "expiry housekeeping: housekeeping done"
            );
        }
        Ok(summary)
    }

    /// Runs one pass (each batch in its own transaction) until a batch comes back short.
    async fn run_pass(
        &self,
        pass: HousekeepingPass,
        now: NaiveDateTime,
    ) -> Result<u64, WorkerError> {
        let mut total = 0_u64;
        for _ in 0..self.config.max_batches_per_tick.max(1) {
            let mut tx = self.pool.begin().await.map_err(housekeeping_error)?;
            let done = match pass {
                HousekeepingPass::Approvals => self.expire_approvals(&mut tx, now).await?,
                HousekeepingPass::Invitations => self.expire_invitations(&mut tx, now).await?,
                HousekeepingPass::PaymentLinks => self.expire_payment_links(&mut tx, now).await?,
                HousekeepingPass::MfaChallenges => self.purge_mfa_challenges(&mut tx, now).await?,
                HousekeepingPass::Secrets => self.scrub_notification_secrets(&mut tx, now).await?,
                HousekeepingPass::Revocations => self.purge_revocations(&mut tx, now).await?,
            };
            tx.commit().await.map_err(housekeeping_error)?;
            total += done;
            if done < u64::try_from(self.config.batch_size).unwrap_or(1) {
                break;
            }
        }
        Ok(total)
    }

    // ---- 1. approvals ---------------------------------------------------------------------

    async fn expire_approvals(
        &self,
        conn: &mut PgConnection,
        now: NaiveDateTime,
    ) -> Result<u64, WorkerError> {
        let rows = sqlx::query(
            "WITH target AS (
               SELECT id, state::text AS previous_state, expires_at FROM approval_requests
               WHERE state IN ('DRAFT', 'PENDING_REVIEW') AND expires_at IS NOT NULL AND expires_at < $1
                 AND mode <> 'EMERGENCY_RATIFICATION'
                 AND upper(regexp_replace(subject_type, '[[:space:]_-]+', '', 'g')) <> ALL($3::text[])
               ORDER BY expires_at ASC LIMIT $2 FOR UPDATE SKIP LOCKED
             )
             UPDATE approval_requests a
             SET state = 'EXPIRED',
                 rejection_reason = 'EXPIRED: not decided before ' || to_char(t.expires_at, 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'),
                 updated_at = $1
             FROM target t WHERE a.id = t.id
             RETURNING a.id, a.subject_type, a.subject_id, a.maker_user_id, t.previous_state, t.expires_at",
        )
        .bind(now)
        .bind(self.config.batch_size)
        .bind(
            APPROVAL_SUBJECTS_WITH_OWN_LIFECYCLE
                .iter()
                .map(|value| (*value).to_owned())
                .collect::<Vec<String>>(),
        )
        .fetch_all(&mut *conn)
        .await
        .map_err(housekeeping_error)?;
        let mut expired = 0_u64;
        for row in &rows {
            let approval_id: Uuid = row.try_get("id").map_err(housekeeping_error)?;
            let subject_type: String = row.try_get("subject_type").map_err(housekeeping_error)?;
            let subject_id: String = row.try_get("subject_id").map_err(housekeeping_error)?;
            let maker_user_id: Uuid = row.try_get("maker_user_id").map_err(housekeeping_error)?;
            let previous_state: String =
                row.try_get("previous_state").map_err(housekeeping_error)?;
            let expires_at: NaiveDateTime =
                row.try_get("expires_at").map_err(housekeeping_error)?;
            let normalized = normalize_approval_subject_type(&subject_type);
            write_system_audit(
                conn,
                &SystemAudit::new(
                    "APPROVAL_REQUEST_EXPIRED",
                    "APPROVAL_REQUEST",
                    &approval_id.to_string(),
                    json!({ "state": previous_state }),
                    json!({
                        "state": "EXPIRED",
                        "subjectType": normalized,
                        "subjectId": subject_id,
                        "expiresAt": iso(expires_at),
                    }),
                ),
            )
            .await?;
            self.release_subject(conn, approval_id, &normalized, &subject_id, now)
                .await?;
            let definition = approval_expired_notice();
            let event_key = format!("approval-expired:{approval_id}");
            queue_notice(
                conn,
                &QueueNoticeInput {
                    definition: &definition,
                    event_key: &event_key,
                    payload: json!({ "subjectType": normalized, "subjectId": subject_id }),
                    user_id: Some(maker_user_id),
                    merchant_id: None,
                    channels: None,
                    lang: NotificationLang::En,
                    cipher: self.notice_cipher.as_deref(),
                },
            )
            .await?;
            expired += 1;
        }
        Ok(expired)
    }

    /// What a rejection does to the subject (`POST /approvals/:id/reject`), without a human actor.
    async fn release_subject(
        &self,
        conn: &mut PgConnection,
        approval_id: Uuid,
        subject_type: &str,
        subject_id: &str,
        now: NaiveDateTime,
    ) -> Result<(), WorkerError> {
        match subject_type {
            "OPERATOR_CASE" => {
                let released = sqlx::query(
                    "UPDATE operator_cases SET state = 'IN_PROGRESS', updated_at = $1
                      WHERE id = $2::uuid AND state = 'PENDING_CHECKER'",
                )
                .bind(now)
                .bind(subject_id)
                .execute(&mut *conn)
                .await
                .map_err(housekeeping_error)?
                .rows_affected();
                if released > 0 {
                    write_system_audit(
                        conn,
                        &SystemAudit::new(
                            "OPERATOR_CASE_RESOLUTION_EXPIRED",
                            "OPERATOR_CASE",
                            subject_id,
                            json!({ "state": "PENDING_CHECKER" }),
                            json!({
                                "state": "IN_PROGRESS",
                                "approvalRequestId": approval_id,
                                "reason": "APPROVAL_EXPIRED",
                            }),
                        ),
                    )
                    .await?;
                }
            }
            "JOIN_REQUEST" => {
                let released = sqlx::query(
                    "UPDATE join_requests SET status = 'IN_REVIEW', approval_request_id = NULL, updated_at = $1
                      WHERE id = $2::uuid AND approval_request_id = $3::uuid AND status = 'PENDING_CHECKER'",
                )
                .bind(now)
                .bind(subject_id)
                .bind(approval_id)
                .execute(&mut *conn)
                .await
                .map_err(housekeeping_error)?
                .rows_affected();
                if released > 0 {
                    write_system_audit(
                        conn,
                        &SystemAudit::new(
                            "JOIN_REQUEST_APPROVAL_EXPIRED",
                            "JOIN_REQUEST",
                            subject_id,
                            json!({ "state": "PENDING_CHECKER" }),
                            json!({
                                "state": "IN_REVIEW",
                                "approvalRequestId": approval_id,
                                "reason": "APPROVAL_EXPIRED",
                            }),
                        ),
                    )
                    .await?;
                }
            }
            "REGULATORY_REPORT" => {
                let changed = sqlx::query(
                    "UPDATE regulatory_reports SET status = 'DRAFT', approval_request_id = NULL, updated_at = $1
                      WHERE id = $2::uuid AND status = 'PENDING_CHECKER'",
                )
                .bind(now)
                .bind(subject_id)
                .execute(&mut *conn)
                .await
                .map_err(housekeeping_error)?
                .rows_affected();
                if changed > 0 {
                    write_system_audit(
                        conn,
                        &SystemAudit::new(
                            "REGULATORY_REPORT_APPROVAL_EXPIRED",
                            "REGULATORY_REPORT",
                            subject_id,
                            json!({ "status": "PENDING_CHECKER" }),
                            json!({
                                "status": "DRAFT",
                                "approvalRequestId": approval_id,
                                "reason": "APPROVAL_EXPIRED",
                            }),
                        ),
                    )
                    .await?;
                }
            }
            "REPORTING_RULE" => {
                let changed = sqlx::query(
                    "UPDATE reporting_rules SET status = 'PROVISIONAL', approval_request_id = NULL, updated_at = $1
                      WHERE id = $2::uuid",
                )
                .bind(now)
                .bind(subject_id)
                .execute(&mut *conn)
                .await
                .map_err(housekeeping_error)?
                .rows_affected();
                if changed > 0 {
                    write_system_audit(
                        conn,
                        &SystemAudit::new(
                            "REPORTING_RULE_APPROVAL_EXPIRED",
                            "REPORTING_RULE",
                            subject_id,
                            json!({ "status": "PROVISIONAL" }),
                            json!({
                                "status": "PROVISIONAL",
                                "approvalRequestId": approval_id,
                                "reason": "APPROVAL_EXPIRED",
                            }),
                        ),
                    )
                    .await?;
                }
            }
            "REGULATORY_REPORT_SCHEMA" => {
                let changed = sqlx::query(
                    "UPDATE regulatory_report_schemas SET status = 'DRAFT', approval_request_id = NULL, updated_at = $1
                      WHERE id = $2::uuid AND status = 'PENDING_APPROVAL'",
                )
                .bind(now)
                .bind(subject_id)
                .execute(&mut *conn)
                .await
                .map_err(housekeeping_error)?
                .rows_affected();
                if changed > 0 {
                    write_system_audit(
                        conn,
                        &SystemAudit::new(
                            "REGULATORY_REPORT_SCHEMA_APPROVAL_EXPIRED",
                            "REGULATORY_REPORT_SCHEMA",
                            subject_id,
                            json!({ "status": "PENDING_APPROVAL" }),
                            json!({
                                "status": "DRAFT",
                                "approvalRequestId": approval_id,
                                "reason": "APPROVAL_EXPIRED",
                            }),
                        ),
                    )
                    .await?;
                }
            }
            "MERCHANT" => {
                write_system_audit(
                    conn,
                    &SystemAudit::new(
                        "MERCHANT_CHANGE_EXPIRED",
                        "MERCHANT",
                        subject_id,
                        json!({ "state": "PENDING_REVIEW" }),
                        json!({
                            "state": "EXPIRED",
                            "approvalRequestId": approval_id,
                        }),
                    ),
                )
                .await?;
            }
            _ => {}
        }
        Ok(())
    }

    // ---- 2. staff invitations -------------------------------------------------------------

    async fn expire_invitations(
        &self,
        conn: &mut PgConnection,
        now: NaiveDateTime,
    ) -> Result<u64, WorkerError> {
        let rows = sqlx::query(
            "UPDATE users SET invitation_token_hash = NULL, updated_at = $1
             WHERE id IN (
               SELECT id FROM users
               WHERE status = 'INVITED' AND invitation_token_hash IS NOT NULL
                 AND invitation_expires_at IS NOT NULL AND invitation_expires_at < $1
               ORDER BY invitation_expires_at ASC LIMIT $2 FOR UPDATE SKIP LOCKED
             )
             RETURNING id, email, invited_by, invitation_expires_at",
        )
        .bind(now)
        .bind(self.config.batch_size)
        .fetch_all(&mut *conn)
        .await
        .map_err(housekeeping_error)?;
        let mut expired = 0_u64;
        for row in &rows {
            let user_id: Uuid = row.try_get("id").map_err(housekeeping_error)?;
            let email: String = row.try_get("email").map_err(housekeeping_error)?;
            let invited_by: Option<Uuid> = row.try_get("invited_by").map_err(housekeeping_error)?;
            let invitation_expires_at: NaiveDateTime = row
                .try_get("invitation_expires_at")
                .map_err(housekeeping_error)?;
            // The invitation mail may still be waiting in the queue: it must not be sent, and its
            // sealed token goes.
            sqlx::query(
                "UPDATE notifications
                    SET status = 'SUPPRESSED', payload_json = payload_json - 'tokenCiphertext',
                        updated_at = $1
                  WHERE recipient_user_id = $2 AND template_code = 'STAFF_INVITATION'
                    AND status = 'QUEUED'",
            )
            .bind(now)
            .bind(user_id)
            .execute(&mut *conn)
            .await
            .map_err(housekeeping_error)?;
            write_system_audit(
                conn,
                &SystemAudit::new(
                    "STAFF_INVITATION_EXPIRED",
                    "USER",
                    &user_id.to_string(),
                    json!({ "status": "INVITED" }),
                    json!({
                        "status": "INVITED",
                        "invitationExpiresAt": iso(invitation_expires_at),
                        "tokenRevoked": true,
                    }),
                ),
            )
            .await?;
            if let Some(invited_by) = invited_by {
                let definition = staff_invitation_expired_notice();
                let event_key = format!(
                    "invitation-expired:{user_id}:{}",
                    invitation_expires_at.and_utc().timestamp_millis()
                );
                queue_notice(
                    conn,
                    &QueueNoticeInput {
                        definition: &definition,
                        event_key: &event_key,
                        payload: json!({ "email": mask_notice_address(Some(&email)) }),
                        user_id: Some(invited_by),
                        merchant_id: None,
                        channels: None,
                        lang: NotificationLang::En,
                        cipher: self.notice_cipher.as_deref(),
                    },
                )
                .await?;
            }
            expired += 1;
        }
        Ok(expired)
    }

    // ---- 3. payment links -----------------------------------------------------------------

    async fn expire_payment_links(
        &self,
        conn: &mut PgConnection,
        now: NaiveDateTime,
    ) -> Result<u64, WorkerError> {
        let rows = sqlx::query(
            "WITH target AS (
               SELECT id FROM payment_links
               WHERE state = 'PENDING' AND expires_at IS NOT NULL AND expires_at < $1
               ORDER BY expires_at ASC LIMIT $2 FOR UPDATE SKIP LOCKED
             )
             UPDATE payment_links l SET state = 'EXPIRED', updated_at = $1
             FROM target t WHERE l.id = t.id
             RETURNING l.id, l.key, l.application_id, l.expires_at",
        )
        .bind(now)
        .bind(self.config.batch_size)
        .fetch_all(&mut *conn)
        .await
        .map_err(housekeeping_error)?;
        if rows.is_empty() {
            return Ok(0);
        }
        let ids: Vec<Uuid> = rows
            .iter()
            .map(|row| row.try_get("id").map_err(housekeeping_error))
            .collect::<Result<_, _>>()?;
        // `link.expired` for the merchant webhook, in the same transaction as the state change.
        sqlx::query(
            "INSERT INTO outbox_events (topic, aggregate_type, aggregate_id, merchant_id, payload_json)
             SELECT 'link.expired', 'payment_link', l.id::text, a.merchant_id,
                    jsonb_build_object('linkId', l.id::text, 'linkKey', l.key, 'expiredAt', $2::text)
             FROM payment_links l JOIN applications a ON a.id = l.application_id
             WHERE l.id = ANY($1::uuid[])",
        )
        .bind(&ids)
        .bind(iso(now))
        .execute(&mut *conn)
        .await
        .map_err(housekeeping_error)?;
        Ok(u64::try_from(rows.len()).unwrap_or(0))
    }

    // ---- 4. MFA challenges ----------------------------------------------------------------

    async fn purge_mfa_challenges(
        &self,
        conn: &mut PgConnection,
        now: NaiveDateTime,
    ) -> Result<u64, WorkerError> {
        let cutoff = now - chrono::Duration::hours(self.config.mfa_retention_hours.max(1));
        let deleted = sqlx::query(
            "DELETE FROM mfa_challenges WHERE id IN (
               SELECT id FROM mfa_challenges
               WHERE expires_at < $1 OR (consumed_at IS NOT NULL AND consumed_at < $1)
               ORDER BY expires_at ASC LIMIT $2
             )",
        )
        .bind(cutoff)
        .bind(self.config.batch_size)
        .execute(&mut *conn)
        .await
        .map_err(housekeeping_error)?
        .rows_affected();
        Ok(deleted)
    }

    // ---- 5. sealed secrets of finished notifications --------------------------------------

    async fn scrub_notification_secrets(
        &self,
        conn: &mut PgConnection,
        now: NaiveDateTime,
    ) -> Result<u64, WorkerError> {
        let cutoff = now - chrono::Duration::minutes(self.config.secret_scrub_after_minutes.max(1));
        let updated = sqlx::query(
            "UPDATE notifications
                SET payload_json = payload_json - 'codeCiphertext' - 'tokenCiphertext',
                    updated_at = $2
              WHERE id IN (
                SELECT id FROM notifications
                WHERE status <> 'QUEUED'
                  AND (payload_json ? 'codeCiphertext' OR payload_json ? 'tokenCiphertext')
                  AND updated_at < $1
                ORDER BY updated_at ASC LIMIT $3
              )",
        )
        .bind(cutoff)
        .bind(now)
        .bind(self.config.batch_size)
        .execute(&mut *conn)
        .await
        .map_err(housekeeping_error)?
        .rows_affected();
        Ok(updated)
    }

    // ---- 6. session revocations -----------------------------------------------------------

    async fn purge_revocations(
        &self,
        conn: &mut PgConnection,
        now: NaiveDateTime,
    ) -> Result<u64, WorkerError> {
        let now = now.and_utc();
        let deleted = sqlx::query(
            "DELETE FROM session_revocations WHERE jti IN (
               SELECT jti FROM session_revocations
               WHERE expires_at < $1
               ORDER BY expires_at ASC LIMIT $2
             )",
        )
        .bind(now)
        .bind(self.config.batch_size)
        .execute(&mut *conn)
        .await
        .map_err(housekeeping_error)?
        .rows_affected();
        Ok(deleted)
    }
}

fn iso(value: NaiveDateTime) -> String {
    value
        .and_utc()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[async_trait]
impl Worker for ExpiryHousekeepingWorker {
    fn name(&self) -> &'static str {
        "ExpiryHousekeepingWorker"
    }

    fn interval(&self) -> Duration {
        Duration::from_millis(self.config.interval_ms.max(1))
    }

    fn singleton(&self) -> bool {
        true
    }

    async fn tick(&self, ctx: &WorkerContext) -> Result<WorkerOutcome, WorkerError> {
        if ctx.shutting_down() {
            return Ok(WorkerOutcome::Deferred);
        }
        let summary = self.tick_once().await?;
        if summary.processed() == 0 {
            Ok(WorkerOutcome::Skipped)
        } else {
            Ok(WorkerOutcome::Processed(summary.processed()))
        }
    }
}

fn housekeeping_error(error: sqlx::Error) -> WorkerError {
    WorkerError::Failed(format!("expiry housekeeping: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subject_types_are_normalized_like_the_typescript_alias_map() {
        assert_eq!(
            normalize_approval_subject_type("JOIN_REQUEST"),
            "JOIN_REQUEST"
        );
        assert_eq!(
            normalize_approval_subject_type("join request"),
            "JOIN_REQUEST"
        );
        assert_eq!(normalize_approval_subject_type("cash-out"), "CASH_OUT");
        assert_eq!(
            normalize_approval_subject_type(" A m l - C a s e "),
            "AML_CASE"
        );
        assert_eq!(normalize_approval_subject_type("WALLET"), "WALLET");
    }

    #[test]
    fn the_lifecycle_exclusions_are_the_normalized_codes() {
        for code in APPROVAL_SUBJECTS_WITH_OWN_LIFECYCLE {
            assert_eq!(code, code.to_uppercase());
            assert!(!code.contains('_'));
            assert!(!code.contains('-'));
        }
    }

    #[test]
    fn counts_and_pass_names_match_typescript() {
        let mut counts = HousekeepingCounts::default();
        counts.set(HousekeepingPass::PaymentLinks, 3);
        assert_eq!(counts.get(HousekeepingPass::PaymentLinks), 3);
        assert_eq!(counts.total(), 3);
        assert_eq!(HousekeepingPass::MfaChallenges.as_str(), "mfaChallenges");
        assert_eq!(HousekeepingPass::Secrets.as_str(), "secrets");
    }

    #[test]
    fn defaults_match_the_typescript_worker() {
        let config = ExpiryHousekeepingConfig::default();
        assert_eq!(config.batch_size, 200);
        assert_eq!(config.mfa_retention_hours, 24);
        assert_eq!(config.secret_scrub_after_minutes, 60);
    }
}

//! Maker-checker guard and the pure approval decision.
//!
//! Ports:
//!
//! - `core-back/api/middleware/makerCheckerGuard.ts` (`actorFromRequest`,
//!   `assertCheckerIsNotMaker`, `assertCheckerAuthority`);
//! - `core-back/lib/approvalQueue.ts` (`APPROVAL_PENDING_STATES`, `approvalIsExpired`);
//! - `core-back/engine/governance/ApprovalService.ts:440-462` (`assertPending`);
//! - `core-back/engine/governance/GovernanceExecution.ts:4181-4230` (domain checker, maker ≠ checker,
//!   no automation checker, route-health `gateway:write`);
//! - `core-back/api/internal/admin.ts:7162-7220` (the approve/reject route guards);
//! - `core-back/api/internal/adminReportEngine.ts:1739-1753` (the AML-bypass variant, which expires
//!   at equality and is pending only in `PENDING_REVIEW`).
//!
//! The functions are pure: no I/O, no clock, no transaction. A caller loads the request, passes the
//! authenticated principal and the database clock, and executes the subject only when the outcome
//! says so.

#![forbid(unsafe_code)]

use pg_types::JsDate;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::GovError;
use crate::subject::{ApprovalSubjectType, Role};

/// `SYSTEM_AUTOMATION` (the literal id the TS sends for the drafting principal).
pub const SYSTEM_AUTOMATION: &str = "SYSTEM_AUTOMATION";
/// The e-mail of the canonical disabled system drafter.
pub const SYSTEM_AUTOMATION_EMAIL: &str = "system-drafter@payment-gateway.internal";
/// `APPROVAL_PENDING_STATES`: the admin route lets a DRAFT approval be decided too.
pub const APPROVAL_PENDING_STATES: &[ApprovalState] =
    &[ApprovalState::Draft, ApprovalState::PendingReview];

/// `ApprovalState` (`approval_requests.state`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ApprovalState {
    Draft,
    PendingReview,
    Approved,
    Executed,
    Rejected,
    /// Not decided before `expires_at`; closed by the expiry housekeeping worker (AUTO-05).
    Expired,
}

impl ApprovalState {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "DRAFT",
            Self::PendingReview => "PENDING_REVIEW",
            Self::Approved => "APPROVED",
            Self::Executed => "EXECUTED",
            Self::Rejected => "REJECTED",
            Self::Expired => "EXPIRED",
        }
    }

    /// The states the approve/reject route accepts.
    #[must_use]
    pub const fn is_decidable(self) -> bool {
        matches!(self, Self::Draft | Self::PendingReview)
    }

    /// A final state: a decision can no longer change it.
    ///
    /// `APPROVED` is deliberately not terminal: it awaits execution.
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Executed | Self::Rejected | Self::Expired)
    }

    #[must_use]
    pub const fn is_approved(self) -> bool {
        matches!(self, Self::Approved | Self::Executed)
    }
}

impl std::fmt::Display for ApprovalState {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// `ApprovalMode` (`approval_requests.mode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ApprovalMode {
    Standard,
    EmergencyRatification,
}

impl ApprovalMode {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Standard => "STANDARD",
            Self::EmergencyRatification => "EMERGENCY_RATIFICATION",
        }
    }
}

/// The two decisions the approve/reject routes record.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ApprovalDecision {
    Approve,
    Reject,
}

impl ApprovalDecision {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Approve => "APPROVE",
            Self::Reject => "REJECT",
        }
    }
}

/// The subset of `approval_requests` the decision needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalRequest {
    pub id: Uuid,
    pub subject_type: ApprovalSubjectType,
    pub subject_id: String,
    pub state: ApprovalState,
    pub mode: ApprovalMode,
    /// A user UUID, or [`SYSTEM_AUTOMATION`] for a system-drafted request.
    pub maker_user_id: String,
    pub checker_user_id: Option<String>,
    pub expires_at: Option<JsDate>,
    pub base_version: Option<i64>,
    pub rejection_reason: Option<String>,
}

impl ApprovalRequest {
    #[must_use]
    pub fn new(
        id: Uuid,
        subject_type: ApprovalSubjectType,
        subject_id: impl Into<String>,
        maker_user_id: impl Into<String>,
    ) -> Self {
        Self {
            id,
            subject_type,
            subject_id: subject_id.into(),
            state: ApprovalState::PendingReview,
            mode: ApprovalMode::Standard,
            maker_user_id: maker_user_id.into(),
            checker_user_id: None,
            expires_at: None,
            base_version: None,
            rejection_reason: None,
        }
    }

    /// `approvalIsExpired`: `expiresAt < now` (strict; equality is still live).
    #[must_use]
    pub fn is_expired(&self, now: JsDate) -> bool {
        self.expires_at.is_some_and(|expires_at| expires_at < now)
    }

    /// The AML-bypass route variant: `expiresAt <= now` expires.
    #[must_use]
    pub fn is_expired_inclusive(&self, now: JsDate) -> bool {
        self.expires_at.is_some_and(|expires_at| expires_at <= now)
    }
}

/// `actorFromRequest`: the authenticated checker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckerContext {
    pub user_id: String,
    pub role: Role,
    /// The principal holds `approval:check`.
    pub is_checker: bool,
    /// Authorities held by the principal (only `gateway:write` is read).
    pub authorities: Vec<String>,
}

impl CheckerContext {
    #[must_use]
    pub fn new(user_id: impl Into<String>, role: Role, is_checker: bool) -> Self {
        Self {
            user_id: user_id.into(),
            role,
            is_checker,
            authorities: Vec::new(),
        }
    }

    #[must_use]
    pub fn with_authorities(
        mut self,
        authorities: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        self.authorities = authorities.into_iter().map(Into::into).collect();
        self
    }

    #[must_use]
    pub fn has_authority(&self, authority: &str) -> bool {
        self.authorities
            .iter()
            .any(|held| held == authority || held == "*")
    }
}

/// True for the system drafter id or e-mail. (`actorFromRequest` rejects the id; the dispatcher
/// also looks the e-mail up in the user table.)
#[must_use]
pub fn is_system_automation(principal: &str) -> bool {
    principal == SYSTEM_AUTOMATION || principal.eq_ignore_ascii_case(SYSTEM_AUTOMATION_EMAIL)
}

/// `assertCheckerIsNotMaker` plus the automation rule and the domain role.
///
/// The four requested codes are used; see [`GovError::code`]/[`GovError::ts_code`].
pub fn ensure_maker_checker(
    maker_user_id: &str,
    checker_user_id: &str,
    domain_checker_allowed: bool,
    subject: ApprovalSubjectType,
) -> Result<(), GovError> {
    if maker_user_id.is_empty() {
        return Err(GovError::MakerMissing);
    }
    if checker_user_id.is_empty() {
        return Err(GovError::CheckerMissing);
    }
    if is_system_automation(checker_user_id) {
        return Err(GovError::AutomationCannotActAsChecker);
    }
    if maker_user_id == checker_user_id {
        return Err(GovError::MakerCheckerSameUser);
    }
    if !domain_checker_allowed {
        return Err(GovError::CheckerAuthorityRequired { subject });
    }
    Ok(())
}

/// `assertDomainChecker`: unknown subjects have no domain rule and always pass.
pub fn ensure_checker_role(subject: ApprovalSubjectType, role: Role) -> Result<(), GovError> {
    match subject.domain_checker_roles() {
        Some(allowed) if !allowed.contains(&role) => Err(GovError::DomainCheckerRequired {
            subject,
            checker_role: role,
            allowed,
        }),
        _ => Ok(()),
    }
}

/// `assertBaseVersion`: a base-versioned approval must match the subject's current version.
pub fn ensure_base_version(
    request: &ApprovalRequest,
    current_version: Option<i64>,
) -> Result<(), GovError> {
    let Some(base) = request.base_version else {
        return Ok(());
    };
    let Some(current) = current_version else {
        return Err(GovError::BaseVersionUnavailable);
    };
    if base != current {
        return Err(GovError::BaseVersionMismatch { base, current });
    }
    Ok(())
}

/// The pure result of a decision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalOutcome {
    /// `APPROVED` or `REJECTED`; the caller writes `EXECUTED` after the subject handler commits.
    pub decision_state: ApprovalState,
    /// The approve route runs `executeApprovalSubject` in the same transaction.
    pub execute_subject: bool,
    /// Recorded on the row for a rejection.
    pub rejection_reason: Option<String>,
}

/// Enforce pending + unexpired + maker ≠ checker + checker authority + domain role, then decide.
///
/// `rejection_reason` is required for [`ApprovalDecision::Reject`] and ignored for an approval.
pub fn decide(
    request: &ApprovalRequest,
    decision: ApprovalDecision,
    checker: &CheckerContext,
    now: JsDate,
    rejection_reason: Option<&str>,
) -> Result<ApprovalOutcome, GovError> {
    decide_with(request, decision, checker, now, rejection_reason, true)
}

/// [`decide`] with the `executeImmediately` flag of `ApprovalService`.
pub fn decide_with(
    request: &ApprovalRequest,
    decision: ApprovalDecision,
    checker: &CheckerContext,
    now: JsDate,
    rejection_reason: Option<&str>,
    execute_immediately: bool,
) -> Result<ApprovalOutcome, GovError> {
    // 1. The checker is a human being (never the system drafter).
    if is_system_automation(&checker.user_id) {
        return Err(GovError::AutomationCannotActAsChecker);
    }
    // 2. Both sides are named.
    if request.maker_user_id.is_empty() {
        return Err(GovError::MakerMissing);
    }
    if checker.user_id.is_empty() {
        return Err(GovError::CheckerMissing);
    }
    // 3. Maker and checker are different users.
    if request.maker_user_id == checker.user_id {
        return Err(GovError::MakerCheckerSameUser);
    }
    // 4. The generic approval authority.
    if !checker.is_checker {
        return Err(GovError::CheckerAuthorityRequired {
            subject: request.subject_type,
        });
    }
    // 5. Subject-specific extra authority: a route-health override needs `gateway:write`.
    if request.subject_type == ApprovalSubjectType::RouteHealthOverride
        && !checker.has_authority("gateway:write")
    {
        return Err(GovError::MissingAuthority {
            subject: request.subject_type,
            authority: "gateway:write",
        });
    }
    // 6. Pending (DRAFT or PENDING_REVIEW).
    if !request.state.is_decidable() {
        return Err(GovError::ApprovalNotPending {
            state: request.state,
        });
    }
    // 7. Unexpired.
    if request.is_expired(now) {
        return Err(GovError::ApprovalExpired);
    }
    // 8. The checker owns the subject's domain.
    ensure_checker_role(request.subject_type, checker.role)?;

    match decision {
        ApprovalDecision::Approve => Ok(ApprovalOutcome {
            decision_state: ApprovalState::Approved,
            execute_subject: execute_immediately,
            rejection_reason: None,
        }),
        ApprovalDecision::Reject => {
            let reason = rejection_reason.map(str::trim).unwrap_or("");
            if reason.is_empty() {
                return Err(GovError::RejectionReasonRequired);
            }
            Ok(ApprovalOutcome {
                decision_state: ApprovalState::Rejected,
                execute_subject: false,
                rejection_reason: Some(reason.to_owned()),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(year: i32, month: u32, day: u32) -> JsDate {
        format!("{year:04}-{month:02}-{day:02}T12:00:00Z")
            .parse()
            .expect("valid timestamp")
    }

    fn request_for(subject: ApprovalSubjectType, maker: &str) -> ApprovalRequest {
        ApprovalRequest::new(Uuid::nil(), subject, "subject-1", maker)
    }

    fn finance_checker() -> CheckerContext {
        CheckerContext::new("checker", Role::Finance, true)
    }

    #[test]
    fn maker_cannot_check() {
        let request = request_for(ApprovalSubjectType::Adjustment, "maker");
        let error = decide(
            &request,
            ApprovalDecision::Approve,
            &CheckerContext::new("maker", Role::Finance, true),
            at(2026, 11, 28),
            None,
        )
        .expect_err("same user");
        assert_eq!(error, GovError::MakerCheckerSameUser);
        assert_eq!(error.code(), "MAKER_CHECKER_SAME_USER");
    }

    #[test]
    fn automation_can_never_check() {
        let request = request_for(ApprovalSubjectType::Adjustment, "maker");
        let error = decide(
            &request,
            ApprovalDecision::Approve,
            &CheckerContext::new(SYSTEM_AUTOMATION, Role::Finance, true),
            at(2026, 11, 28),
            None,
        )
        .expect_err("automation");
        assert_eq!(error, GovError::AutomationCannotActAsChecker);
    }

    #[test]
    fn the_generic_authority_is_required() {
        let request = request_for(ApprovalSubjectType::Adjustment, "maker");
        let error = decide(
            &request,
            ApprovalDecision::Approve,
            &CheckerContext::new("checker", Role::Finance, false),
            at(2026, 11, 28),
            None,
        )
        .expect_err("no approval:check");
        assert_eq!(error.code(), "CHECKER_AUTHORITY_REQUIRED");
        assert_eq!(error.ts_code(), "APPROVAL_CHECKER_AUTHORITY_REQUIRED");
    }

    #[test]
    fn the_domain_role_is_required() {
        let request = request_for(ApprovalSubjectType::AmlCase, "maker");
        let error = decide(
            &request,
            ApprovalDecision::Approve,
            &finance_checker(),
            at(2026, 11, 28),
            None,
        )
        .expect_err("FINANCE cannot check an AML case");
        assert!(matches!(
            error,
            GovError::DomainCheckerRequired {
                subject: ApprovalSubjectType::AmlCase,
                ..
            }
        ));
        assert_eq!(error.ts_code(), "DOMAIN_CHECKER_REQUIRED");

        let mlro = CheckerContext::new("checker", Role::Mlro, true);
        assert!(decide(
            &request,
            ApprovalDecision::Approve,
            &mlro,
            at(2026, 11, 28),
            None
        )
        .is_ok());
    }

    #[test]
    fn a_decided_or_expired_request_is_refused() {
        let mut request = request_for(ApprovalSubjectType::Adjustment, "maker");
        request.state = ApprovalState::Executed;
        let error = decide(
            &request,
            ApprovalDecision::Approve,
            &finance_checker(),
            at(2026, 11, 28),
            None,
        )
        .expect_err("executed");
        assert_eq!(error.code(), "APPROVAL_NOT_PENDING");
        assert_eq!(
            error,
            GovError::ApprovalNotPending {
                state: ApprovalState::Executed
            }
        );

        let mut request = request_for(ApprovalSubjectType::Adjustment, "maker");
        request.expires_at = Some(at(2026, 11, 27));
        let error = decide(
            &request,
            ApprovalDecision::Approve,
            &finance_checker(),
            at(2026, 11, 28),
            None,
        )
        .expect_err("expired");
        assert_eq!(error, GovError::ApprovalExpired);
        assert_eq!(error.code(), "APPROVAL_EXPIRED");
    }

    #[test]
    fn expiry_is_strict_at_equality_for_the_generic_route() {
        let mut request = request_for(ApprovalSubjectType::Adjustment, "maker");
        request.expires_at = Some(at(2026, 11, 28));
        assert!(decide(
            &request,
            ApprovalDecision::Approve,
            &finance_checker(),
            at(2026, 11, 28),
            None,
        )
        .is_ok());
        // The AML-bypass route compares with `<=`.
        assert!(!request.is_expired(at(2026, 11, 28)));
        assert!(request.is_expired_inclusive(at(2026, 11, 28)));
    }

    #[test]
    fn rejection_requires_a_reason_and_never_executes() {
        let request = request_for(ApprovalSubjectType::Merchant, "maker");
        let checker = CheckerContext::new("checker", Role::Compliance, true);
        let error = decide(
            &request,
            ApprovalDecision::Reject,
            &checker,
            at(2026, 11, 28),
            Some("   "),
        )
        .expect_err("blank reason");
        assert_eq!(error, GovError::RejectionReasonRequired);

        let outcome = decide(
            &request,
            ApprovalDecision::Reject,
            &checker,
            at(2026, 11, 28),
            Some("duplicate merchant"),
        )
        .expect("reject");
        assert_eq!(outcome.decision_state, ApprovalState::Rejected);
        assert!(!outcome.execute_subject);
        assert_eq!(
            outcome.rejection_reason.as_deref(),
            Some("duplicate merchant")
        );
    }

    #[test]
    fn approve_without_immediate_execution_stays_approved() {
        let request = request_for(ApprovalSubjectType::Adjustment, "maker");
        let outcome = decide_with(
            &request,
            ApprovalDecision::Approve,
            &finance_checker(),
            at(2026, 11, 28),
            None,
            false,
        )
        .expect("approve");
        assert_eq!(outcome.decision_state, ApprovalState::Approved);
        assert!(!outcome.execute_subject);
        assert!(outcome.decision_state.is_approved());
        assert!(!outcome.decision_state.is_terminal());
    }

    #[test]
    fn route_health_needs_gateway_write() {
        let request = request_for(ApprovalSubjectType::RouteHealthOverride, "maker");
        let security = CheckerContext::new("checker", Role::SecurityAdmin, true);
        let error = decide(
            &request,
            ApprovalDecision::Approve,
            &security,
            at(2026, 11, 28),
            None,
        )
        .expect_err("gateway:write");
        assert_eq!(error.ts_code(), "ROUTE_HEALTH_CHECKER_AUTHORITY_REQUIRED");

        let allowed = security.with_authorities(["gateway:read", "gateway:write"]);
        assert!(decide(
            &request,
            ApprovalDecision::Approve,
            &allowed,
            at(2026, 11, 28),
            None
        )
        .is_ok());
    }

    #[test]
    fn ensure_maker_checker_codes() {
        assert_eq!(
            ensure_maker_checker("", "checker", true, ApprovalSubjectType::User),
            Err(GovError::MakerMissing)
        );
        assert_eq!(
            ensure_maker_checker("maker", "", true, ApprovalSubjectType::User),
            Err(GovError::CheckerMissing)
        );
        assert_eq!(
            ensure_maker_checker("same", "same", true, ApprovalSubjectType::User),
            Err(GovError::MakerCheckerSameUser)
        );
        assert_eq!(
            ensure_maker_checker("maker", "checker", true, ApprovalSubjectType::User),
            Ok(())
        );
        assert_eq!(
            ensure_maker_checker("maker", "checker", false, ApprovalSubjectType::User),
            Err(GovError::CheckerAuthorityRequired {
                subject: ApprovalSubjectType::User
            })
        );
    }

    #[test]
    fn base_version_is_checked() {
        let mut request = request_for(ApprovalSubjectType::Merchant, "maker");
        assert_eq!(ensure_base_version(&request, None), Ok(()));
        request.base_version = Some(4);
        assert_eq!(ensure_base_version(&request, Some(4)), Ok(()));
        assert_eq!(
            ensure_base_version(&request, Some(5)),
            Err(GovError::BaseVersionMismatch {
                base: 4,
                current: 5
            })
        );
        assert_eq!(
            ensure_base_version(&request, None),
            Err(GovError::BaseVersionUnavailable)
        );
    }
}

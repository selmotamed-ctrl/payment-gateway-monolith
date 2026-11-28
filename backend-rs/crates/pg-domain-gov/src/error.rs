//! Governance errors and their wire codes.
//!
//! Port of the maker-checker guards in `core-back/api/middleware/makerCheckerGuard.ts` and
//! `core-back/engine/governance/GovernanceExecution.ts:4181-4217`, plus
//! `ApprovalService.assertPending` (`engine/governance/ApprovalService.ts:454-462`).
//!
//! The coordinator's brief fixed four short codes (`MAKER_CHECKER_SAME_USER`,
//! `CHECKER_AUTHORITY_REQUIRED`, `APPROVAL_EXPIRED`, `APPROVAL_NOT_PENDING`). [`GovError::code`]
//! returns those; [`GovError::ts_code`] returns the exact `ApiError` code the TypeScript route
//! answers with, so a parity test can compare the wire behaviour without changing the requested
//! vocabulary.

#![forbid(unsafe_code)]

use crate::approval::ApprovalState;
use crate::subject::{ApprovalSubjectType, Role};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum GovError {
    #[error("The approval request has no maker")]
    MakerMissing,
    #[error("A checker is required before execution")]
    CheckerMissing,
    #[error("The maker and the checker must be different users")]
    MakerCheckerSameUser,
    #[error("System automation can never act as a checker")]
    AutomationCannotActAsChecker,
    #[error("The principal is not authorised to check an approval")]
    CheckerAuthorityRequired { subject: ApprovalSubjectType },
    #[error("A {subject} approval requires checker role {checker_role}, one of: {allowed:?}")]
    DomainCheckerRequired {
        subject: ApprovalSubjectType,
        checker_role: Role,
        allowed: &'static [Role],
    },
    #[error("The checker needs the {authority} authority for a {subject} approval")]
    MissingAuthority {
        subject: ApprovalSubjectType,
        authority: &'static str,
    },
    #[error("The approval request is not pending review (state {state})")]
    ApprovalNotPending { state: ApprovalState },
    #[error("The approval request has expired")]
    ApprovalExpired,
    #[error("A rejection requires a reason")]
    RejectionReasonRequired,
    #[error("The approval base version {base} does not match the subject version {current}")]
    BaseVersionMismatch { base: i64, current: i64 },
    #[error("The current subject version could not be verified")]
    BaseVersionUnavailable,
    #[error("The subject's maker cannot approve their own change")]
    SelfChange,
    #[error("The cash-out is '{state}' and cannot be {decision}")]
    CashoutStateInvalid {
        state: crate::states::CashoutState,
        decision: &'static str,
    },
}

impl GovError {
    /// The short code requested by the port brief.
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::MakerMissing => "MAKER_MISSING",
            Self::CheckerMissing => "CHECKER_MISSING",
            Self::MakerCheckerSameUser => "MAKER_CHECKER_SAME_USER",
            Self::AutomationCannotActAsChecker => "AUTOMATION_CANNOT_ACT_AS_CHECKER",
            Self::CheckerAuthorityRequired { .. } | Self::MissingAuthority { .. } => {
                "CHECKER_AUTHORITY_REQUIRED"
            }
            Self::DomainCheckerRequired { .. } => "CHECKER_AUTHORITY_REQUIRED",
            Self::ApprovalNotPending { .. } => "APPROVAL_NOT_PENDING",
            Self::ApprovalExpired => "APPROVAL_EXPIRED",
            Self::RejectionReasonRequired => "REJECTION_REASON_REQUIRED",
            Self::BaseVersionMismatch { .. } => "BASE_VERSION_MISMATCH",
            Self::BaseVersionUnavailable => "BASE_VERSION_UNAVAILABLE",
            Self::SelfChange => "APPROVAL_SELF_CHANGE",
            Self::CashoutStateInvalid { .. } => "CASHOUT_STATE_INVALID",
        }
    }

    /// The exact `ApiError` code of the TypeScript implementation.
    #[must_use]
    pub const fn ts_code(&self) -> &'static str {
        match self {
            Self::MakerMissing => "APPROVAL_MAKER_MISSING",
            Self::CheckerMissing => "APPROVAL_CHECKER_MISSING",
            Self::MakerCheckerSameUser => "APPROVAL_MAKER_EQUALS_CHECKER",
            Self::AutomationCannotActAsChecker => "AUTOMATION_CANNOT_ACT_AS_CHECKER",
            Self::CheckerAuthorityRequired { .. } => "APPROVAL_CHECKER_AUTHORITY_REQUIRED",
            Self::DomainCheckerRequired { .. } => "DOMAIN_CHECKER_REQUIRED",
            Self::MissingAuthority { .. } => "ROUTE_HEALTH_CHECKER_AUTHORITY_REQUIRED",
            Self::ApprovalNotPending { .. } => "APPROVAL_NOT_PENDING",
            Self::ApprovalExpired => "APPROVAL_EXPIRED",
            Self::RejectionReasonRequired => "APPROVAL_REJECTION_REASON_REQUIRED",
            Self::BaseVersionMismatch { .. } => "BASE_VERSION_MISMATCH",
            Self::BaseVersionUnavailable => "BASE_VERSION_UNAVAILABLE",
            Self::SelfChange => "APPROVAL_SELF_CHANGE",
            Self::CashoutStateInvalid { .. } => "CASHOUT_STATE_INVALID",
        }
    }

    /// HTTP status the TypeScript route answers with.
    #[must_use]
    pub const fn status(&self) -> u16 {
        match self {
            Self::MakerMissing => 400,
            Self::CheckerMissing => 400,
            Self::MakerCheckerSameUser => 409,
            Self::AutomationCannotActAsChecker => 403,
            Self::CheckerAuthorityRequired { .. }
            | Self::DomainCheckerRequired { .. }
            | Self::MissingAuthority { .. } => 403,
            Self::ApprovalNotPending { .. } => 409,
            Self::ApprovalExpired => 409,
            Self::RejectionReasonRequired => 400,
            Self::BaseVersionMismatch { .. } | Self::BaseVersionUnavailable => 409,
            Self::SelfChange => 403,
            Self::CashoutStateInvalid { .. } => 409,
        }
    }

    /// Stable machine detail for the API envelope, as ordered key/value pairs.
    ///
    /// The exact JSON shape is `{"subjectType","checkerRole","allowedRoles"}`, `{"state"}`,
    /// `{"baseVersion","currentVersion"}` and so on; the HTTP layer serialises these pairs into the
    /// `details` object without this crate depending on `serde_json`.
    #[must_use]
    pub fn details(&self) -> Vec<(&'static str, String)> {
        match self {
            Self::DomainCheckerRequired {
                subject,
                checker_role,
                allowed,
            } => vec![
                ("subjectType", subject.as_str().to_owned()),
                ("checkerRole", checker_role.as_str().to_owned()),
                (
                    "allowedRoles",
                    allowed
                        .iter()
                        .map(|role| role.as_str())
                        .collect::<Vec<_>>()
                        .join(","),
                ),
            ],
            Self::MissingAuthority { subject, authority } => vec![
                ("subjectType", subject.as_str().to_owned()),
                ("authority", (*authority).to_owned()),
            ],
            Self::BaseVersionMismatch { base, current } => vec![
                ("baseVersion", base.to_string()),
                ("currentVersion", current.to_string()),
            ],
            Self::ApprovalNotPending { state } => {
                vec![("state", state.as_str().to_owned())]
            }
            Self::CashoutStateInvalid { state, decision } => vec![
                ("state", state.as_str().to_owned()),
                ("decision", (*decision).to_owned()),
            ],
            _ => Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_and_statuses_match_the_ts_route() {
        let same = GovError::MakerCheckerSameUser;
        assert_eq!(same.code(), "MAKER_CHECKER_SAME_USER");
        assert_eq!(same.ts_code(), "APPROVAL_MAKER_EQUALS_CHECKER");
        assert_eq!(same.status(), 409);

        let expired = GovError::ApprovalExpired;
        assert_eq!(expired.code(), "APPROVAL_EXPIRED");
        assert_eq!(expired.ts_code(), "APPROVAL_EXPIRED");
        assert_eq!(expired.status(), 409);

        let not_pending = GovError::ApprovalNotPending {
            state: ApprovalState::Executed,
        };
        assert_eq!(not_pending.code(), "APPROVAL_NOT_PENDING");
        assert_eq!(not_pending.status(), 409);

        let authority = GovError::CheckerAuthorityRequired {
            subject: ApprovalSubjectType::User,
        };
        assert_eq!(authority.code(), "CHECKER_AUTHORITY_REQUIRED");
        assert_eq!(authority.ts_code(), "APPROVAL_CHECKER_AUTHORITY_REQUIRED");
        assert_eq!(authority.status(), 403);
    }

    #[test]
    fn domain_error_carries_the_role_table() {
        let error = GovError::DomainCheckerRequired {
            subject: ApprovalSubjectType::AmlCase,
            checker_role: Role::Finance,
            allowed: &[Role::Mlro],
        };
        assert_eq!(error.code(), "CHECKER_AUTHORITY_REQUIRED");
        assert_eq!(error.ts_code(), "DOMAIN_CHECKER_REQUIRED");
        let details = error.details();
        assert_eq!(details[0], ("subjectType", "AML_CASE".to_owned()));
        assert_eq!(details[1], ("checkerRole", "FINANCE".to_owned()));
        assert_eq!(details[2], ("allowedRoles", "MLRO".to_owned()));
    }
}

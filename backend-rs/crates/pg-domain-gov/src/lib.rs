//! Governance domain logic: approval subjects, maker-checker, and terminal-state helpers.
//!
//! Ports `core-back/lib/approvalQueue.ts`, the maker-checker guard
//! (`api/middleware/makerCheckerGuard.ts`), the approval guards of
//! `engine/governance/{ApprovalService,GovernanceExecution}.ts` and the AML/adjustment/dispute/
//! cash-out state machines of the Prisma schema and `engine/governance/GovernanceExecution.ts`.
//!
//! No database, no clock, no I/O: a server loads the row, builds a [`CheckerContext`] from the
//! authenticated principal, and calls [`decide`]. The caller executes the subject in the same
//! transaction and writes `EXECUTED` after the handler commits.
//!
//! Subject catalogue correction: the brief's `MERCHANT_EDIT`, `PAYOUT_ACCOUNT_CHANGE`,
//! `USER_CREATE`, `USER_STATUS` and `CASH_OUT` are audit actions/domain concepts in the TS tree,
//! not `approval_requests.subject_type` values. [`ApprovalSubjectType`] carries the real list.

#![forbid(unsafe_code)]

pub mod approval;
pub mod error;
pub mod states;
pub mod subject;

pub use approval::{
    decide, decide_with, ensure_base_version, ensure_checker_role, ensure_maker_checker,
    is_system_automation, ApprovalDecision, ApprovalMode, ApprovalOutcome, ApprovalRequest,
    ApprovalState, CheckerContext, APPROVAL_PENDING_STATES, SYSTEM_AUTOMATION,
    SYSTEM_AUTOMATION_EMAIL,
};
pub use error::GovError;
pub use states::{
    cap_chargeback, transition_cashout, AdjustmentState, AdjustmentType, AmlCaseAction,
    AmlCaseStatus, CashoutDecision, CashoutState, CashoutTransition, ChargebackOutcome,
    DisputeStatus,
};
pub use subject::{normalize_approval_subject_type, ApprovalDomain, ApprovalSubjectType, Role};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approved_subject_executes_and_rejected_subject_does_not() {
        let request = ApprovalRequest::new(
            uuid::Uuid::nil(),
            ApprovalSubjectType::GlShardRepair,
            "shard-1",
            "maker",
        );
        let checker = CheckerContext::new("checker", Role::Finance, true);
        let now = "2026-11-28T00:00:00Z".parse().expect("timestamp");
        let approved =
            decide(&request, ApprovalDecision::Approve, &checker, now, None).expect("approve");
        assert!(approved.execute_subject);
        assert!(ApprovalSubjectType::GlShardRepair.is_executable_by_dispatcher());

        let rejected = decide(
            &request,
            ApprovalDecision::Reject,
            &checker,
            now,
            Some("not economically justified"),
        )
        .expect("reject");
        assert!(!rejected.execute_subject);
        assert_eq!(
            rejected.rejection_reason.as_deref(),
            Some("not economically justified")
        );
    }

    #[test]
    fn catalogue_round_trips_through_the_wire_form() {
        for subject in ApprovalSubjectType::ALL {
            assert_eq!(
                ApprovalSubjectType::from_wire(subject.as_str()),
                Some(*subject),
                "{}",
                subject.as_str()
            );
        }
    }
}

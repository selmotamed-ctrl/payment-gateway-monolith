//! Errors of the ledger persistence layer.
//!
//! The TypeScript poster throws `ApiError(400, code, message)` for everything it validates
//! before touching the database (`LedgerPoster.ts:277-295`, `:1054-1076`) and Prisma errors for
//! everything PostgreSQL rejects. This crate keeps the same codes on [`LedgerError::code`] so a
//! future HTTP adapter can answer with the parity envelope, and wraps the database error
//! untouched otherwise.

#![forbid(unsafe_code)]

use pg_domain_ledger::{AccountType, TemplateError};
use uuid::Uuid;

/// Anything a ledger operation can refuse or fail with.
#[derive(Debug, thiserror::Error)]
pub enum LedgerError {
    /// `validateTemplate` refused the template (`LedgerPoster.ts:1054-1076`).
    #[error("invalid journal template: {0}")]
    Template(#[from] TemplateError),

    /// `LEDGER_RAW_SQL=false` asks for the Prisma/ORM posting path, which this port deliberately
    /// does not implement (design chapter 2 §14: the raw path only; the ORM path is a TS fallback,
    /// not a contract). Refused instead of silently running the raw path.
    #[error(
        "LEDGER_RAW_SQL=false requests the ORM posting path, which the Rust port does not implement; \
         unset it (or set LEDGER_RAW_SQL=true) to use the raw-SQL poster"
    )]
    RawSqlDisabled,

    /// Step 3 of the posting pipeline found no account (`GL_ACCOUNT_NOT_FOUND`,
    /// `LedgerPoster.ts:1149,1296`).
    #[error("no {account_type} account matched the posting context")]
    AccountNotFound { account_type: AccountType },

    /// The entry insert conflicted but reading it back returned nothing (`JOURNAL_ENTRY_CONFLICT`,
    /// `LedgerPoster.ts:820`). PostgreSQL cannot produce this (the journal is append-only); it is a
    /// defensive check.
    #[error("the journal entry conflicted but could not be read back")]
    EntryConflict,

    /// Strict-context mode asked for a currency that the template does not carry
    /// (`MISSING_LEDGER_CURRENCY`, `LedgerPoster.ts:1093`).
    #[error("a currency is required to resolve the journal accounts")]
    MissingCurrency,

    /// The shard row does not exist (`GL_SHARD_NOT_FOUND`, `ShardRepair.ts:218,466`).
    #[error("GL account '{gl_account_id}' has no shard {shard_id}")]
    ShardNotFound { gl_account_id: Uuid, shard_id: i32 },

    /// The repair preview/approval is bound to a different plan (`SHARD_REPAIR_PLAN_CHANGED`,
    /// `ShardRepair.ts:481,496`).
    #[error("the shard changed since the repair was previewed; preview it again")]
    RepairPlanChanged,

    /// A damaged sequence needs an approved re-baseline (`SHARD_REPAIR_NEEDS_APPROVAL`,
    /// `ShardRepair.ts:500-507`).
    #[error("the shard's sequence is damaged: re-baselining it needs a second person's approval")]
    RepairNeedsApproval,

    /// The validated lines and the template lines are not aligned: every template line must survive
    /// validation (the Rust template has no optional zero legs; callers omit them like the TS
    /// `optionalLine` helper does).
    #[error("journal template lines do not align with the validated lines")]
    TemplateLineMismatch,

    /// The pure router refused the line/route alignment.
    #[error("journal template routing failed: {0}")]
    ShardRouting(#[from] pg_domain_ledger::ShardRouteError),

    /// `RETURNING line_seq` did not include a shard that was bumped. PostgreSQL always returns every
    /// bumped row, so this is an internal invariant violation.
    #[error("shard sequence for {gl_account_id} shard {shard_id} was not reserved")]
    SequenceNotReserved { gl_account_id: Uuid, shard_id: i32 },

    /// A stored account type is not part of the chart of accounts.
    #[error("'{0}' is not a GL account type")]
    UnknownAccountType(String),

    /// A stored journal direction is neither `DEBIT` nor `CREDIT`.
    #[error("'{0}' is not a journal direction")]
    UnknownDirection(String),

    /// The account-resolution cache keyed a lookup that cannot be scoped.
    #[error("unsupported account predicate field '{field}'")]
    UnsupportedAccountPredicate { field: String },

    /// Any PostgreSQL failure, including the database guards (`22003` amount, `23503` FK,
    /// `55000` append-only).
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
}

impl LedgerError {
    /// The TypeScript error code for this failure, when it has one.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::Template(error) => match error {
                TemplateError::NegativeAmount { .. } | TemplateError::ZeroAmount { .. } => {
                    "INVALID_LEDGER_AMOUNT"
                }
                TemplateError::Unbalanced { .. }
                | TemplateError::NoDebitLine
                | TemplateError::NoCreditLine => "UNBALANCED_JOURNAL_ENTRY",
                _ => "INVALID_JOURNAL_TEMPLATE",
            },
            Self::RawSqlDisabled => "LEDGER_RAW_SQL_REQUIRES_RAW_PATH",
            Self::AccountNotFound { .. } => "GL_ACCOUNT_NOT_FOUND",
            Self::EntryConflict => "JOURNAL_ENTRY_CONFLICT",
            Self::MissingCurrency => "MISSING_LEDGER_CURRENCY",
            Self::ShardNotFound { .. } => "GL_SHARD_NOT_FOUND",
            Self::RepairPlanChanged => "SHARD_REPAIR_PLAN_CHANGED",
            Self::RepairNeedsApproval => "SHARD_REPAIR_NEEDS_APPROVAL",
            Self::TemplateLineMismatch => "INVALID_JOURNAL_TEMPLATE",
            Self::ShardRouting(_) => "INVALID_JOURNAL_TEMPLATE",
            Self::SequenceNotReserved { .. } => "LEDGER_SHARD_SEQUENCE_NOT_RESERVED",
            Self::UnknownAccountType(_) => "UNKNOWN_GL_ACCOUNT_TYPE",
            Self::UnknownDirection(_) => "UNKNOWN_JOURNAL_DIRECTION",
            Self::UnsupportedAccountPredicate { .. } => "UNSUPPORTED_ACCOUNT_PREDICATE",
            Self::Db(_) => "DATABASE_ERROR",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal::Decimal;
    use std::str::FromStr;

    #[test]
    fn template_codes_match_the_typescript_money_errors() {
        let unbalanced = LedgerError::from(TemplateError::Unbalanced {
            debits: Decimal::from_str("100").expect("decimal"),
            credits: Decimal::from_str("90").expect("decimal"),
        });
        assert_eq!(unbalanced.code(), "UNBALANCED_JOURNAL_ENTRY");

        let zero = LedgerError::from(TemplateError::ZeroAmount { index: 0 });
        assert_eq!(zero.code(), "INVALID_LEDGER_AMOUNT");

        let missing = LedgerError::from(TemplateError::MissingReference);
        assert_eq!(missing.code(), "INVALID_JOURNAL_TEMPLATE");
    }

    #[test]
    fn every_variant_has_a_code() {
        let errors = [
            LedgerError::RawSqlDisabled,
            LedgerError::AccountNotFound {
                account_type: AccountType::Treasury,
            },
            LedgerError::EntryConflict,
            LedgerError::MissingCurrency,
            LedgerError::ShardNotFound {
                gl_account_id: Uuid::nil(),
                shard_id: 0,
            },
            LedgerError::RepairPlanChanged,
            LedgerError::RepairNeedsApproval,
            LedgerError::TemplateLineMismatch,
            LedgerError::ShardRouting(pg_domain_ledger::ShardRouteError::RouteCountMismatch {
                expected: 1,
                actual: 2,
            }),
            LedgerError::SequenceNotReserved {
                gl_account_id: Uuid::nil(),
                shard_id: 0,
            },
            LedgerError::UnknownAccountType("NOPE".to_owned()),
            LedgerError::UnknownDirection("SIDEWAYS".to_owned()),
            LedgerError::UnsupportedAccountPredicate {
                field: "x".to_owned(),
            },
        ];
        for error in errors {
            assert!(!error.code().is_empty(), "{error}");
        }
    }
}

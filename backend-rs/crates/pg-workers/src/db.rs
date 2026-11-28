//! Small database helpers shared by the concrete workers.
//!
//! The TypeScript workers use `this.clock()` (process time) as the parameter of every predicate and
//! `now()` inside `UPDATE … updated_at = now()` statements. The Rust port keeps that split: callers
//! bind [`now_utc`] where TS bound `now`, and the SQL keeps `now()` where TS used it.

#![forbid(unsafe_code)]

use chrono::{DateTime, NaiveDateTime, Utc};
use sqlx::{PgPool, Postgres, Transaction};

pub type Tx<'a> = Transaction<'a, Postgres>;

/// The TS `new Date()` equivalent in the database's `timestamp` representation (UTC).
#[must_use]
pub fn now_utc() -> NaiveDateTime {
    Utc::now().naive_utc()
}

/// `DateTime<Utc>` for `timestamptz` columns.
#[must_use]
pub fn now_tz() -> DateTime<Utc> {
    Utc::now()
}

pub async fn begin(pool: &PgPool) -> Result<Tx<'_>, sqlx::Error> {
    pool.begin().await
}

/// Bypasses the append-only row guards (superuser or maintenance role only).
///
/// Tests use it to remove the rows they created in `audit_log`, `operator_case_events`,
/// `journal_lines` and `gl_shard_repairs`. It must never be used on a production connection:
/// `SET LOCAL` inside the transaction keeps it from leaking to the pool.
pub const APPEND_ONLY_CLEANUP_SQL: &str =
    "SELECT set_config('pgw.ledger_maintenance', 'on', true), \
     set_config('pgw.append_only_maintenance', 'on', true), \
     set_config('pgw.audit_retention', 'on', true)";

/// Classify a sqlx error as a unique violation (`23505`, the replacement for Prisma `P2002`).
#[must_use]
pub fn is_unique_violation(error: &sqlx::Error) -> bool {
    matches!(
        error,
        sqlx::Error::Database(database) if database.code().as_deref() == Some("23505")
    )
}

/// The SQLSTATE of a sqlx database error, when present.
#[must_use]
pub fn sqlstate(error: &sqlx::Error) -> Option<String> {
    match error {
        sqlx::Error::Database(database) => database.code().map(|code| code.into_owned()),
        _ => None,
    }
}

/// Transient database failures the inbound inbox retries (design chapter 2 §18, same list as
/// `callbackInboundHandler.ts`): connection class 08, insufficient resources 53, operator
/// intervention 57, serialization failure 40001, deadlock 40P01 and lock-not-available 55P03.
#[must_use]
pub fn is_transient_sqlstate(code: &str) -> bool {
    code.starts_with("08")
        || code.starts_with("53")
        || code.starts_with("57")
        || code == "40001"
        || code == "40P01"
        || code == "55P03"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transient_classes_match_the_callback_handler_list() {
        for code in ["08006", "53300", "57014", "40001", "40P01", "55P03"] {
            assert!(is_transient_sqlstate(code), "{code} must be transient");
        }
        for code in ["23505", "23503", "55000", "42P01", "22007"] {
            assert!(!is_transient_sqlstate(code), "{code} must not be transient");
        }
    }

    #[test]
    fn now_is_utc() {
        let before = Utc::now().naive_utc();
        let naive = now_utc();
        let after = Utc::now().naive_utc();
        assert!(naive >= before && naive <= after);
    }

    #[test]
    fn unique_violation_detection_does_not_panic_outside_database_errors() {
        let error = sqlx::Error::RowNotFound;
        assert!(!is_unique_violation(&error));
        assert!(sqlstate(&error).is_none());
    }
}

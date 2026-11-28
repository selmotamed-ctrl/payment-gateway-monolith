//! Database error type and SQLSTATE classification helpers.
//!
//! Port of the Prisma error surface the handlers rely on (`Prisma.PrismaClientKnownRequestError`
//! codes P2002/P2003/P2034) plus the SQLSTATE classes that replace them (chapter 2 §18).
//!
//! The HTTP status/code a *route* answers with is route-specific in TS, so this crate exposes the
//! classification only; the adapter chooses the envelope (for example a duplicate statement upload
//! is a 409 on one route and a 400 on another).

#![forbid(unsafe_code)]

use thiserror::Error;

use crate::sqlstate;
use crate::url::UrlError;

#[derive(Debug, Error)]
pub enum DbError {
    #[error("database error: {0}")]
    Sqlx(#[from] sqlx::Error),
    #[error("database URL is invalid: {0}")]
    Url(#[from] UrlError),
    /// A filter value could not be converted (for example a non-numeric `amountMin`).
    #[error("invalid filter value for '{field}'")]
    InvalidFilter { field: String },
    /// A cursor token did not decode into the expected shape (the TS builder then falls back to
    /// OFFSET pagination instead of failing the request).
    #[error("invalid list cursor")]
    InvalidCursor,
    /// `PG_TX_MAX_WAIT_MS` elapsed while waiting for a pooled connection (P2028 equivalent).
    #[error("timed out waiting for a database connection")]
    PoolWaitTimeout,
    /// A configured database section is required but absent.
    #[error("missing database URL: {key}")]
    MissingUrl { key: &'static str },
}

impl DbError {
    /// The PostgreSQL SQLSTATE when the server answered.
    #[must_use]
    pub fn sqlstate(&self) -> Option<String> {
        match self {
            Self::Sqlx(sqlx::Error::Database(database)) => Some(database.code()?.into_owned()),
            _ => None,
        }
    }

    /// The constraint name for a unique/foreign-key violation, when the server reported one.
    #[must_use]
    pub fn constraint(&self) -> Option<String> {
        match self {
            Self::Sqlx(sqlx::Error::Database(database)) => database.constraint().map(str::to_owned),
            _ => None,
        }
    }

    /// The Prisma code the TS handlers test for (`P2002`, `P2003`, `P2034`).
    #[must_use]
    pub fn prisma_code(&self) -> Option<&'static str> {
        self.sqlstate().as_deref().and_then(sqlstate::prisma_code)
    }

    /// True when the TS retry predicates would retry the operation: `08xxx`, `53xxx`, `57xxx`,
    /// `40001`, `40P01`, `55P03`, plus a pool wait timeout (Prisma `P2028`).
    #[must_use]
    pub fn is_transient(&self) -> bool {
        match self {
            Self::PoolWaitTimeout => true,
            Self::Sqlx(sqlx::Error::PoolTimedOut | sqlx::Error::Io(_)) => true,
            Self::Sqlx(sqlx::Error::Database(database)) => database
                .code()
                .is_some_and(|code| sqlstate::is_transient(&code)),
            _ => false,
        }
    }

    #[must_use]
    pub fn is_unique_violation(&self) -> bool {
        self.sqlstate()
            .as_deref()
            .is_some_and(sqlstate::is_unique_violation)
    }

    #[must_use]
    pub fn is_foreign_key_violation(&self) -> bool {
        self.sqlstate()
            .as_deref()
            .is_some_and(sqlstate::is_foreign_key_violation)
    }
}

/// Human-readable detail of a database error without the SQL text (safe for logs).
#[must_use]
pub fn error_detail(error: &sqlx::Error) -> String {
    match error {
        sqlx::Error::Database(database) => format!(
            "{} (SQLSTATE {})",
            database.message(),
            database.code().unwrap_or_default()
        ),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use std::borrow::Cow;

    use sqlx::error::{DatabaseError, ErrorKind};

    use super::*;

    /// A minimal `DatabaseError` so SQLSTATE classification is testable without a server.
    #[derive(Debug)]
    struct FakeDatabaseError {
        code: &'static str,
    }

    impl std::fmt::Display for FakeDatabaseError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("fake database error")
        }
    }

    impl std::error::Error for FakeDatabaseError {}

    impl DatabaseError for FakeDatabaseError {
        fn message(&self) -> &str {
            "fake database error"
        }
        fn code(&self) -> Option<Cow<'_, str>> {
            Some(Cow::Borrowed(self.code))
        }
        fn as_error(&self) -> &(dyn std::error::Error + Send + Sync + 'static) {
            self
        }
        fn as_error_mut(&mut self) -> &mut (dyn std::error::Error + Send + Sync + 'static) {
            self
        }
        fn into_error(self: Box<Self>) -> Box<dyn std::error::Error + Send + Sync + 'static> {
            self
        }
        fn kind(&self) -> ErrorKind {
            match self.code {
                "23505" => ErrorKind::UniqueViolation,
                "23503" => ErrorKind::ForeignKeyViolation,
                _ => ErrorKind::Other,
            }
        }
    }

    fn database_error(code: &'static str) -> sqlx::Error {
        sqlx::Error::Database(Box::new(FakeDatabaseError { code }))
    }

    #[test]
    fn unique_violation_maps_to_p2002() {
        let error = DbError::Sqlx(database_error("23505"));
        assert_eq!(error.prisma_code(), Some("P2002"));
        assert!(error.is_unique_violation());
        assert!(!error.is_transient());
    }

    #[test]
    fn serialization_failure_is_transient() {
        let error = DbError::Sqlx(database_error("40P01"));
        assert_eq!(error.prisma_code(), Some("P2034"));
        assert!(error.is_transient());
    }

    #[test]
    fn pool_wait_timeout_is_transient() {
        assert!(DbError::PoolWaitTimeout.is_transient());
        assert_eq!(DbError::PoolWaitTimeout.sqlstate(), None);
    }
}

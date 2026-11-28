//! SQLSTATE classification (chapter 2 §18).
//!
//! Replaces Prisma error codes with explicit SQLSTATE checks. The TS retry predicate is
//! `08xxx`, `53xxx`, `57xxx`, `40001`, `40P01`, `55P03`.

#![forbid(unsafe_code)]

#[must_use]
pub fn is_transient(sqlstate: &str) -> bool {
    matches!(sqlstate, "40001" | "40P01" | "55P03")
        || sqlstate.starts_with("08")
        || sqlstate.starts_with("53")
        || sqlstate.starts_with("57")
}

#[must_use]
pub fn is_unique_violation(sqlstate: &str) -> bool {
    sqlstate == "23505"
}

#[must_use]
pub fn is_foreign_key_violation(sqlstate: &str) -> bool {
    sqlstate == "23503"
}

#[must_use]
pub fn is_check_violation(sqlstate: &str) -> bool {
    sqlstate == "23514"
}

#[must_use]
pub fn is_deadlock(sqlstate: &str) -> bool {
    sqlstate == "40P01"
}

#[must_use]
pub fn is_serialization_failure(sqlstate: &str) -> bool {
    sqlstate == "40001"
}

/// Prisma-compatible code used in `details` and tests.
#[must_use]
pub fn prisma_code(sqlstate: &str) -> Option<&'static str> {
    match sqlstate {
        "23505" => Some("P2002"),
        "23503" => Some("P2003"),
        "40001" | "40P01" => Some("P2034"),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClassifiedError {
    pub sqlstate: String,
    pub transient: bool,
    pub prisma_code: Option<&'static str>,
}

#[must_use]
pub fn classified_error(sqlstate: &str) -> ClassifiedError {
    ClassifiedError {
        sqlstate: sqlstate.to_owned(),
        transient: is_transient(sqlstate),
        prisma_code: prisma_code(sqlstate),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transient_classes() {
        for state in ["08006", "53300", "57P01", "40001", "40P01", "55P03"] {
            assert!(is_transient(state), "{state}");
        }
        assert!(!is_transient("23505"));
    }

    #[test]
    fn prisma_mapping() {
        assert_eq!(prisma_code("23505"), Some("P2002"));
        assert!(classified_error("40P01").transient);
    }
}

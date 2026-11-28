//! Merchant / attempt / transaction scoping helpers.
//!
//! The merchant portal reaches the same providers as the back office, so every merchant-facing
//! search must be narrowed to that merchant. This module turns a parsed query's
//! `merchant:` / attempt / transaction context into an explicit [`SearchScope`] that filters
//! providers and hits before ranking.
//!
//! Provider groups mirror the models that can carry the scope column:
//! - merchant: merchants and every merchant-owned record (attempts, disputes, adjustments,
//!   cash-outs, KYB/join requests, reconciliation runs);
//! - attempt: the attempt itself, its inquiries, disputes and adjustments;
//! - transaction: an attempt by reference, gateway inquiries and reconciliation runs.

#![forbid(unsafe_code)]

use crate::query::ParsedSearchQuery;
use crate::rank::SearchCandidate;
use crate::types::{MetaValue, SearchHit, SearchType};

/// Providers a merchant scope can search (records owned by a merchant).
#[must_use]
pub fn merchant_scoped_types() -> &'static [SearchType] {
    &[
        SearchType::Merchant,
        SearchType::PaymentAttempt,
        SearchType::Dispute,
        SearchType::Adjustment,
        SearchType::Cashout,
        SearchType::KybDocument,
        SearchType::JoinRequest,
        SearchType::ReconciliationRun,
    ]
}

/// Providers an attempt scope can search.
#[must_use]
pub fn attempt_scoped_types() -> &'static [SearchType] {
    &[
        SearchType::PaymentAttempt,
        SearchType::GatewayInquiry,
        SearchType::Dispute,
        SearchType::Adjustment,
    ]
}

/// Providers a transaction-reference scope can search.
#[must_use]
pub fn transaction_scoped_types() -> &'static [SearchType] {
    &[
        SearchType::PaymentAttempt,
        SearchType::GatewayInquiry,
        SearchType::ReconciliationRun,
    ]
}

/// An explicit search scope.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SearchScope {
    /// `merchant:<id>` (or the merchant session's own id).
    pub merchant_id: Option<String>,
    /// A specific attempt id.
    pub attempt_id: Option<String>,
    /// A provider or internal transaction reference.
    pub transaction_reference: Option<String>,
}

impl SearchScope {
    /// An empty scope (the back-office search).
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// A merchant scope.
    #[must_use]
    pub fn for_merchant(merchant_id: impl Into<String>) -> Self {
        Self {
            merchant_id: Some(merchant_id.into()),
            ..Self::default()
        }
    }

    /// A scope for one attempt.
    #[must_use]
    pub fn for_attempt(attempt_id: impl Into<String>) -> Self {
        Self {
            attempt_id: Some(attempt_id.into()),
            ..Self::default()
        }
    }

    /// A scope for one transaction reference.
    #[must_use]
    pub fn for_transaction(reference: impl Into<String>) -> Self {
        Self {
            transaction_reference: Some(reference.into()),
            ..Self::default()
        }
    }

    /// Takes the `merchant:` token from a parsed query. An attempt or transaction scope passed by
    /// the caller is preserved.
    #[must_use]
    pub fn from_query(parsed: &ParsedSearchQuery) -> Self {
        Self {
            merchant_id: parsed.scoped_merchant_id.clone(),
            ..Self::default()
        }
    }

    /// True when no scope is set.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.merchant_id.is_none()
            && self.attempt_id.is_none()
            && self.transaction_reference.is_none()
    }

    /// Whether the scope can return records from `provider`.
    #[must_use]
    pub fn allows(&self, provider: SearchType) -> bool {
        if self.is_empty() {
            return true;
        }
        let merchant_ok = self
            .merchant_id
            .as_ref()
            .is_none_or(|_| merchant_scoped_types().contains(&provider));
        let attempt_ok = self
            .attempt_id
            .as_ref()
            .is_none_or(|_| attempt_scoped_types().contains(&provider));
        let transaction_ok = self
            .transaction_reference
            .as_ref()
            .is_none_or(|_| transaction_scoped_types().contains(&provider));
        merchant_ok && attempt_ok && transaction_ok
    }

    fn meta_text<'a>(hit: &'a SearchHit, key: &str) -> Option<&'a str> {
        match hit.meta.get(key) {
            Some(MetaValue::Text(text)) => Some(text.as_str()),
            _ => None,
        }
    }

    /// Whether a hit belongs to the scope.
    #[must_use]
    pub fn matches(&self, hit: &SearchHit) -> bool {
        if self.is_empty() {
            return true;
        }
        if let Some(merchant_id) = self.merchant_id.as_deref() {
            // The provider already filtered by the merchant column server-side, so a hit that does
            // not select the column is trusted; a hit that carries a different merchant is not.
            if let Some(hit_merchant) = hit.merchant_id.as_deref() {
                if hit_merchant != merchant_id {
                    return false;
                }
            }
            if let Some(meta_merchant) = Self::meta_text(hit, "merchantId") {
                if meta_merchant != merchant_id {
                    return false;
                }
            }
        }
        if let Some(attempt_id) = self.attempt_id.as_deref() {
            let matches =
                hit.id == attempt_id || Self::meta_text(hit, "attemptId") == Some(attempt_id);
            if !matches {
                return false;
            }
        }
        if let Some(reference) = self.transaction_reference.as_deref() {
            let matches = hit.id == reference
                || hit.reference.as_deref() == Some(reference)
                || Self::meta_text(hit, "reference") == Some(reference);
            if !matches {
                return false;
            }
        }
        true
    }

    /// Fills in the owning merchant when a scoped hit omitted it (the provider already filtered by
    /// the same column server-side).
    pub fn apply(&self, hit: &mut SearchHit) {
        if let Some(merchant_id) = self.merchant_id.as_deref() {
            if hit.merchant_id.is_none() && hit.id != merchant_id {
                hit.merchant_id = Some(merchant_id.to_owned());
            }
        }
    }

    /// Keeps only the candidates the scope allows and owns, then applies the merchant id.
    #[must_use]
    pub fn filter(&self, candidates: Vec<SearchCandidate>) -> Vec<SearchCandidate> {
        if self.is_empty() {
            return candidates;
        }
        let mut scoped = Vec::with_capacity(candidates.len());
        for mut candidate in candidates {
            if !self.allows(candidate.provider) || !self.matches(&candidate.hit) {
                continue;
            }
            self.apply(&mut candidate.hit);
            scoped.push(candidate);
        }
        scoped
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::query::parse_query;
    use crate::rank::MatchSignals;

    fn candidate(provider: SearchType, hit: SearchHit) -> SearchCandidate {
        SearchCandidate::new(provider, hit, MatchSignals::new())
    }

    #[test]
    fn an_empty_scope_allows_everything() {
        let scope = SearchScope::new();
        assert!(scope.is_empty());
        assert!(scope.allows(SearchType::AuditLog));
        assert!(scope.matches(&SearchHit::new("x", "x")));
        assert_eq!(SearchScope::default(), scope);
    }

    #[test]
    fn the_query_merchant_token_becomes_the_scope() {
        let parsed = parse_query("merchant:m-1 ACME").expect("parses");
        let scope = SearchScope::from_query(&parsed);
        assert_eq!(scope.merchant_id.as_deref(), Some("m-1"));
        assert!(!scope.is_empty());
    }

    #[test]
    fn merchant_scope_limits_providers_and_owned_hits() {
        let scope = SearchScope::for_merchant("m-1");
        assert!(scope.allows(SearchType::PaymentAttempt));
        assert!(scope.allows(SearchType::Dispute));
        assert!(!scope.allows(SearchType::AuditLog));
        assert!(!scope.allows(SearchType::User));
        assert!(!scope.allows(SearchType::Gateway));

        let owned = SearchHit::new("a-1", "Attempt").with_merchant("m-1");
        let foreign = SearchHit::new("a-2", "Attempt").with_merchant("m-2");
        let merchant_itself = SearchHit::new("m-1", "ACME");
        assert!(scope.matches(&owned));
        assert!(scope.matches(&merchant_itself));
        assert!(!scope.matches(&foreign));

        let mut filled = SearchHit::new("a-3", "Attempt");
        scope.apply(&mut filled);
        assert_eq!(filled.merchant_id.as_deref(), Some("m-1"));
    }

    #[test]
    fn attempt_and_transaction_scopes_match_their_references() {
        let attempt = SearchScope::for_attempt("att-1");
        assert!(attempt.allows(SearchType::GatewayInquiry));
        assert!(!attempt.allows(SearchType::Merchant));
        assert!(attempt.matches(&SearchHit::new("att-1", "Attempt")));
        let by_meta = SearchHit::new("case-1", "Case")
            .with_meta("attemptId", MetaValue::Text("att-1".to_owned()));
        assert!(attempt.matches(&by_meta));
        assert!(!attempt.matches(&SearchHit::new("att-2", "Other")));

        let transaction = SearchScope::for_transaction("ATT-2026-0001");
        assert!(transaction.allows(SearchType::ReconciliationRun));
        assert!(!transaction.allows(SearchType::Cashout));
        assert!(transaction.matches(&SearchHit::new("x", "x").with_reference("ATT-2026-0001")));
        assert!(!transaction.matches(&SearchHit::new("x", "x").with_reference("ATT-2026-0002")));
    }

    #[test]
    fn filtering_drops_out_of_scope_candidates_and_fills_the_merchant() {
        let scope = SearchScope::for_merchant("m-1");
        let candidates = vec![
            candidate(
                SearchType::PaymentAttempt,
                SearchHit::new("a-1", "Owned").with_merchant("m-1"),
            ),
            candidate(
                SearchType::PaymentAttempt,
                SearchHit::new("a-2", "Foreign").with_merchant("m-2"),
            ),
            candidate(
                SearchType::AuditLog,
                SearchHit::new("log-1", "Audit").with_merchant("m-1"),
            ),
            candidate(SearchType::Dispute, SearchHit::new("d-1", "Dispute")),
        ];
        let scoped = scope.filter(candidates);
        let ids: Vec<&str> = scoped
            .iter()
            .map(|candidate| candidate.hit.id.as_str())
            .collect();
        assert_eq!(ids, vec!["a-1", "d-1"]);
        assert_eq!(scoped[1].hit.merchant_id.as_deref(), Some("m-1"));
        assert_eq!(
            merchant_scoped_types().len()
                + attempt_scoped_types().len()
                + transaction_scoped_types().len(),
            15
        );
    }
}

//! Relevance ranking and result sanitisation.
//!
//! Port of `computeMatchScore`, `rankAndSliceCandidates` and `sanitizeResultItem` in
//! `core-back/lib/search/engine.ts`.
//!
//! Scores are integers, never floats: exact id/reference hits (1000) beat primary text (900),
//! which beats secondary text (250), and a candidate that matches nothing still scores 100 so it
//! is ranked below every real match instead of disappearing. Ties break on recency, then id.

#![forbid(unsafe_code)]

use std::collections::BTreeSet;

use crate::query::ParsedSearchQuery;
use crate::types::{MetaValue, RankedHit, SearchHit, SearchResponse, SearchType};

/// Exact id/reference match.
pub const EXACT_WEIGHT: u32 = 1_000;
/// Id/reference prefix match.
pub const EXACT_PREFIX_WEIGHT: u32 = 750;
/// Id/reference substring match.
pub const EXACT_SUBSTRING_WEIGHT: u32 = 450;
/// Exact primary-text match.
pub const PRIMARY_EXACT_WEIGHT: u32 = 900;
/// Primary-text prefix match.
pub const PRIMARY_PREFIX_WEIGHT: u32 = 650;
/// Primary-text substring match.
pub const PRIMARY_SUBSTRING_WEIGHT: u32 = 350;
/// Exact secondary-text match.
pub const SECONDARY_EXACT_WEIGHT: u32 = 250;
/// Secondary-text prefix match.
pub const SECONDARY_PREFIX_WEIGHT: u32 = 200;
/// Secondary-text substring match.
pub const SECONDARY_SUBSTRING_WEIGHT: u32 = 150;
/// The score of a candidate that matched nothing.
pub const NO_MATCH_SCORE: u32 = 100;

/// `SearchMatchSignals`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MatchSignals {
    /// IDs, references and other identifiers.
    pub exact_fields: Vec<String>,
    /// Titles and names.
    pub primary_text_fields: Vec<String>,
    /// Statuses, descriptions and other context.
    pub secondary_text_fields: Vec<String>,
    /// The record timestamp, for the recency tie-break (`Date#getTime()`).
    pub timestamp_ms: Option<i64>,
}

impl MatchSignals {
    /// Empty signals.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds an exact-match field.
    #[must_use]
    pub fn exact(mut self, value: impl Into<String>) -> Self {
        self.exact_fields.push(value.into());
        self
    }

    /// Adds a primary text field.
    #[must_use]
    pub fn primary(mut self, value: impl Into<String>) -> Self {
        self.primary_text_fields.push(value.into());
        self
    }

    /// Adds a secondary text field.
    #[must_use]
    pub fn secondary(mut self, value: impl Into<String>) -> Self {
        self.secondary_text_fields.push(value.into());
        self
    }

    /// Sets the timestamp.
    #[must_use]
    pub fn at(mut self, timestamp_ms: i64) -> Self {
        self.timestamp_ms = Some(timestamp_ms);
        self
    }
}

/// One provider result candidate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchCandidate {
    pub provider: SearchType,
    pub hit: SearchHit,
    pub signals: MatchSignals,
}

impl SearchCandidate {
    /// A candidate for a provider.
    #[must_use]
    pub fn new(provider: SearchType, hit: SearchHit, signals: MatchSignals) -> Self {
        Self {
            provider,
            hit,
            signals,
        }
    }
}

fn score_field(
    raw: &str,
    query: &str,
    phone_set: &BTreeSet<String>,
    weights: (u32, u32, u32),
) -> u32 {
    let value = raw.trim().to_lowercase();
    if value.is_empty() {
        return 0;
    }
    let compact: String = value
        .chars()
        .filter(|character| !matches!(character, ' ' | '(' | ')' | '-'))
        .collect();
    if value == query
        || (!phone_set.is_empty() && (phone_set.contains(&value) || phone_set.contains(&compact)))
    {
        return weights.0;
    }
    if value.starts_with(query) {
        return weights.1;
    }
    if value.contains(query) {
        return weights.2;
    }
    0
}

/// `computeMatchScore`: the best score across the candidate's fields.
#[must_use]
pub fn compute_match_score(parsed: &ParsedSearchQuery, signals: &MatchSignals) -> u32 {
    let query = parsed.term_lower.as_str();
    let phone_set: BTreeSet<String> = parsed
        .phone_variants
        .iter()
        .map(|variant| variant.to_lowercase())
        .collect();
    let mut best = 0;
    for field in &signals.exact_fields {
        best = best.max(score_field(
            field,
            query,
            &phone_set,
            (EXACT_WEIGHT, EXACT_PREFIX_WEIGHT, EXACT_SUBSTRING_WEIGHT),
        ));
    }
    for field in &signals.primary_text_fields {
        best = best.max(score_field(
            field,
            query,
            &phone_set,
            (
                PRIMARY_EXACT_WEIGHT,
                PRIMARY_PREFIX_WEIGHT,
                PRIMARY_SUBSTRING_WEIGHT,
            ),
        ));
    }
    for field in &signals.secondary_text_fields {
        best = best.max(score_field(
            field,
            query,
            &phone_set,
            (
                SECONDARY_EXACT_WEIGHT,
                SECONDARY_PREFIX_WEIGHT,
                SECONDARY_SUBSTRING_WEIGHT,
            ),
        ));
    }
    if best > 0 {
        best
    } else {
        NO_MATCH_SCORE
    }
}

/// Meta keys that must never reach a client (secrets, ciphertext, bank data, audit snapshots).
const FORBIDDEN_RESULT_KEYS: &[&str] = &[
    "ciphertext",
    "nationalidciphertext",
    "secret",
    "secretciphertext",
    "password",
    "passwordhash",
    "payoutaccount",
    "payoutaccounthash",
    "payoutbankdetailsjson",
    "destinationbankjson",
    "ibanciphertext",
    "matchlistname",
    "listname",
    "listentryref",
    "matchedname",
    "beforejson",
    "afterjson",
    "rawpayload",
    "payloadciphertext",
    "contentciphertext",
    "contextciphertext",
    "mfasecretciphertext",
    "invitationtokenhash",
    "tokenhash",
    "taxid",
    "taxnumber",
    "registrationno",
    "commercialregistrynumber",
];

/// Key fragments that mark a forbidden meta key.
const FORBIDDEN_KEY_FRAGMENTS: &[&str] = &[
    "cipher",
    "secret",
    "password",
    "payout",
    "bank",
    "matchlist",
    "beforejson",
    "afterjson",
    "rawpayload",
    "taxid",
    "taxnumber",
    "registrationno",
    "commercialregistry",
];

/// `isForbiddenKey`.
#[must_use]
pub fn is_forbidden_key(key: &str) -> bool {
    let normalized = key.to_lowercase();
    FORBIDDEN_RESULT_KEYS.contains(&normalized.as_str())
        || FORBIDDEN_KEY_FRAGMENTS
            .iter()
            .any(|fragment| normalized.contains(fragment))
}

/// `sanitizeResultItem`: drops empty optional fields and every forbidden meta key.
#[must_use]
pub fn sanitize_hit(hit: &SearchHit) -> SearchHit {
    let mut clean = SearchHit {
        id: hit.id.clone(),
        title: if hit.title.trim().is_empty() {
            hit.id.clone()
        } else {
            hit.title.clone()
        },
        ..SearchHit::default()
    };
    if let Some(subtitle) = hit
        .subtitle
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        clean.subtitle = Some(subtitle.to_owned());
    }
    if let Some(reference) = hit
        .reference
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        clean.reference = Some(reference.to_owned());
    }
    if let Some(status) = hit.status.as_deref().filter(|value| !value.is_empty()) {
        clean.status = Some(status.to_owned());
    }
    if let Some(merchant_id) = hit.merchant_id.as_deref().filter(|value| !value.is_empty()) {
        clean.merchant_id = Some(merchant_id.to_owned());
    }
    if let Some(case_id) = hit
        .operator_case_id
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        clean.operator_case_id = Some(case_id.to_owned());
    }
    for (key, value) in &hit.meta {
        if is_forbidden_key(key) {
            continue;
        }
        let keep = match value {
            MetaValue::Text(text) => !text.is_empty(),
            MetaValue::Integer(_) | MetaValue::Bool(_) | MetaValue::Null => true,
        };
        if keep {
            clean.meta.insert(key.clone(), value.clone());
        }
    }
    clean
}

/// `rankAndSliceCandidates`: dedupe by `(provider, id)`, score, sort, slice.
#[must_use]
pub fn rank_and_slice(
    parsed: &ParsedSearchQuery,
    candidates: &[SearchCandidate],
    limit: usize,
) -> (Vec<RankedHit>, bool) {
    let mut seen: BTreeSet<(SearchType, String)> = BTreeSet::new();
    let mut scored: Vec<RankedHit> = Vec::new();
    for candidate in candidates {
        if candidate.hit.id.is_empty()
            || !seen.insert((candidate.provider, candidate.hit.id.clone()))
        {
            continue;
        }
        scored.push(RankedHit {
            provider: candidate.provider,
            hit: sanitize_hit(&candidate.hit),
            score: compute_match_score(parsed, &candidate.signals),
            timestamp_ms: candidate.signals.timestamp_ms.unwrap_or(0),
        });
    }
    scored.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| right.timestamp_ms.cmp(&left.timestamp_ms))
            .then_with(|| left.hit.id.cmp(&right.hit.id))
    });
    let truncated = scored.len() > limit;
    scored.truncate(limit);
    (scored, truncated)
}

/// Full ranking (`rankAndSliceCandidates` with the default limit of the parsed query).
#[must_use]
pub fn rank(parsed: &ParsedSearchQuery, candidates: &[SearchCandidate]) -> Vec<RankedHit> {
    rank_and_slice(parsed, candidates, parsed.limit as usize).0
}

/// Builds the response: `partial` is true when any provider failed (`allSettled` rejected).
#[must_use]
pub fn search_response(
    parsed: &ParsedSearchQuery,
    candidates: &[SearchCandidate],
    partial: bool,
) -> SearchResponse {
    let (items, _truncated) = rank_and_slice(parsed, candidates, parsed.limit as usize);
    SearchResponse::new(parsed.raw.clone(), items, partial)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::query::{parse_query, ParsedSearchQuery};

    fn parsed(query: &str) -> ParsedSearchQuery {
        parse_query(query).expect("query fixture")
    }

    fn candidate(
        provider: SearchType,
        id: &str,
        title: &str,
        signals: MatchSignals,
    ) -> SearchCandidate {
        SearchCandidate::new(provider, SearchHit::new(id, title), signals)
    }

    #[test]
    fn weights_follow_the_ts_ordering() {
        let query = parsed("acme");
        let exact = compute_match_score(&query, &MatchSignals::new().exact("ACME"));
        let prefix = compute_match_score(&query, &MatchSignals::new().exact("ACME-2026"));
        let substring = compute_match_score(&query, &MatchSignals::new().exact("X-ACME-X"));
        let primary = compute_match_score(&query, &MatchSignals::new().primary("ACME"));
        let secondary = compute_match_score(&query, &MatchSignals::new().secondary("ACME"));
        let none = compute_match_score(&query, &MatchSignals::new().secondary("other"));
        assert_eq!(exact, 1_000);
        assert_eq!(prefix, 750);
        assert_eq!(substring, 450);
        assert_eq!(primary, 900);
        assert_eq!(secondary, 250);
        assert_eq!(none, 100);
        assert!(exact > primary && primary > prefix && prefix > substring && substring > secondary);
        assert_eq!(NO_MATCH_SCORE, 100);
    }

    #[test]
    fn phone_variants_match_the_same_subscriber() {
        let query = parsed("+218 91 234 5678");
        let score = compute_match_score(&query, &MatchSignals::new().exact("0912345678"));
        assert_eq!(score, 1_000);
        let compact = compute_match_score(&query, &MatchSignals::new().exact("+218912345678"));
        assert_eq!(compact, 1_000);
    }

    #[test]
    fn ranking_is_score_then_recency_then_id() {
        let query = parsed("acme");
        let candidates = vec![
            candidate(
                SearchType::Merchant,
                "b",
                "ACME",
                MatchSignals::new().primary("ACME").at(10),
            ),
            candidate(
                SearchType::PaymentAttempt,
                "c",
                "X-ACME",
                MatchSignals::new().primary("X-ACME").at(99),
            ),
            candidate(
                SearchType::Dispute,
                "a",
                "ACME",
                MatchSignals::new().primary("ACME").at(10),
            ),
            candidate(
                SearchType::Cashout,
                "d",
                "ACME",
                MatchSignals::new().exact("ACME").at(1),
            ),
        ];
        let ranked = rank(&query, &candidates);
        let ids: Vec<&str> = ranked.iter().map(|hit| hit.hit.id.as_str()).collect();
        assert_eq!(ids, vec!["d", "a", "b", "c"]);
        assert_eq!(ranked[0].provider, SearchType::Cashout);
    }

    #[test]
    fn duplicates_within_a_provider_are_dropped() {
        let query = parsed("acme");
        let candidates = vec![
            candidate(
                SearchType::Merchant,
                "m-1",
                "ACME",
                MatchSignals::new().primary("ACME"),
            ),
            candidate(
                SearchType::Merchant,
                "m-1",
                "ACME again",
                MatchSignals::new().primary("ACME"),
            ),
            candidate(
                SearchType::User,
                "m-1",
                "ACME user",
                MatchSignals::new().primary("ACME"),
            ),
        ];
        let (ranked, truncated) = rank_and_slice(&query, &candidates, 10);
        assert_eq!(ranked.len(), 2);
        assert!(!truncated);
        assert!(ranked.iter().any(|hit| hit.provider == SearchType::User));
    }

    #[test]
    fn the_limit_truncates_and_reports_it() {
        let query = parsed("acme");
        let candidates: Vec<SearchCandidate> = (0..5)
            .map(|index| {
                candidate(
                    SearchType::Merchant,
                    &format!("m-{index}"),
                    "ACME",
                    MatchSignals::new().primary("ACME").at(i64::from(index)),
                )
            })
            .collect();
        let (ranked, truncated) = rank_and_slice(&query, &candidates, 2);
        assert_eq!(ranked.len(), 2);
        assert!(truncated);
        assert_eq!(ranked[0].hit.id, "m-4");
        assert_eq!(rank_and_slice(&query, &candidates, 0).0.len(), 0);
        assert!(rank_and_slice(&query, &candidates, 0).1);
    }

    #[test]
    fn sanitisation_drops_secrets_ciphertext_and_audit_snapshots() {
        let mut hit = SearchHit::new("m-1", "  ")
            .with_subtitle("  ")
            .with_reference("")
            .with_meta("amount", MetaValue::Text("10.5000".to_owned()))
            .with_meta("count", MetaValue::Integer(2))
            .with_meta(
                "secretCiphertext",
                MetaValue::Text("vault:v1:xx".to_owned()),
            )
            .with_meta("taxId", MetaValue::Text("123".to_owned()))
            .with_meta("payoutBankDetailsJson", MetaValue::Text("{}".to_owned()))
            .with_meta("beforeJson", MetaValue::Text("{}".to_owned()))
            .with_meta("emptyNote", MetaValue::Text(String::new()));
        hit.operator_case_id = Some("case-1".to_owned());
        let clean = sanitize_hit(&hit);
        assert_eq!(clean.title, "m-1");
        assert_eq!(clean.subtitle, None);
        assert_eq!(clean.reference, None);
        assert_eq!(clean.operator_case_id.as_deref(), Some("case-1"));
        assert!(clean.meta.contains_key("amount"));
        assert!(clean.meta.contains_key("count"));
        assert!(!clean.meta.contains_key("secretCiphertext"));
        assert!(!clean.meta.contains_key("taxId"));
        assert!(!clean.meta.contains_key("payoutBankDetailsJson"));
        assert!(!clean.meta.contains_key("beforeJson"));
        assert!(!clean.meta.contains_key("emptyNote"));
        assert!(is_forbidden_key("nationalIdCiphertext"));
        assert!(is_forbidden_key("ibanCiphertext"));
        assert!(!is_forbidden_key("reference"));
    }

    #[test]
    fn the_response_carries_partial_and_the_query() {
        let query = parsed("acme");
        let candidates = vec![candidate(
            SearchType::Merchant,
            "m-1",
            "ACME",
            MatchSignals::new().primary("ACME"),
        )];
        let response = search_response(&query, &candidates, true);
        assert_eq!(response.query, "acme");
        assert_eq!(response.total, 1);
        assert!(response.partial);
        assert_eq!(response.items[0].score, 900);
        let empty = search_response(&query, &[], false);
        assert!(empty.is_empty());
        assert!(!empty.partial);
    }
}

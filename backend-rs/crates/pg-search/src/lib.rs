//! Global search: provider registry, query parsing, ranking and scoping.
//!
//! Port of `core-back/lib/search/{types,engine}.ts` and `core-back/lib/globalSearch.ts`
//! (task P4-T06 / P8 support).
//!
//! Parity notes:
//! - The working tree registers **21** providers (`Voucher` is not among them); the design deck's
//!   "20 providers" is stale. All 21 are ported with their execution order and aliases.
//! - Scores are integers: exact id/reference (1000) > primary text (900) > secondary text (250),
//!   and a non-match scores 100 so it ranks last instead of vanishing.
//! - `parse_query` enforces the request contract (trim, 2..=120 characters) and clamps `limit` to
//!   1..=50 ([`HARD_LIMIT_CAP`]); the TS admin schema's tighter `limit.max(10)` belongs to the edge
//!   route schema.
//! - Result items are sanitised exactly like `sanitizeResultItem`: ciphertext, secrets, bank
//!   details, tax ids and audit snapshots never reach the client.
//!
//! The providers' SQL is out of scope here; this crate is pure and testable without a database.

#![forbid(unsafe_code)]
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

pub mod query;
pub mod rank;
pub mod scope;
pub mod types;

pub use query::{
    build_phone_variants, parse_query, parse_query_with_limit, validate_request, ParsedSearchQuery,
    SearchError, SearchRequest, TokenKind, CONTRACT_LIMIT_MAX, DEFAULT_LIMIT, HARD_LIMIT_CAP,
    MAX_QUERY_CHARS, MIN_QUERY_CHARS,
};
pub use rank::{
    compute_match_score, is_forbidden_key, rank, rank_and_slice, sanitize_hit, search_response,
    MatchSignals, SearchCandidate, EXACT_PREFIX_WEIGHT, EXACT_SUBSTRING_WEIGHT, EXACT_WEIGHT,
    NO_MATCH_SCORE, PRIMARY_EXACT_WEIGHT, PRIMARY_PREFIX_WEIGHT, PRIMARY_SUBSTRING_WEIGHT,
    SECONDARY_EXACT_WEIGHT, SECONDARY_PREFIX_WEIGHT, SECONDARY_SUBSTRING_WEIGHT,
};
pub use scope::{
    attempt_scoped_types, merchant_scoped_types, transaction_scoped_types, SearchScope,
};
pub use types::{
    all_ordered, MetaValue, ProviderSpec, RankedHit, SearchHit, SearchResponse, SearchType,
    PROVIDERS,
};

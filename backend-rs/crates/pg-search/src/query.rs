//! Query parsing and request validation.
//!
//! Port of `core-back/lib/search/engine.ts` (`parseSearchQuery`, `buildPhoneVariants`) and of
//! `globalSearchRequestSchema` in `core-back/lib/globalSearch.ts`.
//!
//! Scoping tokens (`type:` / `is:` / `kind:`, `status:`, `merchant:`) are dropped from the free
//! text before matching, exactly like the TS parser; `type:` accepts every provider alias.
//!
//! Limit policy (documented port decision): [`DEFAULT_LIMIT`] is 5 and [`HARD_LIMIT_CAP`] is 50,
//! as the port plan requires. The TS admin request schema additionally caps `limit` at 10; that
//! tighter bound belongs to the edge route schema (P4-T06), not to this library.

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};

use crate::types::SearchType;

/// `limit` default (`globalSearchRequestSchema`).
pub const DEFAULT_LIMIT: u32 = 5;
/// The TS admin request schema's maximum (`limit.max(10)`).
pub const CONTRACT_LIMIT_MAX: u32 = 10;
/// The crate-level hard cap required by the port plan (`parse_query` clamps to it).
pub const HARD_LIMIT_CAP: u32 = 50;
/// The minimum free-text length.
pub const MIN_QUERY_CHARS: usize = 2;
/// The maximum query length (`raw.slice(0, 120)`).
pub const MAX_QUERY_CHARS: usize = 120;

/// `QueryTokenKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TokenKind {
    Sha256Hex,
    Email,
    Phone,
    IdOrRef,
    FreeText,
}

impl TokenKind {
    /// The wire value.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Sha256Hex => "SHA256_HEX",
            Self::Email => "EMAIL",
            Self::Phone => "PHONE",
            Self::IdOrRef => "ID_OR_REF",
            Self::FreeText => "FREE_TEXT",
        }
    }
}

/// `ParsedSearchQuery`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParsedSearchQuery {
    /// The trimmed query, at most 120 characters.
    pub raw: String,
    /// The free text after the scoping tokens were removed.
    pub term: String,
    /// `term` lower-cased (the matching key).
    pub term_lower: String,
    /// Phone spellings (Libyan normalisation) that match the same subscriber number.
    pub phone_variants: Vec<String>,
    pub token_kind: TokenKind,
    /// `type:<alias>` values, lower-cased and de-duplicated.
    pub scoped_type_aliases: Vec<String>,
    /// `status:<value>` upper-cased.
    pub scoped_status: Option<String>,
    /// `merchant:<id>`.
    pub scoped_merchant_id: Option<String>,
    /// The effective result limit (1..=50).
    pub limit: u32,
}

/// A request that cannot be served.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SearchError {
    /// The trimmed query is shorter than [`MIN_QUERY_CHARS`].
    #[error("Query must be at least 2 characters")]
    QueryTooShort,
    /// The trimmed query is longer than [`MAX_QUERY_CHARS`].
    #[error("Query must be at most 120 characters")]
    QueryTooLong,
    /// A requested record type is not registered.
    #[error("The search request contains an unsupported record type")]
    UnsupportedType(String),
    /// `limit` is outside 1..=50.
    #[error("The result limit must be between 1 and 50")]
    InvalidLimit(u32),
}

impl SearchError {
    /// The API code (`SEARCH_TYPE_UNSUPPORTED` is the TS-specific one).
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::UnsupportedType(_) => "SEARCH_TYPE_UNSUPPORTED",
            Self::QueryTooShort | Self::QueryTooLong | Self::InvalidLimit(_) => "VALIDATION_FAILED",
        }
    }

    /// The HTTP status.
    #[must_use]
    pub const fn status(&self) -> u16 {
        400
    }
}

/// An accepted search request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchRequest {
    /// The trimmed query echoed back to the client (`GlobalSearchResponse.query`).
    pub query: String,
    pub types: Vec<SearchType>,
    pub limit: u32,
}

impl SearchRequest {
    /// The requested types, or every registered type when the caller restricted none.
    #[must_use]
    pub fn effective_types(&self) -> Vec<SearchType> {
        if self.types.is_empty() {
            crate::types::all_ordered().to_vec()
        } else {
            self.types.clone()
        }
    }
}

fn truncate_chars(value: &str, maximum: usize) -> String {
    value.chars().take(maximum).collect()
}

fn is_sha256_hex(term: &str) -> bool {
    (16..=64).contains(&term.len()) && term.chars().all(|character| character.is_ascii_hexdigit())
}

fn is_email(term: &str) -> bool {
    let Some((local, domain)) = term.split_once('@') else {
        return false;
    };
    if local.is_empty() || local.chars().any(char::is_whitespace) {
        return false;
    }
    let Some((host, suffix)) = domain.rsplit_once('.') else {
        return false;
    };
    !host.is_empty() && !suffix.is_empty() && !term.chars().any(char::is_whitespace)
}

fn is_phone_shaped(term: &str) -> bool {
    let mut characters = term.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    if !(first.is_ascii_digit() || first == '+') {
        return false;
    }
    let count = 1 + characters.clone().count();
    (6..=19).contains(&count)
        && characters.all(|character| {
            character.is_ascii_digit() || matches!(character, ' ' | '(' | ')' | '-')
        })
}

fn is_id_or_ref(term: &str) -> bool {
    (4..=64).contains(&term.len())
        && !term.contains(' ')
        && term.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | ':' | '-')
        })
}

/// `buildPhoneVariants`: every spelling of the same Libyan subscriber number.
#[must_use]
pub fn build_phone_variants(term: &str) -> Vec<String> {
    if !is_phone_shaped(term) {
        return Vec::new();
    }
    let compact: String = term
        .chars()
        .filter(|character| !matches!(character, ' ' | '(' | ')' | '-'))
        .collect();
    let digits: String = compact.chars().filter(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return Vec::new();
    }
    let mut variants: Vec<String> = Vec::new();
    let mut push = |variant: String| {
        if !variant.is_empty() && !variants.contains(&variant) {
            variants.push(variant);
        }
    };
    push(compact.clone());
    push(digits.clone());
    if compact.starts_with('+') {
        push(format!("+{digits}"));
    }
    let normalized = digits.strip_prefix("00").unwrap_or(&digits).to_owned();
    if let Some(national) = normalized.strip_prefix("218") {
        push(normalized.clone());
        push(format!("+{normalized}"));
        if let Some(without_zero) = national.strip_prefix('0') {
            if !without_zero.is_empty() {
                push(format!("0{without_zero}"));
                push(without_zero.to_owned());
            }
        } else if !national.is_empty() {
            push(format!("0{national}"));
        }
    } else if let Some(without_zero) = normalized.strip_prefix('0') {
        if !without_zero.is_empty() {
            push(format!("218{without_zero}"));
            push(format!("+218{without_zero}"));
        }
    } else if normalized.starts_with('9') && normalized.len() == 9 {
        push(format!("0{normalized}"));
        push(format!("218{normalized}"));
        push(format!("+218{normalized}"));
    }
    variants
}

/// `parseSearchQuery` plus the request-level length check.
///
/// # Errors
/// [`SearchError::QueryTooShort`] / [`SearchError::QueryTooLong`].
pub fn parse_query(input: &str) -> Result<ParsedSearchQuery, SearchError> {
    parse_query_with_limit(input, DEFAULT_LIMIT)
}

/// [`parse_query`] with an explicit limit (clamped to 1..=[`HARD_LIMIT_CAP`]).
///
/// # Errors
/// [`SearchError`] for a query outside 2..=120 characters.
pub fn parse_query_with_limit(input: &str, limit: u32) -> Result<ParsedSearchQuery, SearchError> {
    let trimmed = input.trim();
    if trimmed.chars().count() < MIN_QUERY_CHARS {
        return Err(SearchError::QueryTooShort);
    }
    if trimmed.chars().count() > MAX_QUERY_CHARS {
        return Err(SearchError::QueryTooLong);
    }
    let raw = truncate_chars(trimmed, MAX_QUERY_CHARS);
    let tokens: Vec<&str> = raw.split_whitespace().collect();
    let mut scoped_type_aliases: Vec<String> = Vec::new();
    let mut scoped_status: Option<String> = None;
    let mut scoped_merchant_id: Option<String> = None;
    let mut remaining: Vec<&str> = Vec::new();

    for token in &tokens {
        if let Some((key, value)) = token.split_once(':') {
            if tokens.len() > 1 && !key.is_empty() && !value.trim().is_empty() {
                let key = key.to_ascii_lowercase();
                let value = value.trim();
                match key.as_str() {
                    "type" | "is" | "kind" => {
                        let alias = value.to_ascii_lowercase();
                        if !scoped_type_aliases.contains(&alias) {
                            scoped_type_aliases.push(alias);
                        }
                        continue;
                    }
                    "status" => {
                        scoped_status = Some(value.to_ascii_uppercase());
                        continue;
                    }
                    "merchant" => {
                        scoped_merchant_id = Some(value.to_owned());
                        continue;
                    }
                    _ => {}
                }
            }
        }
        remaining.push(token);
    }

    let joined = remaining.join(" ");
    let term = if joined.trim().is_empty() {
        raw.clone()
    } else {
        truncate_chars(joined.trim(), MAX_QUERY_CHARS)
    };
    let term_lower = term.to_lowercase();
    let phone_variants = build_phone_variants(&term);
    let token_kind = if is_sha256_hex(&term) {
        TokenKind::Sha256Hex
    } else if is_email(&term) {
        TokenKind::Email
    } else if !phone_variants.is_empty() {
        TokenKind::Phone
    } else if is_id_or_ref(&term) {
        TokenKind::IdOrRef
    } else {
        TokenKind::FreeText
    };

    Ok(ParsedSearchQuery {
        raw,
        term,
        term_lower,
        phone_variants,
        token_kind,
        scoped_type_aliases,
        scoped_status,
        scoped_merchant_id,
        limit: limit.clamp(1, HARD_LIMIT_CAP),
    })
}

/// Validates a request like `globalSearchRequestSchema` and resolves the requested types.
///
/// # Errors
/// [`SearchError`] for an invalid query, limit or record type.
pub fn validate_request(
    query: &str,
    types: &[&str],
    limit: Option<u32>,
) -> Result<SearchRequest, SearchError> {
    let requested_limit = limit.unwrap_or(DEFAULT_LIMIT);
    if requested_limit == 0 || requested_limit > HARD_LIMIT_CAP {
        return Err(SearchError::InvalidLimit(requested_limit));
    }
    let parsed = parse_query_with_limit(query, requested_limit)?;
    let mut resolved = Vec::with_capacity(types.len());
    for requested in types {
        let Some(search_type) = SearchType::from_wire(requested) else {
            return Err(SearchError::UnsupportedType((*requested).to_owned()));
        };
        if !resolved.contains(&search_type) {
            resolved.push(search_type);
        }
    }
    Ok(SearchRequest {
        query: parsed.raw,
        types: resolved,
        limit: parsed.limit,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scoping_tokens_are_extracted_and_the_term_is_cleaned() {
        let parsed = parse_query("type:merchant status:active acme").expect("parses");
        assert_eq!(parsed.term, "acme");
        assert_eq!(parsed.term_lower, "acme");
        assert_eq!(parsed.scoped_type_aliases, vec!["merchant"]);
        assert_eq!(parsed.scoped_status.as_deref(), Some("ACTIVE"));
        assert_eq!(parsed.scoped_merchant_id, None);
        assert_eq!(parsed.token_kind, TokenKind::IdOrRef);
    }

    #[test]
    fn a_lone_colon_token_stays_in_the_term() {
        let parsed = parse_query("http://example").expect("parses");
        assert_eq!(parsed.term, "http://example");
        assert!(parsed.scoped_type_aliases.is_empty());
    }

    #[test]
    fn merchant_and_kind_aliases_are_recognised() {
        let parsed = parse_query("merchant:0f8f kind:tx ACME").expect("parses");
        assert_eq!(parsed.scoped_merchant_id.as_deref(), Some("0f8f"));
        assert_eq!(parsed.scoped_type_aliases, vec!["tx"]);
        assert_eq!(parsed.term, "ACME");
        assert_eq!(
            SearchType::resolve_alias(&parsed.scoped_type_aliases[0]),
            vec![SearchType::PaymentAttempt]
        );
    }

    #[test]
    fn query_length_is_enforced() {
        assert_eq!(parse_query(" a "), Err(SearchError::QueryTooShort));
        assert!(parse_query("  ab  ").is_ok());
        let long = "a".repeat(500);
        assert_eq!(parse_query(&long), Err(SearchError::QueryTooLong));
        let parsed = parse_query(&"a".repeat(120)).expect("parses");
        assert_eq!(parsed.raw.chars().count(), 120);
        assert_eq!(SearchError::QueryTooShort.code(), "VALIDATION_FAILED");
        assert_eq!(SearchError::QueryTooShort.status(), 400);
    }

    #[test]
    fn the_limit_defaults_to_five_and_is_capped_at_fifty() {
        assert_eq!(parse_query("acme").expect("parses").limit, DEFAULT_LIMIT);
        assert_eq!(parse_query_with_limit("acme", 0).expect("parses").limit, 1);
        assert_eq!(parse_query_with_limit("acme", 7).expect("parses").limit, 7);
        assert_eq!(
            parse_query_with_limit("acme", 500).expect("parses").limit,
            HARD_LIMIT_CAP
        );
        assert_eq!(HARD_LIMIT_CAP, 50);
    }

    #[test]
    fn token_kinds_match_the_ts_regexes() {
        assert_eq!(
            parse_query("9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08")
                .expect("parses")
                .token_kind,
            TokenKind::Sha256Hex
        );
        assert_eq!(
            parse_query("ops@example.com").expect("parses").token_kind,
            TokenKind::Email
        );
        assert_eq!(
            parse_query("+218 91 234 5678").expect("parses").token_kind,
            TokenKind::Phone
        );
        assert_eq!(
            parse_query("ATT-2026-0001").expect("parses").token_kind,
            TokenKind::IdOrRef
        );
        assert_eq!(
            parse_query("ACME LLC").expect("parses").token_kind,
            TokenKind::FreeText
        );
        assert_eq!(TokenKind::Phone.as_str(), "PHONE");
    }

    #[test]
    fn libyan_phone_variants_are_complete() {
        let variants = build_phone_variants("+218 91 234 5678");
        assert_eq!(
            variants,
            vec!["+218912345678", "218912345678", "0912345678"]
        );
        let local = build_phone_variants("0912345678");
        assert!(local.contains(&"218912345678".to_owned()));
        assert!(local.contains(&"+218912345678".to_owned()));
        let short = build_phone_variants("912345678");
        assert!(short.contains(&"0912345678".to_owned()));
        assert!(build_phone_variants("not a phone").is_empty());
        assert!(build_phone_variants("+").is_empty());
    }

    #[test]
    fn request_validation_resolves_types_and_rejects_unknown_ones() {
        let request = validate_request(
            "acme",
            &["merchant", "payment_attempt", "merchant"],
            Some(5),
        )
        .expect("valid");
        assert_eq!(
            request.types,
            vec![SearchType::Merchant, SearchType::PaymentAttempt]
        );
        assert_eq!(request.limit, 5);
        assert_eq!(request.effective_types().len(), 2);
        let all = validate_request("acme", &[], None).expect("valid");
        assert_eq!(all.effective_types().len(), 21);
        assert_eq!(
            validate_request("acme", &["voucher"], None),
            Err(SearchError::UnsupportedType("voucher".to_owned()))
        );
        assert_eq!(
            validate_request("acme", &[], Some(0)),
            Err(SearchError::InvalidLimit(0))
        );
        assert_eq!(
            validate_request("acme", &[], Some(51)),
            Err(SearchError::InvalidLimit(51))
        );
        assert_eq!(
            validate_request("a", &[], None),
            Err(SearchError::QueryTooShort)
        );
        assert_eq!(
            SearchError::UnsupportedType("x".to_owned()).code(),
            "SEARCH_TYPE_UNSUPPORTED"
        );
    }

    #[test]
    fn a_query_of_only_scope_tokens_keeps_the_raw_text_as_the_term() {
        let parsed = parse_query("type:merchant").expect("parses");
        // A single token is never treated as a scope token (the TS requires > 1 token).
        assert!(parsed.scoped_type_aliases.is_empty());
        assert_eq!(parsed.term, "type:merchant");
    }
}

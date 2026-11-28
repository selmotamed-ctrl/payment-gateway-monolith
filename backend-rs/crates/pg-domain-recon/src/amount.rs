//! Statement amounts.
//!
//! Port of `core-back/engine/db/money.ts:12-40` (`moneyFromString`) as used by the statement
//! ingestor (`normalizeRow`), with `rust_decimal` instead of the BigInt minor-unit store.
//!
//! The accepted grammar is the TS `MONEY_PATTERN`, `^-?\d{1,18}(?:\.\d{1,18})?$` on the trimmed
//! value. The result is rounded to four decimals, half away from zero — exactly the
//! `moneyFromString` rounding, because `Decimal::MidpointAwayFromZero` rounds `-1.00005` to
//! `-1.0001` like the TS does (it strips the sign, rounds up, then re-applies it).
//!
//! Deviation: `rust_decimal` carries at most 28-29 significant digits, so a value with 18 integer
//! and 18 fractional digits (allowed by the TS pattern) fails to parse and answers
//! `INVALID_AMOUNT`. No real statement carries such a value.

#![forbid(unsafe_code)]

use rust_decimal::prelude::ToPrimitive;
use rust_decimal::{Decimal, RoundingStrategy};
use thiserror::Error;

/// `MONEY_DECIMALS`.
pub const MONEY_DECIMALS: u32 = 4;
/// `10^MONEY_DECIMALS` as an integer factor.
pub const MONEY_SCALE: i128 = 10_000;

/// Statement parsing errors, with the API code of the TS routes where one exists.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ReconError {
    #[error("Invalid monetary amount: {0}")]
    InvalidAmount(String),
    #[error("The monetary amount is out of range: {0}")]
    AmountOutOfRange(String),
    #[error("Invalid statement date format '{0}'")]
    InvalidDateFormat(String),
    #[error("The statement date '{0}' cannot be parsed")]
    UnparsableDate(String),
    #[error("The statement date is empty")]
    EmptyDate,
    #[error("Invalid statement currency '{0}'")]
    InvalidCurrency(String),
    #[error("Unknown statement timezone '{0}'")]
    UnknownTimezone(String),
}

impl ReconError {
    /// The `ApiError` code of the TS code path.
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::InvalidAmount(_) | Self::AmountOutOfRange(_) => "INVALID_AMOUNT",
            Self::InvalidDateFormat(_) | Self::UnparsableDate(_) | Self::EmptyDate => {
                "STATEMENT_PARSE_FAILED"
            }
            Self::InvalidCurrency(_) | Self::UnknownTimezone(_) => "STATEMENT_PARSE_FAILED",
        }
    }

    #[must_use]
    pub const fn status(&self) -> u16 {
        400
    }
}

/// Parse a statement amount to a four-decimal [`Decimal`].
pub fn parse_amount(raw: &str) -> Result<Decimal, ReconError> {
    let trimmed = raw.trim();
    if !is_money_literal(trimmed) {
        return Err(ReconError::InvalidAmount(raw.to_owned()));
    }
    let value =
        Decimal::from_str_exact(trimmed).map_err(|_| ReconError::InvalidAmount(raw.to_owned()))?;
    Ok(value.round_dp_with_strategy(MONEY_DECIMALS, RoundingStrategy::MidpointAwayFromZero))
}

/// `^-?\d{1,18}(?:\.\d{1,18})?$` without a regex engine.
#[must_use]
pub fn is_money_literal(raw: &str) -> bool {
    let unsigned = raw.strip_prefix('-').unwrap_or(raw);
    let (integer, fraction) = match unsigned.split_once('.') {
        Some((integer, fraction)) => (integer, Some(fraction)),
        None => (unsigned, None),
    };
    let integer_ok = !integer.is_empty()
        && integer.len() <= 18
        && integer.bytes().all(|byte| byte.is_ascii_digit());
    let fraction_ok = match fraction {
        None => true,
        Some(fraction) => {
            !fraction.is_empty()
                && fraction.len() <= 18
                && fraction.bytes().all(|byte| byte.is_ascii_digit())
        }
    };
    integer_ok && fraction_ok
}

/// The minor-unit value (`Money` bigint equivalent) of a four-decimal amount.
pub fn amount_minor(amount: Decimal) -> Result<i128, ReconError> {
    let scaled = amount
        .checked_mul(Decimal::from(MONEY_SCALE))
        .ok_or_else(|| ReconError::AmountOutOfRange(amount.to_string()))?;
    scaled
        .to_i128()
        .ok_or_else(|| ReconError::AmountOutOfRange(amount.to_string()))
}

/// `moneyToString`: always four decimals, `-` prefix for negatives.
#[must_use]
pub fn format_amount(amount: Decimal) -> String {
    format!("{amount:.4}")
}

/// Validate and upper-case a statement source currency (`^[A-Z]{3}$` after trimming).
pub fn validate_currency_code(raw: &str) -> Result<String, ReconError> {
    let trimmed = raw.trim();
    if trimmed.len() == 3 && trimmed.bytes().all(|byte| byte.is_ascii_alphabetic()) {
        Ok(trimmed.to_ascii_uppercase())
    } else {
        Err(ReconError::InvalidCurrency(raw.to_owned()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_rounds_like_money_from_string() {
        assert_eq!(parse_amount("10").expect("ok"), Decimal::new(100_000, 4));
        assert_eq!(parse_amount("10.5").expect("ok"), Decimal::new(105_000, 4));
        assert_eq!(
            parse_amount(" 10.00005 ").expect("ok"),
            Decimal::new(100_001, 4)
        );
        assert_eq!(parse_amount("0.00005").expect("ok"), Decimal::new(1, 4));
        assert_eq!(
            parse_amount("-1.00005").expect("ok"),
            Decimal::new(-10_001, 4)
        );
        assert_eq!(
            parse_amount("123456789012345678").expect("ok").to_string(),
            "123456789012345678"
        );
    }

    #[test]
    fn rejects_every_shape_the_ts_rejects() {
        for raw in [
            "", " ", "+1", "1.", ".5", "1e5", "1,000.00", "1.2.3", "١٢٣", "--1", "1-",
        ] {
            assert_eq!(
                parse_amount(raw),
                Err(ReconError::InvalidAmount(raw.to_owned())),
                "{raw:?}"
            );
        }
        assert!(parse_amount(&"9".repeat(19)).is_err());
        assert!(parse_amount(&format!("1.{}", "0".repeat(19))).is_err());
        // Beyond rust_decimal's 28 significant digits.
        assert_eq!(
            parse_amount(&format!("{}.{}", "1".repeat(18), "1".repeat(18))),
            Err(ReconError::InvalidAmount(format!(
                "{}.{}",
                "1".repeat(18),
                "1".repeat(18)
            )))
        );
        let error = parse_amount("bad").expect_err("invalid");
        assert_eq!(error.code(), "INVALID_AMOUNT");
        assert_eq!(error.status(), 400);
    }

    #[test]
    fn minor_units_match_the_bigint_store() {
        assert_eq!(
            amount_minor(parse_amount("1").expect("ok")).expect("minor"),
            10_000
        );
        assert_eq!(
            amount_minor(parse_amount("-2.5").expect("ok")).expect("minor"),
            -25_000
        );
        assert_eq!(format_amount(parse_amount("2.5").expect("ok")), "2.5000");
        assert_eq!(format_amount(Decimal::new(-25_000, 4)), "-2.5000");
    }

    #[test]
    fn currency_validation() {
        assert_eq!(validate_currency_code(" lyd ").expect("ok"), "LYD");
        assert_eq!(
            validate_currency_code("LY"),
            Err(ReconError::InvalidCurrency("LY".to_owned()))
        );
        assert!(validate_currency_code("L1D").is_err());
        assert_eq!(
            validate_currency_code("").expect_err("empty").code(),
            "STATEMENT_PARSE_FAILED"
        );
    }
}

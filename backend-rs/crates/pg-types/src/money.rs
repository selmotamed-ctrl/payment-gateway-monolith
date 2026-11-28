//! Money and decimal serialisation.
//!
//! Money is always a decimal; floats never appear here (master rule 3). The test module contains
//! the golden values extracted from the TypeScript/Prisma behaviour.

#![forbid(unsafe_code)]

use std::fmt;
use std::str::FromStr;

use rust_decimal::prelude::*;
use rust_decimal::{Decimal, RoundingStrategy};
use serde::de::{self, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// Input money regex `^\d{1,14}(\.\d{1,4})?$` (chapter 2 §4).
pub const MONEY_INPUT_REGEX: &str = r"^\d{1,14}(\.\d{1,4})?$";

/// The commission-profile rounding modes (chapter 2 §12).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RoundingMode {
    #[default]
    HalfUp,
    HalfEven,
    HalfDown,
    Up,
    Down,
    Ceiling,
    Floor,
}

impl RoundingMode {
    #[must_use]
    /// Parse the commission-profile spellings. Returns `None` for unknown values; call
    /// [`RoundingMode::parse_or_default`] where the TS `roundingModeOf` fallback applies.
    pub fn parse(raw: &str) -> Option<Self> {
        let upper = raw.trim().to_ascii_uppercase();
        let normalized = upper.strip_prefix("ROUND_").unwrap_or(&upper);
        Some(match normalized {
            "HALF_UP" => Self::HalfUp,
            "HALF_EVEN" | "BANKERS" => Self::HalfEven,
            "HALF_DOWN" => Self::HalfDown,
            "UP" => Self::Up,
            "DOWN" => Self::Down,
            "CEILING" | "CEIL" => Self::Ceiling,
            "FLOOR" => Self::Floor,
            _ => return None,
        })
    }

    /// TS `roundingModeOf`: unknown or missing values fall back to HALF_UP.
    #[must_use]
    pub fn parse_or_default(raw: &str) -> Self {
        Self::parse(raw).unwrap_or_default()
    }

    #[must_use]
    pub fn to_strategy(self) -> RoundingStrategy {
        match self {
            Self::HalfUp => RoundingStrategy::MidpointAwayFromZero,
            Self::HalfEven => RoundingStrategy::MidpointNearestEven,
            Self::HalfDown => RoundingStrategy::MidpointTowardZero,
            Self::Up => RoundingStrategy::AwayFromZero,
            Self::Down => RoundingStrategy::ToZero,
            Self::Ceiling => RoundingStrategy::ToPositiveInfinity,
            Self::Floor => RoundingStrategy::ToNegativeInfinity,
        }
    }

    /// Round a money value to 4 decimal places exactly once.
    #[must_use]
    pub fn apply(self, value: Decimal) -> Decimal {
        value.round_dp_with_strategy(4, self.to_strategy())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MoneyParseError {
    Empty,
    Invalid,
}

impl fmt::Display for MoneyParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => f.write_str("money value is empty"),
            Self::Invalid => f.write_str("money value must match ^\\d{1,14}(\\.\\d{1,4})?$"),
        }
    }
}

impl std::error::Error for MoneyParseError {}

/// Parse a money input string, enforcing the TS regex before decimal parsing.
pub fn parse_money_input(raw: &str) -> Result<Decimal, MoneyParseError> {
    if raw.is_empty() {
        return Err(MoneyParseError::Empty);
    }
    if !money_input_matches(raw) {
        return Err(MoneyParseError::Invalid);
    }
    Decimal::from_str(raw).map_err(|_| MoneyParseError::Invalid)
}

fn money_input_matches(raw: &str) -> bool {
    let mut parts = raw.split('.');
    let integer = parts.next().unwrap_or("");
    if integer.is_empty() || integer.len() > 14 || !integer.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    match parts.next() {
        None => true,
        Some(fraction) => {
            !fraction.is_empty()
                && fraction.len() <= 4
                && fraction.bytes().all(|b| b.is_ascii_digit())
                && parts.next().is_none()
        }
    }
}

/// A money field serialised as `toFixed(4)`; `null` becomes `"0.0000"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Money4(pub Decimal);

impl Money4 {
    #[must_use]
    pub fn new(value: Decimal) -> Self {
        Self(value)
    }

    #[must_use]
    pub fn to_fixed_4(self) -> String {
        // decimal.js `toFixed(4)`: ROUND_HALF_UP by default, no trailing-zero trimming, and
        // `-0` is normalised to `0`.
        let rounded = self
            .0
            .round_dp_with_strategy(4, RoundingStrategy::MidpointAwayFromZero);
        let rounded = if rounded.is_zero() {
            Decimal::ZERO
        } else {
            rounded
        };
        format!("{rounded:.4}")
    }
}

impl fmt::Display for Money4 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_fixed_4())
    }
}

impl Serialize for Money4 {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_fixed_4())
    }
}

impl<'de> Deserialize<'de> for Money4 {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        let value = Decimal::from_str(&raw).map_err(de::Error::custom)?;
        Ok(Self(value))
    }
}

/// Serialise an optional money field the way the handlers do: missing/null → `"0.0000"`.
#[must_use]
pub fn money4_or_zero(value: Option<Decimal>) -> Money4 {
    Money4(value.unwrap_or(Decimal::ZERO))
}

/// Prisma `Decimal` inside `JSON.stringify` → decimal.js `toString()`.
///
/// decimal.js rules: no trailing fractional zeros, plain notation while the exponent is
/// `-7 < e < 21`, otherwise `1e+21` / `1.5e-7` style.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct DecimalJs(pub Decimal);

impl DecimalJs {
    #[must_use]
    pub fn to_decimal_js_string(self) -> String {
        let value = self.0;
        if value.is_zero() {
            return if value.is_sign_negative() {
                "-0".to_owned()
            } else {
                "0".to_owned()
            };
        }
        let sign = if value.is_sign_negative() { "-" } else { "" };
        let mantissa = value.mantissa().unsigned_abs().to_string();
        let scale = i64::from(value.scale());
        let exponent = mantissa.len() as i64 - 1 - scale;
        let digits = mantissa.trim_end_matches('0');
        let digits = if digits.is_empty() { "0" } else { digits };

        // decimal.js: plain notation while -7 < exponent < 21; `1e-7` is exponential.
        if exponent > -7 && exponent < 21 {
            let point = exponent + 1;
            let rendered = if point <= 0 {
                format!("0.{}{}", "0".repeat((-point) as usize), digits)
            } else if point as usize >= digits.len() {
                format!("{}{}", digits, "0".repeat(point as usize - digits.len()))
            } else {
                let (head, tail) = digits.split_at(point as usize);
                format!("{head}.{tail}")
            };
            return format!("{sign}{rendered}");
        }

        let (head, tail) = digits.split_at(1);
        let mantissa = if tail.is_empty() {
            head.to_owned()
        } else {
            format!("{head}.{tail}")
        };
        format!(
            "{sign}{mantissa}e{}{}",
            if exponent >= 0 { '+' } else { '-' },
            exponent.abs()
        )
    }
}

impl fmt::Display for DecimalJs {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_decimal_js_string())
    }
}

impl Serialize for DecimalJs {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_decimal_js_string())
    }
}

impl<'de> Deserialize<'de> for DecimalJs {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct DecimalVisitor;
        impl Visitor<'_> for DecimalVisitor {
            type Value = DecimalJs;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a decimal string or number")
            }
            fn visit_str<E: de::Error>(self, value: &str) -> Result<Self::Value, E> {
                Decimal::from_str(value).map(DecimalJs).map_err(E::custom)
            }
            fn visit_f64<E: de::Error>(self, value: f64) -> Result<Self::Value, E> {
                Decimal::from_f64(value)
                    .map(DecimalJs)
                    .ok_or_else(|| E::custom("non-finite decimal"))
            }
        }
        deserializer.deserialize_any(DecimalVisitor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn money4_formats_four_places() {
        assert_eq!(Money4(Decimal::new(5, 0)).to_string(), "5.0000");
        assert_eq!(Money4(Decimal::new(5, 2)).to_string(), "0.0500");
        assert_eq!(money4_or_zero(None).to_string(), "0.0000");
    }

    #[test]
    fn money_input_regex_is_enforced() {
        assert!(parse_money_input("1").is_ok());
        assert!(parse_money_input("12345678901234.1234").is_ok());
        assert!(parse_money_input("123456789012345").is_err());
        assert!(parse_money_input("1.12345").is_err());
        assert!(parse_money_input("-1").is_err());
        assert!(parse_money_input("1.").is_err());
        assert!(parse_money_input("").is_err());
    }

    #[test]
    fn decimal_js_trims_zeros_and_uses_exponent_bounds() {
        assert_eq!(
            DecimalJs(Decimal::from_str("1.2300").unwrap()).to_string(),
            "1.23"
        );
        assert_eq!(
            DecimalJs(Decimal::from_str("0.0000001").unwrap()).to_string(),
            "1e-7"
        );
        assert_eq!(
            DecimalJs(Decimal::from_str("1000000000000000000000").unwrap()).to_string(),
            "1e+21"
        );
        assert_eq!(DecimalJs(Decimal::ZERO).to_string(), "0");
    }

    #[test]
    fn rounding_modes_map_to_rust_decimal() {
        let value = Decimal::from_str("1.23445").unwrap();
        assert_eq!(RoundingMode::HalfUp.apply(value).to_string(), "1.2345");
        assert_eq!(RoundingMode::Down.apply(value).to_string(), "1.2344");
    }
}

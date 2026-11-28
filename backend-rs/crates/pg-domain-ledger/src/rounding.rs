//! Commission rounding and the split fee-bearer breakdown.
//!
//! Ports: `core-back/api/internal/checkout.ts`
//!
//! - `MONEY_SCALE` (`:366`), `roundingModeOf` (`:367-388`),
//! - `splitRatio` (`:456-487`), `buildBreakdown` (`:489-521`).
//!
//! The TypeScript computes the commission **once** from the payment amount and rounds it **once**
//! to four decimal places with the profile's rounding mode. Every other figure is derived from that
//! rounded value by exact subtraction, so the journal balances exactly (`commission + merchant ==
//! amount`, never a rounding residue). That is the contract implemented here; no float appears.
//!
//! Fee bearers (from `buildBreakdown`):
//!
//! - `MERCHANT_ABSORBS`: `net = gross - commission`, surcharge `0`, charged `gross`.
//! - `PAYER_SURCHARGE`: `net = gross`, surcharge `commission`, charged `gross + commission`.
//! - `SPLIT`: the payer pays a ratio of the commission, so `surcharge = round(commission * share)`,
//!   `charged = gross + surcharge`, `net = gross - (commission - surcharge)` (exact subtraction).
//!
//! [`split_commission`] is the `SPLIT` case with the TS fallback ratio (0.5) and the commission
//! rate applied as a percentage; callers with a stored `splitRatio` use
//! [`split_commission_with_share`].

use rust_decimal::{Decimal, RoundingStrategy};
use serde::{Deserialize, Serialize};

/// Money scale (`numeric(18,4)`): four decimal places (`checkout.ts:366`).
pub const MONEY_SCALE: u32 = 4;

/// Port of `roundingModeOf` (`checkout.ts:367-388`): the commission-profile rounding modes.
///
/// The TypeScript strips a leading `ROUND_` and accepts `BANKERS`/`CEIL` aliases; unknown values
/// fall back to `HALF_UP`. [`CommissionRounding::parse`] keeps exactly that behaviour, while the
/// callers of this crate decide explicitly which mode to use (there is no silent fallback when a
/// mode fails to parse).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CommissionRounding {
    /// decimal.js `ROUND_HALF_UP`; the platform default.
    #[default]
    HalfUp,
    /// decimal.js `ROUND_HALF_EVEN` (`BANKERS`).
    HalfEven,
    /// decimal.js `ROUND_HALF_DOWN`.
    HalfDown,
    /// decimal.js `ROUND_UP` (away from zero).
    Up,
    /// decimal.js `ROUND_DOWN` (toward zero).
    Down,
    /// decimal.js `ROUND_CEIL` (toward positive infinity).
    Ceiling,
    /// decimal.js `ROUND_FLOOR` (toward negative infinity).
    Floor,
}

impl CommissionRounding {
    /// The commission-profile text (`"HALF_UP"` …).
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::HalfUp => "HALF_UP",
            Self::HalfEven => "HALF_EVEN",
            Self::HalfDown => "HALF_DOWN",
            Self::Up => "UP",
            Self::Down => "DOWN",
            Self::Ceiling => "CEILING",
            Self::Floor => "FLOOR",
        }
    }

    /// Port of `roundingModeOf`: case-insensitive, tolerates a `ROUND_` prefix and the
    /// `BANKERS`/`CEIL` aliases.
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        let trimmed = raw.trim().to_ascii_uppercase();
        let key = trimmed.strip_prefix("ROUND_").unwrap_or(trimmed.as_str());
        Some(match key {
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

    /// The `rust_decimal` strategy with the same semantics (chapter 2 §12 mapping).
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

    /// Rounds a money value to four decimal places once (`toDecimalPlaces(4, mode)`).
    #[must_use]
    pub fn apply(self, value: Decimal) -> Decimal {
        value.round_dp_with_strategy(MONEY_SCALE, self.to_strategy())
    }

    /// The shared `pg-types` vocabulary, kept in lock-step (see the tests).
    #[must_use]
    pub fn from_pg(mode: pg_types::RoundingMode) -> Self {
        match mode {
            pg_types::RoundingMode::HalfUp => Self::HalfUp,
            pg_types::RoundingMode::HalfEven => Self::HalfEven,
            pg_types::RoundingMode::HalfDown => Self::HalfDown,
            pg_types::RoundingMode::Up => Self::Up,
            pg_types::RoundingMode::Down => Self::Down,
            pg_types::RoundingMode::Ceiling => Self::Ceiling,
            pg_types::RoundingMode::Floor => Self::Floor,
        }
    }

    /// The shared `pg-types` vocabulary, kept in lock-step (see the tests).
    #[must_use]
    pub fn to_pg(self) -> pg_types::RoundingMode {
        match self {
            Self::HalfUp => pg_types::RoundingMode::HalfUp,
            Self::HalfEven => pg_types::RoundingMode::HalfEven,
            Self::HalfDown => pg_types::RoundingMode::HalfDown,
            Self::Up => pg_types::RoundingMode::Up,
            Self::Down => pg_types::RoundingMode::Down,
            Self::Ceiling => pg_types::RoundingMode::Ceiling,
            Self::Floor => pg_types::RoundingMode::Floor,
        }
    }
}

impl std::fmt::Display for CommissionRounding {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// `splitRatio`'s fallback (`checkout.ts:458-462`): a half when no valid share is stored.
#[must_use]
pub fn default_split_platform_share() -> Decimal {
    Decimal::new(5, 1)
}

/// Port of the `toDecimalPlaces(MONEY_SCALE, mode)` step: money rounds to four decimal places with
/// the profile's rounding mode. Like decimal.js, a value that already has fewer decimals is
/// returned unchanged (its scale is at most four, never padded).
#[must_use]
pub fn round_money_4(value: Decimal, rounding: CommissionRounding) -> Decimal {
    value.round_dp_with_strategy(MONEY_SCALE, rounding.to_strategy())
}

/// Which money input failed validation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MoneyField {
    Gross,
    Commission,
    Rate,
}

impl MoneyField {
    /// The human label used by the error message.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Gross => "gross amount",
            Self::Commission => "commission amount",
            Self::Rate => "commission rate",
        }
    }
}

impl std::fmt::Display for MoneyField {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Why a commission breakdown could not be computed.
///
/// A struct (one error with the offending field) rather than one variant per field: readable, and
/// it keeps the enum-variant naming lint out of the way.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MoneyError {
    /// The offending input.
    pub field: MoneyField,
}

impl std::fmt::Display for MoneyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} must not be negative", self.field)
    }
}

impl std::error::Error for MoneyError {}

/// Port of the `CommissionBreakdown` split figures (`checkout.ts:513-521`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SplitCommission {
    /// The payment amount the commission is computed from.
    pub gross: Decimal,
    /// The platform commission, at most four decimal places.
    pub commission: Decimal,
    /// The share of the commission the payer pays (`round(commission * platform_share)`), at most
    /// four decimal places.
    pub payer_share: Decimal,
    /// What is charged on top of `gross` (equal to `payer_share` for a split bearer).
    pub surcharge: Decimal,
    /// `gross + surcharge`.
    pub total_charged: Decimal,
    /// What the merchant is credited: `gross - (commission - payer_share)`, exact.
    pub net: Decimal,
}

impl SplitCommission {
    /// The requested `(net, payer_share, surcharge)` view of the breakdown.
    #[must_use]
    pub fn as_tuple(&self) -> (Decimal, Decimal, Decimal) {
        (self.net, self.payer_share, self.surcharge)
    }
}

/// Port of the percentage part of `commissionForProfile` (`checkout.ts:411-448`), used by the
/// `PERCENTAGE`/`HYBRID` calc types: `gross * rate`, rounded once.
///
/// TIERED profiles resolve their own flat/percent pair before this step; that selection is a
/// profile concern, not a money concern.
pub fn commission_for_percentage(
    gross: Decimal,
    rate: Decimal,
    rounding: CommissionRounding,
) -> Result<Decimal, MoneyError> {
    if gross < Decimal::ZERO {
        return Err(MoneyError {
            field: MoneyField::Gross,
        });
    }
    if rate < Decimal::ZERO {
        return Err(MoneyError {
            field: MoneyField::Rate,
        });
    }
    Ok(round_money_4(gross * rate, rounding))
}

/// Port of the `SPLIT` branch of `buildBreakdown` (`checkout.ts:513-521`), with the commission rate
/// applied as a percentage and the `splitRatio` fallback of one half:
///
/// - `commission = round(gross * rate)`,
/// - `payer_share = surcharge = round(commission * 0.5)` (the TS `splitRatio` fallback, which is
///   what the ledger design's worked example uses: `100.0000` at `3%` charges the payer `1.5000`
///   and credits the merchant `98.5000`),
/// - `net = gross - (commission - payer_share)` by exact subtraction.
///
/// Returns `(net, payer_share, surcharge)`. Use [`split_commission_breakdown`] for the full
/// figures (commission and total charged) and [`split_commission_with_share`] when the profile has
/// a stored split ratio.
pub fn split_commission(
    gross: Decimal,
    rate: Decimal,
    rounding: CommissionRounding,
) -> Result<(Decimal, Decimal, Decimal), MoneyError> {
    split_commission_breakdown(gross, rate, rounding).map(|split| split.as_tuple())
}

/// [`split_commission`] with every figure of the `SPLIT` breakdown.
pub fn split_commission_breakdown(
    gross: Decimal,
    rate: Decimal,
    rounding: CommissionRounding,
) -> Result<SplitCommission, MoneyError> {
    let commission = commission_for_percentage(gross, rate, rounding)?;
    split_commission_with_share(gross, commission, None, rounding)
}

/// The full `SPLIT` breakdown from an already-rounded commission and the profile's platform share.
///
/// `gross` is the 4-decimal payment amount (`buildBreakdown` rounds `link.amount` HALF_UP once for
/// its own arithmetic); it is not rounded again here. `platform_share` outside `0..=1` (or `None`)
/// falls back to [`default_split_platform_share`], exactly like `splitRatio`
/// (`checkout.ts:456-487`). The payer's share is rounded once with the profile mode; `net` and
/// `total_charged` are exact additions/subtractions of four-decimal values, so
/// `net + commission == total_charged` and the journal can balance without a residue.
pub fn split_commission_with_share(
    gross: Decimal,
    commission: Decimal,
    platform_share: Option<Decimal>,
    rounding: CommissionRounding,
) -> Result<SplitCommission, MoneyError> {
    if gross < Decimal::ZERO {
        return Err(MoneyError {
            field: MoneyField::Gross,
        });
    }
    if commission < Decimal::ZERO {
        return Err(MoneyError {
            field: MoneyField::Commission,
        });
    }
    let share = platform_share
        .filter(|value| (Decimal::ZERO..=Decimal::ONE).contains(value))
        .unwrap_or_else(default_split_platform_share);
    let payer_share = round_money_4(commission * share, rounding);
    let net = gross - (commission - payer_share);
    let total_charged = gross + payer_share;
    Ok(SplitCommission {
        gross,
        commission,
        payer_share,
        surcharge: payer_share,
        total_charged,
        net,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal::Decimal;
    use std::str::FromStr;

    fn dec(raw: &str) -> Decimal {
        Decimal::from_str(raw).expect("test decimal")
    }

    #[test]
    fn half_up_rounds_a_half_away_from_zero() {
        assert_eq!(
            round_money_4(dec("1.23445"), CommissionRounding::HalfUp),
            dec("1.2345")
        );
        assert_eq!(
            round_money_4(dec("-1.23445"), CommissionRounding::HalfUp),
            dec("-1.2345")
        );
    }

    #[test]
    fn half_even_rounds_a_half_to_the_even_digit() {
        assert_eq!(
            round_money_4(dec("0.00025"), CommissionRounding::HalfEven),
            dec("0.0002")
        );
        assert_eq!(
            round_money_4(dec("0.00035"), CommissionRounding::HalfEven),
            dec("0.0004")
        );
    }

    #[test]
    fn half_down_rounds_a_half_toward_zero() {
        assert_eq!(
            round_money_4(dec("0.00025"), CommissionRounding::HalfDown),
            dec("0.0002")
        );
        assert_eq!(
            round_money_4(dec("-0.00025"), CommissionRounding::HalfDown),
            dec("-0.0002")
        );
    }

    #[test]
    fn up_and_down_ignore_the_fraction_size() {
        assert_eq!(
            round_money_4(dec("1.00001"), CommissionRounding::Up),
            dec("1.0001")
        );
        assert_eq!(
            round_money_4(dec("-1.00001"), CommissionRounding::Up),
            dec("-1.0001")
        );
        assert_eq!(
            round_money_4(dec("1.00009"), CommissionRounding::Down),
            dec("1.0000")
        );
        assert_eq!(
            round_money_4(dec("-1.00009"), CommissionRounding::Down),
            dec("-1.0000")
        );
    }

    #[test]
    fn ceiling_and_floor_follow_positive_and_negative_infinity() {
        assert_eq!(
            round_money_4(dec("1.00001"), CommissionRounding::Ceiling),
            dec("1.0001")
        );
        assert_eq!(
            round_money_4(dec("-1.00001"), CommissionRounding::Ceiling),
            dec("-1.0000")
        );
        assert_eq!(
            round_money_4(dec("1.00001"), CommissionRounding::Floor),
            dec("1.0000")
        );
        assert_eq!(
            round_money_4(dec("-1.00001"), CommissionRounding::Floor),
            dec("-1.0001")
        );
    }

    #[test]
    fn rounding_modes_stay_in_lock_step_with_pg_types() {
        let modes = [
            CommissionRounding::HalfUp,
            CommissionRounding::HalfEven,
            CommissionRounding::HalfDown,
            CommissionRounding::Up,
            CommissionRounding::Down,
            CommissionRounding::Ceiling,
            CommissionRounding::Floor,
        ];
        for mode in modes {
            assert_eq!(CommissionRounding::from_pg(mode.to_pg()), mode);
            assert_eq!(mode.to_pg().to_strategy(), mode.to_strategy());
        }
        let sample = dec("1.23445");
        assert_eq!(
            CommissionRounding::HalfEven.apply(sample),
            pg_types::RoundingMode::HalfEven.apply(sample)
        );
    }

    #[test]
    fn parsing_mirrors_rounding_mode_of() {
        for mode in [
            CommissionRounding::HalfUp,
            CommissionRounding::HalfEven,
            CommissionRounding::HalfDown,
            CommissionRounding::Up,
            CommissionRounding::Down,
            CommissionRounding::Ceiling,
            CommissionRounding::Floor,
        ] {
            assert_eq!(CommissionRounding::parse(mode.as_str()), Some(mode));
            assert_eq!(mode.to_string(), mode.as_str());
        }
        assert_eq!(
            CommissionRounding::parse("ROUND_HALF_UP"),
            Some(CommissionRounding::HalfUp)
        );
        assert_eq!(
            CommissionRounding::parse(" bankers "),
            Some(CommissionRounding::HalfEven)
        );
        assert_eq!(
            CommissionRounding::parse("ceil"),
            Some(CommissionRounding::Ceiling)
        );
        assert_eq!(CommissionRounding::parse("nearest"), None);
        assert_eq!(CommissionRounding::parse(""), None);
    }

    #[test]
    fn split_commission_reproduces_the_worked_split_entry() {
        // Ledger design §3.3 row 6: amount 100, commission 3, payer surcharge 1.5, merchant 98.5.
        let split =
            split_commission_breakdown(dec("100.0000"), dec("0.03"), CommissionRounding::HalfUp)
                .expect("valid split");
        assert_eq!(split.gross, dec("100.0000"));
        assert_eq!(split.commission.to_string(), "3.0000");
        assert_eq!(split.payer_share.to_string(), "1.5000");
        assert_eq!(split.surcharge, split.payer_share);
        assert_eq!(split.total_charged.to_string(), "101.5000");
        assert_eq!(split.net.to_string(), "98.5000");
        assert_eq!(
            split.as_tuple(),
            (dec("98.5000"), dec("1.5000"), dec("1.5000"))
        );
        // The tuple API is exactly (net, payer_share, surcharge).
        assert_eq!(
            split_commission(dec("100.0000"), dec("0.03"), CommissionRounding::HalfUp)
                .expect("valid split"),
            (dec("98.5000"), dec("1.5000"), dec("1.5000"))
        );
    }

    #[test]
    fn split_figures_balance_exactly_without_a_rounding_residue() {
        let split =
            split_commission_breakdown(dec("33.3333"), dec("0.0299"), CommissionRounding::HalfUp)
                .expect("valid split");
        // The journal equation: merchant credit + platform commission == charged amount.
        assert_eq!(split.net + split.commission, split.total_charged);
        assert_eq!(split.total_charged, split.gross + split.payer_share);
        assert_eq!(
            split.net,
            split.gross - (split.commission - split.payer_share)
        );
        // Everything stays inside the money scale.
        assert!(split.commission.scale() <= MONEY_SCALE);
        assert!(split.payer_share.scale() <= MONEY_SCALE);
        assert!(split.net.scale() <= MONEY_SCALE);
        assert!(split.total_charged.scale() <= MONEY_SCALE);
    }

    #[test]
    fn a_platform_share_drives_the_payer_part() {
        let split = split_commission_with_share(
            dec("100.0000"),
            dec("3.0000"),
            Some(dec("0.25")),
            CommissionRounding::HalfUp,
        )
        .expect("valid split");
        assert_eq!(split.payer_share, dec("0.7500"));
        assert_eq!(split.net, dec("97.7500"));
        assert_eq!(split.total_charged, dec("100.7500"));
    }

    #[test]
    fn an_invalid_platform_share_falls_back_to_one_half() {
        for share in [None, Some(dec("1.5")), Some(dec("-0.1"))] {
            let split = split_commission_with_share(
                dec("100.0000"),
                dec("2.0000"),
                share,
                CommissionRounding::HalfUp,
            )
            .expect("valid split");
            assert_eq!(split.payer_share, dec("1.0000"));
        }
    }

    #[test]
    fn zero_commission_is_a_valid_breakdown() {
        let split =
            split_commission_breakdown(dec("100.0000"), Decimal::ZERO, CommissionRounding::HalfUp)
                .expect("valid split");
        assert!(split.commission.is_zero());
        assert!(split.payer_share.is_zero());
        assert_eq!(split.net, dec("100.0000"));
        assert_eq!(split.total_charged, dec("100.0000"));
    }

    #[test]
    fn negative_money_is_rejected() {
        assert_eq!(
            split_commission(dec("-1"), dec("0.03"), CommissionRounding::HalfUp),
            Err(MoneyError {
                field: MoneyField::Gross
            })
        );
        assert_eq!(
            split_commission(dec("1"), dec("-0.03"), CommissionRounding::HalfUp),
            Err(MoneyError {
                field: MoneyField::Rate
            })
        );
        assert_eq!(
            split_commission_with_share(dec("1"), dec("-0.03"), None, CommissionRounding::HalfUp),
            Err(MoneyError {
                field: MoneyField::Commission
            })
        );
    }

    #[test]
    fn percentage_commission_rounds_once() {
        assert_eq!(
            commission_for_percentage(dec("100.0000"), dec("0.03"), CommissionRounding::HalfUp)
                .expect("valid"),
            dec("3.0000")
        );
        assert_eq!(
            commission_for_percentage(dec("33.3333"), dec("0.0299"), CommissionRounding::HalfUp)
                .expect("valid"),
            dec("0.9967")
        );
    }
}

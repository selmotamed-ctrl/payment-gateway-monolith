//! Statement rows and their classification.
//!
//! Port of `core-back/engine/reconciliation/StatementIngestor.ts`: `StatementRowType`,
//! `detectRowType`, `StatementRow`, `ReconciliationResult` and the row normalisation of
//! `normalizeRow` (references, amount, fee, currency, date, type).
//!
//! The TS stores money as a four-decimal BigInt (`Money`). [`StatementLine`] keeps the
//! [`rust_decimal::Decimal`] and exposes [`StatementLine::amount_minor`] for the BigInt value and
//! [`StatementLine::statement_amount_text`] for the `moneyToString` column representation.

#![forbid(unsafe_code)]

use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

use crate::amount::{amount_minor, format_amount, validate_currency_code, ReconError};

/// `StatementRowType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum StatementRowType {
    Settlement,
    Chargeback,
    Fee,
    Reversal,
    Unknown,
}

impl StatementRowType {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Settlement => "SETTLEMENT",
            Self::Chargeback => "CHARGEBACK",
            Self::Fee => "FEE",
            Self::Reversal => "REVERSAL",
            Self::Unknown => "UNKNOWN",
        }
    }
}

/// `detectRowType`: the first matching family wins, in the TS order.
#[must_use]
pub fn detect_row_type(raw: Option<&str>) -> StatementRowType {
    let value = raw.unwrap_or("").trim().to_ascii_uppercase();
    if value.contains("CHARGEBACK") || value.contains("CHARGE_BACK") || value.contains("DEBIT") {
        return StatementRowType::Chargeback;
    }
    if value.contains("REVERSAL") || value.contains("REFUND") {
        return StatementRowType::Reversal;
    }
    if value.contains("FEE") {
        return StatementRowType::Fee;
    }
    if value.contains("SETTLE") || value.contains("PAYMENT") || value.contains("CREDIT") {
        return StatementRowType::Settlement;
    }
    StatementRowType::Unknown
}

/// `ReconciliationResult`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ReconciliationResult {
    Matched,
    AmountMismatch,
    MissingAtGateway,
    MissingLocally,
    Duplicate,
}

impl ReconciliationResult {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Matched => "MATCHED",
            Self::AmountMismatch => "AMOUNT_MISMATCH",
            Self::MissingAtGateway => "MISSING_AT_GATEWAY",
            Self::MissingLocally => "MISSING_LOCALLY",
            Self::Duplicate => "DUPLICATE",
        }
    }

    /// The matching outcome for an amount comparison (`expectedAmount === row.amount`).
    #[must_use]
    pub fn for_amounts(expected: Decimal, statement: Decimal) -> Self {
        if expected == statement {
            Self::Matched
        } else {
            Self::AmountMismatch
        }
    }
}

/// One normalised statement line (`StatementRow`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatementLine {
    pub our_reference: Option<String>,
    pub provider_reference: Option<String>,
    pub batch_reference: Option<String>,
    pub amount: Decimal,
    pub fee: Decimal,
    pub currency: Option<String>,
    pub occurred_on: Option<NaiveDate>,
    pub row_type: StatementRowType,
}

impl StatementLine {
    #[must_use]
    pub fn new(amount: Decimal, fee: Decimal) -> Self {
        Self {
            our_reference: None,
            provider_reference: None,
            batch_reference: None,
            amount,
            fee,
            currency: None,
            occurred_on: None,
            row_type: StatementRowType::Unknown,
        }
    }

    /// An all-zero line (a statement row without an amount cell).
    #[must_use]
    pub fn zero() -> Self {
        Self::new(Decimal::ZERO, Decimal::ZERO)
    }

    #[must_use]
    pub fn with_our_reference(mut self, reference: impl Into<String>) -> Self {
        self.our_reference = Some(reference.into());
        self
    }

    #[must_use]
    pub fn with_provider_reference(mut self, reference: impl Into<String>) -> Self {
        self.provider_reference = Some(reference.into());
        self
    }

    #[must_use]
    pub fn with_batch_reference(mut self, reference: impl Into<String>) -> Self {
        self.batch_reference = Some(reference.into());
        self
    }

    #[must_use]
    pub fn with_currency(mut self, currency: impl Into<String>) -> Self {
        self.currency = Some(currency.into());
        self
    }

    #[must_use]
    pub fn with_occurred_on(mut self, date: NaiveDate) -> Self {
        self.occurred_on = Some(date);
        self
    }

    #[must_use]
    pub fn with_row_type(mut self, row_type: StatementRowType) -> Self {
        self.row_type = row_type;
        self
    }

    /// `moneyToString(row.amount)` for `reconciliation_items.statement_amount`.
    #[must_use]
    pub fn statement_amount_text(&self) -> String {
        format_amount(self.amount)
    }

    /// `moneyToString(row.fee)` for `reconciliation_items.statement_fee`.
    #[must_use]
    pub fn statement_fee_text(&self) -> String {
        format_amount(self.fee)
    }

    /// The BigInt minor-unit value.
    pub fn amount_minor(&self) -> Result<i128, ReconError> {
        amount_minor(self.amount)
    }

    /// `normalizeRow`: the row currency is upper-cased; a blank cell falls back to the source.
    #[must_use]
    pub fn normalised_currency(&self, source_currency: Option<&str>) -> Option<String> {
        match self
            .currency
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            Some(value) => Some(value.to_ascii_uppercase()),
            None => source_currency.map(str::to_owned),
        }
    }

    /// The de-duplication key of `matchStatement`:
    /// `ourReference ?? providerReference ?? batchReference ?? "${amountMinor}|${occurredAt}"`.
    #[must_use]
    pub fn dedupe_key(&self) -> String {
        if let Some(reference) = self
            .our_reference
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            return reference.to_owned();
        }
        if let Some(reference) = self
            .provider_reference
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            return reference.to_owned();
        }
        if let Some(reference) = self
            .batch_reference
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            return reference.to_owned();
        }
        let amount = self
            .amount_minor()
            .map_or_else(|_| self.amount.to_string(), |minor| minor.to_string());
        let occurred = self
            .occurred_on
            .map_or_else(String::new, |date| format!("{date}T00:00:00.000Z"));
        format!("{amount}|{occurred}")
    }
}

/// Validate the source-level currency (`StatementParserConfig.currency`).
pub fn parse_source_currency(raw: Option<&str>) -> Result<Option<String>, ReconError> {
    match raw.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => validate_currency_code(value).map(Some),
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use rust_decimal::Decimal;

    use super::*;
    use crate::amount::parse_amount;

    #[test]
    fn row_type_detection_matches_the_ts_order() {
        assert_eq!(
            detect_row_type(Some("chargeback debit")),
            StatementRowType::Chargeback
        );
        assert_eq!(
            detect_row_type(Some("charge_back")),
            StatementRowType::Chargeback
        );
        assert_eq!(detect_row_type(Some("refund")), StatementRowType::Reversal);
        assert_eq!(detect_row_type(Some("gateway fee")), StatementRowType::Fee);
        assert_eq!(
            detect_row_type(Some("settlement")),
            StatementRowType::Settlement
        );
        assert_eq!(
            detect_row_type(Some("payment")),
            StatementRowType::Settlement
        );
        assert_eq!(
            detect_row_type(Some("credit")),
            StatementRowType::Settlement
        );
        assert_eq!(detect_row_type(Some("")), StatementRowType::Unknown);
        assert_eq!(detect_row_type(None), StatementRowType::Unknown);
        // DEBIT dominates FEE because chargeback is tested first.
        assert_eq!(
            detect_row_type(Some("debit fee")),
            StatementRowType::Chargeback
        );
    }

    #[test]
    fn dedupe_key_prefers_references_then_amount() {
        let date = NaiveDate::from_ymd_opt(2026, 11, 1).expect("date");
        let line = StatementLine::new(parse_amount("10").expect("amount"), Decimal::ZERO)
            .with_provider_reference("GW-1")
            .with_batch_reference("BATCH-1")
            .with_occurred_on(date);
        assert_eq!(line.dedupe_key(), "GW-1");

        let line = line.with_our_reference("PAY-1");
        assert_eq!(line.dedupe_key(), "PAY-1");

        let no_references = StatementLine::new(parse_amount("10").expect("amount"), Decimal::ZERO)
            .with_occurred_on(date);
        assert_eq!(
            no_references.dedupe_key(),
            "100000|2026-11-01T00:00:00.000Z"
        );

        let without_date = StatementLine::new(parse_amount("-2.5").expect("amount"), Decimal::ZERO);
        assert_eq!(without_date.dedupe_key(), "-25000|");
    }

    #[test]
    fn normalisation_and_text_forms() {
        let line = StatementLine::new(
            parse_amount("1250.00").expect("amount"),
            parse_amount("12.5").expect("fee"),
        )
        .with_currency("lyd");
        assert_eq!(line.normalised_currency(None).as_deref(), Some("LYD"));
        assert_eq!(
            line.normalised_currency(Some("USD")).as_deref(),
            Some("LYD")
        );
        let without = StatementLine::new(parse_amount("1").expect("amount"), Decimal::ZERO);
        assert_eq!(
            without.normalised_currency(Some("USD")).as_deref(),
            Some("USD")
        );
        assert_eq!(without.normalised_currency(None), None);
        assert_eq!(line.statement_amount_text(), "1250.0000");
        assert_eq!(line.statement_fee_text(), "12.5000");
        assert_eq!(line.amount_minor().expect("minor"), 12_500_000);
    }

    #[test]
    fn result_for_amounts_is_the_ts_comparison() {
        let ten = parse_amount("10").expect("amount");
        assert_eq!(
            ReconciliationResult::for_amounts(ten, ten),
            ReconciliationResult::Matched
        );
        assert_eq!(
            ReconciliationResult::for_amounts(ten, Decimal::ZERO),
            ReconciliationResult::AmountMismatch
        );
        assert_eq!(ReconciliationResult::Duplicate.as_str(), "DUPLICATE");
    }

    #[test]
    fn source_currency_is_validated() {
        assert_eq!(
            parse_source_currency(Some("lyd")).expect("ok"),
            Some("LYD".to_owned())
        );
        assert_eq!(parse_source_currency(Some(" ")).expect("ok"), None);
        assert_eq!(parse_source_currency(None).expect("ok"), None);
        assert!(parse_source_currency(Some("LY")).is_err());
    }
}

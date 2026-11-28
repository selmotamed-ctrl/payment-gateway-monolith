//! Journal templates, the chart-of-accounts vocabulary and the posting scenarios.
//!
//! Ports: `core-back/engine/ledger/LedgerPoster.ts`
//!
//! - `LedgerDirection` (`:19`), `LedgerLineTemplate`/`JournalTemplate` (`:140-151`),
//! - `LedgerAccountType` (`:6-17`),
//! - `LedgerScenario`/`LedgerScenarioStage` (`:204-231`),
//! - `LedgerPoster.validateTemplate` (`:1054-1076`).
//!
//! The scenario builders themselves are called by the engine (chapter 2 §14); this module owns
//! their vocabulary and the invariant every posting must satisfy before a row is written.

use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Port of `LedgerDirection` (`LedgerPoster.ts:19`): the sign of a journal line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Direction {
    Debit,
    Credit,
}

impl Direction {
    /// The wire/database text (`"DEBIT"` / `"CREDIT"`).
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Debit => "DEBIT",
            Self::Credit => "CREDIT",
        }
    }

    /// Parses the wire/database text; anything else is `None` (never a default).
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_uppercase().as_str() {
            "DEBIT" => Some(Self::Debit),
            "CREDIT" => Some(Self::Credit),
            _ => None,
        }
    }
}

impl std::fmt::Display for Direction {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Port of `LedgerAccountType` (`LedgerPoster.ts:6-17`): the chart of accounts.
///
/// The scoping predicates mirror `ACCOUNT_SCOPING` (`LedgerPoster.ts:316-328`) and the
/// natural-sign/balance-guard tables in `shardRouting.ts:35-45`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AccountType {
    Treasury,
    GatewayClearing,
    MerchantWallet,
    PlatformIncome,
    ProviderFeeExpense,
    GatewayFeeExpense,
    GatewayFeeAccrual,
    CommissionReceivable,
    AmlHold,
    ChargebackReserve,
    Suspense,
}

impl AccountType {
    /// The wire/database text of the account type.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Treasury => "TREASURY",
            Self::GatewayClearing => "GATEWAY_CLEARING",
            Self::MerchantWallet => "MERCHANT_WALLET",
            Self::PlatformIncome => "PLATFORM_INCOME",
            Self::ProviderFeeExpense => "PROVIDER_FEE_EXPENSE",
            Self::GatewayFeeExpense => "GATEWAY_FEE_EXPENSE",
            Self::GatewayFeeAccrual => "GATEWAY_FEE_ACCRUAL",
            Self::CommissionReceivable => "COMMISSION_RECEIVABLE",
            Self::AmlHold => "AML_HOLD",
            Self::ChargebackReserve => "CHARGEBACK_RESERVE",
            Self::Suspense => "SUSPENSE",
        }
    }

    /// Parses the wire/database text; unknown account types are rejected, never defaulted.
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_uppercase().as_str() {
            "TREASURY" => Some(Self::Treasury),
            "GATEWAY_CLEARING" => Some(Self::GatewayClearing),
            "MERCHANT_WALLET" => Some(Self::MerchantWallet),
            "PLATFORM_INCOME" => Some(Self::PlatformIncome),
            "PROVIDER_FEE_EXPENSE" => Some(Self::ProviderFeeExpense),
            "GATEWAY_FEE_EXPENSE" => Some(Self::GatewayFeeExpense),
            "GATEWAY_FEE_ACCRUAL" => Some(Self::GatewayFeeAccrual),
            "COMMISSION_RECEIVABLE" => Some(Self::CommissionReceivable),
            "AML_HOLD" => Some(Self::AmlHold),
            "CHARGEBACK_RESERVE" => Some(Self::ChargebackReserve),
            "SUSPENSE" => Some(Self::Suspense),
            _ => None,
        }
    }

    /// Debit-natural accounts grow with a debit; every other type is credit-natural.
    /// Port of `DEBIT_NATURAL_ACCOUNT_TYPES` (`shardRouting.ts:38-45`).
    #[must_use]
    pub fn is_debit_natural(self) -> bool {
        matches!(
            self,
            Self::Treasury
                | Self::GatewayClearing
                | Self::CommissionReceivable
                | Self::ProviderFeeExpense
                | Self::GatewayFeeExpense
        )
    }

    /// The one balance-guarded account type (cash-out/chargeback overdraft checks).
    /// Port of `BALANCE_GUARDED_ACCOUNT_TYPES` (`shardRouting.ts:35-36`).
    #[must_use]
    pub fn is_balance_guarded(self) -> bool {
        matches!(self, Self::MerchantWallet)
    }

    /// Port of `ACCOUNT_SCOPING` (`LedgerPoster.ts:316-328`): the wallet belongs to one merchant.
    #[must_use]
    pub fn is_merchant_scoped(self) -> bool {
        matches!(self, Self::MerchantWallet)
    }

    /// Port of `ACCOUNT_SCOPING` (`LedgerPoster.ts:316-328`): clearing belongs to a gateway/env set.
    #[must_use]
    pub fn is_gateway_scoped(self) -> bool {
        matches!(self, Self::GatewayClearing)
    }
}

impl std::fmt::Display for AccountType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Port of `LedgerLineTemplate` (`LedgerPoster.ts:140-144`), with the account already resolved to
/// an id (the Rust poster resolves accounts before it builds the template).
#[derive(Debug, Clone, PartialEq)]
pub struct LedgerLineInput {
    /// The resolved `gl_accounts.id`.
    pub gl_account_id: Uuid,
    pub direction: Direction,
    /// Always a positive money value after validation; zero is only legal on an optional leg.
    pub amount: Decimal,
    /// `true`: a zero amount is omitted (the TS `optionalLine` convention for fees and
    /// commission). `false`: a zero amount is an error.
    pub optional: bool,
}

/// Port of `JournalTemplate` (`LedgerPoster.ts:146-151`) plus the currency the posting context
/// carries (`LedgerPostContext.currency`, strict-context mode requires it).
#[derive(Debug, Clone, PartialEq)]
pub struct JournalTemplate {
    /// `JournalRefType` text, e.g. `PAYMENT_ATTEMPT`.
    pub ref_type: String,
    /// The business reference; together with `ref_type` it makes the posting idempotent.
    pub ref_id: String,
    /// ISO-4217 code the accounts are resolved in.
    pub currency: String,
    pub description: Option<String>,
    pub lines: Vec<LedgerLineInput>,
}

/// One line that passed validation. Amounts are strictly positive and zero optional legs are
/// already gone.
///
/// `shard_id` is `0` until the line is routed: [`validate_template`] does not know account widths.
/// Call [`crate::shard::route_validated_lines`] (or compute [`crate::shard::route_line`] directly)
/// before folding. A *routed* wallet debit also lands on shard `0`, so the two states are only
/// distinguishable by call order, never by the value.
#[derive(Debug, Clone, PartialEq)]
pub struct ValidatedLine {
    pub gl_account_id: Uuid,
    pub direction: Direction,
    pub amount: Decimal,
    /// Assigned by [`crate::shard::route_validated_lines`]; `0` before routing.
    pub shard_id: u32,
}

/// The output of [`validate_template`]: the exact lines the poster may write.
#[derive(Debug, Clone, PartialEq)]
pub struct ValidatedTemplate {
    pub ref_type: String,
    pub ref_id: String,
    pub currency: String,
    pub description: Option<String>,
    pub lines: Vec<ValidatedLine>,
    /// Sum of the debit lines; equal to `credits` (exact decimal equality, no tolerance).
    pub debits: Decimal,
    pub credits: Decimal,
}

impl ValidatedTemplate {
    /// Number of lines that will be written (zero optional legs excluded).
    #[must_use]
    pub fn line_count(&self) -> usize {
        self.lines.len()
    }
}

/// Port of `TemplateError` behaviour from `validateTemplate` (`LedgerPoster.ts:1054-1076`).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TemplateError {
    #[error("journal template requires a reference type and a reference id")]
    MissingReference,
    #[error("journal template requires a currency")]
    MissingCurrency,
    #[error("journal template requires at least one line")]
    EmptyLines,
    #[error("journal line {index} amount must not be negative")]
    NegativeAmount { index: usize },
    #[error("journal line {index} amount must be greater than zero")]
    ZeroAmount { index: usize },
    #[error("journal template has no debit line")]
    NoDebitLine,
    #[error("journal template has no credit line")]
    NoCreditLine,
    #[error("journal debits {debits} must equal credits {credits} and be greater than zero")]
    Unbalanced { debits: Decimal, credits: Decimal },
}

/// Port of `LedgerPoster.validateTemplate` (`LedgerPoster.ts:1054-1076`):
///
/// - the reference and the currency must be present,
/// - at least one line must survive,
/// - every amount must be greater than zero (a zero *optional* leg is omitted, a zero required
///   leg is an error, a negative amount is always an error),
/// - there must be at least one debit and one credit,
/// - `sum(debits) == sum(credits)` exactly (decimal equality; `0.1000` equals `0.10`).
///
/// The TS code performs the last two checks as one `debits !== credits || debits <= 0` test; the
/// split variants here only make the failure reason explicit.
///
/// A template that legitimately has no lines (a zero-variance `FEE_VARIANCE_TRUE_UP`) is never
/// validated: its caller skips the posting (`postPaymentConfirmation` returns `null` for it).
pub fn validate_template(template: &JournalTemplate) -> Result<ValidatedTemplate, TemplateError> {
    if template.ref_type.trim().is_empty() || template.ref_id.trim().is_empty() {
        return Err(TemplateError::MissingReference);
    }
    if template.currency.trim().is_empty() {
        return Err(TemplateError::MissingCurrency);
    }
    if template.lines.is_empty() {
        return Err(TemplateError::EmptyLines);
    }

    let mut lines = Vec::with_capacity(template.lines.len());
    let mut debits = Decimal::ZERO;
    let mut credits = Decimal::ZERO;
    let mut has_debit = false;
    let mut has_credit = false;

    for (index, line) in template.lines.iter().enumerate() {
        if line.amount < Decimal::ZERO {
            return Err(TemplateError::NegativeAmount { index });
        }
        if line.amount.is_zero() {
            if line.optional {
                continue;
            }
            return Err(TemplateError::ZeroAmount { index });
        }
        match line.direction {
            Direction::Debit => {
                debits += line.amount;
                has_debit = true;
            }
            Direction::Credit => {
                credits += line.amount;
                has_credit = true;
            }
        }
        lines.push(ValidatedLine {
            gl_account_id: line.gl_account_id,
            direction: line.direction,
            amount: line.amount,
            shard_id: 0,
        });
    }

    if lines.is_empty() {
        return Err(TemplateError::EmptyLines);
    }
    if !has_debit {
        return Err(TemplateError::NoDebitLine);
    }
    if !has_credit {
        return Err(TemplateError::NoCreditLine);
    }
    if debits != credits || debits <= Decimal::ZERO {
        return Err(TemplateError::Unbalanced { debits, credits });
    }

    Ok(ValidatedTemplate {
        ref_type: template.ref_type.clone(),
        ref_id: template.ref_id.clone(),
        currency: template.currency.clone(),
        description: template.description.clone(),
        lines,
        debits,
        credits,
    })
}

/// Port of `LedgerScenario` (`LedgerPoster.ts:204-222`).
///
/// The TypeScript enum is the authority: 18 entries. `project-design/parts/01-core-back/03-ledger.md`
/// §3.3 tabulates 17 base scenarios plus four stage variants because it predates `SUSPENSE_REFUND`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum LedgerScenario {
    PlatformHeldConfirmation,
    PlatformHeldFeeAccrual,
    SettlementSweep,
    FeeVarianceTrueUp,
    PayerSurchargeConfirmation,
    SplitSurchargeConfirmation,
    MerchantDirectConfirmation,
    AmlHoldAndRelease,
    Cashout,
    FullRefund,
    ChargebackReserveAndLost,
    AmlVoid,
    ChargebackWon,
    InternalConfirmation,
    InternalRefund,
    ChargebackInsufficient,
    SuspenseSettlement,
    SuspenseRefund,
}

impl LedgerScenario {
    /// Every scenario, in the order of the TypeScript union.
    pub const ALL: [Self; 18] = [
        Self::PlatformHeldConfirmation,
        Self::PlatformHeldFeeAccrual,
        Self::SettlementSweep,
        Self::FeeVarianceTrueUp,
        Self::PayerSurchargeConfirmation,
        Self::SplitSurchargeConfirmation,
        Self::MerchantDirectConfirmation,
        Self::AmlHoldAndRelease,
        Self::Cashout,
        Self::FullRefund,
        Self::ChargebackReserveAndLost,
        Self::AmlVoid,
        Self::ChargebackWon,
        Self::InternalConfirmation,
        Self::InternalRefund,
        Self::ChargebackInsufficient,
        Self::SuspenseSettlement,
        Self::SuspenseRefund,
    ];

    /// The scenario name used by audit rows, logs and the scenario registry.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PlatformHeldConfirmation => "PLATFORM_HELD_CONFIRMATION",
            Self::PlatformHeldFeeAccrual => "PLATFORM_HELD_FEE_ACCRUAL",
            Self::SettlementSweep => "SETTLEMENT_SWEEP",
            Self::FeeVarianceTrueUp => "FEE_VARIANCE_TRUE_UP",
            Self::PayerSurchargeConfirmation => "PAYER_SURCHARGE_CONFIRMATION",
            Self::SplitSurchargeConfirmation => "SPLIT_SURCHARGE_CONFIRMATION",
            Self::MerchantDirectConfirmation => "MERCHANT_DIRECT_CONFIRMATION",
            Self::AmlHoldAndRelease => "AML_HOLD_AND_RELEASE",
            Self::Cashout => "CASHOUT",
            Self::FullRefund => "FULL_REFUND",
            Self::ChargebackReserveAndLost => "CHARGEBACK_RESERVE_AND_LOST",
            Self::AmlVoid => "AML_VOID",
            Self::ChargebackWon => "CHARGEBACK_WON",
            Self::InternalConfirmation => "INTERNAL_CONFIRMATION",
            Self::InternalRefund => "INTERNAL_REFUND",
            Self::ChargebackInsufficient => "CHARGEBACK_INSUFFICIENT",
            Self::SuspenseSettlement => "SUSPENSE_SETTLEMENT",
            Self::SuspenseRefund => "SUSPENSE_REFUND",
        }
    }

    /// Parses a scenario name; unknown names are rejected, never defaulted.
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_uppercase().as_str() {
            "PLATFORM_HELD_CONFIRMATION" => Some(Self::PlatformHeldConfirmation),
            "PLATFORM_HELD_FEE_ACCRUAL" => Some(Self::PlatformHeldFeeAccrual),
            "SETTLEMENT_SWEEP" => Some(Self::SettlementSweep),
            "FEE_VARIANCE_TRUE_UP" => Some(Self::FeeVarianceTrueUp),
            "PAYER_SURCHARGE_CONFIRMATION" => Some(Self::PayerSurchargeConfirmation),
            "SPLIT_SURCHARGE_CONFIRMATION" => Some(Self::SplitSurchargeConfirmation),
            "MERCHANT_DIRECT_CONFIRMATION" => Some(Self::MerchantDirectConfirmation),
            "AML_HOLD_AND_RELEASE" => Some(Self::AmlHoldAndRelease),
            "CASHOUT" => Some(Self::Cashout),
            "FULL_REFUND" => Some(Self::FullRefund),
            "CHARGEBACK_RESERVE_AND_LOST" => Some(Self::ChargebackReserveAndLost),
            "AML_VOID" => Some(Self::AmlVoid),
            "CHARGEBACK_WON" => Some(Self::ChargebackWon),
            "INTERNAL_CONFIRMATION" => Some(Self::InternalConfirmation),
            "INTERNAL_REFUND" => Some(Self::InternalRefund),
            "CHARGEBACK_INSUFFICIENT" => Some(Self::ChargebackInsufficient),
            "SUSPENSE_SETTLEMENT" => Some(Self::SuspenseSettlement),
            "SUSPENSE_REFUND" => Some(Self::SuspenseRefund),
            _ => None,
        }
    }
}

impl std::fmt::Display for LedgerScenario {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Port of `LedgerScenarioStage` (`LedgerPoster.ts:224-231`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum LedgerScenarioStage {
    Hold,
    Release,
    Confirm,
    Netting,
    Refund,
    Reserve,
    Lost,
}

impl LedgerScenarioStage {
    /// The stage name used by callers and audit rows.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Hold => "HOLD",
            Self::Release => "RELEASE",
            Self::Confirm => "CONFIRM",
            Self::Netting => "NETTING",
            Self::Refund => "REFUND",
            Self::Reserve => "RESERVE",
            Self::Lost => "LOST",
        }
    }

    /// Parses a stage name; unknown names are rejected, never defaulted.
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_uppercase().as_str() {
            "HOLD" => Some(Self::Hold),
            "RELEASE" => Some(Self::Release),
            "CONFIRM" => Some(Self::Confirm),
            "NETTING" => Some(Self::Netting),
            "REFUND" => Some(Self::Refund),
            "RESERVE" => Some(Self::Reserve),
            "LOST" => Some(Self::Lost),
            _ => None,
        }
    }
}

impl std::fmt::Display for LedgerScenarioStage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;
    use uuid::Uuid;

    fn dec(raw: &str) -> Decimal {
        Decimal::from_str(raw).expect("test decimal")
    }

    fn line(account: u128, direction: Direction, amount: &str, optional: bool) -> LedgerLineInput {
        LedgerLineInput {
            gl_account_id: Uuid::from_u128(account),
            direction,
            amount: dec(amount),
            optional,
        }
    }

    fn template(lines: Vec<LedgerLineInput>) -> JournalTemplate {
        JournalTemplate {
            ref_type: "PAYMENT_ATTEMPT".to_owned(),
            ref_id: "attempt-1".to_owned(),
            currency: "LYD".to_owned(),
            description: Some("test posting".to_owned()),
            lines,
        }
    }

    /// The worked `PLATFORM_HELD_CONFIRMATION` entry (ledger design §3.3, row 1).
    fn platform_held_lines() -> Vec<LedgerLineInput> {
        vec![
            line(1, Direction::Debit, "99.0000", false),
            line(2, Direction::Debit, "1.0000", false),
            line(3, Direction::Credit, "97.0000", false),
            line(4, Direction::Credit, "3.0000", false),
        ]
    }

    #[test]
    fn validates_the_platform_held_confirmation_shape() {
        let validated =
            validate_template(&template(platform_held_lines())).expect("valid template");
        assert_eq!(validated.debits, dec("100"));
        assert_eq!(validated.credits, dec("100"));
        assert_eq!(validated.line_count(), 4);
        assert_eq!(validated.ref_type, "PAYMENT_ATTEMPT");
        assert_eq!(validated.ref_id, "attempt-1");
        assert_eq!(validated.currency, "LYD");
        assert_eq!(validated.description.as_deref(), Some("test posting"));
        // Validation does not route: every shard is left at zero for the router to fill.
        assert!(validated.lines.iter().all(|line| line.shard_id == 0));
    }

    #[test]
    fn omits_zero_optional_legs() {
        let mut lines = platform_held_lines();
        lines.push(line(5, Direction::Credit, "0.0000", true));
        let validated = validate_template(&template(lines)).expect("valid template");
        assert_eq!(validated.line_count(), 4);
        assert_eq!(validated.debits, dec("100"));
        assert_eq!(validated.credits, dec("100"));
    }

    #[test]
    fn rejects_a_zero_required_leg() {
        let mut lines = platform_held_lines();
        lines.push(line(5, Direction::Credit, "0.0000", false));
        assert_eq!(
            validate_template(&template(lines)),
            Err(TemplateError::ZeroAmount { index: 4 })
        );
    }

    #[test]
    fn rejects_a_negative_leg_even_when_optional() {
        let mut lines = platform_held_lines();
        lines.push(line(5, Direction::Credit, "-0.0001", true));
        assert_eq!(
            validate_template(&template(lines)),
            Err(TemplateError::NegativeAmount { index: 4 })
        );
    }

    #[test]
    fn rejects_an_empty_template() {
        assert_eq!(
            validate_template(&template(Vec::new())),
            Err(TemplateError::EmptyLines)
        );
    }

    #[test]
    fn rejects_a_template_of_only_omitted_optional_legs() {
        let lines = vec![line(1, Direction::Debit, "0", true)];
        assert_eq!(
            validate_template(&template(lines)),
            Err(TemplateError::EmptyLines)
        );
    }

    #[test]
    fn rejects_a_missing_reference() {
        let mut journal = template(platform_held_lines());
        journal.ref_id = "   ".to_owned();
        assert_eq!(
            validate_template(&journal),
            Err(TemplateError::MissingReference)
        );
        journal.ref_id = "attempt-1".to_owned();
        journal.ref_type = String::new();
        assert_eq!(
            validate_template(&journal),
            Err(TemplateError::MissingReference)
        );
    }

    #[test]
    fn rejects_a_missing_currency() {
        let mut journal = template(platform_held_lines());
        journal.currency = " ".to_owned();
        assert_eq!(
            validate_template(&journal),
            Err(TemplateError::MissingCurrency)
        );
    }

    #[test]
    fn rejects_an_unbalanced_template_and_reports_both_sides() {
        let lines = vec![
            line(1, Direction::Debit, "100.0000", false),
            line(2, Direction::Credit, "99.9999", false),
        ];
        let error = validate_template(&template(lines)).expect_err("must not balance");
        assert_eq!(
            error,
            TemplateError::Unbalanced {
                debits: dec("100.0000"),
                credits: dec("99.9999"),
            }
        );
    }

    #[test]
    fn accepts_equal_sums_written_with_different_scales() {
        let lines = vec![
            line(1, Direction::Debit, "0.1000", false),
            line(2, Direction::Credit, "0.10", false),
        ];
        let validated = validate_template(&template(lines)).expect("exact decimal equality");
        assert_eq!(validated.debits, dec("0.1"));
        assert_eq!(validated.credits, dec("0.1"));
    }

    #[test]
    fn requires_a_debit_line() {
        let lines = vec![line(1, Direction::Credit, "10.0000", false)];
        assert_eq!(
            validate_template(&template(lines)),
            Err(TemplateError::NoDebitLine)
        );
    }

    #[test]
    fn requires_a_credit_line() {
        let lines = vec![line(1, Direction::Debit, "10.0000", false)];
        assert_eq!(
            validate_template(&template(lines)),
            Err(TemplateError::NoCreditLine)
        );
    }

    #[test]
    fn direction_round_trips() {
        for direction in [Direction::Debit, Direction::Credit] {
            assert_eq!(Direction::parse(direction.as_str()), Some(direction));
            assert_eq!(direction.to_string(), direction.as_str());
        }
        assert_eq!(Direction::parse(" debit "), Some(Direction::Debit));
        assert_eq!(Direction::parse("CREDITX"), None);
        assert_eq!(Direction::parse(""), None);
    }

    #[test]
    fn account_types_round_trip_and_keep_their_tables() {
        let all = [
            AccountType::Treasury,
            AccountType::GatewayClearing,
            AccountType::MerchantWallet,
            AccountType::PlatformIncome,
            AccountType::ProviderFeeExpense,
            AccountType::GatewayFeeExpense,
            AccountType::GatewayFeeAccrual,
            AccountType::CommissionReceivable,
            AccountType::AmlHold,
            AccountType::ChargebackReserve,
            AccountType::Suspense,
        ];
        for account_type in all {
            assert_eq!(
                AccountType::parse(account_type.as_str()),
                Some(account_type)
            );
            assert_eq!(account_type.to_string(), account_type.as_str());
        }
        assert_eq!(all.len(), 11);
        assert_eq!(
            AccountType::parse("merchant_wallet"),
            Some(AccountType::MerchantWallet)
        );
        assert_eq!(AccountType::parse("CASH"), None);

        assert!(AccountType::Treasury.is_debit_natural());
        assert!(AccountType::CommissionReceivable.is_debit_natural());
        assert!(!AccountType::MerchantWallet.is_debit_natural());
        assert!(!AccountType::Suspense.is_debit_natural());
        assert!(AccountType::MerchantWallet.is_balance_guarded());
        assert!(!AccountType::Treasury.is_balance_guarded());
        assert!(AccountType::MerchantWallet.is_merchant_scoped());
        assert!(AccountType::GatewayClearing.is_gateway_scoped());
        assert!(!AccountType::Treasury.is_merchant_scoped());
        assert!(!AccountType::Treasury.is_gateway_scoped());
    }

    #[test]
    fn every_typescript_scenario_is_present_and_parses_back() {
        assert_eq!(LedgerScenario::ALL.len(), 18);
        let mut seen = Vec::new();
        for scenario in LedgerScenario::ALL {
            let name = scenario.as_str();
            assert_eq!(LedgerScenario::parse(name), Some(scenario));
            assert!(!seen.contains(&name), "duplicate scenario name {name}");
            seen.push(name);
            assert_eq!(scenario.to_string(), name);
        }
        assert!(seen.contains(&"SUSPENSE_REFUND"));
        assert_eq!(LedgerScenario::parse("PAYMENT_CONFIRMATION"), None);
        assert_eq!(LedgerScenario::parse(""), None);
    }

    #[test]
    fn stages_round_trip() {
        let all = [
            LedgerScenarioStage::Hold,
            LedgerScenarioStage::Release,
            LedgerScenarioStage::Confirm,
            LedgerScenarioStage::Netting,
            LedgerScenarioStage::Refund,
            LedgerScenarioStage::Reserve,
            LedgerScenarioStage::Lost,
        ];
        for stage in all {
            assert_eq!(LedgerScenarioStage::parse(stage.as_str()), Some(stage));
            assert_eq!(stage.to_string(), stage.as_str());
        }
        assert_eq!(all.len(), 7);
        assert_eq!(LedgerScenarioStage::parse("SETTLE"), None);
    }
}

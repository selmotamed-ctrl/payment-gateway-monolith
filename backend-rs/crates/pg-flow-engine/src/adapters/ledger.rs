//! [`LedgerPort`] on `pg-ledger`.
//!
//! Port of `engine/ledger/LedgerPoster.ts` for the scenarios the flow engine posts:
//!
//! - `post_confirmation` maps a [`ConfirmationPosting`] to `buildPaymentConfirmationTemplate`
//!   (`PLATFORM_HELD_CONFIRMATION`, `PLATFORM_HELD_FEE_ACCRUAL`, `PAYER_SURCHARGE_CONFIRMATION`,
//!   `SPLIT_SURCHARGE_CONFIRMATION`, `INTERNAL_CONFIRMATION`, `MERCHANT_DIRECT_CONFIRMATION`);
//! - `post_scenario` maps a [`ScenarioPosting`] to `buildLedgerTemplate` (AML hold/release, void,
//!   refunds, settlement sweep, chargebacks, suspense, ...).
//!
//! Every write joins the supplied [`PgConnection`]: the `*_on` helpers are the transaction-aware
//! form the engine's finalize path calls inside the slot commit transaction.
//!
//! `ConfirmationPosting`/`ScenarioPosting` cannot carry every optional fee of the TypeScript input
//! (provider fee, settled amount, variance), so the adapter uses only the fields the port carries
//! and omits an optional leg whose amount is zero, exactly like the TS `optionalLine` helper.

use std::sync::Arc;

use async_trait::async_trait;
use pg_domain_ledger::{AccountType, Direction, LedgerScenario, LedgerScenarioStage};
use pg_ledger::{
    post_entry, AccountCache, AccountSelector, JournalTemplate, LedgerError, LedgerLineTemplate,
    PostContext, PostOptions,
};
use rust_decimal::Decimal;
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

use crate::error::{codes, EngineError};
use crate::ports::{ConfirmationPosting, Environment, LedgerPort, PostedEntry, ScenarioPosting};

/// What one scenario builder produced.
#[derive(Debug, Clone)]
pub enum ScenarioTemplate {
    /// A journal to post.
    Post(JournalTemplate),
    /// The TS builder legitimately produced no line (a zero-commission merchant-direct
    /// confirmation), so nothing is booked.
    NoPosting,
}

/// [`LedgerPort`] on the core database.
#[derive(Clone)]
pub struct PgLedgerAdapter {
    pool: PgPool,
    cache: Option<Arc<AccountCache>>,
}

impl std::fmt::Debug for PgLedgerAdapter {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PgLedgerAdapter")
            .field("cache", &self.cache.is_some())
            .finish_non_exhaustive()
    }
}

impl PgLedgerAdapter {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool, cache: None }
    }

    /// Shares the bounded scoped-account cache with the rest of the process.
    #[must_use]
    pub fn with_account_cache(mut self, cache: Arc<AccountCache>) -> Self {
        self.cache = Some(cache);
        self
    }

    /// Posts a confirmation in the caller's transaction.
    pub async fn post_confirmation_on(
        &self,
        conn: &mut PgConnection,
        posting: &ConfirmationPosting,
    ) -> Result<PostedEntry, EngineError> {
        match confirmation_template(posting)? {
            ScenarioTemplate::Post(template) => {
                let context = context_of(
                    posting.merchant_id.as_deref(),
                    posting.gateway_id.as_deref(),
                    posting.credential_set_id.as_deref(),
                    posting.env,
                    &posting.currency,
                )?;
                post_template(conn, &template, context, self.cache.as_deref()).await
            }
            ScenarioTemplate::NoPosting => Err(EngineError::new(
                409,
                "MERCHANT_DIRECT_ZERO_COMMISSION",
                "A merchant-direct confirmation with a zero commission has no journal to post; \
                 the caller must skip the ledger step (TS `postPaymentConfirmation` returns null)",
            )),
        }
    }

    /// Posts a scenario in the caller's transaction.
    pub async fn post_scenario_on(
        &self,
        conn: &mut PgConnection,
        posting: &ScenarioPosting,
    ) -> Result<PostedEntry, EngineError> {
        post_scenario_in_tx(conn, posting, self.cache.as_deref()).await
    }
}

/// `buildPaymentConfirmationTemplate` (`LedgerPoster.ts:702-731`).
pub fn confirmation_template(
    posting: &ConfirmationPosting,
) -> Result<ScenarioTemplate, EngineError> {
    let amount = positive(posting.amount, "Transaction amount")?;
    let commission = non_negative(posting.commission_amount, "Commission amount")?;
    let merchant = non_negative(posting.merchant_amount, "Merchant amount")?;
    let surcharge = non_negative(posting.surcharge_amount, "Payer surcharge amount")?;

    let scenario = posting.scenario;
    let gateway_fee = posting
        .gateway_fee_amount
        .map(|value| non_negative(value, "Gateway fee amount"))
        .transpose()?;
    let provider_fee = posting
        .provider_fee_amount
        .map(|value| non_negative(value, "Provider fee amount"))
        .transpose()?;
    let mut lines: Vec<LedgerLineTemplate> = Vec::new();
    let (ref_type, description) = match scenario {
        LedgerScenario::InternalConfirmation => {
            push(&mut lines, Direction::Debit, amount, AccountType::Treasury);
            push_optional(
                &mut lines,
                Direction::Credit,
                merchant,
                AccountType::MerchantWallet,
            );
            push_optional(
                &mut lines,
                Direction::Credit,
                commission,
                AccountType::PlatformIncome,
            );
            (
                "PAYMENT_ATTEMPT",
                "NeomPay internal confirmation under INTERNAL-1",
            )
        }
        LedgerScenario::MerchantDirectConfirmation => {
            push_optional(
                &mut lines,
                Direction::Debit,
                commission,
                AccountType::CommissionReceivable,
            );
            push_optional(
                &mut lines,
                Direction::Credit,
                commission,
                AccountType::PlatformIncome,
            );
            if lines.is_empty() {
                return Ok(ScenarioTemplate::NoPosting);
            }
            (
                "PAYMENT_ATTEMPT",
                "Merchant-owned direct settlement commission recognition",
            )
        }
        LedgerScenario::PlatformHeldConfirmation => {
            let provider_fee = provider_fee.ok_or_else(|| missing_fee("Provider fee amount"))?;
            let treasury = amount - provider_fee;
            if treasury <= Decimal::ZERO {
                return Err(money_error(
                    "Provider fee exceeds the transaction amount; the treasury leg would not be positive",
                ));
            }
            push(
                &mut lines,
                Direction::Debit,
                treasury,
                AccountType::Treasury,
            );
            push_optional(
                &mut lines,
                Direction::Debit,
                provider_fee,
                AccountType::ProviderFeeExpense,
            );
            push_optional(
                &mut lines,
                Direction::Credit,
                merchant,
                AccountType::MerchantWallet,
            );
            push_optional(
                &mut lines,
                Direction::Credit,
                commission,
                AccountType::PlatformIncome,
            );
            (
                "PAYMENT_ATTEMPT",
                "Platform-held confirmation with fee deducted at source",
            )
        }
        LedgerScenario::PlatformHeldFeeAccrual => {
            let gateway_fee = gateway_fee.ok_or_else(|| missing_fee("Gateway fee amount"))?;
            push(
                &mut lines,
                Direction::Debit,
                amount,
                AccountType::GatewayClearing,
            );
            push_optional(
                &mut lines,
                Direction::Debit,
                gateway_fee,
                AccountType::GatewayFeeExpense,
            );
            push_optional(
                &mut lines,
                Direction::Credit,
                merchant,
                AccountType::MerchantWallet,
            );
            push_optional(
                &mut lines,
                Direction::Credit,
                commission,
                AccountType::PlatformIncome,
            );
            push_optional(
                &mut lines,
                Direction::Credit,
                gateway_fee,
                AccountType::GatewayFeeAccrual,
            );
            (
                "PAYMENT_ATTEMPT",
                "Platform-held confirmation with gateway fee accrual",
            )
        }
        LedgerScenario::PayerSurchargeConfirmation => {
            let gateway_fee = gateway_fee.ok_or_else(|| missing_fee("Gateway fee amount"))?;
            let charged = amount + surcharge;
            push(
                &mut lines,
                Direction::Debit,
                charged,
                AccountType::GatewayClearing,
            );
            push_optional(
                &mut lines,
                Direction::Debit,
                gateway_fee,
                AccountType::GatewayFeeExpense,
            );
            push(
                &mut lines,
                Direction::Credit,
                amount,
                AccountType::MerchantWallet,
            );
            push_optional(
                &mut lines,
                Direction::Credit,
                commission,
                AccountType::PlatformIncome,
            );
            push_optional(
                &mut lines,
                Direction::Credit,
                gateway_fee,
                AccountType::GatewayFeeAccrual,
            );
            (
                "PAYMENT_ATTEMPT",
                "Payment confirmation with payer surcharge",
            )
        }
        LedgerScenario::SplitSurchargeConfirmation => {
            let gateway_fee = gateway_fee.ok_or_else(|| missing_fee("Gateway fee amount"))?;
            let charged = amount + surcharge;
            push(
                &mut lines,
                Direction::Debit,
                charged,
                AccountType::GatewayClearing,
            );
            push_optional(
                &mut lines,
                Direction::Debit,
                gateway_fee,
                AccountType::GatewayFeeExpense,
            );
            push(
                &mut lines,
                Direction::Credit,
                merchant,
                AccountType::MerchantWallet,
            );
            push_optional(
                &mut lines,
                Direction::Credit,
                commission,
                AccountType::PlatformIncome,
            );
            push_optional(
                &mut lines,
                Direction::Credit,
                gateway_fee,
                AccountType::GatewayFeeAccrual,
            );
            (
                "PAYMENT_ATTEMPT",
                "Payment confirmation with a split fee bearer",
            )
        }
        _ => {
            return Err(EngineError::new(
                400,
                "INVALID_LEDGER_SCENARIO",
                "The confirmation posting mapped to a scenario that is not a payment confirmation",
            ))
        }
    };

    Ok(ScenarioTemplate::Post(
        JournalTemplate::new(
            ref_type,
            &posting.attempt_id,
            description,
            &posting.currency,
        )
        .with_lines(lines),
    ))
}

/// `buildLedgerTemplate` (`LedgerPoster.ts:338-700`) for the port's reduced input.
pub fn scenario_template(posting: &ScenarioPosting) -> Result<JournalTemplate, EngineError> {
    let amount = positive(posting.amount, "Transaction amount")?;
    let commission = non_negative(posting.commission_amount, "Commission amount")?;
    let merchant = non_negative(posting.merchant_amount, "Merchant amount")?;
    let stage = posting.stage;
    let reference = posting.ref_id.clone();
    let currency = posting.currency.clone();
    let mut lines: Vec<LedgerLineTemplate> = Vec::new();
    let (ref_type, description): (&str, &str) = match posting.scenario {
        LedgerScenario::PlatformHeldConfirmation => {
            let treasury = amount - commission;
            if treasury <= Decimal::ZERO {
                return Err(money_error(
                    "The commission exceeds the transaction amount; the treasury leg would not be positive",
                ));
            }
            push(
                &mut lines,
                Direction::Debit,
                treasury,
                AccountType::Treasury,
            );
            push(
                &mut lines,
                Direction::Credit,
                merchant,
                AccountType::MerchantWallet,
            );
            push_optional(
                &mut lines,
                Direction::Credit,
                commission,
                AccountType::PlatformIncome,
            );
            (
                "PAYMENT_ATTEMPT",
                "Platform-held confirmation with fee deducted at source",
            )
        }
        LedgerScenario::PlatformHeldFeeAccrual => {
            push(
                &mut lines,
                Direction::Debit,
                amount,
                AccountType::GatewayClearing,
            );
            push_optional(
                &mut lines,
                Direction::Credit,
                merchant,
                AccountType::MerchantWallet,
            );
            push_optional(
                &mut lines,
                Direction::Credit,
                commission,
                AccountType::PlatformIncome,
            );
            (
                "PAYMENT_ATTEMPT",
                "Platform-held confirmation with gateway fee accrual",
            )
        }
        LedgerScenario::SettlementSweep => {
            push(&mut lines, Direction::Debit, amount, AccountType::Treasury);
            push(
                &mut lines,
                Direction::Credit,
                amount,
                AccountType::GatewayClearing,
            );
            ("SETTLEMENT_SWEEP", "Gateway settlement sweep")
        }
        LedgerScenario::FeeVarianceTrueUp => {
            push(
                &mut lines,
                Direction::Debit,
                amount,
                AccountType::GatewayFeeExpense,
            );
            push(
                &mut lines,
                Direction::Credit,
                amount,
                AccountType::GatewayFeeAccrual,
            );
            ("FEE_VARIANCE", "Gateway settlement fee variance true-up")
        }
        LedgerScenario::PayerSurchargeConfirmation | LedgerScenario::SplitSurchargeConfirmation => {
            let surcharge = commission;
            let charged = amount + surcharge;
            push(
                &mut lines,
                Direction::Debit,
                charged,
                AccountType::GatewayClearing,
            );
            push(
                &mut lines,
                Direction::Credit,
                amount,
                AccountType::MerchantWallet,
            );
            push_optional(
                &mut lines,
                Direction::Credit,
                commission,
                AccountType::PlatformIncome,
            );
            let description = if posting.scenario == LedgerScenario::PayerSurchargeConfirmation {
                "Payment confirmation with payer surcharge"
            } else {
                "Payment confirmation with a split fee bearer"
            };
            ("PAYMENT_ATTEMPT", description)
        }
        LedgerScenario::MerchantDirectConfirmation => match stage {
            Some(LedgerScenarioStage::Refund) => {
                push_optional(
                    &mut lines,
                    Direction::Debit,
                    commission,
                    AccountType::PlatformIncome,
                );
                push_optional(
                    &mut lines,
                    Direction::Credit,
                    commission,
                    AccountType::CommissionReceivable,
                );
                (
                    "ADJUSTMENT",
                    "Merchant-direct commission reversal on refund",
                )
            }
            Some(LedgerScenarioStage::Netting) => {
                push_optional(
                    &mut lines,
                    Direction::Debit,
                    commission,
                    AccountType::MerchantWallet,
                );
                push_optional(
                    &mut lines,
                    Direction::Credit,
                    commission,
                    AccountType::CommissionReceivable,
                );
                ("COMMISSION_NETTING", "Merchant-direct commission netting")
            }
            _ => {
                push_optional(
                    &mut lines,
                    Direction::Debit,
                    commission,
                    AccountType::CommissionReceivable,
                );
                push_optional(
                    &mut lines,
                    Direction::Credit,
                    commission,
                    AccountType::PlatformIncome,
                );
                (
                    "PAYMENT_ATTEMPT",
                    "Merchant-owned direct settlement commission recognition",
                )
            }
        },
        LedgerScenario::AmlHoldAndRelease => match stage {
            Some(LedgerScenarioStage::Release) => {
                push(&mut lines, Direction::Debit, amount, AccountType::AmlHold);
                push_optional(
                    &mut lines,
                    Direction::Credit,
                    merchant,
                    AccountType::MerchantWallet,
                );
                push_optional(
                    &mut lines,
                    Direction::Credit,
                    commission,
                    AccountType::PlatformIncome,
                );
                ("AML_RELEASE", "AML hold checker release")
            }
            _ => {
                push(
                    &mut lines,
                    Direction::Debit,
                    amount,
                    AccountType::GatewayClearing,
                );
                push(&mut lines, Direction::Credit, amount, AccountType::AmlHold);
                ("PAYMENT_ATTEMPT", "AML threshold hold")
            }
        },
        LedgerScenario::Cashout => {
            push(
                &mut lines,
                Direction::Debit,
                amount,
                AccountType::MerchantWallet,
            );
            push(&mut lines, Direction::Credit, amount, AccountType::Treasury);
            ("ADJUSTMENT", "Merchant cash-out execution")
        }
        LedgerScenario::FullRefund => {
            push_optional(
                &mut lines,
                Direction::Debit,
                merchant,
                AccountType::MerchantWallet,
            );
            push_optional(
                &mut lines,
                Direction::Debit,
                commission,
                AccountType::PlatformIncome,
            );
            push(&mut lines, Direction::Credit, amount, AccountType::Treasury);
            ("ADJUSTMENT", "Full refund with commission reversal")
        }
        LedgerScenario::ChargebackReserveAndLost => match stage {
            Some(LedgerScenarioStage::Lost) => {
                push(
                    &mut lines,
                    Direction::Debit,
                    amount,
                    AccountType::ChargebackReserve,
                );
                push(&mut lines, Direction::Credit, amount, AccountType::Treasury);
                ("DISPUTE_OUTCOME", "Chargeback reserve lost")
            }
            _ => {
                push_optional(
                    &mut lines,
                    Direction::Debit,
                    merchant,
                    AccountType::MerchantWallet,
                );
                push_optional(
                    &mut lines,
                    Direction::Debit,
                    commission,
                    AccountType::PlatformIncome,
                );
                push(
                    &mut lines,
                    Direction::Credit,
                    amount,
                    AccountType::ChargebackReserve,
                );
                ("DISPUTE_OUTCOME", "Chargeback reserve")
            }
        },
        LedgerScenario::AmlVoid => {
            push(&mut lines, Direction::Debit, amount, AccountType::AmlHold);
            push(&mut lines, Direction::Credit, amount, AccountType::Treasury);
            ("AML_VOID", "AML hold void and funds return")
        }
        LedgerScenario::ChargebackWon => {
            push(
                &mut lines,
                Direction::Debit,
                amount,
                AccountType::ChargebackReserve,
            );
            push_optional(
                &mut lines,
                Direction::Credit,
                merchant,
                AccountType::MerchantWallet,
            );
            push_optional(
                &mut lines,
                Direction::Credit,
                commission,
                AccountType::PlatformIncome,
            );
            ("DISPUTE_OUTCOME", "Chargeback won and reserve released")
        }
        LedgerScenario::InternalConfirmation => {
            push(&mut lines, Direction::Debit, amount, AccountType::Treasury);
            push_optional(
                &mut lines,
                Direction::Credit,
                merchant,
                AccountType::MerchantWallet,
            );
            push_optional(
                &mut lines,
                Direction::Credit,
                commission,
                AccountType::PlatformIncome,
            );
            (
                "PAYMENT_ATTEMPT",
                "NeomPay internal confirmation under INTERNAL-1",
            )
        }
        LedgerScenario::InternalRefund => {
            push_optional(
                &mut lines,
                Direction::Debit,
                merchant,
                AccountType::MerchantWallet,
            );
            push_optional(
                &mut lines,
                Direction::Debit,
                commission,
                AccountType::PlatformIncome,
            );
            push(&mut lines, Direction::Credit, amount, AccountType::Treasury);
            ("ADJUSTMENT", "NeomPay internal refund")
        }
        LedgerScenario::ChargebackInsufficient => {
            push_optional(
                &mut lines,
                Direction::Debit,
                merchant,
                AccountType::MerchantWallet,
            );
            push_optional(
                &mut lines,
                Direction::Debit,
                commission,
                AccountType::PlatformIncome,
            );
            push(
                &mut lines,
                Direction::Credit,
                amount,
                AccountType::ChargebackReserve,
            );
            (
                "DISPUTE_OUTCOME",
                "Chargeback against insufficient merchant wallet",
            )
        }
        LedgerScenario::SuspenseSettlement => {
            // `ScenarioPosting` carries no ownership mode; the flow engine's SUSPENSE posting is a
            // platform-cleared settlement (its `INTERNAL` variant is produced by the slot sink,
            // which knows the attempt). Callers that need the treasury leg post directly.
            push(
                &mut lines,
                Direction::Debit,
                amount,
                AccountType::GatewayClearing,
            );
            push(&mut lines, Direction::Credit, amount, AccountType::Suspense);
            (
                "PAYMENT_ATTEMPT",
                "Settlement routed to SUSPENSE because the link slot was already used",
            )
        }
        LedgerScenario::SuspenseRefund => {
            push(&mut lines, Direction::Debit, amount, AccountType::Suspense);
            push(&mut lines, Direction::Credit, amount, AccountType::Treasury);
            ("ADJUSTMENT", "Refund of a settlement held in SUSPENSE")
        }
    };
    Ok(JournalTemplate::new(ref_type, reference, description, currency).with_lines(lines))
}

/// Posts one scenario inside the caller's transaction (used by the slot sink's SUSPENSE path).
pub(crate) async fn post_scenario_in_tx(
    conn: &mut PgConnection,
    posting: &ScenarioPosting,
    cache: Option<&AccountCache>,
) -> Result<PostedEntry, EngineError> {
    let template = scenario_template(posting)?;
    let context = context_of(
        posting.merchant_id.as_deref(),
        posting.gateway_id.as_deref(),
        posting.credential_set_id.as_deref(),
        posting.env,
        &posting.currency,
    )?;
    post_template(conn, &template, context, cache).await
}

async fn post_template(
    conn: &mut PgConnection,
    template: &JournalTemplate,
    context: PostContext,
    cache: Option<&AccountCache>,
) -> Result<PostedEntry, EngineError> {
    let mut options = PostOptions::new(context);
    if let Some(cache) = cache {
        options = options.with_cache(cache);
    }
    let result = post_entry(&mut *conn, template, &options)
        .await
        .map_err(ledger_error)?;
    Ok(PostedEntry {
        entry_id: result.entry.id.to_string(),
        idempotent: result.idempotent,
    })
}

fn context_of(
    merchant_id: Option<&str>,
    gateway_id: Option<&str>,
    credential_set_id: Option<&str>,
    env: Environment,
    currency: &str,
) -> Result<PostContext, EngineError> {
    let mut context = PostContext::new().with_currency(currency.to_owned());
    if let Some(merchant_id) = merchant_id {
        context = context.with_merchant(merchant_id);
    }
    if let Some(gateway_id) = gateway_id {
        let value = Uuid::parse_str(gateway_id).map_err(|error| {
            EngineError::with_code(
                500,
                codes::STEP_REQUEST_INVALID,
                format!("The ledger context gateway id is invalid: {error}"),
            )
        })?;
        context = context.with_gateway(value);
    }
    if let Some(credential_set_id) = credential_set_id {
        let value = Uuid::parse_str(credential_set_id).map_err(|error| {
            EngineError::with_code(
                500,
                codes::STEP_REQUEST_INVALID,
                format!("The ledger context credential set id is invalid: {error}"),
            )
        })?;
        context = context.with_credential_set(value);
    }
    Ok(context.with_env(env.as_str()))
}

fn push(
    lines: &mut Vec<LedgerLineTemplate>,
    direction: Direction,
    amount: Decimal,
    account_type: AccountType,
) {
    lines.push(LedgerLineTemplate::new(
        direction,
        amount,
        AccountSelector::new(account_type),
    ));
}

fn push_optional(
    lines: &mut Vec<LedgerLineTemplate>,
    direction: Direction,
    amount: Decimal,
    account_type: AccountType,
) {
    if !amount.is_zero() {
        push(lines, direction, amount, account_type);
    }
}

fn positive(value: Decimal, label: &str) -> Result<Decimal, EngineError> {
    if value <= Decimal::ZERO {
        return Err(EngineError::new(
            400,
            "INVALID_LEDGER_AMOUNT",
            format!("{label} must be greater than zero"),
        ));
    }
    Ok(value)
}

fn non_negative(value: Decimal, label: &str) -> Result<Decimal, EngineError> {
    if value < Decimal::ZERO {
        return Err(EngineError::new(
            400,
            "INVALID_LEDGER_AMOUNT",
            format!("{label} must not be negative"),
        ));
    }
    Ok(value)
}

fn missing_fee(label: &str) -> EngineError {
    EngineError::new(
        400,
        "MISSING_FEE_AMOUNT",
        format!("{label} must be resolved before posting"),
    )
}

fn money_error(message: &str) -> EngineError {
    EngineError::new(400, "INVALID_LEDGER_AMOUNT", message)
}

fn ledger_error(error: LedgerError) -> EngineError {
    let status = match &error {
        LedgerError::Template(_)
        | LedgerError::AccountNotFound { .. }
        | LedgerError::EntryConflict
        | LedgerError::MissingCurrency
        | LedgerError::TemplateLineMismatch
        | LedgerError::ShardRouting(_)
        | LedgerError::UnknownAccountType(_)
        | LedgerError::UnknownDirection(_)
        | LedgerError::UnsupportedAccountPredicate { .. } => 400,
        _ => 500,
    };
    EngineError::with_code(status, error.code(), error.to_string())
}

#[async_trait]
impl LedgerPort for PgLedgerAdapter {
    async fn post_confirmation(
        &self,
        posting: ConfirmationPosting,
    ) -> Result<PostedEntry, EngineError> {
        let mut tx = self.pool.begin().await.map_err(|error| {
            EngineError::with_code(500, "DATABASE_ERROR", format!("database error: {error}"))
        })?;
        let entry = self.post_confirmation_on(&mut tx, &posting).await?;
        tx.commit().await.map_err(|error| {
            EngineError::with_code(500, "DATABASE_ERROR", format!("database error: {error}"))
        })?;
        Ok(entry)
    }

    async fn post_scenario(&self, posting: ScenarioPosting) -> Result<PostedEntry, EngineError> {
        let mut tx = self.pool.begin().await.map_err(|error| {
            EngineError::with_code(500, "DATABASE_ERROR", format!("database error: {error}"))
        })?;
        let entry = self.post_scenario_on(&mut tx, &posting).await?;
        tx.commit().await.map_err(|error| {
            EngineError::with_code(500, "DATABASE_ERROR", format!("database error: {error}"))
        })?;
        Ok(entry)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ports::{FeeBearer, OwnershipMode};
    use std::str::FromStr;

    fn dec(value: &str) -> Decimal {
        Decimal::from_str(value).expect("decimal")
    }

    fn confirmation(
        ownership: OwnershipMode,
        bearer: FeeBearer,
        accrual: bool,
    ) -> ConfirmationPosting {
        let mut posting = ConfirmationPosting {
            attempt_id: "00000000-0000-4000-8000-000000000001".to_owned(),
            ownership_mode: ownership,
            fee_bearer: bearer,
            fee_accrual: accrual,
            amount: dec("100.0000"),
            surcharge_amount: dec("3.0000"),
            commission_amount: dec("3.0000"),
            merchant_amount: dec("97.0000"),
            gateway_fee_amount: Some(dec("0.8000")),
            provider_fee_amount: Some(dec("0.8000")),
            scenario: LedgerScenario::PlatformHeldConfirmation,
            merchant_id: None,
            gateway_id: None,
            credential_set_id: None,
            wallet_gl_account_id: None,
            currency: "LYD".to_owned(),
            env: Environment::Live,
        };
        posting.scenario = crate::ports::confirmation_scenario(&posting).expect("scenario");
        posting
    }

    fn balances(template: &JournalTemplate) -> (Decimal, Decimal) {
        let mut debit = Decimal::ZERO;
        let mut credit = Decimal::ZERO;
        for line in &template.lines {
            match line.direction {
                Direction::Debit => debit += line.amount,
                Direction::Credit => credit += line.amount,
            }
        }
        (debit, credit)
    }

    #[test]
    fn every_confirmation_template_balances() {
        for (ownership, bearer, accrual) in [
            (OwnershipMode::Internal, FeeBearer::MerchantAbsorbs, false),
            (
                OwnershipMode::MerchantDirect,
                FeeBearer::MerchantAbsorbs,
                false,
            ),
            (
                OwnershipMode::PlatformClearing,
                FeeBearer::MerchantAbsorbs,
                false,
            ),
            (
                OwnershipMode::PlatformClearing,
                FeeBearer::MerchantAbsorbs,
                true,
            ),
            (
                OwnershipMode::PlatformClearing,
                FeeBearer::PayerSurcharge,
                false,
            ),
            (OwnershipMode::PlatformClearing, FeeBearer::Split, false),
        ] {
            let mut posting = confirmation(ownership, bearer, accrual);
            if bearer == FeeBearer::Split {
                // In a split fee bearer the surcharge funds the platform commission, so the
                // merchant still receives the full amount (checkout.ts fee breakdown).
                posting.merchant_amount = posting.amount;
            }
            match confirmation_template(&posting).expect("template") {
                ScenarioTemplate::Post(template) => {
                    let (debit, credit) = balances(&template);
                    assert_eq!(debit, credit, "{ownership:?}/{bearer:?}/{accrual}");
                }
                ScenarioTemplate::NoPosting => {
                    assert_eq!(ownership, OwnershipMode::MerchantDirect);
                }
            }
        }
    }

    #[test]
    fn merchant_direct_zero_commission_has_no_posting() {
        let mut posting = confirmation(
            OwnershipMode::MerchantDirect,
            FeeBearer::MerchantAbsorbs,
            false,
        );
        posting.commission_amount = Decimal::ZERO;
        posting.merchant_amount = posting.amount;
        assert!(matches!(
            confirmation_template(&posting).expect("template"),
            ScenarioTemplate::NoPosting
        ));
    }

    #[test]
    fn suspense_and_refund_scenarios_balance() {
        let base = ScenarioPosting {
            scenario: LedgerScenario::SuspenseSettlement,
            stage: None,
            ref_id: "a".to_owned(),
            amount: dec("100.0000"),
            commission_amount: dec("3.0000"),
            merchant_amount: dec("97.0000"),
            merchant_id: None,
            gateway_id: None,
            credential_set_id: None,
            wallet_gl_account_id: None,
            currency: "LYD".to_owned(),
            env: Environment::Live,
        };
        let template = scenario_template(&base).expect("suspense");
        let (debit, credit) = balances(&template);
        assert_eq!(debit, dec("100.0000"));
        assert_eq!(credit, debit);

        let mut refund = base.clone();
        refund.scenario = LedgerScenario::FullRefund;
        let template = scenario_template(&refund).expect("refund");
        let (debit, credit) = balances(&template);
        assert_eq!(debit, credit);
        assert_eq!(credit, dec("100.0000"));
    }

    #[test]
    fn missing_fee_is_refused_not_invented() {
        let mut posting = confirmation(
            OwnershipMode::PlatformClearing,
            FeeBearer::MerchantAbsorbs,
            false,
        );
        posting.gateway_fee_amount = None;
        posting.provider_fee_amount = None;
        let error = confirmation_template(&posting).expect_err("missing fee");
        assert_eq!(error.code, "MISSING_FEE_AMOUNT");
    }
}

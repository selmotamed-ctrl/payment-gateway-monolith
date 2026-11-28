//! The posting template, the posting context and the poster options.
//!
//! Port of the TypeScript vocabulary in `core-back/engine/ledger/LedgerPoster.ts`:
//!
//! - `LedgerAccountSelector` (`:130-138`) and `LedgerLineTemplate` (`:140-144`) → [`AccountSelector`]
//!   and [`LedgerLineTemplate`];
//! - `JournalTemplate` (`:146-151`) → [`JournalTemplate`];
//! - `LedgerPostContext` (`:153-161`) → [`PostContext`];
//! - `LedgerPosterOptions` (`:180-193`) → [`PostOptions`].
//!
//! The important difference from [`pg_domain_ledger::JournalTemplate`] is that this template still
//! carries *selectors*, not resolved account ids: resolving them needs the database, so it happens
//! inside [`crate::post_entry`], exactly like the TypeScript step 3 (design chapter 2 §14).

#![forbid(unsafe_code)]

use std::collections::HashMap;

use pg_domain_ledger::{
    AccountType, Direction, JournalTemplate as DomainTemplate, LedgerLineInput,
};
use rust_decimal::{Decimal, RoundingStrategy};
use uuid::Uuid;

use crate::accounts::AccountCache;
use crate::error::LedgerError;

/// Port of `LedgerAccountSelector` (`LedgerPoster.ts:130-138`): which account a line books to.
///
/// An explicit `account_id` wins, then the caller's [`PostContext::accounts`] override, then the
/// scoped lookup (only the dimensions the account type carries, see `ACCOUNT_SCOPING`,
/// `LedgerPoster.ts:316-328`), then the platform-wide fallback, then `GL_ACCOUNT_NOT_FOUND`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountSelector {
    pub account_type: AccountType,
    /// `selector.accountId`: an already-known account, used as-is (no existence check, like TS).
    pub account_id: Option<Uuid>,
    /// `selector.ownerId`; defaults to the context merchant for `MERCHANT_WALLET`.
    pub owner_id: Option<String>,
    /// `selector.gatewayId`; defaults to the context gateway for `GATEWAY_CLEARING`.
    pub gateway_id: Option<Uuid>,
    /// `selector.credentialSetId`; defaults to the context credential set for `GATEWAY_CLEARING`.
    pub credential_set_id: Option<Uuid>,
    /// `selector.env`; defaults to the context environment for `GATEWAY_CLEARING`.
    pub env: Option<String>,
    /// `selector.currency`; defaults to the context currency, then the template currency.
    pub currency: Option<String>,
}

impl AccountSelector {
    /// A selector for one account type with no explicit dimensions.
    #[must_use]
    pub fn new(account_type: AccountType) -> Self {
        Self {
            account_type,
            account_id: None,
            owner_id: None,
            gateway_id: None,
            credential_set_id: None,
            env: None,
            currency: None,
        }
    }

    /// Pins the account explicitly (step 1 of the resolution order).
    #[must_use]
    pub fn with_account_id(mut self, account_id: Uuid) -> Self {
        self.account_id = Some(account_id);
        self
    }

    /// Narrows the lookup to one merchant wallet owner.
    #[must_use]
    pub fn with_owner(mut self, owner_id: impl Into<String>) -> Self {
        self.owner_id = Some(owner_id.into());
        self
    }

    /// Narrows the lookup to one gateway clearing account.
    #[must_use]
    pub fn with_gateway(mut self, gateway_id: Uuid) -> Self {
        self.gateway_id = Some(gateway_id);
        self
    }

    /// Narrows the lookup to one gateway credential set.
    #[must_use]
    pub fn with_credential_set(mut self, credential_set_id: Uuid) -> Self {
        self.credential_set_id = Some(credential_set_id);
        self
    }

    /// Narrows the lookup to one environment (`LIVE` / `SANDBOX`).
    #[must_use]
    pub fn with_env(mut self, env: impl Into<String>) -> Self {
        self.env = Some(env.into());
        self
    }

    /// Overrides the currency used to resolve the account.
    #[must_use]
    pub fn with_currency(mut self, currency: impl Into<String>) -> Self {
        self.currency = Some(currency.into());
        self
    }
}

/// Port of `LedgerLineTemplate` (`LedgerPoster.ts:140-144`).
///
/// A zero optional leg is never a line: the TypeScript `optionalLine` helper (`:305-311`) returns
/// an empty array, so callers simply do not add it here.
#[derive(Debug, Clone, PartialEq)]
pub struct LedgerLineTemplate {
    pub direction: Direction,
    pub amount: Decimal,
    pub account: AccountSelector,
}

impl LedgerLineTemplate {
    #[must_use]
    pub fn new(direction: Direction, amount: Decimal, account: AccountSelector) -> Self {
        Self {
            direction,
            amount,
            account,
        }
    }

    /// A debit line for `amount` on `account`.
    #[must_use]
    pub fn debit(amount: Decimal, account: AccountSelector) -> Self {
        Self::new(Direction::Debit, amount, account)
    }

    /// A credit line for `amount` on `account`.
    #[must_use]
    pub fn credit(amount: Decimal, account: AccountSelector) -> Self {
        Self::new(Direction::Credit, amount, account)
    }
}

/// Port of `JournalTemplate` (`LedgerPoster.ts:146-151`) plus the currency the Rust port keeps on
/// the template so account resolution is always currency-scoped.
///
/// The posted amount is the sum of the debit lines and must equal the sum of the credit lines
/// exactly (see `pg_domain_ledger::validate_template`).
#[derive(Debug, Clone, PartialEq)]
pub struct JournalTemplate {
    /// `JournalRefType` text, e.g. `PAYMENT_ATTEMPT`.
    pub ref_type: String,
    /// The business reference; `(ref_type, ref_id)` is unique and makes a replay idempotent.
    pub ref_id: String,
    /// `journal_entries.description` (NOT NULL).
    pub description: String,
    /// ISO-4217 code every resolved account must be in (the template carrier of
    /// `LedgerPostContext.currency`; the domain template also requires it).
    pub currency: String,
    pub lines: Vec<LedgerLineTemplate>,
}

impl JournalTemplate {
    #[must_use]
    pub fn new(
        ref_type: impl Into<String>,
        ref_id: impl Into<String>,
        description: impl Into<String>,
        currency: impl Into<String>,
    ) -> Self {
        Self {
            ref_type: ref_type.into(),
            ref_id: ref_id.into(),
            description: description.into(),
            currency: currency.into(),
            lines: Vec::new(),
        }
    }

    #[must_use]
    pub fn with_line(mut self, line: LedgerLineTemplate) -> Self {
        self.lines.push(line);
        self
    }

    #[must_use]
    pub fn with_lines(mut self, lines: impl IntoIterator<Item = LedgerLineTemplate>) -> Self {
        self.lines.extend(lines);
        self
    }

    /// The domain template with placeholder ids, used only to call
    /// [`pg_domain_ledger::validate_template`] before account resolution (the validated account ids
    /// are overwritten after step 3, exactly like the TypeScript validates amounts before it
    /// resolves accounts).
    #[must_use]
    pub(crate) fn to_unresolved_domain_template(&self) -> DomainTemplate {
        DomainTemplate {
            ref_type: self.ref_type.clone(),
            ref_id: self.ref_id.clone(),
            currency: self.currency.clone(),
            description: Some(self.description.clone()),
            lines: self
                .lines
                .iter()
                .map(|line| LedgerLineInput {
                    gl_account_id: Uuid::nil(),
                    direction: line.direction,
                    amount: line.amount,
                    // The Rust template mirrors `LedgerPoster.ts` exactly: a zero amount is always an
                    // error, and callers omit non-applicable legs (the TS `optionalLine` helper).
                    optional: false,
                })
                .collect(),
        }
    }
}

/// Port of `LedgerPostContext` (`LedgerPoster.ts:153-161`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PostContext {
    /// `context.accounts`: per-account-type overrides that win over every database lookup.
    pub accounts: HashMap<AccountType, Uuid>,
    /// The merchant whose wallet a `MERCHANT_WALLET` selector resolves to.
    pub merchant_id: Option<String>,
    /// The gateway a `GATEWAY_CLEARING` selector resolves to.
    pub gateway_id: Option<Uuid>,
    /// The credential set a `GATEWAY_CLEARING` selector resolves to.
    pub credential_set_id: Option<Uuid>,
    /// The environment (`LIVE` / `SANDBOX`) a `GATEWAY_CLEARING` selector resolves to.
    pub env: Option<String>,
    /// The currency of default account resolution.
    pub currency: Option<String>,
}

impl PostContext {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn with_merchant(mut self, merchant_id: impl Into<String>) -> Self {
        self.merchant_id = Some(merchant_id.into());
        self
    }

    #[must_use]
    pub fn with_gateway(mut self, gateway_id: Uuid) -> Self {
        self.gateway_id = Some(gateway_id);
        self
    }

    #[must_use]
    pub fn with_credential_set(mut self, credential_set_id: Uuid) -> Self {
        self.credential_set_id = Some(credential_set_id);
        self
    }

    #[must_use]
    pub fn with_env(mut self, env: impl Into<String>) -> Self {
        self.env = Some(env.into());
        self
    }

    #[must_use]
    pub fn with_currency(mut self, currency: impl Into<String>) -> Self {
        self.currency = Some(currency.into());
        self
    }

    /// Maps one account type to an explicit account id for this posting.
    #[must_use]
    pub fn with_account(mut self, account_type: AccountType, account_id: Uuid) -> Self {
        self.accounts.insert(account_type, account_id);
        self
    }
}

/// Port of `LedgerPosterOptions` (`LedgerPoster.ts:180-193`) adapted to the Rust surface.
///
/// `raw_sql` is not a toggle: the Rust port implements the raw path only and refuses
/// `LEDGER_RAW_SQL=false` (see [`PostOptions::from_env`] and design chapter 2 §14).
#[derive(Debug, Clone)]
pub struct PostOptions<'a> {
    /// The posting context (merchant, gateway, environment, currency, account overrides).
    pub context: PostContext,
    /// Emit `ledger.entry_posted` in the posting transaction. Off by default, exactly like
    /// `createLedgerPoster` (`lib/storageEngine/ledgerPosterFactory.ts:10-21`): the topic has no
    /// consumer.
    pub emit_outbox: bool,
    /// Refuse an account lookup that has no currency (`LedgerPoster.ts:189-191`). The Rust template
    /// always carries a currency, so this only rejects an empty one.
    pub require_currency: bool,
    /// The shared, bounded, 60-second scoped-account cache. `None` disables caching.
    pub cache: Option<&'a AccountCache>,
}

impl<'a> PostOptions<'a> {
    /// Options with only a context (outbox off, no cache).
    #[must_use]
    pub fn new(context: PostContext) -> Self {
        Self {
            context,
            emit_outbox: false,
            require_currency: false,
            cache: None,
        }
    }

    /// Options with a cache attached.
    #[must_use]
    pub fn with_cache(mut self, cache: &'a AccountCache) -> Self {
        self.cache = Some(cache);
        self
    }

    /// Emits the `ledger.entry_posted` outbox row in the posting transaction.
    #[must_use]
    pub fn with_outbox(mut self) -> Self {
        self.emit_outbox = true;
        self
    }

    /// Refuse account lookups without a currency (`LEDGER_STRICT_CONTEXT=true`).
    #[must_use]
    pub fn with_required_currency(mut self) -> Self {
        self.require_currency = true;
        self
    }

    /// Production constructor: refuses `LEDGER_RAW_SQL=false` and reads `LEDGER_STRICT_CONTEXT`,
    /// like `createLedgerPoster` (`ledgerPosterFactory.ts:51-52`).
    pub fn from_env(context: PostContext) -> Result<Self, LedgerError> {
        let raw_sql = std::env::var("LEDGER_RAW_SQL").ok();
        check_ledger_raw_sql(raw_sql.as_deref())?;
        let require_currency = std::env::var("LEDGER_STRICT_CONTEXT")
            .map(|value| value.trim() == "true")
            .unwrap_or(false);
        Ok(Self {
            context,
            emit_outbox: false,
            require_currency,
            cache: None,
        })
    }
}

/// The pure half of the `LEDGER_RAW_SQL` kill switch: `false` (the TS ORM path) is refused.
///
/// The TypeScript reads `LEDGER_RAW_SQL !== "false"` (`ledgerPosterFactory.ts:51`). The Rust port
/// trims the value and accepts every spelling except `false`; anything else runs the same raw path.
pub fn check_ledger_raw_sql(value: Option<&str>) -> Result<(), LedgerError> {
    match value.map(str::trim) {
        Some("false") => Err(LedgerError::RawSqlDisabled),
        _ => Ok(()),
    }
}

/// Rounds a money value to the `numeric(18,4)` scale with decimal.js `toFixed(4)` semantics
/// (ROUND_HALF_UP, away from zero), which is what every TS write and `toFixed(4)` does.
#[must_use]
pub(crate) fn money4(value: Decimal) -> Decimal {
    let rounded = value.round_dp_with_strategy(4, RoundingStrategy::MidpointAwayFromZero);
    if rounded.is_zero() {
        Decimal::ZERO
    } else {
        rounded
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    fn dec(raw: &str) -> Decimal {
        Decimal::from_str(raw).expect("test decimal")
    }

    #[test]
    fn raw_sql_false_is_refused_and_everything_else_is_allowed() {
        assert!(matches!(
            check_ledger_raw_sql(Some("false")),
            Err(LedgerError::RawSqlDisabled)
        ));
        assert!(matches!(
            check_ledger_raw_sql(Some(" false ")),
            Err(LedgerError::RawSqlDisabled)
        ));
        for allowed in [None, Some("true"), Some("1"), Some(""), Some("FALSE")] {
            assert!(check_ledger_raw_sql(allowed).is_ok(), "{allowed:?}");
        }
    }

    #[test]
    fn money_rounds_like_to_fixed_four() {
        assert_eq!(money4(dec("1.00005")).to_string(), "1.0001");
        assert_eq!(money4(dec("-1.00005")).to_string(), "-1.0001");
        assert_eq!(money4(dec("100")).to_string(), "100");
        assert_eq!(money4(dec("0.00001")).to_string(), "0");
        // The value keeps four decimal places when serialised with the money formatter.
        assert_eq!(
            pg_types::Money4::new(money4(dec("1.5"))).to_fixed_4(),
            "1.5000"
        );
    }

    #[test]
    fn unresolved_template_keeps_validation_inputs() {
        let template = JournalTemplate::new("ADJUSTMENT", "ref-1", "description", "LYD")
            .with_line(LedgerLineTemplate::debit(
                dec("10"),
                AccountSelector::new(AccountType::Treasury),
            ))
            .with_line(LedgerLineTemplate::credit(
                dec("10"),
                AccountSelector::new(AccountType::MerchantWallet).with_owner("merchant-1"),
            ));
        let domain = template.to_unresolved_domain_template();
        assert_eq!(domain.ref_type, "ADJUSTMENT");
        assert_eq!(domain.ref_id, "ref-1");
        assert_eq!(domain.currency, "LYD");
        assert_eq!(domain.lines.len(), 2);
        assert!(domain.lines.iter().all(|line| line.gl_account_id.is_nil()));
        assert!(domain.lines.iter().all(|line| !line.optional));
        assert_eq!(domain.lines[0].direction, Direction::Debit);
        assert_eq!(domain.lines[1].direction, Direction::Credit);
    }

    #[test]
    fn context_overrides_are_recorded_per_account_type() {
        let treasury = Uuid::now_v7();
        let context = PostContext::new()
            .with_merchant("merchant-1")
            .with_currency("LYD")
            .with_account(AccountType::Treasury, treasury);
        assert_eq!(
            context.accounts.get(&AccountType::Treasury),
            Some(&treasury)
        );
        assert_eq!(context.merchant_id.as_deref(), Some("merchant-1"));
    }
}

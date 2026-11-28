//! Currency and settlement context.
//!
//! Port of `StatementIngestor.itemContext` (`:367-378`) and the sweep grouping of
//! `core-back/engine/workers/BackgroundJobHandlers.ts:181-267`:
//!
//! - the item currency is `row.currency ?? attempt.currency ?? source.currency`;
//! - the environment is `attempt.env ?? source.env`;
//! - the credential set is `attempt.credentialSetId ?? source.credentialSetId`;
//! - the gateway is the statement source's gateway;
//! - lines with the same batch reference and the same full context
//!   `(batch, gateway, env, credentialSet, currency)` are one sweep; a line without a batch posts
//!   its own sweep.
//!
//! A sweep without a currency or a gateway is skipped (the TS logs and continues), which
//! [`CurrencyContext::is_complete`] exposes.

#![forbid(unsafe_code)]

use crate::statement::StatementLine;

/// `StatementSourceRow` fields the context reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatementSourceContext {
    pub gateway_id: String,
    pub currency: Option<String>,
    pub environment: Option<String>,
    pub credential_set_id: Option<String>,
}

impl StatementSourceContext {
    #[must_use]
    pub fn new(gateway_id: impl Into<String>) -> Self {
        Self {
            gateway_id: gateway_id.into(),
            currency: None,
            environment: None,
            credential_set_id: None,
        }
    }

    #[must_use]
    pub fn with_currency(mut self, currency: impl Into<String>) -> Self {
        self.currency = Some(currency.into());
        self
    }

    #[must_use]
    pub fn with_environment(mut self, environment: impl Into<String>) -> Self {
        self.environment = Some(environment.into());
        self
    }

    #[must_use]
    pub fn with_credential_set(mut self, credential_set_id: impl Into<String>) -> Self {
        self.credential_set_id = Some(credential_set_id.into());
        self
    }
}

/// The attempt fields the context reads (`PaymentAttempt`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AttemptContext {
    pub currency: Option<String>,
    pub environment: Option<String>,
    pub credential_set_id: Option<String>,
}

impl AttemptContext {
    #[must_use]
    pub fn new(currency: Option<String>) -> Self {
        Self {
            currency,
            environment: None,
            credential_set_id: None,
        }
    }
}

/// The context snapshot stored on a reconciliation item and read by the settlement sweep.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CurrencyContext {
    pub gateway_id: Option<String>,
    pub environment: Option<String>,
    pub credential_set_id: Option<String>,
    pub currency: Option<String>,
}

impl CurrencyContext {
    /// `itemContext`: the fallback chain of the ingestor.
    #[must_use]
    pub fn resolve(
        source: &StatementSourceContext,
        line: &StatementLine,
        attempt: Option<&AttemptContext>,
    ) -> Self {
        let currency = line
            .currency
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_ascii_uppercase)
            .or_else(|| attempt.and_then(|context| context.currency.clone()))
            .or_else(|| source.currency.clone());
        let environment = attempt
            .and_then(|context| context.environment.clone())
            .or_else(|| source.environment.clone());
        let credential_set_id = attempt
            .and_then(|context| context.credential_set_id.clone())
            .or_else(|| source.credential_set_id.clone());
        Self {
            gateway_id: Some(source.gateway_id.clone()),
            environment,
            credential_set_id,
            currency,
        }
    }

    /// The sweep needs both a currency and a gateway.
    #[must_use]
    pub fn is_complete(&self) -> bool {
        self.currency
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
            && self
                .gateway_id
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
    }

    /// The grouping key `[batchReference ?? itemId, gatewayId, env ?? "", credentialSet ?? "",
    /// currency].join("|")`.
    #[must_use]
    pub fn group_key(&self, batch_reference: Option<&str>, item_id: &str) -> String {
        [
            batch_reference.unwrap_or(item_id),
            self.gateway_id.as_deref().unwrap_or(""),
            self.environment.as_deref().unwrap_or(""),
            self.credential_set_id.as_deref().unwrap_or(""),
            self.currency.as_deref().unwrap_or(""),
        ]
        .join("|")
    }

    /// The journal `refId` of the sweep:
    /// `settlement:<batch>:<gateway>:<env|->:<credentialSet|->:<currency>` with a batch, else
    /// `settlement:<itemId>`.
    #[must_use]
    pub fn settlement_ref(&self, batch_reference: Option<&str>, item_id: &str) -> String {
        match batch_reference {
            Some(batch) if !batch.is_empty() => format!(
                "settlement:{batch}:{}:{}:{}:{}",
                self.gateway_id.as_deref().unwrap_or(""),
                self.environment.as_deref().unwrap_or("-"),
                self.credential_set_id.as_deref().unwrap_or("-"),
                self.currency.as_deref().unwrap_or("")
            ),
            _ => format!("settlement:{item_id}"),
        }
    }

    /// The legacy un-grouped ref of the pre-grouping sweeps (`settlement:<batch>`); a batch that
    /// already posted under it is never swept twice.
    #[must_use]
    pub fn legacy_settlement_ref(batch_reference: &str) -> String {
        format!("settlement:{batch_reference}")
    }
}

#[cfg(test)]
mod tests {
    use rust_decimal::Decimal;

    use super::*;
    use crate::amount::parse_amount;

    fn line(currency: Option<&str>) -> StatementLine {
        let mut line = StatementLine::new(parse_amount("10").expect("amount"), Decimal::ZERO);
        line.currency = currency.map(str::to_owned);
        line
    }

    #[test]
    fn fallback_chain_matches_item_context() {
        let source = StatementSourceContext::new("gw-1")
            .with_currency("LYD")
            .with_environment("LIVE")
            .with_credential_set("cred-source");
        let attempt = AttemptContext {
            currency: Some("USD".to_owned()),
            environment: Some("SANDBOX".to_owned()),
            credential_set_id: Some("cred-attempt".to_owned()),
        };

        let context = CurrencyContext::resolve(&source, &line(Some("eur")), Some(&attempt));
        assert_eq!(context.currency.as_deref(), Some("EUR"));
        assert_eq!(context.environment.as_deref(), Some("SANDBOX"));
        assert_eq!(context.credential_set_id.as_deref(), Some("cred-attempt"));
        assert_eq!(context.gateway_id.as_deref(), Some("gw-1"));

        let context = CurrencyContext::resolve(&source, &line(None), Some(&attempt));
        assert_eq!(context.currency.as_deref(), Some("USD"));
        let context = CurrencyContext::resolve(&source, &line(None), None);
        assert_eq!(context.currency.as_deref(), Some("LYD"));
        assert_eq!(context.environment.as_deref(), Some("LIVE"));
        assert_eq!(context.credential_set_id.as_deref(), Some("cred-source"));
    }

    #[test]
    fn blank_row_currency_falls_back() {
        let source = StatementSourceContext::new("gw-1").with_currency("LYD");
        let context = CurrencyContext::resolve(&source, &line(Some("   ")), None);
        assert_eq!(context.currency.as_deref(), Some("LYD"));
    }

    #[test]
    fn grouping_and_refs() {
        let context = CurrencyContext {
            gateway_id: Some("gw-1".to_owned()),
            environment: Some("LIVE".to_owned()),
            credential_set_id: None,
            currency: Some("LYD".to_owned()),
        };
        assert_eq!(
            context.group_key(Some("BATCH-1"), "item-1"),
            "BATCH-1|gw-1|LIVE||LYD"
        );
        assert_eq!(context.group_key(None, "item-1"), "item-1|gw-1|LIVE||LYD");
        assert_eq!(
            context.settlement_ref(Some("BATCH-1"), "item-1"),
            "settlement:BATCH-1:gw-1:LIVE:-:LYD"
        );
        assert_eq!(context.settlement_ref(None, "item-1"), "settlement:item-1");
        assert_eq!(
            CurrencyContext::legacy_settlement_ref("BATCH-1"),
            "settlement:BATCH-1"
        );
    }

    #[test]
    fn incomplete_contexts_are_skipped() {
        let source = StatementSourceContext::new("gw-1");
        let context = CurrencyContext::resolve(&source, &line(None), None);
        assert!(!context.is_complete());
        let source = StatementSourceContext::new(" ").with_currency("LYD");
        let context = CurrencyContext::resolve(&source, &line(None), None);
        assert!(!context.is_complete());
        let context = CurrencyContext {
            gateway_id: Some("gw-1".to_owned()),
            environment: None,
            credential_set_id: None,
            currency: Some("LYD".to_owned()),
        };
        assert!(context.is_complete());
    }
}

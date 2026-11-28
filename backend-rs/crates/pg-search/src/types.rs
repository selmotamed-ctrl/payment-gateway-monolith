//! Search record types, result shapes and the provider registry.
//!
//! Port of `core-back/lib/search/types.ts` and of the providers registered in
//! `core-back/lib/globalSearch.ts`.
//!
//! The plan text says "20 providers"; the working tree registers **21** (`V1_SEARCH_TYPES`, the
//! `defaultSearchRegistry.register(...)` chain and `SEARCH_PROVIDERS` all list 21). Parity wins:
//! all 21 are ported, in registration order (`order` 10..200), with their aliases.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// The provider execution order, the registry key and the wire value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SearchType {
    Merchant,
    PaymentAttempt,
    OperatorCase,
    GatewayInquiry,
    Approval,
    JoinRequest,
    KybDocument,
    Dispute,
    Adjustment,
    Cashout,
    ReconciliationRun,
    AmlCase,
    AmlScreening,
    AmlRule,
    AmlReport,
    Gateway,
    CredentialSet,
    Rail,
    Route,
    User,
    AuditLog,
}

/// `ProviderSpec` — one registered provider.
#[derive(Debug, Clone, Copy)]
pub struct ProviderSpec {
    pub search_type: SearchType,
    /// Execution order (the TS `order` field).
    pub order: u16,
    /// `type:<alias>` / `is:<alias>` resolution.
    pub aliases: &'static [&'static str],
}

/// The registered providers, in execution order.
pub const PROVIDERS: [ProviderSpec; 21] = [
    ProviderSpec {
        search_type: SearchType::Merchant,
        order: 10,
        aliases: &["merchants", "mer", "store"],
    },
    ProviderSpec {
        search_type: SearchType::PaymentAttempt,
        order: 20,
        aliases: &["attempt", "attempts", "tx", "transaction", "payment"],
    },
    ProviderSpec {
        search_type: SearchType::OperatorCase,
        order: 30,
        aliases: &["case", "cases"],
    },
    ProviderSpec {
        search_type: SearchType::GatewayInquiry,
        order: 40,
        aliases: &["inquiry", "inquiries"],
    },
    ProviderSpec {
        search_type: SearchType::Approval,
        order: 50,
        aliases: &["approvals", "maker_checker"],
    },
    ProviderSpec {
        search_type: SearchType::JoinRequest,
        order: 60,
        aliases: &["onboarding", "join", "kyb"],
    },
    ProviderSpec {
        search_type: SearchType::KybDocument,
        order: 70,
        aliases: &["doc", "docs", "document"],
    },
    ProviderSpec {
        search_type: SearchType::Dispute,
        order: 80,
        aliases: &["disputes", "chargeback"],
    },
    ProviderSpec {
        search_type: SearchType::Adjustment,
        order: 90,
        aliases: &["adjustments", "refund", "fee_adjustment"],
    },
    ProviderSpec {
        search_type: SearchType::Cashout,
        order: 100,
        aliases: &["cashouts", "payout", "withdrawal"],
    },
    ProviderSpec {
        search_type: SearchType::ReconciliationRun,
        order: 110,
        aliases: &["recon", "reconciliation", "statement"],
    },
    ProviderSpec {
        search_type: SearchType::AmlCase,
        order: 120,
        aliases: &["aml"],
    },
    ProviderSpec {
        search_type: SearchType::AmlScreening,
        order: 130,
        aliases: &["screening"],
    },
    ProviderSpec {
        search_type: SearchType::AmlRule,
        order: 140,
        aliases: &["aml_rules"],
    },
    ProviderSpec {
        search_type: SearchType::AmlReport,
        order: 150,
        aliases: &["str", "sar", "regulatory_report"],
    },
    ProviderSpec {
        search_type: SearchType::Gateway,
        order: 160,
        aliases: &["gateways", "gw"],
    },
    ProviderSpec {
        search_type: SearchType::CredentialSet,
        order: 165,
        aliases: &["credential_sets", "credentials", "credential"],
    },
    ProviderSpec {
        search_type: SearchType::Rail,
        order: 170,
        aliases: &["rails"],
    },
    ProviderSpec {
        search_type: SearchType::Route,
        order: 180,
        aliases: &["routes", "rail_route"],
    },
    ProviderSpec {
        search_type: SearchType::User,
        order: 190,
        aliases: &["users", "staff", "admin"],
    },
    ProviderSpec {
        search_type: SearchType::AuditLog,
        order: 200,
        aliases: &["audit", "logs"],
    },
];

impl SearchType {
    /// The wire value (`V1_SEARCH_TYPES` member).
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Merchant => "merchant",
            Self::PaymentAttempt => "payment_attempt",
            Self::OperatorCase => "operator_case",
            Self::GatewayInquiry => "gateway_inquiry",
            Self::Approval => "approval",
            Self::JoinRequest => "join_request",
            Self::KybDocument => "kyb_document",
            Self::Dispute => "dispute",
            Self::Adjustment => "adjustment",
            Self::Cashout => "cashout",
            Self::ReconciliationRun => "reconciliation_run",
            Self::AmlCase => "aml_case",
            Self::AmlScreening => "aml_screening",
            Self::AmlRule => "aml_rule",
            Self::AmlReport => "aml_report",
            Self::Gateway => "gateway",
            Self::CredentialSet => "credential_set",
            Self::Rail => "rail",
            Self::Route => "route",
            Self::User => "user",
            Self::AuditLog => "audit_log",
        }
    }

    /// Parses a wire value.
    #[must_use]
    pub fn from_wire(value: &str) -> Option<Self> {
        PROVIDERS
            .iter()
            .find(|provider| provider.search_type.as_str() == value)
            .map(|provider| provider.search_type)
    }

    /// The provider execution order.
    #[must_use]
    pub fn order(self) -> u16 {
        PROVIDERS
            .iter()
            .find(|provider| provider.search_type == self)
            .map_or(u16::MAX, |provider| provider.order)
    }

    /// The `type:` aliases.
    #[must_use]
    pub fn aliases(self) -> &'static [&'static str] {
        PROVIDERS
            .iter()
            .find(|provider| provider.search_type == self)
            .map_or(&[], |provider| provider.aliases)
    }

    /// Resolves a `type:<alias>` token to the registered types (case-insensitive). The exact type
    /// name always resolves to itself.
    #[must_use]
    pub fn resolve_alias(alias: &str) -> Vec<Self> {
        let normalized = alias.to_ascii_lowercase();
        let mut matched = Vec::new();
        for provider in &PROVIDERS {
            let type_name = provider.search_type.as_str();
            let alias_match = provider
                .aliases
                .iter()
                .any(|candidate| candidate.eq_ignore_ascii_case(&normalized));
            if type_name == normalized || alias_match {
                matched.push(provider.search_type);
            }
        }
        matched
    }
}

impl std::fmt::Display for SearchType {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl Serialize for SearchType {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for SearchType {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = <String as Deserialize>::deserialize(deserializer)?;
        Self::from_wire(&text)
            .ok_or_else(|| serde::de::Error::custom(format!("unsupported search type '{text}'")))
    }
}

/// All registered providers in execution order.
#[must_use]
pub fn all_ordered() -> &'static [SearchType] {
    // `PROVIDERS` is already in execution order.
    ALL_ORDERED.as_slice()
}

const ALL_ORDERED: [SearchType; 21] = [
    SearchType::Merchant,
    SearchType::PaymentAttempt,
    SearchType::OperatorCase,
    SearchType::GatewayInquiry,
    SearchType::Approval,
    SearchType::JoinRequest,
    SearchType::KybDocument,
    SearchType::Dispute,
    SearchType::Adjustment,
    SearchType::Cashout,
    SearchType::ReconciliationRun,
    SearchType::AmlCase,
    SearchType::AmlScreening,
    SearchType::AmlRule,
    SearchType::AmlReport,
    SearchType::Gateway,
    SearchType::CredentialSet,
    SearchType::Rail,
    SearchType::Route,
    SearchType::User,
    SearchType::AuditLog,
];

/// A metadata value. Floats are deliberately absent: every numeric meta value the providers emit
/// is a count, and money must never become a float.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MetaValue {
    /// A string.
    Text(String),
    /// An integer count.
    Integer(i64),
    /// A boolean.
    Bool(bool),
    /// A null.
    Null,
}

/// `SearchResultItem` (`SearchHit` in the port).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchHit {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merchant_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operator_case_id: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub meta: BTreeMap<String, MetaValue>,
}

impl SearchHit {
    /// A hit with the two mandatory fields.
    #[must_use]
    pub fn new(id: impl Into<String>, title: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            ..Self::default()
        }
    }

    /// Attaches a subtitle.
    #[must_use]
    pub fn with_subtitle(mut self, subtitle: impl Into<String>) -> Self {
        self.subtitle = Some(subtitle.into());
        self
    }

    /// Attaches a reference.
    #[must_use]
    pub fn with_reference(mut self, reference: impl Into<String>) -> Self {
        self.reference = Some(reference.into());
        self
    }

    /// Attaches a status.
    #[must_use]
    pub fn with_status(mut self, status: impl Into<String>) -> Self {
        self.status = Some(status.into());
        self
    }

    /// Attaches the owning merchant.
    #[must_use]
    pub fn with_merchant(mut self, merchant_id: impl Into<String>) -> Self {
        self.merchant_id = Some(merchant_id.into());
        self
    }

    /// Attaches a metadata entry.
    #[must_use]
    pub fn with_meta(mut self, key: impl Into<String>, value: MetaValue) -> Self {
        self.meta.insert(key.into(), value);
        self
    }
}

/// `SearchResultGroup` flattened: one ranked hit with its provider.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RankedHit {
    pub provider: SearchType,
    #[serde(flatten)]
    pub hit: SearchHit,
    /// `computeMatchScore` result.
    pub score: u32,
    /// The signal timestamp, for the recency tie-break.
    pub timestamp_ms: i64,
}

/// `GlobalSearchResponse` in the port's flat shape (`items` instead of per-type `groups`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchResponse {
    pub query: String,
    pub items: Vec<RankedHit>,
    /// The number of returned items (`total` in the TS response).
    pub total: usize,
    /// True when at least one provider failed (`allSettled` rejected).
    pub partial: bool,
}

impl SearchResponse {
    /// Builds a response from already ranked items.
    #[must_use]
    pub fn new(query: impl Into<String>, items: Vec<RankedHit>, partial: bool) -> Self {
        Self {
            query: query.into(),
            total: items.len(),
            items,
            partial,
        }
    }

    /// An empty response.
    #[must_use]
    pub fn empty(query: impl Into<String>) -> Self {
        Self::new(query, Vec::new(), false)
    }

    /// True when nothing matched.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    /// The number of returned items.
    #[must_use]
    pub fn len(&self) -> usize {
        self.items.len()
    }

    /// The distinct providers represented, in execution order.
    #[must_use]
    pub fn providers(&self) -> Vec<SearchType> {
        let mut providers: Vec<SearchType> = Vec::new();
        for item in &self.items {
            if !providers.contains(&item.provider) {
                providers.push(item.provider);
            }
        }
        providers.sort_by_key(|provider| provider.order());
        providers
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_registry_has_every_provider_in_order() {
        assert_eq!(PROVIDERS.len(), 21);
        assert_eq!(all_ordered().len(), 21);
        let mut previous = 0;
        for provider in &PROVIDERS {
            assert!(provider.order > previous, "orders must increase");
            previous = provider.order;
            assert_eq!(
                provider.search_type.as_str(),
                SearchType::from_wire(provider.search_type.as_str())
                    .expect("known")
                    .as_str()
            );
            assert_eq!(provider.search_type.order(), provider.order);
        }
        assert_eq!(SearchType::Merchant.order(), 10);
        assert_eq!(SearchType::AuditLog.order(), 200);
        assert_eq!(SearchType::CredentialSet.order(), 165);
    }

    #[test]
    fn aliases_resolve_like_the_ts_registry() {
        assert_eq!(
            SearchType::resolve_alias("tx"),
            vec![SearchType::PaymentAttempt]
        );
        assert_eq!(
            SearchType::resolve_alias("merchants"),
            vec![SearchType::Merchant]
        );
        assert_eq!(
            SearchType::resolve_alias("chargeback"),
            vec![SearchType::Dispute]
        );
        assert_eq!(
            SearchType::resolve_alias("str"),
            vec![SearchType::AmlReport]
        );
        assert_eq!(
            SearchType::resolve_alias("audit"),
            vec![SearchType::AuditLog]
        );
        assert_eq!(
            SearchType::resolve_alias("payment_attempt"),
            vec![SearchType::PaymentAttempt]
        );
        assert!(SearchType::resolve_alias("unknown").is_empty());
        assert_eq!(
            SearchType::PaymentAttempt.aliases(),
            &["attempt", "attempts", "tx", "transaction", "payment"][..]
        );
    }

    #[test]
    fn search_types_round_trip_on_the_wire() {
        assert_eq!(SearchType::KybDocument.as_str(), "kyb_document");
        assert_eq!(
            SearchType::from_wire("aml_report"),
            Some(SearchType::AmlReport)
        );
        assert_eq!(SearchType::from_wire("voucher"), None);
        assert_eq!(SearchType::AuditLog.to_string(), "audit_log");
        assert_eq!(SearchType::CredentialSet.as_str(), "credential_set");
    }

    #[test]
    fn a_hit_carries_the_ts_result_fields() {
        let mut hit = SearchHit::new("id-1", "Merchant ACME")
            .with_subtitle("ACME LLC")
            .with_reference("ATT-1")
            .with_status("SUCCEEDED")
            .with_merchant("m-1")
            .with_meta("amount", MetaValue::Text("10.5000".to_owned()))
            .with_meta("count", MetaValue::Integer(3));
        assert_eq!(hit.id, "id-1");
        assert_eq!(hit.merchant_id.as_deref(), Some("m-1"));
        assert_eq!(hit.meta.get("count"), Some(&MetaValue::Integer(3)));
        assert!(hit.operator_case_id.is_none());
        hit.operator_case_id = Some("case-1".to_owned());
        assert_eq!(hit.operator_case_id.as_deref(), Some("case-1"));
    }

    #[test]
    fn a_response_reports_its_providers_in_order() {
        let hit = |provider, id: &str| RankedHit {
            provider,
            hit: SearchHit::new(id, id),
            score: 100,
            timestamp_ms: 0,
        };
        let response = SearchResponse::new(
            "ACME",
            vec![
                hit(SearchType::AuditLog, "a"),
                hit(SearchType::Merchant, "b"),
            ],
            true,
        );
        assert_eq!(response.total, 2);
        assert!(response.partial);
        assert_eq!(response.len(), 2);
        assert_eq!(
            response.providers(),
            vec![SearchType::Merchant, SearchType::AuditLog]
        );
        assert!(SearchResponse::empty("x").is_empty());
    }
}

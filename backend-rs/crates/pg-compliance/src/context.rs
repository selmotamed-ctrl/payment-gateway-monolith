//! The canonical regulatory report context.
//!
//! Port of `core-back/engine/compliance/reporting/CanonicalReportContext.ts` (the value shape that
//! the XML/XLSX/DOCX bindings read) plus the gateway/currency totals the payload builder emits in
//! `aggregates`.
//!
//! Field names are camelCase on the wire, exactly like the TS object: bindings such as
//! `report.periodKey` or `transactions[*].totalChargedAmount` depend on these names.
//! Money is always a plain decimal string with four places ([`money4`]); no float ever appears.

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// `goaml.rentity_id` fallback (provisional configuration).
pub const PROVISIONAL_RENTITY_ID: &str = "PROVISIONAL-CBL-RENTITY";
/// `goaml.rentity_branch` fallback.
pub const PROVISIONAL_RENTITY_BRANCH: &str = "PROVISIONAL";
/// `goaml.submission_code` fallback.
pub const PROVISIONAL_SUBMISSION_CODE: &str = "E";
/// `goaml.local_currency_code` fallback.
pub const PROVISIONAL_LOCAL_CURRENCY_CODE: &str = "LYD";
/// `goaml.reporting_person_name` fallback.
pub const PROVISIONAL_REPORTING_PERSON_NAME: &str = "Compliance Officer";
/// `goaml.reporting_person_email` fallback.
pub const PROVISIONAL_REPORTING_PERSON_EMAIL: &str = "compliance@payment-gateway.internal";

/// `money()`: a four-place decimal string; `null` becomes `"0.0000"`.
#[must_use]
pub fn money4(value: Option<&str>) -> String {
    match value.map(str::trim) {
        None | Some("") => "0.0000".to_owned(),
        Some(text) if text.contains('.') => text.to_owned(),
        Some(text) => format!("{text}.0000"),
    }
}

/// `institution` — the goAML reporting institution.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstitutionContext {
    pub rentity_id: String,
    pub rentity_branch: String,
    pub submission_code: String,
    pub local_currency_code: String,
    pub reporting_person_name: String,
    pub reporting_person_email: String,
}

impl Default for InstitutionContext {
    fn default() -> Self {
        Self {
            rentity_id: PROVISIONAL_RENTITY_ID.to_owned(),
            rentity_branch: PROVISIONAL_RENTITY_BRANCH.to_owned(),
            submission_code: PROVISIONAL_SUBMISSION_CODE.to_owned(),
            local_currency_code: PROVISIONAL_LOCAL_CURRENCY_CODE.to_owned(),
            reporting_person_name: PROVISIONAL_REPORTING_PERSON_NAME.to_owned(),
            reporting_person_email: PROVISIONAL_REPORTING_PERSON_EMAIL.to_owned(),
        }
    }
}

/// `report`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportContextReport {
    pub id: String,
    pub report_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub report_code: Option<String>,
    pub authority: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub period_start: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub period_end: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub period_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due_at: Option<String>,
    #[serde(default)]
    pub required_output_formats: Vec<String>,
}

/// `merchant`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MerchantContext {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub legal_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trade_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registration_no: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tax_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub business_category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub country: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kyb_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub risk_tier: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contact_phone: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contact_email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payout_bank_details: Option<Value>,
}

/// `wallet`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletContext {
    pub id: String,
    pub currency: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

/// `transactions[]` (`attemptContext`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionContext {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_reference: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gateway_reference: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub network_reference: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub substatus: Option<String>,
    /// Four-place decimal string.
    pub amount: String,
    /// Four-place decimal string.
    pub total_charged_amount: String,
    /// Four-place decimal string.
    pub settled_amount: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rail_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rail_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gateway_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gateway_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collection_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payer_phone: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payer_name: Option<String>,
}

impl TransactionContext {
    /// A transaction row with the mandatory amounts defaulted to `"0.0000"`.
    #[must_use]
    pub fn new(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            amount: money4(None),
            total_charged_amount: money4(None),
            settled_amount: money4(None),
            ..Self::default()
        }
    }
}

/// `amlCase`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AmlCaseContext {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub severity: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolution_notes: Option<String>,
}

/// `aggregates.summaryRows[]`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryRow {
    pub metric: String,
    pub value: i64,
}

/// Per-gateway, per-environment, per-currency totals.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayTotals {
    pub gateway_code: String,
    /// `LIVE` / `SANDBOX`.
    pub environment: String,
    pub currency: String,
    pub attempts: u64,
    pub succeeded: u64,
    pub failed: u64,
    pub unknown: u64,
    /// Four-place decimal string.
    pub requested_amount: String,
    /// Four-place decimal string.
    pub total_charged_amount: String,
    /// Four-place decimal string.
    pub settled_amount: String,
}

impl GatewayTotals {
    /// A row with zeroed counts and amounts.
    #[must_use]
    pub fn new(
        gateway_code: impl Into<String>,
        environment: impl Into<String>,
        currency: impl Into<String>,
    ) -> Self {
        Self {
            gateway_code: gateway_code.into(),
            environment: environment.into(),
            currency: currency.into(),
            attempts: 0,
            succeeded: 0,
            failed: 0,
            unknown: 0,
            requested_amount: money4(None),
            total_charged_amount: money4(None),
            settled_amount: money4(None),
        }
    }

    /// The success rate as a percentage with two decimals, `None` when there were no attempts.
    ///
    /// Integer arithmetic only: `succeeded * 10_000 / attempts` basis points, then formatted.
    #[must_use]
    pub fn success_rate_percent(&self) -> Option<String> {
        if self.attempts == 0 {
            return None;
        }
        let basis_points = self.succeeded.saturating_mul(10_000) / self.attempts;
        let whole = basis_points / 100;
        let fraction = basis_points % 100;
        Some(format!("{whole}.{fraction:02}"))
    }
}

/// Per-currency totals with their gateway breakdown.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrencyTotals {
    pub currency: String,
    pub attempts: u64,
    pub succeeded: u64,
    pub failed: u64,
    pub unknown: u64,
    /// Four-place decimal string.
    pub requested_amount: String,
    /// Four-place decimal string.
    pub total_charged_amount: String,
    /// Four-place decimal string.
    pub settled_amount: String,
    #[serde(default)]
    pub gateways: Vec<GatewayTotals>,
}

impl CurrencyTotals {
    /// A row with zeroed counts and amounts.
    #[must_use]
    pub fn new(currency: impl Into<String>) -> Self {
        Self {
            currency: currency.into(),
            attempts: 0,
            succeeded: 0,
            failed: 0,
            unknown: 0,
            requested_amount: money4(None),
            total_charged_amount: money4(None),
            settled_amount: money4(None),
            gateways: Vec::new(),
        }
    }

    /// Recomputes the integer counts from the gateway breakdown (amounts stay as supplied, because
    /// decimal addition belongs to the reporting payload builder).
    pub fn recompute_counts(&mut self) {
        self.attempts = self.gateways.iter().map(|gateway| gateway.attempts).sum();
        self.succeeded = self.gateways.iter().map(|gateway| gateway.succeeded).sum();
        self.failed = self.gateways.iter().map(|gateway| gateway.failed).sum();
        self.unknown = self.gateways.iter().map(|gateway| gateway.unknown).sum();
    }
}

/// `aggregates` — the queryable section payload plus the gateway/currency totals.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Aggregates {
    #[serde(default)]
    pub gateway_totals: Vec<GatewayTotals>,
    #[serde(default)]
    pub currency_totals: Vec<CurrencyTotals>,
    #[serde(default)]
    pub summary_rows: Vec<SummaryRow>,
    #[serde(default)]
    pub payment_rails: Vec<Value>,
    /// The remaining `payload.sections` keys, unchanged.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// `CanonicalReportContext`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalReportContext {
    #[serde(default)]
    pub institution: InstitutionContext,
    pub report: ReportContextReport,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merchant: Option<MerchantContext>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wallet: Option<WalletContext>,
    #[serde(default)]
    pub transactions: Vec<TransactionContext>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aml_case: Option<AmlCaseContext>,
    #[serde(default)]
    pub indicators: Vec<Value>,
    #[serde(default)]
    pub aggregates: Aggregates,
    #[serde(default)]
    pub narrative: Map<String, Value>,
    #[serde(default)]
    pub pending: Vec<String>,
}

impl CanonicalReportContext {
    /// A context for a report with the provisional institution settings.
    #[must_use]
    pub fn new(report: ReportContextReport) -> Self {
        Self {
            institution: InstitutionContext::default(),
            report,
            merchant: None,
            wallet: None,
            transactions: Vec::new(),
            aml_case: None,
            indicators: Vec::new(),
            aggregates: Aggregates::default(),
            narrative: Map::new(),
            pending: Vec::new(),
        }
    }

    /// True when the payload still has sections the generator could not fill.
    #[must_use]
    pub fn has_pending_sections(&self) -> bool {
        !self.pending.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn report() -> ReportContextReport {
        ReportContextReport {
            id: "r-1".to_owned(),
            report_type: "PSP-M".to_owned(),
            report_code: Some("PSP-M".to_owned()),
            authority: "CBL".to_owned(),
            period_start: Some("2026-09-30T22:00:00.000Z".to_owned()),
            period_end: Some("2026-10-31T22:00:00.000Z".to_owned()),
            period_key: Some("2026-10".to_owned()),
            due_at: Some("2026-11-20T22:00:00.000Z".to_owned()),
            required_output_formats: vec!["XML".to_owned(), "XLSX".to_owned()],
        }
    }

    #[test]
    fn money_is_always_four_places() {
        assert_eq!(money4(None), "0.0000");
        assert_eq!(money4(Some("")), "0.0000");
        assert_eq!(money4(Some("12")), "12.0000");
        assert_eq!(money4(Some("12.5")), "12.5");
        assert_eq!(money4(Some(" 1500.0000 ")), "1500.0000");
    }

    #[test]
    fn the_institution_defaults_are_the_provisional_goaml_values() {
        let institution = InstitutionContext::default();
        assert_eq!(institution.rentity_id, PROVISIONAL_RENTITY_ID);
        assert_eq!(institution.rentity_branch, "PROVISIONAL");
        assert_eq!(institution.submission_code, "E");
        assert_eq!(institution.local_currency_code, "LYD");
        assert!(institution.reporting_person_email.contains('@'));
    }

    #[test]
    fn serde_names_match_the_ts_bindings() {
        let mut context = CanonicalReportContext::new(report());
        context.transactions.push(TransactionContext {
            reference: Some("ATT-1".to_owned()),
            amount: money4(Some("10")),
            total_charged_amount: money4(Some("10.5")),
            settled_amount: money4(Some("10.5")),
            currency: Some("LYD".to_owned()),
            ..TransactionContext::new("a-1")
        });
        context.merchant = Some(MerchantContext {
            id: "m-1".to_owned(),
            trade_name: Some("ACME".to_owned()),
            ..MerchantContext::default()
        });
        context.wallet = Some(WalletContext {
            id: "w-1".to_owned(),
            currency: "LYD".to_owned(),
            status: Some("ACTIVE".to_owned()),
        });
        context.pending = vec!["suspiciousActivity".to_owned()];
        context.aggregates.summary_rows = vec![SummaryRow {
            metric: "Attempts".to_owned(),
            value: 12,
        }];
        context
            .narrative
            .insert("summary".to_owned(), json!("A monthly return"));

        let value = serde_json::to_value(&context).expect("serialises");
        assert_eq!(value["institution"]["rentityId"], PROVISIONAL_RENTITY_ID);
        assert_eq!(value["report"]["periodKey"], "2026-10");
        assert_eq!(value["report"]["requiredOutputFormats"][0], "XML");
        assert_eq!(value["merchant"]["tradeName"], "ACME");
        assert_eq!(value["wallet"]["currency"], "LYD");
        assert_eq!(value["transactions"][0]["totalChargedAmount"], "10.5");
        assert_eq!(value["transactions"][0]["reference"], "ATT-1");
        assert_eq!(value["aggregates"]["summaryRows"][0]["metric"], "Attempts");
        assert_eq!(value["narrative"]["summary"], "A monthly return");
        assert_eq!(value["pending"][0], "suspiciousActivity");
        assert!(value.get("amlCase").is_none());
        assert!(context.has_pending_sections());
    }

    #[test]
    fn gateway_and_currency_totals_use_integer_counts() {
        let mut gateway = GatewayTotals::new("edfali", "LIVE", "LYD");
        gateway.attempts = 3;
        gateway.succeeded = 2;
        gateway.failed = 1;
        gateway.total_charged_amount = money4(Some("300"));
        assert_eq!(gateway.success_rate_percent().as_deref(), Some("66.66"));
        assert_eq!(
            GatewayTotals::new("edfali", "LIVE", "LYD").success_rate_percent(),
            None
        );

        let mut currency = CurrencyTotals::new("LYD");
        currency.gateways = vec![gateway.clone(), {
            let mut second = GatewayTotals::new("sadad", "LIVE", "LYD");
            second.attempts = 7;
            second.succeeded = 6;
            second.failed = 1;
            second
        }];
        currency.recompute_counts();
        assert_eq!(currency.attempts, 10);
        assert_eq!(currency.succeeded, 8);
        assert_eq!(currency.failed, 2);
        assert_eq!(currency.unknown, 0);
        assert_eq!(currency.total_charged_amount, "0.0000");

        let aggregates = Aggregates {
            gateway_totals: vec![gateway],
            currency_totals: vec![currency],
            payment_rails: vec![json!({"rail": "edfali", "attempts": 3})],
            ..Aggregates::default()
        };
        let value = serde_json::to_value(&aggregates).expect("serialises");
        assert_eq!(value["gatewayTotals"][0]["attempts"], 3);
        assert_eq!(
            value["currencyTotals"][0]["gateways"][1]["gatewayCode"],
            "sadad"
        );
        assert_eq!(value["paymentRails"][0]["rail"], "edfali");
    }

    #[test]
    fn extra_aggregate_sections_are_preserved() {
        let mut aggregates = Aggregates::default();
        aggregates.extra.insert(
            "refunds".to_owned(),
            json!({"2026-10::LYD": {"count": 2, "amount": "20.0000"}}),
        );
        let value = serde_json::to_value(&aggregates).expect("serialises");
        assert_eq!(value["refunds"]["2026-10::LYD"]["count"], 2);
        let round_trip: Aggregates = serde_json::from_value(value).expect("deserialises");
        assert_eq!(
            round_trip.extra["refunds"]["2026-10::LYD"]["amount"],
            "20.0000"
        );
    }
}

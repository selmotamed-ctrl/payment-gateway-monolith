//! The twenty emulated rails, the default healthy chaos baseline and the deterministic PRNG.
//!
//! TS: `engine/chaos/{DefaultRailScenarios,ChaosEvaluator,prng,scenarioStore}.ts`.

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::db::{now_iso, text, Db};
use crate::error::ApiResult;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FailureMode {
    #[serde(rename = "TERMINAL_DECLINE_INSUFFICIENT_FUNDS")]
    TerminalDeclineInsufficientFunds,
    #[serde(rename = "LIMIT_EXCEEDED_CUSTOMER_CEILING")]
    LimitExceededCustomerCeiling,
    #[serde(rename = "WRONG_OTP_RETRYABLE")]
    WrongOtpRetryable,
    #[serde(rename = "HTTP_500_GATEWAY_FAULT")]
    Http500GatewayFault,
    #[serde(rename = "TIMEOUT_HANG_ABOVE_STEP_TTL")]
    TimeoutHangAboveStepTtl,
    #[serde(rename = "SOCKET_RESET_MID_STREAM")]
    SocketResetMidStream,
    #[serde(rename = "MALFORMED_OR_UNMAPPED_200_BODY")]
    MalformedOrUnmapped200Body,
    #[serde(rename = "RATE_LIMIT_HTTP_429")]
    RateLimitHttp429,
    #[serde(rename = "AMOUNT_ROUNDING_MISMATCH")]
    AmountRoundingMismatch,
    #[serde(rename = "CONFLICTING_WEBHOOK_VS_INQUIRY")]
    ConflictingWebhookVsInquiry,
}

impl FailureMode {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TerminalDeclineInsufficientFunds => "TERMINAL_DECLINE_INSUFFICIENT_FUNDS",
            Self::LimitExceededCustomerCeiling => "LIMIT_EXCEEDED_CUSTOMER_CEILING",
            Self::WrongOtpRetryable => "WRONG_OTP_RETRYABLE",
            Self::Http500GatewayFault => "HTTP_500_GATEWAY_FAULT",
            Self::TimeoutHangAboveStepTtl => "TIMEOUT_HANG_ABOVE_STEP_TTL",
            Self::SocketResetMidStream => "SOCKET_RESET_MID_STREAM",
            Self::MalformedOrUnmapped200Body => "MALFORMED_OR_UNMAPPED_200_BODY",
            Self::RateLimitHttp429 => "RATE_LIMIT_HTTP_429",
            Self::AmountRoundingMismatch => "AMOUNT_ROUNDING_MISMATCH",
            Self::ConflictingWebhookVsInquiry => "CONFLICTING_WEBHOOK_VS_INQUIRY",
        }
    }

    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        ALL_FAILURE_MODES
            .iter()
            .copied()
            .find(|mode| mode.as_str() == value)
    }
}

pub const ALL_FAILURE_MODES: [FailureMode; 10] = [
    FailureMode::TerminalDeclineInsufficientFunds,
    FailureMode::LimitExceededCustomerCeiling,
    FailureMode::WrongOtpRetryable,
    FailureMode::Http500GatewayFault,
    FailureMode::TimeoutHangAboveStepTtl,
    FailureMode::SocketResetMidStream,
    FailureMode::MalformedOrUnmapped200Body,
    FailureMode::RateLimitHttp429,
    FailureMode::AmountRoundingMismatch,
    FailureMode::ConflictingWebhookVsInquiry,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FailPhase {
    #[serde(rename = "INITIATE")]
    Initiate,
    #[serde(rename = "SUBMIT")]
    Submit,
    #[serde(rename = "VERIFY")]
    Verify,
    #[serde(rename = "WEBHOOK")]
    Webhook,
    #[serde(rename = "REFUND")]
    Refund,
}

impl FailPhase {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Initiate => "INITIATE",
            Self::Submit => "SUBMIT",
            Self::Verify => "VERIFY",
            Self::Webhook => "WEBHOOK",
            Self::Refund => "REFUND",
        }
    }

    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "INITIATE" => Some(Self::Initiate),
            "SUBMIT" => Some(Self::Submit),
            "VERIFY" => Some(Self::Verify),
            "WEBHOOK" => Some(Self::Webhook),
            "REFUND" => Some(Self::Refund),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PhaseBreakdown {
    #[serde(
        rename = "initiateFailWeight",
        alias = "initiate_fail_weight",
        default = "weight20"
    )]
    pub initiate_fail_weight: f64,
    #[serde(
        rename = "submitFailWeight",
        alias = "submit_fail_weight",
        default = "weight40"
    )]
    pub submit_fail_weight: f64,
    #[serde(
        rename = "verifyFailWeight",
        alias = "verify_fail_weight",
        default = "weight15"
    )]
    pub verify_fail_weight: f64,
    #[serde(
        rename = "webhookFailWeight",
        alias = "webhook_fail_weight",
        default = "weight15"
    )]
    pub webhook_fail_weight: f64,
    #[serde(
        rename = "refundFailWeight",
        alias = "refund_fail_weight",
        default = "weight10"
    )]
    pub refund_fail_weight: f64,
}

fn weight10() -> f64 {
    10.0
}
fn weight15() -> f64 {
    15.0
}
fn weight20() -> f64 {
    20.0
}
fn weight40() -> f64 {
    40.0
}

impl Default for PhaseBreakdown {
    fn default() -> Self {
        Self {
            initiate_fail_weight: 20.0,
            submit_fail_weight: 40.0,
            verify_fail_weight: 15.0,
            webhook_fail_weight: 15.0,
            refund_fail_weight: 10.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FailureModeWeights {
    #[serde(rename = "TERMINAL_DECLINE_INSUFFICIENT_FUNDS", default = "weight18")]
    pub terminal_decline_insufficient_funds: f64,
    #[serde(rename = "LIMIT_EXCEEDED_CUSTOMER_CEILING", default = "weight8")]
    pub limit_exceeded_customer_ceiling: f64,
    #[serde(rename = "WRONG_OTP_RETRYABLE", default = "weight12")]
    pub wrong_otp_retryable: f64,
    #[serde(rename = "HTTP_500_GATEWAY_FAULT", default = "weight14")]
    pub http_500_gateway_fault: f64,
    #[serde(rename = "TIMEOUT_HANG_ABOVE_STEP_TTL", default = "weight14")]
    pub timeout_hang_above_step_ttl: f64,
    #[serde(rename = "SOCKET_RESET_MID_STREAM", default = "weight8")]
    pub socket_reset_mid_stream: f64,
    #[serde(rename = "MALFORMED_OR_UNMAPPED_200_BODY", default = "weight8")]
    pub malformed_or_unmapped_200_body: f64,
    #[serde(rename = "RATE_LIMIT_HTTP_429", default = "weight6")]
    pub rate_limit_http_429: f64,
    #[serde(rename = "AMOUNT_ROUNDING_MISMATCH", default = "weight6")]
    pub amount_rounding_mismatch: f64,
    #[serde(rename = "CONFLICTING_WEBHOOK_VS_INQUIRY", default = "weight6")]
    pub conflicting_webhook_vs_inquiry: f64,
}

fn weight6() -> f64 {
    6.0
}
fn weight8() -> f64 {
    8.0
}
fn weight12() -> f64 {
    12.0
}
fn weight14() -> f64 {
    14.0
}
fn weight18() -> f64 {
    18.0
}

impl Default for FailureModeWeights {
    fn default() -> Self {
        Self {
            terminal_decline_insufficient_funds: 18.0,
            limit_exceeded_customer_ceiling: 8.0,
            wrong_otp_retryable: 12.0,
            http_500_gateway_fault: 14.0,
            timeout_hang_above_step_ttl: 14.0,
            socket_reset_mid_stream: 8.0,
            malformed_or_unmapped_200_body: 8.0,
            rate_limit_http_429: 6.0,
            amount_rounding_mismatch: 6.0,
            conflicting_webhook_vs_inquiry: 6.0,
        }
    }
}

impl FailureModeWeights {
    pub fn entries(&self) -> Vec<(FailureMode, f64)> {
        vec![
            (
                FailureMode::TerminalDeclineInsufficientFunds,
                self.terminal_decline_insufficient_funds,
            ),
            (
                FailureMode::LimitExceededCustomerCeiling,
                self.limit_exceeded_customer_ceiling,
            ),
            (FailureMode::WrongOtpRetryable, self.wrong_otp_retryable),
            (
                FailureMode::Http500GatewayFault,
                self.http_500_gateway_fault,
            ),
            (
                FailureMode::TimeoutHangAboveStepTtl,
                self.timeout_hang_above_step_ttl,
            ),
            (
                FailureMode::SocketResetMidStream,
                self.socket_reset_mid_stream,
            ),
            (
                FailureMode::MalformedOrUnmapped200Body,
                self.malformed_or_unmapped_200_body,
            ),
            (FailureMode::RateLimitHttp429, self.rate_limit_http_429),
            (
                FailureMode::AmountRoundingMismatch,
                self.amount_rounding_mismatch,
            ),
            (
                FailureMode::ConflictingWebhookVsInquiry,
                self.conflicting_webhook_vs_inquiry,
            ),
        ]
    }

    pub fn set(&mut self, mode: FailureMode, weight: f64) {
        match mode {
            FailureMode::TerminalDeclineInsufficientFunds => {
                self.terminal_decline_insufficient_funds = weight;
            }
            FailureMode::LimitExceededCustomerCeiling => {
                self.limit_exceeded_customer_ceiling = weight;
            }
            FailureMode::WrongOtpRetryable => self.wrong_otp_retryable = weight,
            FailureMode::Http500GatewayFault => self.http_500_gateway_fault = weight,
            FailureMode::TimeoutHangAboveStepTtl => self.timeout_hang_above_step_ttl = weight,
            FailureMode::SocketResetMidStream => self.socket_reset_mid_stream = weight,
            FailureMode::MalformedOrUnmapped200Body => self.malformed_or_unmapped_200_body = weight,
            FailureMode::RateLimitHttp429 => self.rate_limit_http_429 = weight,
            FailureMode::AmountRoundingMismatch => self.amount_rounding_mismatch = weight,
            FailureMode::ConflictingWebhookVsInquiry => {
                self.conflicting_webhook_vs_inquiry = weight;
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebhookBehavior {
    #[serde(rename = "delaySeconds", alias = "delay_seconds", default)]
    pub delay_seconds: f64,
    #[serde(rename = "duplicateCount", alias = "duplicate_count", default = "one")]
    pub duplicate_count: f64,
    #[serde(
        rename = "outOfOrderPendingAfterPaid",
        alias = "out_of_order_pending_after_paid",
        default
    )]
    pub out_of_order_pending_after_paid: bool,
    #[serde(
        rename = "corruptSignatureChancePercent",
        alias = "corrupt_signature_chance_percent",
        default
    )]
    pub corrupt_signature_chance_percent: f64,
}

fn one() -> f64 {
    1.0
}

impl Default for WebhookBehavior {
    fn default() -> Self {
        Self {
            delay_seconds: 0.0,
            duplicate_count: 1.0,
            out_of_order_pending_after_paid: false,
            corrupt_signature_chance_percent: 0.0,
        }
    }
}

fn zero() -> f64 {
    0.0
}

fn latency_min() -> f64 {
    40.0
}

fn latency_max() -> f64 {
    250.0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Latency {
    #[serde(default = "latency_min")]
    pub min: f64,
    #[serde(default = "latency_max")]
    pub max: f64,
}

impl Default for Latency {
    fn default() -> Self {
        Self {
            min: 40.0,
            max: 250.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Scenario {
    #[serde(rename = "railCode")]
    pub rail_code: String,
    #[serde(rename = "gatewayCode")]
    pub gateway_code: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(rename = "overallFailureChancePercent", default = "zero")]
    pub overall_failure_chance_percent: f64,
    #[serde(rename = "phaseBreakdown", default)]
    pub phase_breakdown: PhaseBreakdown,
    #[serde(rename = "failureModeWeights", default)]
    pub failure_mode_weights: FailureModeWeights,
    #[serde(rename = "latencyMs", default)]
    pub latency_ms: Latency,
    #[serde(rename = "autoApproveAsyncAfterSec", default)]
    pub auto_approve_async_after_sec: Option<f64>,
    #[serde(rename = "webhookBehavior", default)]
    pub webhook_behavior: WebhookBehavior,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Copy)]
pub struct RailDescriptor {
    pub rail_code: &'static str,
    pub gateway_code: &'static str,
    pub name: &'static str,
    pub collection_modes: &'static [&'static str],
    pub aliases: &'static [&'static str],
    pub default_otp: &'static str,
    pub otp_length: usize,
}

pub static RAIL_DESCRIPTORS: [RailDescriptor; 20] = [
    RailDescriptor {
        rail_code: "edfali",
        gateway_code: "edfali",
        name: "Edfali",
        collection_modes: &["OTP_PULL"],
        aliases: &["edfali"],
        default_otp: "1234",
        otp_length: 4,
    },
    RailDescriptor {
        rail_code: "sadad",
        gateway_code: "sadad",
        name: "Sadad",
        collection_modes: &["OTP_PULL"],
        aliases: &["sadad"],
        default_otp: "123456",
        otp_length: 6,
    },
    RailDescriptor {
        rail_code: "mobicash",
        gateway_code: "mobicash",
        name: "MobiCash",
        collection_modes: &["OTP_PULL", "QR_DISPLAY"],
        aliases: &["mobicash"],
        default_otp: "123456",
        otp_length: 6,
    },
    RailDescriptor {
        rail_code: "moamalat",
        gateway_code: "moamalat",
        name: "Moamalat NPG",
        collection_modes: &["EMBEDDED", "REDIRECT"],
        aliases: &["moamalat", "moamalat_card"],
        default_otp: "123456",
        otp_length: 6,
    },
    RailDescriptor {
        rail_code: "ly_pay",
        gateway_code: "cbl_lypay",
        name: "CBL LYPay",
        collection_modes: &["QR_DISPLAY", "PUSH_APPROVAL"],
        aliases: &["ly_pay", "lypay", "cbl_lypay"],
        default_otp: "123456",
        otp_length: 6,
    },
    RailDescriptor {
        rail_code: "onepay",
        gateway_code: "onepay",
        name: "OnePay",
        collection_modes: &["QR_DISPLAY", "PAY_CODE", "OTP_PULL"],
        aliases: &["onepay"],
        default_otp: "123456",
        otp_length: 6,
    },
    RailDescriptor {
        rail_code: "tlync",
        gateway_code: "tlync",
        name: "Tadawul T-LYNC",
        collection_modes: &["REDIRECT"],
        aliases: &["tlync"],
        default_otp: "123456",
        otp_length: 6,
    },
    RailDescriptor {
        rail_code: "mypay",
        gateway_code: "mypay",
        name: "MyPay",
        collection_modes: &["REDIRECT"],
        aliases: &["mypay"],
        default_otp: "123456",
        otp_length: 6,
    },
    RailDescriptor {
        rail_code: "dpay",
        gateway_code: "dpay",
        name: "DPay",
        collection_modes: &["REDIRECT", "OTP_PULL", "EMBEDDED"],
        aliases: &["dpay"],
        default_otp: "123456",
        otp_length: 6,
    },
    RailDescriptor {
        rail_code: "plutu",
        gateway_code: "plutu",
        name: "Plutu",
        collection_modes: &["OTP_PULL", "REDIRECT"],
        aliases: &["plutu"],
        default_otp: "123456",
        otp_length: 6,
    },
    RailDescriptor {
        rail_code: "yussor_pay",
        gateway_code: "yussor",
        name: "Yussor Pay",
        collection_modes: &["HYBRID", "OTP_PULL", "QR_DISPLAY", "PAY_CODE"],
        aliases: &["yussor_pay", "yussor"],
        default_otp: "123456",
        otp_length: 6,
    },
    RailDescriptor {
        rail_code: "sahara_pay",
        gateway_code: "sahara",
        name: "Sahara Pay",
        collection_modes: &["HYBRID", "OTP_PULL", "QR_DISPLAY", "PAY_CODE"],
        aliases: &["sahara_pay", "sahara"],
        default_otp: "123456",
        otp_length: 6,
    },
    RailDescriptor {
        rail_code: "masrefy_pay",
        gateway_code: "masrefy",
        name: "Masrefy Pay",
        collection_modes: &["HYBRID", "OTP_PULL", "QR_DISPLAY", "PAY_CODE"],
        aliases: &["masrefy_pay", "masrefy"],
        default_otp: "123456",
        otp_length: 6,
    },
    RailDescriptor {
        rail_code: "hawelli",
        gateway_code: "hawelli",
        name: "Hawelli",
        collection_modes: &["PUSH_APPROVAL", "QR_DISPLAY", "OTP_PULL", "DEEP_LINK"],
        aliases: &["hawelli"],
        default_otp: "123456",
        otp_length: 6,
    },
    RailDescriptor {
        rail_code: "gpay_libya",
        gateway_code: "gpay_libya",
        name: "GPay Libya",
        collection_modes: &["PUSH_APPROVAL", "QR_DISPLAY", "OTP_PULL", "DEEP_LINK"],
        aliases: &["gpay_libya", "gpay"],
        default_otp: "123456",
        otp_length: 6,
    },
    RailDescriptor {
        rail_code: "numo_pay",
        gateway_code: "numo_pay",
        name: "Numo Pay",
        collection_modes: &["PUSH_APPROVAL", "QR_DISPLAY", "OTP_PULL", "DEEP_LINK"],
        aliases: &["numo_pay", "numo"],
        default_otp: "123456",
        otp_length: 6,
    },
    RailDescriptor {
        rail_code: "libyana",
        gateway_code: "libyana",
        name: "Libyana",
        collection_modes: &["PUSH_APPROVAL", "QR_DISPLAY", "OTP_PULL", "DEEP_LINK"],
        aliases: &["libyana"],
        default_otp: "123456",
        otp_length: 6,
    },
    RailDescriptor {
        rail_code: "mpgs",
        gateway_code: "mpgs",
        name: "MPGS (Visa/Mastercard)",
        collection_modes: &["EMBEDDED", "REDIRECT"],
        aliases: &["mpgs"],
        default_otp: "123456",
        otp_length: 6,
    },
    RailDescriptor {
        rail_code: "evopay",
        gateway_code: "evo_pay",
        name: "Evo Pay",
        collection_modes: &["QR_DISPLAY", "PUSH_APPROVAL"],
        aliases: &["evopay", "evo_pay"],
        default_otp: "123456",
        otp_length: 6,
    },
    RailDescriptor {
        rail_code: "neompay",
        gateway_code: "neompay",
        name: "NeomPay",
        collection_modes: &["HYBRID"],
        aliases: &["neompay", "neompay_wallet"],
        default_otp: "123456",
        otp_length: 6,
    },
];

#[must_use]
pub fn resolve_rail(code: &str) -> Option<&'static RailDescriptor> {
    let needle = code.trim().to_ascii_lowercase();
    RAIL_DESCRIPTORS.iter().find(|rail| {
        rail.rail_code == needle
            || rail.gateway_code == needle
            || rail.aliases.iter().any(|alias| *alias == needle)
    })
}

#[must_use]
pub fn canonical_rail_code(code: &str) -> String {
    resolve_rail(code).map_or_else(
        || code.trim().to_ascii_lowercase(),
        |rail| rail.rail_code.to_owned(),
    )
}

#[must_use]
pub fn default_scenario(rail: &RailDescriptor) -> Scenario {
    Scenario {
        rail_code: rail.rail_code.to_owned(),
        gateway_code: rail.gateway_code.to_owned(),
        enabled: true,
        overall_failure_chance_percent: 0.0,
        phase_breakdown: PhaseBreakdown::default(),
        failure_mode_weights: FailureModeWeights::default(),
        latency_ms: Latency::default(),
        auto_approve_async_after_sec: None,
        webhook_behavior: WebhookBehavior::default(),
    }
}

pub fn ensure_default_scenarios(db: &Db) -> ApiResult<()> {
    for rail in &RAIL_DESCRIPTORS {
        let scenario = default_scenario(rail);
        let config = serde_json::to_string(&scenario).unwrap_or_default();
        db.execute(
            "INSERT OR IGNORE INTO fake_rail_scenarios (rail_code, gateway_code, config_json, updated_at)
             VALUES (?,?,?,?)",
            vec![
                text(rail.rail_code),
                text(rail.gateway_code),
                text(config),
                text(now_iso()),
            ],
        )?;
    }
    Ok(())
}

pub fn list_scenarios(db: &Db) -> ApiResult<Vec<Scenario>> {
    ensure_default_scenarios(db)?;
    let rows = db.query_json(
        "SELECT config_json FROM fake_rail_scenarios ORDER BY rail_code ASC",
        vec![],
    )?;
    Ok(rows
        .iter()
        .filter_map(|row| row.get("config_json").and_then(Value::as_str))
        .filter_map(|raw| serde_json::from_str::<Scenario>(raw).ok())
        .collect())
}

pub fn get_scenario(db: &Db, code: &str) -> ApiResult<Scenario> {
    ensure_default_scenarios(db)?;
    let canonical = canonical_rail_code(code);
    let row = db.query_one_json(
        "SELECT config_json FROM fake_rail_scenarios WHERE rail_code = ?",
        vec![text(canonical.clone())],
    )?;
    if let Some(scenario) = row
        .and_then(|row| row.get("config_json").cloned())
        .and_then(|value| value.as_str().map(str::to_owned))
        .and_then(|raw| serde_json::from_str::<Scenario>(&raw).ok())
    {
        return Ok(scenario);
    }
    Ok(resolve_rail(code).map_or_else(|| default_scenario(&RAIL_DESCRIPTORS[0]), default_scenario))
}

pub fn save_scenario(db: &Db, scenario: &Scenario) -> ApiResult<Scenario> {
    ensure_default_scenarios(db)?;
    let canonical = canonical_rail_code(&scenario.rail_code);
    let gateway = resolve_rail(&canonical)
        .map(|rail| rail.gateway_code.to_owned())
        .unwrap_or_else(|| scenario.gateway_code.clone());
    let mut normalized = scenario.clone();
    normalized.rail_code.clone_from(&canonical);
    normalized.gateway_code = gateway;
    normalized.overall_failure_chance_percent =
        normalized.overall_failure_chance_percent.clamp(0.0, 100.0);
    let config = serde_json::to_string(&normalized)?;
    db.execute(
        "INSERT INTO fake_rail_scenarios (rail_code, gateway_code, config_json, updated_at)
         VALUES (?,?,?,?)
         ON CONFLICT(rail_code) DO UPDATE SET gateway_code = excluded.gateway_code,
           config_json = excluded.config_json, updated_at = excluded.updated_at",
        vec![
            text(normalized.rail_code.clone()),
            text(normalized.gateway_code.clone()),
            text(config),
            text(now_iso()),
        ],
    )?;
    Ok(normalized)
}

pub fn reset_all_scenarios(db: &Db) -> ApiResult<Vec<Scenario>> {
    db.execute("DELETE FROM fake_rail_scenarios", vec![])?;
    ensure_default_scenarios(db)?;
    list_scenarios(db)
}

/// mulberry32, exactly as `engine/chaos/prng.ts`.
pub struct Prng {
    state: u32,
}

impl Prng {
    #[must_use]
    pub fn new(seed: &str) -> Self {
        Self {
            state: hash_string(seed),
        }
    }

    #[must_use]
    pub fn from_u32(seed: u32) -> Self {
        Self { state: seed }
    }

    pub fn next_f64(&mut self) -> f64 {
        self.state = self.state.wrapping_add(0x6d2b_79f5);
        let mut t = self.state;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }

    #[must_use]
    pub fn int(&mut self, min: i64, max: i64) -> i64 {
        let span = (max - min + 1) as f64;
        (self.next_f64() * span).floor() as i64 + min
    }

    #[must_use]
    pub fn chance(&mut self, percent: f64) -> bool {
        self.next_f64() * 100.0 < percent
    }

    pub fn weighted<T: Copy>(&mut self, entries: &[(T, f64)]) -> Option<T> {
        let filtered: Vec<(T, f64)> = entries
            .iter()
            .copied()
            .filter(|(_, weight)| *weight > 0.0)
            .collect();
        if filtered.is_empty() {
            return None;
        }
        let total: f64 = filtered.iter().map(|(_, weight)| *weight).sum();
        let mut roll = self.next_f64() * total;
        for (value, weight) in &filtered {
            roll -= *weight;
            if roll <= 0.0 {
                return Some(*value);
            }
        }
        filtered.last().map(|(value, _)| *value)
    }
}

/// FNV-1a over UTF-16 code units (JS `charCodeAt`), folded to u32.
#[must_use]
pub fn hash_string(value: &str) -> u32 {
    let mut hash: u32 = 2_166_136_261;
    for unit in value.encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(16_777_619);
    }
    hash
}

#[derive(Debug, Clone, PartialEq)]
pub struct MagicTrigger {
    pub failure_mode: FailureMode,
    pub phase: FailPhase,
    pub reason: &'static str,
}

const OTP_TRIGGERS: [(&str, FailureMode, &str); 5] = [
    ("000000", FailureMode::WrongOtpRetryable, "magic OTP 000000"),
    ("0000", FailureMode::WrongOtpRetryable, "magic OTP 0000"),
    (
        "999999",
        FailureMode::TerminalDeclineInsufficientFunds,
        "magic OTP 999999",
    ),
    (
        "500500",
        FailureMode::Http500GatewayFault,
        "magic OTP 500500",
    ),
    (
        "408408",
        FailureMode::TimeoutHangAboveStepTtl,
        "magic OTP 408408",
    ),
];

const PHONE_SUFFIX_TRIGGERS: [(&str, FailureMode, &str); 5] = [
    (
        "9901",
        FailureMode::TerminalDeclineInsufficientFunds,
        "magic phone 9901",
    ),
    (
        "9902",
        FailureMode::LimitExceededCustomerCeiling,
        "magic phone 9902",
    ),
    ("9905", FailureMode::Http500GatewayFault, "magic phone 9905"),
    (
        "9906",
        FailureMode::TimeoutHangAboveStepTtl,
        "magic phone 9906",
    ),
    (
        "9907",
        FailureMode::MalformedOrUnmapped200Body,
        "magic phone 9907",
    ),
];

fn flatten(value: &Value, output: &mut Vec<String>) {
    match value {
        Value::Null => {}
        Value::String(text) => output.push(text.clone()),
        Value::Number(number) => output.push(number.to_string()),
        Value::Bool(flag) => output.push(flag.to_string()),
        Value::Array(items) => {
            for item in items {
                flatten(item, output);
            }
        }
        Value::Object(object) => {
            for item in object.values() {
                flatten(item, output);
            }
        }
    }
}

fn digits_only(value: &str) -> String {
    value.chars().filter(char::is_ascii_digit).collect()
}

fn token_delimited(haystack: &str, needle: &str) -> bool {
    let bytes = haystack.as_bytes();
    let needle_bytes = needle.as_bytes();
    let mut index = 0usize;
    while index + needle_bytes.len() <= bytes.len() {
        if &bytes[index..index + needle_bytes.len()] == needle_bytes {
            let before_ok = index == 0 || !bytes[index - 1].is_ascii_digit();
            let after = index + needle_bytes.len();
            let after_ok = after == bytes.len() || !bytes[after].is_ascii_digit();
            if before_ok && after_ok {
                return true;
            }
        }
        index += 1;
    }
    false
}

/// Deterministic magic inputs (the 15-scenario sandbox contract).
#[must_use]
pub fn detect_magic_trigger(body: &Value, raw_body: &str) -> Option<MagicTrigger> {
    let mut values = Vec::new();
    flatten(body, &mut values);
    values.push(raw_body.to_owned());
    let joined = values.join(" ");
    for value in &values {
        let trimmed = value.trim();
        if let Some((_, mode, reason)) = OTP_TRIGGERS.iter().find(|(otp, _, _)| *otp == trimmed) {
            return Some(MagicTrigger {
                failure_mode: *mode,
                phase: FailPhase::Submit,
                reason,
            });
        }
    }
    for (otp, mode, reason) in OTP_TRIGGERS {
        if token_delimited(&joined, otp) {
            return Some(MagicTrigger {
                failure_mode: mode,
                phase: FailPhase::Submit,
                reason,
            });
        }
    }
    for value in &values {
        let digits = digits_only(value);
        if let Some((_, mode, reason)) = PHONE_SUFFIX_TRIGGERS
            .iter()
            .find(|(suffix, _, _)| digits.ends_with(*suffix))
        {
            return Some(MagicTrigger {
                failure_mode: *mode,
                phase: FailPhase::Submit,
                reason,
            });
        }
    }
    None
}

#[derive(Debug, Clone, PartialEq)]
pub struct FateAssignment {
    pub assigned_fail_phase: Option<FailPhase>,
    pub assigned_failure_mode: Option<FailureMode>,
    pub source: &'static str,
}

/// Rolls the fate of a brand-new transaction once, reproducibly for the same seed.
#[must_use]
pub fn assign_fate(config: &Scenario, seed: &str) -> FateAssignment {
    if config.overall_failure_chance_percent <= 0.0 {
        return FateAssignment {
            assigned_fail_phase: None,
            assigned_failure_mode: None,
            source: "NONE",
        };
    }
    let mut prng = Prng::new(seed);
    if !prng.chance(config.overall_failure_chance_percent) {
        return FateAssignment {
            assigned_fail_phase: None,
            assigned_failure_mode: None,
            source: "NONE",
        };
    }
    let phases = [
        (
            FailPhase::Initiate,
            config.phase_breakdown.initiate_fail_weight,
        ),
        (FailPhase::Submit, config.phase_breakdown.submit_fail_weight),
        (FailPhase::Verify, config.phase_breakdown.verify_fail_weight),
        (
            FailPhase::Webhook,
            config.phase_breakdown.webhook_fail_weight,
        ),
        (FailPhase::Refund, config.phase_breakdown.refund_fail_weight),
    ];
    let phase = prng.weighted(&phases);
    let mode = prng.weighted(&config.failure_mode_weights.entries());
    match (phase, mode) {
        (Some(phase), Some(mode)) => FateAssignment {
            assigned_fail_phase: Some(phase),
            assigned_failure_mode: Some(mode),
            source: "PROBABILITY",
        },
        _ => FateAssignment {
            assigned_fail_phase: None,
            assigned_failure_mode: None,
            source: "NONE",
        },
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChaosDecision {
    pub failure_mode: FailureMode,
    pub phase: FailPhase,
    pub source: &'static str,
    pub reason: String,
}

/// Magic inputs win, then a disabled rail is an outage, then the pinned transaction fate.
#[must_use]
pub fn evaluate(
    body: &Value,
    raw_body: &str,
    config: &Scenario,
    phase: FailPhase,
    pinned: Option<(Option<FailPhase>, Option<FailureMode>)>,
) -> Option<ChaosDecision> {
    if let Some(magic) = detect_magic_trigger(body, raw_body) {
        if magic.phase == phase {
            return Some(ChaosDecision {
                failure_mode: magic.failure_mode,
                phase,
                source: "MAGIC_INPUT",
                reason: magic.reason.to_owned(),
            });
        }
    }
    if !config.enabled {
        return Some(ChaosDecision {
            failure_mode: FailureMode::Http500GatewayFault,
            phase,
            source: "OUTAGE",
            reason: "rail outage (503)".to_owned(),
        });
    }
    if let Some((Some(pinned_phase), Some(mode))) = pinned {
        if pinned_phase == phase {
            return Some(ChaosDecision {
                failure_mode: mode,
                phase,
                source: "TRANSACTION_OVERRIDE",
                reason: "pinned transaction fate".to_owned(),
            });
        }
    }
    None
}

#[must_use]
pub fn latency_for(config: &Scenario, seed: &str) -> u64 {
    let min = config.latency_ms.min.max(0.0);
    let max = config.latency_ms.max.max(min);
    if max == 0.0 {
        return 0;
    }
    let mut prng = Prng::new(seed);
    prng.int(min as i64, max as i64).max(0) as u64
}

/// Applies one portal patch onto the stored scenario (`mergeScenario` in the TS router).
pub fn merge_scenario(base: &Scenario, patch: &Value) -> Scenario {
    let mut merged = base.clone();
    let Some(patch) = patch.as_object() else {
        return merged;
    };
    if let Some(value) = patch.get("enabled").and_then(Value::as_bool) {
        merged.enabled = value;
    }
    if let Some(value) = patch
        .get("overallFailureChancePercent")
        .and_then(Value::as_f64)
    {
        merged.overall_failure_chance_percent = value.clamp(0.0, 100.0);
    }
    if let Some(breakdown) = patch.get("phaseBreakdown").and_then(Value::as_object) {
        if let Some(value) = breakdown.get("initiateFailWeight").and_then(Value::as_f64) {
            merged.phase_breakdown.initiate_fail_weight = value.max(0.0);
        }
        if let Some(value) = breakdown.get("submitFailWeight").and_then(Value::as_f64) {
            merged.phase_breakdown.submit_fail_weight = value.max(0.0);
        }
        if let Some(value) = breakdown.get("verifyFailWeight").and_then(Value::as_f64) {
            merged.phase_breakdown.verify_fail_weight = value.max(0.0);
        }
        if let Some(value) = breakdown.get("webhookFailWeight").and_then(Value::as_f64) {
            merged.phase_breakdown.webhook_fail_weight = value.max(0.0);
        }
        if let Some(value) = breakdown.get("refundFailWeight").and_then(Value::as_f64) {
            merged.phase_breakdown.refund_fail_weight = value.max(0.0);
        }
    }
    if let Some(weights) = patch.get("failureModeWeights").and_then(Value::as_object) {
        for mode in ALL_FAILURE_MODES {
            if let Some(value) = weights.get(mode.as_str()).and_then(Value::as_f64) {
                merged.failure_mode_weights.set(mode, value.max(0.0));
            }
        }
    }
    if let Some(latency) = patch.get("latencyMs").and_then(Value::as_object) {
        if let Some(value) = latency.get("min").and_then(Value::as_f64) {
            merged.latency_ms.min = value.max(0.0);
        }
        if let Some(value) = latency.get("max").and_then(Value::as_f64) {
            merged.latency_ms.max = value.max(0.0);
        }
    }
    if let Some(value) = patch.get("autoApproveAsyncAfterSec") {
        merged.auto_approve_async_after_sec = if value.is_null() {
            None
        } else {
            value.as_f64().map(|seconds| seconds.max(0.0))
        };
    }
    if let Some(behavior) = patch.get("webhookBehavior").and_then(Value::as_object) {
        if let Some(value) = behavior.get("delaySeconds").and_then(Value::as_f64) {
            merged.webhook_behavior.delay_seconds = value.max(0.0);
        }
        if let Some(value) = behavior.get("duplicateCount").and_then(Value::as_f64) {
            merged.webhook_behavior.duplicate_count = value.clamp(1.0, 5.0);
        }
        if let Some(value) = behavior
            .get("outOfOrderPendingAfterPaid")
            .and_then(Value::as_bool)
        {
            merged.webhook_behavior.out_of_order_pending_after_paid = value;
        }
        if let Some(value) = behavior
            .get("corruptSignatureChancePercent")
            .and_then(Value::as_f64)
        {
            merged.webhook_behavior.corrupt_signature_chance_percent = value.clamp(0.0, 100.0);
        }
    }
    merged
}

pub const PRESETS: [&str; 4] = ["healthy", "flaky", "timeout_on_confirm", "outage"];

#[must_use]
pub fn apply_preset(base: &Scenario, preset: &str) -> Option<Scenario> {
    let mut scenario = base.clone();
    match preset {
        "healthy" => {
            scenario.enabled = true;
            scenario.overall_failure_chance_percent = 0.0;
            scenario.latency_ms = Latency {
                min: 20.0,
                max: 120.0,
            };
        }
        "flaky" => {
            scenario.enabled = true;
            scenario.overall_failure_chance_percent = 25.0;
        }
        "timeout_on_confirm" => {
            scenario.enabled = true;
            scenario.overall_failure_chance_percent = 100.0;
            scenario.phase_breakdown = PhaseBreakdown {
                initiate_fail_weight: 0.0,
                submit_fail_weight: 100.0,
                verify_fail_weight: 0.0,
                webhook_fail_weight: 0.0,
                refund_fail_weight: 0.0,
            };
            scenario.failure_mode_weights = FailureModeWeights {
                terminal_decline_insufficient_funds: 0.0,
                limit_exceeded_customer_ceiling: 0.0,
                wrong_otp_retryable: 0.0,
                http_500_gateway_fault: 0.0,
                timeout_hang_above_step_ttl: 100.0,
                socket_reset_mid_stream: 0.0,
                malformed_or_unmapped_200_body: 0.0,
                rate_limit_http_429: 0.0,
                amount_rounding_mismatch: 0.0,
                conflicting_webhook_vs_inquiry: 0.0,
            };
        }
        "outage" => scenario.enabled = false,
        _ => return None,
    }
    Some(scenario)
}

#[must_use]
pub fn descriptor_json(rail: &RailDescriptor) -> Value {
    json!({
        "railCode": rail.rail_code,
        "gatewayCode": rail.gateway_code,
        "name": rail.name,
        "collectionModes": rail.collection_modes,
        "aliases": rail.aliases,
        "defaultOtp": rail.default_otp,
        "otpLength": rail.otp_length,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalogue_has_twenty_rails_and_resolves_aliases() {
        assert_eq!(RAIL_DESCRIPTORS.len(), 20);
        assert_eq!(
            resolve_rail("cbl_lypay").map(|r| r.rail_code),
            Some("ly_pay")
        );
        assert_eq!(resolve_rail("evo_pay").map(|r| r.rail_code), Some("evopay"));
        assert!(resolve_rail("nope").is_none());
    }

    #[test]
    fn magic_inputs_are_deterministic() {
        let empty = json!({});
        assert_eq!(
            detect_magic_trigger(&json!({"otp": "000000"}), "").map(|trigger| trigger.failure_mode),
            Some(FailureMode::WrongOtpRetryable)
        );
        assert_eq!(
            detect_magic_trigger(&json!({"phone": "0911239901"}), "")
                .map(|trigger| trigger.failure_mode),
            Some(FailureMode::TerminalDeclineInsufficientFunds)
        );
        assert_eq!(
            detect_magic_trigger(&json!({"phone": "0911239906"}), "")
                .map(|trigger| trigger.failure_mode),
            Some(FailureMode::TimeoutHangAboveStepTtl)
        );
        assert_eq!(
            detect_magic_trigger(&json!({"phone": "0911239907"}), "")
                .map(|trigger| trigger.failure_mode),
            Some(FailureMode::MalformedOrUnmapped200Body)
        );
        assert!(detect_magic_trigger(&json!({"phone": "0911230000"}), "").is_none());
        assert!(detect_magic_trigger(&empty, "").is_none());
    }

    #[test]
    fn fate_is_reproducible_and_zero_never_fails() {
        let mut scenario = default_scenario(&RAIL_DESCRIPTORS[0]);
        scenario.overall_failure_chance_percent = 100.0;
        let first = assign_fate(&scenario, "tx-1");
        let second = assign_fate(&scenario, "tx-1");
        assert_eq!(first, second);
        assert!(first.assigned_fail_phase.is_some());
        assert!(first.assigned_failure_mode.is_some());

        let mut zero = default_scenario(&RAIL_DESCRIPTORS[0]);
        zero.overall_failure_chance_percent = 0.0;
        assert!(assign_fate(&zero, "tx-1").assigned_failure_mode.is_none());
    }

    #[test]
    fn magic_input_wins_over_pinned_fate() {
        let scenario = default_scenario(&RAIL_DESCRIPTORS[0]);
        let decision = evaluate(
            &json!({"otp": "999999"}),
            "",
            &scenario,
            FailPhase::Submit,
            Some((
                Some(FailPhase::Submit),
                Some(FailureMode::Http500GatewayFault),
            )),
        )
        .expect("decision");
        assert_eq!(decision.source, "MAGIC_INPUT");
        assert_eq!(
            decision.failure_mode,
            FailureMode::TerminalDeclineInsufficientFunds
        );
    }

    #[test]
    fn disabled_rail_is_an_outage() {
        let mut scenario = default_scenario(&RAIL_DESCRIPTORS[0]);
        scenario.enabled = false;
        let decision =
            evaluate(&json!({}), "", &scenario, FailPhase::Initiate, None).expect("decision");
        assert_eq!(decision.source, "OUTAGE");
    }

    #[test]
    fn prng_is_deterministic_and_weighted_is_stable() {
        let mut a = Prng::new("seed");
        let mut b = Prng::new("seed");
        assert_eq!(
            [a.next_f64(), a.next_f64(), a.next_f64()],
            [b.next_f64(), b.next_f64(), b.next_f64()]
        );
        let entries = [(FailureMode::WrongOtpRetryable, 1.0)];
        assert_eq!(a.weighted(&entries), Some(FailureMode::WrongOtpRetryable));
    }

    #[test]
    fn presets_apply() {
        let base = default_scenario(&RAIL_DESCRIPTORS[0]);
        let timeout = apply_preset(&base, "timeout_on_confirm").expect("preset");
        assert_eq!(timeout.overall_failure_chance_percent, 100.0);
        assert_eq!(timeout.phase_breakdown.submit_fail_weight, 100.0);
        assert_eq!(
            timeout.failure_mode_weights.timeout_hang_above_step_ttl,
            100.0
        );
        assert!(apply_preset(&base, "nope").is_none());
    }

    #[test]
    fn scenarios_persist_in_sqlite() {
        let db = Db::memory().expect("db");
        let scenarios = list_scenarios(&db).expect("list");
        assert_eq!(scenarios.len(), 20);
        let mut scenario = get_scenario(&db, "edfali").expect("get");
        scenario.overall_failure_chance_percent = 42.0;
        save_scenario(&db, &scenario).expect("save");
        assert_eq!(
            get_scenario(&db, "edfali")
                .expect("get")
                .overall_failure_chance_percent,
            42.0
        );
        let reset = reset_all_scenarios(&db).expect("reset");
        assert_eq!(reset.len(), 20);
        assert_eq!(
            get_scenario(&db, "edfali")
                .expect("get")
                .overall_failure_chance_percent,
            0.0
        );
    }
}

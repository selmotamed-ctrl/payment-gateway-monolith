//! The gateway protocol dispatcher and the twenty emulated rails.
//!
//! TS: `api/rails/**`. One router serves every switch: the wire shape and the endpoint are selected
//! by the gateway code in the URL; the transaction/chaos/webhook machinery is shared.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::time::Instant;

use serde_json::{json, Map, Value};

use crate::accounts::{
    capture_hold, refund_transaction, release_hold, reserve_account_funds, Reserve,
};
use crate::chaos::{
    assign_fate, evaluate, latency_for, resolve_rail, FailPhase, FailureMode, RailDescriptor,
    Scenario,
};
use crate::crypto::derive_otp;
use crate::db::{
    find_transaction_by_reference, insert_step_event, insert_transaction, now_iso,
    update_transaction, uuid_v7, NewStepEvent, Transaction,
};
use crate::error::{ApiError, ApiResult};
use crate::money::{lyd, mask_customer, micros, normalize_amount};
use crate::state::AppState;
use crate::statements::gateway_statement;
use crate::webhook::{DispatchInput, WebhookBehavior};

#[derive(Debug, Clone)]
pub struct RailRequest {
    pub gateway_code: String,
    pub method: String,
    pub path: String,
    pub query: BTreeMap<String, String>,
    pub headers: BTreeMap<String, String>,
    pub body: Value,
    pub raw_body: String,
}

impl RailRequest {
    #[must_use]
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .get(&name.to_ascii_lowercase())
            .map(String::as_str)
    }
}

#[derive(Debug, Clone)]
pub struct RailResponse {
    pub status: u16,
    pub body: Value,
    pub raw: Option<(String, String)>,
    pub headers: Vec<(String, String)>,
    pub close_connection: bool,
}

impl RailResponse {
    #[must_use]
    pub fn json(status: u16, body: Value) -> Self {
        Self {
            status,
            body,
            raw: None,
            headers: Vec::new(),
            close_connection: false,
        }
    }

    #[must_use]
    pub fn raw(status: u16, content_type: &str, body: String) -> Self {
        Self {
            status,
            body: Value::String(body.clone()),
            raw: Some((content_type.to_owned(), body)),
            headers: Vec::new(),
            close_connection: false,
        }
    }

    #[must_use]
    fn body_text(&self) -> String {
        self.raw
            .as_ref()
            .map_or_else(|| self.body.to_string(), |(_, body)| body.clone())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Handler {
    OtpInitiate,
    OtpConfirm,
    AsyncInitiate,
    RedirectInitiate,
    Inquiry,
    Refund,
    Cancel,
    AsyncConfirm,
    Token,
    LedgerExport,
    Statement,
}

#[derive(Debug, Clone, Copy)]
struct RailRoute {
    gateway_codes: &'static [&'static str],
    method: &'static str,
    path: &'static str,
    phase: FailPhase,
    handler: Handler,
}

const HYBRID_CODES: [&str; 3] = ["yussor", "sahara", "masrefy"];
const PUSH_CODES: [&str; 4] = ["hawelli", "gpay_libya", "numo_pay", "libyana"];
const STATEMENT_GATEWAYS: [&str; 22] = [
    "edfali",
    "sadad",
    "mobicash",
    "moamalat",
    "ly_pay",
    "cbl_lypay",
    "onepay",
    "tlync",
    "mypay",
    "dpay",
    "plutu",
    "yussor",
    "sahara",
    "masrefy",
    "hawelli",
    "gpay_libya",
    "numo_pay",
    "libyana",
    "mpgs",
    "evopay",
    "evo_pay",
    "neompay",
];

static STATEMENT_CODE_SETS: [&[&str]; 22] = [
    &["edfali"],
    &["sadad"],
    &["mobicash"],
    &["moamalat"],
    &["ly_pay"],
    &["cbl_lypay"],
    &["onepay"],
    &["tlync"],
    &["mypay"],
    &["dpay"],
    &["plutu"],
    &["yussor"],
    &["sahara"],
    &["masrefy"],
    &["hawelli"],
    &["gpay_libya"],
    &["numo_pay"],
    &["libyana"],
    &["mpgs"],
    &["evopay"],
    &["evo_pay"],
    &["neompay"],
];

fn route_table() -> Vec<RailRoute> {
    let mut routes = vec![
        // Edfali / Sadad / MobiCash OTP pull
        RailRoute {
            gateway_codes: &["edfali"],
            method: "POST",
            path: "/verify",
            phase: FailPhase::Initiate,
            handler: Handler::OtpInitiate,
        },
        RailRoute {
            gateway_codes: &["edfali"],
            method: "POST",
            path: "/confirm",
            phase: FailPhase::Submit,
            handler: Handler::OtpConfirm,
        },
        RailRoute {
            gateway_codes: &["edfali"],
            method: "GET",
            path: "/status/:ref",
            phase: FailPhase::Verify,
            handler: Handler::Inquiry,
        },
        RailRoute {
            gateway_codes: &["sadad"],
            method: "POST",
            path: "/verify",
            phase: FailPhase::Initiate,
            handler: Handler::OtpInitiate,
        },
        RailRoute {
            gateway_codes: &["sadad"],
            method: "POST",
            path: "/confirm",
            phase: FailPhase::Submit,
            handler: Handler::OtpConfirm,
        },
        RailRoute {
            gateway_codes: &["sadad"],
            method: "GET",
            path: "/status/:ref",
            phase: FailPhase::Verify,
            handler: Handler::Inquiry,
        },
        RailRoute {
            gateway_codes: &["mobicash"],
            method: "POST",
            path: "/open",
            phase: FailPhase::Initiate,
            handler: Handler::OtpInitiate,
        },
        RailRoute {
            gateway_codes: &["mobicash"],
            method: "POST",
            path: "/confirm",
            phase: FailPhase::Submit,
            handler: Handler::OtpConfirm,
        },
        RailRoute {
            gateway_codes: &["mobicash"],
            method: "POST",
            path: "/qr",
            phase: FailPhase::Initiate,
            handler: Handler::AsyncInitiate,
        },
        RailRoute {
            gateway_codes: &["mobicash"],
            method: "GET",
            path: "/status/:ref",
            phase: FailPhase::Verify,
            handler: Handler::Inquiry,
        },
        // Moamalat / MPGS
        RailRoute {
            gateway_codes: &["moamalat"],
            method: "POST",
            path: "/FilterTransactions",
            phase: FailPhase::Verify,
            handler: Handler::Inquiry,
        },
        RailRoute {
            gateway_codes: &["moamalat"],
            method: "POST",
            path: "/refund",
            phase: FailPhase::Refund,
            handler: Handler::Refund,
        },
        RailRoute {
            gateway_codes: &["moamalat"],
            method: "POST",
            path: "/confirm",
            phase: FailPhase::Submit,
            handler: Handler::AsyncConfirm,
        },
        RailRoute {
            gateway_codes: &["mpgs"],
            method: "POST",
            path: "/session",
            phase: FailPhase::Initiate,
            handler: Handler::RedirectInitiate,
        },
        RailRoute {
            gateway_codes: &["mpgs"],
            method: "GET",
            path: "/order/:id",
            phase: FailPhase::Verify,
            handler: Handler::Inquiry,
        },
        RailRoute {
            gateway_codes: &["mpgs"],
            method: "POST",
            path: "/order/:id/refund",
            phase: FailPhase::Refund,
            handler: Handler::Refund,
        },
        RailRoute {
            gateway_codes: &["mpgs"],
            method: "POST",
            path: "/order/:id/confirm",
            phase: FailPhase::Submit,
            handler: Handler::AsyncConfirm,
        },
        // CBL LYPay
        RailRoute {
            gateway_codes: &["ly_pay", "cbl_lypay"],
            method: "POST",
            path: "/api/v1/auth/token",
            phase: FailPhase::Initiate,
            handler: Handler::Token,
        },
        RailRoute {
            gateway_codes: &["ly_pay", "cbl_lypay"],
            method: "POST",
            path: "/api/v1/payments/funds-transfers",
            phase: FailPhase::Initiate,
            handler: Handler::AsyncInitiate,
        },
        RailRoute {
            gateway_codes: &["ly_pay", "cbl_lypay"],
            method: "POST",
            path: "/api/v1/payments/funds-transfers/:uuid/confirm",
            phase: FailPhase::Submit,
            handler: Handler::AsyncConfirm,
        },
        RailRoute {
            gateway_codes: &["ly_pay", "cbl_lypay"],
            method: "GET",
            path: "/api/v1/payments/funds-transfers/enquiry",
            phase: FailPhase::Verify,
            handler: Handler::Inquiry,
        },
        // OnePay
        RailRoute {
            gateway_codes: &["onepay"],
            method: "POST",
            path: "/qr",
            phase: FailPhase::Initiate,
            handler: Handler::AsyncInitiate,
        },
        RailRoute {
            gateway_codes: &["onepay"],
            method: "POST",
            path: "/paycode",
            phase: FailPhase::Initiate,
            handler: Handler::AsyncInitiate,
        },
        RailRoute {
            gateway_codes: &["onepay"],
            method: "POST",
            path: "/verify",
            phase: FailPhase::Initiate,
            handler: Handler::OtpInitiate,
        },
        RailRoute {
            gateway_codes: &["onepay"],
            method: "POST",
            path: "/confirm",
            phase: FailPhase::Submit,
            handler: Handler::OtpConfirm,
        },
        RailRoute {
            gateway_codes: &["onepay"],
            method: "GET",
            path: "/status/:ref",
            phase: FailPhase::Verify,
            handler: Handler::Inquiry,
        },
        // Redirect rails
        RailRoute {
            gateway_codes: &["tlync"],
            method: "POST",
            path: "/payment/create",
            phase: FailPhase::Initiate,
            handler: Handler::RedirectInitiate,
        },
        RailRoute {
            gateway_codes: &["tlync"],
            method: "POST",
            path: "/receipt/transaction",
            phase: FailPhase::Verify,
            handler: Handler::Inquiry,
        },
        RailRoute {
            gateway_codes: &["tlync"],
            method: "POST",
            path: "/refund",
            phase: FailPhase::Refund,
            handler: Handler::Refund,
        },
        RailRoute {
            gateway_codes: &["mypay"],
            method: "POST",
            path: "/auth/token",
            phase: FailPhase::Initiate,
            handler: Handler::Token,
        },
        RailRoute {
            gateway_codes: &["mypay"],
            method: "POST",
            path: "/payment/create",
            phase: FailPhase::Initiate,
            handler: Handler::RedirectInitiate,
        },
        RailRoute {
            gateway_codes: &["dpay"],
            method: "POST",
            path: "/sessions/open",
            phase: FailPhase::Initiate,
            handler: Handler::RedirectInitiate,
        },
        RailRoute {
            gateway_codes: &["dpay"],
            method: "POST",
            path: "/sessions/:id/verify",
            phase: FailPhase::Submit,
            handler: Handler::OtpConfirm,
        },
        RailRoute {
            gateway_codes: &["dpay"],
            method: "GET",
            path: "/sessions/:id",
            phase: FailPhase::Verify,
            handler: Handler::Inquiry,
        },
        RailRoute {
            gateway_codes: &["dpay"],
            method: "POST",
            path: "/refund",
            phase: FailPhase::Refund,
            handler: Handler::Refund,
        },
        RailRoute {
            gateway_codes: &["plutu"],
            method: "POST",
            path: "/edfali/verify",
            phase: FailPhase::Initiate,
            handler: Handler::OtpInitiate,
        },
        RailRoute {
            gateway_codes: &["plutu"],
            method: "POST",
            path: "/edfali/confirm",
            phase: FailPhase::Submit,
            handler: Handler::OtpConfirm,
        },
        RailRoute {
            gateway_codes: &["plutu"],
            method: "POST",
            path: "/sadad/verify",
            phase: FailPhase::Initiate,
            handler: Handler::OtpInitiate,
        },
        RailRoute {
            gateway_codes: &["plutu"],
            method: "POST",
            path: "/sadad/confirm",
            phase: FailPhase::Submit,
            handler: Handler::OtpConfirm,
        },
        RailRoute {
            gateway_codes: &["plutu"],
            method: "POST",
            path: "/tlync/create",
            phase: FailPhase::Initiate,
            handler: Handler::RedirectInitiate,
        },
        // NeomPay
        RailRoute {
            gateway_codes: &["neompay"],
            method: "POST",
            path: "/payments/requests",
            phase: FailPhase::Initiate,
            handler: Handler::AsyncInitiate,
        },
        RailRoute {
            gateway_codes: &["neompay"],
            method: "POST",
            path: "/payments/:id/confirm",
            phase: FailPhase::Submit,
            handler: Handler::AsyncConfirm,
        },
        RailRoute {
            gateway_codes: &["neompay"],
            method: "GET",
            path: "/payments/by-reference/:ref",
            phase: FailPhase::Verify,
            handler: Handler::Inquiry,
        },
        RailRoute {
            gateway_codes: &["neompay"],
            method: "POST",
            path: "/payments/:id/refund",
            phase: FailPhase::Refund,
            handler: Handler::Refund,
        },
        RailRoute {
            gateway_codes: &["neompay"],
            method: "GET",
            path: "/ledger-export",
            phase: FailPhase::Verify,
            handler: Handler::LedgerExport,
        },
        // EvoPay
        RailRoute {
            gateway_codes: &["evopay", "evo_pay"],
            method: "POST",
            path: "/Payment",
            phase: FailPhase::Initiate,
            handler: Handler::AsyncInitiate,
        },
        RailRoute {
            gateway_codes: &["evopay", "evo_pay"],
            method: "GET",
            path: "/Payment/:id",
            phase: FailPhase::Verify,
            handler: Handler::Inquiry,
        },
    ];
    for code in HYBRID_CODES {
        let codes: &'static [&'static str] = match code {
            "yussor" => &["yussor"],
            "sahara" => &["sahara"],
            _ => &["masrefy"],
        };
        routes.push(RailRoute {
            gateway_codes: codes,
            method: "POST",
            path: "/initiate",
            phase: FailPhase::Initiate,
            handler: Handler::AsyncInitiate,
        });
        routes.push(RailRoute {
            gateway_codes: codes,
            method: "POST",
            path: "/confirm",
            phase: FailPhase::Submit,
            handler: Handler::AsyncConfirm,
        });
        routes.push(RailRoute {
            gateway_codes: codes,
            method: "GET",
            path: "/status/:ref",
            phase: FailPhase::Verify,
            handler: Handler::Inquiry,
        });
    }
    for code in PUSH_CODES {
        let codes: &'static [&'static str] = match code {
            "hawelli" => &["hawelli"],
            "gpay_libya" => &["gpay_libya"],
            "numo_pay" => &["numo_pay"],
            _ => &["libyana"],
        };
        routes.push(RailRoute {
            gateway_codes: codes,
            method: "POST",
            path: "/request",
            phase: FailPhase::Initiate,
            handler: Handler::AsyncInitiate,
        });
        routes.push(RailRoute {
            gateway_codes: codes,
            method: "POST",
            path: "/confirm",
            phase: FailPhase::Submit,
            handler: Handler::AsyncConfirm,
        });
        routes.push(RailRoute {
            gateway_codes: codes,
            method: "POST",
            path: "/cancel",
            phase: FailPhase::Initiate,
            handler: Handler::Cancel,
        });
        routes.push(RailRoute {
            gateway_codes: codes,
            method: "GET",
            path: "/status/:ref",
            phase: FailPhase::Verify,
            handler: Handler::Inquiry,
        });
    }
    for (code, codes) in STATEMENT_GATEWAYS.iter().zip(STATEMENT_CODE_SETS.iter()) {
        let _ = code;
        routes.push(RailRoute {
            gateway_codes: codes,
            method: "GET",
            path: "/statement",
            phase: FailPhase::Verify,
            handler: Handler::Statement,
        });
    }
    routes
}

/// Matches a route pattern (`/status/:ref`) against the request path, returning the path params.
fn match_path(pattern: &str, actual: &str) -> Option<BTreeMap<String, String>> {
    let pattern_parts: Vec<&str> = pattern.split('/').filter(|part| !part.is_empty()).collect();
    let actual_parts: Vec<&str> = actual.split('/').filter(|part| !part.is_empty()).collect();
    if pattern_parts.len() != actual_parts.len() {
        return None;
    }
    let mut params = BTreeMap::new();
    for (expected, received) in pattern_parts.iter().zip(actual_parts.iter()) {
        if let Some(name) = expected.strip_prefix(':') {
            params.insert(name.to_owned(), percent_decode(received));
        } else if expected != received {
            return None;
        }
    }
    Some(params)
}

#[must_use]
pub fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                output.push(byte);
                index += 3;
                continue;
            }
        }
        output.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&output).into_owned()
}

fn match_route<'a>(
    routes: &'a [RailRoute],
    actual_codes: &[&str],
    method: &str,
    path: &str,
) -> Option<(&'a RailRoute, BTreeMap<String, String>)> {
    routes.iter().find_map(|route| {
        if route.method != method {
            return None;
        }
        if !route
            .gateway_codes
            .iter()
            .any(|code| actual_codes.contains(code))
        {
            return None;
        }
        match_path(route.path, path).map(|params| (route, params))
    })
}

const REFERENCE_KEYS: &[&str] = &[
    "our_reference",
    "reference",
    "merchant_reference",
    "MerchantReference",
    "merchantReference",
    "custom_ref",
    "order_id",
    "orderId",
    "merchant_order_id",
    "merchantTransInfo",
    "external_reference",
    "externalReference",
    "request_id",
    "requestId",
    "idempotency_key",
    "client_reference",
    "transaction_id",
    "transactionId",
    "uuid",
    "ref",
    "store_order_id",
    "invoice_no",
    "merchantRef",
];

const AMOUNT_KEYS: &[&str] = &[
    "amount",
    "Amount",
    "AmountTrxn",
    "total_amount",
    "totalAmount",
    "trans_amount",
    "transAmount",
    "funds_transfer_amount",
    "value",
    "payment_amount",
    "requested_amount",
    "amount_lyd",
    "price",
];

const CUSTOMER_KEYS: &[&str] = &[
    "customer_mobile",
    "phone",
    "mobile",
    "msisdn",
    "card_number",
    "cardNumber",
    "wallet_id",
    "walletId",
    "pan",
    "customer_phone",
    "payer_phone",
    "account",
    "customer_id",
    "mobile_number",
];

const OTP_KEYS: &[&str] = &[
    "otp",
    "OTP",
    "otp_code",
    "otpCode",
    "code",
    "pin",
    "verification_code",
    "confirm_code",
];

fn first_string(value: &Value) -> Option<String> {
    match value {
        Value::String(text) if !text.trim().is_empty() => Some(text.trim().to_owned()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

fn deep_find(value: &Value, keys: &[&str], depth: usize) -> Option<String> {
    if depth > 6 || value.is_null() {
        return None;
    }
    if let Value::Object(object) = value {
        for key in keys {
            if let Some(found) = object.get(*key).and_then(first_string) {
                return Some(found);
            }
        }
        for entry in object.values() {
            if let Some(found) = deep_find(entry, keys, depth + 1) {
                return Some(found);
            }
        }
    }
    None
}

#[must_use]
pub fn extract_reference(body: &Value, request: &RailRequest) -> String {
    deep_find(body, REFERENCE_KEYS, 0)
        .or_else(|| request.header("idempotency-key").map(str::to_owned))
        .or_else(|| request.header("x-request-id").map(str::to_owned))
        .unwrap_or_else(|| {
            format!(
                "FK-{}-{}",
                AppState::now_ms(),
                (uuid_v7().as_bytes()[0] as u32) % 100_000
            )
        })
}

#[must_use]
pub fn extract_amount(body: &Value) -> String {
    if let Some(nested) = body.get("transAmount") {
        if let Some(found) = deep_find(nested, AMOUNT_KEYS, 0) {
            return found;
        }
    }
    deep_find(body, AMOUNT_KEYS, 0).unwrap_or_else(|| "0.00".to_owned())
}

#[must_use]
pub fn extract_customer(body: &Value) -> Option<String> {
    deep_find(body, CUSTOMER_KEYS, 0)
}

#[must_use]
pub fn extract_otp(body: &Value) -> Option<String> {
    deep_find(body, OTP_KEYS, 0)
}

fn reference_from_path(path: &str) -> Option<String> {
    let segments: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    let markers = [
        "by-reference",
        "status",
        "order",
        "sessions",
        "payments",
        "Payment",
        "funds-transfers",
    ];
    for marker in markers {
        if let Some(index) = segments.iter().position(|segment| *segment == marker) {
            let candidate = segments.get(index + 1)?;
            if [
                "open",
                "enquiry",
                "create",
                "requests",
                "by-reference",
                "funds-transfers",
                "status",
                "order",
                "sessions",
            ]
            .contains(candidate)
            {
                continue;
            }
            return Some((*candidate).to_owned());
        }
    }
    None
}

struct RailContext<'a> {
    state: &'a AppState,
    request: &'a RailRequest,
    descriptor: &'static RailDescriptor,
    scenario: Scenario,
    transaction: Transaction,
    phase: FailPhase,
    body: Value,
    reference: String,
    mode: String,
    fault: Option<crate::chaos::ChaosDecision>,
    started_at: Instant,
}

impl RailContext<'_> {
    fn success_base(&self) -> Map<String, Value> {
        let mut base = Map::new();
        base.insert("reference".to_owned(), json!(self.reference));
        base.insert(
            "our_reference".to_owned(),
            json!(self.transaction.our_reference),
        );
        base.insert(
            "provider_reference".to_owned(),
            json!(self.transaction.provider_reference),
        );
        base.insert(
            "transaction_id".to_owned(),
            json!(self.transaction.provider_reference),
        );
        base.insert(
            "network_reference".to_owned(),
            json!(self.transaction.network_reference),
        );
        base.insert(
            "amount".to_owned(),
            json!(self.transaction.normalized_amount_lyd),
        );
        base.insert("currency".to_owned(), json!(self.transaction.currency));
        base.insert(
            "process_id".to_owned(),
            json!(self.transaction.provider_reference),
        );
        base.insert("env".to_owned(), json!(self.transaction.env));
        base.insert("environment".to_owned(), json!(self.transaction.env));
        base
    }

    fn success_response(
        &mut self,
        status: &str,
        extra: Map<String, Value>,
    ) -> ApiResult<RailResponse> {
        let settled = (status == "PAID").then(|| self.transaction.normalized_amount_lyd.clone());
        update_transaction(
            &self.state.db,
            &self.transaction.id,
            &[
                ("status", json!(status)),
                ("settled_amount_lyd", json!(settled)),
            ],
        )?;
        self.transaction.status = status.to_owned();
        self.transaction.settled_amount_lyd = settled;
        let mut body = self.success_base();
        body.insert("status".to_owned(), json!(status));
        body.insert("success".to_owned(), json!(true));
        body.insert("ActionCode".to_owned(), json!("00"));
        for (key, value) in extra {
            body.insert(key, value);
        }
        Ok(RailResponse::json(200, Value::Object(body)))
    }

    fn dispatch_success_webhook(&self, event: &str) -> ApiResult<()> {
        let mut payload = self.success_base();
        payload.insert("event".to_owned(), json!(event));
        payload.insert("status".to_owned(), json!("PAID"));
        payload.insert(
            "amount".to_owned(),
            json!(self.transaction.normalized_amount_lyd),
        );
        let transaction = Transaction {
            status: "PAID".to_owned(),
            ..self.transaction.clone()
        };
        self.state.webhooks.dispatch(&DispatchInput {
            transaction: &transaction,
            event,
            payload: Value::Object(payload),
            url: None,
            behavior: WebhookBehavior {
                delay_seconds: self.scenario.webhook_behavior.delay_seconds,
                duplicate_count: self.scenario.webhook_behavior.duplicate_count,
                out_of_order_pending_after_paid: self
                    .scenario
                    .webhook_behavior
                    .out_of_order_pending_after_paid,
                corrupt_signature_chance_percent: self
                    .scenario
                    .webhook_behavior
                    .corrupt_signature_chance_percent,
            },
            headers: BTreeMap::new(),
        })?;
        Ok(())
    }
}

fn awaiting_body(
    context: &mut RailContext<'_>,
    extra: Map<String, Value>,
) -> ApiResult<RailResponse> {
    update_transaction(
        &context.state.db,
        &context.transaction.id,
        &[("status", json!("AWAITING_ACTION"))],
    )?;
    context.transaction.status = "AWAITING_ACTION".to_owned();
    let mut body = Map::new();
    body.insert("reference".to_owned(), json!(context.reference));
    body.insert(
        "our_reference".to_owned(),
        json!(context.transaction.our_reference),
    );
    body.insert(
        "provider_reference".to_owned(),
        json!(context.transaction.provider_reference),
    );
    body.insert(
        "process_id".to_owned(),
        json!(context.transaction.provider_reference),
    );
    body.insert(
        "transaction_id".to_owned(),
        json!(context.transaction.provider_reference),
    );
    body.insert("status".to_owned(), json!("AWAITING_CUSTOMER"));
    body.insert(
        "amount".to_owned(),
        json!(context.transaction.normalized_amount_lyd),
    );
    body.insert("currency".to_owned(), json!(context.transaction.currency));
    body.insert("env".to_owned(), json!(context.transaction.env));
    body.insert("environment".to_owned(), json!(context.transaction.env));
    body.insert("otp".to_owned(), json!(context.transaction.expected_otp));
    body.insert(
        "expected_otp".to_owned(),
        json!(context.transaction.expected_otp),
    );
    body.insert("expires_in_seconds".to_owned(), json!(300));
    for (key, value) in extra {
        body.insert(key, value);
    }
    Ok(RailResponse::json(200, Value::Object(body)))
}

fn failure_body(context: &RailContext<'_>, code: &str, message: &str) -> Value {
    let mut body = context.success_base();
    body.insert("status".to_owned(), json!("FAILED"));
    body.insert("success".to_owned(), json!(false));
    body.insert("error".to_owned(), json!(code));
    body.insert("error_code".to_owned(), json!(code));
    body.insert("message".to_owned(), json!(message));
    body.insert(
        "ActionCode".to_owned(),
        json!(if code == "INSUFFICIENT_FUNDS" {
            "05"
        } else {
            "61"
        }),
    );
    Value::Object(body)
}

fn account_decline(context: &RailContext<'_>, code: &str, message: &str) -> RailResponse {
    let mut body = Map::new();
    body.insert("reference".to_owned(), json!(context.reference));
    body.insert(
        "our_reference".to_owned(),
        json!(context.transaction.our_reference),
    );
    body.insert(
        "provider_reference".to_owned(),
        json!(context.transaction.provider_reference),
    );
    body.insert(
        "transaction_id".to_owned(),
        json!(context.transaction.provider_reference),
    );
    body.insert(
        "amount".to_owned(),
        json!(context.transaction.normalized_amount_lyd),
    );
    body.insert("currency".to_owned(), json!(context.transaction.currency));
    body.insert("status".to_owned(), json!("FAILED"));
    body.insert("success".to_owned(), json!(false));
    body.insert("error".to_owned(), json!(code));
    body.insert("error_code".to_owned(), json!(code));
    body.insert("message".to_owned(), json!(message));
    let action_code = match code {
        "ACCOUNT_FROZEN" => "62",
        "ACCOUNT_EXPIRED" => "54",
        "ACCOUNT_BLOCKED" => "62",
        "INSUFFICIENT_FUNDS" => "51",
        "LIMIT_EXCEEDED" => "61",
        _ => "05",
    };
    body.insert("ActionCode".to_owned(), json!(action_code));
    RailResponse::json(200, Value::Object(body))
}

fn record_rail_event(context: &RailContext<'_>, response: &RailResponse) {
    let headers = Value::Object(
        context
            .request
            .headers
            .iter()
            .map(|(key, value)| (key.clone(), json!(value)))
            .collect(),
    );
    let duration_ms = context.started_at.elapsed().as_millis() as i64;
    let event_id = insert_step_event(
        &context.state.db,
        &NewStepEvent {
            transaction_id: Some(&context.transaction.id),
            gateway_code: context.descriptor.gateway_code,
            phase: context.phase.as_str(),
            method: &context.request.method,
            path: &context.request.path,
            request_headers_json: &headers.to_string(),
            request_body_raw: &context
                .request
                .raw_body
                .chars()
                .take(200_000)
                .collect::<String>(),
            response_status: Some(i64::from(response.status)),
            response_body_raw: Some(
                &response
                    .body_text()
                    .chars()
                    .take(200_000)
                    .collect::<String>(),
            ),
            injected_fault: context
                .fault
                .as_ref()
                .map(|fault| fault.failure_mode.as_str()),
            duration_ms,
        },
    )
    .ok();
    context.state.hub.broadcast(
        "rail.request",
        json!({
            "eventId": event_id,
            "gatewayCode": context.descriptor.gateway_code,
            "railCode": context.descriptor.rail_code,
            "phase": context.phase.as_str(),
            "method": context.request.method,
            "path": context.request.path,
            "status": response.status,
            "transactionId": context.transaction.id,
            "ourReference": context.transaction.our_reference,
            "providerReference": context.transaction.provider_reference,
            "amount": context.transaction.normalized_amount_lyd,
            "expectedOtp": context.transaction.expected_otp,
            "fault": context.fault.as_ref().map(|fault| fault.failure_mode.as_str()),
            "durationMs": duration_ms,
        }),
    );
}

fn resolve_or_create(
    state: &AppState,
    request: &RailRequest,
    descriptor: &'static RailDescriptor,
    params: &BTreeMap<String, String>,
    scenario: &Scenario,
) -> ApiResult<Transaction> {
    let path_reference = params
        .get("ref")
        .or_else(|| params.get("id"))
        .or_else(|| params.get("uuid"))
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .or_else(|| reference_from_path(&request.path));
    let reference = path_reference.unwrap_or_else(|| extract_reference(&request.body, request));
    if let Some(existing) =
        find_transaction_by_reference(&state.db, descriptor.gateway_code, &reference)?
    {
        return Ok(existing);
    }
    let wire = extract_amount(&request.body);
    let (requested_wire, normalized_lyd, _scale) = normalize_amount(descriptor.gateway_code, &wire);
    let customer = extract_customer(&request.body);
    let seed = format!("{}:{}", descriptor.rail_code, reference);
    let fate = assign_fate(scenario, &seed);
    let otp = derive_otp(
        &state.config.seeder_token,
        descriptor.rail_code,
        &reference,
        descriptor.otp_length,
    );
    let requested_webhook = deep_find(
        &request.body,
        &["webhook_url", "webhookUrl", "notification_url"],
        0,
    );
    if let Some(url) = &requested_webhook {
        if !crate::webhook::webhook_target_allowed(
            url,
            &crate::webhook::allowed_webhook_hosts(&state.config),
        ) {
            return Err(ApiError::new(
                400,
                "WEBHOOK_URL_NOT_ALLOWED",
                "The webhook URL host is not on the allowed list",
            ));
        }
    }
    let environment = request
        .header("x-pg-environment")
        .map(str::to_owned)
        .or_else(|| deep_find(&request.body, &["env", "environment"], 0))
        .unwrap_or_else(|| "SANDBOX".to_owned())
        .to_ascii_uppercase();
    let env = if environment.contains("LIVE") {
        "LIVE"
    } else {
        "SANDBOX"
    };
    let currency = deep_find(&request.body, &["currency", "Currency"], 0)
        .unwrap_or_else(|| "LYD".to_owned())
        .to_ascii_uppercase()
        .chars()
        .take(3)
        .collect::<String>();
    let stamp = AppState::now_ms();
    let suffix = uuid_v7();
    let provider_reference = format!(
        "FK-{}-{stamp}-{:04}",
        descriptor
            .rail_code
            .to_ascii_uppercase()
            .chars()
            .filter(char::is_ascii_alphanumeric)
            .collect::<String>(),
        (suffix.as_bytes()[0] as u32) % 10_000
    );
    let network_reference =
        if ["moamalat", "ly_pay", "onepay", "mpgs"].contains(&descriptor.rail_code) {
            Some(format!(
                "NET-{}",
                suffix
                    .replace('-', "")
                    .chars()
                    .take(10)
                    .collect::<String>()
                    .to_ascii_uppercase()
            ))
        } else {
            None
        };
    let transaction = Transaction {
        id: uuid_v7(),
        gateway_code: descriptor.gateway_code.to_owned(),
        rail_code: descriptor.rail_code.to_owned(),
        env: env.to_owned(),
        our_reference: reference.clone(),
        provider_reference,
        network_reference,
        idempotency_key: request.header("idempotency-key").map(str::to_owned),
        requested_amount_wire: requested_wire,
        normalized_amount_lyd: normalized_lyd,
        settled_amount_lyd: None,
        gateway_fee_lyd: "0.0000".to_owned(),
        currency,
        collection_mode: descriptor
            .collection_modes
            .first()
            .copied()
            .unwrap_or("OTP_PULL")
            .to_owned(),
        customer_identifier_masked: mask_customer(descriptor.gateway_code, customer.as_deref()),
        expected_otp: Some(otp),
        merchant_id: request
            .header("x-pg-merchant-id")
            .or_else(|| request.header("x-merchant-id"))
            .map(str::to_owned),
        qr_payload: None,
        deep_link_url: None,
        redirect_url: None,
        account_id: None,
        held_amount_lyd: None,
        status: "INITIATED".to_owned(),
        assigned_fail_phase: fate
            .assigned_fail_phase
            .map(|phase| phase.as_str().to_owned()),
        assigned_failure_mode: fate
            .assigned_failure_mode
            .map(|mode| mode.as_str().to_owned()),
        inquiry_override_status: None,
        return_url: deep_find(
            &request.body,
            &["return_url", "returnUrl", "redirect_url", "callback_url"],
            0,
        ),
        cancel_url: deep_find(&request.body, &["cancel_url", "cancelUrl"], 0),
        webhook_url: requested_webhook,
        is_seeded_historical: 0,
        created_at: now_iso(),
        updated_at: now_iso(),
    };
    insert_transaction(&state.db, &transaction)?;
    Ok(transaction)
}

fn apply_account_outcome(context: &RailContext<'_>, body: &Value) {
    let status = body
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_uppercase();
    match status.as_str() {
        "PAID" | "SUCCEEDED" => {
            let _ = capture_hold(&context.state.db, &context.transaction.id, None);
        }
        "REFUNDED" => {
            let _ = refund_transaction(
                &context.state.db,
                &context.transaction.id,
                None,
                "Refund returned to the test customer account",
            );
        }
        "FAILED" | "CANCELLED" => {
            let _ = release_hold(
                &context.state.db,
                &context.transaction.id,
                &format!("Rail answered {status}"),
            );
        }
        _ => {}
    }
}

async fn handle_request(state: &AppState, request: &RailRequest) -> ApiResult<RailResponse> {
    let descriptor = resolve_rail(&request.gateway_code).ok_or_else(|| {
        ApiError::new(
            404,
            "UNKNOWN_GATEWAY",
            format!("No emulated gateway '{}'", request.gateway_code),
        )
    })?;
    let table = route_table();
    // Gateway aliases (cbl_lypay -> ly_pay, evo_pay -> evopay) share the same code list.
    let codes: Vec<&str> = match descriptor.rail_code {
        "ly_pay" => vec!["ly_pay", "cbl_lypay"],
        "evopay" => vec!["evopay", "evo_pay"],
        _ => vec![descriptor.gateway_code],
    };
    let route = match_route(&table, &codes, &request.method, &request.path).or_else(|| {
        match_route(
            &table,
            &codes,
            &request.method,
            request.path.trim_end_matches('/'),
        )
    });
    let Some((route, params)) = route else {
        return Err(ApiError::new(
            404,
            "UNKNOWN_RAIL_ENDPOINT",
            format!(
                "No emulated endpoint {} {} for gateway '{}'",
                request.method, request.path, descriptor.gateway_code
            ),
        ));
    };
    let started_at = Instant::now();
    let scenario = crate::chaos::get_scenario(&state.db, descriptor.rail_code)?;
    let transaction = resolve_or_create(state, request, descriptor, &params, &scenario)?;
    let pinned = (
        transaction
            .assigned_fail_phase
            .as_deref()
            .and_then(FailPhase::parse),
        transaction
            .assigned_failure_mode
            .as_deref()
            .and_then(FailureMode::parse),
    );
    let fault = evaluate(
        &request.body,
        &request.raw_body,
        &scenario,
        route.phase,
        Some(pinned),
    );
    let mut context = RailContext {
        state,
        request,
        descriptor,
        scenario: scenario.clone(),
        transaction,
        phase: route.phase,
        body: request.body.clone(),
        reference: String::new(),
        mode: String::new(),
        fault: fault.clone(),
        started_at,
    };
    context
        .reference
        .clone_from(&context.transaction.our_reference);
    context
        .mode
        .clone_from(&context.transaction.collection_mode);

    if route.phase == FailPhase::Initiate && context.transaction.account_id.is_none() {
        let identifier = extract_customer(&context.body)
            .or_else(|| context.transaction.customer_identifier_masked.clone());
        let merchant_id = context.transaction.merchant_id.clone().or_else(|| {
            context
                .request
                .header("x-pg-merchant-id")
                .map(str::to_owned)
        });
        let hold = reserve_account_funds(
            &state.db,
            &Reserve {
                rail_code: descriptor.rail_code,
                gateway_code: descriptor.gateway_code,
                identifier: identifier.as_deref(),
                transaction_id: &context.transaction.id,
                amount_lyd: &context.transaction.normalized_amount_lyd,
                merchant_id: merchant_id.as_deref(),
            },
        )?;
        if !hold.allowed {
            update_transaction(
                &state.db,
                &context.transaction.id,
                &[("status", json!("FAILED"))],
            )?;
            context.transaction.status = "FAILED".to_owned();
            let declined = account_decline(
                &context,
                hold.decline_code.unwrap_or("INSUFFICIENT_FUNDS"),
                hold.decline_message
                    .as_deref()
                    .unwrap_or("Declined by the test customer account"),
            );
            record_rail_event(&context, &declined);
            return Ok(declined);
        }
        if let Some(static_otp) = &hold.account.static_otp {
            update_transaction(
                &state.db,
                &context.transaction.id,
                &[("expected_otp", json!(static_otp))],
            )?;
            context.transaction.expected_otp = Some(static_otp.clone());
        }
        context.transaction.account_id = Some(hold.account.id.clone());
    }

    let delay = latency_for(
        &scenario,
        &format!("{}:{}", context.transaction.id, route.phase.as_str()),
    );
    if delay > 0 {
        tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
    }

    if let Some(decision) = apply_hard_fault(state, &context).await {
        record_rail_event(&context, &decision);
        return Ok(decision);
    }
    if let Some(decision) = context.fault.clone() {
        if let Some(business) = finalize_fault(&mut context, &decision)? {
            apply_account_outcome(&context, &business.body);
            record_rail_event(&context, &business);
            return Ok(business);
        }
    }

    let result = match route.handler {
        Handler::OtpInitiate => awaiting_body(&mut context, Map::new())?,
        Handler::OtpConfirm => otp_confirm(&mut context).await?,
        Handler::AsyncInitiate => async_initiate(&mut context)?,
        Handler::RedirectInitiate => redirect_initiate(&mut context)?,
        Handler::Inquiry => inquiry(&context),
        Handler::Refund => refund(&mut context).await?,
        Handler::Cancel => cancel(&mut context)?,
        Handler::AsyncConfirm => async_confirm(&mut context).await?,
        Handler::Token => token_endpoint(&context),
        Handler::LedgerExport => ledger_export(state, &context)?,
        Handler::Statement => statement(state, &context)?,
    };
    apply_account_outcome(&context, &result.body);
    record_rail_event(&context, &result);
    Ok(result)
}

async fn apply_hard_fault(state: &AppState, context: &RailContext<'_>) -> Option<RailResponse> {
    let fault = context.fault.as_ref()?;
    match fault.failure_mode {
        FailureMode::TimeoutHangAboveStepTtl => {
            tokio::time::sleep(std::time::Duration::from_millis(
                state.config.timeout_hang_ms,
            ))
            .await;
            Some(RailResponse::json(
                504,
                json!({"error": "gateway_timeout", "message": "Upstream switch did not respond"}),
            ))
        }
        FailureMode::SocketResetMidStream => {
            // The transport cannot destroy the socket from the router; the response closes the
            // connection with the TS status instead (documented deviation).
            let mut response = RailResponse::json(499, json!({}));
            response.close_connection = true;
            Some(response)
        }
        FailureMode::Http500GatewayFault => Some(RailResponse::json(
            if fault.source == "OUTAGE" { 503 } else { 500 },
            json!({"error": "gateway_fault", "message": "Upstream switch internal error"}),
        )),
        FailureMode::RateLimitHttp429 => Some(RailResponse::json(
            429,
            json!({"error": "rate_limited", "message": "Too many requests"}),
        )),
        FailureMode::MalformedOrUnmapped200Body => Some(RailResponse::json(
            200,
            json!({"unexpected_schema": true, "data": null, "code": "??"}),
        )),
        _ => None,
    }
}

fn finalize_fault(
    context: &mut RailContext<'_>,
    fault: &crate::chaos::ChaosDecision,
) -> ApiResult<Option<RailResponse>> {
    match fault.failure_mode {
        FailureMode::TerminalDeclineInsufficientFunds => {
            update_transaction(
                &context.state.db,
                &context.transaction.id,
                &[("status", json!("FAILED"))],
            )?;
            context.transaction.status = "FAILED".to_owned();
            Ok(Some(RailResponse::json(
                200,
                failure_body(context, "INSUFFICIENT_FUNDS", "Insufficient funds"),
            )))
        }
        FailureMode::LimitExceededCustomerCeiling => {
            update_transaction(
                &context.state.db,
                &context.transaction.id,
                &[("status", json!("FAILED"))],
            )?;
            context.transaction.status = "FAILED".to_owned();
            Ok(Some(RailResponse::json(
                200,
                failure_body(context, "LIMIT_EXCEEDED", "Customer limit exceeded"),
            )))
        }
        FailureMode::WrongOtpRetryable => {
            update_transaction(
                &context.state.db,
                &context.transaction.id,
                &[("status", json!("AWAITING_ACTION"))],
            )?;
            context.transaction.status = "AWAITING_ACTION".to_owned();
            let mut body = context.success_base();
            body.insert("status".to_owned(), json!("AWAITING_CUSTOMER"));
            body.insert("error".to_owned(), json!("WRONG_OTP"));
            body.insert("message".to_owned(), json!("The OTP is incorrect"));
            body.insert("retryable".to_owned(), json!(true));
            Ok(Some(RailResponse::json(200, Value::Object(body))))
        }
        FailureMode::AmountRoundingMismatch => {
            let settled = lyd(micros(&context.transaction.normalized_amount_lyd) + 500);
            update_transaction(
                &context.state.db,
                &context.transaction.id,
                &[
                    ("status", json!("PAID")),
                    ("settled_amount_lyd", json!(settled)),
                ],
            )?;
            context.transaction.status = "PAID".to_owned();
            context.transaction.settled_amount_lyd = Some(settled.clone());
            let mut body = context.success_base();
            body.insert("status".to_owned(), json!("PAID"));
            body.insert("settled_amount".to_owned(), json!(settled));
            Ok(Some(RailResponse::json(200, Value::Object(body))))
        }
        FailureMode::ConflictingWebhookVsInquiry => {
            update_transaction(
                &context.state.db,
                &context.transaction.id,
                &[
                    ("status", json!("PAID")),
                    ("inquiry_override_status", json!("FAILED")),
                ],
            )?;
            context.transaction.status = "PAID".to_owned();
            context.transaction.inquiry_override_status = Some("FAILED".to_owned());
            let mut body = context.success_base();
            body.insert("status".to_owned(), json!("PAID"));
            // Fire-and-forget like the TS `void dispatchSuccessWebhook`.
            let webhook_context = RailContext {
                state: context.state,
                request: context.request,
                descriptor: context.descriptor,
                scenario: context.scenario.clone(),
                transaction: context.transaction.clone(),
                phase: context.phase,
                body: context.body.clone(),
                reference: context.reference.clone(),
                mode: context.mode.clone(),
                fault: None,
                started_at: context.started_at,
            };
            let _ = webhook_context.dispatch_success_webhook("payment.paid");
            Ok(Some(RailResponse::json(200, Value::Object(body))))
        }
        _ => Ok(None),
    }
}

async fn otp_confirm(context: &mut RailContext<'_>) -> ApiResult<RailResponse> {
    let provided = extract_otp(&context.body);
    let matches = provided
        .as_deref()
        .is_none_or(|otp| Some(otp) == context.transaction.expected_otp.as_deref());
    if !matches {
        update_transaction(
            &context.state.db,
            &context.transaction.id,
            &[("status", json!("AWAITING_ACTION"))],
        )?;
        context.transaction.status = "AWAITING_ACTION".to_owned();
        return Ok(RailResponse::json(
            200,
            json!({
                "reference": context.reference,
                "status": "AWAITING_CUSTOMER",
                "success": false,
                "error": "WRONG_OTP",
                "message": "The OTP is incorrect",
                "retryable": true,
            }),
        ));
    }
    let mut extra = Map::new();
    extra.insert(
        "bank_reference".to_owned(),
        json!(context.transaction.provider_reference),
    );
    extra.insert(
        "transaction_id".to_owned(),
        json!(context.transaction.provider_reference),
    );
    let response = context.success_response("PAID", extra)?;
    context.dispatch_success_webhook("payment.paid")?;
    Ok(response)
}

fn async_initiate(context: &mut RailContext<'_>) -> ApiResult<RailResponse> {
    let base = context.state.config.public_origin();
    let qr_payload = format!(
        "EMVCO|{}|{}|{}|LYD",
        context.descriptor.rail_code,
        context.transaction.provider_reference,
        context.transaction.normalized_amount_lyd
    );
    let deep_link = format!("{base}/hosted/redirect/{}", context.transaction.id);
    update_transaction(
        &context.state.db,
        &context.transaction.id,
        &[
            ("qr_payload", json!(qr_payload)),
            ("deep_link_url", json!(deep_link)),
        ],
    )?;
    context.transaction.qr_payload = Some(qr_payload.clone());
    context.transaction.deep_link_url = Some(deep_link.clone());
    let expires_at = (chrono::Utc::now() + chrono::Duration::minutes(15))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut extra = Map::new();
    extra.insert("qr_code".to_owned(), json!(qr_payload));
    extra.insert("qr_payload".to_owned(), json!(qr_payload));
    extra.insert("deep_link".to_owned(), json!(deep_link));
    extra.insert(
        "push_reference".to_owned(),
        json!(context.transaction.provider_reference),
    );
    extra.insert(
        "pay_code".to_owned(),
        json!(context.transaction.expected_otp),
    );
    extra.insert("expires_at".to_owned(), json!(expires_at));
    awaiting_body(context, extra)
}

fn redirect_initiate(context: &mut RailContext<'_>) -> ApiResult<RailResponse> {
    let base = context.state.config.public_origin();
    let redirect_url = format!("{base}/hosted/redirect/{}", context.transaction.id);
    update_transaction(
        &context.state.db,
        &context.transaction.id,
        &[
            ("status", json!("AWAITING_ACTION")),
            ("redirect_url", json!(redirect_url)),
        ],
    )?;
    context.transaction.status = "AWAITING_ACTION".to_owned();
    context.transaction.redirect_url = Some(redirect_url.clone());
    Ok(RailResponse::json(
        200,
        json!({
            "reference": context.reference,
            "our_reference": context.transaction.our_reference,
            "provider_reference": context.transaction.provider_reference,
            "transaction_id": context.transaction.provider_reference,
            "status": "AWAITING_CUSTOMER",
            "env": context.transaction.env,
            "environment": context.transaction.env,
            "redirect_url": redirect_url,
            "return_url": context.transaction.return_url,
            "cancel_url": context.transaction.cancel_url,
            "expires_in_seconds": 900,
        }),
    ))
}

fn inquiry(context: &RailContext<'_>) -> RailResponse {
    let status = context
        .transaction
        .inquiry_override_status
        .clone()
        .unwrap_or_else(|| context.transaction.status.clone());
    let paid = status == "PAID" || status == "SUCCEEDED";
    let failed = status == "FAILED";
    RailResponse::json(
        200,
        json!({
            "reference": context.reference,
            "our_reference": context.transaction.our_reference,
            "provider_reference": context.transaction.provider_reference,
            "transaction_id": context.transaction.provider_reference,
            "network_reference": context.transaction.network_reference,
            "status": if paid { "PAID" } else if failed { "FAILED" } else { "PENDING" },
            "result": if paid { "SUCCESS" } else if failed { "FAILED" } else { "PENDING" },
            "payment": { "status": if paid { "Captured" } else if failed { "Declined" } else { "Pending" } },
            "amount": context.transaction.settled_amount_lyd.clone().unwrap_or_else(|| context.transaction.normalized_amount_lyd.clone()),
            "currency": context.transaction.currency,
            "env": context.transaction.env,
            "environment": context.transaction.env,
            "ActionCode": if paid { "00" } else if failed { "05" } else { "09" },
        }),
    )
}

async fn refund(context: &mut RailContext<'_>) -> ApiResult<RailResponse> {
    if context.transaction.status != "PAID" && context.transaction.status != "SUCCEEDED" {
        return Ok(RailResponse::json(
            200,
            json!({
                "reference": context.reference,
                "status": "FAILED",
                "success": false,
                "error": "NOT_REFUNDABLE",
                "message": "The transaction is not in a refundable state",
            }),
        ));
    }
    update_transaction(
        &context.state.db,
        &context.transaction.id,
        &[
            ("status", json!("REFUNDED")),
            ("settled_amount_lyd", json!("0.0000")),
        ],
    )?;
    context.transaction.status = "REFUNDED".to_owned();
    context.transaction.settled_amount_lyd = Some("0.0000".to_owned());
    context.dispatch_success_webhook("payment.refunded")?;
    Ok(RailResponse::json(
        200,
        json!({
            "reference": context.reference,
            "provider_reference": context.transaction.provider_reference,
            "provider_refund_ref": format!("RF-{}", context.transaction.provider_reference),
            "status": "REFUNDED",
            "success": true,
            "amount": context.transaction.normalized_amount_lyd,
            "currency": context.transaction.currency,
        }),
    ))
}

fn cancel(context: &mut RailContext<'_>) -> ApiResult<RailResponse> {
    update_transaction(
        &context.state.db,
        &context.transaction.id,
        &[("status", json!("CANCELLED"))],
    )?;
    context.transaction.status = "CANCELLED".to_owned();
    Ok(RailResponse::json(
        200,
        json!({
            "reference": context.reference,
            "provider_reference": context.transaction.provider_reference,
            "status": "CANCELLED",
            "success": true,
        }),
    ))
}

async fn async_confirm(context: &mut RailContext<'_>) -> ApiResult<RailResponse> {
    let mut extra = Map::new();
    extra.insert(
        "transaction_id".to_owned(),
        json!(context.transaction.provider_reference),
    );
    let response = context.success_response("PAID", extra)?;
    context.dispatch_success_webhook("payment.paid")?;
    Ok(response)
}

fn token_endpoint(context: &RailContext<'_>) -> RailResponse {
    RailResponse::json(
        200,
        json!({
            "access_token": format!("fake-access-{}-{}", context.descriptor.gateway_code, AppState::now_ms()),
            "token_type": "Bearer",
            "expires_in": if context.descriptor.gateway_code == "mypay" { 600 } else { 3600 },
            "scope": "payments",
        }),
    )
}

fn ledger_export(state: &AppState, context: &RailContext<'_>) -> ApiResult<RailResponse> {
    let rows = state.db.query_json(
        "SELECT provider_reference, our_reference, normalized_amount_lyd, settled_amount_lyd,
                gateway_fee_lyd, status, created_at
         FROM fake_transactions WHERE gateway_code = 'neompay'
         ORDER BY created_at DESC LIMIT 5000",
        vec![],
    )?;
    let entries: Vec<Value> = rows
        .iter()
        .map(|row| {
            json!({
                "provider_reference": row.get("provider_reference").cloned().unwrap_or(Value::Null),
                "our_reference": row.get("our_reference").cloned().unwrap_or(Value::Null),
                "amount": row.get("normalized_amount_lyd").cloned().unwrap_or(Value::Null),
                "settled_amount": row.get("settled_amount_lyd").cloned().unwrap_or(Value::Null),
                "fee": row.get("gateway_fee_lyd").cloned().unwrap_or(Value::Null),
                "status": row.get("status").cloned().unwrap_or(Value::Null),
                "created_at": row.get("created_at").cloned().unwrap_or(Value::Null),
            })
        })
        .collect();
    Ok(RailResponse::json(
        200,
        json!({
            "gateway": "neompay",
            "exported_at": now_iso(),
            "currency": "LYD",
            "entries": entries,
            "reference": context.reference,
        }),
    ))
}

fn statement(state: &AppState, context: &RailContext<'_>) -> ApiResult<RailResponse> {
    let format = context
        .request
        .query
        .get("format")
        .map_or("csv", String::as_str)
        .to_ascii_lowercase();
    let from = context.request.query.get("from").map(String::as_str);
    let to = context.request.query.get("to").map(String::as_str);
    let (content_type, body) = gateway_statement(
        &state.db,
        context.descriptor.gateway_code,
        from,
        to,
        &format,
    )?;
    Ok(RailResponse::raw(200, &content_type, body))
}

/// Public entry point used by the HTTP dispatcher.
pub async fn handle_rails(state: &AppState, request: &RailRequest) -> ApiResult<RailResponse> {
    handle_request(state, request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn route_table_covers_every_rail_and_the_otp_families() {
        let routes = route_table();
        for rail in &crate::chaos::RAIL_DESCRIPTORS {
            assert!(
                routes
                    .iter()
                    .any(|route| route.gateway_codes.contains(&rail.gateway_code)),
                "{} has no route",
                rail.gateway_code
            );
        }
        let edfali: Vec<&RailRoute> = routes
            .iter()
            .filter(|route| route.gateway_codes.contains(&"edfali"))
            .collect();
        assert_eq!(edfali.len(), 4);
    }

    #[test]
    fn path_matching_captures_params() {
        let params = match_path("/status/:ref", "/status/REF-1").expect("match");
        assert_eq!(params.get("ref").map(String::as_str), Some("REF-1"));
        assert!(match_path("/status/:ref", "/status/REF-1/extra").is_none());
        assert!(match_path("/verify", "/confirm").is_none());
    }

    #[test]
    fn reference_and_amount_extraction_prefers_the_seeded_field_names() {
        let body = json!({"invoice_no": "INV-1", "amount": "25.00", "mobile_number": "0910000001"});
        let request = RailRequest {
            gateway_code: "edfali".to_owned(),
            method: "POST".to_owned(),
            path: "/rails/edfali/verify".to_owned(),
            query: BTreeMap::new(),
            headers: BTreeMap::new(),
            body: body.clone(),
            raw_body: body.to_string(),
        };
        assert_eq!(extract_reference(&body, &request), "INV-1");
        assert_eq!(extract_amount(&body), "25.00");
        assert_eq!(extract_customer(&body).as_deref(), Some("0910000001"));
        assert_eq!(
            extract_otp(&json!({"otp": "1234"})).as_deref(),
            Some("1234")
        );
    }

    #[test]
    fn percent_decoding_handles_utf8_and_plus() {
        assert_eq!(percent_decode("A%2FB"), "A/B");
        assert_eq!(percent_decode("caf%C3%A9"), "café");
        assert_eq!(percent_decode("plain"), "plain");
    }
}

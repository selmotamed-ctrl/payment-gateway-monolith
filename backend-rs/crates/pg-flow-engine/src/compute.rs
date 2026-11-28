//! The declarative compute operations of the seeded rails.
//!
//! Port of `core-back/engine/runtime/computeRegistry.ts`. A `COMPUTE` step performs no HTTP call: it
//! derives a payload from the attempt, the state and the credentials. The operation name is carried
//! by the `method` column of a stored flow step.
//!
//! Exactly three operations are registered (chapter 2 §15): `MOAMALAT_LIGHTBOX_PAYLOAD`,
//! `NEOMPAY_QR_PAYLOAD`, `LOCAL_SETTLEMENT_RECONCILE`; anything else answers
//! `UNKNOWN_COMPUTE_OPERATION`.
//!
//! Deviation: the TS `LOCAL_SETTLEMENT_RECONCILE` re-reads the attempt row; this port derives the
//! answer from the attempt snapshot the engine already loaded (it re-reads the row before every
//! phase). A store-backed registry can be plugged in through [`ComputeRegistry`].

#![forbid(unsafe_code)]

use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use pg_crypto::canonical::CanonicalizationMode;
use pg_crypto::{
    canonicalize, decode_key, encode_output, hmac_sha256, KeyEncoding, OutputEncoding,
};
use serde_json::{Map, Value};

use crate::error::{codes, EngineError};
use crate::ports::{Clock, Rng};
use crate::selector::{stringify_value, xml_escape};

/// The context one compute operation reads (`StepExecutionContext` minus the executor plumbing).
#[derive(Debug, Clone, Default)]
pub struct ComputeContext {
    pub attempt: Map<String, Value>,
    pub credentials: Map<String, Value>,
    pub state: Map<String, Value>,
    pub customer_fields: Map<String, Value>,
}

impl ComputeContext {
    fn attempt_string(&self, key: &str) -> Option<String> {
        self.attempt.get(key).map(stringify_value)
    }

    fn credential(&self, key: &str) -> Option<String> {
        self.credentials.get(key).map(stringify_value)
    }
}

/// `ComputeOperation`.
#[async_trait]
pub trait ComputeRegistry: Send + Sync {
    async fn compute(
        &self,
        name: &str,
        input: &Value,
        context: &ComputeContext,
    ) -> Result<Value, EngineError>;
}

/// The three registered operations of the blueprints.
pub struct BuiltinComputeRegistry {
    clock: Arc<dyn Clock>,
    rng: Arc<dyn Rng>,
}

impl BuiltinComputeRegistry {
    #[must_use]
    pub fn new(clock: Arc<dyn Clock>, rng: Arc<dyn Rng>) -> Self {
        Self { clock, rng }
    }

    /// The registered names, in the declaration order of the TS registry.
    pub const OPERATIONS: [&'static str; 3] = [
        "MOAMALAT_LIGHTBOX_PAYLOAD",
        "NEOMPAY_QR_PAYLOAD",
        "LOCAL_SETTLEMENT_RECONCILE",
    ];

    fn moamalat(&self, context: &ComputeContext) -> Result<Value, EngineError> {
        let amount = context
            .attempt_string("totalChargedAmount")
            .unwrap_or_else(|| "0".to_owned());
        // scale(1000) |> to_int |> to_string.
        let scaled = scale_to_int(&amount, 1000)?;
        let merchant_reference = merchant_reference(
            context
                .attempt_string("gatewayReference")
                .or_else(|| context.attempt_string("reference"))
                .as_deref()
                .unwrap_or(""),
        );
        let timestamp = self.clock.now();
        let trx_date_time = format_tripoli(timestamp);
        let merchant_id = context.credential("MID").unwrap_or_default();
        let terminal_id = context.credential("TID").unwrap_or_default();
        let mut fields = Map::new();
        fields.insert("Amount".to_owned(), Value::String(scaled.clone()));
        fields.insert(
            "DateTimeLocalTrxn".to_owned(),
            Value::String(trx_date_time.clone()),
        );
        fields.insert("MerchantId".to_owned(), Value::String(merchant_id));
        fields.insert(
            "MerchantReference".to_owned(),
            Value::String(merchant_reference.clone()),
        );
        fields.insert("TerminalId".to_owned(), Value::String(terminal_id));
        let secure_hash = context
            .credential("MerchantSecretKey")
            .filter(|secret| !secret.is_empty())
            .map(|secret| {
                let canonical = canonicalize(
                    CanonicalizationMode::SortedKeyValueAmp,
                    &pg_crypto::canonical::CanonicalizationInput {
                        fields: fields.clone(),
                        ..pg_crypto::canonical::CanonicalizationInput::default()
                    },
                )
                .unwrap_or_default();
                decode_key(&secret, KeyEncoding::Hex)
                    .map(|key| {
                        encode_output(
                            &hmac_sha256(&key, canonical.as_bytes()),
                            OutputEncoding::HexUpper,
                        )
                    })
                    .unwrap_or_default()
            })
            .unwrap_or_default();
        let mut output = Map::new();
        output.insert("Amount".to_owned(), Value::String(amount));
        output.insert("AmountTrxn".to_owned(), Value::String(scaled));
        output.insert(
            "Currency".to_owned(),
            Value::String(
                context
                    .attempt_string("currency")
                    .unwrap_or_else(|| "LYD".to_owned()),
            ),
        );
        output.insert(
            "MerchantReference".to_owned(),
            Value::String(merchant_reference),
        );
        output.insert("TrxDateTime".to_owned(), Value::String(trx_date_time));
        output.insert("SecureHash".to_owned(), Value::String(secure_hash));
        Ok(Value::Object(output))
    }

    fn neompay(&self, context: &ComputeContext) -> Result<Value, EngineError> {
        let reference = context
            .attempt_string("gatewayReference")
            .or_else(|| context.attempt_string("reference"))
            .unwrap_or_default();
        let expires_at = context
            .attempt_string("expiresAt")
            .and_then(|raw| DateTime::parse_from_rfc3339(&raw).ok())
            .map(|value| value.with_timezone(&Utc))
            .unwrap_or_else(|| self.clock.now() + chrono::Duration::minutes(10));
        let request_id = self.rng.uuid().to_string();
        let qr_payload = [
            "neompay://pay".to_owned(),
            format!("ref={}", crate::selector::encode_uri_component(&reference)),
            format!("exp={}", expires_at.timestamp()),
            format!("nonce={request_id}"),
        ]
        .join("&");
        let mut output = Map::new();
        output.insert("qr_payload".to_owned(), Value::String(qr_payload));
        output.insert("request_id".to_owned(), Value::String(request_id));
        output.insert(
            "expires_at".to_owned(),
            Value::String(expires_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
        );
        output.insert("reference".to_owned(), Value::String(reference));
        Ok(Value::Object(output))
    }

    fn local_settlement(&self, context: &ComputeContext) -> Result<Value, EngineError> {
        let status = context
            .attempt_string("status")
            .unwrap_or_else(|| "UNKNOWN".to_owned());
        let settled = context.attempt_string("settledAmount");
        let provider_reference = context
            .attempt_string("providerReference")
            .filter(|value| !value.is_empty());
        let mut output = Map::new();
        output.insert(
            "status".to_owned(),
            Value::String(if status == "SUCCEEDED" {
                "SUCCESS".to_owned()
            } else {
                status
            }),
        );
        output.insert(
            "settled_amount".to_owned(),
            settled.map(Value::String).unwrap_or(Value::Null),
        );
        output.insert(
            "provider_reference".to_owned(),
            provider_reference.map(Value::String).unwrap_or(Value::Null),
        );
        output.insert(
            "currency".to_owned(),
            Value::String(
                context
                    .attempt_string("currency")
                    .unwrap_or_else(|| "LYD".to_owned()),
            ),
        );
        output.insert(
            "reference".to_owned(),
            Value::String(
                context
                    .attempt_string("gatewayReference")
                    .or_else(|| context.attempt_string("reference"))
                    .unwrap_or_default(),
            ),
        );
        Ok(Value::Object(output))
    }
}

#[async_trait]
impl ComputeRegistry for BuiltinComputeRegistry {
    async fn compute(
        &self,
        name: &str,
        _input: &Value,
        context: &ComputeContext,
    ) -> Result<Value, EngineError> {
        match name {
            "MOAMALAT_LIGHTBOX_PAYLOAD" => self.moamalat(context),
            "NEOMPAY_QR_PAYLOAD" => self.neompay(context),
            "LOCAL_SETTLEMENT_RECONCILE" => self.local_settlement(context),
            other => Err(EngineError::new(
                400,
                codes::UNKNOWN_COMPUTE_OPERATION,
                format!("Compute operation '{other}' is not registered"),
            )),
        }
    }
}

/// The Moamalat merchant reference: ten numeric digits derived from the reference.
#[must_use]
pub fn merchant_reference(source: &str) -> String {
    let digits: String = source.chars().filter(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return "0000000000".to_owned();
    }
    let mut value = digits.chars().take(10).collect::<String>();
    while value.len() < 10 {
        value.insert(0, '0');
    }
    value
}

fn scale_to_int(amount: &str, factor: i64) -> Result<String, EngineError> {
    let decimal = rust_decimal::Decimal::from_str_exact(amount.trim()).map_err(|_| {
        EngineError::with_code(
            400,
            "COMPUTE_INVALID_AMOUNT",
            format!("Invalid amount '{amount}'"),
        )
    })?;
    let scaled = decimal * rust_decimal::Decimal::from(factor);
    Ok(scaled.trunc().to_string())
}

fn format_tripoli(timestamp: DateTime<Utc>) -> String {
    use chrono::TimeZone as _;
    let zone: chrono_tz::Tz = chrono_tz::Africa::Tripoli;
    zone.from_utc_datetime(&timestamp.naive_utc())
        .format("%Y%m%d%H%M")
        .to_string()
}

#[allow(dead_code)]
fn escape(value: &str) -> String {
    xml_escape(&Value::String(value.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::{CounterRng, FixedClock};
    use serde_json::json;

    fn registry() -> BuiltinComputeRegistry {
        BuiltinComputeRegistry::new(
            Arc::new(FixedClock::at(1_700_000_000_000)),
            Arc::new(CounterRng::new(1)),
        )
    }

    fn context() -> ComputeContext {
        let mut attempt = Map::new();
        attempt.insert("reference".to_owned(), json!("ORD-000123"));
        attempt.insert("totalChargedAmount".to_owned(), json!("12.345"));
        attempt.insert("currency".to_owned(), json!("LYD"));
        attempt.insert("status".to_owned(), json!("SUCCEEDED"));
        attempt.insert("settledAmount".to_owned(), json!("12.3450"));
        attempt.insert("providerReference".to_owned(), json!("TX-1"));
        let mut credentials = Map::new();
        credentials.insert("MID".to_owned(), json!("MID-1"));
        credentials.insert("TID".to_owned(), json!("TID-1"));
        credentials.insert("MerchantSecretKey".to_owned(), json!("00ff10"));
        ComputeContext {
            attempt,
            credentials,
            ..ComputeContext::default()
        }
    }

    #[tokio::test]
    async fn moamalat_payload_matches_the_blueprint() {
        let value = registry()
            .compute("MOAMALAT_LIGHTBOX_PAYLOAD", &Value::Null, &context())
            .await
            .expect("compute");
        assert_eq!(value["Amount"], json!("12.345"));
        assert_eq!(value["AmountTrxn"], json!("12345"));
        assert_eq!(value["MerchantReference"], json!("0000000123"));
        assert_eq!(value["TrxDateTime"], json!("202311150013"));
        assert_eq!(value["Currency"], json!("LYD"));
        // The hash is deterministic for the seeded profile; it is long uppercase hex.
        let hash = value["SecureHash"].as_str().expect("hash");
        assert_eq!(hash.len(), 64);
        assert!(hash.chars().all(|character| character.is_ascii_hexdigit()));
        assert_eq!(hash, hash.to_ascii_uppercase());
    }

    #[tokio::test]
    async fn neompay_payload_is_bound_to_the_reference_and_expiry() {
        let value = registry()
            .compute("NEOMPAY_QR_PAYLOAD", &Value::Null, &context())
            .await
            .expect("compute");
        let payload = value["qr_payload"].as_str().expect("payload");
        assert!(payload.starts_with("neompay://pay&ref=ORD-000123&exp="));
        assert!(payload.contains("&nonce="));
        assert_eq!(value["reference"], json!("ORD-000123"));
    }

    #[tokio::test]
    async fn local_settlement_reads_the_attempt_snapshot() {
        let value = registry()
            .compute("LOCAL_SETTLEMENT_RECONCILE", &Value::Null, &context())
            .await
            .expect("compute");
        assert_eq!(value["status"], json!("SUCCESS"));
        assert_eq!(value["settled_amount"], json!("12.3450"));
        assert_eq!(value["provider_reference"], json!("TX-1"));
        assert_eq!(value["currency"], json!("LYD"));
    }

    #[tokio::test]
    async fn unknown_operations_are_refused() {
        let error = registry()
            .compute("DO_SOMETHING", &Value::Null, &context())
            .await
            .expect_err("unknown");
        assert_eq!(error.code, "UNKNOWN_COMPUTE_OPERATION");
        assert_eq!(BuiltinComputeRegistry::OPERATIONS.len(), 3);
    }

    #[test]
    fn merchant_reference_pads_and_truncates() {
        assert_eq!(merchant_reference("ORD-1"), "0000000001");
        assert_eq!(merchant_reference("123456789012"), "1234567890");
        assert_eq!(merchant_reference("no digits"), "0000000000");
    }
}

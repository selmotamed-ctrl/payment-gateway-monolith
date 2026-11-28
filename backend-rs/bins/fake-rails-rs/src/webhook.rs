//! Asynchronous outbound webhook dispatcher: delayed/duplicated/out-of-order/corrupt deliveries,
//! retry backoff and the SSRF host allowlist. Ported from `engine/webhooks/WebhookDispatcher.ts`.
//!
//! Transport deviation: the Rust port speaks plain HTTP/1.1 over `tokio::net::TcpStream`
//! (`https://` targets are recorded as failed deliveries; see README "Deviations").

#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Map, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::config::Config;
use crate::crypto::{
    derive_secret, sign, CanonicalizationMode, CryptoAlgorithm, OutputEncoding, SecretEncoding,
    SigningRecipe,
};
use crate::db::{now_iso, text, uuid_v7, Db};
use crate::error::{ApiError, ApiResult};
use crate::events::Hub;

#[derive(Debug, Clone, Default)]
pub struct WebhookBehavior {
    pub delay_seconds: f64,
    pub duplicate_count: f64,
    pub out_of_order_pending_after_paid: bool,
    pub corrupt_signature_chance_percent: f64,
}

impl WebhookBehavior {
    fn normalized(&self) -> Self {
        Self {
            delay_seconds: self.delay_seconds.max(0.0),
            duplicate_count: if self.duplicate_count > 0.0 {
                self.duplicate_count.min(5.0)
            } else {
                1.0
            },
            out_of_order_pending_after_paid: self.out_of_order_pending_after_paid,
            corrupt_signature_chance_percent: self
                .corrupt_signature_chance_percent
                .clamp(0.0, 100.0),
        }
    }
}

struct SignatureProfile {
    algorithm: CryptoAlgorithm,
    canonicalization_mode: CanonicalizationMode,
    output_encoding: OutputEncoding,
    secret_encoding: SecretEncoding,
    signature_header: &'static str,
    timestamp_header: Option<&'static str>,
}

fn profile_for(gateway_code: &str) -> SignatureProfile {
    let canonical = match gateway_code {
        "cbl_lypay" => "ly_pay",
        "evo_pay" => "evopay",
        other => other,
    };
    match canonical {
        "dpay" => SignatureProfile {
            algorithm: CryptoAlgorithm::HmacSha256,
            canonicalization_mode: CanonicalizationMode::TimestampDotRawBody,
            output_encoding: OutputEncoding::HexLower,
            secret_encoding: SecretEncoding::Utf8,
            signature_header: "X-DPay-Signature",
            timestamp_header: Some("X-DPay-Timestamp"),
        },
        "mypay" => SignatureProfile {
            algorithm: CryptoAlgorithm::HmacSha256,
            canonicalization_mode: CanonicalizationMode::RawBody,
            output_encoding: OutputEncoding::HexLower,
            secret_encoding: SecretEncoding::Utf8,
            signature_header: "X-MYPAY-SIGNATURE",
            timestamp_header: None,
        },
        "ly_pay" => SignatureProfile {
            algorithm: CryptoAlgorithm::HmacSha256,
            canonicalization_mode: CanonicalizationMode::SortedKeyValueAmp,
            output_encoding: OutputEncoding::HexUpper,
            secret_encoding: SecretEncoding::Utf8,
            signature_header: "X-LYPAY-Signature",
            timestamp_header: None,
        },
        "plutu" => SignatureProfile {
            algorithm: CryptoAlgorithm::HmacSha256,
            canonicalization_mode: CanonicalizationMode::SortedValuesHash,
            output_encoding: OutputEncoding::HexUpper,
            secret_encoding: SecretEncoding::Utf8,
            signature_header: "X-Plutu-Signature",
            timestamp_header: None,
        },
        "moamalat" => SignatureProfile {
            algorithm: CryptoAlgorithm::HmacSha256,
            canonicalization_mode: CanonicalizationMode::SortedKeyValueAmp,
            output_encoding: OutputEncoding::HexUpper,
            secret_encoding: SecretEncoding::Hex,
            signature_header: "SecureHash",
            timestamp_header: None,
        },
        "mpgs" => SignatureProfile {
            algorithm: CryptoAlgorithm::HmacSha256,
            canonicalization_mode: CanonicalizationMode::RawBody,
            output_encoding: OutputEncoding::HexLower,
            secret_encoding: SecretEncoding::Utf8,
            signature_header: "X-Notification-Secret",
            timestamp_header: None,
        },
        _ => SignatureProfile {
            algorithm: CryptoAlgorithm::HmacSha256,
            canonicalization_mode: CanonicalizationMode::SortedKeyValueAmp,
            output_encoding: OutputEncoding::HexLower,
            secret_encoding: SecretEncoding::Utf8,
            signature_header: "X-Fake-Rails-Signature",
            timestamp_header: None,
        },
    }
}

fn recipe_for(config: &Config, gateway_code: &str, corrupt: bool) -> SigningRecipe {
    let profile = profile_for(gateway_code);
    let secret = derive_secret(&config.seeder_token, gateway_code, "webhook");
    SigningRecipe {
        algorithm: profile.algorithm,
        canonicalization_mode: profile.canonicalization_mode,
        secret: if corrupt {
            format!("{secret}-tampered")
        } else {
            secret
        },
        secret_key_encoding: profile.secret_encoding,
        output_encoding: profile.output_encoding,
        template_string: None,
        included_fields: None,
        excluded_fields: None,
    }
}

/// Hosts a webhook may target: `CORE_INBOUND_BASE_URL` plus `FAKE_RAILS_WEBHOOK_ALLOWED_HOSTS`.
#[must_use]
pub fn allowed_webhook_hosts(config: &Config) -> Vec<String> {
    let mut hosts = std::collections::BTreeSet::new();
    if let Ok(url) = url::Url::parse(&config.core_inbound_base_url) {
        if url.host_str().is_some() {
            hosts.insert(format_host(&url));
        }
    }
    for entry in config.webhook_allowed_hosts.split(',') {
        let host = entry.trim().to_ascii_lowercase();
        if !host.is_empty() {
            hosts.insert(host);
        }
    }
    hosts.into_iter().collect()
}

fn format_host(url: &url::Url) -> String {
    let hostname = url.host_str().unwrap_or_default().to_ascii_lowercase();
    url.port()
        .map_or(hostname.clone(), |port| format!("{hostname}:{port}"))
}

/// Plain http(s), no credentials, and the host (or host:port) must be on the allowlist.
#[must_use]
pub fn webhook_target_allowed(value: &str, allowed: &[String]) -> bool {
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    if url.scheme() != "http" && url.scheme() != "https" {
        return false;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let host = format_host(&url);
    let hostname = url.host_str().unwrap_or_default().to_ascii_lowercase();
    allowed
        .iter()
        .any(|entry| *entry == host || (!entry.contains(':') && *entry == hostname))
}

fn percent_encode_path(value: &str) -> String {
    let mut output = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            output.push(char::from(byte));
        } else {
            output.push_str(&format!("%{byte:02X}"));
        }
    }
    output
}

fn default_url(config: &Config, transaction: &crate::db::Transaction) -> String {
    if let Some(url) = &transaction.webhook_url {
        return url.clone();
    }
    format!(
        "{}/{}/{}/{}",
        config.core_inbound_base_url.trim_end_matches('/'),
        percent_encode_path(&transaction.gateway_code),
        transaction.env.to_ascii_lowercase(),
        percent_encode_path(&format!("{}-webhook", transaction.gateway_code)),
    )
}

#[derive(Debug, Clone)]
pub struct DispatchInput<'a> {
    pub transaction: &'a crate::db::Transaction,
    pub event: &'a str,
    pub payload: Value,
    pub url: Option<&'a str>,
    pub behavior: WebhookBehavior,
    pub headers: BTreeMap<String, String>,
}

#[derive(Clone)]
pub struct WebhookService {
    db: Db,
    config: Arc<Config>,
    hub: Hub,
}

impl std::fmt::Debug for WebhookService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WebhookService").finish_non_exhaustive()
    }
}

impl WebhookService {
    #[must_use]
    pub fn new(db: Db, config: Arc<Config>, hub: Hub) -> Self {
        Self { db, config, hub }
    }

    /// Re-arms every delivery that was queued before a restart.
    pub fn resume_queued(&self) {
        let Ok(rows) = self.db.query_json(
            "SELECT id, scheduled_for FROM fake_webhook_deliveries WHERE state = 'QUEUED'",
            vec![],
        ) else {
            return;
        };
        for row in rows {
            let (Some(id), Some(scheduled)) = (
                row.get("id").and_then(Value::as_str),
                row.get("scheduled_for").and_then(Value::as_str),
            ) else {
                continue;
            };
            let delay = chrono::DateTime::parse_from_rfc3339(scheduled)
                .map(|instant| instant.timestamp_millis() - chrono::Utc::now().timestamp_millis())
                .unwrap_or(0)
                .max(0) as u64;
            self.schedule(id.to_owned(), delay);
        }
    }

    pub fn dispatch(&self, input: &DispatchInput<'_>) -> ApiResult<Vec<Value>> {
        let behavior = input.behavior.normalized();
        let url = input.url.map_or_else(
            || default_url(&self.config, input.transaction),
            str::to_owned,
        );
        let mut deliveries = Vec::new();
        let copies = behavior.duplicate_count.clamp(1.0, 5.0) as i64;
        for _ in 0..copies {
            deliveries.push(self.enqueue(
                input.transaction,
                input.event,
                &input.payload,
                &url,
                &behavior,
                &input.headers,
            )?);
        }
        if behavior.out_of_order_pending_after_paid {
            let lower = input.event.to_ascii_lowercase();
            let paid =
                lower.contains("paid") || lower.contains("success") || lower.contains("captured");
            if paid {
                let mut pending = input.payload.clone();
                if let Some(object) = pending.as_object_mut() {
                    object.insert("status".to_owned(), json!("PENDING"));
                    object.insert("event".to_owned(), json!("transaction.pending"));
                }
                let mut pending_behavior = behavior.clone();
                pending_behavior.delay_seconds += 2.0;
                pending_behavior.duplicate_count = 1.0;
                pending_behavior.out_of_order_pending_after_paid = false;
                deliveries.push(self.enqueue(
                    input.transaction,
                    "transaction.pending",
                    &pending,
                    &url,
                    &pending_behavior,
                    &input.headers,
                )?);
            }
        }
        Ok(deliveries)
    }

    fn enqueue(
        &self,
        transaction: &crate::db::Transaction,
        event: &str,
        payload: &Value,
        url: &str,
        behavior: &WebhookBehavior,
        extra_headers: &BTreeMap<String, String>,
    ) -> ApiResult<Value> {
        let profile = profile_for(&transaction.gateway_code);
        let mut prng =
            crate::chaos::Prng::new(&format!("{}:{}:{}", transaction.id, event, uuid_v7()));
        let corrupt = prng.chance(behavior.corrupt_signature_chance_percent);
        let timestamp = chrono::Utc::now().timestamp().to_string();
        let mut raw_object = payload.clone();
        if let Some(object) = raw_object.as_object_mut() {
            object.insert("event".to_owned(), json!(event));
        }
        let raw_body = raw_object.to_string();
        let signature = sign(
            &recipe_for(&self.config, &transaction.gateway_code, corrupt),
            payload,
            Some(&raw_body),
            Some(&timestamp),
        )?;
        let mut headers = Map::new();
        headers.insert("content-type".to_owned(), json!("application/json"));
        headers.insert(
            "x-fake-rails-signature-valid".to_owned(),
            json!(if corrupt { "false" } else { "true" }),
        );
        headers.insert("x-fake-rails-event".to_owned(), json!(event));
        headers.insert(profile.signature_header.to_owned(), json!(signature));
        if let Some(timestamp_header) = profile.timestamp_header {
            headers.insert(timestamp_header.to_owned(), json!(timestamp));
        }
        for (key, value) in extra_headers {
            headers.insert(key.clone(), json!(value));
        }
        let scheduled_for = (chrono::Utc::now()
            + chrono::Duration::milliseconds((behavior.delay_seconds.max(0.0) * 1000.0) as i64))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let id = uuid_v7();
        let created_at = now_iso();
        self.db.execute(
            "INSERT INTO fake_webhook_deliveries (
                id, transaction_id, gateway_code, url, request_headers_json, request_body_raw,
                signature_valid, attempt, max_attempts, state, response_status, response_body_raw,
                scheduled_for, sent_at, error, created_at
             ) VALUES (?,?,?,?,?,?,?,1,3,'QUEUED',NULL,NULL,?,NULL,NULL,?)",
            vec![
                text(id.clone()),
                text(transaction.id.clone()),
                text(transaction.gateway_code.clone()),
                text(url),
                text(Value::Object(headers.clone()).to_string()),
                text(raw_body),
                crate::db::int(i64::from(!corrupt)),
                text(scheduled_for.clone()),
                text(created_at),
            ],
        )?;
        self.hub.broadcast(
            "webhook.queued",
            json!({
                "type": "webhook.queued",
                "deliveryId": id,
                "transactionId": transaction.id,
                "gatewayCode": transaction.gateway_code,
                "event": event,
                "state": "QUEUED",
                "detail": { "scheduledFor": scheduled_for, "signatureValid": !corrupt },
            }),
        );
        self.schedule(
            id.clone(),
            (behavior.delay_seconds.max(0.0) * 1000.0) as u64,
        );
        self.get(&id)?
            .ok_or_else(|| ApiError::new(500, "DELIVERY_NOT_STORED", "delivery vanished"))
    }

    fn schedule(&self, delivery_id: String, delay_ms: u64) {
        let service = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            let _ = service.send(&delivery_id).await;
        });
    }

    /// Sends one queued delivery (or returns it unchanged when already sent).
    pub async fn send(&self, delivery_id: &str) -> ApiResult<Option<Value>> {
        let Some(row) = self.get(delivery_id)? else {
            return Ok(None);
        };
        if row["state"] == "SENT" {
            return Ok(Some(row));
        }
        let url = row["url"].as_str().unwrap_or_default().to_owned();
        let attempt = row["attempt"].as_i64().unwrap_or(1);
        let max_attempts = row["max_attempts"].as_i64().unwrap_or(3);
        let headers: BTreeMap<String, String> = row["request_headers_json"]
            .as_str()
            .and_then(|raw| serde_json::from_str(raw).ok())
            .unwrap_or_default();
        if !webhook_target_allowed(&url, &allowed_webhook_hosts(&self.config)) {
            self.db.execute(
                "UPDATE fake_webhook_deliveries SET state = 'FAILED', error = ? WHERE id = ?",
                vec![
                    text("webhook target host is not allowed"),
                    text(delivery_id),
                ],
            )?;
            return self.get(delivery_id);
        }
        let body = row["request_body_raw"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let timeout = Duration::from_millis(self.config.webhook_timeout_ms);
        match http_post(&url, &headers, &body, timeout).await {
            Ok((status, response_body)) => {
                let state = if (200..300).contains(&status) {
                    "SENT"
                } else if attempt >= max_attempts {
                    "FAILED"
                } else {
                    "QUEUED"
                };
                self.db.execute(
                    "UPDATE fake_webhook_deliveries
                        SET state = ?, response_status = ?, response_body_raw = ?, sent_at = ?, error = NULL
                      WHERE id = ?",
                    vec![
                        text(state),
                        crate::db::int(i64::from(status)),
                        text(response_body.chars().take(4000).collect::<String>()),
                        text(now_iso()),
                        text(delivery_id),
                    ],
                )?;
                self.hub.broadcast(
                    if state == "SENT" {
                        "webhook.sent"
                    } else {
                        "webhook.failed"
                    },
                    json!({
                        "type": if state == "SENT" { "webhook.sent" } else { "webhook.failed" },
                        "deliveryId": delivery_id,
                        "transactionId": row["transaction_id"],
                        "gatewayCode": row["gateway_code"],
                        "event": headers.get("x-fake-rails-event").cloned().unwrap_or_else(|| "unknown".to_owned()),
                        "state": state,
                        "detail": { "status": status },
                    }),
                );
                if state == "QUEUED" {
                    self.retry(delivery_id, attempt + 1)?;
                }
            }
            Err(error) => {
                let state = if attempt >= max_attempts {
                    "FAILED"
                } else {
                    "QUEUED"
                };
                self.db.execute(
                    "UPDATE fake_webhook_deliveries SET state = ?, error = ?, sent_at = ? WHERE id = ?",
                    vec![
                        text(state),
                        text(error.clone()),
                        text(now_iso()),
                        text(delivery_id),
                    ],
                )?;
                self.hub.broadcast(
                    "webhook.failed",
                    json!({
                        "type": "webhook.failed",
                        "deliveryId": delivery_id,
                        "transactionId": row["transaction_id"],
                        "gatewayCode": row["gateway_code"],
                        "event": headers.get("x-fake-rails-event").cloned().unwrap_or_else(|| "unknown".to_owned()),
                        "state": state,
                        "detail": { "error": error },
                    }),
                );
                if state == "QUEUED" {
                    self.retry(delivery_id, attempt + 1)?;
                }
            }
        }
        self.get(delivery_id)
    }

    fn retry(&self, delivery_id: &str, next_attempt: i64) -> ApiResult<()> {
        let delay_ms = 1000u64.saturating_mul(1u64 << (next_attempt.saturating_sub(1).min(6)));
        let scheduled = (chrono::Utc::now() + chrono::Duration::milliseconds(delay_ms as i64))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        self.db.execute(
            "UPDATE fake_webhook_deliveries SET attempt = ?, scheduled_for = ? WHERE id = ?",
            vec![
                crate::db::int(next_attempt),
                text(scheduled),
                text(delivery_id),
            ],
        )?;
        self.schedule(delivery_id.to_owned(), delay_ms);
        Ok(())
    }

    pub fn get(&self, delivery_id: &str) -> ApiResult<Option<Value>> {
        self.db.query_one_json(
            "SELECT * FROM fake_webhook_deliveries WHERE id = ?",
            vec![text(delivery_id)],
        )
    }

    pub fn list(&self, transaction_id: Option<&str>) -> ApiResult<Vec<Value>> {
        if let Some(transaction_id) = transaction_id {
            return self.db.query_json(
                "SELECT * FROM fake_webhook_deliveries WHERE transaction_id = ? ORDER BY created_at DESC",
                vec![text(transaction_id)],
            );
        }
        self.db.query_json(
            "SELECT * FROM fake_webhook_deliveries ORDER BY created_at DESC LIMIT 500",
            vec![],
        )
    }

    pub fn replay(&self, delivery_id: &str, tamper: bool) -> ApiResult<Option<Value>> {
        let Some(original) = self.get(delivery_id)? else {
            return Ok(None);
        };
        let mut headers: BTreeMap<String, Value> = original["request_headers_json"]
            .as_str()
            .and_then(|raw| serde_json::from_str(raw).ok())
            .unwrap_or_default();
        if tamper {
            for (key, value) in headers.iter_mut() {
                let lower = key.to_ascii_lowercase();
                if lower.contains("signature")
                    || lower.contains("securehash")
                    || lower.contains("notification-secret")
                {
                    *value = json!("forged-signature-0000");
                }
            }
            headers.insert("x-fake-rails-signature-valid".to_owned(), json!("false"));
        }
        let headers_json = Value::Object(headers.into_iter().collect()).to_string();
        self.db.execute(
            "UPDATE fake_webhook_deliveries
                SET request_headers_json = ?, state = 'QUEUED', attempt = 1, scheduled_for = ?,
                    sent_at = NULL, error = NULL
              WHERE id = ?",
            vec![text(headers_json), text(now_iso()), text(delivery_id)],
        )?;
        self.schedule(delivery_id.to_owned(), 0);
        self.get(delivery_id)
    }

    /// Records a delivery for a URL that is not even attempted (used by tests and by the seeded
    /// historical rows).
    pub fn force_state(&self, delivery_id: &str, state: &str) -> ApiResult<()> {
        self.db.execute(
            "UPDATE fake_webhook_deliveries SET state = ? WHERE id = ?",
            vec![text(state), text(delivery_id)],
        )?;
        Ok(())
    }
}

/// Minimal HTTP/1.1 POST (plain HTTP only, no redirects, capped response).
pub async fn http_post(
    url: &str,
    headers: &BTreeMap<String, String>,
    body: &str,
    timeout: Duration,
) -> Result<(u16, String), String> {
    let parsed = url::Url::parse(url).map_err(|error| error.to_string())?;
    if parsed.scheme() != "http" {
        return Err(format!(
            "unsupported webhook scheme '{}': the Rust port only delivers plain HTTP",
            parsed.scheme()
        ));
    }
    let host = parsed
        .host_str()
        .ok_or("webhook URL has no host")?
        .to_owned();
    let port = parsed.port_or_known_default().unwrap_or(80);
    let path = if parsed.path().is_empty() {
        "/".to_owned()
    } else {
        parsed.path().to_owned()
    };
    let path = parsed
        .query()
        .map_or(path.clone(), |query| format!("{path}?{query}"));
    let request_headers = headers.clone();
    let body_owned = body.to_owned();
    let exchange = async move {
        let mut stream = TcpStream::connect((host.as_str(), port))
            .await
            .map_err(|error| error.to_string())?;
        let mut request =
            format!("POST {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n");
        let mut has_content_type = false;
        for (key, value) in &request_headers {
            if key.eq_ignore_ascii_case("content-type") {
                has_content_type = true;
            }
            request.push_str(&format!("{key}: {value}\r\n"));
        }
        if !has_content_type {
            request.push_str("content-type: application/json\r\n");
        }
        request.push_str(&format!("Content-Length: {}\r\n\r\n", body_owned.len()));
        stream
            .write_all(request.as_bytes())
            .await
            .map_err(|error| error.to_string())?;
        stream
            .write_all(body_owned.as_bytes())
            .await
            .map_err(|error| error.to_string())?;
        stream.flush().await.map_err(|error| error.to_string())?;
        let mut response = Vec::new();
        let mut buffer = [0u8; 8192];
        loop {
            let read = stream
                .read(&mut buffer)
                .await
                .map_err(|error| error.to_string())?;
            if read == 0 {
                break;
            }
            response.extend_from_slice(&buffer[..read]);
            if response.len() > 64 * 1024 {
                break;
            }
        }
        let text = String::from_utf8_lossy(&response).into_owned();
        let status = text
            .split_whitespace()
            .nth(1)
            .and_then(|code| code.parse::<u16>().ok())
            .ok_or_else(|| "malformed HTTP response".to_owned())?;
        let body = text
            .split_once("\r\n\r\n")
            .map(|(_, body)| body.chars().take(4000).collect::<String>())
            .unwrap_or_default();
        Ok::<(u16, String), String>((status, body))
    };
    tokio::time::timeout(timeout, exchange)
        .await
        .map_err(|_| "webhook delivery timed out".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> Config {
        Config::test_config("/tmp/webhook-test.sqlite")
    }

    #[test]
    fn allowlist_matches_the_ts_behaviour() {
        let allowed = allowed_webhook_hosts(&config());
        assert!(allowed.contains(&"core.lab.internal:4103".to_owned()));
        assert!(allowed.contains(&"receiver.lab.internal".to_owned()));
        assert!(allowed.contains(&"hook.lab.internal:9443".to_owned()));
        for ok in [
            "http://core.lab.internal:4103/api/v1/inbound/webhook/x",
            "https://receiver.lab.internal/hook",
            "http://receiver.lab.internal:8080/hook",
            "https://hook.lab.internal:9443/a",
        ] {
            assert!(webhook_target_allowed(ok, &allowed), "{ok}");
        }
        for bad in [
            "http://169.254.169.254/latest/meta-data/",
            "http://127.0.0.1:4000/internal",
            "http://localhost/admin",
            "http://[::1]/",
            "http://core.lab.internal:4999/other-port",
            "http://hook.lab.internal:9444/wrong-port",
            "http://user:pass@receiver.lab.internal/hook",
            "http://receiver.lab.internal.evil.example/hook",
            "http://evil.example/?receiver.lab.internal",
            "file:///etc/passwd",
            "ftp://receiver.lab.internal/x",
            "javascript:alert(1)",
            "not a url",
            "",
        ] {
            assert!(!webhook_target_allowed(bad, &allowed), "{bad}");
        }
    }

    #[test]
    fn signature_profiles_match_the_gateway_families() {
        assert_eq!(
            profile_for("cbl_lypay").signature_header,
            "X-LYPAY-Signature"
        );
        assert_eq!(
            profile_for("evo_pay").signature_header,
            "X-Fake-Rails-Signature"
        );
        assert_eq!(profile_for("moamalat").signature_header, "SecureHash");
        assert_eq!(
            profile_for("dpay").timestamp_header,
            Some("X-DPay-Timestamp")
        );
    }

    #[tokio::test]
    async fn forbidden_stored_target_fails_without_a_request() {
        let db = Db::memory().expect("db");
        let config = Arc::new(config());
        let service = WebhookService::new(db.clone(), config, Hub::new());
        let id = uuid_v7();
        db.execute(
            "INSERT INTO fake_webhook_deliveries
               (id, transaction_id, gateway_code, url, request_headers_json, request_body_raw,
                attempt, max_attempts, state, scheduled_for, created_at)
             VALUES (?, 't-1', 'tlync', 'http://127.0.0.1:9/pwned', '{}', '{}', 1, 3, 'QUEUED', ?, ?)",
            vec![text(id.clone()), text(now_iso()), text(now_iso())],
        )
        .expect("insert");
        let row = service.send(&id).await.expect("send").expect("row");
        assert_eq!(row["state"], "FAILED");
        assert!(row["error"]
            .as_str()
            .unwrap_or_default()
            .contains("not allowed"));
    }

    #[tokio::test]
    async fn dispatch_creates_duplicates_and_out_of_order_pending() {
        let db = Db::memory().expect("db");
        let config = Arc::new(Config {
            webhook_allowed_hosts: "127.0.0.1:9".to_owned(),
            core_inbound_base_url: "http://127.0.0.1:9/api/v1/inbound".to_owned(),
            ..config()
        });
        let service = WebhookService::new(db.clone(), config, Hub::new());
        let transaction = transaction(&db);
        let deliveries = service
            .dispatch(&DispatchInput {
                transaction: &transaction,
                event: "payment.paid",
                payload: json!({"reference": "REF-1", "status": "PAID"}),
                url: Some("http://127.0.0.1:9/hook"),
                behavior: WebhookBehavior {
                    duplicate_count: 3.0,
                    out_of_order_pending_after_paid: true,
                    ..WebhookBehavior::default()
                },
                headers: BTreeMap::new(),
            })
            .expect("dispatch");
        assert_eq!(deliveries.len(), 4);
        let pending = &deliveries[3];
        assert!(pending["request_body_raw"]
            .as_str()
            .unwrap_or_default()
            .contains("transaction.pending"));
    }

    fn transaction(db: &Db) -> crate::db::Transaction {
        let now = now_iso();
        let transaction = crate::db::Transaction {
            id: uuid_v7(),
            gateway_code: "tlync".to_owned(),
            rail_code: "tlync".to_owned(),
            env: "SANDBOX".to_owned(),
            our_reference: "WH-1".to_owned(),
            provider_reference: format!("FK-TLYNC-{}", uuid_v7()),
            network_reference: None,
            idempotency_key: None,
            requested_amount_wire: "10.00".to_owned(),
            normalized_amount_lyd: "10.0000".to_owned(),
            settled_amount_lyd: Some("10.0000".to_owned()),
            gateway_fee_lyd: "0.0000".to_owned(),
            currency: "LYD".to_owned(),
            collection_mode: "REDIRECT".to_owned(),
            customer_identifier_masked: None,
            expected_otp: Some("123456".to_owned()),
            merchant_id: None,
            qr_payload: None,
            deep_link_url: None,
            redirect_url: None,
            account_id: None,
            held_amount_lyd: None,
            status: "PAID".to_owned(),
            assigned_fail_phase: None,
            assigned_failure_mode: None,
            inquiry_override_status: None,
            return_url: None,
            cancel_url: None,
            webhook_url: None,
            is_seeded_historical: 0,
            created_at: now.clone(),
            updated_at: now,
        };
        crate::db::insert_transaction(db, &transaction).expect("insert");
        transaction
    }
}

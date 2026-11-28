//! Minimal Fake Rails v2 control-plane client for the Sandbox checkout GET routes.
//!
//! Port of `core-back/engine/rails/FakeRailsControlClient.ts` restricted to the five reads the
//! checkout GET routes use (`listAccounts`, `getAccount`, `accountMovements`, `accountHolds`,
//! `checkoutHelper`):
//!
//! - base URL `FAKE_RAILS_CONTROL_URL`, else `FAKE_RAILS_PUBLIC_BASE_URL`, else
//!   `http://127.0.0.1:4104`; path `<base>/control/...`;
//! - `x-fake-rails-control-token` when `FAKE_RAILS_CONTROL_TOKEN` is configured;
//! - 10 s timeout, `accepted: application/json`, errors mapped exactly like the TS client
//!   (`FAKE_RAILS_UNAVAILABLE` 502 on transport/parse errors, the upstream status otherwise,
//!   `404` stays `404`, `5xx` becomes `502`).
//!
//! The control plane is plain HTTP on the private network, so this module speaks HTTP/1.1 over
//! `tokio::net::TcpStream`. A configured `https:` endpoint is refused with a documented deviation
//! (the P3 shell carries no TLS client; the object-storage daemon already has one for its own
//! mTLS plane). The token is never logged.

#![forbid(unsafe_code)]

use std::collections::HashMap;

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::{timeout, Duration};

use pg_http::ApiError;

/// `FakeRailsControlClient` default (`controlBaseUrl`).
const DEFAULT_BASE_URL: &str = "http://127.0.0.1:4104";
/// The TS client's `AbortController` budget.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// A bounded response buffer; account pages are small.
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

/// The configured control-plane client.
#[derive(Debug, Clone)]
pub(super) struct ControlClient {
    base: String,
    base_path: String,
    host_header: String,
    host: String,
    port: u16,
    token: Option<String>,
}

impl ControlClient {
    /// `new FakeRailsControlClient()` — reads the process environment on every construction, like
    /// the TS module reads `env` lazily.
    pub(super) fn from_env() -> Self {
        let configured = std::env::var("FAKE_RAILS_CONTROL_URL")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .or_else(|| {
                std::env::var("FAKE_RAILS_PUBLIC_BASE_URL")
                    .ok()
                    .filter(|value| !value.trim().is_empty())
            })
            .unwrap_or_else(|| DEFAULT_BASE_URL.to_owned());
        let base = configured.trim().trim_end_matches('/').to_owned();
        let token = std::env::var("FAKE_RAILS_CONTROL_TOKEN")
            .ok()
            .filter(|value| !value.is_empty());
        match url::Url::parse(&base) {
            Ok(parsed)
                if parsed.scheme() == "http"
                    && parsed.host_str().is_some()
                    && parsed.port_or_known_default().is_some() =>
            {
                let host = parsed.host_str().unwrap_or_default().to_owned();
                let port = parsed.port_or_known_default().unwrap_or(80);
                let default_port = port == 80;
                let host_header = if default_port {
                    host.clone()
                } else {
                    format!("{host}:{port}")
                };
                let base_path = parsed.path().trim_end_matches('/').to_owned();
                Self {
                    base,
                    base_path,
                    host_header,
                    host,
                    port,
                    token,
                }
            }
            _ => Self {
                // An unusable endpoint keeps the TS fallback and fails at request time with
                // FAKE_RAILS_UNAVAILABLE, exactly like an unreachable emulator.
                base,
                base_path: String::new(),
                host_header: String::new(),
                host: String::new(),
                port: 0,
                token,
            },
        }
    }

    /// `listAccounts({merchantId, railCode})`.
    pub(super) async fn list_accounts(
        &self,
        merchant_id: Option<&str>,
        rail_code: Option<&str>,
    ) -> Result<Vec<Value>, ApiError> {
        let mut query = Vec::new();
        if let Some(merchant_id) = merchant_id.filter(|value| !value.is_empty()) {
            query.push(format!("merchantId={}", encode_component(merchant_id)));
        }
        if let Some(rail_code) = rail_code.filter(|value| !value.is_empty()) {
            query.push(format!("railCode={}", encode_component(rail_code)));
        }
        let suffix = if query.is_empty() {
            String::new()
        } else {
            format!("?{}", query.join("&"))
        };
        let payload = self.request(&format!("/accounts{suffix}")).await?;
        Ok(payload
            .get("accounts")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    }

    /// `getAccount(accountId)`: `None` for an unknown account (the route answers its own 404).
    pub(super) async fn get_account(&self, account_id: &str) -> Result<Option<Value>, ApiError> {
        match self
            .request(&format!("/accounts/{}", encode_component(account_id)))
            .await
        {
            Ok(payload) => Ok(payload.get("account").cloned()),
            Err(error) if error.status == 404 => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// `accountMovements(accountId, limit)`.
    pub(super) async fn account_movements(
        &self,
        account_id: &str,
        limit: &str,
    ) -> Result<Vec<Value>, ApiError> {
        let payload = self
            .request(&format!(
                "/accounts/{}/movements?limit={}",
                encode_component(account_id),
                encode_component(limit)
            ))
            .await?;
        Ok(payload
            .get("movements")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    }

    /// `accountHolds(accountId, limit)`.
    pub(super) async fn account_holds(
        &self,
        account_id: &str,
        limit: &str,
    ) -> Result<Vec<Value>, ApiError> {
        let payload = self
            .request(&format!(
                "/accounts/{}/holds?limit={}",
                encode_component(account_id),
                encode_component(limit)
            ))
            .await?;
        Ok(payload
            .get("holds")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    }

    /// `checkoutHelper(reference)`.
    pub(super) async fn checkout_helper(&self, reference: &str) -> Result<Value, ApiError> {
        self.request(&format!("/checkout-helper/{}", encode_component(reference)))
            .await
    }

    async fn request(&self, path: &str) -> Result<Value, ApiError> {
        let (status, body) = self.send(path).await?;
        let payload: Value = if String::from_utf8_lossy(&body).trim().is_empty() {
            Value::Object(serde_json::Map::new())
        } else {
            serde_json::from_slice(&body).map_err(|_| {
                ApiError::new(
                    502,
                    "FAKE_RAILS_UNAVAILABLE",
                    "The Fake Rails emulator is unreachable: invalid JSON body",
                )
            })?
        };
        if (200..300).contains(&status) {
            return Ok(payload);
        }
        let code = payload
            .get("code")
            .and_then(Value::as_str)
            .or_else(|| payload.get("error").and_then(Value::as_str))
            .unwrap_or("FAKE_RAILS_CONTROL_ERROR")
            .to_owned();
        let message = payload
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| format!("Fake Rails answered {status}"));
        let mapped = if status == 404 {
            404
        } else if status >= 500 {
            502
        } else {
            status
        };
        Err(ApiError::new(mapped, code, message))
    }

    async fn send(&self, path: &str) -> Result<(u16, Vec<u8>), ApiError> {
        if self.host.is_empty() || self.port == 0 {
            return Err(ApiError::new(
                502,
                "FAKE_RAILS_UNAVAILABLE",
                format!(
                    "The Fake Rails emulator is unreachable: unsupported control URL '{}'",
                    self.base
                ),
            ));
        }
        let target = format!("{}/control{path}", self.base_path);
        let mut request = format!(
            "GET {target} HTTP/1.1\r\nHost: {host}\r\naccept: application/json\r\n\
             connection: close\r\n",
            host = self.host_header
        );
        if let Some(token) = &self.token {
            request.push_str(&format!("x-fake-rails-control-token: {token}\r\n"));
        }
        request.push_str("\r\n");
        let exchange = async {
            let mut stream = TcpStream::connect((self.host.as_str(), self.port))
                .await
                .map_err(transport_error)?;
            stream
                .write_all(request.as_bytes())
                .await
                .map_err(transport_error)?;
            stream.flush().await.map_err(transport_error)?;
            let mut buffer = Vec::new();
            let mut chunk = [0_u8; 16 * 1024];
            loop {
                let read = stream.read(&mut chunk).await.map_err(transport_error)?;
                if read == 0 {
                    break;
                }
                buffer.extend_from_slice(&chunk[..read]);
                if buffer.len() > MAX_RESPONSE_BYTES {
                    return Err(ApiError::new(
                        502,
                        "FAKE_RAILS_UNAVAILABLE",
                        "The Fake Rails emulator answered more than the 8 MiB response cap",
                    ));
                }
            }
            parse_response(&buffer)
        };
        timeout(REQUEST_TIMEOUT, exchange).await.map_err(|_| {
            ApiError::new(
                502,
                "FAKE_RAILS_UNAVAILABLE",
                "The Fake Rails emulator is unreachable: request timed out",
            )
        })?
    }
}

fn transport_error(error: std::io::Error) -> ApiError {
    ApiError::new(
        502,
        "FAKE_RAILS_UNAVAILABLE",
        format!("The Fake Rails emulator is unreachable: {error}"),
    )
}

fn parse_response(raw: &[u8]) -> Result<(u16, Vec<u8>), ApiError> {
    let split = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| {
            ApiError::new(
                502,
                "FAKE_RAILS_UNAVAILABLE",
                "The Fake Rails emulator is unreachable: malformed HTTP response",
            )
        })?;
    let head = String::from_utf8_lossy(&raw[..split]);
    let mut lines = head.split("\r\n");
    let status_line = lines.next().unwrap_or_default();
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| {
            ApiError::new(
                502,
                "FAKE_RAILS_UNAVAILABLE",
                "The Fake Rails emulator is unreachable: malformed status line",
            )
        })?;
    let mut headers: HashMap<String, String> = HashMap::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_owned());
        }
    }
    let body = &raw[split + 4..];
    let chunked = headers
        .get("transfer-encoding")
        .is_some_and(|value| value.to_ascii_lowercase().contains("chunked"));
    let body = if chunked {
        decode_chunked(body)?
    } else {
        body.to_vec()
    };
    Ok((status, body))
}

fn decode_chunked(mut body: &[u8]) -> Result<Vec<u8>, ApiError> {
    let mut decoded = Vec::new();
    while let Some(line_end) = body.windows(2).position(|window| window == b"\r\n") {
        let size_text = String::from_utf8_lossy(&body[..line_end]);
        let size = usize::from_str_radix(size_text.trim(), 16).unwrap_or(0);
        body = &body[line_end + 2..];
        if size == 0 {
            break;
        }
        if body.len() < size {
            return Err(ApiError::new(
                502,
                "FAKE_RAILS_UNAVAILABLE",
                "The Fake Rails emulator is unreachable: truncated chunked response",
            ));
        }
        decoded.extend_from_slice(&body[..size]);
        body = &body[(size + 2).min(body.len())..];
    }
    Ok(decoded)
}

/// `encodeURIComponent` (unreserved marks kept, everything else `%XX`).
fn encode_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        let keep = byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            );
        if keep {
            encoded.push(char::from(*byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn component_encoding_matches_encode_uri_component() {
        assert_eq!(encode_component("018f-abc_1.2~"), "018f-abc_1.2~");
        assert_eq!(encode_component("a b/c"), "a%20b%2Fc");
        assert_eq!(encode_component("é"), "%C3%A9");
    }

    #[test]
    fn plain_and_chunked_responses_parse() {
        let response =
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}";
        let (status, body) = parse_response(response).expect("plain");
        assert_eq!(status, 200);
        assert_eq!(body, b"{}");

        let chunked = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n";
        let (status, body) = parse_response(chunked).expect("chunked");
        assert_eq!(status, 200);
        assert_eq!(body, b"{}");
    }

    #[test]
    fn error_statuses_are_mapped_like_the_ts_client() {
        let (status, _) =
            parse_response(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n")
                .expect("status");
        assert_eq!(status, 503);
    }
}

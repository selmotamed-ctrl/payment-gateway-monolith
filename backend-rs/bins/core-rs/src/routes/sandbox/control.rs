//! Minimal Fake Rails v2 control-plane client for the Sandbox read routes.
//!
//! Port of the GET half of `core-back/engine/rails/FakeRailsControlClient.ts`:
//!
//! - base URL `FAKE_RAILS_CONTROL_URL`, else `FAKE_RAILS_PUBLIC_BASE_URL`, else
//!   `http://127.0.0.1:4104`; the path is `<base>/control/...`;
//! - `x-fake-rails-control-token` when `FAKE_RAILS_CONTROL_TOKEN` is configured;
//! - 10 s timeout, `accept: application/json`, the exact TS error mapping
//!   (`FAKE_RAILS_UNAVAILABLE` 502 on transport/parse errors, the upstream code and status
//!   otherwise, `404` stays `404`, `5xx` becomes `502`).
//!
//! The emulator's control plane is plain HTTP on the private network, so this module speaks
//! HTTP/1.1 over `tokio::net::TcpStream`. A configured `https:` endpoint is refused with
//! `FAKE_RAILS_UNAVAILABLE` (documented filler: the P3 shell carries no TLS client for the control
//! plane). The same blocked fallback the checkout module uses applies: `ControlClient` is kept local
//! to the Sandbox module because `routes::checkout::fake_rails` is private to its module.
//!
//! **DEV-SANDBOX-03:** the checkout inspector (`checkout-helper`) is read here too, because
//! `GET /internal/sandbox/merchant/payments/:attemptId` embeds it; the write helpers (create,
//! adjust, reset, replay, …) arrive with the P7 write routes.
//!
//! The token is never logged.

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
/// A bounded response buffer; account/tester pages are small.
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

/// The configured control-plane client.
#[derive(Debug, Clone)]
pub struct ControlClient {
    base: String,
    base_path: String,
    host_header: String,
    host: String,
    port: u16,
    token: Option<String>,
}

impl ControlClient {
    /// `new FakeRailsControlClient()`: reads the process environment on every construction, like the
    /// TS module reads `env` lazily.
    #[must_use]
    pub fn from_env() -> Self {
        let configured = std::env::var("FAKE_RAILS_CONTROL_URL")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .or_else(|| {
                std::env::var("FAKE_RAILS_PUBLIC_BASE_URL")
                    .ok()
                    .filter(|value| !value.trim().is_empty())
            })
            .unwrap_or_else(|| DEFAULT_BASE_URL.to_owned());
        let token = std::env::var("FAKE_RAILS_CONTROL_TOKEN")
            .ok()
            .filter(|value| !value.is_empty());
        Self::parse(&configured, token)
    }

    /// A client for an explicit endpoint (the database/transport tests).
    #[must_use]
    pub fn at(base: &str, token: Option<String>) -> Self {
        Self::parse(base, token)
    }

    fn parse(base: &str, token: Option<String>) -> Self {
        let base = base.trim().trim_end_matches('/').to_owned();
        match url::Url::parse(&base) {
            Ok(parsed)
                if parsed.scheme() == "http"
                    && parsed.host_str().is_some()
                    && parsed.port_or_known_default().is_some() =>
            {
                let host = parsed.host_str().unwrap_or_default().to_owned();
                let port = parsed.port_or_known_default().unwrap_or(80);
                let host_header = if port == 80 {
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
                // An unusable endpoint fails at request time with FAKE_RAILS_UNAVAILABLE, exactly
                // like an unreachable emulator.
                base,
                base_path: String::new(),
                host_header: String::new(),
                host: String::new(),
                port: 0,
                token,
            },
        }
    }

    /// `GET /control<path>` (the caller has already built and encoded the query string).
    pub async fn get(&self, path: &str) -> Result<Value, ApiError> {
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

    /// `listAccountsPage` / `listAccounts`: the endpoint's page payload (`{accounts, total, …}`).
    pub async fn accounts_page(&self, query: &[(&str, String)]) -> Result<Value, ApiError> {
        self.get(&format!("/accounts{}", query_string(query))).await
    }

    /// The `accounts` array of a non-paged account list (`{accounts}`).
    pub async fn accounts(&self, query: &[(&str, String)]) -> Result<Vec<Value>, ApiError> {
        let payload = self.accounts_page(query).await?;
        Ok(payload
            .get("accounts")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    }

    /// `getAccount(accountId)`: the whole `{account}` payload.
    ///
    /// A 404 is propagated with the emulator's code (`FAKE_ACCOUNT_NOT_FOUND`), exactly like the TS
    /// `request()` helper; `getAccount`'s `null` branch only fires for a 200 without `account`.
    pub async fn account(&self, account_id: &str) -> Result<Value, ApiError> {
        self.get(&format!("/accounts/{}", encode_component(account_id)))
            .await
    }

    /// `accountMovements`: `{movements}` with the emulator's rows.
    pub async fn movements(&self, account_id: &str, limit: &str) -> Result<Value, ApiError> {
        let payload = self
            .get(&format!(
                "/accounts/{}/movements?limit={}",
                encode_component(account_id),
                encode_component(limit)
            ))
            .await?;
        Ok(serde_json::json!({
            "movements": payload.get("movements").cloned().unwrap_or_else(|| Value::Array(Vec::new()))
        }))
    }

    /// `accountHolds`: `{holds}` with the emulator's rows.
    pub async fn holds(&self, account_id: &str, limit: &str) -> Result<Value, ApiError> {
        let payload = self
            .get(&format!(
                "/accounts/{}/holds?limit={}",
                encode_component(account_id),
                encode_component(limit)
            ))
            .await?;
        Ok(serde_json::json!({
            "holds": payload.get("holds").cloned().unwrap_or_else(|| Value::Array(Vec::new()))
        }))
    }

    /// `GET /scenarios` (`{rails, scenarios}`).
    pub async fn scenarios(&self) -> Result<Value, ApiError> {
        self.get("/scenarios").await
    }

    /// `GET /transactions` (`{total, rows}`).
    pub async fn transactions(&self, query: &[(&str, String)]) -> Result<Value, ApiError> {
        self.get(&format!("/transactions{}", query_string(query)))
            .await
    }

    /// `GET /transactions/summary`.
    pub async fn transaction_summary(&self) -> Result<Value, ApiError> {
        self.get("/transactions/summary").await
    }

    /// `GET /transactions/:id` (`{transaction, events, deliveries}`).
    pub async fn transaction(&self, transaction_id: &str) -> Result<Value, ApiError> {
        self.get(&format!(
            "/transactions/{}",
            encode_component(transaction_id)
        ))
        .await
    }

    /// `GET /webhooks?transactionId=…`: the `deliveries` array.
    pub async fn webhook_deliveries(
        &self,
        transaction_id: Option<&str>,
    ) -> Result<Vec<Value>, ApiError> {
        let path = match transaction_id.filter(|value| !value.is_empty()) {
            Some(id) => format!("/webhooks?transactionId={}", encode_component(id)),
            None => "/webhooks".to_owned(),
        };
        let payload = self.get(&path).await?;
        Ok(payload
            .get("deliveries")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    }

    /// `GET /statements`: the `statements` array.
    pub async fn statements(&self) -> Result<Vec<Value>, ApiError> {
        let payload = self.get("/statements").await?;
        Ok(payload
            .get("statements")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    }

    /// `GET /clearing/pools` (`{pools}`).
    pub async fn clearing_pools(&self) -> Result<Value, ApiError> {
        self.get("/clearing/pools").await
    }

    /// `checkoutHelper(reference)` (`{activeAttemptSecrets}`).
    pub async fn checkout_helper(&self, reference: &str) -> Result<Value, ApiError> {
        self.get(&format!("/checkout-helper/{}", encode_component(reference)))
            .await
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
            // Header values cannot contain a CR/LF; the token comes from configuration.
            let token = token.replace(['\r', '\n'], "");
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
#[must_use]
pub fn encode_component(value: &str) -> String {
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

/// `URLSearchParams.toString()` for the filters the Sandbox reads send (order kept, blanks dropped).
#[must_use]
pub fn query_string(query: &[(&str, String)]) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in query {
        if value.is_empty() {
            continue;
        }
        serializer.append_pair(key, value);
    }
    let encoded = serializer.finish();
    if encoded.is_empty() {
        String::new()
    } else {
        format!("?{encoded}")
    }
}

/// `Number(text)` and `String(number)` for the emulator's numeric query parameters.
///
/// `Number('abc')` is `NaN` and `String(NaN)` is `"NaN"`; the emulator owns the validation, so the
/// Sandbox forwards exactly what the TS client would send.
#[must_use]
pub fn js_number_text(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return "0".to_owned();
    }
    match trimmed.parse::<f64>() {
        Ok(number) if number.is_finite() => {
            if number.fract() == 0.0 && number.abs() < 9_007_199_254_740_992.0 {
                format!("{}", number as i64)
            } else {
                number.to_string()
            }
        }
        _ => "NaN".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// One-shot HTTP server on 127.0.0.1 that answers `response` to the first request.
    fn serve_once(response: &'static [u8]) -> (String, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().expect("address");
        let handle = std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut request = [0_u8; 4096];
                let _ = stream.read(&mut request);
                let _ = stream.write_all(response);
                let _ = stream.flush();
            }
        });
        (format!("http://127.0.0.1:{}", address.port()), handle)
    }

    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(future)
    }

    #[test]
    fn component_encoding_matches_encode_uri_component() {
        assert_eq!(encode_component("018f-abc_1.2~"), "018f-abc_1.2~");
        assert_eq!(encode_component("a b/c"), "a%20b%2Fc");
        assert_eq!(encode_component("é"), "%C3%A9");
    }

    #[test]
    fn query_string_drops_blanks_and_keeps_every_pair() {
        assert_eq!(
            query_string(&[("railCode", "edfali".to_owned()), ("search", String::new())]),
            "?railCode=edfali"
        );
        assert_eq!(query_string(&[]), "");
    }

    #[test]
    fn js_number_text_matches_javascript_number_rendering() {
        assert_eq!(js_number_text("12"), "12");
        assert_eq!(js_number_text("12.0"), "12");
        assert_eq!(js_number_text("abc"), "NaN");
        assert_eq!(js_number_text(""), "0");
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
    fn a_5xx_control_answer_maps_to_502_with_the_upstream_code() {
        let (base, handle) = serve_once(
            b"HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\n\
              Content-Length: 59\r\n\r\n\
              {\"code\":\"FAKE_RAILS_CONTROL_DISABLED\",\"message\":\"off\"}  ",
        );
        let client = ControlClient::at(&base, None);
        let error = block_on(client.get("/scenarios")).expect_err("mapped");
        assert_eq!(error.status, 502);
        assert_eq!(error.code, "FAKE_RAILS_CONTROL_DISABLED");
        handle.join().expect("server");
    }

    #[test]
    fn a_404_control_answer_stays_404_with_the_upstream_code() {
        let body = b"{\"code\":\"FAKE_ACCOUNT_NOT_FOUND\",\"message\":\"Account x not found\"}";
        let mut response = format!(
            "HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
            body.len()
        )
        .into_bytes();
        response.extend_from_slice(body);
        let leaked: &'static [u8] = Box::leak(response.into_boxed_slice());
        let (base, handle) = serve_once(leaked);
        let client = ControlClient::at(&base, None);
        let error = block_on(client.account("x")).expect_err("mapped");
        assert_eq!(error.status, 404);
        assert_eq!(error.code, "FAKE_ACCOUNT_NOT_FOUND");
        handle.join().expect("server");
    }

    #[test]
    fn an_unreachable_emulator_is_fake_rails_unavailable() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("address").port();
        drop(listener);
        let client = ControlClient::at(&format!("http://127.0.0.1:{port}"), None);
        let error = block_on(client.get("/pools")).expect_err("unreachable");
        assert_eq!(error.status, 502);
        assert_eq!(error.code, "FAKE_RAILS_UNAVAILABLE");
    }
}

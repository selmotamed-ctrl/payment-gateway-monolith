//! Edge → core executor: mTLS client, least-in-flight pools, retries and limits.
//!
//! Port of `admin-back/lib/coreInternalClient.ts` and chapter 2 §10. The decision logic lives in
//! `pg-upstream` (`UpstreamPool`, `AttemptLoop`, path confinement, header hygiene, retry policy);
//! this module owns the socket. The Sandbox pool is a separate `UpstreamPool`; when it is not
//! configured the call fails with `503 SANDBOX_NODE_UNAVAILABLE` and never falls back to Live.

#![forbid(unsafe_code)]

use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use bytes::Bytes;
use pg_upstream::{
    build_core_headers, now_millis, resolve_core_url, AttemptDecision, AttemptLoop, CoreMethod,
    CoreRequestMeta, EdgeChannel, HeaderSet, LoopFinish, Plane, PoolError, QueryValue,
    RetryOptions, TransportFailure, UpstreamPool,
};
use serde_json::Value;

use crate::config::Config;
use crate::error::{map_transport_error, ApiError, EdgeResult};

/// One request to core.
#[derive(Debug, Clone)]
pub struct CoreRequest {
    pub method: CoreMethod,
    pub path: String,
    pub query: Vec<(String, QueryValue)>,
    pub headers: HeaderSet,
    pub body: Option<Bytes>,
    pub timeout_ms: u64,
    pub retry: RetryOptions,
    pub idempotency_key: Option<String>,
}

/// A buffered core response.
#[derive(Debug, Clone)]
pub struct CoreResponse {
    pub status: u16,
    pub headers: HeaderSet,
    pub body: Bytes,
}

impl CoreResponse {
    #[must_use]
    pub fn json(&self) -> Value {
        let text = String::from_utf8_lossy(&self.body);
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Value::Object(serde_json::Map::new());
        }
        serde_json::from_str(trimmed).unwrap_or_else(|_| serde_json::json!({ "message": text }))
    }

    #[must_use]
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name)
    }
}

/// A failed attempt: either the transport failed or the edge refused the response locally.
#[derive(Debug, Clone)]
pub enum SendError {
    /// A network/TLS failure with whether anything reached the wire.
    Transport {
        failure: TransportFailure,
        connect_phase: bool,
    },
    /// A local policy failure (response too large, invalid URL). Never counts against the node.
    Local(PoolError),
}

/// One node's HTTP transport. In production this is reqwest; tests inject a fake.
#[async_trait]
pub trait NodeSender: Send + Sync {
    async fn send(
        &self,
        node_url: &str,
        request: &CoreRequest,
        timeout: Duration,
    ) -> Result<CoreResponse, SendError>;
}

/// Real mTLS sender (TLS 1.3 only, internal CA, client certificate).
pub struct ReqwestSender {
    client: reqwest::Client,
    max_response_bytes: u64,
}

impl ReqwestSender {
    pub fn new(config: &Config) -> Result<Self, anyhow::Error> {
        // `reqwest` is built with `rustls-no-provider`: install the ring provider once before
        // any client is constructed, or the first TLS handshake panics.
        pg_mtls::install_crypto_provider();
        let mut pem = std::fs::read(&config.mtls_client_cert).map_err(|error| {
            anyhow::anyhow!(
                "MTLS_CLIENT_CERT_PATH cannot be read ({}): {error}",
                config.mtls_client_cert.display()
            )
        })?;
        if !pem.ends_with(b"\n") {
            pem.push(b'\n');
        }
        pem.extend_from_slice(&std::fs::read(&config.mtls_client_key).map_err(|error| {
            anyhow::anyhow!(
                "MTLS_CLIENT_KEY_PATH cannot be read ({}): {error}",
                config.mtls_client_key.display()
            )
        })?);
        let ca = std::fs::read(&config.mtls_ca_cert).map_err(|error| {
            anyhow::anyhow!(
                "MTLS_CA_CERT_PATH cannot be read ({}): {error}",
                config.mtls_ca_cert.display()
            )
        })?;
        let identity = reqwest::Identity::from_pem(&pem).map_err(|error| {
            anyhow::anyhow!("client certificate/key are not a valid PEM pair: {error}")
        })?;
        let root = reqwest::Certificate::from_pem(&ca).map_err(|error| {
            anyhow::anyhow!("internal CA is not a valid PEM certificate: {error}")
        })?;
        let client = reqwest::Client::builder()
            .add_root_certificate(root)
            .identity(identity)
            .min_tls_version(reqwest::tls::Version::TLS_1_3)
            .max_tls_version(reqwest::tls::Version::TLS_1_3)
            .pool_idle_timeout(Duration::from_secs(30))
            .pool_max_idle_per_host(64)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| anyhow::anyhow!("mTLS client build failed: {error}"))?;
        Ok(Self {
            client,
            max_response_bytes: config.max_response_bytes,
        })
    }
}

#[async_trait]
impl NodeSender for ReqwestSender {
    async fn send(
        &self,
        node_url: &str,
        request: &CoreRequest,
        timeout: Duration,
    ) -> Result<CoreResponse, SendError> {
        let url = resolve_core_url(EdgeChannel::Admin, node_url, &request.path, &request.query)
            .map_err(SendError::Local)?;
        let method = reqwest::Method::from_bytes(request.method.as_str().as_bytes())
            .map_err(|_| SendError::Local(PoolError::path_invalid("Unsupported method")))?;
        let mut builder = self.client.request(method, url).timeout(timeout);
        for (name, value) in request.headers.entries() {
            if name.eq_ignore_ascii_case("content-length") {
                continue;
            }
            builder = builder.header(name, value);
        }
        if let Some(body) = &request.body {
            builder = builder.body(body.clone());
        }
        let response = builder.send().await.map_err(|error| SendError::Transport {
            failure: TransportFailure::from_reqwest(&error),
            connect_phase: error.is_connect(),
        })?;
        let status = response.status().as_u16();
        let mut headers = HeaderSet::new();
        for (name, value) in response.headers() {
            if let Ok(value) = value.to_str() {
                headers.set(name.as_str(), value);
            }
        }
        if let Some(declared) = response.content_length() {
            if declared > self.max_response_bytes {
                return Err(SendError::Local(PoolError::response_too_large(
                    self.max_response_bytes,
                )));
            }
        }
        let mut body = Vec::new();
        let mut response = response;
        loop {
            let chunk = response
                .chunk()
                .await
                .map_err(|error| SendError::Transport {
                    failure: TransportFailure::from_reqwest(&error),
                    connect_phase: false,
                })?;
            let Some(chunk) = chunk else {
                break;
            };
            if body.len() as u64 + chunk.len() as u64 > self.max_response_bytes {
                return Err(SendError::Local(PoolError::response_too_large(
                    self.max_response_bytes,
                )));
            }
            body.extend_from_slice(&chunk);
        }
        Ok(CoreResponse {
            status,
            headers,
            body: Bytes::from(body),
        })
    }
}

/// The two core planes, kept strictly apart.
pub struct CoreClient {
    live: UpstreamPool,
    sandbox: Option<UpstreamPool>,
    sender: Arc<dyn NodeSender>,
    total_deadline_ms: u64,
    request_timeout_ms: u64,
}

impl CoreClient {
    #[must_use]
    pub fn new(config: &Config, sender: Arc<dyn NodeSender>) -> Self {
        Self {
            live: UpstreamPool::with_defaults(config.core_urls.clone()),
            sandbox: config
                .sandbox_core_urls
                .as_ref()
                .map(|urls| UpstreamPool::with_defaults(urls.clone())),
            sender,
            total_deadline_ms: config.total_deadline_ms,
            request_timeout_ms: config.request_timeout_ms,
        }
    }

    /// Call core on the requested plane.
    pub async fn call(&self, plane: Plane, request: &CoreRequest) -> EdgeResult<CoreResponse> {
        let pool = match plane {
            Plane::Live => &self.live,
            Plane::Sandbox => self.sandbox.as_ref().ok_or_else(|| {
                ApiError::new(
                    503,
                    "SANDBOX_NODE_UNAVAILABLE",
                    "The Sandbox environment is not configured on this gateway",
                )
            })?,
        };
        if pool.is_empty() {
            return Err(map_transport_error(&PoolError::unavailable()));
        }
        let mut attempt = AttemptLoop::new(
            pool,
            request.method,
            request.idempotency_key.as_deref(),
            request.retry,
        );
        let timeout_ms = request
            .timeout_ms
            .max(self.request_timeout_ms)
            .min(self.total_deadline_ms);
        let deadline = Instant::now() + Duration::from_millis(self.total_deadline_ms);
        let mut last_response: Option<CoreResponse> = None;
        loop {
            let now = now_millis();
            let Some(node) = attempt.next_node(now) else {
                break;
            };
            let node_url = node.url().to_owned();
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                match attempt.record_transport(TransportFailure::Timeout, false, now_millis()) {
                    AttemptDecision::Retry => continue,
                    AttemptDecision::Fail(error) => return Err(map_transport_error(&error)),
                    AttemptDecision::Accept => {}
                }
            }
            let attempt_timeout = Duration::from_millis(timeout_ms).min(remaining);
            let outcome = tokio::time::timeout(
                attempt_timeout,
                self.sender.send(&node_url, request, attempt_timeout),
            )
            .await;
            match outcome {
                Ok(Ok(response)) => match attempt.record_response(response.status, now_millis()) {
                    AttemptDecision::Accept => return Ok(response),
                    AttemptDecision::Retry => {
                        last_response = Some(response);
                    }
                    AttemptDecision::Fail(error) => return Err(map_transport_error(&error)),
                },
                Ok(Err(SendError::Local(error))) => return Err(map_transport_error(&error)),
                Ok(Err(SendError::Transport {
                    failure,
                    connect_phase,
                })) => match attempt.record_transport(failure, connect_phase, now_millis()) {
                    AttemptDecision::Retry => continue,
                    AttemptDecision::Fail(error) => return Err(map_transport_error(&error)),
                    AttemptDecision::Accept => {}
                },
                Err(_elapsed) => {
                    match attempt.record_transport(TransportFailure::Timeout, false, now_millis()) {
                        AttemptDecision::Retry => continue,
                        AttemptDecision::Fail(error) => return Err(map_transport_error(&error)),
                        AttemptDecision::Accept => {}
                    }
                }
            }
        }
        match attempt.finish(now_millis()) {
            LoopFinish::Response(_status) => match last_response {
                Some(response) => Ok(response),
                None => Err(map_transport_error(&PoolError::gateway_timeout())),
            },
            LoopFinish::Error(error) => Err(map_transport_error(&error)),
        }
    }
}

/// Build the headers of one core call, exactly like `buildCoreHeaders`.
#[allow(clippy::too_many_arguments)]
pub fn core_headers(
    caller: &[(&str, &str)],
    request_id: &str,
    client_ip: &str,
    user_agent: Option<&str>,
    authorization: Option<&str>,
    body_present: bool,
    raw_content_type: Option<&str>,
    min_lsn: Option<&str>,
    idempotency_key: Option<&str>,
    plane: Plane,
) -> EdgeResult<HeaderSet> {
    build_core_headers(
        caller,
        &CoreRequestMeta {
            channel: EdgeChannel::Admin,
            plane,
            request_id,
            client_ip,
            user_agent,
            authorization,
            body_present,
            raw_content_type,
            min_lsn,
            idempotency_key,
        },
    )
    .map_err(|error| map_transport_error(&error))
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_CA: &str = "-----BEGIN CERTIFICATE-----
MIIDGzCCAgOgAwIBAgIUeCYavhWdP3LtGmILy8WcI6lVDtwwDQYJKoZIhvcNAQEL
BQAwHTEbMBkGA1UEAwwSYWRtaW4tZWRnZSB0ZXN0IENBMB4XDTI2MTEyODExMDA0
MFoXDTM2MTEyNTExMDA0MFowHTEbMBkGA1UEAwwSYWRtaW4tZWRnZSB0ZXN0IENB
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAn2f/X5uBTLvYxO8fp+ci
lsgOPat3fCYANa88huiaeVbZJHTu38d8aZOcM0/YsMTeTPi7YEYmysp/HRk9O6G1
2cO6ph9ZfNqyqY1DqQujRI2jmR7Y1zcDeC3j+8SxiSeZuHZ/cP4nEX/P3mH6WxqL
nrQv7sxEoOFZo/gWqtoFeE6hcdePc33fqohfPHPkFCXY4/XYlrEr3r9g26n0g8hg
7yE99yqb4SjAH0J2h0N6MfEgRnvRSqw92NjLagRkGYoHTZJPFreEDVmNVdjP3phI
kmXqBsj7PWt5YA1EGJYlm0F7LKBtiSbHywMpBln/A8YUfbxAcmocY6aM1jDVul8r
EQIDAQABo1MwUTAdBgNVHQ4EFgQU4TLn6hMDbX7EGSKQPLzkQyLIks0wHwYDVR0j
BBgwFoAU4TLn6hMDbX7EGSKQPLzkQyLIks0wDwYDVR0TAQH/BAUwAwEB/zANBgkq
hkiG9w0BAQsFAAOCAQEAVm9zLhux8PwzFK3UEVUtlg1QR9ZkEgEojTi9kAOLrKTJ
6+g2DtHE2dfnVdJjukcXMfb3J399wqi6XtpBQlkiO1Wf/vpVh1nGwKZJ+JW1ftOS
+ruX9lIRXqcz/kVLOYiwdpkIt+L60FklB6pLgvsXhNcJ6N4ey7TT+6aEBIE7OIjj
mr5cxX6Pw1D309Q+nL25dQ8xB2bZpJ+lUVaav5juxqaX2r/SBLBIqv3o/QEblEJB
g1/S6Dt2DsCHiRoxBcZtrdIqe3VltvF/8L/mbuTgSB4FnAmxrQ7Xz4it9DtS7rCO
1EKPnJB68sOR+/p06JLkcBVyV/TZxZSgOBKamaKlTg==
-----END CERTIFICATE-----";
    const TEST_CLIENT_CERT: &str = "-----BEGIN CERTIFICATE-----
MIIDAjCCAeqgAwIBAgIUNUH4qen/b0gPioRIIiaLWlM5HsYwDQYJKoZIhvcNAQEL
BQAwHTEbMBkGA1UEAwwSYWRtaW4tZWRnZSB0ZXN0IENBMB4XDTI2MTEyODExMDA0
MFoXDTM2MTEyNTExMDA0MFowFTETMBEGA1UEAwwKYWRtaW4tYmFjazCCASIwDQYJ
KoZIhvcNAQEBBQADggEPADCCAQoCggEBAO36qDkBFs6O/2g/NKRVuP8wxAYJnU8V
t65yi1IeHpBNB08QHCRXXcV6BWBr/ShvyySicMu95oF2PzTHeLFsQ1UL15WuAXXh
20erMsyRd5HLrK28rVjlS0JhxnH4/r6B/Yj5szwR6S2yTVEICwfe1eiRO5CL8FzH
da14WcwekG7tEGVof41jSpQRSyyu4Q5HF5FGBEKjSBw9vnbpRlPFzcPNYl68jHyM
AaieLBRxAmysZG8tihlHbVxcAdZi/U12qfC254/n7d0RyE2gKSPHR0225vkcJyu+
0TizI/zNX8jTdtKbcEgzHzBJperchOxOrYHPmHe//YrTaA/ZkPjoMkUCAwEAAaNC
MEAwHQYDVR0OBBYEFF2RegOvAYXP8SRvp8+cwK+zUUm0MB8GA1UdIwQYMBaAFOEy
5+oTA21+xBkikDy85EMiyJLNMA0GCSqGSIb3DQEBCwUAA4IBAQBR199byDOA+S1Z
WgoX1ZEeEMjL2qMbOr+YqELZhm+tEwhrX1Htm76OILB1TyqaMrIgU09c3MUm6nMC
JKVbiZiBvF98b1mZywqaebAmYxaPGf6Otudb732Nieso5f8G7rkYymjq3YNnAFoZ
6r6gjRZmR8fMTShs0WxGNzePWPKUwu85tZqh2PVdIIvmCrBgUpzDL3vHbYZNpTlT
7rrAiCRokwMtIQjOfj2AZ+BGBX8n85d/tBRwe3Sk6m7xjt8hjwag3s3k1TL6c/jc
98ympcOzvPBX9sHnkiJffSK6UOev4EOEvxYt3PrPyXAiHYodXS4GUkW4xylV2e9w
26EcskvD
-----END CERTIFICATE-----";
    const TEST_CLIENT_KEY: &str = "-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDt+qg5ARbOjv9o
PzSkVbj/MMQGCZ1PFbeucotSHh6QTQdPEBwkV13FegVga/0ob8skonDLveaBdj80
x3ixbENVC9eVrgF14dtHqzLMkXeRy6ytvK1Y5UtCYcZx+P6+gf2I+bM8Eektsk1R
CAsH3tXokTuQi/Bcx3WteFnMHpBu7RBlaH+NY0qUEUssruEORxeRRgRCo0gcPb52
6UZTxc3DzWJevIx8jAGoniwUcQJsrGRvLYoZR21cXAHWYv1NdqnwtueP5+3dEchN
oCkjx0dNtub5HCcrvtE4syP8zV/I03bSm3BIMx8wSaXq3ITsTq2Bz5h3v/2K02gP
2ZD46DJFAgMBAAECggEABv07Vw8/4PmkqSZgEKp+2CnRu/6oytOPtTUif9soGSNW
AV2vAec59wyGH2aUhQ1BeVY2+1jcrfUv1og8NHPCR3tlTb1SSCjFtKVjxMvJ5/OE
IwcdTTTQwMaX2i2Op8AwFseEmtFI2KF5sVVL46OJAz9OsUhW2xa1j05vTrYgFk3c
E3Q1QPBp+UYnnKMPC5VITXFARn5PDlNlHptVhMDrtkdL6AcDj0wYixJ8rCM0DaBd
0YL1qjHjakGCA95q4vLFEMHFNrLPr/+IKT4VMFWKirR9CwI/TMxmQ7oVZ4HDm1YB
zGCfmAOWqaehCsLvdqYpMyw73u7xrNqjPR/s3HmRsQKBgQD5O08wLgtJ6rSIYqJh
f7djpi0wIy7ZVx2vKpYnhE387CxYMj6xFzmMuf1lztNwxaObt1cgNe9se1wIOQtE
C1LOntQh7NifBPi44bYg4ZTSg3P2uiZgOMvi/HV3vGy2EIHfVSCNwB2mSaM2XD2Z
Zwt2xE+/br1li8VL3+q3MX7MNQKBgQD0cR5ern4FKKFffvp8NoCONwkJ4/2eu8FE
qnbyxjt4PCVauzdA3rN4qsq0bsv+zh1wuAAFP/DgkquuSLpHdTFjWLDdtwHSvkQQ
4Z+xJt4MWVY5bpH7nNXcXNjfFJBDbSf6D8uOSdBJWlM3JQS0cg9lP1IFosmnSRBK
1jupnIbv0QKBgBwL55JlbBHKXryGVP2h0LJfDfC/1NLScd23biROSDRxI2Bdbx6g
nXJPr8tYJgUnyIyKajyOtT3A+A9Y1AK5P31O9FJJA+uJNLAhfkxe9k9mSZN3SUBE
w/TsMg/iXV1zqBnIy5wIBY4j9UD1ylzL8sdPuiWxwZB+1Rn/vbsVz84NAoGAZHw/
7NI0cfBy7ivn0rog/NV4/LzhnKg4Wf7taP2+or2u6W5+10b1ZkxniebmKzgV+Clb
sMzJO7hvpPS2xvtRMzLZejtqH3UhzALEP/HnZBIxlOh0UIf3jmAIsyPj7iPoRC7M
EhEb85uTC99G4Nrmo0t1b2WtGfy6GtmYqy/ydJECgYEA2u+qIbi0FfA+YVMB5HLT
Ip36/jpCHrB5bl1H+w/4GrWsayFYyuX6YuTJC4H8YgoeAuBaiXrB3wtqpxez/xH3
7nvzzNiAh9RY1f3d7M2JgH2Auqu22/BemTmMi7ooZnNG8p5ASvBPCBAuQ2qWCpZf
J0REDW5zO5Rzat9BXE9DKoQ=
-----END PRIVATE KEY-----";

    #[test]
    fn response_json_parses_and_falls_back_to_message() {
        let response = CoreResponse {
            status: 200,
            headers: HeaderSet::new(),
            body: Bytes::from_static(br#"{"code":"X"}"#),
        };
        assert_eq!(response.json()["code"], "X");
        let text = CoreResponse {
            status: 502,
            headers: HeaderSet::new(),
            body: Bytes::from_static(b"bad gateway"),
        };
        assert_eq!(text.json()["message"], "bad gateway");
    }

    #[test]
    fn builds_the_mtls_client_with_the_ring_provider() {
        // `reqwest` is built with `rustls-no-provider`; constructing the client proves the
        // provider is installed (otherwise rustls panics) and the PEM material parses.
        let dir = tempfile::tempdir().expect("tempdir");
        let ca = dir.path().join("ca.pem");
        let cert = dir.path().join("client.pem");
        let key = dir.path().join("client.key");
        std::fs::write(&ca, TEST_CA).expect("ca");
        std::fs::write(&cert, TEST_CLIENT_CERT).expect("cert");
        std::fs::write(&key, TEST_CLIENT_KEY).expect("key");
        let env = pg_config::Env::process()
            .with_value("CORE_BACK_URL", "https://core.internal:4000")
            .with_value("MTLS_CLIENT_CERT_PATH", cert.to_string_lossy())
            .with_value("MTLS_CLIENT_KEY_PATH", key.to_string_lossy())
            .with_value("MTLS_CA_CERT_PATH", ca.to_string_lossy());
        let config = crate::config::Config::from_env(&env).expect("config");
        let sender = ReqwestSender::new(&config).expect("client");
        assert!(sender.max_response_bytes > 0);
    }
}

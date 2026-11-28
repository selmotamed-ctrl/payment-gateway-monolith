//! A local HTTP/HTTPS test server for the egress executor.
//!
//! Every connection is served once (`connection: close`) so a test can assert exactly what the
//! client sent. The TLS variant terminates rustls on a blocking thread fed by a
//! `tokio::net::TcpListener`, because the workspace has no `tokio-rustls` dependency; the
//! certificates come from `rcgen`.

#![allow(dead_code)]

use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use rcgen::{BasicConstraints, CertificateParams, DnType, IsCa, Issuer, KeyPair};
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::server::WebPkiClientVerifier;
use rustls::{RootCertStore, ServerConfig, ServerConnection, StreamOwned};

/// The host every test target uses; the resolver pins it to the loopback server.
pub const TEST_HOST: &str = "gateway.test";

/// One request the server received.
#[derive(Debug, Clone)]
pub struct CapturedRequest {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl CapturedRequest {
    #[must_use]
    pub fn header(&self, name: &str) -> Option<&str> {
        let name = name.to_ascii_lowercase();
        self.headers
            .iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| value.as_str())
    }

    #[must_use]
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

/// One answer the server writes.
#[derive(Debug, Clone, Default)]
pub struct TestResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    /// Delay before the answer is written (timeout tests).
    pub delay: Option<Duration>,
    /// Write only the head and then close (truncated-body tests).
    pub truncate: bool,
    /// Use `transfer-encoding: chunked` with no `content-length` (streaming-cap tests).
    pub chunked: bool,
}

impl TestResponse {
    #[must_use]
    pub fn json(status: u16, value: &serde_json::Value) -> Self {
        Self {
            status,
            headers: vec![("content-type".to_owned(), "application/json".to_owned())],
            body: serde_json::to_vec(value).unwrap_or_default(),
            ..Self::default()
        }
    }

    #[must_use]
    pub fn text(status: u16, content_type: &str, body: impl Into<String>) -> Self {
        Self {
            status,
            headers: vec![("content-type".to_owned(), content_type.to_owned())],
            body: body.into().into_bytes(),
            ..Self::default()
        }
    }

    #[must_use]
    pub fn empty(status: u16) -> Self {
        Self {
            status,
            ..Self::default()
        }
    }

    #[must_use]
    pub fn with_header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_owned(), value.to_owned()));
        self
    }

    #[must_use]
    pub fn with_delay(mut self, delay: Duration) -> Self {
        self.delay = Some(delay);
        self
    }

    #[must_use]
    pub fn truncated(mut self) -> Self {
        self.truncate = true;
        self
    }

    #[must_use]
    pub fn chunked(mut self) -> Self {
        self.chunked = true;
        self
    }
}

/// A synchronous request handler.
pub type Handler = Arc<dyn Fn(&CapturedRequest) -> TestResponse + Send + Sync>;

/// A running test server.
pub struct TestServer {
    pub port: u16,
    pub secure: bool,
    requests: Arc<Mutex<Vec<CapturedRequest>>>,
    saw_client_certificate: Arc<AtomicBool>,
}

impl TestServer {
    /// Start a plain-HTTP server.
    pub async fn http(handler: Handler) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind the test server");
        let port = listener.local_addr().expect("local addr").port();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                let handler = handler.clone();
                let requests = captured.clone();
                let Ok(stream) = stream.into_std() else {
                    continue;
                };
                if stream.set_nonblocking(false).is_err() {
                    continue;
                }
                thread::spawn(move || {
                    let mut stream = stream;
                    serve(&mut stream, &handler, &requests);
                });
            }
        });
        Self {
            port,
            secure: false,
            requests,
            saw_client_certificate: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Start an HTTPS server with a certificate from the test CA.
    pub async fn https(handler: Handler, pki: &TestPki, require_client_certificate: bool) -> Self {
        let config = pki.server_config(require_client_certificate);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind the test server");
        let port = listener.local_addr().expect("local addr").port();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        let saw_client_certificate = Arc::new(AtomicBool::new(false));
        let saw = saw_client_certificate.clone();
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                let handler = handler.clone();
                let requests = captured.clone();
                let config = config.clone();
                let saw = saw.clone();
                let Ok(stream) = stream.into_std() else {
                    continue;
                };
                if stream.set_nonblocking(false).is_err() {
                    continue;
                }
                thread::spawn(move || {
                    let Ok(connection) = ServerConnection::new(config) else {
                        return;
                    };
                    let mut stream = StreamOwned::new(connection, stream);
                    let served = serve(&mut stream, &handler, &requests);
                    if served && stream.conn.peer_certificates().is_some() {
                        saw.store(true, Ordering::SeqCst);
                    }
                });
            }
        });
        Self {
            port,
            secure: true,
            requests,
            saw_client_certificate,
        }
    }

    #[must_use]
    pub fn url(&self, path: &str) -> String {
        let scheme = if self.secure { "https" } else { "http" };
        format!("{scheme}://{TEST_HOST}:{}{path}", self.port)
    }

    #[must_use]
    pub fn address(&self) -> &'static str {
        "127.0.0.1"
    }

    #[must_use]
    pub fn requests(&self) -> Vec<CapturedRequest> {
        self.requests.lock().expect("requests lock").clone()
    }

    #[must_use]
    pub fn request_count(&self) -> usize {
        self.requests.lock().expect("requests lock").len()
    }

    #[must_use]
    pub fn saw_client_certificate(&self) -> bool {
        self.saw_client_certificate.load(Ordering::SeqCst)
    }
}

/// Handler from a plain closure.
#[must_use]
pub fn handler(
    handle: impl Fn(&CapturedRequest) -> TestResponse + Send + Sync + 'static,
) -> Handler {
    Arc::new(handle)
}

fn serve<S: Read + Write>(
    stream: &mut S,
    handler: &Handler,
    requests: &Mutex<Vec<CapturedRequest>>,
) -> bool {
    let Some(captured) = read_request(stream) else {
        return false;
    };
    requests
        .lock()
        .expect("requests lock")
        .push(captured.clone());
    let response = handler(&captured);
    if let Some(delay) = response.delay {
        thread::sleep(delay);
    }
    write_response(stream, &response);
    true
}

fn read_request<S: Read>(stream: &mut S) -> Option<CapturedRequest> {
    let mut buffer: Vec<u8> = Vec::new();
    let mut chunk = [0_u8; 8192];
    let header_end = loop {
        if let Some(position) = find(&buffer, b"\r\n\r\n") {
            break position + 4;
        }
        match stream.read(&mut chunk) {
            Ok(0) => return None,
            Ok(read) => buffer.extend_from_slice(&chunk[..read]),
            Err(_) => return None,
        }
        if buffer.len() > 64 * 1024 {
            return None;
        }
    };
    let head = String::from_utf8_lossy(&buffer[..header_end - 4]).into_owned();
    let mut lines = head.split("\r\n");
    let request_line = lines.next()?;
    let mut parts = request_line.split(' ');
    let method = parts.next()?.to_owned();
    let path = parts.next()?.to_owned();
    let mut headers: Vec<(String, String)> = Vec::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let (name, value) = line.split_once(':')?;
        headers.push((name.trim().to_ascii_lowercase(), value.trim().to_owned()));
    }
    let declared: usize = headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .and_then(|(_, value)| value.parse().ok())
        .unwrap_or(0);
    let mut body = buffer[header_end..].to_vec();
    while body.len() < declared {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => body.extend_from_slice(&chunk[..read]),
            Err(_) => break,
        }
    }
    body.truncate(declared);
    Some(CapturedRequest {
        method,
        path,
        headers,
        body,
    })
}

fn write_response<S: Write>(stream: &mut S, response: &TestResponse) {
    let reason = match response.status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        301 => "Moved Permanently",
        302 => "Found",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "Test",
    };
    if response.chunked {
        let mut head = format!(
            "HTTP/1.1 {} {reason}\r\ntransfer-encoding: chunked\r\nconnection: close\r\n",
            response.status
        );
        for (name, value) in &response.headers {
            head.push_str(&format!("{name}: {value}\r\n"));
        }
        head.push_str("\r\n");
        let _ = stream.write_all(head.as_bytes());
        for chunk in response.body.chunks(700) {
            let _ = stream.write_all(format!("{:x}\r\n", chunk.len()).as_bytes());
            let _ = stream.write_all(chunk);
            let _ = stream.write_all(b"\r\n");
        }
        let _ = stream.write_all(b"0\r\n\r\n");
        let _ = stream.flush();
        return;
    }
    let mut head = format!(
        "HTTP/1.1 {} {reason}\r\ncontent-length: {}\r\nconnection: close\r\n",
        response.status,
        response.body.len()
    );
    for (name, value) in &response.headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    let _ = stream.write_all(head.as_bytes());
    if !response.truncate {
        let _ = stream.write_all(&response.body);
    }
    let _ = stream.flush();
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// A throwaway CA plus a server and a client certificate.
pub struct TestPki {
    pub ca_pem: String,
    pub server_cert_pem: String,
    pub server_key_pem: String,
    pub client_cert_pem: String,
    pub client_key_pem: String,
    ca_der: CertificateDer<'static>,
    server_cert_der: CertificateDer<'static>,
    server_key_der: Vec<u8>,
}

impl TestPki {
    #[must_use]
    pub fn generate(host: &str) -> Self {
        pg_mtls::install_crypto_provider();
        let mut ca_params = CertificateParams::new(Vec::<String>::new()).expect("CA params");
        ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        ca_params
            .distinguished_name
            .push(DnType::CommonName, "pg-egress test CA");
        let ca_key = KeyPair::generate().expect("CA key");
        let ca_cert = ca_params.self_signed(&ca_key).expect("CA certificate");
        let issuer = Issuer::new(ca_params.clone(), &ca_key);

        let mut server_params =
            CertificateParams::new(vec![host.to_owned()]).expect("server params");
        server_params
            .distinguished_name
            .push(DnType::CommonName, host);
        let server_key = KeyPair::generate().expect("server key");
        let server_cert = server_params
            .signed_by(&server_key, &issuer)
            .expect("server certificate");

        let mut client_params =
            CertificateParams::new(vec!["gateway-client".to_owned()]).expect("client params");
        client_params
            .distinguished_name
            .push(DnType::CommonName, "gateway-client");
        let client_key = KeyPair::generate().expect("client key");
        let client_cert = client_params
            .signed_by(&client_key, &issuer)
            .expect("client certificate");

        Self {
            ca_pem: ca_cert.pem(),
            server_cert_pem: server_cert.pem(),
            server_key_pem: server_key.serialize_pem(),
            client_cert_pem: client_cert.pem(),
            client_key_pem: client_key.serialize_pem(),
            ca_der: ca_cert.der().clone(),
            server_cert_der: server_cert.der().clone(),
            server_key_der: server_key.serialize_der(),
        }
    }

    #[must_use]
    pub fn server_config(&self, require_client_certificate: bool) -> Arc<ServerConfig> {
        pg_mtls::install_crypto_provider();
        let builder = ServerConfig::builder();
        let builder = if require_client_certificate {
            let mut roots = RootCertStore::empty();
            roots.add(self.ca_der.clone()).expect("CA root");
            builder.with_client_cert_verifier(
                WebPkiClientVerifier::builder(Arc::new(roots))
                    .build()
                    .expect("client verifier"),
            )
        } else {
            builder.with_no_client_auth()
        };
        let key = PrivateKeyDer::Pkcs8(self.server_key_der.clone().into());
        let config = builder
            .with_single_cert(vec![self.server_cert_der.clone()], key)
            .expect("server config");
        Arc::new(config)
    }

    /// The mutual-TLS credential map for `GatewayCredentials`.
    #[must_use]
    pub fn client_credentials(&self) -> Vec<(&'static str, String)> {
        vec![
            ("certificate", self.client_cert_pem.clone()),
            ("privateKey", self.client_key_pem.clone()),
            ("ca", self.ca_pem.clone()),
        ]
    }
}

/// A clock the test moves by hand.
pub struct ManualClock(std::sync::atomic::AtomicU64);

impl ManualClock {
    #[must_use]
    pub fn new(now_ms: u64) -> Arc<Self> {
        Arc::new(Self(std::sync::atomic::AtomicU64::new(now_ms)))
    }

    pub fn advance(&self, delta_ms: u64) {
        self.0.fetch_add(delta_ms, Ordering::SeqCst);
    }

    #[must_use]
    pub fn as_clock(self: &Arc<Self>) -> Arc<dyn pg_egress::executor::Clock> {
        self.clone()
    }
}

impl pg_egress::executor::Clock for ManualClock {
    fn now_ms(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}

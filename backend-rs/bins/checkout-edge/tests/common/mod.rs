//! Shared test harness: a deterministic fake core and an ntex pipeline.
//!
//! No live core, TLS server or PostgreSQL is required. The fake implements [`CoreTransport`],
//! records every request (node URL, path, query, headers, body) and answers from a closure.

#![allow(dead_code)]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use checkout_edge::config::CheckoutConfig;
use checkout_edge::core::{
    CoreClient, CoreHttpRequest, CoreResponse, CoreStreamResponse, CoreTransport,
    CoreTransportError, StreamBody,
};
use checkout_edge::server::init_test_pipeline;
use checkout_edge::EdgeService;
use futures_util::stream;
use ntex::http::{HeaderMap, Request, Response, StatusCode};
use ntex::service::Pipeline;
use ntex::util::Bytes;
use ntex::web::{self, WebError};

/// One request the edge sent to a fake core.
#[derive(Debug, Clone)]
pub struct RecordedCall {
    pub node: String,
    pub method: String,
    pub path: String,
    pub query: Vec<(String, String)>,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl RecordedCall {
    #[must_use]
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    #[must_use]
    pub fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body).unwrap_or(serde_json::Value::Null)
    }
}

/// What the fake core answers.
pub enum MockReply {
    Buffered {
        status: u16,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    },
    Stream {
        status: u16,
        headers: Vec<(String, String)>,
        chunks: Vec<Vec<u8>>,
    },
    Fail(CoreTransportError),
}

impl MockReply {
    #[must_use]
    pub fn json(status: u16, value: serde_json::Value) -> Self {
        Self::Buffered {
            status,
            headers: vec![("content-type".to_owned(), "application/json".to_owned())],
            body: serde_json::to_vec(&value).unwrap_or_default(),
        }
    }

    #[must_use]
    pub fn ok(value: serde_json::Value) -> Self {
        Self::json(200, value)
    }
}

type Responder = dyn Fn(&RecordedCall) -> MockReply + Send + Sync;

/// A fake core transport.
pub struct MockTransport {
    calls: Mutex<Vec<RecordedCall>>,
    responder: Box<Responder>,
}

impl MockTransport {
    pub fn new<F>(responder: F) -> Arc<Self>
    where
        F: Fn(&RecordedCall) -> MockReply + Send + Sync + 'static,
    {
        Arc::new(Self {
            calls: Mutex::new(Vec::new()),
            responder: Box::new(responder),
        })
    }

    /// A fake that answers every call with `value`.
    pub fn always(value: serde_json::Value) -> Arc<Self> {
        Self::new(move |_| MockReply::ok(value.clone()))
    }

    #[must_use]
    pub fn calls(&self) -> Vec<RecordedCall> {
        self.calls.lock().expect("calls").clone()
    }

    #[must_use]
    pub fn count(&self) -> usize {
        self.calls.lock().expect("calls").len()
    }

    #[must_use]
    pub fn last(&self) -> Option<RecordedCall> {
        self.calls.lock().expect("calls").last().cloned()
    }

    fn record(&self, node_url: &str, request: &CoreHttpRequest) -> RecordedCall {
        let call = RecordedCall {
            node: node_url.to_owned(),
            method: request.method.as_str().to_owned(),
            path: request.url.path().to_owned(),
            query: request
                .url
                .query_pairs()
                .map(|(key, value)| (key.into_owned(), value.into_owned()))
                .collect(),
            headers: request.headers.clone(),
            body: request.body.clone().unwrap_or_default(),
        };
        self.calls.lock().expect("calls").push(call.clone());
        call
    }
}

#[async_trait]
impl CoreTransport for MockTransport {
    async fn send(
        &self,
        node_url: &str,
        request: CoreHttpRequest,
    ) -> Result<CoreResponse, CoreTransportError> {
        let recorded = self.record(node_url, &request);
        match (self.responder)(&recorded) {
            MockReply::Buffered {
                status,
                headers,
                body,
            } => Ok(CoreResponse {
                status,
                headers,
                body,
            }),
            MockReply::Stream {
                status,
                headers,
                chunks,
            } => Ok(CoreResponse {
                status,
                headers,
                body: chunks.concat(),
            }),
            MockReply::Fail(error) => Err(error),
        }
    }

    async fn open(
        &self,
        node_url: &str,
        request: CoreHttpRequest,
    ) -> Result<CoreStreamResponse, CoreTransportError> {
        let recorded = self.record(node_url, &request);
        match (self.responder)(&recorded) {
            MockReply::Buffered {
                status,
                headers,
                body,
            } => Ok(CoreStreamResponse {
                status,
                headers,
                body: StreamBody::Buffered(body),
            }),
            MockReply::Stream {
                status,
                headers,
                chunks,
            } => Ok(CoreStreamResponse {
                status,
                headers,
                body: StreamBody::Live(Box::pin(stream::iter(
                    chunks
                        .into_iter()
                        .map(|chunk| Ok(Bytes::copy_from_slice(&chunk))),
                ))),
            }),
            MockReply::Fail(error) => Err(error),
        }
    }
}

/// The pipeline under test plus its service.
pub struct TestApp {
    pub service: Arc<EdgeService>,
    pub app: Pipeline<Request, Response, WebError<(), ntex::web::DefaultError>>,
}

impl TestApp {
    pub async fn start(config: CheckoutConfig, core: Arc<dyn CoreTransport>) -> Self {
        let config = Arc::new(config);
        let client = Arc::new(CoreClient::new(
            &config.core,
            core,
            Duration::from_secs(5),
            Duration::from_secs(30),
            64 * 1024 * 1024,
        ));
        let service = Arc::new(EdgeService::new(config, client));
        let app = init_test_pipeline(Arc::clone(&service)).await;
        Self { service, app }
    }

    /// Start with a fake core and the standard test config.
    pub async fn with_core(core: Arc<dyn CoreTransport>) -> Self {
        Self::start(
            CheckoutConfig::for_tests(
                vec!["https://core.test:4000".to_owned()],
                Some(vec!["https://sandbox.test:4005".to_owned()]),
            ),
            core,
        )
        .await
    }

    pub async fn call(&self, request: Request) -> TestResponse {
        let response = ntex::web::test::call_service(&self.app, request).await;
        TestResponse::from_response(response).await
    }

    /// Return the response without reading its body, so an SSE stream slot stays open.
    pub async fn call_headers(&self, request: Request) -> Response {
        ntex::web::test::call_service(&self.app, request).await
    }
}

/// A response with status, headers and body already read.
pub struct TestResponse {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
}

impl TestResponse {
    async fn from_response(response: Response) -> Self {
        let status = response.status();
        let headers = response.headers().clone();
        let body = web::test::read_body(response).await.to_vec();
        Self {
            status,
            headers,
            body,
        }
    }

    #[must_use]
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|value| value.to_str().ok())
    }

    #[must_use]
    pub fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body).unwrap_or(serde_json::Value::Null)
    }

    #[must_use]
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

/// Request builders.
#[must_use]
pub fn get(path: &str) -> web::test::TestRequest {
    base(web::test::TestRequest::get(), path)
}

#[must_use]
pub fn post(path: &str, body: &str) -> web::test::TestRequest {
    base(web::test::TestRequest::post(), path)
        .header(ntex::http::header::CONTENT_TYPE, "application/json")
        .payload(body.to_owned())
}

#[must_use]
pub fn post_empty(path: &str) -> web::test::TestRequest {
    base(web::test::TestRequest::post(), path)
}

#[must_use]
pub fn patch(path: &str, body: &str) -> web::test::TestRequest {
    base(web::test::TestRequest::patch(), path)
        .header(ntex::http::header::CONTENT_TYPE, "application/json")
        .payload(body.to_owned())
}

#[must_use]
pub fn put(path: &str, body: &str) -> web::test::TestRequest {
    base(web::test::TestRequest::put(), path)
        .header(ntex::http::header::CONTENT_TYPE, "application/json")
        .payload(body.to_owned())
}

fn base(mut request: web::test::TestRequest, path: &str) -> web::test::TestRequest {
    request = request.uri(path);
    request = request.peer_addr("127.0.0.1:50000".parse().expect("peer"));
    request
}

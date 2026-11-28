//! ntex HTTP adapter.
//!
//! The TS edge terminates no TLS itself (Nginx does), so the Rust edge serves plain HTTP. The
//! middleware reproduces `checkout-back/index.ts`: security headers, CORS allow-list, request id
//! and the request log line, then the health route, the inbound router, the pay limiter, the
//! global body parser, the api router and the 404 handler.

#![forbid(unsafe_code)]

use std::sync::Arc;
use std::time::Instant;

use ntex::http::body::BodySize;
use ntex::http::body::MessageBody;
use ntex::http::header::{HeaderName, HeaderValue};
use ntex::http::{HeaderMap, Method, StatusCode};
use ntex::web::{self, middleware::from_fn, App, HttpRequest, HttpResponse, WebAppConfig};
use pg_http::RequestId;

use crate::logging::redact_url;
use crate::routes::match_route;
use crate::service::{Classification, EdgeService, RequestMeta};
use crate::EdgeFailure;

const SECURITY_HEADERS: [(&str, &str); 6] = [
    ("x-content-type-options", "nosniff"),
    ("referrer-policy", "no-referrer"),
    ("x-frame-options", "DENY"),
    ("content-security-policy", "frame-ancestors 'none'"),
    // checkout-back/lib/security/index.ts uses `cross-origin`, unlike the shared prose in
    // chapter 2 §2. TS wins (track P).
    ("cross-origin-resource-policy", "cross-origin"),
    ("cache-control", "no-store"),
];

/// The application chain. It is expanded in [`run_server`] and in the test pipeline because the
/// ntex `AppServices` type only implements `IntoServiceFactory` (not a nameable `ServiceFactory`).
macro_rules! app_for {
    ($service:expr) => {
        App::new()
            .with_config(WebAppConfig::new().set_value($service))
            .middleware(from_fn(async |req, next| {
                let started = Instant::now();
                let request_id = RequestId::from_incoming(
                    req.headers()
                        .get(pg_http::request_id::REQUEST_ID_HEADER)
                        .and_then(|value| value.to_str().ok())
                        .map(str::trim)
                        .filter(|value| !value.is_empty()),
                );
                req.extensions_mut().insert(request_id.clone());
                let method = req.method().clone();
                let path = req.path().to_owned();
                let query = req.query_string().to_owned();
                let service = req.app_value::<Arc<EdgeService>>().cloned();

                // CORS preflight: only when `CORS_ALLOWED_ORIGINS` is configured (the TS
                // middleware calls `next()` without the cors handler when the list is empty).
                if method == Method::OPTIONS {
                    if let Some(service) = &service {
                        if service.config().cors.is_enabled()
                            && req.headers().get("access-control-request-method").is_some()
                        {
                            let origin = req
                                .headers()
                                .get(ntex::http::header::ORIGIN)
                                .and_then(|value| value.to_str().ok());
                            let requested_headers = req
                                .headers()
                                .get("access-control-request-headers")
                                .and_then(|value| value.to_str().ok());
                            let allow_origin = service.config().cors.allow_origin(origin);
                            let mut builder = HttpResponse::builder(StatusCode::NO_CONTENT);
                            builder.header("content-length", "0");
                            // `cors` default methods, not the requested method echoed back.
                            builder.header(
                                "access-control-allow-methods",
                                "GET,HEAD,PUT,PATCH,POST,DELETE",
                            );
                            if let Some(allowed) = allow_origin {
                                builder.header("access-control-allow-origin", allowed);
                                builder.header("vary", "Origin");
                            } else if origin.is_some() {
                                builder.header("vary", "Origin");
                            }
                            if let Some(requested) = requested_headers {
                                builder.header("access-control-allow-headers", requested);
                            }
                            let mut response = req.into_response(builder.body(Vec::new()));
                            finish_response(
                                &mut response,
                                &request_id,
                                &method,
                                &path,
                                &query,
                                started,
                                service,
                            );
                            return Ok(response);
                        }
                    }
                }

                let mut response = next.call(req).await?;
                if let Some(service) = &service {
                    finish_response(
                        &mut response,
                        &request_id,
                        &method,
                        &path,
                        &query,
                        started,
                        service,
                    );
                }
                Ok(response)
            }))
            .configure(configure)
    };
}

/// Serve the edge on plain HTTP (Nginx terminates TLS).
pub async fn run_server(service: Arc<EdgeService>, bind: String) -> std::io::Result<()> {
    let server = ntex::web::HttpServer::new(async move |_| app_for!(service.clone()))
        .graceful_shutdown_timeout(ntex::time::Seconds(10))
        .bind(&bind, ntex::SharedCfg::new("pg-edge-rs"))?;
    tracing::info!("checkout-back listening on {bind}");
    server.run().await
}

fn configure(config: &mut web::ServiceConfig<(), ()>) {
    config.service(web::resource("/{tail}*").to(dispatch));
}

/// The integration-test pipeline (no socket, no TLS server).
pub async fn init_test_pipeline(
    service: Arc<EdgeService>,
) -> ntex::service::Pipeline<
    ntex::http::Request,
    ntex::http::Response,
    ntex::web::WebError<(), ntex::web::DefaultError>,
> {
    ntex::web::test::init_service(app_for!(service)).await
}

fn finish_response(
    response: &mut web::WebResponse,
    request_id: &RequestId,
    method: &Method,
    path: &str,
    query: &str,
    started: Instant,
    service: &Arc<EdgeService>,
) {
    for (name, value) in SECURITY_HEADERS {
        let Ok(name) = HeaderName::from_bytes(name.as_bytes()) else {
            continue;
        };
        if response.headers().contains_key(&name) {
            continue;
        }
        if let Ok(value) = HeaderValue::from_str(value) {
            response.headers_mut().insert(name, value);
        }
    }
    // TS parity: `checkout-back` resolves/forwards `x-request-id` but does not set a response
    // header. Chapter 2 §2 says to echo it; the TS code wins in Track P (see README deviation 17).
    if service.config().cors.is_enabled() {
        let origin = response
            .request()
            .headers()
            .get(ntex::http::header::ORIGIN)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        if let Some(origin) = origin {
            // The cors package always varies by Origin when the option is configured, including
            // for a disallowed origin (which then gets no allow-origin header).
            response.headers_mut().insert(
                HeaderName::from_static("vary"),
                HeaderValue::from_static("Origin"),
            );
            if let Some(allowed) = service.config().cors.allow_origin(Some(origin.as_str())) {
                if let Ok(value) = HeaderValue::from_str(&allowed) {
                    response.headers_mut().insert(
                        HeaderName::from_static("access-control-allow-origin"),
                        value,
                    );
                }
            }
        }
    }
    let status = response.status();
    let logged_query = if query.is_empty() {
        String::new()
    } else {
        redact_url(&format!("?{query}"))
    };
    tracing::info!(
        target: "checkout_edge::request",
        request_id = %request_id,
        method = %method,
        path = %redact_url(path),
        query = %logged_query,
        status = status.as_u16(),
        duration_ms = started.elapsed().as_millis() as u64,
        "request"
    );
}

async fn dispatch(req: HttpRequest, payload: web::types::Payload) -> HttpResponse {
    let Some(service) = req.app_value::<Arc<EdgeService>>().cloned() else {
        return suppress_head(req.method(), EdgeFailure::server_error().to_response());
    };
    let request_id = req
        .extensions()
        .get::<RequestId>()
        .cloned()
        .unwrap_or_else(RequestId::generate);
    let meta = RequestMeta {
        method: req.method().clone(),
        path: req.path().to_owned(),
        query: req.query_string().to_owned(),
        headers: req.headers().clone(),
        peer: req.peer_addr(),
        request_id: request_id.to_string(),
    };
    let method = meta.method.clone();
    let response = match service.classify(&meta) {
        Classification::Health => service.health(),
        Classification::Inbound => service.handle_inbound(meta, payload).await,
        Classification::Api => {
            if let Some(response) = service.check_pay_limiter(&meta) {
                return suppress_head(&method, response);
            }
            let body = match service.read_body(&meta, payload).await {
                Ok(body) => body,
                Err(failure) => return suppress_head(&method, failure.to_response()),
            };
            match match_route(&method, &meta.path) {
                Some(matched) => service.handle_api(meta, matched, body).await,
                None => EdgeFailure::not_found(method.as_str(), &meta.path).to_response(),
            }
        }
    };
    suppress_head(&method, response)
}

/// Express suppresses the body of a HEAD response but keeps `content-length`.
fn suppress_head(method: &Method, response: ntex::http::Response) -> ntex::http::Response {
    if *method != Method::HEAD {
        return response;
    }
    let status = response.status();
    let size = response.body().size();
    let headers: HeaderMap = response.headers().clone();
    let mut builder = HttpResponse::builder(status);
    for (name, value) in &headers {
        builder.header(name.clone(), value.clone());
    }
    if let BodySize::Sized(length) = size {
        builder.header("content-length", length.to_string());
    }
    builder.body(Vec::new())
}

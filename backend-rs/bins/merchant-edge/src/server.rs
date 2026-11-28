//! The ntex HTTP shell of the merchant edge.
//!
//! Port of `merchant-back/index.ts`: security headers, CORS allow-list, request logging (the
//! structured `tracing` line replaces the ANSI request logger), `/health`, the 2 MiB / 24 MiB JSON
//! parsers, the multipart pre-checks (before buffering), the `/api/v1` router and the 404 handler.
//!
//! The TS edge terminates no TLS (nginx does), so the Rust service listens on plain HTTP as well.

#![forbid(unsafe_code)]

use std::sync::Arc;

use ntex::web::{self, App, HttpRequest, HttpResponse, HttpServer};
use ntex::{time::Seconds, SharedCfg};
use pg_edge::MULTIPART_OVERHEAD_BYTES;
use tracing::{info, warn};

use crate::app::{AppState, IncomingRequest};
use crate::config::EdgeConfig;
use crate::error::EdgeApiError;
use crate::http::{resolve_request_id, EdgeResponse, ResponseBody};
use crate::routes::{body_policy, BodyPolicy};

/// Run the edge until SIGTERM/SIGINT.
pub async fn serve(config: EdgeConfig, release: String, commit: String) -> std::io::Result<()> {
    let bind = format!("{}:{}", config.bind_host, config.port);
    let port = config.port;
    let bind_host = config.bind_host.clone();
    let max_streams = config.max_streams_per_ip;
    let state = AppState::production(config, release, commit).map_err(std::io::Error::other)?;
    let app_state = Arc::new(state);
    let workers = std::thread::available_parallelism()
        .map(std::num::NonZeroUsize::get)
        .unwrap_or(1);
    info!(
        bind = %bind,
        max_streams_per_ip = max_streams,
        "merchant-edge listening"
    );
    HttpServer::new(async move |_| {
        let state = Arc::clone(&app_state);
        App::new().service(web::resource("/{tail}*").to(
            async move |req: HttpRequest, payload: web::types::Payload| {
                handle(Arc::clone(&state), req, payload).await
            },
        ))
    })
    .workers(workers)
    .graceful_shutdown_timeout(Seconds(10))
    .bind(bind, SharedCfg::new("merchant-edge"))?
    .run()
    .await
    .map_err(|error| std::io::Error::other(format!("{bind_host}:{port}: {error}")))
}

/// The body policy of the matched route, before reading a single byte.
fn request_body_policy(state: &AppState, request: &IncomingRequest) -> Option<BodyPolicy> {
    let (route, _) = crate::routes::match_route(&request.method, &request.path)?;
    Some(body_policy(route, &request.path, &state.config))
}

fn policy_cap(state: &AppState, policy: BodyPolicy) -> u64 {
    match policy {
        BodyPolicy::None => 0,
        BodyPolicy::Json(limit) => limit,
        BodyPolicy::Multipart => state
            .config
            .max_upload_bytes
            .saturating_add(MULTIPART_OVERHEAD_BYTES),
    }
}

pub async fn handle(
    state: Arc<AppState>,
    req: HttpRequest,
    payload: web::types::Payload,
) -> HttpResponse {
    let started = std::time::Instant::now();
    let method = req.method().as_str().to_owned();
    let path = req.path().to_owned();
    let query = req.query_string().to_owned();
    let headers = convert_headers(req.headers());
    let peer = req
        .peer_addr()
        .map(|address| address.ip())
        .unwrap_or_else(|| std::net::IpAddr::from([0, 0, 0, 0]));
    let request_id = resolve_request_id(&headers);
    let content_length = headers
        .get("content-length")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok());

    // CORS preflight (`cors` middleware) before any route work.
    if method == "OPTIONS" && state.config.cors.is_enabled() {
        let origin = headers.get("origin").and_then(|value| value.to_str().ok());
        let requested_method = headers
            .get("access-control-request-method")
            .and_then(|value| value.to_str().ok());
        let requested_headers = headers
            .get("access-control-request-headers")
            .and_then(|value| value.to_str().ok());
        let preflight = state
            .config
            .cors
            .preflight(origin, requested_method, requested_headers);
        if !preflight.is_empty() {
            let mut response = EdgeResponse::empty(204);
            for (name, value) in preflight {
                response.set_header(&name, &value);
            }
            response.finalize(&state.config.cors, origin);
            return response.into_http();
        }
    }

    let mut request = IncomingRequest {
        method,
        path,
        query,
        headers,
        peer,
        body: Vec::new(),
        content_length,
        upload_admitted: false,
    };

    // Multipart: refuse an invalid credential / oversized declared body before buffering a file.
    let policy = request_body_policy(&state, &request);
    if matches!(policy, Some(BodyPolicy::Multipart)) {
        let client_ip = crate::http::resolve_client(
            &request.headers,
            request.peer,
            &state.config.trusted_proxies,
        );
        if let Err(mut refusal) = state.preflight_upload(
            &request.headers,
            &client_ip,
            request.content_length,
            &request.method,
            &request.path,
        ) {
            refusal.finalize(&state.config.cors, None);
            return refusal.into_http();
        }
        request.upload_admitted = true;
    }

    if let Some(policy) = policy.filter(|policy| *policy != BodyPolicy::None) {
        let cap = policy_cap(&state, policy);
        if content_length.is_some_and(|declared| declared > cap) {
            let mut refusal = EdgeResponse::from_error(&too_large(&request, policy));
            refusal.finalize(&state.config.cors, None);
            return refusal.into_http();
        }
        match read_body(payload, cap).await {
            Ok(body) => request.body = body,
            Err(ReadError::TooLarge) => {
                let mut refusal = EdgeResponse::from_error(&too_large(&request, policy));
                refusal.finalize(&state.config.cors, None);
                return refusal.into_http();
            }
            Err(ReadError::Payload(error)) => {
                warn!(error = %error, "request body read failed");
                let mut refusal = EdgeResponse::from_error(&EdgeApiError::bad_request_body());
                refusal.finalize(&state.config.cors, None);
                return refusal.into_http();
            }
        }
    }

    let head = request.method == "HEAD";
    let mut response = crate::app::serve(&state, request).await;
    if head {
        // Express sends the GET headers without a body for HEAD.
        response.body = ResponseBody::Bytes(Vec::new());
    }
    let status = response.status;
    let duration_ms = started.elapsed().as_millis();
    if status >= 500 {
        warn!(request_id = %request_id, method = %req.method(), path = %req.path(), status, duration_ms, "request failed");
    } else {
        info!(request_id = %request_id, method = %req.method(), path = %req.path(), status, duration_ms, "request");
    }
    response.into_http()
}

fn too_large(request: &IncomingRequest, policy: BodyPolicy) -> EdgeApiError {
    if matches!(policy, BodyPolicy::Multipart) || request.upload_admitted {
        EdgeApiError::from_edge(pg_edge::EdgeError::UploadTooLarge(
            pg_edge::UploadKind::Document,
        ))
    } else {
        EdgeApiError::payload_too_large()
    }
}

enum ReadError {
    TooLarge,
    Payload(String),
}

async fn read_body(mut payload: web::types::Payload, cap: u64) -> Result<Vec<u8>, ReadError> {
    use futures_util::StreamExt as _;
    let mut output = Vec::new();
    while let Some(chunk) = payload.next().await {
        let chunk = chunk.map_err(|error| ReadError::Payload(error.to_string()))?;
        if output.len() as u64 + chunk.len() as u64 > cap {
            return Err(ReadError::TooLarge);
        }
        output.extend_from_slice(&chunk);
    }
    Ok(output)
}

fn convert_headers(headers: &ntex::http::HeaderMap) -> http::HeaderMap {
    let mut map = http::HeaderMap::new();
    for (name, value) in headers {
        let Ok(name) = http::header::HeaderName::from_bytes(name.as_str().as_bytes()) else {
            continue;
        };
        if let Ok(value) = http::header::HeaderValue::from_bytes(value.as_bytes()) {
            map.append(name, value);
        }
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_conversion_preserves_repeated_cookie_headers() {
        let mut source = ntex::http::HeaderMap::new();
        let name = ntex::http::header::HeaderName::from_static("cookie");
        source.append(name.clone(), "a=1".parse().expect("value"));
        source.append(name, "b=2".parse().expect("value"));
        let converted = convert_headers(&source);
        assert_eq!(converted.get_all("cookie").iter().count(), 2);
    }
}

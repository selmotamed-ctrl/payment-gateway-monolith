//! Health route handlers.
//!
//! `GET /health` always answers 200 with the payload of chapter 2 §20 (degraded included), the
//! same way the TS handler does; the deploy verifier reads `status`.

#![forbid(unsafe_code)]

use ntex::web::HttpRequest;
use ntex::web::HttpResponse;
use pg_http::Channel;

use crate::http::error_response;
use crate::routes;
use crate::state::AppState;

/// `GET /health`.
pub async fn root(state: &AppState, request: &HttpRequest) -> HttpResponse {
    let payload = state.health(chrono::Utc::now()).await;
    match serde_json::to_string(&payload) {
        Ok(body) => HttpResponse::Ok()
            .content_type("application/json; charset=utf-8")
            .body(body),
        Err(error) => {
            tracing::error!(error = %error, "health payload could not be serialised");
            error_response(request, pg_http::ApiError::server_error())
        }
    }
}

/// `GET /internal/{admin,merchant,checkout}/health`.
pub fn channel(state: &AppState, channel: Channel, request: &HttpRequest) -> HttpResponse {
    let body = crate::health::channel_payload(&state.config, routes::channel_name(channel));
    let _ = request;
    HttpResponse::Ok()
        .content_type("application/json; charset=utf-8")
        .body(body.to_string())
}

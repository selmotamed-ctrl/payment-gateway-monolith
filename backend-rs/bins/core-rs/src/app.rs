//! The request dispatcher: pipeline order, mTLS channel guard, policy authorisation and handlers.
//!
//! This is `createApp` (`core-back/index.ts:76-191`) for the P3 shell. Express composes middleware
//! and routers; the Rust shell composes the same steps explicitly in [`dispatch`], which is also
//! what the tests drive:
//!
//! 1. request id (validated header or UUIDv4) attached to the request and echoed on the response;
//! 2. the body-parser limit for the path is enforced before routing (Express parses before the
//!    router);
//! 3. the mounted route is looked up in [`crate::routes::mounted_routes`] — unregistered core
//!    routes answer `501 NOT_IMPLEMENTED_ROUTE` so the parity harness can classify them, unknown
//!    paths answer Express's 404 page;
//! 4. the mTLS channel guard (CN table) runs for every `/internal/*` route; `/health` has no CN
//!    check;
//! 5. the policy is authorised (authentication, principal guard, authorities);
//! 6. the handler runs; any `ApiError` becomes the JSON envelope with the request id as
//!    `reference`;
//! 7. the request line is logged and the access-log row is queued.

#![forbid(unsafe_code)]

use std::sync::Arc;

use ntex::web::types::Payload;
use ntex::web::HttpRequest;
use ntex::web::HttpResponse;

use pg_http::{ApiError, RequestId};

use crate::auth;
use crate::http;
use crate::logging::{self, Started};
use crate::routes::{self, Handler};
use crate::state::AppState;

/// Handle one request.
pub async fn dispatch(
    state: Arc<AppState>,
    request: HttpRequest,
    payload: Payload,
) -> HttpResponse {
    let request_id = RequestId::from_incoming(http::incoming_request_id(&request).as_deref());
    http::attach_request_id(&request, &request_id);
    let mut meta = http::RequestMeta::new(
        request_id,
        Started::now(),
        request.method().as_str(),
        logging::logged_path(request.path()),
    );
    meta.peer = http::peer_ip(&request);

    let response = if let Some(error) = http::declared_body_error(&request) {
        http::error_response(&request, error)
    } else {
        route(state.as_ref(), &request, payload).await
    };

    http::finish(&meta, state.log_sink.as_deref(), response)
}

async fn route(state: &AppState, request: &HttpRequest, payload: Payload) -> HttpResponse {
    let method = request.method().as_str();
    // Express serves HEAD from a GET handler.
    let lookup_method = if method == "HEAD" { "GET" } else { method };
    let Some(route) = routes::find(lookup_method, request.path()) else {
        if request.path().starts_with("/internal/") || request.path().starts_with("/api/") {
            return http::not_implemented_response(request.path());
        }
        return http::not_found_response(method, request.path());
    };

    // The CN table applies to `/internal/*`; `/health` accepts any valid certificate.
    if pg_mtls::allowed_channel_cns(request.path()).is_some() {
        if let Err(error) = auth::require_channel_identity(request, state.config.mtls_required) {
            return http::error_response(request, error);
        }
    }

    let principal = match routes::authorize(state, &route, request).await {
        Ok(principal) => principal,
        Err(error) => return http::error_response(request, error),
    };

    match route.handler {
        Handler::Health => routes::health::root(state, request).await,
        Handler::ChannelHealth => routes::health::channel(state, route.policy.channel, request),
        Handler::AuthMe => {
            let Some(principal) = principal.as_ref() else {
                return http::error_response(
                    request,
                    ApiError::new(
                        401,
                        "AUTH_REQUIRED",
                        "A bearer token is required for this endpoint",
                    ),
                );
            };
            routes::auth::me(state, principal)
        }
        Handler::Custom(handler) => handler(state, request, principal.as_ref(), payload).await,
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn unported_prefixes_are_distinguished_from_unknown_paths() {
        // The classification the dispatcher uses for the two fallbacks.
        assert!("/internal/admin/merchants".starts_with("/internal/"));
        assert!("/api/public/links".starts_with("/api/"));
        assert!(!"/favicon.ico".starts_with("/internal/"));
    }
}

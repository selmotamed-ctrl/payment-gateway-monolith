//! ntex responder for [`ApiError`].
//!
//! Keeps the TS envelope, attaches the request id as `reference` when the error has none, and
//! never leaks a Rust backtrace or internal path.

#![forbid(unsafe_code)]

use ntex::http::{Response, StatusCode};
use ntex::web::{HttpRequest, Responder, State};

use crate::error::ApiError;
use crate::request_id::REQUEST_ID_HEADER;

impl<St: State> Responder<St> for ApiError {
    async fn respond_to(self, _st: &St, req: &HttpRequest) -> Response {
        let reference = self.reference.clone().or_else(|| {
            req.headers()
                .get(REQUEST_ID_HEADER)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned)
        });
        let mut error = self;
        if error.reference.is_none() {
            error.reference = reference;
        }
        let status =
            StatusCode::from_u16(error.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        Response::builder(status)
            .content_type("application/json; charset=utf-8")
            .body(error.to_json())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_is_the_ts_envelope() {
        let error = ApiError::new(400, "INVALID_BODY", "Bad").with_details(serde_json::json!([]));
        assert!(error.to_json().contains("\"code\":\"INVALID_BODY\""));
        assert_eq!(
            StatusCode::from_u16(error.status).unwrap_or(StatusCode::OK),
            StatusCode::BAD_REQUEST
        );
    }
}

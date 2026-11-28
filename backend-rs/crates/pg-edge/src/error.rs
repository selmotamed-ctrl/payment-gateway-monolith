//! Edge error envelope and the upload/body-limit codes.
//!
//! Port of `{admin,merchant,checkout}-back/lib/error/index.ts` (the `ApiError` shape), the
//! body-parser branch (`PAYLOAD_TOO_LARGE` / `BAD_REQUEST`) and `{admin,merchant}-back/api/upload.ts`
//! (`UPLOAD_TOO_LARGE`, `UPLOAD_UNEXPECTED_FIELD`, `UPLOAD_INVALID`, `UPLOAD_REQUIRED`).
//!
//! The edge envelope is `{"code": string, "message": string}`; status codes follow the TypeScript
//! `ApiError(status, code, message)` calls exactly.

#![forbid(unsafe_code)]

use std::fmt;

use serde::Serialize;

/// Which noun an upload endpoint uses in its messages.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UploadKind {
    /// Reconciliation statement (admin edge).
    Statement,
    /// Merchant document upload (KYB, disputes, evidence).
    Document,
}

impl UploadKind {
    #[must_use]
    pub fn too_large_message(self) -> &'static str {
        match self {
            Self::Statement => "The uploaded file exceeds the size limit",
            Self::Document => "The uploaded document exceeds the size limit",
        }
    }

    #[must_use]
    pub fn required_message(self, field: &str) -> String {
        match self {
            Self::Statement => {
                format!("A statement file is required in the {field} field")
            }
            Self::Document => {
                format!("A document file is required in the {field} field")
            }
        }
    }
}

/// A request-scoped edge failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EdgeError {
    /// Cookie mode with no `x-pg-csrf: 1` on an unsafe method.
    CsrfHeaderRequired,
    /// Malformed, expired, or non-session credential (also the upload session-shape refusal).
    AuthInvalid,
    /// A JWT issued for another channel.
    AuthAudienceInvalid,
    /// A forwarded header is not printable ASCII (pg-upstream contract, shared helper here).
    CoreHeaderInvalid,
    /// The body exceeded `MAX_JSON_BODY_BYTES` (Express body-parser 413).
    PayloadTooLarge,
    /// The multipart file exceeded the configured upload limit.
    UploadTooLarge(UploadKind),
    /// A file arrived in an unexpected multipart field.
    UploadUnexpectedField,
    /// The multipart payload could not be parsed.
    UploadInvalid,
    /// No file was present in the expected field.
    UploadRequired { kind: UploadKind, field: String },
}

impl EdgeError {
    #[must_use]
    pub fn status(&self) -> u16 {
        match self {
            Self::CsrfHeaderRequired => 403,
            Self::AuthInvalid | Self::AuthAudienceInvalid => 401,
            Self::CoreHeaderInvalid | Self::UploadUnexpectedField | Self::UploadInvalid => 400,
            Self::UploadRequired { .. } => 400,
            Self::PayloadTooLarge | Self::UploadTooLarge(_) => 413,
        }
    }

    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::CsrfHeaderRequired => "CSRF_HEADER_REQUIRED",
            Self::AuthInvalid => "AUTH_INVALID",
            Self::AuthAudienceInvalid => "AUTH_AUDIENCE_INVALID",
            Self::CoreHeaderInvalid => "CORE_HEADER_INVALID",
            Self::PayloadTooLarge => "PAYLOAD_TOO_LARGE",
            Self::UploadTooLarge(_) => "UPLOAD_TOO_LARGE",
            Self::UploadUnexpectedField => "UPLOAD_UNEXPECTED_FIELD",
            Self::UploadInvalid => "UPLOAD_INVALID",
            Self::UploadRequired { .. } => "UPLOAD_REQUIRED",
        }
    }

    #[must_use]
    pub fn message(&self) -> String {
        match self {
            Self::CsrfHeaderRequired => {
                "Cookie-authenticated writes must send the x-pg-csrf header".to_owned()
            }
            Self::AuthInvalid => "The session is invalid or expired".to_owned(),
            Self::AuthAudienceInvalid => {
                "The session token was not issued for the merchant channel".to_owned()
            }
            Self::CoreHeaderInvalid => "A forwarded header contains invalid characters".to_owned(),
            Self::PayloadTooLarge => "The request body exceeds the size limit".to_owned(),
            Self::UploadTooLarge(kind) => kind.too_large_message().to_owned(),
            Self::UploadUnexpectedField => {
                "Unexpected file field in the multipart payload".to_owned()
            }
            Self::UploadInvalid => "The multipart payload could not be parsed".to_owned(),
            Self::UploadRequired { kind, field } => kind.required_message(field),
        }
    }

    #[must_use]
    pub fn body(&self) -> EdgeErrorBody {
        EdgeErrorBody {
            code: self.code(),
            message: self.message(),
        }
    }

    #[must_use]
    pub fn to_json(&self) -> String {
        serde_json::to_string(&self.body()).unwrap_or_else(|_| {
            r#"{"code":"SERVER_ERROR","message":"Unexpected server error"}"#.to_owned()
        })
    }
}

impl fmt::Display for EdgeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message())
    }
}

impl std::error::Error for EdgeError {}

/// The exact JSON body of an edge error response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EdgeErrorBody {
    pub code: &'static str,
    pub message: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csrf_refusal_matches_the_typescript_message() {
        let error = EdgeError::CsrfHeaderRequired;
        assert_eq!(error.status(), 403);
        assert_eq!(error.code(), "CSRF_HEADER_REQUIRED");
        assert_eq!(
            error.message(),
            "Cookie-authenticated writes must send the x-pg-csrf header"
        );
    }

    #[test]
    fn auth_codes_and_statuses() {
        assert_eq!(EdgeError::AuthInvalid.status(), 401);
        assert_eq!(EdgeError::AuthInvalid.code(), "AUTH_INVALID");
        assert_eq!(EdgeError::AuthAudienceInvalid.status(), 401);
        assert_eq!(
            EdgeError::AuthAudienceInvalid.code(),
            "AUTH_AUDIENCE_INVALID"
        );
    }

    #[test]
    fn body_limit_maps_to_the_express_parser_branch() {
        let error = EdgeError::PayloadTooLarge;
        assert_eq!(error.status(), 413);
        assert_eq!(error.code(), "PAYLOAD_TOO_LARGE");
        assert_eq!(error.message(), "The request body exceeds the size limit");
        assert_eq!(
            error.to_json(),
            r#"{"code":"PAYLOAD_TOO_LARGE","message":"The request body exceeds the size limit"}"#
        );
    }

    #[test]
    fn upload_messages_use_the_edge_noun() {
        let statement = EdgeError::UploadTooLarge(UploadKind::Statement);
        assert_eq!(statement.code(), "UPLOAD_TOO_LARGE");
        assert_eq!(
            statement.message(),
            "The uploaded file exceeds the size limit"
        );
        let document = EdgeError::UploadTooLarge(UploadKind::Document);
        assert_eq!(
            document.message(),
            "The uploaded document exceeds the size limit"
        );

        let required = EdgeError::UploadRequired {
            kind: UploadKind::Document,
            field: "file".to_owned(),
        };
        assert_eq!(required.status(), 400);
        assert_eq!(
            required.message(),
            "A document file is required in the file field"
        );
    }

    #[test]
    fn envelope_is_code_and_message_only() {
        let body = EdgeError::CoreHeaderInvalid.body();
        assert_eq!(body.code, "CORE_HEADER_INVALID");
        assert_eq!(
            serde_json::to_value(&body).expect("serialises"),
            serde_json::json!({
                "code": "CORE_HEADER_INVALID",
                "message": "A forwarded header contains invalid characters",
            })
        );
    }
}

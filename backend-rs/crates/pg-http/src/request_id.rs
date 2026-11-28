//! Request id contract.
//!
//! `x-request-id` is accepted when it matches `^[A-Za-z0-9._:-]{1,128}$`; otherwise a UUIDv4 is
//! generated. The same value is echoed on the response and used as the error `reference`.

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const REQUEST_ID_HEADER: &str = "x-request-id";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RequestId(pub String);

impl RequestId {
    #[must_use]
    pub fn generate() -> Self {
        Self(Uuid::new_v4().to_string())
    }

    #[must_use]
    pub fn from_incoming(raw: Option<&str>) -> Self {
        raw.filter(|value| valid_request_id(value))
            .map_or_else(Self::generate, |value| Self(value.to_owned()))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for RequestId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Accept only the documented alphabet and length.
#[must_use]
pub fn valid_request_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

/// Extract and validate from a header value.
#[must_use]
pub fn request_id_from_header(value: Option<&str>) -> RequestId {
    RequestId::from_incoming(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_valid_ids() {
        assert_eq!(
            request_id_from_header(Some("abc-123_x.y:z")).as_str(),
            "abc-123_x.y:z"
        );
    }

    #[test]
    fn replaces_invalid_ids() {
        let id = request_id_from_header(Some("with space"));
        assert_ne!(id.as_str(), "with space");
        assert_eq!(id.as_str().len(), 36);
    }

    #[test]
    fn rejects_overlong() {
        assert!(!valid_request_id(&"a".repeat(129)));
    }
}

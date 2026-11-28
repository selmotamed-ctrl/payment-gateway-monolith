//! Opaque cursor codec for `listQuery` parity.
//!
//! The TS `listQuery` helper encodes the last row's sort values as base64url JSON. The Rust port
//! stores the same shape so a cursor minted by either implementation is accepted by the other
//! while both run side by side.

#![forbid(unsafe_code)]

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CursorError {
    #[error("cursor is not valid base64url")]
    Encoding,
    #[error("cursor payload is not valid JSON")]
    Json,
    #[error("cursor payload has an unsupported shape")]
    Shape,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CursorCodec {
    /// Sort key/value pairs of the last row, in the list's sort order.
    pub values: Vec<Value>,
}

impl CursorCodec {
    #[must_use]
    pub fn new(values: Vec<Value>) -> Self {
        Self { values }
    }

    pub fn encode(&self) -> Result<String, CursorError> {
        let json = serde_json::to_vec(self).map_err(|_| CursorError::Shape)?;
        Ok(URL_SAFE_NO_PAD.encode(json))
    }

    pub fn decode(raw: &str) -> Result<Self, CursorError> {
        let bytes = URL_SAFE_NO_PAD
            .decode(raw)
            .map_err(|_| CursorError::Encoding)?;
        serde_json::from_slice(&bytes).map_err(|_| CursorError::Json)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn round_trips() {
        let codec = CursorCodec::new(vec![json!("2026-11-28T10:00:00.000Z"), json!("id")]);
        let encoded = codec.encode().expect("encode");
        assert_eq!(CursorCodec::decode(&encoded).expect("decode"), codec);
    }

    #[test]
    fn rejects_garbage() {
        assert!(matches!(
            CursorCodec::decode("!!!"),
            Err(CursorError::Encoding)
        ));
    }
}

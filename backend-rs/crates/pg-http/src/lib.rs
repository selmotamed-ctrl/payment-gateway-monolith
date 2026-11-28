//! HTTP boundary shared by every Rust service.
//!
//! Ports: `core-back/lib/error/index.ts`, `core-back/lib/requestLogger/index.ts`,
//! the edge security-header middleware, the route policy registry (chapter 3 §6) and the
//! fixed-window keepers of chapter 2 §9.

#![forbid(unsafe_code)]

pub mod error;
pub mod health;
pub mod limits;
pub mod policy;
pub mod rate_limit;
pub mod rate_policy;
pub mod request_id;
pub mod responder;
pub mod security;
pub mod validation;

pub use error::{ApiError, ErrorEnvelope};
pub use health::{CoreHealth, EdgeHealth, WorkerHealth};
pub use limits::{json_limit_for, raw_body_limit_for, MAX_JSON_BODY_BYTES_DEFAULT};
pub use policy::{
    AuditRule, Authn, BodyRule, Channel, MfaRule, Policy, RateClass, RouteRegistry, ScopeRule,
};
pub use rate_limit::{FixedWindowLimiter, RateDecision};
pub use rate_policy::{RateKey, RatePolicy};
pub use request_id::{request_id_from_header, valid_request_id, RequestId};
pub use security::{apply_security_headers, security_headers, SecurityHeaders};
pub use validation::{Issue, ValidationError};

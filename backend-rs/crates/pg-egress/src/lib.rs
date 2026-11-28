//! Outbound egress rules: API consumer, SSRF guard, token cache and merchant webhooks.
//!
//! Port of `core-back/engine/apiConsumer/ApiConsumer.ts`,
//! `core-back/engine/apiConsumer/compileUrl.ts` and `core-back/lib/webhooks/egress.ts`
//! (chapter 2 §28 of the Rust port plan).
//!
//! The crate is pure modulo [`executor`]: [`validate_target`] resolves a host through an injected
//! [`Resolver`], so tests pin or deny addresses without a network. The caller receives a
//! [`ResolvedTarget`] with **one** pinned address and the executor connects to that address; a
//! second DNS answer between the check and the connect can therefore never redirect the request.

#![forbid(unsafe_code)]

pub mod auth;
pub mod body;
pub mod credentials;
pub mod error;
pub mod executor;
pub mod ip_rules;
pub mod target;
pub mod token_cache;
pub mod webhook;

pub use auth::{
    sign_payload, sign_request, ApiConsumerAuth, AuthPlacement, SignatureAlgorithm,
    DEFAULT_API_KEY_HEADER, DEFAULT_BODY_NAME, DEFAULT_QUERY_NAME, DEFAULT_SIGNATURE_HEADER,
    DEFAULT_TIMESTAMP_HEADER,
};
pub use body::{BodyError, BodyKind, MultipartBody, MultipartFile, PreparedBody, RequestBody};
pub use credentials::{
    apply_auth, assert_no_control_characters, place_body_api_key, AuthError, GatewayAuthConfig,
    GatewayCredentials, API_KEY_NAMES, TLS_CA_NAMES, TLS_CERTIFICATE_NAMES, TLS_PRIVATE_KEY_NAMES,
};
pub use error::{EgressError, GatewayError};
pub use executor::{
    encode_uri_component, CallContext, Clock, EgressClient, EgressConfig, EgressRequest,
    EgressResponse, RefreshTokenSink, RetryPolicy, RotatedRefreshToken, SideEffect, SystemClock,
    DEFAULT_CLIENT_CACHE_CAPACITY, DEFAULT_CONNECT_TIMEOUT_MS, DEFAULT_MAX_JSON_DEPTH,
    DEFAULT_MAX_RETRIES, DEFAULT_RETRY_DELAY_MS, DEFAULT_TIMEOUT_MS, MAX_RESPONSE_BYTES,
    TOKEN_REQUEST_TIMEOUT_MS,
};
pub use ip_rules::{is_local_host_name, is_public_ip, normalize_host};
pub use target::{
    ensure_not_redirect, validate_target, validate_target_with, EgressPolicy, HostAllowlist,
    ResolvedTarget, Resolver, StaticResolver, SystemResolver,
};
pub use token_cache::{TokenCache, TokenKey, TokenValue};
pub use webhook::{
    endpoint_accepts_event, ensure_endpoint_capacity, parse_event_filter, WebhookConfigError,
    WebhookEventType, WebhookLimitError, WebhookRetryPolicy, WEBHOOK_DISABLE_AFTER_DAYS,
    WEBHOOK_DISABLE_AFTER_MS, WEBHOOK_ENDPOINTS_PER_APPLICATION, WEBHOOK_JITTER_PERCENT,
    WEBHOOK_MAX_ATTEMPTS, WEBHOOK_RETRY_DELAYS_MS, WEBHOOK_TEST_EVENT,
};

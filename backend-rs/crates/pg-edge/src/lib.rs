//! Edge-shared helpers: client IP, session cookies, header safety, body limits, multipart
//! metadata, SSE, upload guards and relay/CORS helpers.
//!
//! Port of the shared code of `admin-back`, `merchant-back` and `checkout-back`:
//! - `lib/net/index.ts`, `lib/clientIp/index.ts` → [`client_ip`]
//! - `lib/security/sessionCookie.ts` (admin + merchant) → [`session_cookie`]
//! - `lib/coreInternalClient.ts` header rules → [`headers`]
//! - `lib/env/index.ts` limits and `api/upload.ts` guards → [`limits`], [`upload`], [`multipart`]
//! - `lib/coreInternalClient.ts` SSE relay → [`sse`]
//! - `api/forward.ts` and `lib/security/index.ts` CORS → [`relay`]
//!
//! The crate is deliberately I/O-free: ntex glue and the actual core client belong to `bins/*-edge`
//! and `pg-upstream`. These are the values the three edge copies must agree on.

#![forbid(unsafe_code)]

pub mod client_ip;
pub mod error;
pub mod headers;
pub mod limits;
pub mod multipart;
pub mod relay;
pub mod session_cookie;
pub mod sse;
pub mod upload;

pub use client_ip::{
    digest_key_part, is_trusted_proxy, normalize_ip_string, parse_cidr, parse_cidr_list, parse_ip,
    resolve_client_ip, resolve_client_ip_from_headers, TRUSTED_PROXY_DEFAULT, X_REAL_CLIENT_IP,
    X_REAL_IP,
};
pub use error::{EdgeError, EdgeErrorBody, UploadKind};
pub use headers::{
    assert_header_map_safe, is_hop_by_hop, is_valid_header_name, is_valid_header_value,
    sanitize_user_agent, set_content_length, strip_forward_headers, validate_header_pair,
    HOP_BY_HOP_HEADERS, STRIPPED_FORWARD_HEADERS, USER_AGENT_MAX_CHARS, X_CLIENT_USER_AGENT,
};
pub use limits::{
    check_declared_length, check_upload_length, EdgeKind, ADMIN_JSON_LIMIT, ADMIN_MAX_UPLOAD_BYTES,
    ADMIN_UPLOAD_RATE_LIMIT_PER_MINUTE, CHECKOUT_JSON_LIMIT, MERCHANT_JSON_LIMIT,
    MERCHANT_MAX_UPLOAD_BYTES, MERCHANT_UPLOAD_RATE_LIMIT_PER_MINUTE, MIB,
    MULTIPART_OVERHEAD_BYTES, UPLOAD_RATE_LIMIT_WINDOW_MS,
};
pub use multipart::{
    extract_boundary, scan_multipart, MultipartError, MultipartLimits, MultipartMetadata,
    MultipartScanner, PartMetadata, DEFAULT_MAX_HEADER_BYTES, DEFAULT_MAX_PARTS,
};
pub use relay::{relay_status, CorsAllowList, RELAY_RESPONSE_HEADERS};
pub use session_cookie::{
    assert_session_shape, capture_session_token, cookie_session_decision, is_auth_exempt_path,
    read_session_cookie, require_audience, session_cookie_value_valid, CookieDecision,
    SessionChannel, SessionCookieConfig, ADMIN_SESSION_AUDIENCE, ADMIN_SESSION_COOKIE_NAME,
    ADMIN_SESSION_COOKIE_PATH, CSRF_HEADER, CSRF_REQUIRED_VALUE, MERCHANT_SESSION_AUDIENCE,
    MERCHANT_SESSION_COOKIE_NAME, MERCHANT_SESSION_COOKIE_PATH, SESSION_COOKIE_MAX_AGE_SECONDS,
};
pub use sse::{
    apply_sse_headers, event_frame, sse_headers, status_event_frame,
    CHECKOUT_STATUS_STREAM_TIMEOUT_MS, POS_STREAM_TIMEOUT_MS, SSE_BUFFERING, SSE_CACHE_CONTROL,
    SSE_CONNECTION, SSE_CONTENT_TYPE, SSE_HEADERS,
};
pub use upload::{upload_error, upload_rate_key, UploadGuard};

//! The checkout route table.
//!
//! Every route registered by `checkout-back/index.ts` and `checkout-back/api/index.ts` is listed
//! here. There are no unported checkout routes: an unknown method/path pair is the TS
//! `notFoundHandler` (`404 NOT_FOUND`), never a 501.
//!
//! Matching mimics Express defaults: case-insensitive static segments, one optional trailing
//! slash, and `HEAD` handled by the `GET` route.

#![forbid(unsafe_code)]

use ntex::http::{Method, StatusCode};

/// The checkout route after matching.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    Health,
    Inbound,
    PayLink,
    Initiate,
    AttemptLogs,
    AttemptStatus,
    Confirm,
    Resend,
    Cancel,
    ClientEvent,
    SandboxAccountsList,
    SandboxAccountsCreate,
    SandboxAccountMovements,
    SandboxAccountPatch,
    SandboxInspector,
    SandboxSimulate,
    Return,
    Certificate,
}

impl Route {
    /// The TS method and file that registers this route, used by tests and the README.
    #[must_use]
    pub const fn ts_origin(self) -> (&'static str, &'static str) {
        match self {
            Self::Health => ("GET", "checkout-back/index.ts"),
            Self::Inbound => ("ALL", "checkout-back/api/public/inbound.ts"),
            Self::PayLink => ("GET", "checkout-back/api/public/pay.ts"),
            Self::Initiate => ("POST", "checkout-back/api/public/pay.ts"),
            Self::AttemptLogs => ("GET", "checkout-back/api/public/pay.ts"),
            Self::AttemptStatus => ("GET", "checkout-back/api/public/pay.ts"),
            Self::Confirm => ("POST", "checkout-back/api/public/pay.ts"),
            Self::Resend => ("POST", "checkout-back/api/public/pay.ts"),
            Self::Cancel => ("POST", "checkout-back/api/public/pay.ts"),
            Self::ClientEvent => ("POST", "checkout-back/api/public/pay.ts"),
            Self::SandboxAccountsList => ("GET", "checkout-back/api/public/pay.ts"),
            Self::SandboxAccountsCreate => ("POST", "checkout-back/api/public/pay.ts"),
            Self::SandboxAccountMovements => ("GET", "checkout-back/api/public/pay.ts"),
            Self::SandboxAccountPatch => ("PATCH", "checkout-back/api/public/pay.ts"),
            Self::SandboxInspector => ("GET", "checkout-back/api/public/pay.ts"),
            Self::SandboxSimulate => ("POST", "checkout-back/api/public/pay.ts"),
            Self::Return => ("GET|POST", "checkout-back/api/public/return.ts"),
            Self::Certificate => ("GET", "checkout-back/api/public/certificate.ts"),
        }
    }

    /// The route path as registered in the TypeScript router.
    #[must_use]
    pub const fn ts_path(self) -> &'static str {
        match self {
            Self::Health => "/health",
            Self::Inbound => "/api/v1/inbound/:gateway/:env/:pathToken",
            Self::PayLink => "/api/v1/pay/:linkKey",
            Self::Initiate => "/api/v1/pay/:linkKey/initiate",
            Self::AttemptLogs => "/api/v1/pay/:linkKey/logs/:attemptId",
            Self::AttemptStatus => "/api/v1/pay/:linkKey/logs/:attemptId/status",
            Self::Confirm => "/api/v1/pay/:linkKey/logs/:attemptId/confirm",
            Self::Resend => "/api/v1/pay/:linkKey/logs/:attemptId/resend",
            Self::Cancel => "/api/v1/pay/:linkKey/logs/:attemptId/cancel",
            Self::ClientEvent => "/api/v1/pay/:linkKey/logs/:attemptId/client-event",
            Self::SandboxAccountsList => "/api/v1/pay/:linkKey/sandbox-accounts",
            Self::SandboxAccountsCreate => "/api/v1/pay/:linkKey/sandbox-accounts",
            Self::SandboxAccountMovements => {
                "/api/v1/pay/:linkKey/sandbox-accounts/:accountId/movements"
            }
            Self::SandboxAccountPatch => "/api/v1/pay/:linkKey/sandbox-accounts/:accountId",
            Self::SandboxInspector => "/api/v1/pay/:linkKey/logs/:attemptId/sandbox-inspector",
            Self::SandboxSimulate => "/api/v1/pay/:linkKey/logs/:attemptId/sandbox-simulate",
            Self::Return => "/api/v1/return/:attemptToken",
            Self::Certificate => "/api/v1/verify/certificate/:publicId",
        }
    }

    /// The core path prefix this route forwards to.
    #[must_use]
    pub const fn core_prefix(self) -> &'static str {
        match self {
            Self::Health => "",
            Self::Inbound => "/internal/checkout/inbound",
            Self::Return => "/internal/checkout/return",
            Self::Certificate => "/internal/checkout/academy/certificates",
            _ => "/internal/checkout/pay",
        }
    }
}

/// One matched route and its raw (already percent-decoded) parameters.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteMatch {
    pub route: Route,
    pub link_key: Option<String>,
    pub attempt_id: Option<String>,
    pub account_id: Option<String>,
    pub attempt_token: Option<String>,
    pub public_id: Option<String>,
    /// Segments below `/api/v1/inbound` in wire order.
    pub inbound_segments: Vec<String>,
    /// A dynamic segment contained a malformed percent escape.
    pub malformed_path: bool,
}

impl RouteMatch {
    fn new(route: Route) -> Self {
        Self {
            route,
            link_key: None,
            attempt_id: None,
            account_id: None,
            attempt_token: None,
            public_id: None,
            inbound_segments: Vec::new(),
            malformed_path: false,
        }
    }
}

/// The mount point of the inbound router in the TS app.
pub const INBOUND_PREFIX: [&str; 3] = ["api", "v1", "inbound"];
/// The mount point of the pay limiter and pay router.
pub const PAY_PREFIX: [&str; 3] = ["api", "v1", "pay"];

/// Split a raw request path into segments, dropping one trailing slash.
#[must_use]
pub fn path_segments(raw_path: &str) -> Vec<String> {
    let path = raw_path.split('?').next().unwrap_or(raw_path);
    let mut segments: Vec<String> = path.split('/').skip(1).map(str::to_owned).collect();
    // Express non-strict routing accepts ONE optional trailing slash; an interior or repeated
    // empty segment must not become a valid path (`/api//v1/pay` is not `/api/v1/pay`).
    if segments.last().is_some_and(String::is_empty) {
        segments.pop();
    }
    segments
}

/// Percent-decode one path segment (`decodeURIComponent` semantics, UTF-8).
#[must_use]
pub fn decode_segment(segment: &str) -> Option<String> {
    let bytes = segment.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = hex(bytes.get(index + 1).copied()?)?;
            let low = hex(bytes.get(index + 2).copied()?)?;
            output.push(high * 16 + low);
            index += 3;
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(output).ok()
}

fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn is_static(segment: &str, expected: &str) -> bool {
    segment.eq_ignore_ascii_case(expected)
}

fn is_get(method: &Method) -> bool {
    method == Method::GET || method == Method::HEAD
}

fn is_post(method: &Method) -> bool {
    method == Method::POST
}

/// Whether the path is under the pay limiter mount (`app.use("/api/v1/pay", payLimiter)`).
#[must_use]
pub fn under_pay_prefix(segments: &[String]) -> bool {
    segments.len() >= 3
        && is_static(&segments[0], PAY_PREFIX[0])
        && is_static(&segments[1], PAY_PREFIX[1])
        && is_static(&segments[2], PAY_PREFIX[2])
}

/// Whether the path is under the inbound mount.
#[must_use]
pub fn under_inbound_prefix(segments: &[String]) -> bool {
    segments.len() >= 3
        && is_static(&segments[0], INBOUND_PREFIX[0])
        && is_static(&segments[1], INBOUND_PREFIX[1])
        && is_static(&segments[2], INBOUND_PREFIX[2])
}

/// Match a request against the checkout route table.
#[must_use]
pub fn match_route(method: &Method, raw_path: &str) -> Option<RouteMatch> {
    let segments: Vec<String> = path_segments(raw_path);
    if segments.len() == 1 && is_static(&segments[0], "health") {
        return is_get(method).then(|| RouteMatch::new(Route::Health));
    }
    if under_inbound_prefix(&segments) {
        let mut matched = RouteMatch::new(Route::Inbound);
        matched.inbound_segments = segments[3..].to_vec();
        return Some(matched);
    }
    if segments.len() < 3 || !is_static(&segments[0], "api") || !is_static(&segments[1], "v1") {
        return None;
    }
    match (segments[2].as_str(), method) {
        (third, _) if is_static(third, "pay") => match_pay(method, &segments),
        (third, _) if is_static(third, "return") => match_return(method, &segments),
        (third, _) if is_static(third, "verify") => match_certificate(method, &segments),
        _ => None,
    }
}

fn set_param(
    matched: &mut RouteMatch,
    segment: &str,
    assign: impl FnOnce(&mut RouteMatch, String),
) {
    match decode_segment(segment) {
        Some(value) => assign(matched, value),
        None => matched.malformed_path = true,
    }
}

fn match_pay(method: &Method, segments: &[String]) -> Option<RouteMatch> {
    // /api/v1/pay/:linkKey
    if segments.len() == 4 {
        return is_get(method).then(|| {
            let mut matched = RouteMatch::new(Route::PayLink);
            set_param(&mut matched, &segments[3], |matched, value| {
                matched.link_key = Some(value);
            });
            matched
        });
    }
    if segments.len() == 5 {
        let mut matched = RouteMatch::new(if is_static(&segments[4], "initiate") {
            Route::Initiate
        } else if is_static(&segments[4], "sandbox-accounts") {
            if is_post(method) {
                Route::SandboxAccountsCreate
            } else if is_get(method) {
                Route::SandboxAccountsList
            } else {
                return None;
            }
        } else {
            return None;
        });
        if !matches!(
            matched.route,
            Route::SandboxAccountsCreate | Route::SandboxAccountsList
        ) && !is_post(method)
        {
            return None;
        }
        set_param(&mut matched, &segments[3], |matched, value| {
            matched.link_key = Some(value);
        });
        return Some(matched);
    }
    if segments.len() == 6 {
        if !is_static(&segments[4], "logs") {
            if is_static(&segments[4], "sandbox-accounts") {
                if !matches!(method, &Method::PATCH) {
                    return None;
                }
                let mut matched = RouteMatch::new(Route::SandboxAccountPatch);
                set_param(&mut matched, &segments[3], |matched, value| {
                    matched.link_key = Some(value);
                });
                set_param(&mut matched, &segments[5], |matched, value| {
                    matched.account_id = Some(value);
                });
                return Some(matched);
            }
            return None;
        }
        let mut matched = RouteMatch::new(Route::AttemptLogs);
        set_param(&mut matched, &segments[3], |matched, value| {
            matched.link_key = Some(value);
        });
        set_param(&mut matched, &segments[5], |matched, value| {
            matched.attempt_id = Some(value);
        });
        if is_get(method) {
            return Some(matched);
        }
        return None;
    }
    if segments.len() == 7 && is_static(&segments[4], "logs") {
        let route = if is_static(&segments[6], "status") {
            Route::AttemptStatus
        } else if is_static(&segments[6], "confirm") {
            Route::Confirm
        } else if is_static(&segments[6], "resend") {
            Route::Resend
        } else if is_static(&segments[6], "cancel") {
            Route::Cancel
        } else if is_static(&segments[6], "client-event") {
            Route::ClientEvent
        } else if is_static(&segments[6], "sandbox-inspector") {
            Route::SandboxInspector
        } else if is_static(&segments[6], "sandbox-simulate") {
            Route::SandboxSimulate
        } else {
            return None;
        };
        let method_ok = match route {
            Route::AttemptStatus | Route::SandboxInspector => is_get(method),
            _ => is_post(method),
        };
        if !method_ok {
            return None;
        }
        let mut matched = RouteMatch::new(route);
        set_param(&mut matched, &segments[3], |matched, value| {
            matched.link_key = Some(value);
        });
        set_param(&mut matched, &segments[5], |matched, value| {
            matched.attempt_id = Some(value);
        });
        return Some(matched);
    }
    if segments.len() == 7 && is_static(&segments[4], "sandbox-accounts") {
        if !is_static(&segments[6], "movements") || !is_get(method) {
            return None;
        }
        let mut matched = RouteMatch::new(Route::SandboxAccountMovements);
        set_param(&mut matched, &segments[3], |matched, value| {
            matched.link_key = Some(value);
        });
        set_param(&mut matched, &segments[5], |matched, value| {
            matched.account_id = Some(value);
        });
        return Some(matched);
    }
    None
}

fn match_return(method: &Method, segments: &[String]) -> Option<RouteMatch> {
    if segments.len() != 4 || !(is_get(method) || is_post(method)) {
        return None;
    }
    let mut matched = RouteMatch::new(Route::Return);
    set_param(&mut matched, &segments[3], |matched, value| {
        matched.attempt_token = Some(value);
    });
    Some(matched)
}

fn match_certificate(method: &Method, segments: &[String]) -> Option<RouteMatch> {
    if segments.len() != 5 || !is_get(method) || !is_static(&segments[3], "certificate") {
        return None;
    }
    let mut matched = RouteMatch::new(Route::Certificate);
    set_param(&mut matched, &segments[4], |matched, value| {
        matched.public_id = Some(value);
    });
    Some(matched)
}

/// The JSON body of the inbound mount's method guard, with its status and `Allow` header.
#[must_use]
pub fn inbound_method_not_allowed() -> (StatusCode, &'static str) {
    (StatusCode::METHOD_NOT_ALLOWED, "GET, HEAD, POST")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_ts_route_matches() {
        let cases = [
            (Method::GET, "/health", Route::Health),
            (Method::GET, "/api/v1/pay/LNKTESTKEY1", Route::PayLink),
            (
                Method::POST,
                "/api/v1/pay/LNKTESTKEY1/initiate",
                Route::Initiate,
            ),
            (
                Method::GET,
                "/api/v1/pay/LNKTESTKEY1/logs/att_test_1",
                Route::AttemptLogs,
            ),
            (
                Method::GET,
                "/api/v1/pay/LNKTESTKEY1/logs/att_test_1/status",
                Route::AttemptStatus,
            ),
            (
                Method::POST,
                "/api/v1/pay/LNKTESTKEY1/logs/att_test_1/confirm",
                Route::Confirm,
            ),
            (
                Method::POST,
                "/api/v1/pay/LNKTESTKEY1/logs/att_test_1/resend",
                Route::Resend,
            ),
            (
                Method::POST,
                "/api/v1/pay/LNKTESTKEY1/logs/att_test_1/cancel",
                Route::Cancel,
            ),
            (
                Method::POST,
                "/api/v1/pay/LNKTESTKEY1/logs/att_test_1/client-event",
                Route::ClientEvent,
            ),
            (
                Method::GET,
                "/api/v1/pay/LNKTESTKEY1/logs/att_test_1/sandbox-inspector",
                Route::SandboxInspector,
            ),
            (
                Method::POST,
                "/api/v1/pay/LNKTESTKEY1/logs/att_test_1/sandbox-simulate",
                Route::SandboxSimulate,
            ),
            (
                Method::GET,
                "/api/v1/pay/LNKTESTKEY1/sandbox-accounts",
                Route::SandboxAccountsList,
            ),
            (
                Method::POST,
                "/api/v1/pay/LNKTESTKEY1/sandbox-accounts",
                Route::SandboxAccountsCreate,
            ),
            (
                Method::GET,
                "/api/v1/pay/LNKTESTKEY1/sandbox-accounts/acc_1/movements",
                Route::SandboxAccountMovements,
            ),
            (
                Method::PATCH,
                "/api/v1/pay/LNKTESTKEY1/sandbox-accounts/acc_1",
                Route::SandboxAccountPatch,
            ),
            (Method::GET, "/api/v1/return/attempttoken123", Route::Return),
            (
                Method::POST,
                "/api/v1/return/attempttoken123",
                Route::Return,
            ),
            (
                Method::GET,
                "/api/v1/verify/certificate/opaquePublicId0123456789abcdef",
                Route::Certificate,
            ),
            (
                Method::POST,
                "/api/v1/inbound/moamalat/live/abc123token",
                Route::Inbound,
            ),
        ];
        for (method, path, route) in cases {
            let matched = match_route(&method, path).unwrap_or_else(|| panic!("{method} {path}"));
            assert_eq!(matched.route, route, "{method} {path}");
        }
    }

    #[test]
    fn head_is_handled_by_get_routes() {
        assert_eq!(
            match_route(&Method::HEAD, "/api/v1/pay/LNKTESTKEY1")
                .expect("head")
                .route,
            Route::PayLink
        );
        assert_eq!(
            match_route(&Method::HEAD, "/health").expect("head").route,
            Route::Health
        );
    }

    #[test]
    fn wrong_methods_are_not_routes() {
        for (method, path) in [
            (Method::GET, "/api/v1/pay/LNKTESTKEY1/initiate"),
            (
                Method::GET,
                "/api/v1/pay/LNKTESTKEY1/logs/att_test_1/confirm",
            ),
            (
                Method::DELETE,
                "/api/v1/pay/LNKTESTKEY1/sandbox-accounts/acc_1",
            ),
            (Method::GET, "/api/v1/return/attempttoken123/extra"),
            (
                Method::POST,
                "/api/v1/verify/certificate/opaquePublicId0123456789abcdef",
            ),
            (Method::POST, "/health"),
        ] {
            assert!(match_route(&method, path).is_none(), "{method} {path}");
        }
    }

    #[test]
    fn unknown_paths_are_none() {
        for path in [
            "/",
            "/healthz",
            "/api/v1",
            "/api/v1/pay",
            "/api/v1/pay/LNKTESTKEY1/unknown",
            "/api/v1/other/x",
        ] {
            assert!(match_route(&Method::GET, path).is_none(), "{path}");
        }
    }

    #[test]
    fn static_segments_are_case_insensitive_and_trailing_slash_is_accepted() {
        assert_eq!(
            match_route(&Method::GET, "/API/V1/PAY/LNKTESTKEY1/")
                .expect("case")
                .route,
            Route::PayLink
        );
        assert_eq!(
            match_route(&Method::GET, "/api/v1/pay/LNK_TEST_1?next=1")
                .expect("query")
                .route,
            Route::PayLink
        );
    }

    #[test]
    fn parameters_are_percent_decoded() {
        let matched = match_route(&Method::GET, "/api/v1/pay/%4CNKTESTKEY1").expect("decoded");
        assert_eq!(matched.link_key.as_deref(), Some("LNKTESTKEY1"));
        let matched =
            match_route(&Method::GET, "/api/v1/return/attempttoken%5F123").expect("decoded");
        assert_eq!(matched.attempt_token.as_deref(), Some("attempttoken_123"));
    }

    #[test]
    fn inbound_segments_are_captured_for_the_guard_and_rate_key() {
        let matched = match_route(&Method::PUT, "/api/v1/inbound/gw/live/token").expect("inbound");
        assert_eq!(matched.route, Route::Inbound);
        assert_eq!(matched.inbound_segments, vec!["gw", "live", "token"]);
    }

    #[test]
    fn mounts_are_detected_even_without_a_route() {
        let segments = path_segments("/api/v1/pay/a/b/c/d/e/f/g");
        assert!(under_pay_prefix(&segments));
        let inbound = path_segments("/api/v1/inbound/gw/live/token/extra");
        assert!(under_inbound_prefix(&inbound));
        assert!(!under_pay_prefix(&path_segments("/api/v1/payer")));
        assert!(!under_inbound_prefix(&path_segments("/api/v1/inboundx")));
    }

    #[test]
    fn route_table_is_complete_and_names_its_ts_origin() {
        let routes = [
            Route::Health,
            Route::Inbound,
            Route::PayLink,
            Route::Initiate,
            Route::AttemptLogs,
            Route::AttemptStatus,
            Route::Confirm,
            Route::Resend,
            Route::Cancel,
            Route::ClientEvent,
            Route::SandboxAccountsList,
            Route::SandboxAccountsCreate,
            Route::SandboxAccountMovements,
            Route::SandboxAccountPatch,
            Route::SandboxInspector,
            Route::SandboxSimulate,
            Route::Return,
            Route::Certificate,
        ];
        assert_eq!(routes.len(), 18);
        for route in routes {
            assert!(route.ts_path().starts_with('/'));
            assert!(!route.ts_origin().1.is_empty());
        }
    }
}

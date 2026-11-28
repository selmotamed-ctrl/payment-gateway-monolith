//! Core-response relay helpers and the CORS allow-list.
//!
//! Port of `{admin,merchant,checkout}-back/api/forward.ts` (`relayStatus`, the response header
//! allow-list) and `lib/security/index.ts` (`corsAllowList`).
//!
//! `relayStatus` is used by routes whose core outcome became asynchronous (backups, drills,
//! reconciliation, object storage, approvals): the edge answers with the status core returned
//! instead of its declared 200/202. The header allow-list is the exact set `forward.ts` copies
//! back (`content-type`, `content-disposition`, `x-content-sha256`, `x-pg-served-by`,
//! `x-pg-min-lsn`).
//!
//! CORS is emitted only when `CORS_ALLOWED_ORIGINS` is configured; origins are exact matches and
//! credentials are never allowed (the TypeScript `cors({ credentials: false })`).

#![forbid(unsafe_code)]

/// Response headers relayed from core to the client.
pub const RELAY_RESPONSE_HEADERS: [&str; 5] = [
    "content-type",
    "content-disposition",
    "x-content-sha256",
    "x-pg-served-by",
    "x-pg-min-lsn",
];

/// The status of a forwarded call.
#[must_use]
pub fn relay_status(relay: bool, core_status: u16, declared_status: Option<u16>) -> u16 {
    if relay {
        core_status
    } else {
        declared_status.unwrap_or(200)
    }
}

/// Parsed `CORS_ALLOWED_ORIGINS`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CorsAllowList {
    origins: Vec<String>,
}

impl CorsAllowList {
    /// Split, trim and strip trailing slashes, exactly like `allowedOrigins()`.
    #[must_use]
    pub fn from_csv(raw: Option<&str>) -> Self {
        let origins = raw
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .map(|origin| origin.trim_end_matches('/'))
            .filter(|origin| !origin.is_empty())
            .map(str::to_owned)
            .collect();
        Self { origins }
    }

    #[must_use]
    pub fn is_enabled(&self) -> bool {
        !self.origins.is_empty()
    }

    #[must_use]
    pub fn origins(&self) -> &[String] {
        &self.origins
    }

    /// `None` means "emit no CORS headers". `"*"` is only returned when it is literally listed and
    /// the request origin is `*`, matching the exact match in the TS `allowedOrigins().includes`.
    #[must_use]
    pub fn allow_origin(&self, origin: Option<&str>) -> Option<String> {
        let origin = origin?;
        self.origins
            .iter()
            .any(|entry| entry == origin)
            .then(|| origin.to_owned())
    }

    /// Headers of a successful preflight (`Origin` + `Access-Control-Request-Method` present).
    ///
    /// Empty when CORS is off or the origin is not allowed. `access-control-allow-credentials` is
    /// never produced.
    #[must_use]
    pub fn preflight(
        &self,
        origin: Option<&str>,
        requested_method: Option<&str>,
        requested_headers: Option<&str>,
    ) -> Vec<(String, String)> {
        let Some(origin) = self.allow_origin(origin) else {
            return Vec::new();
        };
        let methods = requested_method
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("GET,HEAD,PUT,PATCH,POST,DELETE");
        let mut headers = vec![
            ("access-control-allow-origin".to_owned(), origin),
            ("vary".to_owned(), "Origin".to_owned()),
            (
                "access-control-allow-methods".to_owned(),
                methods.to_owned(),
            ),
        ];
        if let Some(requested) = requested_headers
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            headers.push((
                "access-control-allow-headers".to_owned(),
                requested.to_owned(),
            ));
        }
        headers
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relay_status_uses_core_only_when_asked() {
        assert_eq!(relay_status(true, 201, Some(200)), 201);
        assert_eq!(relay_status(true, 409, None), 409);
        assert_eq!(relay_status(false, 201, Some(202)), 202);
        assert_eq!(relay_status(false, 500, None), 200);
    }

    #[test]
    fn response_header_allow_list_matches_forward_ts() {
        assert_eq!(RELAY_RESPONSE_HEADERS.len(), 5);
        assert!(RELAY_RESPONSE_HEADERS.contains(&"x-pg-served-by"));
        assert!(RELAY_RESPONSE_HEADERS.contains(&"x-pg-min-lsn"));
        assert!(!RELAY_RESPONSE_HEADERS.contains(&"set-cookie"));
    }

    #[test]
    fn origins_are_trimmed_and_deduplicated_by_exact_match() {
        let list = CorsAllowList::from_csv(Some(" https://a.example/ , https://b.example ,, "));
        assert_eq!(
            list.origins(),
            &[
                "https://a.example".to_owned(),
                "https://b.example".to_owned()
            ]
        );
        assert!(list.is_enabled());
        assert_eq!(
            list.allow_origin(Some("https://a.example")),
            Some("https://a.example".to_owned())
        );
        assert_eq!(list.allow_origin(Some("https://c.example")), None);
        assert_eq!(list.allow_origin(None), None);
        assert!(!CorsAllowList::default().is_enabled());
    }

    #[test]
    fn preflight_is_empty_without_a_configured_origin() {
        let list = CorsAllowList::from_csv(Some("https://a.example"));
        assert!(list.preflight(None, Some("POST"), None).is_empty());
        assert!(list
            .preflight(Some("https://b.example"), Some("POST"), None)
            .is_empty());
    }

    #[test]
    fn preflight_echoes_the_request_and_never_allows_credentials() {
        let list = CorsAllowList::from_csv(Some("https://a.example"));
        let headers = list.preflight(
            Some("https://a.example"),
            Some("PATCH"),
            Some("content-type, authorization"),
        );
        assert!(headers.contains(&(
            "access-control-allow-origin".to_owned(),
            "https://a.example".to_owned()
        )));
        assert!(headers.contains(&(
            "access-control-allow-methods".to_owned(),
            "PATCH".to_owned()
        )));
        assert!(headers.contains(&(
            "access-control-allow-headers".to_owned(),
            "content-type, authorization".to_owned()
        )));
        assert!(!headers
            .iter()
            .any(|(name, _)| name == "access-control-allow-credentials"));
    }

    #[test]
    fn preflight_defaults_methods_when_missing() {
        let list = CorsAllowList::from_csv(Some("https://a.example"));
        let headers = list.preflight(Some("https://a.example"), None, None);
        assert!(headers.contains(&(
            "access-control-allow-methods".to_owned(),
            "GET,HEAD,PUT,PATCH,POST,DELETE".to_owned()
        )));
        assert!(!headers
            .iter()
            .any(|(name, _)| name == "access-control-allow-headers"));
    }
}

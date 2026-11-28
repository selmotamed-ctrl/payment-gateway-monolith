//! Edge security headers (chapter 2 §2).
//!
//! Same in all three edges; `Cache-Control: no-store` unless the handler set one.

#![forbid(unsafe_code)]

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SecurityHeaders;

/// The six headers every edge response carries.
#[must_use]
pub fn security_headers() -> [(&'static str, &'static str); 6] {
    [
        ("x-content-type-options", "nosniff"),
        ("referrer-policy", "no-referrer"),
        ("x-frame-options", "DENY"),
        ("content-security-policy", "frame-ancestors 'none'"),
        ("cross-origin-resource-policy", "same-origin"),
        ("cache-control", "no-store"),
    ]
}

/// Apply to a header map, only when the handler has not already set a value.
pub fn apply_security_headers(headers: &mut http::HeaderMap) {
    use http::header::HeaderName;
    for (name, value) in security_headers() {
        let Ok(name) = HeaderName::from_bytes(name.as_bytes()) else {
            continue;
        };
        if !headers.contains_key(&name) {
            if let Ok(value) = http::HeaderValue::from_str(value) {
                headers.insert(name, value);
            }
        }
    }
}

/// `x-powered-by` must never appear.
#[must_use]
pub fn is_forbidden_technology_header(name: &str) -> bool {
    name.eq_ignore_ascii_case("x-powered-by")
}

/// CORS is enabled only when `CORS_ALLOWED_ORIGINS` is set, never with credentials.
#[derive(Debug, Clone, Default)]
pub struct CorsPolicy {
    allowed_origins: Vec<String>,
}

impl CorsPolicy {
    #[must_use]
    pub fn from_csv(raw: Option<&str>) -> Self {
        Self {
            allowed_origins: raw
                .map(|value| {
                    value
                        .split(',')
                        .map(str::trim)
                        .filter(|origin| !origin.is_empty())
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default(),
        }
    }

    #[must_use]
    pub fn is_enabled(&self) -> bool {
        !self.allowed_origins.is_empty()
    }

    /// `None` means "do not emit CORS headers"; `Some("*")` for an explicit wildcard.
    #[must_use]
    pub fn allow_origin(&self, origin: Option<&str>) -> Option<String> {
        let origin = origin?;
        if self.allowed_origins.iter().any(|entry| entry == "*") {
            return Some("*".to_owned());
        }
        self.allowed_origins
            .iter()
            .any(|entry| entry == origin)
            .then(|| origin.to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn six_headers() {
        assert_eq!(security_headers().len(), 6);
        assert_eq!(security_headers()[0].1, "nosniff");
    }

    #[test]
    fn cors_requires_configured_origin() {
        let policy = CorsPolicy::from_csv(Some("https://a.example"));
        assert_eq!(
            policy.allow_origin(Some("https://a.example")),
            Some("https://a.example".to_owned())
        );
        assert_eq!(policy.allow_origin(Some("https://b.example")), None);
        assert!(!CorsPolicy::default().is_enabled());
    }
}

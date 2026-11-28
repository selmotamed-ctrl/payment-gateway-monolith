//! Core pool configuration: `CORE_BACK_URLS`, the Sandbox pool and the plane marker.
//!
//! Port of `{admin,merchant,checkout}-back/lib/env/index.ts` (`parseCoreBackUrls`,
//! `coreBackUrls`, `sandboxCoreBackUrls`), `lib/corePools.ts` and the
//! `x-execution-plane` / `x-sandbox-proxy` headers in the sandbox proxies.
//!
//! The Sandbox pool is strictly separate. When it is not configured, [`CorePoolConfig::urls`]
//! returns `503 SANDBOX_NODE_UNAVAILABLE`; it never returns the Live URLs.

#![forbid(unsafe_code)]

use url::Url;

use crate::error::PoolError;
use crate::path::EdgeChannel;

/// The bearer-token prefix that pins a merchant request to the Sandbox plane.
///
/// Port of `sandboxTokenPrefix` (`merchant-back/lib/corePools.ts:8`).
pub const SANDBOX_TOKEN_PREFIX: &str = "pg_test_";
/// The `sbx_` link-key prefix used by the checkout edge.
///
/// Port of `isSandboxLinkKey` (`checkout-back/lib/corePools.ts:5`).
pub const SANDBOX_LINK_PREFIX: &str = "sbx_";

/// A bad `CORE_BACK_URLS` / `SANDBOX_CORE_BACK_URLS` value.
///
/// Port of the throws in `parseCoreBackUrls` (`env/index.ts:103-124`).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PoolConfigError {
    #[error("CORE_BACK_URLS must not contain an empty entry")]
    EmptyEntry,
    #[error("CORE_BACK_URLS contains a malformed URL: {0}")]
    MalformedUrl(String),
    #[error("CORE_BACK_URLS only accepts absolute https URLs: {0}")]
    NotHttps(String),
}

/// Parse a comma-separated URL list, de-duplicated, absolute `https:` only.
///
/// Port of `parseCoreBackUrls` (`env/index.ts:103-124`). The fallback (`CORE_BACK_URL`) is used
/// when the list is absent or blank, exactly like TS. The original (trimmed) text is preserved in
/// the returned list; de-duplication compares the WHATWG-normalised URL so `https://a:443` and
/// `https://A` count as the same node.
pub fn parse_core_back_urls(
    raw: Option<&str>,
    fallback: &str,
) -> Result<Vec<String>, PoolConfigError> {
    let entries: Vec<&str> = match raw {
        Some(value) if !value.trim().is_empty() => value.split(',').collect(),
        _ => vec![fallback],
    };
    let mut seen = std::collections::HashSet::new();
    let mut urls = Vec::with_capacity(entries.len());
    for entry in entries {
        let trimmed = entry.trim();
        if trimmed.is_empty() {
            return Err(PoolConfigError::EmptyEntry);
        }
        let parsed =
            Url::parse(trimmed).map_err(|_| PoolConfigError::MalformedUrl(trimmed.to_owned()))?;
        if parsed.scheme() != "https" {
            return Err(PoolConfigError::NotHttps(trimmed.to_owned()));
        }
        if seen.insert(parsed.to_string()) {
            urls.push(trimmed.to_owned());
        }
    }
    Ok(urls)
}

/// Live or Sandbox.
///
/// Port of `CorePlane` (`merchant-back/lib/corePools.ts:6`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Plane {
    Live,
    Sandbox,
}

impl Plane {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Live => "LIVE",
            Self::Sandbox => "SANDBOX",
        }
    }

    /// A merchant bearer token selects Sandbox only when it carries `pg_test_`.
    #[must_use]
    pub fn from_bearer_token(token: &str) -> Self {
        Self::from_token_prefix(token, SANDBOX_TOKEN_PREFIX)
    }

    /// Checkout: a `sbx_` link key is the only public Sandbox marker.
    #[must_use]
    pub fn from_link_key(link_key: &str) -> Self {
        Self::from_token_prefix(link_key, SANDBOX_LINK_PREFIX)
    }

    #[must_use]
    pub fn from_token_prefix(token: &str, sandbox_prefix: &str) -> Self {
        if token.starts_with(sandbox_prefix) {
            Self::Sandbox
        } else {
            Self::Live
        }
    }
}

/// The configured node list of each plane.
///
/// Port of `coreBackUrls()` plus `sandboxCoreBackUrls()` (`env/index.ts:126-148`). `sandbox` is
/// `None` when this edge has no Sandbox node, which is different from an empty list: both are
/// rejected by [`Self::urls`] for `Plane::Sandbox`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CorePoolConfig {
    pub live: Vec<String>,
    pub sandbox: Option<Vec<String>>,
}

impl CorePoolConfig {
    /// Build from the six environment values.
    ///
    /// `sandbox_urls`/`sandbox_fallback` follow the TS rule: with neither set the Sandbox plane is
    /// not configured at all; with only the fallback set the fallback is the single node.
    pub fn from_values(
        live_urls: Option<&str>,
        live_fallback: &str,
        sandbox_urls: Option<&str>,
        sandbox_fallback: Option<&str>,
    ) -> Result<Self, PoolConfigError> {
        let live = parse_core_back_urls(live_urls, live_fallback)?;
        let sandbox_configured = sandbox_urls.is_some_and(|value| !value.trim().is_empty())
            || sandbox_fallback.is_some_and(|value| !value.trim().is_empty());
        let sandbox = if sandbox_configured {
            let fallback = sandbox_fallback
                .filter(|value| !value.trim().is_empty())
                .map(str::to_owned)
                .or_else(|| {
                    sandbox_urls
                        .and_then(|value| value.split(',').next())
                        .map(str::trim)
                        .map(str::to_owned)
                })
                .unwrap_or_default();
            Some(parse_core_back_urls(sandbox_urls, &fallback)?)
        } else {
            None
        };
        Ok(Self { live, sandbox })
    }

    /// The node list of a plane.
    ///
    /// Never returns the Live list for `Plane::Sandbox`.
    pub fn urls(&self, plane: Plane) -> Result<&[String], PoolError> {
        match plane {
            Plane::Live => Ok(&self.live),
            Plane::Sandbox => match &self.sandbox {
                Some(urls) if !urls.is_empty() => Ok(urls),
                _ => Err(PoolError::sandbox_unavailable()),
            },
        }
    }

    /// `true` when this edge can serve Sandbox traffic at all.
    #[must_use]
    pub fn has_sandbox(&self) -> bool {
        self.sandbox.as_ref().is_some_and(|urls| !urls.is_empty())
    }
}

/// The two headers that pin a request to the Sandbox core plane.
///
/// Port of the `x-execution-plane` / `x-sandbox-proxy` pairs in
/// `{admin,merchant}-back/api/sandboxProxy.ts`.
#[must_use]
pub fn sandbox_headers(channel: EdgeChannel) -> [(&'static str, &'static str); 2] {
    [
        ("x-execution-plane", "SANDBOX"),
        ("x-sandbox-proxy", channel.service_name()),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_trims_and_deduplicates() {
        let urls = parse_core_back_urls(
            Some(" https://core-a:4000 , https://core-b ,https://core-a:4000/ "),
            "https://ignored",
        )
        .expect("urls");
        assert_eq!(urls, vec!["https://core-a:4000", "https://core-b"]);

        let deduped =
            parse_core_back_urls(Some("https://a:443,https://A"), "https://x").expect("urls");
        assert_eq!(deduped, vec!["https://a:443"]);
    }

    #[test]
    fn falls_back_when_the_list_is_absent_or_blank() {
        assert_eq!(
            parse_core_back_urls(None, "https://fallback").expect("urls"),
            vec!["https://fallback"]
        );
        assert_eq!(
            parse_core_back_urls(Some("   "), "https://fallback").expect("urls"),
            vec!["https://fallback"]
        );
    }

    #[test]
    fn rejects_empty_entries_malformed_and_insecure_urls() {
        assert_eq!(
            parse_core_back_urls(Some("https://a,,https://b"), "https://x").expect_err("empty"),
            PoolConfigError::EmptyEntry
        );
        assert_eq!(
            parse_core_back_urls(Some("not a url"), "https://x").expect_err("malformed"),
            PoolConfigError::MalformedUrl("not a url".to_owned())
        );
        assert_eq!(
            parse_core_back_urls(Some("http://core-a"), "https://x").expect_err("http"),
            PoolConfigError::NotHttps("http://core-a".to_owned())
        );
        assert!(PoolConfigError::EmptyEntry
            .to_string()
            .contains("CORE_BACK_URLS"));
    }

    #[test]
    fn sandbox_plane_is_only_configured_when_a_value_is_present() {
        let live_only =
            CorePoolConfig::from_values(Some("https://live"), "https://live", None, None)
                .expect("config");
        assert!(!live_only.has_sandbox());
        assert_eq!(live_only.urls(Plane::Live).expect("live").len(), 1);
        let error = live_only.urls(Plane::Sandbox).expect_err("sandbox");
        assert_eq!(error.code(), "SANDBOX_NODE_UNAVAILABLE");
        assert_eq!(error.status(), 503);

        let blank =
            CorePoolConfig::from_values(Some("https://live"), "https://live", Some("  "), Some(""))
                .expect("config");
        assert!(!blank.has_sandbox());
        assert_eq!(
            blank.urls(Plane::Sandbox).expect_err("sandbox").code(),
            "SANDBOX_NODE_UNAVAILABLE"
        );
    }

    #[test]
    fn sandbox_accepts_a_list_or_a_fallback_and_never_returns_live() {
        let config = CorePoolConfig::from_values(
            Some("https://live"),
            "https://live",
            Some("https://sandbox-a,https://sandbox-b"),
            None,
        )
        .expect("config");
        assert_eq!(
            config.urls(Plane::Sandbox).expect("sandbox"),
            [
                "https://sandbox-a".to_owned(),
                "https://sandbox-b".to_owned()
            ]
            .as_slice()
        );

        let fallback_only = CorePoolConfig::from_values(
            Some("https://live"),
            "https://live",
            None,
            Some("https://sandbox-only"),
        )
        .expect("config");
        assert_eq!(
            fallback_only.urls(Plane::Sandbox).expect("sandbox"),
            ["https://sandbox-only".to_owned()].as_slice()
        );
        assert_ne!(
            fallback_only.urls(Plane::Sandbox).expect("sandbox"),
            fallback_only.urls(Plane::Live).expect("live")
        );

        let list_with_fallback = CorePoolConfig::from_values(
            Some("https://live"),
            "https://live",
            Some("https://sandbox-a"),
            Some("https://sandbox-b"),
        )
        .expect("config");
        assert_eq!(
            list_with_fallback.urls(Plane::Sandbox).expect("sandbox"),
            ["https://sandbox-a".to_owned()].as_slice()
        );
    }

    #[test]
    fn plane_detection_matches_the_token_prefixes() {
        assert_eq!(Plane::from_bearer_token("pg_test_123"), Plane::Sandbox);
        assert_eq!(Plane::from_bearer_token("pg_live_123"), Plane::Live);
        assert_eq!(Plane::from_link_key("sbx_abc"), Plane::Sandbox);
        assert_eq!(Plane::from_link_key("pl_abc"), Plane::Live);
        assert_eq!(Plane::Live.as_str(), "LIVE");
        assert_eq!(Plane::Sandbox.as_str(), "SANDBOX");
    }

    #[test]
    fn sandbox_headers_name_the_edge() {
        assert_eq!(
            sandbox_headers(EdgeChannel::Admin),
            [
                ("x-execution-plane", "SANDBOX"),
                ("x-sandbox-proxy", "admin-back")
            ]
        );
        assert_eq!(
            sandbox_headers(EdgeChannel::Merchant)[1],
            ("x-sandbox-proxy", "merchant-back")
        );
    }
}

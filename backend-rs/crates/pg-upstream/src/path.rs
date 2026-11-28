//! Core path confinement and query serialisation.
//!
//! Port of `assertCorePath` / `resolveCoreUrlAgainst` in
//! `{admin,merchant,checkout}-back/lib/coreInternalClient.ts:260-322` and `:12-17`.
//!
//! Every forwarded path must be a rooted absolute path that stays inside the channel prefixes of
//! the edge. The raw path is checked before a single byte reaches the network:
//!
//! * no `//`, `://`, backslash or non-rooted path;
//! * `%XX` escapes must decode (the TS `decodeURIComponent` contract) and the decoded path must
//!   not contain `.`/`..` segments or a backslash;
//! * the raw path must start with its channel prefix (`/internal/admin`, `/internal/merchant`,
//!   `/internal/checkout`) or with `/internal/sandbox` where the edge is allowed to proxy it.
//!
//! Failures are `500 CORE_PATH_INVALID` (malformed) or `403 CORE_CHANNEL_VIOLATION` (wrong
//! channel), exactly like TS.

#![forbid(unsafe_code)]

use std::fmt::Write as _;

use url::Url;

use crate::error::PoolError;

/// The three edge services and the core channel each one owns.
///
/// Port of `CORE_SERVICE_NAME`, `CORE_CHANNEL_PREFIX` and `CORE_EXTRA_CHANNEL_PREFIXES` in all
/// three `coreInternalClient.ts` copies plus `lib/corePools.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EdgeChannel {
    Admin,
    Merchant,
    Checkout,
}

impl EdgeChannel {
    #[must_use]
    pub const fn all() -> [Self; 3] {
        [Self::Admin, Self::Merchant, Self::Checkout]
    }

    /// The mTLS certificate CN and `x-edge-service` value.
    #[must_use]
    pub const fn service_name(self) -> &'static str {
        match self {
            Self::Admin => "admin-back",
            Self::Merchant => "merchant-back",
            Self::Checkout => "checkout-back",
        }
    }

    /// The channel prefixes this edge may call.
    ///
    /// Admin and merchant both reach the Sandbox control plane; checkout never does.
    #[must_use]
    pub const fn prefixes(self) -> &'static [&'static str] {
        match self {
            Self::Admin => &["/internal/admin", "/internal/sandbox"],
            Self::Merchant => &["/internal/merchant", "/internal/sandbox"],
            Self::Checkout => &["/internal/checkout"],
        }
    }

    /// The edge's own channel prefix (the first entry of [`Self::prefixes`]).
    #[must_use]
    pub const fn primary_prefix(self) -> &'static str {
        match self {
            Self::Admin => "/internal/admin",
            Self::Merchant => "/internal/merchant",
            Self::Checkout => "/internal/checkout",
        }
    }

    /// Reverse of [`Self::service_name`], used by configuration loaders and tests.
    #[must_use]
    pub fn parse_service_name(raw: &str) -> Option<Self> {
        Self::all()
            .into_iter()
            .find(|channel| channel.service_name() == raw)
    }
}

/// Validate a path and return it unchanged.
///
/// Port of `assertCorePath` (`coreInternalClient.ts:260-294`, identical in all three copies except
/// for the prefix list).
pub fn assert_core_path(channel: EdgeChannel, path: &str) -> Result<&str, PoolError> {
    if path.is_empty() {
        return Err(PoolError::path_invalid("A core path is required"));
    }
    if !path.starts_with('/')
        || path.starts_with("//")
        || path.contains("://")
        || path.contains('\\')
    {
        return Err(PoolError::path_invalid(
            "Core path must be a rooted absolute path",
        ));
    }
    let decoded = percent_decode(path)
        .ok_or_else(|| PoolError::path_invalid("Core path contains invalid escaping"))?;
    if decoded.contains('\\') {
        return Err(PoolError::path_invalid(
            "Core path must not contain backslashes",
        ));
    }
    if decoded
        .split('/')
        .any(|segment| segment == "." || segment == "..")
    {
        return Err(PoolError::path_invalid(
            "Core path must not contain traversal segments",
        ));
    }
    let allowed = channel.prefixes();
    let inside = allowed.iter().any(|prefix| {
        let with_slash = format!("{prefix}/");
        path == *prefix || path.starts_with(with_slash.as_str())
    });
    if !inside {
        let prefixes = allowed.join(", ");
        return Err(PoolError::channel_violation(format!(
            "Path is outside the {prefixes} channel bound to {}",
            channel.service_name()
        )));
    }
    Ok(path)
}

/// One query parameter value.
///
/// Port of the `string | number | boolean` half of `CoreCallOptions.query`
/// (`coreInternalClient.ts:71`). `null`/`undefined` are modelled by omitting the entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QueryValue {
    Text(String),
    Bool(bool),
    Integer(i64),
}

impl QueryValue {
    /// `String(value)` from the TS `URLSearchParams.append`.
    #[must_use]
    pub fn as_text(&self) -> String {
        match self {
            Self::Text(value) => value.clone(),
            Self::Bool(true) => "true".to_owned(),
            Self::Bool(false) => "false".to_owned(),
            Self::Integer(value) => value.to_string(),
        }
    }
}

impl From<&str> for QueryValue {
    fn from(value: &str) -> Self {
        Self::Text(value.to_owned())
    }
}

impl From<String> for QueryValue {
    fn from(value: String) -> Self {
        Self::Text(value)
    }
}

impl From<bool> for QueryValue {
    fn from(value: bool) -> Self {
        Self::Bool(value)
    }
}

impl From<i64> for QueryValue {
    fn from(value: i64) -> Self {
        Self::Integer(value)
    }
}

/// Join a confined path (and its query) onto a configured core base URL.
///
/// Port of `resolveCoreUrlAgainst` (`coreInternalClient.ts:296-316`): the base path is kept
/// (minus trailing slashes), the fragment is dropped and the query is serialised with the WHATWG
/// `application/x-www-form-urlencoded` rules Node's `URLSearchParams` uses (space becomes `+`).
pub fn resolve_core_url(
    channel: EdgeChannel,
    base_url: &str,
    path: &str,
    query: &[(String, QueryValue)],
) -> Result<Url, PoolError> {
    let safe_path = assert_core_path(channel, path)?;
    let base = Url::parse(base_url)
        .map_err(|_| PoolError::config_invalid("CORE_BACK_URL is not a valid absolute URL"))?;
    let mut target = base.clone();
    let base_path = base.path().trim_end_matches('/');
    target.set_path(&format!("{base_path}{safe_path}"));
    target.set_fragment(None);
    if !query.is_empty() {
        let mut serialized = String::new();
        for (index, (key, value)) in query.iter().enumerate() {
            if index > 0 {
                serialized.push('&');
            }
            encode_form_component(key, &mut serialized);
            serialized.push('=');
            encode_form_component(&value.as_text(), &mut serialized);
        }
        target.set_query(Some(&serialized));
    }
    Ok(target)
}

/// `decodeURIComponent`: decode `%XX` sequences and reject malformed escapes or invalid UTF-8.
fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes.get(index).copied() == Some(b'%') {
            let high = hex_value(bytes.get(index + 1).copied()?)?;
            let low = hex_value(bytes.get(index + 2).copied()?)?;
            decoded.push(high.saturating_mul(16).saturating_add(low));
            index += 3;
        } else {
            decoded.push(bytes.get(index).copied()?);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// The WHATWG form-urlencoded byte set: alphanumerics plus `*-._`, space as `+`.
fn encode_form_component(value: &str, output: &mut String) {
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                output.push(char::from(byte));
            }
            b' ' => output.push('+'),
            _ => {
                let _ = write!(output, "%{byte:02X}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_prefixes_of_each_channel() {
        assert!(assert_core_path(EdgeChannel::Admin, "/internal/admin/merchants").is_ok());
        assert!(assert_core_path(EdgeChannel::Admin, "/internal/admin").is_ok());
        assert!(assert_core_path(EdgeChannel::Admin, "/internal/sandbox/merchant/x").is_ok());
        assert!(assert_core_path(EdgeChannel::Merchant, "/internal/merchant/payments").is_ok());
        assert!(assert_core_path(EdgeChannel::Merchant, "/internal/sandbox/merchant/x").is_ok());
        assert!(assert_core_path(EdgeChannel::Checkout, "/internal/checkout/pay").is_ok());
        assert!(assert_core_path(EdgeChannel::Merchant, "/internal/sandbox").is_ok());
    }

    #[test]
    fn rejects_malformed_rooted_paths() {
        for path in [
            "",
            "internal/admin/x",
            "//internal/admin/x",
            "/internal/admin/../merchant",
            "/internal/admin/./x",
            "/internal/admin/..",
            "/internal/admin/a\\b",
            "/internal/admin?x=://evil",
            "/internal/admin/%2e%2e/merchant",
            "/internal/admin/%5c..",
            "/internal/admin/%",
            "/internal/admin/%zz",
            "/internal/admin/%ff",
        ] {
            let error = assert_core_path(EdgeChannel::Admin, path).expect_err(path);
            assert_eq!(error.code(), "CORE_PATH_INVALID", "{path}");
            assert_eq!(error.status(), 500, "{path}");
        }
    }

    #[test]
    fn rejects_paths_outside_the_channel() {
        let cases = [
            (EdgeChannel::Admin, "/internal/merchant/payments"),
            (EdgeChannel::Admin, "/internal/checkout/pay"),
            (EdgeChannel::Merchant, "/internal/admin/users"),
            (EdgeChannel::Merchant, "/internal/checkout/pay"),
            (EdgeChannel::Checkout, "/internal/admin/users"),
            (EdgeChannel::Checkout, "/internal/sandbox/fake-rails"),
            (EdgeChannel::Admin, "/internal/adminx"),
            (EdgeChannel::Admin, "/internal/admin-old/x"),
        ];
        for (channel, path) in cases {
            let error = assert_core_path(channel, path).expect_err(path);
            assert_eq!(error.code(), "CORE_CHANNEL_VIOLATION", "{path}");
            assert_eq!(error.status(), 403, "{path}");
            assert!(error.message().contains(channel.service_name()));
        }
    }

    #[test]
    fn channel_names_round_trip() {
        for channel in EdgeChannel::all() {
            assert_eq!(
                EdgeChannel::parse_service_name(channel.service_name()),
                Some(channel)
            );
            assert!(channel.primary_prefix().starts_with("/internal/"));
        }
        assert_eq!(EdgeChannel::parse_service_name("core-back"), None);
    }

    #[test]
    fn joins_base_path_path_and_query_like_the_ts_client() {
        let url = resolve_core_url(
            EdgeChannel::Admin,
            "https://core-a:4000/base/",
            "/internal/admin/merchants",
            &[
                ("page".to_owned(), QueryValue::from(2_i64)),
                ("search".to_owned(), QueryValue::from("a b&c")),
                ("flag".to_owned(), QueryValue::from(true)),
            ],
        )
        .expect("url");
        assert_eq!(
            url.as_str(),
            "https://core-a:4000/base/internal/admin/merchants?page=2&search=a+b%26c&flag=true"
        );

        let plain = resolve_core_url(
            EdgeChannel::Merchant,
            "https://core-b",
            "/internal/merchant/links",
            &[],
        )
        .expect("url");
        assert_eq!(plain.as_str(), "https://core-b/internal/merchant/links");

        let fragment = resolve_core_url(
            EdgeChannel::Checkout,
            "https://core-c/base#section",
            "/internal/checkout/pay",
            &[],
        )
        .expect("url");
        assert_eq!(
            fragment.as_str(),
            "https://core-c/base/internal/checkout/pay"
        );
    }

    #[test]
    fn resolve_rejects_confined_and_unparseable_inputs() {
        assert_eq!(
            resolve_core_url(
                EdgeChannel::Admin,
                "https://core-a",
                "/internal/merchant/x",
                &[]
            )
            .expect_err("channel")
            .code(),
            "CORE_CHANNEL_VIOLATION"
        );
        assert_eq!(
            resolve_core_url(EdgeChannel::Admin, "not a url", "/internal/admin/x", &[])
                .expect_err("base")
                .code(),
            "CORE_CONFIG_INVALID"
        );
    }

    #[test]
    fn form_encoding_matches_url_search_params() {
        let mut encoded = String::new();
        encode_form_component("a b~!*()'", &mut encoded);
        assert_eq!(encoded, "a+b%7E%21*%28%29%27");
    }
}

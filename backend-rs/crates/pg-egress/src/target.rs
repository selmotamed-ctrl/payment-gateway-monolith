//! Outbound target validation, DNS pinning and response caps.
//!
//! Port of `validateWebhookUrl` / `resolvePinnedAddress` (`core-back/lib/webhooks/egress.ts:21-71`)
//! and the SSRF posture of `compileUrl.validateFinalUrl` / `ApiConsumer.assertDnsAllowed`
//! (`core-back/engine/apiConsumer/compileUrl.ts:160-190`,
//! `core-back/engine/apiConsumer/ApiConsumer.ts:923-948`).
//!
//! Rules, in the TS order:
//!
//! 1. the URL is non-empty, within the length cap and free of whitespace/control characters;
//! 2. no backslash and no encoded path separator (`%2f`/`%5c`), no `.`/`..` path segment;
//! 3. `https:` only (an explicit development opt-in may allow `http:`);
//! 4. no credentials and no fragment;
//! 5. the port is 443, or explicitly allowed;
//! 6. a configured host allowlist must contain the host (an empty allowlist fails closed);
//! 7. no local name and no private/loopback/link-local literal;
//! 8. the name resolves **once**, every address must be public, and the first address is pinned.
//!
//! [`EgressPolicy::allow_private_hosts`] is the scoped Fake Rails relaxation: it must only be set
//! for a host that is also on the allowlist (checked anyway).

#![forbid(unsafe_code)]

use std::net::{IpAddr, SocketAddr};

use url::Url;

use crate::error::EgressError;
use crate::ip_rules::{is_ip_literal, is_local_host_name, is_public_ip, normalize_host};

/// DNS resolution for an outbound host.
///
/// Port of the `DnsResolver`/`DnsLookupHook` types; Rust uses a trait so tests can return a fixed
/// list without a network.
pub trait Resolver {
    fn resolve(&self, host: &str) -> Result<Vec<IpAddr>, EgressError>;
}

/// A resolver with a fixed answer per host (tests and the parity harness).
#[derive(Debug, Clone, Default)]
pub struct StaticResolver {
    entries: Vec<(String, Vec<IpAddr>)>,
}

impl StaticResolver {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Add one host answer. Addresses that do not parse are dropped; a typo therefore surfaces as
    /// an empty answer (and `DNS_FAILURE`), never as a silent different address.
    #[must_use]
    pub fn with(mut self, host: &str, addresses: &[&str]) -> Self {
        let parsed = addresses
            .iter()
            .filter_map(|address| address.parse::<IpAddr>().ok())
            .collect();
        self.entries.push((normalize_host(host), parsed));
        self
    }
}

impl Resolver for StaticResolver {
    fn resolve(&self, host: &str) -> Result<Vec<IpAddr>, EgressError> {
        let normalized = normalize_host(host);
        self.entries
            .iter()
            .find(|(entry, _)| *entry == normalized)
            .map(|(_, addresses)| addresses.clone())
            .ok_or_else(|| EgressError::dns_failure(normalized))
    }
}

/// The operating system resolver.
///
/// Blocking; an async caller must run it on `spawn_blocking` (chapter 3 §2). Tests never call it.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemResolver;

impl Resolver for SystemResolver {
    fn resolve(&self, host: &str) -> Result<Vec<IpAddr>, EgressError> {
        use std::net::ToSocketAddrs;
        let entries = (host, 0_u16)
            .to_socket_addrs()
            .map_err(|_| EgressError::dns_failure(normalize_host(host)))?;
        let mut addresses: Vec<IpAddr> = Vec::new();
        for entry in entries {
            let address = entry.ip();
            if !addresses.contains(&address) {
                addresses.push(address);
            }
        }
        if addresses.is_empty() {
            return Err(EgressError::dns_failure(normalize_host(host)));
        }
        Ok(addresses)
    }
}

/// A host allowlist with exact match semantics (TS `allowedHosts`).
///
/// Entries are trimmed, lowercased and lose one trailing root dot. Both the hostname and the
/// `host:port` form are compared, like `validateFinalUrl` (`compileUrl.ts:177-186`). An empty list
/// fails closed unless [`Self::with_allow_any`] was set explicitly.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HostAllowlist {
    entries: Vec<String>,
    allow_any: bool,
}

impl HostAllowlist {
    #[must_use]
    pub fn new(entries: &[&str]) -> Self {
        let entries = entries
            .iter()
            .map(|entry| normalize_allowlist_entry(entry))
            .filter(|entry| !entry.is_empty())
            .collect();
        Self {
            entries,
            allow_any: false,
        }
    }

    #[must_use]
    pub fn from_csv(raw: &str) -> Self {
        let entries: Vec<&str> = raw.split(',').collect();
        Self::new(&entries)
    }

    /// Explicit opt-out of the allowlist (`allowAnyHost` in TS). Never set it from request input.
    #[must_use]
    pub fn with_allow_any(mut self) -> Self {
        self.allow_any = true;
        self
    }

    #[must_use]
    pub fn entries(&self) -> &[String] {
        &self.entries
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    #[must_use]
    pub fn allows_any(&self) -> bool {
        self.allow_any
    }

    /// `hostname` is the serialized host (`[::1]` keeps its brackets) and `host_with_port` adds a
    /// non-default port, exactly like WHATWG `URL.hostname`/`URL.host`.
    #[must_use]
    pub fn is_permitted(&self, hostname: &str, host_with_port: &str) -> bool {
        if self.allow_any {
            return true;
        }
        let hostname = normalize_allowlist_entry(hostname);
        let host_with_port = normalize_allowlist_entry(host_with_port);
        self.entries
            .iter()
            .any(|entry| *entry == hostname || *entry == host_with_port)
    }

    /// Reject an unconfigured allowlist before any resolution happens.
    pub fn ensure_configured(&self) -> Result<(), EgressError> {
        if self.entries.is_empty() && !self.allow_any {
            Err(EgressError::HostAllowlistEmpty)
        } else {
            Ok(())
        }
    }
}

/// The policy applied to one outbound call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EgressPolicy {
    pub allowlist: HostAllowlist,
    /// Development-only `http:` (never enabled in production configuration).
    pub allow_insecure_http: bool,
    /// The scoped Fake Rails relaxation. Leave `false` everywhere else.
    pub allow_private_hosts: bool,
    /// Extra ports beyond 443 (and 80 when `allow_insecure_http`).
    pub extra_ports: Vec<u16>,
    pub allow_fragments: bool,
    pub max_url_length: usize,
    pub max_response_bytes: u64,
}

impl EgressPolicy {
    /// TS `MAX_URL_LENGTH` in `validateWebhookUrl` (`webhooks/egress.ts:27`).
    pub const DEFAULT_MAX_URL_LENGTH: usize = 2_000;
    /// `ApiConsumer` default response cap (`ApiConsumer.ts:969`).
    pub const DEFAULT_MAX_RESPONSE_BYTES: u64 = 2 * 1024 * 1024;
    /// `postPinned` default response cap (`webhooks/egress.ts:105`).
    pub const WEBHOOK_MAX_RESPONSE_BYTES: u64 = 4 * 1024;

    #[must_use]
    pub fn new(allowlist: HostAllowlist) -> Self {
        Self {
            allowlist,
            allow_insecure_http: false,
            allow_private_hosts: false,
            extra_ports: Vec::new(),
            allow_fragments: false,
            max_url_length: Self::DEFAULT_MAX_URL_LENGTH,
            max_response_bytes: Self::DEFAULT_MAX_RESPONSE_BYTES,
        }
    }

    /// The merchant webhook posture: 4 KiB answer cap, optional development `http:`.
    #[must_use]
    pub fn webhook(allowlist: HostAllowlist, allow_insecure: bool) -> Self {
        let mut policy = Self::new(allowlist);
        policy.allow_insecure_http = allow_insecure;
        policy.max_response_bytes = Self::WEBHOOK_MAX_RESPONSE_BYTES;
        policy
    }

    /// Permit one additional port.
    #[must_use]
    pub fn with_port(mut self, port: u16) -> Self {
        self.extra_ports.push(port);
        self
    }

    /// Enable the scoped private-host relaxation (Fake Rails only).
    #[must_use]
    pub fn with_private_hosts(mut self) -> Self {
        self.allow_private_hosts = true;
        self
    }

    #[must_use]
    pub fn port_allowed(&self, port: u16) -> bool {
        port == 443 || (self.allow_insecure_http && port == 80) || self.extra_ports.contains(&port)
    }

    /// Reject a declared `content-length` above the cap before reading the body.
    pub fn check_declared_length(&self, declared: Option<u64>) -> Result<(), EgressError> {
        match declared {
            Some(length) if length > self.max_response_bytes => {
                Err(EgressError::ResponseTooLarge {
                    limit: self.max_response_bytes,
                })
            }
            _ => Ok(()),
        }
    }

    /// Reject a running total above the cap (`ApiConsumer.readRawText`, `webhooks/egress.ts:143`).
    pub fn check_received(&self, received: u64) -> Result<(), EgressError> {
        if received > self.max_response_bytes {
            Err(EgressError::ResponseTooLarge {
                limit: self.max_response_bytes,
            })
        } else {
            Ok(())
        }
    }

    /// Reject a redirect: the only acceptable answer is the endpoint's own response.
    pub fn check_redirect(&self, status: u16) -> Result<(), EgressError> {
        ensure_not_redirect(status)
    }
}

/// A validated destination with exactly one pinned address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedTarget {
    /// The normalised URL (fragment removed only when policy allowed it).
    pub url: Url,
    /// Lowercased host without brackets or a trailing dot.
    pub host: String,
    pub port: u16,
    /// Every address the name resolved to; all were checked.
    pub addresses: Vec<IpAddr>,
    /// The address to connect to; a second lookup must not happen.
    pub pinned: IpAddr,
    pub secure: bool,
}

impl ResolvedTarget {
    /// The `Host` header value (WHATWG `URL.host`: the default port is omitted).
    #[must_use]
    pub fn host_header(&self) -> String {
        let host = self.url.host_str().unwrap_or(self.host.as_str());
        match self.url.port() {
            Some(port) => format!("{host}:{port}"),
            None => host.to_owned(),
        }
    }

    /// The socket address to connect to for the pinned address.
    #[must_use]
    pub fn pinned_socket_addr(&self) -> SocketAddr {
        SocketAddr::new(self.pinned, self.port)
    }

    /// The TLS server name (never set for an IP literal, like the TS `servername` option).
    #[must_use]
    pub fn tls_server_name(&self) -> Option<&str> {
        if is_ip_literal(&self.host) {
            None
        } else {
            Some(self.host.as_str())
        }
    }
}

/// Validate with the default policy: HTTPS, port 443, exact host allowlist, public addresses.
pub fn validate_target(
    url: &str,
    allowlist: &HostAllowlist,
    resolver: &dyn Resolver,
) -> Result<ResolvedTarget, EgressError> {
    validate_target_with(url, &EgressPolicy::new(allowlist.clone()), resolver)
}

/// Validate with an explicit policy.
pub fn validate_target_with(
    url: &str,
    policy: &EgressPolicy,
    resolver: &dyn Resolver,
) -> Result<ResolvedTarget, EgressError> {
    if url.is_empty() || url.len() > policy.max_url_length {
        return Err(EgressError::InvalidUrl);
    }
    if url
        .chars()
        .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err(EgressError::InvalidUrlCharacters);
    }
    assert_no_encoded_separator(url)?;
    if url.contains('\\') {
        return Err(EgressError::InvalidUrlCharacters);
    }
    assert_no_dot_segments(url)?;

    let parsed = Url::parse(url).map_err(|_| EgressError::MalformedUrl)?;
    let secure = parsed.scheme() == "https";
    if !secure && !(policy.allow_insecure_http && parsed.scheme() == "http") {
        return Err(EgressError::InsecureScheme);
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(EgressError::UrlUserinfo);
    }
    if parsed.fragment().is_some() && !policy.allow_fragments {
        return Err(EgressError::UrlFragment);
    }

    let serialized_host = parsed.host_str().ok_or(EgressError::MalformedUrl)?;
    let host = normalize_host(serialized_host);
    if host.is_empty() {
        return Err(EgressError::MalformedUrl);
    }
    let port = parsed
        .port_or_known_default()
        .ok_or(EgressError::MalformedUrl)?;
    if !policy.port_allowed(port) {
        return Err(EgressError::PortNotAllowed(port));
    }

    policy.allowlist.ensure_configured()?;
    if !policy.allow_private_hosts {
        if is_local_host_name(&host) {
            return Err(EgressError::PrivateHost);
        }
        if is_ip_literal(&host) {
            let address = host
                .parse::<IpAddr>()
                .map_err(|_| EgressError::PrivateHost)?;
            if !is_public_ip(address) {
                return Err(EgressError::PrivateHost);
            }
        }
    }
    let host_with_port = match parsed.port() {
        Some(port) => format!("{serialized_host}:{port}"),
        None => serialized_host.to_owned(),
    };
    if !policy
        .allowlist
        .is_permitted(serialized_host, &host_with_port)
    {
        return Err(EgressError::HostNotAllowed(host_with_port));
    }

    // Resolve exactly once. An IP literal is its own answer and never touches DNS.
    let addresses = if is_ip_literal(&host) {
        vec![host
            .parse::<IpAddr>()
            .map_err(|_| EgressError::MalformedUrl)?]
    } else {
        resolver.resolve(&host)?
    };
    if addresses.is_empty() {
        return Err(EgressError::dns_failure(host));
    }
    if !policy.allow_private_hosts && addresses.iter().any(|address| !is_public_ip(*address)) {
        return Err(EgressError::PrivateHost);
    }
    let pinned = *addresses
        .first()
        .ok_or_else(|| EgressError::dns_failure(host.clone()))?;

    Ok(ResolvedTarget {
        url: parsed,
        host,
        port,
        addresses,
        pinned,
        secure,
    })
}

/// Reject a 3xx answer (`ApiConsumer.ts:559-561`, `webhooks/egress.ts:298`).
pub fn ensure_not_redirect(status: u16) -> Result<(), EgressError> {
    if (300..400).contains(&status) {
        Err(EgressError::RedirectForbidden)
    } else {
        Ok(())
    }
}

/// Hosts compare exactly, so an encoded separator would let a path escape to another endpoint.
///
/// Port of `assertPathIntegrity`'s `%2f|%5c` rule (`compileUrl.ts:141-143`).
fn assert_no_encoded_separator(url: &str) -> Result<(), EgressError> {
    let lower = url.to_ascii_lowercase();
    if lower.contains("%2f") || lower.contains("%5c") {
        return Err(EgressError::InvalidUrlCharacters);
    }
    Ok(())
}

/// `.`/`..` segments are normalised away by the URL parser, so they must be rejected on the raw
/// text first, like `assertPathIntegrity` (`compileUrl.ts:144-150`).
fn assert_no_dot_segments(url: &str) -> Result<(), EgressError> {
    let end = url
        .find('?')
        .unwrap_or(url.len())
        .min(url.find('#').unwrap_or(url.len()));
    let after_scheme = match url[..end].find("://") {
        Some(scheme_end) => scheme_end.saturating_add(3),
        None => 0,
    };
    let path_start = match url[after_scheme..end].find('/') {
        Some(offset) => after_scheme.saturating_add(offset),
        None => end,
    };
    if url[path_start..end]
        .split('/')
        .any(|segment| segment == "." || segment == "..")
    {
        return Err(EgressError::InvalidUrlPath);
    }
    Ok(())
}

fn normalize_allowlist_entry(value: &str) -> String {
    let trimmed = value.trim();
    let without_root = trimmed.strip_suffix('.').unwrap_or(trimmed);
    without_root.to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const PUBLIC_V4: &str = "93.184.216.34";
    const PUBLIC_V6: &str = "2606:2800:220:1:248:1893:25c8:1946";

    fn allowlist() -> HostAllowlist {
        HostAllowlist::new(&["gateway.example", "api.example:8443", "[2606:db8::5]"])
    }

    fn resolver() -> StaticResolver {
        StaticResolver::new()
            .with("gateway.example", &[PUBLIC_V4, PUBLIC_V6])
            .with("api.example", &[PUBLIC_V4])
    }

    fn validate(url: &str) -> Result<ResolvedTarget, EgressError> {
        validate_target(url, &allowlist(), &resolver())
    }

    #[test]
    fn valid_https_target_is_pinned_to_the_first_public_address() {
        let target = validate("https://gateway.example/pay?x=1").expect("target");
        assert_eq!(target.host, "gateway.example");
        assert_eq!(target.port, 443);
        assert!(target.secure);
        assert_eq!(target.addresses.len(), 2);
        assert_eq!(target.pinned, PUBLIC_V4.parse::<IpAddr>().expect("ip"));
        assert_eq!(target.host_header(), "gateway.example");
        assert_eq!(
            target.pinned_socket_addr(),
            format!("{PUBLIC_V4}:443").parse().expect("socket")
        );
        assert_eq!(target.tls_server_name(), Some("gateway.example"));
    }

    #[test]
    fn only_https_and_443_are_allowed_by_default() {
        assert_eq!(
            validate("http://gateway.example/").expect_err("http"),
            EgressError::InsecureScheme
        );
        assert_eq!(
            validate("https://gateway.example:8443/").expect_err("port"),
            EgressError::PortNotAllowed(8443)
        );

        let mut policy = EgressPolicy::new(allowlist());
        policy.allow_insecure_http = true;
        policy.extra_ports.push(8443);
        let resolver = resolver();
        assert!(validate_target_with("http://gateway.example/", &policy, &resolver).is_ok());
        assert!(validate_target_with("https://api.example:8443/hook", &policy, &resolver).is_ok());
        // The extra port is scheme-independent while `allow_insecure_http` is on.
        assert!(validate_target_with("http://gateway.example:8443/", &policy, &resolver).is_ok());
        assert_eq!(
            validate_target_with("http://gateway.example:9443/", &policy, &resolver)
                .expect_err("port not allowed")
                .code(),
            "PORT_NOT_ALLOWED"
        );
    }

    #[test]
    fn rejects_credentials_fragments_and_control_characters() {
        assert_eq!(
            validate("https://user:pass@gateway.example/").expect_err("userinfo"),
            EgressError::UrlUserinfo
        );
        assert_eq!(
            validate("https://gateway.example/#frag").expect_err("fragment"),
            EgressError::UrlFragment
        );
        assert_eq!(
            validate("https://gateway.example/a b").expect_err("space"),
            EgressError::InvalidUrlCharacters
        );
        assert_eq!(
            validate("https://gateway.example/\n").expect_err("newline"),
            EgressError::InvalidUrlCharacters
        );
        let long = format!("https://gateway.example/{}", "a".repeat(2_000));
        assert_eq!(validate(&long).expect_err("long"), EgressError::InvalidUrl);
        assert_eq!(validate("").expect_err("empty"), EgressError::InvalidUrl);
    }

    #[test]
    fn rejects_encoded_separators_backslashes_and_dot_segments() {
        assert_eq!(
            validate("https://gateway.example/a%2Fb").expect_err("encoded slash"),
            EgressError::InvalidUrlCharacters
        );
        assert_eq!(
            validate("https://gateway.example/a%5cb").expect_err("encoded backslash"),
            EgressError::InvalidUrlCharacters
        );
        assert_eq!(
            validate("https://gateway.example/a\\b").expect_err("backslash"),
            EgressError::InvalidUrlCharacters
        );
        assert_eq!(
            validate("https://gateway.example/a/../admin").expect_err("dot segment"),
            EgressError::InvalidUrlPath
        );
        assert_eq!(
            validate("https://gateway.example/./admin").expect_err("dot"),
            EgressError::InvalidUrlPath
        );
        // The query is not a path and may contain dots.
        assert!(validate("https://gateway.example/a?next=../b").is_ok());
    }

    #[test]
    fn an_empty_allowlist_fails_closed() {
        let error = validate_target(
            "https://gateway.example/",
            &HostAllowlist::new(&[]),
            &resolver(),
        )
        .expect_err("empty allowlist");
        assert_eq!(error, EgressError::HostAllowlistEmpty);
        assert_eq!(error.code(), "HOST_ALLOWLIST_EMPTY");

        let any = HostAllowlist::new(&[]).with_allow_any();
        assert!(
            validate_target("https://gateway.example/", &any, &resolver()).is_ok(),
            "explicit allowAnyHost permits a host outside the list"
        );
    }

    #[test]
    fn the_host_must_be_on_the_allowlist_case_insensitively() {
        let resolver = resolver();
        assert!(validate_target(
            "https://GATEWAY.example./",
            &HostAllowlist::new(&["gateway.example"]),
            &resolver
        )
        .is_ok());
        let error = validate_target(
            "https://other.example/",
            &HostAllowlist::new(&["gateway.example"]),
            &resolver,
        )
        .expect_err("not allowed");
        assert_eq!(error.code(), "HOST_NOT_ALLOWED");

        // A non-default port is matched through the `host:port` form.
        let port_list = HostAllowlist::new(&["api.example:8443"]);
        let mut policy = EgressPolicy::new(port_list);
        policy.extra_ports.push(8443);
        assert!(validate_target_with("https://api.example:8443/x", &policy, &resolver).is_ok());
    }

    #[test]
    fn private_and_local_literals_are_rejected_before_resolution() {
        let list = HostAllowlist::new(&["localhost", "127.0.0.1", "10.0.0.5", "[::1]"]);
        let resolver = StaticResolver::new();
        for url in [
            "https://localhost/",
            "https://127.0.0.1/",
            "https://10.0.0.5/",
            "https://[::1]/",
        ] {
            assert_eq!(
                validate_target(url, &list, &resolver).expect_err(url),
                EgressError::PrivateHost,
                "{url}"
            );
        }
        assert!(validate_target(
            "https://169.254.169.254/",
            &HostAllowlist::new(&["169.254.169.254"]),
            &resolver
        )
        .is_err());
    }

    #[test]
    fn a_name_resolving_to_a_private_address_is_rejected() {
        let resolver = StaticResolver::new().with("gateway.example", &[PUBLIC_V4, "10.0.0.5"]);
        assert_eq!(
            validate_target("https://gateway.example/", &allowlist(), &resolver)
                .expect_err("private answer"),
            EgressError::PrivateHost
        );
    }

    #[test]
    fn an_empty_or_failed_resolution_is_a_retryable_dns_failure() {
        let empty = StaticResolver::new().with("gateway.example", &[]);
        let error = validate_target("https://gateway.example/", &allowlist(), &empty)
            .expect_err("empty answer");
        assert_eq!(error.code(), "DNS_FAILURE");
        assert!(error.retryable());

        let missing = StaticResolver::new();
        assert_eq!(
            validate_target("https://gateway.example/", &allowlist(), &missing)
                .expect_err("no answer")
                .code(),
            "DNS_FAILURE"
        );
    }

    #[test]
    fn the_scoped_private_relaxation_requires_the_allowlist_too() {
        let resolver = StaticResolver::new().with("fake-rails.local", &["127.0.0.1"]);
        let policy =
            EgressPolicy::new(HostAllowlist::new(&["fake-rails.local"])).with_private_hosts();
        let target = validate_target_with("http://fake-rails.local:4003/hook", &policy, &resolver)
            .expect_err("http is still refused without allow_insecure_http");
        assert_eq!(target, EgressError::InsecureScheme);

        let mut policy = policy;
        policy.allow_insecure_http = true;
        policy.extra_ports.push(4003);
        let target = validate_target_with("http://fake-rails.local:4003/hook", &policy, &resolver)
            .expect("private host allowed");
        assert_eq!(target.pinned, "127.0.0.1".parse::<IpAddr>().expect("ip"));

        let other = EgressPolicy::new(HostAllowlist::new(&["other.local"])).with_private_hosts();
        assert_eq!(
            validate_target_with("http://fake-rails.local:4003/hook", &other, &resolver)
                .expect_err("not on the allowlist"),
            EgressError::InsecureScheme,
            "the scheme is checked before the allowlist"
        );
    }

    #[test]
    fn ipv6_literals_keep_brackets_and_skip_dns() {
        let list = HostAllowlist::new(&["[2606:db8::5]"]);
        let target = validate_target("https://[2606:db8::5]/hook", &list, &StaticResolver::new())
            .expect("literal");
        assert_eq!(target.host, "2606:db8::5");
        assert_eq!(target.host_header(), "[2606:db8::5]");
        assert_eq!(target.tls_server_name(), None);
        assert_eq!(
            target.pinned,
            "2606:db8::5".parse::<IpAddr>().expect("address")
        );
    }

    #[test]
    fn dns_is_asked_once_per_validation() {
        struct CountingResolver {
            inner: StaticResolver,
            calls: AtomicUsize,
        }
        impl Resolver for CountingResolver {
            fn resolve(&self, host: &str) -> Result<Vec<IpAddr>, EgressError> {
                self.calls.fetch_add(1, Ordering::SeqCst);
                self.inner.resolve(host)
            }
        }
        let resolver = CountingResolver {
            inner: resolver(),
            calls: AtomicUsize::new(0),
        };
        let _ =
            validate_target("https://gateway.example/", &allowlist(), &resolver).expect("target");
        assert_eq!(resolver.calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn response_caps_and_redirects() {
        let policy = EgressPolicy::webhook(HostAllowlist::new(&["gateway.example"]), false);
        assert_eq!(policy.max_response_bytes, 4 * 1024);
        assert!(policy.check_declared_length(Some(4 * 1024)).is_ok());
        assert_eq!(
            policy
                .check_declared_length(Some(4 * 1024 + 1))
                .expect_err("declared")
                .code(),
            "RESPONSE_TOO_LARGE"
        );
        assert!(policy.check_received(10).is_ok());
        assert!(policy.check_received(4 * 1024 + 1).is_err());

        assert!(ensure_not_redirect(200).is_ok());
        assert!(ensure_not_redirect(299).is_ok());
        assert_eq!(
            ensure_not_redirect(301).expect_err("redirect"),
            EgressError::RedirectForbidden
        );
        assert_eq!(
            ensure_not_redirect(308).expect_err("redirect").code(),
            "REDIRECT_FORBIDDEN"
        );
    }
}

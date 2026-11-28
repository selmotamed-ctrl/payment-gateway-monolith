//! Trusted-proxy aware client IP resolution.
//!
//! Port of `{admin,merchant,checkout}-back/lib/net/index.ts` (`parseCidr*`, `normalizeIp`,
//! `resolveClientIp`).
//!
//! Forwarded headers are honoured only when the immediate peer is inside `TRUSTED_PROXY_CIDRS`
//! (loopback by default). The shipped nginx sets `X-Real-IP` to `$remote_addr`, so `x-real-ip` is
//! authoritative behind a trusted proxy; `x-real-client-ip` is only the fallback. A forwarded
//! value must be a single valid IP address, otherwise it is ignored and the peer address wins.
//! The edge always overwrites `x-real-client-ip` towards core with the resolved value.

#![forbid(unsafe_code)]

use std::net::{IpAddr, Ipv4Addr};

use http::HeaderMap;
use ipnet::IpNet;

/// Default `TRUSTED_PROXY_CIDRS` in every edge.
pub const TRUSTED_PROXY_DEFAULT: &str = "127.0.0.0/8,::1/128";
pub const X_REAL_IP: &str = "x-real-ip";
pub const X_REAL_CLIENT_IP: &str = "x-real-client-ip";

/// Parse one CIDR entry; a bare address becomes `/32` or `/128` like the TypeScript parser.
#[must_use]
pub fn parse_cidr(raw: &str) -> Option<IpNet> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    if raw.contains('/') {
        return raw.parse::<IpNet>().ok();
    }
    let address = parse_ip(raw)?;
    let prefix = if address.is_ipv4() { 32 } else { 128 };
    IpNet::new(address, prefix).ok()
}

/// Parse a comma separated list, dropping blank and malformed entries.
#[must_use]
pub fn parse_cidr_list(raw: Option<&str>) -> Vec<IpNet> {
    raw.unwrap_or_default()
        .split(',')
        .filter_map(parse_cidr)
        .collect()
}

/// Parse a single address like `normalizeIp`: trim, strip one `::ffff:` mapping and brackets.
#[must_use]
pub fn parse_ip(raw: &str) -> Option<IpAddr> {
    let mut value = raw.trim();
    if value.starts_with('[') && value.ends_with(']') {
        value = &value[1..value.len() - 1];
    }
    if let Some(mapped) = value.strip_prefix("::ffff:") {
        if let Ok(address) = mapped.parse::<Ipv4Addr>() {
            return Some(IpAddr::V4(address));
        }
    }
    let address = value.parse::<IpAddr>().ok()?;
    // `::ffff:1.2.3.4` is the IPv4 address 1.2.3.4 for every consumer (rate limits, allowlists).
    Some(match address {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(IpAddr::V6(v6), IpAddr::V4),
        IpAddr::V4(_) => address,
    })
}

#[must_use]
pub fn is_trusted_proxy(trusted: &[IpNet], peer: IpAddr) -> bool {
    trusted.iter().any(|network| network.contains(&peer))
}

/// Resolve the client address of a proxied request.
///
/// Port of `resolveClientIp(req, trustedProxyCidrs)`.
#[must_use]
pub fn resolve_client_ip(
    peer: IpAddr,
    trusted: &[IpNet],
    x_real_ip: Option<&str>,
    x_real_client_ip: Option<&str>,
) -> IpAddr {
    if !is_trusted_proxy(trusted, peer) {
        return peer;
    }
    x_real_ip
        .and_then(parse_ip)
        .or_else(|| x_real_client_ip.and_then(parse_ip))
        .unwrap_or(peer)
}

/// Header-map convenience: only the first value of each header is inspected, like Express.
#[must_use]
pub fn resolve_client_ip_from_headers(
    peer: IpAddr,
    trusted: &[IpNet],
    headers: &HeaderMap,
) -> IpAddr {
    let real = headers.get(X_REAL_IP).and_then(|value| value.to_str().ok());
    let client = headers
        .get(X_REAL_CLIENT_IP)
        .and_then(|value| value.to_str().ok());
    resolve_client_ip(peer, trusted, real, client)
}

/// Port of `digestKeyPart` (`lib/clientIp/index.ts`): SHA-256 hex truncated to 32 characters, a
/// stable non-reversible key part for limiters keyed on a secret or an identifier.
#[must_use]
pub fn digest_key_part(value: &str) -> String {
    use sha2::{Digest, Sha256};
    use std::fmt::Write as _;

    let digest = Sha256::digest(value.as_bytes());
    let mut output = String::with_capacity(32);
    for byte in digest.iter().take(16) {
        let _ = write!(output, "{byte:02x}");
    }
    output
}

/// `normalizeIp` for display and for `x-real-client-ip` towards core.
#[must_use]
pub fn normalize_ip_string(raw: &str) -> String {
    parse_ip(raw).map_or_else(String::new, |address| address.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use http::HeaderValue;

    fn loopback_trust() -> Vec<IpNet> {
        parse_cidr_list(Some(TRUSTED_PROXY_DEFAULT))
    }

    fn ip(raw: &str) -> IpAddr {
        parse_ip(raw).expect("valid ip")
    }

    #[test]
    fn default_list_contains_loopback() {
        let trusted = loopback_trust();
        assert_eq!(trusted.len(), 2);
        assert!(is_trusted_proxy(&trusted, ip("127.0.0.1")));
        assert!(is_trusted_proxy(&trusted, ip("127.9.9.9")));
        assert!(is_trusted_proxy(&trusted, ip("::1")));
        assert!(!is_trusted_proxy(&trusted, ip("10.1.2.3")));
    }

    #[test]
    fn trusted_peer_honours_x_real_ip_first() {
        let resolved = resolve_client_ip(
            ip("127.0.0.1"),
            &loopback_trust(),
            Some("203.0.113.9"),
            Some("198.51.100.4"),
        );
        assert_eq!(resolved, ip("203.0.113.9"));
    }

    #[test]
    fn trusted_peer_falls_back_to_x_real_client_ip() {
        let resolved = resolve_client_ip(
            ip("127.0.0.1"),
            &loopback_trust(),
            None,
            Some("198.51.100.4"),
        );
        assert_eq!(resolved, ip("198.51.100.4"));
        let none = resolve_client_ip(ip("127.0.0.1"), &loopback_trust(), None, None);
        assert_eq!(none, ip("127.0.0.1"));
    }

    #[test]
    fn untrusted_peer_ignores_spoofed_headers() {
        let resolved = resolve_client_ip(
            ip("203.0.113.50"),
            &loopback_trust(),
            Some("10.0.0.1"),
            Some("10.0.0.2"),
        );
        assert_eq!(resolved, ip("203.0.113.50"));
    }

    #[test]
    fn invalid_forwarded_values_are_ignored() {
        let resolved = resolve_client_ip(
            ip("127.0.0.1"),
            &loopback_trust(),
            Some("not-an-ip"),
            Some("198.51.100.4"),
        );
        assert_eq!(resolved, ip("198.51.100.4"));

        let list = resolve_client_ip(
            ip("127.0.0.1"),
            &loopback_trust(),
            Some("1.2.3.4, 5.6.7.8"),
            None,
        );
        assert_eq!(list, ip("127.0.0.1"));
    }

    #[test]
    fn mapped_and_bracketed_addresses_normalise() {
        assert_eq!(parse_ip("::ffff:192.0.2.5"), Some(ip("192.0.2.5")));
        assert_eq!(parse_ip("[::1]"), Some(ip("::1")));
        assert_eq!(normalize_ip_string(" ::ffff:192.0.2.5 "), "192.0.2.5");
        assert_eq!(normalize_ip_string("nope"), "");
    }

    #[test]
    fn cidr_parsing_defaults_and_rejects() {
        assert_eq!(
            parse_cidr("10.0.0.0/8"),
            Some("10.0.0.0/8".parse().expect("cidr"))
        );
        assert_eq!(
            parse_cidr("10.1.2.3"),
            Some("10.1.2.3/32".parse().expect("cidr"))
        );
        assert_eq!(
            parse_cidr("fd00::1"),
            Some("fd00::1/128".parse().expect("cidr"))
        );
        assert_eq!(parse_cidr("10.0.0.0/33"), None);
        assert_eq!(parse_cidr("not a cidr"), None);
        assert_eq!(parse_cidr("  "), None);
        assert_eq!(parse_cidr_list(Some(" 10.0.0.0/8 ,, x ")).len(), 1);
    }

    #[test]
    fn header_map_resolution() {
        let mut headers = HeaderMap::new();
        headers.insert(X_REAL_IP, HeaderValue::from_static("203.0.113.9"));
        assert_eq!(
            resolve_client_ip_from_headers(ip("127.0.0.1"), &loopback_trust(), &headers),
            ip("203.0.113.9")
        );

        let mut spoofed = HeaderMap::new();
        spoofed.insert(X_REAL_IP, HeaderValue::from_static("203.0.113.9"));
        assert_eq!(
            resolve_client_ip_from_headers(ip("198.51.100.1"), &loopback_trust(), &spoofed),
            ip("198.51.100.1")
        );
    }

    #[test]
    fn digest_key_part_is_a_short_sha256_prefix() {
        // sha256("abc") = ba7816bf8f01cfea414140de5dae2223...
        assert_eq!(digest_key_part("abc"), "ba7816bf8f01cfea414140de5dae2223");
        assert_eq!(digest_key_part("abc"), digest_key_part("abc"));
        assert_eq!(digest_key_part("abc").len(), 32);
        assert_ne!(digest_key_part("abc"), digest_key_part("abd"));
    }
}

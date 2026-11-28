//! Public-address and local-host rules for outbound destinations.
//!
//! Port of `isPublicIpAddress` in `core-back/engine/apiConsumer/ApiConsumer.ts:196-283` and
//! `isPrivateHostLiteral` in `core-back/engine/apiConsumer/compileUrl.ts:41-75`.
//!
//! The address check is conservative: an address that cannot be parsed, or that is wrapped in an
//! IPv4-in-IPv6 translation range (mapped, compatible, NAT64, 6to4, Teredo), is not public. The
//! range tables are the TS constants; `ipnet` performs the containment test.

#![forbid(unsafe_code)]

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::OnceLock;

use ipnet::{Ipv4Net, Ipv6Net};

/// `BLOCKED_IPV4_RANGES` (`ApiConsumer.ts:214-229`).
const BLOCKED_IPV4_RANGES: [&str; 14] = [
    "0.0.0.0/8",
    "10.0.0.0/8",
    "100.64.0.0/10",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.0.0.0/24",
    "192.0.2.0/24",
    "192.168.0.0/16",
    "198.18.0.0/15",
    "198.51.100.0/24",
    "203.0.113.0/24",
    "224.0.0.0/4",
    "240.0.0.0/4",
];

/// `BLOCKED_IPV6_RANGES` (`ApiConsumer.ts:200-212`).
const BLOCKED_IPV6_RANGES: [&str; 11] = [
    "::/128",
    "::1/128",
    "::ffff:0:0/96",
    "64:ff9b::/96",
    "100::/64",
    "2001::/32",
    "2002::/16",
    "fc00::/7",
    "fe80::/10",
    "ff00::/8",
    "2001:db8::/32",
];

fn blocked_ipv4() -> &'static Vec<Ipv4Net> {
    static RANGES: OnceLock<Vec<Ipv4Net>> = OnceLock::new();
    RANGES.get_or_init(|| {
        BLOCKED_IPV4_RANGES
            .iter()
            .filter_map(|range| range.parse::<Ipv4Net>().ok())
            .collect()
    })
}

fn blocked_ipv6() -> &'static Vec<Ipv6Net> {
    static RANGES: OnceLock<Vec<Ipv6Net>> = OnceLock::new();
    RANGES.get_or_init(|| {
        BLOCKED_IPV6_RANGES
            .iter()
            .filter_map(|range| range.parse::<Ipv6Net>().ok())
            .collect()
    })
}

/// Whether an address may be used as an outbound destination.
///
/// Port of `isPublicIpAddress` (`ApiConsumer.ts:238-283`). IPv4-mapped (`::ffff:a.b.c.d`) and the
/// deprecated IPv4-compatible (`::a.b.c.d`) forms are unwrapped first so the IPv4 rules apply to
/// the embedded address, which is what blocks `::ffff:127.0.0.1`.
#[must_use]
pub fn is_public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => is_public_ipv4(address),
        IpAddr::V6(address) => is_public_ipv6(address),
    }
}

fn is_public_ipv4(address: Ipv4Addr) -> bool {
    !blocked_ipv4()
        .iter()
        .any(|network| network.contains(&address))
}

fn is_public_ipv6(address: Ipv6Addr) -> bool {
    if let Some(mapped) = address.to_ipv4_mapped() {
        return is_public_ipv4(mapped);
    }
    let octets = address.octets();
    if octets
        .get(..12)
        .is_some_and(|prefix| prefix.iter().all(|byte| *byte == 0))
    {
        let embedded = Ipv4Addr::new(
            octets.get(12).copied().unwrap_or(0),
            octets.get(13).copied().unwrap_or(0),
            octets.get(14).copied().unwrap_or(0),
            octets.get(15).copied().unwrap_or(0),
        );
        return is_public_ipv4(embedded);
    }
    !blocked_ipv6()
        .iter()
        .any(|network| network.contains(&address))
}

/// Lowercase a host and strip IPv6 brackets and one trailing root dot.
///
/// Port of the `host.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "")` chain in
/// `ApiConsumer.ts:924` / `compileUrl.ts:55`.
#[must_use]
pub fn normalize_host(raw: &str) -> String {
    let trimmed = raw.trim();
    let without_open = trimmed.strip_prefix('[').unwrap_or(trimmed);
    let without_brackets = without_open.strip_suffix(']').unwrap_or(without_open);
    let without_root = without_brackets
        .strip_suffix('.')
        .unwrap_or(without_brackets);
    without_root.to_ascii_lowercase()
}

/// Local-only names: `localhost`, `*.localhost`, `*.local`, `*.internal`.
///
/// Port of `isPrivateHostLiteral`'s name branch (`compileUrl.ts:43-46`) and
/// `validateWebhookUrl` (`webhooks/egress.ts:42`).
#[must_use]
pub fn is_local_host_name(raw: &str) -> bool {
    let host = normalize_host(raw);
    host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
}

/// Whether a normalised host is an IP literal.
#[must_use]
pub fn is_ip_literal(host: &str) -> bool {
    host.parse::<IpAddr>().is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn public(address: &str) -> bool {
        address
            .parse::<IpAddr>()
            .map(is_public_ip)
            .expect("test address")
    }

    #[test]
    fn public_addresses_are_accepted() {
        for address in [
            "93.184.216.34",
            "8.8.8.8",
            "1.1.1.1",
            "203.0.114.1",
            "2606:2800:220:1:248:1893:25c8:1946",
            "2001:4860:4860::8888",
        ] {
            assert!(public(address), "{address}");
        }
    }

    #[test]
    fn every_blocked_ipv4_range_is_rejected() {
        for address in [
            "0.0.0.0",
            "0.1.2.3",
            "10.0.0.1",
            "10.255.255.255",
            "100.64.0.1",
            "100.127.255.255",
            "127.0.0.1",
            "127.10.20.30",
            "169.254.169.254",
            "172.16.0.1",
            "172.31.255.255",
            "192.0.0.1",
            "192.0.2.1",
            "192.168.1.1",
            "198.18.0.1",
            "198.19.255.255",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "239.255.255.255",
            "240.0.0.1",
            "255.255.255.255",
        ] {
            assert!(!public(address), "{address}");
        }
    }

    #[test]
    fn boundary_addresses_outside_the_ranges_are_public() {
        for address in [
            "11.0.0.0",
            "100.63.255.255",
            "100.128.0.0",
            "172.15.255.255",
            "172.32.0.0",
            "192.167.255.255",
            "192.169.0.0",
            "198.17.255.255",
            "198.20.0.0",
            "223.255.255.255",
            "11.1.1.1",
        ] {
            assert!(public(address), "{address}");
        }
        assert!(!public("10.255.255.255"));
    }

    #[test]
    fn every_blocked_ipv6_range_is_rejected() {
        for address in [
            "::",
            "::1",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "64:ff9b::7f00:1",
            "100::1",
            "2001::1",
            "2002:7f00:1::",
            "fc00::1",
            "fd12:3456::1",
            "fe80::1",
            "febf::1",
            "ff02::1",
            "2001:db8::1",
        ] {
            assert!(!public(address), "{address}");
        }
    }

    #[test]
    fn ipv4_mapped_and_compatible_forms_use_the_ipv4_rules() {
        assert!(public("::ffff:93.184.216.34"));
        assert!(public("::93.184.216.34"));
        assert!(!public("::ffff:192.168.1.1"));
        assert!(!public("::192.168.1.1"));
    }

    #[test]
    fn local_names_are_recognised_after_normalisation() {
        for host in [
            "localhost",
            "LOCALHOST",
            "api.localhost",
            "printer.local",
            "service.internal",
            "[localhost]",
            "localhost.",
        ] {
            assert!(is_local_host_name(host), "{host}");
        }
        for host in ["example.com", "notlocalhost.com", "local.example.com"] {
            assert!(!is_local_host_name(host), "{host}");
        }
    }

    #[test]
    fn hosts_normalise_brackets_case_and_root_dot() {
        assert_eq!(normalize_host("  Example.COM. "), "example.com");
        assert_eq!(normalize_host("[::1]"), "::1");
        assert_eq!(normalize_host("2001:DB8::1"), "2001:db8::1");
        assert_eq!(normalize_host(""), "");
    }

    #[test]
    fn ip_literals_are_detected() {
        assert!(is_ip_literal("93.184.216.34"));
        assert!(is_ip_literal("2001:db8::1"));
        assert!(!is_ip_literal("example.com"));
        assert!(!is_ip_literal(""));
    }
}

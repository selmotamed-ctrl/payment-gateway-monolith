//! Rate-limit catalogue (chapter 2 §9).
//!
//! Values copied from the TS edges' `express-rate-limit` configuration. Key derivation matches
//! the edges: client IP, token hash or account identifier depending on the route class.

#![forbid(unsafe_code)]

use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RateKey {
    Ip,
    TokenHash,
    Account,
    IpAndAccount,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RatePolicy {
    pub name: &'static str,
    pub window: Duration,
    pub max: u64,
    pub key: RateKey,
}

pub const ADMIN_AUTH: RatePolicy = RatePolicy {
    name: "admin-auth",
    window: Duration::from_secs(15 * 60),
    max: 10,
    key: RateKey::Ip,
};
pub const ADMIN_API: RatePolicy = RatePolicy {
    name: "admin-api",
    window: Duration::from_secs(60),
    max: 600,
    key: RateKey::Ip,
};
pub const ADMIN_SEARCH: RatePolicy = RatePolicy {
    name: "admin-search",
    window: Duration::from_secs(60),
    max: 120,
    key: RateKey::TokenHash,
};
pub const ADMIN_ACADEMY: RatePolicy = RatePolicy {
    name: "admin-academy",
    window: Duration::from_secs(60),
    max: 60,
    key: RateKey::Ip,
};
pub const ADMIN_UPLOAD: RatePolicy = RatePolicy {
    name: "admin-upload",
    window: Duration::from_secs(60),
    max: 20,
    key: RateKey::Ip,
};
pub const ADMIN_BACKUP_JOBS: RatePolicy = RatePolicy {
    name: "admin-backup-jobs",
    window: Duration::from_secs(10 * 60),
    max: 6,
    key: RateKey::Ip,
};

pub const MERCHANT_AUTH: RatePolicy = RatePolicy {
    name: "merchant-auth",
    window: Duration::from_secs(15 * 60),
    max: 20,
    key: RateKey::Ip,
};
pub const MERCHANT_API: RatePolicy = RatePolicy {
    name: "merchant-api",
    window: Duration::from_secs(60),
    max: 300,
    key: RateKey::Ip,
};
pub const MERCHANT_EXTERNAL: RatePolicy = RatePolicy {
    name: "merchant-external",
    window: Duration::from_secs(60),
    max: 120,
    key: RateKey::Ip,
};
pub const MERCHANT_UPLOAD: RatePolicy = RatePolicy {
    name: "merchant-upload",
    window: Duration::from_secs(60),
    max: 10,
    key: RateKey::Ip,
};

pub const CHECKOUT_PAY: RatePolicy = RatePolicy {
    name: "checkout-pay",
    window: Duration::from_secs(60),
    max: 120,
    key: RateKey::Ip,
};
pub const CHECKOUT_INBOUND: RatePolicy = RatePolicy {
    name: "checkout-inbound",
    window: Duration::from_secs(60),
    max: 600,
    key: RateKey::Ip,
};
pub const CORE_PUBLIC: RatePolicy = RatePolicy {
    name: "core-public",
    window: Duration::from_secs(60 * 60),
    max: 15,
    key: RateKey::Ip,
};

/// Auth failure counts (not request rates): pair 5, identifier 50, IP 30, MFA 20 per 15 min.
pub const AUTH_LOGIN_PAIR_MAX: u64 = 5;
pub const AUTH_LOGIN_ID_MAX: u64 = 50;
pub const AUTH_LOGIN_IP_MAX: u64 = 30;
pub const AUTH_MFA_IP_MAX: u64 = 20;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalogue_matches_the_contract() {
        assert_eq!(ADMIN_AUTH.max, 10);
        assert_eq!(MERCHANT_API.max, 300);
        assert_eq!(CHECKOUT_PAY.max, 120);
        assert_eq!(CORE_PUBLIC.window, Duration::from_secs(3600));
        assert_eq!(ADMIN_SEARCH.key, RateKey::TokenHash);
    }
}

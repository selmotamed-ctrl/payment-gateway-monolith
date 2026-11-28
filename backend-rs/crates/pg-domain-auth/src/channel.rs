//! Session channels and JWT audiences.
//!
//! Port of `core-back/lib/auth/index.ts:6-19` (`SESSION_ISSUER`, `SessionChannel`,
//! `SESSION_AUDIENCES`, `ALL_SESSION_AUDIENCES`, `SESSION_TTL_SECONDS`) and the channel guards in
//! `core-back/api/middleware/authDoubleCheck.ts:399-428`.
//!
//! Every channel has its own audience (GAP-020): a token minted for one edge is refused by the
//! others, and core only accepts the three channel audiences. The `payment-gateway-edge` audience
//! that older builds used is no longer valid.
//!
//! The Sandbox execution plane has **no audience of its own**: it accepts the sessions minted for
//! the admin and merchant channels and mirrors the principal into its own database
//! (`authDoubleCheck.ts:159-290`, chapter 2 §5).

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};

use crate::error::AuthError;

/// `iss` of every session token.
pub const SESSION_ISSUER: &str = "payment-gateway-core";

/// `exp = iat + 12 * 60 * 60` (`SESSION_TTL_SECONDS`).
pub const SESSION_TTL_SECONDS: i64 = 43_200;

/// The admin audience (`payment-gateway-admin`).
pub const ADMIN_AUDIENCE: &str = "payment-gateway-admin";
/// The merchant audience (`payment-gateway-merchant`).
pub const MERCHANT_AUDIENCE: &str = "payment-gateway-merchant";
/// The checkout audience (`payment-gateway-checkout`).
pub const CHECKOUT_AUDIENCE: &str = "payment-gateway-checkout";

/// All three audiences core accepts when no channel is pinned.
pub const ALL_AUDIENCES: [&str; 3] = [ADMIN_AUDIENCE, MERCHANT_AUDIENCE, CHECKOUT_AUDIENCE];

/// The edge/channel a session was minted for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    Admin,
    Merchant,
    Checkout,
    /// The parallel Sandbox execution plane (v38). Accepts admin and merchant audiences.
    Sandbox,
}

impl Channel {
    /// Every channel, in the order the TS object literal declares them.
    pub const ALL: [Self; 4] = [Self::Admin, Self::Merchant, Self::Checkout, Self::Sandbox];

    /// `admin|merchant|checkout|sandbox`.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Admin => "admin",
            Self::Merchant => "merchant",
            Self::Checkout => "checkout",
            Self::Sandbox => "sandbox",
        }
    }

    /// Parse the lower-case channel name. Case sensitive, like the TS string union.
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        Some(match raw {
            "admin" => Self::Admin,
            "merchant" => Self::Merchant,
            "checkout" => Self::Checkout,
            "sandbox" => Self::Sandbox,
            _ => return None,
        })
    }

    /// The JWT audience this channel mints. `None` for [`Channel::Sandbox`], which mints nothing
    /// and accepts `Admin`/`Merchant` tokens.
    #[must_use]
    pub fn audience(self) -> Option<&'static str> {
        match self {
            Self::Admin => Some(ADMIN_AUDIENCE),
            Self::Merchant => Some(MERCHANT_AUDIENCE),
            Self::Checkout => Some(CHECKOUT_AUDIENCE),
            Self::Sandbox => None,
        }
    }

    /// The channel a session audience was minted for (`authDoubleCheck.ts:334`).
    #[must_use]
    pub fn from_audience(audience: &str) -> Option<Self> {
        match audience {
            ADMIN_AUDIENCE => Some(Self::Admin),
            MERCHANT_AUDIENCE => Some(Self::Merchant),
            CHECKOUT_AUDIENCE => Some(Self::Checkout),
            _ => None,
        }
    }

    /// True when a token with this audience may be used on this channel. This is the
    /// channel↔audience rule: Sandbox accepts the admin and merchant audiences only.
    #[must_use]
    pub fn accepts_audience(self, audience: &str) -> bool {
        match self {
            Self::Admin => audience == ADMIN_AUDIENCE,
            Self::Merchant => audience == MERCHANT_AUDIENCE,
            Self::Checkout => audience == CHECKOUT_AUDIENCE,
            Self::Sandbox => matches!(audience, ADMIN_AUDIENCE | MERCHANT_AUDIENCE),
        }
    }

    /// The error a channel guard throws when the token audience is not this channel's
    /// (`authDoubleCheck.ts:405-407,421-423`).
    #[must_use]
    pub fn audience_error(self) -> AuthError {
        let message = match self {
            Self::Admin => "The session token was not issued for the admin channel",
            Self::Merchant => "The session token was not issued for the merchant channel",
            Self::Checkout => "The session token was not issued for the checkout channel",
            Self::Sandbox => "The session token was not issued for the sandbox plane",
        };
        AuthError::session_audience_invalid(message)
    }

    /// True for the two channels that mint sessions (Sandbox mints none).
    #[must_use]
    pub fn mints_sessions(self) -> bool {
        self.audience().is_some()
    }
}

/// A validated session audience (`payment-gateway-admin|merchant|checkout`).
///
/// Only `Serialize` is derived: the value is a `&'static str` from a closed set, so deserialization
/// goes through [`Audience::parse`] (which refuses the retired `payment-gateway-edge`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct Audience(&'static str);

impl Audience {
    /// `payment-gateway-admin`.
    pub const ADMIN: Self = Self(ADMIN_AUDIENCE);
    /// `payment-gateway-merchant`.
    pub const MERCHANT: Self = Self(MERCHANT_AUDIENCE);
    /// `payment-gateway-checkout`.
    pub const CHECKOUT: Self = Self(CHECKOUT_AUDIENCE);

    /// All three, in TS declaration order.
    pub const ALL: [Self; 3] = [Self::ADMIN, Self::MERCHANT, Self::CHECKOUT];

    /// Parse one of the three accepted audiences; anything else (including the retired
    /// `payment-gateway-edge`) is rejected.
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            ADMIN_AUDIENCE => Some(Self::ADMIN),
            MERCHANT_AUDIENCE => Some(Self::MERCHANT),
            CHECKOUT_AUDIENCE => Some(Self::CHECKOUT),
            _ => None,
        }
    }

    /// The audience string as it appears in the JWT.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        self.0
    }

    /// The channel this audience belongs to.
    #[must_use]
    pub fn channel(self) -> Channel {
        match self.0 {
            ADMIN_AUDIENCE => Channel::Admin,
            MERCHANT_AUDIENCE => Channel::Merchant,
            _ => Channel::Checkout,
        }
    }
}

impl std::fmt::Display for Audience {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audiences_match_the_ts_table() {
        assert_eq!(Channel::Admin.audience(), Some("payment-gateway-admin"));
        assert_eq!(
            Channel::Merchant.audience(),
            Some("payment-gateway-merchant")
        );
        assert_eq!(
            Channel::Checkout.audience(),
            Some("payment-gateway-checkout")
        );
        assert_eq!(Channel::Sandbox.audience(), None);
    }

    #[test]
    fn audience_and_channel_round_trip() {
        for audience in Audience::ALL {
            let channel = audience.channel();
            assert_eq!(channel.audience(), Some(audience.as_str()));
            assert_eq!(Channel::from_audience(audience.as_str()), Some(channel));
            assert!(channel.accepts_audience(audience.as_str()));
        }
    }

    #[test]
    fn retired_edge_audience_is_refused() {
        assert!(Audience::parse("payment-gateway-edge").is_none());
        assert_eq!(Channel::from_audience("payment-gateway-edge"), None);
        for channel in Channel::ALL {
            assert!(!channel.accepts_audience("payment-gateway-edge"));
        }
    }

    #[test]
    fn sandbox_accepts_admin_and_merchant_only() {
        assert!(Channel::Sandbox.accepts_audience(ADMIN_AUDIENCE));
        assert!(Channel::Sandbox.accepts_audience(MERCHANT_AUDIENCE));
        assert!(!Channel::Sandbox.accepts_audience(CHECKOUT_AUDIENCE));
        assert!(!Channel::Sandbox.mints_sessions());
    }

    #[test]
    fn cross_channel_audience_is_refused() {
        assert!(!Channel::Admin.accepts_audience(MERCHANT_AUDIENCE));
        assert_eq!(
            Channel::Merchant.audience_error().code,
            "SESSION_AUDIENCE_INVALID"
        );
    }

    #[test]
    fn channel_names_round_trip() {
        for channel in Channel::ALL {
            assert_eq!(Channel::parse(channel.as_str()), Some(channel));
        }
        assert_eq!(Channel::parse("Admin"), None);
    }
}

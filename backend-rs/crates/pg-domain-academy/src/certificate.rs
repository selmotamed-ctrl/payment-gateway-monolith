//! Academy certificate identity and public verification state.
//!
//! Port of `core-back/engine/academy/certificate.ts` and the public verification route
//! `core-back/api/internal/checkout.ts:57-101`:
//!
//! - `publicId` = base64url of 24 random bytes (32 characters, no padding);
//! - `displayId` = `PG-AC-` + 8 upper-case hex characters (4 random bytes);
//! - the stored statuses are `ACTIVE`, `SUPERSEDED`, `REVOKED` (`AcademyCertificateStatus`);
//! - `verify` answers `valid` only for an `ACTIVE` certificate of an `ACTIVE` holder whose badge
//!   has not expired (`expiresAt > now`, strict, exactly `isBadgeValid`);
//! - issuance sets `expiresAt = addMonthsUtc(earnedAt, 12)` and supersedes the holder's previous
//!   `ACTIVE` certificate for the track in the same transaction.
//!
//! `EXPIRED` is a verification state, not a stored status: the schema has no such enum value. This
//! crate exposes it in [`CertificateStatus`] and [`VerificationState`] because the port brief asks
//! for it and the admin/certificate UI already renders an expired issuance;
//! [`verification_state`] treats a stored [`CertificateStatus::Expired`] as expired.
//!
//! Generation is separate: the caller supplies random bytes (`rand` is not a dependency), so the
//! identity functions are deterministic encoders/validators.

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};

use crate::time::UtcMillis;

/// `randomBytes(24)` for `publicId`.
pub const PUBLIC_ID_BYTES: usize = 24;
/// `randomBytes(4)` for `displayId`.
pub const DISPLAY_ID_BYTES: usize = 4;
/// The encoded `publicId` length (`base64url(24 bytes)` without padding).
pub const PUBLIC_ID_LENGTH: usize = 32;
/// `PG-AC-`.
pub const DISPLAY_ID_PREFIX: &str = "PG-AC-";
/// `addMonthsUtc(now, 12)`.
pub const CERTIFICATE_VALIDITY_MONTHS: i32 = 12;

const BASE64URL_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// `AcademyCertificateStatus` plus the derived `EXPIRED`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CertificateStatus {
    Active,
    Superseded,
    Revoked,
    Expired,
}

impl CertificateStatus {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Active => "ACTIVE",
            Self::Superseded => "SUPERSEDED",
            Self::Revoked => "REVOKED",
            Self::Expired => "EXPIRED",
        }
    }

    #[must_use]
    pub const fn is_stored(self) -> bool {
        !matches!(self, Self::Expired)
    }
}

/// The public verification answer of the checkout route.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VerificationState {
    Valid,
    Expired,
    Revoked,
    Superseded,
}

impl VerificationState {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Valid => "valid",
            Self::Expired => "expired",
            Self::Revoked => "revoked",
            Self::Superseded => "superseded",
        }
    }

    #[must_use]
    pub const fn is_valid(self) -> bool {
        matches!(self, Self::Valid)
    }
}

/// The two identifiers of one certificate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CertificateIdentity {
    pub public_id: String,
    pub display_id: String,
}

impl CertificateIdentity {
    /// Encode the random bytes the issuer drew.
    #[must_use]
    pub fn from_bytes(public: &[u8; PUBLIC_ID_BYTES], display: &[u8; DISPLAY_ID_BYTES]) -> Self {
        Self {
            public_id: certificate_public_id_from_bytes(public),
            display_id: certificate_display_id_from_bytes(display),
        }
    }

    /// Both identifiers have the exact shape the routes and the schema require.
    pub fn validate(&self) -> Result<(), CertificateIdentityError> {
        if !is_valid_public_id(&self.public_id) {
            return Err(CertificateIdentityError::InvalidPublicId);
        }
        if !is_valid_display_id(&self.display_id) {
            return Err(CertificateIdentityError::InvalidDisplayId);
        }
        Ok(())
    }
}

/// Identity validation errors.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum CertificateIdentityError {
    #[error("public_id must be 32 base64url characters")]
    InvalidPublicId,
    #[error("display_id must be PG-AC- followed by 8 upper-case hex characters")]
    InvalidDisplayId,
}

/// `publicId`: base64url (unpadded) of 24 bytes.
#[must_use]
pub fn certificate_public_id_from_bytes(bytes: &[u8; PUBLIC_ID_BYTES]) -> String {
    let mut output = String::with_capacity(PUBLIC_ID_LENGTH);
    for chunk in bytes.as_chunks::<3>().0 {
        let value = (u32::from(chunk[0]) << 16) | (u32::from(chunk[1]) << 8) | u32::from(chunk[2]);
        for shift in [18_u32, 12, 6, 0] {
            let index = ((value >> shift) & 0x3f) as usize;
            output.push(BASE64URL_ALPHABET[index] as char);
        }
    }
    output
}

/// `displayId`: `PG-AC-` + upper-case hex of 4 bytes.
#[must_use]
pub fn certificate_display_id_from_bytes(bytes: &[u8; DISPLAY_ID_BYTES]) -> String {
    let mut output = String::with_capacity(DISPLAY_ID_PREFIX.len() + 8);
    output.push_str(DISPLAY_ID_PREFIX);
    for byte in bytes {
        output.push_str(&format!("{byte:02X}"));
    }
    output
}

/// `z.string().min(16).max(64)` plus the base64url alphabet of the generator.
#[must_use]
pub fn is_valid_public_id(value: &str) -> bool {
    value.len() == PUBLIC_ID_LENGTH && value.bytes().all(|byte| BASE64URL_ALPHABET.contains(&byte))
}

/// Round-trip check for a `publicId` the issuer stored.
#[must_use]
pub fn is_valid_display_id(value: &str) -> bool {
    let Some(hex) = value.strip_prefix(DISPLAY_ID_PREFIX) else {
        return false;
    };
    hex.len() == 8
        && hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'A'..=b'F').contains(&byte))
}

/// `addMonthsUtc(issuedAt, 12)` with the day clamped to the shorter month.
#[must_use]
pub fn expires_at(issued_at: UtcMillis) -> Option<UtcMillis> {
    issued_at.add_months(CERTIFICATE_VALIDITY_MONTHS)
}

/// The badge validity rule of `isBadgeValid`: `expiresAt > now` (strict).
#[must_use]
pub fn is_badge_valid(now: UtcMillis, expires_at: UtcMillis) -> bool {
    expires_at > now
}

/// The public verification state of a stored certificate.
///
/// `issued_at + 12 months` is the stored `expires_at` (the issuer derives it from the badge), so
/// this is the 3-argument form the brief asks for.
#[must_use]
pub fn verification_state(
    now: UtcMillis,
    issued_at: UtcMillis,
    status: CertificateStatus,
) -> VerificationState {
    match status {
        CertificateStatus::Revoked => VerificationState::Revoked,
        CertificateStatus::Superseded => VerificationState::Superseded,
        CertificateStatus::Expired => VerificationState::Expired,
        CertificateStatus::Active => match expires_at(issued_at) {
            Some(expires_at) if is_badge_valid(now, expires_at) => VerificationState::Valid,
            _ => VerificationState::Expired,
        },
    }
}

/// Like [`verification_state`] with an explicit stored expiry (imported/legacy rows).
#[must_use]
pub fn verification_state_with_expiry(
    now: UtcMillis,
    expires_at: UtcMillis,
    status: CertificateStatus,
) -> VerificationState {
    match status {
        CertificateStatus::Revoked => VerificationState::Revoked,
        CertificateStatus::Superseded => VerificationState::Superseded,
        CertificateStatus::Expired => VerificationState::Expired,
        CertificateStatus::Active if is_badge_valid(now, expires_at) => VerificationState::Valid,
        CertificateStatus::Active => VerificationState::Expired,
    }
}

/// The checkout route: an inactive holder makes even an `ACTIVE` issuance answer `revoked`.
#[must_use]
pub fn verification_state_for_holder(
    now: UtcMillis,
    issued_at: UtcMillis,
    status: CertificateStatus,
    holder_active: bool,
) -> VerificationState {
    if !holder_active {
        return VerificationState::Revoked;
    }
    verification_state(now, issued_at, status)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::time::Civil;

    fn at(year: i32, month: u32, day: u32) -> UtcMillis {
        UtcMillis::from_civil(Civil {
            year,
            month,
            day,
            hour: 0,
            minute: 0,
            second: 0,
            millisecond: 0,
        })
        .expect("valid date")
    }

    #[test]
    fn identifiers_have_the_ts_format() {
        let mut public = [0_u8; PUBLIC_ID_BYTES];
        for (index, byte) in public.iter_mut().enumerate() {
            *byte = index as u8;
        }
        assert_eq!(
            certificate_public_id_from_bytes(&public),
            "AAECAwQFBgcICQoLDA0ODxAREhMUFRYX"
        );
        assert_eq!(
            certificate_display_id_from_bytes(&[0x00, 0x0f, 0xab, 0xff]),
            "PG-AC-000FABFF"
        );
        let identity = CertificateIdentity::from_bytes(&public, &[0xde, 0xad, 0xbe, 0xef]);
        assert!(identity.validate().is_ok());
        assert!(is_valid_public_id(&identity.public_id));
        assert!(is_valid_display_id("PG-AC-DEADBEEF"));
    }

    #[test]
    fn identifier_validation_is_strict() {
        assert!(!is_valid_public_id("short"));
        assert!(!is_valid_public_id(&format!("{}=", "A".repeat(32))));
        assert!(!is_valid_public_id(&"A".repeat(31)));
        assert!(!is_valid_public_id(&format!("{}+", "A".repeat(31))));
        assert!(!is_valid_display_id("PG-AC-deadbeef"));
        assert!(!is_valid_display_id("PG-AC-DEADBEE"));
        assert!(!is_valid_display_id("PG-AC-DEADBEEF0"));
        assert!(!is_valid_display_id("XX-AC-DEADBEEF"));
        let invalid = CertificateIdentity {
            public_id: "nope".to_owned(),
            display_id: "PG-AC-DEADBEEF".to_owned(),
        };
        assert_eq!(
            invalid.validate(),
            Err(CertificateIdentityError::InvalidPublicId)
        );
        let invalid = CertificateIdentity {
            public_id: "A".repeat(32),
            display_id: "bad".to_owned(),
        };
        assert_eq!(
            invalid.validate(),
            Err(CertificateIdentityError::InvalidDisplayId)
        );
    }

    #[test]
    fn expiry_is_twelve_months_and_clamped() {
        assert_eq!(
            expires_at(at(2026, 11, 28))
                .expect("expiry")
                .to_iso_string()
                .as_deref(),
            Some("2027-11-28T00:00:00.000Z")
        );
        assert_eq!(
            expires_at(at(2024, 2, 29))
                .expect("expiry")
                .to_iso_string()
                .as_deref(),
            Some("2025-02-28T00:00:00.000Z")
        );
    }

    #[test]
    fn active_is_valid_until_the_expiry_instant() {
        let issued = at(2026, 1, 31);
        let expired_at = at(2027, 1, 31);
        assert_eq!(
            verification_state(at(2026, 6, 1), issued, CertificateStatus::Active),
            VerificationState::Valid
        );
        // The rule is `expiresAt > now`: at the exact instant the certificate is expired.
        assert_eq!(
            verification_state(expired_at, issued, CertificateStatus::Active),
            VerificationState::Expired
        );
        assert_eq!(
            verification_state_with_expiry(
                UtcMillis::from_millis(expired_at.as_millis() - 1),
                expired_at,
                CertificateStatus::Active
            ),
            VerificationState::Valid
        );
    }

    #[test]
    fn statuses_map_to_the_public_answer() {
        let now = at(2026, 11, 28);
        let issued = at(2026, 1, 1);
        assert_eq!(
            verification_state(now, issued, CertificateStatus::Revoked),
            VerificationState::Revoked
        );
        assert_eq!(
            verification_state(now, issued, CertificateStatus::Superseded),
            VerificationState::Superseded
        );
        assert_eq!(
            verification_state(now, issued, CertificateStatus::Expired),
            VerificationState::Expired
        );
        assert_eq!(VerificationState::Valid.as_str(), "valid");
        assert!(VerificationState::Valid.is_valid());
        assert!(!VerificationState::Superseded.is_valid());
        assert!(!CertificateStatus::Expired.is_stored());
        assert!(CertificateStatus::Active.is_stored());
    }

    #[test]
    fn an_inactive_holder_revokes_every_issuance() {
        let now = at(2026, 11, 28);
        let issued = at(2026, 1, 1);
        assert_eq!(
            verification_state_for_holder(now, issued, CertificateStatus::Active, false),
            VerificationState::Revoked
        );
        assert_eq!(
            verification_state_for_holder(now, issued, CertificateStatus::Active, true),
            VerificationState::Valid
        );
    }
}

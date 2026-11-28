//! Server-side single-use authentication challenges (MFA, e-mail verification, password reset).
//!
//! Port of `core-back/lib/auth/mfaChallenges.ts` and `core-back/lib/auth/index.ts:87-93`, chapter 2
//! §5.
//!
//! - Code: `readUInt32BE(randomBytes(4)) % 1_000_000`, zero-padded to six digits.
//! - Stored as `codeHash = hex(HMAC-SHA256(mfaKey, "<userId>:<code>"))` with
//!   `mfaKey = HKDF-SHA256(master, "payment-gateway-core", "mfa-challenge", 32)`
//!   ([`crate::session::mfa_key`]).
//! - `MFA_TTL 5 min`, `5` attempts, `15 min` lock after the fifth wrong code, at most `5` issues per
//!   `15 min`.
//! - A new challenge consumes every open one of the same user and sets its queued notifications to
//!   `SUPPRESSED`; the code is sealed under the `mfa-sms` vault key and the delivery address under
//!   `mfa-address` (sealing itself is a `pg-crypto::Vault` call, done by the caller that owns the
//!   transaction).
//!
//! This module owns the pure parts: generation, hashing, the issue/verify decisions and the delivery
//! descriptors. The Prisma writes stay in the repository layer.

#![forbid(unsafe_code)]

use chrono::{DateTime, Utc};

use crate::error::AuthError;

/// Maximum wrong codes before the challenge is locked.
pub const MFA_MAX_ATTEMPTS: u32 = 5;
/// Challenge TTL in seconds (5 minutes).
pub const MFA_TTL_SECONDS: i64 = 300;
/// TTL in milliseconds, the unit the TS code uses (`MFA_TTL_MS`).
pub const MFA_TTL_MS: i64 = MFA_TTL_SECONDS * 1000;
/// Lock cool-down after too many wrong codes (15 minutes).
pub const MFA_LOCK_COOLDOWN_SECONDS: i64 = 900;
/// The window the issue limit counts in (15 minutes).
pub const MFA_ISSUE_WINDOW_SECONDS: i64 = 900;
/// At most five challenges per issue window.
pub const MFA_MAX_ISSUES_PER_WINDOW: usize = 5;
/// Vault key id of the sealed code.
pub const MFA_CODE_VAULT_KEY_ID: &str = "mfa-sms";
/// Vault key id of the sealed delivery address.
pub const MFA_ADDRESS_VAULT_KEY_ID: &str = "mfa-address";

/// The channel a challenge belongs to (`Admin` sessions vs merchant clients).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MfaChannel {
    Admin,
    Merchant,
}

impl MfaChannel {
    /// `ADMIN` / `MERCHANT`.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Admin => "ADMIN",
            Self::Merchant => "MERCHANT",
        }
    }

    /// Parse the Prisma enum value.
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "ADMIN" => Some(Self::Admin),
            "MERCHANT" => Some(Self::Merchant),
            _ => None,
        }
    }
}

/// Why a code was issued. A password-reset code can never be replayed as a sign-in code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MfaPurpose {
    LoginMfa,
    EmailVerification,
    PasswordReset,
}

impl MfaPurpose {
    /// The Prisma enum value, which is also the default notification template code
    /// (`templateForPurpose`).
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LoginMfa => "LOGIN_MFA",
            Self::EmailVerification => "EMAIL_VERIFICATION",
            Self::PasswordReset => "PASSWORD_RESET",
        }
    }

    /// Parse the Prisma enum value.
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "LOGIN_MFA" => Some(Self::LoginMfa),
            "EMAIL_VERIFICATION" => Some(Self::EmailVerification),
            "PASSWORD_RESET" => Some(Self::PasswordReset),
            _ => None,
        }
    }

    /// `canBeVerifiedByPhone`: every current purpose can be delivered by phone.
    #[must_use]
    pub fn can_be_verified_by_phone(self) -> bool {
        true
    }

    /// The default notification template code (`templateForPurpose`).
    #[must_use]
    pub fn template_code(self) -> &'static str {
        self.as_str()
    }
}

/// A delivery channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeliveryChannel {
    Email,
    Sms,
}

impl DeliveryChannel {
    /// `EMAIL` / `SMS`.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Email => "EMAIL",
            Self::Sms => "SMS",
        }
    }

    /// The key the masked destination is stored under (`destinationMasked.email|phone`).
    #[must_use]
    pub fn masked_key(self) -> &'static str {
        match self {
            Self::Email => "email",
            Self::Sms => "phone",
        }
    }
}

/// One planned delivery: the real address (sealed before storage) and its masked form.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MfaDelivery {
    pub channel: DeliveryChannel,
    /// The real destination; seal with [`MFA_ADDRESS_VAULT_KEY_ID`] before writing it.
    pub address: String,
    /// The masked form shown to the user and written to the log.
    pub masked: String,
}

impl MfaDelivery {
    /// Build a phone delivery with the TS mask `*******<last4>`.
    #[must_use]
    pub fn sms(phone: &str, phone_last4: Option<&str>) -> Self {
        let last4 = phone_last4.map(str::to_owned).unwrap_or_else(|| {
            let characters: Vec<char> = phone.chars().collect();
            let start = characters.len().saturating_sub(4);
            characters[start..].iter().collect()
        });
        Self {
            channel: DeliveryChannel::Sms,
            address: phone.to_owned(),
            masked: masked_last4(&last4),
        }
    }

    /// Build an e-mail delivery with a caller-supplied mask.
    #[must_use]
    pub fn email(address: &str, masked: &str) -> Self {
        Self {
            channel: DeliveryChannel::Email,
            address: address.to_owned(),
            masked: masked.to_owned(),
        }
    }
}

/// `*******<last4>`.
#[must_use]
pub fn masked_last4(last4: &str) -> String {
    format!("*******{last4}")
}

/// `readUInt32BE(randomBytes(4)) % 1_000_000`, zero-padded to six digits.
#[must_use]
pub fn generate_mfa_code() -> String {
    let uuid = uuid::Uuid::new_v4();
    let mut word = [0_u8; 4];
    word.copy_from_slice(&uuid.as_bytes()[0..4]);
    mfa_code_from_bytes(word)
}

/// Deterministic code derivation (golden vectors).
#[must_use]
pub fn mfa_code_from_bytes(bytes: [u8; 4]) -> String {
    format!("{:06}", u32::from_be_bytes(bytes) % 1_000_000)
}

/// `hashMfaCode`: hex HMAC-SHA256 of `"<userId>:<code>"` under the MFA key.
#[must_use]
pub fn hash_mfa_code(mfa_key: &[u8; 32], user_id: &str, code: &str) -> String {
    let message = format!("{user_id}:{code}");
    pg_crypto::encode_output(
        &pg_crypto::hmac_sha256(mfa_key, message.as_bytes()),
        pg_crypto::OutputEncoding::HexLower,
    )
}

/// `constantTimeEqual(hashMfaCode(userId, code), row.codeHash)`.
#[must_use]
pub fn verify_mfa_code(mfa_key: &[u8; 32], user_id: &str, code: &str, stored_hash: &str) -> bool {
    let computed = hash_mfa_code(mfa_key, user_id, code);
    pg_crypto::timing_safe_string_equal(computed.as_bytes(), stored_hash.as_bytes())
}

/// The fields of one `mfa_challenges` row the decisions read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MfaChallengeSummary {
    pub channel: MfaChannel,
    pub purpose: MfaPurpose,
    pub attempts: u32,
    pub max_attempts: u32,
    pub expires_at: DateTime<Utc>,
    pub locked_at: Option<DateTime<Utc>>,
    pub consumed_at: Option<DateTime<Utc>>,
}

/// `attempts >= maxAttempts`.
#[must_use]
pub fn attempts_exhausted(attempts: u32, max_attempts: u32) -> bool {
    attempts >= max_attempts
}

/// The issue gate of `issueMfaChallenge`.
///
/// `recent` must be the user's challenges created inside the issue window
/// (`createdAt >= now - 15 min`), as the TS query returns them. The lock check runs first, exactly
/// like the TS code, so a recently locked user gets `MFA_LOCKED` rather than the rate-limit answer.
pub fn assert_issue_allowed(
    recent: &[MfaChallengeSummary],
    now: DateTime<Utc>,
) -> Result<(), AuthError> {
    let lock_cutoff = now - chrono::Duration::seconds(MFA_LOCK_COOLDOWN_SECONDS);
    if recent.iter().any(|row| {
        row.locked_at
            .is_some_and(|locked_at| locked_at > lock_cutoff)
    }) {
        return Err(AuthError::mfa_locked());
    }
    if recent.len() >= MFA_MAX_ISSUES_PER_WINDOW {
        return Err(AuthError::mfa_rate_limited());
    }
    Ok(())
}

/// The pre-checks of `verifyMfaChallenge` that do not need a write.
///
/// Returns `MFA_CHALLENGE_INVALID` for an unknown/expired/consumed/wrong-channel/wrong-purpose
/// challenge and `MFA_LOCKED` when the challenge or the user is locked or the attempts are spent.
/// The caller then claims the attempt counter with a compare-and-swap (`attempts = attempts + 1
/// WHERE attempts = $before AND consumed_at IS NULL AND locked_at IS NULL`) and compares the hash.
pub fn assert_challenge_verifiable(
    row: Option<&MfaChallengeSummary>,
    channel: MfaChannel,
    purpose: MfaPurpose,
    user_has_recent_lock: bool,
    now: DateTime<Utc>,
) -> Result<(), AuthError> {
    let Some(row) = row else {
        return Err(AuthError::mfa_challenge_invalid());
    };
    if row.channel != channel
        || row.purpose != purpose
        || row.consumed_at.is_some()
        || row.expires_at <= now
    {
        return Err(AuthError::mfa_challenge_invalid());
    }
    if row.locked_at.is_some()
        || attempts_exhausted(row.attempts, row.max_attempts)
        || user_has_recent_lock
    {
        return Err(AuthError::mfa_locked());
    }
    Ok(())
}

/// What happens after a wrong code was counted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WrongCodeOutcome {
    /// Count the attempt and answer `401 MFA_CODE_INVALID`.
    Retry,
    /// This was the last allowed attempt: set `locked_at` and answer `429 MFA_LOCKED`.
    Lock,
}

/// The post-wrong-code rule: the fifth failure locks the challenge
/// (`attemptsBefore + 1 >= maxAttempts`).
#[must_use]
pub fn wrong_code_outcome(attempts_after: u32, max_attempts: u32) -> WrongCodeOutcome {
    if attempts_after >= max_attempts {
        WrongCodeOutcome::Lock
    } else {
        WrongCodeOutcome::Retry
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::mfa_key;
    use chrono::TimeZone;

    const MASTER: &str = "golden-master-key";
    const MFA_KEY_HEX: &str = "36122db2e524b69db9cbde0c9ab848dcb380ed8bddea9aa135b8434b44f1b69f";

    fn at(seconds: i64) -> DateTime<Utc> {
        Utc.timestamp_opt(seconds, 0).single().expect("instant")
    }

    fn key() -> [u8; 32] {
        mfa_key(MASTER).expect("mfa key")
    }

    fn summary(now: DateTime<Utc>) -> MfaChallengeSummary {
        MfaChallengeSummary {
            channel: MfaChannel::Merchant,
            purpose: MfaPurpose::LoginMfa,
            attempts: 0,
            max_attempts: MFA_MAX_ATTEMPTS,
            expires_at: now + chrono::Duration::seconds(MFA_TTL_SECONDS),
            locked_at: None,
            consumed_at: None,
        }
    }

    #[test]
    fn codes_are_six_digits_from_the_uint32_modulo() {
        assert_eq!(mfa_code_from_bytes([0x00, 0x00, 0x00, 0x00]), "000000");
        assert_eq!(mfa_code_from_bytes([0x00, 0x00, 0x00, 0x2a]), "000042");
        assert_eq!(mfa_code_from_bytes([0x00, 0x0f, 0x42, 0x40]), "000000"); // exactly 1_000_000
        assert_eq!(mfa_code_from_bytes([0xff, 0xff, 0xff, 0xff]), "967295");
        for _ in 0..64 {
            let code = generate_mfa_code();
            assert_eq!(code.len(), 6);
            assert!(code.bytes().all(|byte| byte.is_ascii_digit()));
            assert!(code.parse::<u32>().expect("numeric") < 1_000_000);
        }
    }

    #[test]
    fn code_hash_matches_the_independent_hmac() {
        // hex HMAC-SHA256(mfa_key, "user-1:123456") from an independent implementation.
        assert_eq!(
            hash_mfa_code(&key(), "user-1", "123456"),
            "1c3b7586093ae04cb39b7cb4beb707b17fa6ea6a0233cffb38445de05e55f551"
        );
        // The golden key itself is asserted so a key-derivation change cannot hide here.
        assert_eq!(
            pg_crypto::encode_output(&key(), pg_crypto::OutputEncoding::HexLower),
            MFA_KEY_HEX
        );
    }

    #[test]
    fn verification_is_bound_to_the_user_and_the_code() {
        let stored = hash_mfa_code(&key(), "user-1", "123456");
        assert!(verify_mfa_code(&key(), "user-1", "123456", &stored));
        assert!(!verify_mfa_code(&key(), "user-1", "123457", &stored));
        // A code of another user never matches, even with the same digits.
        assert!(!verify_mfa_code(&key(), "user-2", "123456", &stored));
        // Another master key derives another MAC.
        let other = mfa_key("another-master").expect("key");
        assert!(!verify_mfa_code(&other, "user-1", "123456", &stored));
        assert!(!verify_mfa_code(&key(), "user-1", "123456", ""));
    }

    #[test]
    fn policy_constants_match_the_ts() {
        assert_eq!(MFA_MAX_ATTEMPTS, 5);
        assert_eq!(MFA_TTL_SECONDS, 300);
        assert_eq!(MFA_TTL_MS, 300_000);
        assert_eq!(MFA_LOCK_COOLDOWN_SECONDS, 900);
        assert_eq!(MFA_ISSUE_WINDOW_SECONDS, 900);
        assert_eq!(MFA_MAX_ISSUES_PER_WINDOW, 5);
    }

    #[test]
    fn issue_gate_locks_before_it_rate_limits() {
        let now = at(1_764_288_000);
        assert!(assert_issue_allowed(&[], now).is_ok());
        // Five challenges inside the window: rate limited.
        let five: Vec<MfaChallengeSummary> = (0..5).map(|_| summary(now)).collect();
        assert_eq!(
            assert_issue_allowed(&five, now).expect_err("limited").code,
            "MFA_RATE_LIMITED"
        );
        // A lock inside the cool-down wins over the rate limit.
        let mut locked = summary(now);
        locked.locked_at = Some(now - chrono::Duration::seconds(60));
        assert_eq!(
            assert_issue_allowed(&[locked], now)
                .expect_err("locked")
                .code,
            "MFA_LOCKED"
        );
        // A lock older than the cool-down no longer blocks.
        let mut stale = summary(now);
        stale.locked_at = Some(now - chrono::Duration::seconds(MFA_LOCK_COOLDOWN_SECONDS + 1));
        assert!(assert_issue_allowed(&[stale], now).is_ok());
    }

    #[test]
    fn verify_pre_checks() {
        let now = at(1_764_288_000);
        let row = summary(now);
        assert!(assert_challenge_verifiable(
            Some(&row),
            MfaChannel::Merchant,
            MfaPurpose::LoginMfa,
            false,
            now
        )
        .is_ok());
        assert_eq!(
            assert_challenge_verifiable(
                None,
                MfaChannel::Merchant,
                MfaPurpose::LoginMfa,
                false,
                now
            )
            .expect_err("missing")
            .code,
            "MFA_CHALLENGE_INVALID"
        );
        // Wrong channel or purpose is indistinguishable from "no such challenge".
        assert_eq!(
            assert_challenge_verifiable(
                Some(&row),
                MfaChannel::Admin,
                MfaPurpose::LoginMfa,
                false,
                now
            )
            .expect_err("channel")
            .code,
            "MFA_CHALLENGE_INVALID"
        );
        assert_eq!(
            assert_challenge_verifiable(
                Some(&row),
                MfaChannel::Merchant,
                MfaPurpose::PasswordReset,
                false,
                now
            )
            .expect_err("purpose")
            .code,
            "MFA_CHALLENGE_INVALID"
        );
        // Expired, consumed, locked or spent.
        let expired = now + chrono::Duration::seconds(MFA_TTL_SECONDS);
        assert_eq!(
            assert_challenge_verifiable(
                Some(&row),
                MfaChannel::Merchant,
                MfaPurpose::LoginMfa,
                false,
                expired
            )
            .expect_err("expired")
            .code,
            "MFA_CHALLENGE_INVALID"
        );
        let mut consumed = row.clone();
        consumed.consumed_at = Some(now);
        assert_eq!(
            assert_challenge_verifiable(
                Some(&consumed),
                MfaChannel::Merchant,
                MfaPurpose::LoginMfa,
                false,
                now
            )
            .expect_err("consumed")
            .code,
            "MFA_CHALLENGE_INVALID"
        );
        let mut locked = row.clone();
        locked.locked_at = Some(now);
        assert_eq!(
            assert_challenge_verifiable(
                Some(&locked),
                MfaChannel::Merchant,
                MfaPurpose::LoginMfa,
                false,
                now
            )
            .expect_err("locked")
            .code,
            "MFA_LOCKED"
        );
        let mut spent = row.clone();
        spent.attempts = MFA_MAX_ATTEMPTS;
        assert_eq!(
            assert_challenge_verifiable(
                Some(&spent),
                MfaChannel::Merchant,
                MfaPurpose::LoginMfa,
                false,
                now
            )
            .expect_err("spent")
            .code,
            "MFA_LOCKED"
        );
        // The user-level lock of another challenge blocks this one too.
        assert_eq!(
            assert_challenge_verifiable(
                Some(&row),
                MfaChannel::Merchant,
                MfaPurpose::LoginMfa,
                true,
                now
            )
            .expect_err("user locked")
            .code,
            "MFA_LOCKED"
        );
    }

    #[test]
    fn fifth_wrong_code_locks() {
        assert_eq!(wrong_code_outcome(1, 5), WrongCodeOutcome::Retry);
        assert_eq!(wrong_code_outcome(4, 5), WrongCodeOutcome::Retry);
        assert_eq!(wrong_code_outcome(5, 5), WrongCodeOutcome::Lock);
        assert!(!attempts_exhausted(4, 5));
        assert!(attempts_exhausted(5, 5));
        assert!(attempts_exhausted(9, 5));
    }

    #[test]
    fn purposes_round_trip_and_carry_their_template() {
        for purpose in [
            MfaPurpose::LoginMfa,
            MfaPurpose::EmailVerification,
            MfaPurpose::PasswordReset,
        ] {
            assert_eq!(MfaPurpose::parse(purpose.as_str()), Some(purpose));
            assert_eq!(purpose.template_code(), purpose.as_str());
        }
        assert_eq!(MfaPurpose::parse("SIGN_IN"), None);
        assert_eq!(MfaChannel::parse("MERCHANT"), Some(MfaChannel::Merchant));
        assert_eq!(MfaChannel::parse("merchant"), None);
        assert_eq!(DeliveryChannel::Sms.masked_key(), "phone");
        assert_eq!(DeliveryChannel::Email.masked_key(), "email");
    }

    #[test]
    fn deliveries_mask_phone_numbers_without_the_middle_digits() {
        let delivery = MfaDelivery::sms("+2189100001234", Some("1234"));
        assert_eq!(delivery.masked, "*******1234");
        assert_eq!(delivery.address, "+2189100001234");
        assert_eq!(delivery.channel.as_str(), "SMS");
        // Last four characters when no explicit last-4 is supplied.
        assert_eq!(MfaDelivery::sms("0911234567", None).masked, "*******4567");
        assert!(!delivery.masked.contains("000"));
        let email = MfaDelivery::email("user@example.com", "u***@example.com");
        assert_eq!(email.channel.masked_key(), "email");
        assert_eq!(email.masked, "u***@example.com");
    }
}

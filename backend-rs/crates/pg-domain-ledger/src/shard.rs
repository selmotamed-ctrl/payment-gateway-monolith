//! Shard routing: FNV-1a over UTF-16 code units, shard widths and the wallet rule.
//!
//! Ports: `core-back/lib/storageEngine/shardRouting.ts` (routing model, widths, balance guard) and
//! `core-back/lib/storageEngine/shardBalances.ts:7-32` (`fnv1aHash`, `shardCountForAccountType`,
//! `shardIdForAttempt`).
//!
//! Model (from `shardRouting.ts:1-14`):
//!
//! - an account has a routing *width* (`gl_accounts.shard_count`, 1..=256);
//! - a line goes to shard `fnv1a(refId) % width`, so a retry of the same posting always lands on the
//!   same shard;
//! - a `MERCHANT_WALLET` line that *reduces* the balance (a debit) always goes to shard 0, which
//!   keeps wallet debits serialized while credits spread over the other shards
//!   (`shardRouting.ts:70-82`).

use rust_decimal::Decimal;

use crate::template::{AccountType, Direction, ValidatedTemplate};

/// Smallest legal routing width.
pub const MIN_SHARD_WIDTH: u32 = 1;
/// Largest legal routing width.
pub const MAX_SHARD_WIDTH: u32 = 256;
/// `shardBalances.ts:1` — the default width before an account is provisioned or scaled.
pub const DEFAULT_SHARD_COUNT: u32 = 16;
/// Width a new non-hot system account starts with (`shardRouting.ts:20`).
pub const INITIAL_SYSTEM_SHARD_WIDTH: u32 = 16;
/// Interim width of the hot system accounts (TREASURY, GATEWAY_CLEARING, PLATFORM_INCOME), decision
/// D6/AUTO-10 (`shardRouting.ts:28-33`).
pub const HOT_SYSTEM_SHARD_WIDTH: u32 = 128;

/// FNV-1a 32-bit over the UTF-16 code units of `value`, exactly like JavaScript's
/// `charCodeAt` loop (`shardBalances.ts:11-18`).
///
/// An astral character contributes its two surrogate code units, not its UTF-8 bytes and not one
/// `char`, so hashes agree with the TypeScript router for every id the platform can produce.
///
/// Re-implemented locally (there is no `pg-crypto` dependency in this crate); the constants and the
/// algorithm are the reference ones: offset basis `0x811c9dc5`, prime `0x01000193`.
#[must_use]
pub fn fnv1a32_utf16(value: &str) -> u32 {
    const OFFSET_BASIS: u32 = 0x811c_9dc5;
    const PRIME: u32 = 0x0100_0193;
    let mut hash = OFFSET_BASIS;
    for unit in value.encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(PRIME);
    }
    hash
}

/// Clamps a routing width into `1..=256`; zero and garbage widths fall back to one shard rather
/// than panicking (`shardRouting.ts:49-50`).
#[must_use]
pub fn clamp_shard_width(width: u32) -> u32 {
    width.clamp(MIN_SHARD_WIDTH, MAX_SHARD_WIDTH)
}

/// Shard of a reference at a given width: `fnv1a(ref) % clamp(width)`.
/// Port of the `count === 1 ? 0 : fnv1aHash(ref) % count` branch (`shardBalances.ts:25-32`).
#[must_use]
pub fn shard_for_reference(reference: &str, shard_count: u32) -> u32 {
    fnv1a32_utf16(reference) % clamp_shard_width(shard_count)
}

/// Port of `reducesBalance` (`shardRouting.ts:65-67`): true when a line lowers the account's
/// natural balance.
#[must_use]
pub fn reduces_balance(account_type: AccountType, direction: Direction) -> bool {
    if account_type.is_debit_natural() {
        matches!(direction, Direction::Credit)
    } else {
        matches!(direction, Direction::Debit)
    }
}

/// Port of `routeLine` (`shardRouting.ts:70-82`): chooses the shard of a line.
///
/// A balance-guarded account (a merchant wallet) sends every balance-*reducing* line to shard 0; a
/// one-shard account always returns 0; everything else is `fnv1a(refId) % width`.
#[must_use]
pub fn route_line(
    account_type: AccountType,
    shard_count: u32,
    ref_id: &str,
    direction: Direction,
) -> u32 {
    let width = clamp_shard_width(shard_count);
    if width == MIN_SHARD_WIDTH {
        return 0;
    }
    if account_type.is_balance_guarded() && reduces_balance(account_type, direction) {
        return 0;
    }
    fnv1a32_utf16(ref_id) % width
}

/// Port of `initialShardWidth` (`shardRouting.ts:52-63`): the routing width a new account starts
/// with — one shard for a balance-guarded wallet, `hot_system_width` for the hot system accounts
/// and `system_width` for everything else.
#[must_use]
pub fn initial_shard_width_with(
    account_type: AccountType,
    system_width: u32,
    hot_system_width: u32,
) -> u32 {
    if account_type.is_balance_guarded() {
        return 1;
    }
    let width = if matches!(
        account_type,
        AccountType::Treasury | AccountType::GatewayClearing | AccountType::PlatformIncome
    ) {
        hot_system_width
    } else {
        system_width
    };
    clamp_shard_width(width)
}

/// [`initial_shard_width_with`] using the platform defaults (`16` system, `128` hot).
#[must_use]
pub fn initial_shard_width(account_type: AccountType) -> u32 {
    initial_shard_width_with(
        account_type,
        INITIAL_SYSTEM_SHARD_WIDTH,
        HOT_SYSTEM_SHARD_WIDTH,
    )
}

/// Port of `naturalShardBalance` (`shardBalances.ts:78-97`): converts a debit-positive shard sum to
/// the account's natural sign (the debit-positive table there is identical to
/// [`AccountType::is_debit_natural`]).
///
/// A wallet is a liability: its shards hold a negative (credit) balance, and this is where the
/// public balance becomes positive again. Zero is always canonical zero, never `-0`.
#[must_use]
pub fn natural_balance(account_type: AccountType, debit_positive_total: Decimal) -> Decimal {
    if debit_positive_total.is_zero() {
        Decimal::ZERO
    } else if account_type.is_debit_natural() {
        debit_positive_total
    } else {
        -debit_positive_total
    }
}

/// The account facts routing needs for one line, in template line order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LineRoute {
    pub account_type: AccountType,
    /// The account's routing width (`gl_accounts.shard_count`).
    pub shard_count: u32,
}

/// Why the validated lines could not be routed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ShardRouteError {
    #[error("expected {expected} line routes, got {actual}")]
    RouteCountMismatch { expected: usize, actual: usize },
}

/// Routes every validated line of `template` in place, from the account facts of the same posting
/// (`shardRouting.ts` + `ledgerShardWriter.ts`: the writer loads each account's width and calls
/// `routeLine` per line).
///
/// `routes` must be aligned with `ValidatedTemplate::lines` (zero optional legs were already
/// dropped by validation), so the caller passes the resolved account type/width of each written
/// line.
pub fn route_validated_lines(
    template: &mut ValidatedTemplate,
    routes: &[LineRoute],
) -> Result<(), ShardRouteError> {
    if routes.len() != template.lines.len() {
        return Err(ShardRouteError::RouteCountMismatch {
            expected: template.lines.len(),
            actual: routes.len(),
        });
    }
    let ref_id = template.ref_id.clone();
    for (line, route) in template.lines.iter_mut().zip(routes) {
        line.shard_id = route_line(
            route.account_type,
            route.shard_count,
            &ref_id,
            line.direction,
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal::Decimal;

    #[test]
    fn matches_the_fnv_reference_vectors() {
        // The FNV reference test suite; ASCII code points are single UTF-16 units.
        assert_eq!(fnv1a32_utf16(""), 0x811c_9dc5);
        assert_eq!(fnv1a32_utf16("a"), 0xe40c_292c);
        assert_eq!(fnv1a32_utf16("foobar"), 0xbf9c_f968);
    }

    #[test]
    fn astral_characters_are_hashed_as_two_utf16_units() {
        // U+1F600 is the surrogate pair D83D DE00.
        let mut expected = 0x811c_9dc5u32;
        for unit in [0xD83Du16, 0xDE00u16] {
            expected ^= u32::from(unit);
            expected = expected.wrapping_mul(0x0100_0193);
        }
        assert_eq!(fnv1a32_utf16("\u{1F600}"), expected);
        // Hashing UTF-8 bytes or one `char` would disagree with the expected value.
        assert_ne!(fnv1a32_utf16("\u{1F600}"), fnv1a32_utf16(""));
    }

    #[test]
    fn non_ascii_bmp_characters_are_single_units() {
        // U+00E9 is one UTF-16 unit, U+0065 is another: the hashes must differ.
        assert_ne!(fnv1a32_utf16("é"), fnv1a32_utf16("e"));
        assert_eq!(fnv1a32_utf16("é"), {
            let mut hash = 0x811c_9dc5u32;
            hash ^= u32::from(0x00E9u16);
            hash.wrapping_mul(0x0100_0193)
        });
    }

    #[test]
    fn shard_for_reference_uses_the_low_bits_of_the_hash() {
        // 0xbf9cf968 % 16, 0x811c9dc5 % 16 and 0xe40c292c % 16.
        assert_eq!(shard_for_reference("foobar", 16), 8);
        assert_eq!(shard_for_reference("", 16), 5);
        assert_eq!(shard_for_reference("a", 16), 12);
        assert_eq!(shard_for_reference("foobar", 256), 104);
    }

    #[test]
    fn widths_are_clamped_into_one_to_256() {
        assert_eq!(clamp_shard_width(0), 1);
        assert_eq!(clamp_shard_width(1), 1);
        assert_eq!(clamp_shard_width(256), 256);
        assert_eq!(clamp_shard_width(257), 256);
        assert_eq!(clamp_shard_width(u32::MAX), 256);

        assert_eq!(shard_for_reference("foobar", 0), 0);
        assert_eq!(shard_for_reference("foobar", 1), 0);
        assert_eq!(shard_for_reference("foobar", u32::MAX), 104);
    }

    #[test]
    fn shards_stay_inside_the_width() {
        for width in [1u32, 2, 7, 16, 128, 256] {
            for reference in ["a", "ref-1", "ref-2", "😀", "attempt-0001"] {
                assert!(shard_for_reference(reference, width) < width);
            }
        }
    }

    #[test]
    fn wallet_debits_always_route_to_shard_zero() {
        assert_eq!(
            route_line(AccountType::MerchantWallet, 16, "foobar", Direction::Debit),
            0
        );
        // Wallet credits spread like any other balance-raising line.
        assert_eq!(
            route_line(AccountType::MerchantWallet, 16, "foobar", Direction::Credit),
            shard_for_reference("foobar", 16)
        );
        // A one-shard wallet has nothing to spread.
        assert_eq!(
            route_line(AccountType::MerchantWallet, 1, "foobar", Direction::Credit),
            0
        );
    }

    #[test]
    fn non_wallet_lines_hash_regardless_of_direction() {
        assert_eq!(
            route_line(AccountType::Treasury, 16, "foobar", Direction::Debit),
            8
        );
        assert_eq!(
            route_line(AccountType::Treasury, 16, "foobar", Direction::Credit),
            8
        );
        // SUSPENSE is credit-natural, so a credit reduces it, but only wallets are guarded.
        assert_eq!(
            route_line(AccountType::Suspense, 16, "foobar", Direction::Credit),
            8
        );
    }

    #[test]
    fn reduces_balance_follows_the_natural_sign() {
        assert!(reduces_balance(AccountType::Treasury, Direction::Credit));
        assert!(!reduces_balance(AccountType::Treasury, Direction::Debit));
        assert!(reduces_balance(
            AccountType::MerchantWallet,
            Direction::Debit
        ));
        assert!(!reduces_balance(
            AccountType::MerchantWallet,
            Direction::Credit
        ));
        // Suspense is credit-natural: a credit increases it, a debit reduces it.
        assert!(!reduces_balance(AccountType::Suspense, Direction::Credit));
        assert!(reduces_balance(AccountType::Suspense, Direction::Debit));
    }

    #[test]
    fn initial_widths_match_the_provisioning_rules() {
        assert_eq!(initial_shard_width(AccountType::MerchantWallet), 1);
        assert_eq!(initial_shard_width(AccountType::Treasury), 128);
        assert_eq!(initial_shard_width(AccountType::GatewayClearing), 128);
        assert_eq!(initial_shard_width(AccountType::PlatformIncome), 128);
        assert_eq!(initial_shard_width(AccountType::Suspense), 16);
        assert_eq!(initial_shard_width(AccountType::AmlHold), 16);

        // Explicit widths are clamped, and the wallet rule always wins.
        assert_eq!(initial_shard_width_with(AccountType::Suspense, 0, 0), 1);
        assert_eq!(
            initial_shard_width_with(AccountType::Suspense, 999, 128),
            256
        );
        assert_eq!(
            initial_shard_width_with(AccountType::MerchantWallet, 999, 128),
            1
        );
    }

    #[test]
    fn natural_balance_flips_a_credit_natural_total() {
        use std::str::FromStr;

        let debit_positive = Decimal::from_str("-25.0000").expect("decimal");
        assert_eq!(
            natural_balance(AccountType::MerchantWallet, debit_positive),
            Decimal::from_str("25.0000").expect("decimal")
        );
        // Debit-natural accounts keep the sign they are stored with.
        assert_eq!(
            natural_balance(AccountType::Treasury, debit_positive),
            debit_positive
        );
        // Zero is canonical zero, even from a negative-signed sum.
        let negative_zero = natural_balance(AccountType::Suspense, Decimal::ZERO);
        assert!(negative_zero.is_zero());
        assert_eq!(negative_zero.to_string(), "0");
    }

    fn routed_wallet_debit() -> ValidatedTemplate {
        use crate::template::{validate_template, JournalTemplate, LedgerLineInput};
        use std::str::FromStr;
        use uuid::Uuid;

        let lines = vec![
            LedgerLineInput {
                gl_account_id: Uuid::from_u128(1),
                direction: Direction::Debit,
                amount: rust_decimal::Decimal::from_str("10.0000").expect("decimal"),
                optional: false,
            },
            LedgerLineInput {
                gl_account_id: Uuid::from_u128(2),
                direction: Direction::Credit,
                amount: rust_decimal::Decimal::from_str("10.0000").expect("decimal"),
                optional: false,
            },
        ];
        validate_template(&JournalTemplate {
            ref_type: "ADJUSTMENT".to_owned(),
            ref_id: "foobar".to_owned(),
            currency: "LYD".to_owned(),
            description: None,
            lines,
        })
        .expect("valid template")
    }

    #[test]
    fn routes_every_validated_line() {
        let mut template = routed_wallet_debit();
        let routes = [
            LineRoute {
                account_type: AccountType::MerchantWallet,
                shard_count: 16,
            },
            LineRoute {
                account_type: AccountType::Suspense,
                shard_count: 16,
            },
        ];
        route_validated_lines(&mut template, &routes).expect("routing succeeds");
        assert_eq!(template.lines[0].shard_id, 0);
        assert_eq!(template.lines[1].shard_id, 8);

        // Re-routing is idempotent.
        route_validated_lines(&mut template, &routes).expect("routing succeeds");
        assert_eq!(template.lines[0].shard_id, 0);
        assert_eq!(template.lines[1].shard_id, 8);
    }

    #[test]
    fn rejects_misaligned_routes() {
        let mut template = routed_wallet_debit();
        let routes = [LineRoute {
            account_type: AccountType::Treasury,
            shard_count: 16,
        }];
        assert_eq!(
            route_validated_lines(&mut template, &routes),
            Err(ShardRouteError::RouteCountMismatch {
                expected: 2,
                actual: 1,
            })
        );
        // The failed call leaves the lines untouched.
        assert!(template.lines.iter().all(|line| line.shard_id == 0));
    }
}

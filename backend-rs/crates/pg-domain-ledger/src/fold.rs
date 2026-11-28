//! Per-shard folding and gapless sequence assignment.
//!
//! Ports: `core-back/lib/storageEngine/shardRouting.ts:84-153` (`RoutedLine`, `ShardBump`,
//! `foldShardBumps`, `assignShardSeqs`).
//!
//! Why fold: PostgreSQL cannot touch the same row twice in one `INSERT … ON CONFLICT DO UPDATE`
//! statement, so the lines of a posting are aggregated per `(account, shard)` before the shard
//! upsert (`shardRouting.ts:103-108`). Sorting by `(account, shard)` also makes every posting lock
//! its shard rows in the same global order, which is what removes the deadlock window between
//! concurrent postings (design chapter 2 §17).

use std::collections::BTreeMap;

use rust_decimal::Decimal;
use uuid::Uuid;

use crate::template::{Direction, ValidatedLine};

/// Port of `ShardBump` (`shardRouting.ts:92-100`): one shard's share of a posting — the signed
/// balance delta and how many lines it carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShardFold {
    pub gl_account_id: Uuid,
    pub shard_id: u32,
    /// Debit-positive: a debit adds, a credit subtracts (the shard balance sign).
    pub delta: Decimal,
    /// Number of lines the posting puts on this shard.
    pub line_count: i64,
}

/// Port of `foldShardBumps` (`shardRouting.ts:109-128`): folds the routed lines of one posting into
/// one `(delta, line_count)` per `(account, shard)`, sorted by account id and then shard id.
///
/// The lines must already be routed (`shard_id` set by
/// [`crate::shard::route_validated_lines`]); validation alone leaves every shard at zero.
///
/// The order is the lock order: `Uuid` compares byte-wise exactly like PostgreSQL's `uuid` type,
/// so both agree on `(gl_account_id, shard_id)`.
#[must_use]
pub fn fold_lines(lines: &[ValidatedLine]) -> Vec<ShardFold> {
    let mut by_key: BTreeMap<(Uuid, u32), (Decimal, i64)> = BTreeMap::new();
    for line in lines {
        let signed = match line.direction {
            Direction::Debit => line.amount,
            Direction::Credit => -line.amount,
        };
        let entry = by_key
            .entry((line.gl_account_id, line.shard_id))
            .or_insert((Decimal::ZERO, 0));
        entry.0 += signed;
        entry.1 += 1;
    }
    by_key
        .into_iter()
        .map(
            |((gl_account_id, shard_id), (delta, line_count))| ShardFold {
                gl_account_id,
                shard_id,
                delta,
                line_count,
            },
        )
        .collect()
}

/// Port of `assignShardSeqs` (`shardRouting.ts:130-153`): the sequence number of the j-th line
/// (1-based, template order) of a posting on a shard whose post-upsert high-water mark is
/// `high_water` and that received `line_count` lines, i.e. `high_water - line_count + j`.
///
/// Gapless by construction: the caller reserves `[high_water - line_count + 1, high_water]` before
/// inserting, and a rolled-back posting rolls back its bump too, so no number is skipped or reused.
///
/// The caller guarantees `1 <= j <= line_count`; the arithmetic saturates at the `i64` bounds
/// instead of overflowing (a sequence is a `bigint` count of posted lines, far below that).
#[must_use]
pub fn assign_sequences(high_water: i64, line_count: i64, j: usize) -> i64 {
    let ordinal = i64::try_from(j).unwrap_or(i64::MAX);
    high_water
        .saturating_sub(line_count)
        .saturating_add(ordinal)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal::Decimal;
    use std::str::FromStr;
    use uuid::Uuid;

    fn dec(raw: &str) -> Decimal {
        Decimal::from_str(raw).expect("test decimal")
    }

    fn line(account: u128, shard: u32, direction: Direction, amount: &str) -> ValidatedLine {
        ValidatedLine {
            gl_account_id: Uuid::from_u128(account),
            direction,
            amount: dec(amount),
            shard_id: shard,
        }
    }

    #[test]
    fn folds_mixed_signs_per_shard() {
        let lines = [
            line(1, 0, Direction::Debit, "10.0000"),
            line(1, 0, Direction::Credit, "3.0000"),
            line(1, 1, Direction::Credit, "5.0000"),
            line(2, 0, Direction::Debit, "7.5000"),
        ];
        let folds = fold_lines(&lines);
        assert_eq!(folds.len(), 3);

        assert_eq!(folds[0].gl_account_id, Uuid::from_u128(1));
        assert_eq!(folds[0].shard_id, 0);
        assert_eq!(folds[0].delta, dec("7.0000"));
        assert_eq!(folds[0].line_count, 2);

        assert_eq!(folds[1].gl_account_id, Uuid::from_u128(1));
        assert_eq!(folds[1].shard_id, 1);
        assert_eq!(folds[1].delta, dec("-5.0000"));
        assert_eq!(folds[1].line_count, 1);

        assert_eq!(folds[2].gl_account_id, Uuid::from_u128(2));
        assert_eq!(folds[2].shard_id, 0);
        assert_eq!(folds[2].delta, dec("7.5000"));
        assert_eq!(folds[2].line_count, 1);
    }

    #[test]
    fn a_debit_and_a_credit_on_one_shard_net_to_zero_but_keep_their_count() {
        let lines = [
            line(1, 3, Direction::Debit, "2.0000"),
            line(1, 3, Direction::Credit, "2.0000"),
        ];
        let folds = fold_lines(&lines);
        assert_eq!(folds.len(), 1);
        assert!(folds[0].delta.is_zero());
        assert_eq!(folds[0].line_count, 2);
    }

    #[test]
    fn sorts_by_account_id_then_shard_id() {
        let lines = [
            line(2, 0, Direction::Debit, "1.0000"),
            line(1, 2, Direction::Debit, "1.0000"),
            line(1, 0, Direction::Debit, "1.0000"),
        ];
        let folds = fold_lines(&lines);
        let keys: Vec<(u128, u32)> = folds
            .iter()
            .map(|fold| (fold.gl_account_id.as_u128(), fold.shard_id))
            .collect();
        assert_eq!(keys, vec![(1, 0), (1, 2), (2, 0)]);
    }

    #[test]
    fn empty_input_folds_to_nothing() {
        assert!(fold_lines(&[]).is_empty());
    }

    #[test]
    fn assigns_the_last_sequence_numbers_of_the_reserved_range() {
        // A shard that received three lines and now sits at high-water 10 gets 8, 9, 10.
        assert_eq!(assign_sequences(10, 3, 1), 8);
        assert_eq!(assign_sequences(10, 3, 2), 9);
        assert_eq!(assign_sequences(10, 3, 3), 10);
        // One line keeps the high-water mark itself.
        assert_eq!(assign_sequences(5, 1, 1), 5);
        // A fresh shard starts its gapless sequence at 1.
        assert_eq!(assign_sequences(1, 1, 1), 1);
        assert_eq!(assign_sequences(3, 3, 1), 1);
    }
}

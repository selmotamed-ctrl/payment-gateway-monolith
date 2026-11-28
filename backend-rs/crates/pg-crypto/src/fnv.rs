//! FNV-1a over UTF-16 code units (ledger shard routing).
//!
//! Port of `core-back/lib/storageEngine/shardBalances.ts:11-16`. JavaScript iterates UTF-16 code
//! units (`charCodeAt`), so a character outside the BMP contributes two units.

#![forbid(unsafe_code)]

const OFFSET_BASIS: u32 = 0x811c_9dc5;
const PRIME: u32 = 0x0100_0193;

#[must_use]
pub fn fnv1a32_utf16(input: &str) -> u32 {
    let mut hash = OFFSET_BASIS;
    for unit in input.encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(PRIME);
    }
    hash
}

/// Shard index for a ledger reference id.
#[must_use]
pub fn shard_index(reference: &str, shard_count: u32) -> u32 {
    if shard_count == 0 {
        return 0;
    }
    fnv1a32_utf16(reference) % shard_count
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_known_fnv_values() {
        assert_eq!(fnv1a32_utf16(""), 0x811c_9dc5);
        assert_eq!(fnv1a32_utf16("a"), 0xe40c_292c);
        assert_eq!(fnv1a32_utf16("foobar"), 0xbf9c_f968);
    }

    #[test]
    fn astral_characters_use_two_units() {
        // U+1F600 is the surrogate pair D83D DE00 in UTF-16 (two code units).
        assert_ne!(fnv1a32_utf16("\u{1F600}"), fnv1a32_utf16(""));
    }

    #[test]
    fn shard_is_bounded() {
        for reference in ["a", "ref-1", "ref-2", "😀"] {
            assert!(shard_index(reference, 16) < 16);
        }
        assert_eq!(shard_index("anything", 0), 0);
    }
}

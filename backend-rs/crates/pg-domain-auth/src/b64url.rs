//! Unpadded base64url (RFC 4648 §5), implemented locally.
//!
//! Node produces API tokens with `randomBytes(32).toString("base64url")` and `jsonwebtoken` uses
//! base64url for the JWT segments (chapter 2 §5). `pg-crypto` only exposes the padded standard
//! alphabet (`decode_base64_strict`), and this crate may not add dependencies, so the URL-safe
//! alphabet lives here with the same strictness rules: the input must be canonical (re-encode and
//! compare) and the final quantum may not carry non-zero padding bits.

#![forbid(unsafe_code)]

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Encode without padding.
#[must_use]
pub fn encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = u32::from(chunk[0]);
        let second = chunk.get(1).copied().map_or(0, u32::from);
        let third = chunk.get(2).copied().map_or(0, u32::from);
        let combined = (first << 16) | (second << 8) | third;
        let emitted = chunk.len() + 1;
        for index in 0..emitted {
            let shift = 18 - (index as u32) * 6;
            let slot = ((combined >> shift) & 0x3f) as usize;
            out.push(char::from(ALPHABET[slot]));
        }
    }
    out
}

/// Decode unpadded base64url. Rejects padding characters, a length of `1 mod 4`, non-canonical
/// alphabets and non-zero trailing bits.
#[must_use]
pub fn decode(value: &str) -> Option<Vec<u8>> {
    if value.is_empty() || value.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(value.len() * 3 / 4);
    let bytes = value.as_bytes();
    for chunk in bytes.chunks(4) {
        // The four characters pack 24 bits, most significant first.
        let mut combined: u32 = 0;
        for (index, byte) in chunk.iter().enumerate() {
            let slot = decode_char(*byte)?;
            combined |= u32::from(slot) << (18 - (index as u32) * 6);
        }
        // The final quantum must have zero padding bits: 4 for two characters, 2 for three.
        let padding_mask: u32 = match chunk.len() {
            2 => 0x0000_0f00,
            3 => 0x0000_00c0,
            _ => 0,
        };
        if combined & padding_mask != 0 {
            return None;
        }
        out.push((combined >> 16) as u8);
        if chunk.len() > 2 {
            out.push((combined >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(combined as u8);
        }
    }
    // Exactly one encoding per value: an input with different case bits or padding cannot round-trip.
    if encode(&out) != value {
        return None;
    }
    Some(out)
}

fn decode_char(byte: u8) -> Option<u8> {
    Some(match byte {
        b'A'..=b'Z' => byte - b'A',
        b'a'..=b'z' => byte - b'a' + 26,
        b'0'..=b'9' => byte - b'0' + 52,
        b'-' => 62,
        b'_' => 63,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc4648_vectors_without_padding() {
        assert_eq!(encode(b""), "");
        assert_eq!(encode(b"f"), "Zg");
        assert_eq!(encode(b"fo"), "Zm8");
        assert_eq!(encode(b"foo"), "Zm9v");
        assert_eq!(encode(b"foob"), "Zm9vYg");
        assert_eq!(encode(b"fooba"), "Zm9vYmE");
        assert_eq!(encode(b"foobar"), "Zm9vYmFy");
        assert_eq!(decode("Zm9vYmFy"), Some(b"foobar".to_vec()));
    }

    #[test]
    fn url_safe_alphabet_covers_both_extra_characters() {
        // 0xfb 0xff encodes to "-_8" in the URL-safe alphabet.
        assert_eq!(encode(&[0xfb, 0xff]), "-_8");
        assert_eq!(decode("-_8"), Some(vec![0xfb, 0xff]));
    }

    #[test]
    fn rejects_non_canonical_input() {
        assert_eq!(decode("Zg=="), None); // padded
        assert_eq!(decode("Z"), None); // 1 mod 4
        assert_eq!(decode("Zg\n"), None); // newline
        assert_eq!(decode("Zh"), None); // non-zero trailing bits
        assert_eq!(decode("+/8"), None); // standard alphabet
    }
}

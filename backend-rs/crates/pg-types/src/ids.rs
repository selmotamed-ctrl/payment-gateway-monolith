//! Identifier generation matching Prisma's defaults.
//!
//! - 105 models use UUID v7 (`@default(uuid(7))`) — time-ordered.
//! - 6 models use UUID v4.
//! - `SandboxSyncAudit` uses `cuid()`; only the shape is contract-relevant (chapter 2 §13).

#![forbid(unsafe_code)]

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use uuid::Uuid;

static CUID_COUNTER: AtomicU64 = AtomicU64::new(0);

/// UUID v7 for client-generated ids.
#[must_use]
pub fn new_v7() -> Uuid {
    Uuid::now_v7()
}

/// UUID v4 for the six storage/attachment models.
#[must_use]
pub fn new_v4() -> Uuid {
    Uuid::new_v4()
}

/// Prisma-compatible `cuid()` (v1 shape): `c` + base36 timestamp + 4-char counter + 4-char
/// fingerprint + 4-char random, 25 characters total starting with `c`.
#[must_use]
pub fn cuid() -> String {
    const BASE36: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    fn encode(mut value: u64, width: usize) -> String {
        let mut out = vec![b'0'; width];
        for index in (0..width).rev() {
            out[index] = BASE36[(value % 36) as usize];
            value /= 36;
        }
        String::from_utf8(out).unwrap_or_default()
    }

    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let counter = CUID_COUNTER.fetch_add(1, Ordering::Relaxed) % 1_679_616; // 36^4
    let host = host_fingerprint();
    let random = (Uuid::new_v4().as_u128() as u64) % 1_679_616;
    format!(
        "c{}{}{}{}",
        encode(millis, 8),
        encode(counter, 4),
        encode(host, 4),
        encode(random, 8)
    )
}

fn host_fingerprint() -> u64 {
    static FINGERPRINT: std::sync::OnceLock<u64> = std::sync::OnceLock::new();
    *FINGERPRINT.get_or_init(|| {
        let host = std::env::var("HOSTNAME").unwrap_or_else(|_| "localhost".to_owned());
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for byte in host.as_bytes() {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        hash % 1_679_616
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cuid_shape() {
        let id = cuid();
        assert_eq!(id.len(), 25);
        assert!(id.starts_with('c'));
        assert!(id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit()));
    }

    #[test]
    fn v7_is_ordered() {
        let first = new_v7();
        std::thread::sleep(std::time::Duration::from_millis(2));
        let second = new_v7();
        assert!(first.to_string() < second.to_string());
    }
}

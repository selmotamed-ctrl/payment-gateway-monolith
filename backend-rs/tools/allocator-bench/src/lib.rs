//! P0-T09: which global allocator should the Rust port ship with?
//!
//! The workload is JSON/serde heavy because that is what the ntex request path does
//! (parse a body into `serde_json::Value`, validate into typed structs, serialise a response)
//! and because the ledger path builds many short-lived `String`s and `Vec`s per posting.
//!
//! The allocator is selected at compile time by a feature so the exact same workload runs
//! against each implementation:
//!
//! ```text
//! cargo bench --no-default-features                      # system (glibc malloc)
//! cargo bench --no-default-features --features mimalloc
//! cargo bench --no-default-features --features jemalloc
//! ```
//!
//! `cargo run --release --features ... -- mem` reports peak RSS for a fixed retained set.

use serde::{Deserialize, Serialize};

#[cfg(feature = "mimalloc")]
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[cfg(feature = "jemalloc")]
#[global_allocator]
static GLOBAL: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;

pub const ALLOCATOR: &str = if cfg!(feature = "mimalloc") {
    "mimalloc"
} else if cfg!(feature = "jemalloc") {
    "jemalloc"
} else {
    "system (glibc malloc)"
};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Line {
    pub direction: String,
    pub amount: String,
    pub account: String,
    pub shard: u16,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Metadata {
    pub gateway: String,
    pub env: String,
    pub attempt: u32,
    pub tags: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PaymentEvent {
    pub id: String,
    pub ref_type: String,
    pub ref_id: String,
    pub amount: String,
    pub currency: String,
    pub description: String,
    pub lines: Vec<Line>,
    pub metadata: Metadata,
}

/// Deterministic sample: no RNG, so every allocator sees byte-identical data.
pub fn sample_event(seed: u32) -> PaymentEvent {
    let amount = format!("{:}.{:04}", 100 + (seed % 4900), seed % 10_000);
    let accounts = [
        "TREASURY",
        "GATEWAY_CLEARING",
        "PLATFORM_INCOME",
        "PROVIDER_FEE_EXPENSE",
        "MERCHANT_WALLET",
    ];
    let lines = accounts
        .iter()
        .enumerate()
        .map(|(index, account)| Line {
            direction: if index % 2 == 0 { "DEBIT" } else { "CREDIT" }.to_string(),
            amount: amount.clone(),
            account: (*account).to_string(),
            shard: (seed as u16 + index as u16) % 16,
        })
        .collect();
    PaymentEvent {
        id: format!("018f4c2a-0000-7000-8000-{:012x}", seed),
        ref_type: "PAYMENT_ATTEMPT".to_string(),
        ref_id: format!("pay_{seed:08}_lyd"),
        amount: amount.clone(),
        currency: "LYD".to_string(),
        description: "Platform-held confirmation with fee deducted at source".to_string(),
        lines,
        metadata: Metadata {
            gateway: "edfali".to_string(),
            env: "LIVE".to_string(),
            attempt: seed,
            tags: vec![
                "region:tripoli".to_string(),
                "channel:web".to_string(),
                format!("batch:{:02}", seed % 32),
            ],
        },
    }
}

/// One JSON document as the HTTP boundary would see it (~1.3 kB).
pub fn sample_json(seed: u32) -> String {
    serde_json::to_string(&sample_event(seed)).expect("serialise sample event")
}

/// Parse to an untyped `Value`, walk it, serialise it back: the generic body path.
pub fn value_roundtrip(json: &str) -> String {
    let value: serde_json::Value = serde_json::from_str(json).expect("parse event");
    // Touch nested values so the tree is materialised (as a handler/validator would).
    let mut total = 0usize;
    if let Some(lines) = value.get("lines").and_then(|v| v.as_array()) {
        for line in lines {
            if let Some(amount) = line.get("amount").and_then(|v| v.as_str()) {
                total += amount.len();
            }
        }
    }
    std::hint::black_box(total);
    serde_json::to_string(&value).expect("serialise value")
}

/// Typed path: deserialize into structs, serialise back (what a validated route does).
pub fn typed_roundtrip(json: &str) -> String {
    let event: PaymentEvent = serde_json::from_str(json).expect("deserialize event");
    serde_json::to_string(&event).expect("serialize event")
}

/// Many short-lived small allocations: the per-posting string/vec churn of a ledger posting.
pub fn churn_small(iterations: usize) -> usize {
    let mut checksum = 0usize;
    for index in 0..iterations {
        let mut parts: Vec<String> = Vec::with_capacity(4);
        parts.push(format!("pay_{index:08}_lyd"));
        parts.push("TREASURY".to_string());
        parts.push(format!("{:}.{:04}", 100 + index % 4900, index % 10_000));
        parts.push(format!("shard-{}", index % 16));
        checksum += parts.iter().map(String::len).sum::<usize>();
        std::hint::black_box(&parts);
    }
    checksum
}

/// Medium buffers: body decompression, statement parsing, report rows.
pub fn churn_medium(iterations: usize) -> usize {
    let mut checksum = 0usize;
    for index in 0..iterations {
        let buffer = vec![(index % 251) as u8; 4096];
        checksum += buffer.len();
        std::hint::black_box(&buffer);
    }
    checksum
}

/// Retained set for the memory probe: 20k events held in a Vec.
pub fn retain_events(count: u32) -> Vec<PaymentEvent> {
    (0..count).map(sample_event).collect()
}

/// Peak resident set in KiB (Linux `/proc/self/status`, `VmHWM`).
pub fn peak_rss_kib() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix("VmHWM:") {
            return rest.split_whitespace().next()?.parse().ok();
        }
    }
    None
}

//! Memory / smoke / bench modes.
//!
//! `cargo run --release [--features mimalloc|jemalloc] -- mem` reports peak RSS after a fixed
//! retained workload (20k events, ~80 MB of serde structs plus their strings);
//! `-- smoke` checks that every allocator produces the same bytes; `-- bench [seconds]` prints
//! ops/s for each workload so the allocators can be compared interleaved on a noisy host.

use allocator_bench::{
    churn_medium, churn_small, peak_rss_kib, retain_events, sample_json, typed_roundtrip,
    value_roundtrip, ALLOCATOR,
};
use std::hint::black_box;
use std::time::{Duration, Instant};

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_else(|| "mem".to_string());
    match mode.as_str() {
        "mem" => mem(),
        "smoke" => smoke(),
        "bench" => bench(),
        other => {
            eprintln!("unknown mode {other:?}; use `mem`, `smoke` or `bench`");
            std::process::exit(2);
        }
    }
}

/// Fixed-duration timing loop: cheap enough to run alternately for each allocator on a noisy
/// host. `--seconds N` controls the per-case measurement window (default 1s).
fn bench() {
    let seconds: f64 = std::env::args()
        .nth(2)
        .and_then(|v| v.parse().ok())
        .unwrap_or(1.0);
    let documents: Vec<String> = (0..64).map(sample_json).collect();
    let events: Vec<_> = (0..64).map(allocator_bench::sample_event).collect();

    println!("allocator={ALLOCATOR}");
    run_case("json_parse_to_value", 64, seconds, || {
        let mut n = 0usize;
        for document in &documents {
            let value: serde_json::Value = serde_json::from_str(document).unwrap();
            n += value.as_object().map(|o| o.len()).unwrap_or(0);
        }
        n
    });
    run_case("json_value_roundtrip", 64, seconds, || {
        let mut n = 0usize;
        for document in &documents {
            n += value_roundtrip(document).len();
        }
        n
    });
    run_case("json_typed_roundtrip", 64, seconds, || {
        let mut n = 0usize;
        for document in &documents {
            n += typed_roundtrip(document).len();
        }
        n
    });
    run_case("json_serialize", 64, seconds, || {
        let mut n = 0usize;
        for event in &events {
            n += serde_json::to_string(event).unwrap().len();
        }
        n
    });
    run_case("churn_small_1000", 1_000, seconds, || churn_small(1_000));
    run_case("churn_medium_250", 250, seconds, || churn_medium(250));
    run_case("mixed_burst", 1, seconds, || {
        let document = &documents[0];
        let value = value_roundtrip(document);
        let typed = typed_roundtrip(document);
        value.len() + typed.len() + churn_small(50)
    });
}

fn run_case(name: &str, ops_per_iteration: usize, seconds: f64, mut work: impl FnMut() -> usize) {
    // Warm up for a fifth of the measurement window.
    let warmup = Duration::from_secs_f64(seconds / 5.0);
    let started = Instant::now();
    let mut checksum = 0usize;
    while started.elapsed() < warmup {
        checksum ^= black_box(work());
    }
    let window = Duration::from_secs_f64(seconds);
    let started = Instant::now();
    let mut iterations = 0u64;
    while started.elapsed() < window {
        checksum ^= black_box(work());
        iterations += 1;
    }
    let elapsed = started.elapsed().as_secs_f64();
    let ops = iterations as f64 * ops_per_iteration as f64;
    println!(
        "case={name} iterations={iterations} ops={ops:.0} ops_per_s={:.0} ns_per_op={:.1} checksum={checksum}",
        ops / elapsed,
        elapsed * 1e9 / ops
    );
}

fn smoke() {
    let json = sample_json(42);
    let typed = typed_roundtrip(&json);
    let value = value_roundtrip(&json);
    assert_eq!(typed.len(), value.len());
    assert!(json.contains("\"ref_id\":\"pay_00000042_lyd\""));
    println!(
        "allocator={ALLOCATOR} doc_bytes={} typed_bytes={} churn={} medium={}",
        json.len(),
        typed.len(),
        churn_small(1_000),
        churn_medium(100)
    );
}

fn mem() {
    let count: u32 = std::env::var("ALLOC_EVENTS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(20_000);
    // Warm every code path first so first-touch/COW pages do not dominate the peak.
    let warm = retain_events(1_000);
    std::hint::black_box(&warm);
    drop(warm);
    churn_small(10_000);
    churn_medium(1_000);

    let before = peak_rss_kib().unwrap_or(0);
    let retained = retain_events(count);
    let checksum: usize = retained
        .iter()
        .map(|event| {
            event
                .lines
                .iter()
                .map(|line| line.account.len())
                .sum::<usize>()
        })
        .sum();
    let after = peak_rss_kib().unwrap_or(0);
    println!(
        "allocator={ALLOCATOR} events={count} checksum={checksum} peak_rss_before_kib={before} peak_rss_after_kib={after} peak_rss_delta_kib={}",
        after.saturating_sub(before)
    );
    std::hint::black_box(&retained);
}

# Allocator micro-benchmark (P0-T09)

Standalone Cargo project (empty `[workspace]` so it is not a member of `backend-rs/`) that compares the
system allocator, [`mimalloc`](https://crates.io/crates/mimalloc) and
[`tikv-jemallocator`](https://crates.io/crates/tikv-jemallocator) on the allocation shapes the port
actually performs:

- `serde_json` parse to `Value`, typed `Deserialize`/`Serialize`, serialise back (the HTTP body path);
- many short-lived `String`/`Vec` allocations per iteration (the ledger posting path);
- 4 KiB buffer churn (decompression, statement and report parsing);
- a fixed retained set for peak-RSS measurement.

The allocator is a compile-time feature so every build runs byte-identical input:

```bash
cd backend-rs/tools/allocator-bench

# Correctness smoke (any allocator)
cargo run --release -- smoke

# Peak RSS for 20k retained events
cargo run --release -- mem
cargo run --release --features mimalloc -- mem
cargo run --release --features jemalloc -- mem

# Criterion (JSON + churn), short sampling
cargo bench --no-default-features -- --warm-up-time 1 --measurement-time 5 --sample-size 50
cargo bench --no-default-features --features mimalloc -- --warm-up-time 1 --measurement-time 5 --sample-size 50
cargo bench --no-default-features --features jemalloc -- --warm-up-time 1 --measurement-time 5 --sample-size 50
```

The release profile matches `backend-rs/Cargo.toml` (`lto = "fat"`, `codegen-units = 1`).

Results and the decision are recorded in `backend-rs/BENCHMARKS.md`. Run the three variants in a quiet
window on the same machine; do not compare numbers taken while another build is running.

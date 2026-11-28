# Rust benchmarks

Measured with the real TS harnesses on this host; Rust numbers appear only after a Rust run
(P5-T04 and later). A missed target is profiled and either fixed or accepted in `DEVIATIONS.md`.

## Environment

Run of **2026-11-28** (all times UTC), git `e1ea5df` plus the uncommitted `backend-rs/` work tree.

| Item | Value |
| :--- | :--- |
| Hardware | Intel Core Ultra 7 256V, 8 logical CPUs (8 cores, 1 thread/core, 1 socket), 15.2 GiB RAM (15,914,608 kB), no swap |
| OS / kernel | Ubuntu 26.04.1 LTS under **WSL2** (`6.18.33.2-microsoft-standard-WSL2`) |
| Bun | 1.4.4 |
| Rust | 1.100.1 (only for the P0-T09 allocator benchmark) |
| PostgreSQL | 18.6 (Ubuntu 18.6-0ubuntu0.26.04.1), x86_64, gcc 15.2.0 |
| Redis | 8.0.5 (only BL-2 uses it) |
| Provided database | `postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test`, schema version 46 |

**Host-contention warning.** This box is shared with other port agents. During these runs other
agents were running `cargo build --release`, `cargo clippy` and `cargo test` on the same 8 CPUs
(load average 2.9-14.5; observed 1-minute load is noted per run). Absolute numbers are therefore a
lower bound and run-to-run variance is ±20-30% on the multi-poster levels. Allocator numbers were
taken interleaved (A/B/A/B…) to keep the comparison fair under the same host load.

## Method

- BL-1 uses the real production write path (`createLedgerPoster`: journal entry + lines + shard
  projection + transactional outbox in one transaction), one prefix per level, 2 s warm-up and a
  15 s measured window, with 5% duplicate replays to prove idempotency.
- After every level the harness proves **D1** every entry balances, **D2** exactly one entry per
  refId, **D3** shard totals equal journal lines for every touched account, **D4** one
  `ledger.entry_posted` outbox event per entry, **D5** total debit = total credit.
- BL-2 is `scripts/run-benchmarks.sh` unchanged (storage-engine performance suite, then the full
  storage-engine regression, then backup control-plane tests). p50/p95 are printed by the suites.
- No number is copied from a previous report; everything below was produced in this run.

## BL-1 — ledger posting (TS baseline)

### Setup

The provided shared cluster has `max_connections=100`; the harness requests
`4 × (32 + 2) + 5 = 141` connections at the 128-poster level, so level 128 cannot run there. The
recorded runs use a **twin cluster** created from the provided database, same PostgreSQL build and
the same memory/WAL settings, with `max_connections=300`:

```bash
export PGBIN=/usr/lib/postgresql/18/bin
rm -rf /tmp/opencode/pg-bl1
$PGBIN/initdb -D /tmp/opencode/pg-bl1 -U postgres --auth=trust --no-locale -E UTF8
mkdir -p /tmp/opencode/pg-bl1-sock
$PGBIN/pg_ctl -D /tmp/opencode/pg-bl1 -l /tmp/opencode/pg-bl1-server.log \
  -o "-p 55433 -k /tmp/opencode/pg-bl1-sock -c listen_addresses=127.0.0.1 \
      -c max_connections=300 -c shared_buffers=128MB -c max_wal_size=1GB \
      -c wal_level=replica -c fsync=on -c synchronous_commit=on -c autovacuum=on" start

pg_dump "postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test" \
  --no-owner --no-privileges -Fc -f /tmp/opencode/pg_bl1_source.dump
psql "postgresql://postgres@127.0.0.1:55433/postgres" -c "CREATE DATABASE pg_bl1_load;"
pg_restore --no-owner --no-privileges --schema-only -d \
  "postgresql://postgres@127.0.0.1:55433/pg_bl1_load" /tmp/opencode/pg_bl1_source.dump
pg_restore --no-owner --no-privileges --data-only -t schema_versions -d \
  "postgresql://postgres@127.0.0.1:55433/pg_bl1_load" /tmp/opencode/pg_bl1_source.dump

# Harness prerequisite that the script does not create: a platform-wide provider-fee account for
# the posting currency (the provided database already has one from the seed).
psql "postgresql://postgres@127.0.0.1:55433/pg_bl1_load" -c \
  "INSERT INTO gl_accounts (id, updated_at, account_type, currency, shard_count, seed_key) \
   VALUES (gen_random_uuid(), CURRENT_TIMESTAMP, 'PROVIDER_FEE_EXPENSE', 'LYD', 16, \
           'system:PROVIDER_FEE_EXPENSE');"
```

The twin cluster was dropped after the runs. Settings: `shared_buffers=128MB`,
`max_wal_size=1GB`, `fsync=on`, `synchronous_commit=on`, `wal_level=replica`, `autovacuum=on`,
`checkpoint_timeout=300` (default).

A first attempt on a schema-only copy without the provider-fee account failed every post with
`GL_ACCOUNT_NOT_FOUND: No PROVIDER_FEE_EXPENSE account matched the posting context` (0 created,
23k-30k errors per level). That is a harness setup prerequisite, not a code defect; the account
exists in the provided database.

Exact command (three runs; run 1 also covered 1/16/64):

```bash
cd core-back
DATABASE_URL="postgresql://postgres@127.0.0.1:55433/pg_bl1_load" \
LOAD_LEVELS=1,8,16,32,64,128 LOAD_DURATION_S=15 LOAD_PROCS=4 LOAD_WALLETS=500 LOAD_WARMUP_S=2 \
bun run test/load/ledger-load.ts

# repeat for stability
DATABASE_URL="postgresql://postgres@127.0.0.1:55433/pg_bl1_load" \
LOAD_LEVELS=8,32,128 LOAD_DURATION_S=15 LOAD_PROCS=4 LOAD_WALLETS=500 LOAD_WARMUP_S=2 \
bun run test/load/ledger-load.ts
```

On the provided shared cluster only a smoke level was run (concurrency 2, 3 s, 1 process,
10 wallets): **757 posts/s**, created 718/s, p50 2.4 ms, p95 4.6 ms, p99 7.0 ms, 0 errors, D1-D5
PASS. Its larger levels were discarded because they collided with a concurrent Rust build.

### Results

Run 1: 2026-11-28T10:55:14Z, load average 3.96 (falling from a just-finished build), all levels.
Run 2: 2026-11-28T10:57:20Z, load average not recorded at start (other agents' builds were active
during the window), 8/32/128.
Run 3: 2026-11-28T11:02:07Z, load average 4.51 (no compiler process active at start), 8/32/128.
Latency columns are from the run that produced the median throughput (run 1 for 1/16/64, run 3
for 8/32/128).

| Posters | Run 1 posts/s | Run 2 posts/s | Run 3 posts/s | Median posts/s | Created/s | p50 ms | p95 ms | p99 ms | Errors (of 3 runs) | D1-D5 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :--- |
| 1 | 363 | — | — | 363 | 347 | 2.5 | 4.6 | 6.4 | 0 | PASS |
| 8 | 1,138 | 952 | 1,030 | **1,030** | 977 | 6.1 | 18.1 | 28.2 | 0 | PASS |
| 16 | 1,067 | — | — | 1,067 | 1,014 | 10.5 | 41.9 | 71.7 | 0 | PASS |
| 32 | 563 | 692 | 632 | **632** | 602 | 27.0 | 170.2 | 310.8 | 0 | PASS |
| 64 | 745 | — | — | 745 | 709 | 34.3 | 326.6 | 608.5 | 0 | PASS |
| 128 | 621 | 468 | 581 | **581** | 552 | 83.2 | 796.7 | 1,524.8 | one in run 2, one in run 3 | PASS (see note) |

`posts/s` counts every completed posting including idempotent replays; `Created/s` counts new
entries only.

Run 1 p95/p99 for the extra levels: 1 → 4.6/6.4 ms; 16 → 41.9/71.7 ms; 64 → 326.6/608.5 ms.
Run 1 level 128: 621 posts/s, p50 81.0, p95 800.5, p99 1,491.2 ms, 0 errors.
Earlier reference point (not re-measured here): GAP-065 reported ~877 posts/s at 8 posters on a
3.7 GB WSL VM.

Whole-run CPU (run 3, `/usr/bin/time`): user 107.39 s + sys 26.81 s = **134.2 s CPU**, wall 57.12 s,
max RSS 240,600 kB for the 4 worker processes. Run 3 counted 32,161 new entries plus 1,706
idempotent replays (33,867 postings) across its three levels, plus 2 s of warm-up per level and 500
seeded wallet accounts, i.e. roughly **4.0 ms of CPU per posting** (4.2 ms per new entry) for the
whole process tree — consistent with GAP-065's 6-7 ms per posting on a slower VM. This is not a pure
per-posting CPU figure (it includes seeding, warm-up and idle polling); the three recorded runs
created 126,839 entries in 133,501 postings.

### Invariants

Every level of every run passed D1-D5, with details like `entries=15280 distinct=15280`,
`outbox=15280 entries=15280`, `debit=38194274.4102 credit=38194274.4102`, and 504 accounts matching
on D3 (3 platform accounts + hot wallet + 500 wallets). No replay created a second entry
(`duplicateMismatch=0`).

The 128-poster level is marked **FAIL** by the script in runs 2 and 3 because `errors=1`: one
posting exceeded Prisma's 5 s interactive-transaction budget under host load
(`P2028: … The timeout for this transaction was 5000 ms, however 5298 ms / 5640 ms passed`). The
errored post did not commit (`workers saw N succeed (+1 errored)`, `entries=N`), so D1-D5 still
held; this is a latency/queueing failure at 128-way concurrency on a contended 8-core host, not a
ledger drift. Those two are the only errors observed in ~133,000 postings across the three recorded
runs.

### Notes

- Throughput peaks at 8 posters (~1,030/s) and falls at 32+ while p95/p99 grow sharply. The
  precise cause was not isolated: at 20% hot-wallet share every posting to the single-shard hot
  wallet serialises on one row, and the platform accounts have only 16 shards each, so 32-128
  posters queue on a small set of rows. A hot-wallet-off diagnostic was run but was invalidated by
  a concurrent build (it measured 783/s at 32 and 423/s at 128) and is not used.
- The database grows by ~33,000-35,000 entries per three-level run (563 MB after four runs); the
  harness does not clean up, by design.
- Target S1 (≥ 4,500 postings/s on one core node) is a **Rust** target; the TS baseline is
  ~1,000/s on this host. S2 (≤ 1.0 ms application CPU per posting) is likewise Rust-only.

## BL-2 — storage engine (TS baseline)

Command (run 2 of the script, 2026-11-28T11:10:48Z, load average 2.87 at start):

```bash
DATABASE_URL="postgresql://postgres@127.0.0.1:55432/pg_bench_ts" \
STORAGE_TEST_REDIS_URL="redis://127.0.0.1:56379" \
./scripts/run-benchmarks.sh
```

`pg_bench_ts` is a throwaway copy of `payment_gateway_monolith_test`
(`CREATE DATABASE pg_bench_ts TEMPLATE payment_gateway_monolith_test`), dropped afterwards. The
script exited 0: performance 27/27 pass, full storage-engine 136/136 pass, backup-admin 26/26 pass.

| Metric | Measured (dedicated perf pass) | Repeat, same run inside the 17-file regression | Bound | Unit |
| :--- | ---: | ---: | ---: | :--- |
| UoW 500 sequential (outbox + audit) | 1,785.6 | 1,381.1 | < 10,000 | ms |
| UoW 50 concurrent p95 | 99.4 | 74.0 | < 500 | ms |
| Outbox drain 1,000 events | 34.1 | 19.0 | < 5,000 | ms |
| Shard 16-row query median | 0.5 | 0.2 | < 50 | ms |
| Audit 1,000 append + verify | 262.1 | 198.8 | < 5,000 | ms |
| Redis velocity 1,000 evaluations | 113.6 | 96.2 | < 3,000 | ms |
| compareLsn 1,000,000 ops median | 254.2 | 268.0 | < 1,000 | ms |
| uuidv7 100,000 ids median | 295.1 | 289.7 | < 2,000 | ms |
| stableJson 10,000 rows median | 19.3 | 13.5 | < 2,000 | ms |
| Memory velocity 10,000 evaluations | 4.0 | 1.9 | < 2,000 | ms |
| Read-store routing 100,000 selections | 1.1 | 1.3 | < 1,000 | ms |
| 300 transactional audit writes (audit_log + audit_outbox) | 1,386.4 | 709.9 | < 10,000 | ms |
| Shard balance read p95 (two accounts) | 0.93 | 0.68 | < 25 | ms |

All bounds passed in both observations. The second column is not a re-run of a quiet system: it is
the same metrics emitted while the full 17-file storage-engine suite ran its files concurrently, so
its lower values show that these tests are not CPU-saturated by one another; neither column is a
certified baseline. An earlier attempt at 11:04 UTC (load average 14.5) failed with a 5 s Bun test
timeout on "500 sequential UoWs" (`7012 ms` measured, test bound 10 s) — a host-load artefact,
fixed by re-running in the quieter window above.

## BL-3 … BL-9 availability

| ID | Status | Reason |
| :--- | :--- | :--- |
| BL-3 checkout initiate/confirm | **not measured** | Requires a deployed lab (`pgctl lab checkout-stress` is not implemented yet; the TS gate needs SSH-reachable lab hosts). No lab host was available. |
| BL-4 edge overhead (`oha`) | **not measured** | `oha` is not installed on this host and no edge + stub-core listener was set up; a hand-written load client would not be comparable with the documented tool. |
| BL-5 hot reads | **not measured** | Requires a running core + edge on a populated database and a load generator; the local stack is not under test here and `oha` is absent. |
| BL-6 memory during BL-3/BL-5 | **not measured** | Depends on BL-3/BL-5. |
| BL-7 1k/5k SSE streams | **not measured** | Requires the running stack and a client holding thousands of streams; not run. |
| BL-8 workers | **partial** | Outbox drain (34.1 ms/1,000), audit chain append+verify (262.1 ms/1,000) and Redis Lua velocity (113.6 ms/1,000) are measured under BL-2. Merchant webhook delivery throughput is **not measured** (needs a running core and a receiver). |
| BL-9 deploy | **not measured** | `pgctl stress` is not implemented; the TS deploy stress harness needs SSH targets. |

## Rust baseline table (to fill on the Rust run)

| ID | Scenario | TS baseline | Rust run 1 | Notes |
| :--- | :--- | :--- | :--- | :--- |
| BL-1 | ledger posting, 1 poster | 363 posts/s, p95 4.6 ms | TODO | |
| BL-1 | ledger posting, 8 posters | 1,030 posts/s, p95 18.1 ms | TODO | S1 target ≥ 4,500/s; S2 ≤ 1.0 ms CPU/posting |
| BL-1 | ledger posting, 32 posters | 632 posts/s, p95 170.2 ms | TODO | |
| BL-1 | ledger posting, 128 posters | 581 posts/s, p95 796.7 ms, one P2028 error in each of runs 2 and 3 | TODO | |
| BL-3 | edge proxy GET | TODO | TODO | |
| BL-4 | checkout initiate | TODO | TODO | |
| BL-5 | admin list page | TODO | TODO | |
| BL-7 | 5k SSE streams | TODO | TODO | |

## P0-T09 — allocator decision

### Method

Standalone project `backend-rs/tools/allocator-bench` (own `[workspace]`, no workspace edit; see
its `README.md`). Workload: 64 deterministic ~0.7 kB JSON documents parsed to `serde_json::Value`,
walked and re-serialised; typed `Deserialize`/`Serialize` round trips; 1,000 short-lived
`String`/`Vec` allocations; 250 × 4 KiB buffer churns; mixed bursts. Release profile matches
`backend-rs` (`lto = "fat"`, `codegen-units = 1`).

Allocator is a compile-time feature (`system` glibc malloc, `mimalloc` 0.1, `tikv-jemallocator`
0.6). Run on 2026-11-28, load average 7.5-10.9 (other agents' cargo jobs). **jemalloc could not be
built**: `tikv-jemalloc-sys` needs `make`, which is not installed on this host
(`failed to execute command: No such file or directory`, `build.rs:407`); `perl` alone is not
enough. Only system vs mimalloc is measured and jemalloc stays an open comparison.

Interleaved runs: 5 × `allocator-bench bench 1` per allocator, alternating; median ops/s shown. A
second harness (criterion, 2 rounds each, 3 s measurement, 1 s warm-up, 30 samples) is shown beside
it so the direction can be checked independently.

### Results — JSON/serde path

| Case | System ops/s (median) | mimalloc ops/s (median) | mimalloc / system |
| :--- | ---: | ---: | ---: |
| `json_parse_to_value` (64 docs) | 430,738 | 494,888 | **1.15×** |
| `json_value_roundtrip` (parse → serialise) | 308,747 | 403,513 | **1.31×** |
| `json_typed_roundtrip` | 623,528 | 636,071 | **1.02×** |
| `json_serialize` | 1,317,048 | 1,588,722 | **1.21×** |
| `mixed_burst` (body + typed + churn) | 75,759 | 92,385 | **1.22×** |
| `churn_small_1000` (1k short strings) | 7,204,221 | 8,171,927 | 1.13× (noisy) |
| `churn_medium_250` (250 × 4 KiB) | 22,486,396 | 19,269,628 | 0.86× (noisy) |

Criterion (median of the two runs, per-batch time; lower is better):

| Benchmark | System | mimalloc | mimalloc / system |
| :--- | ---: | ---: | ---: |
| `json/parse_to_value` | 173.23 µs | 104.84 µs | **0.61×** |
| `json/value_roundtrip` | 242.20 µs | 162.39 µs | **0.67×** |
| `json/typed_roundtrip` | 128.03 µs | 106.81 µs | **0.83×** |
| `json/serialize` | 36.24 µs | 33.88 µs | 0.94× |
| `alloc/mixed_burst` | 12.19 µs | 9.84 µs | **0.81×** |
| `alloc/churn_small_1000` | 104.25 µs | 133.38 µs | 1.28× (contradicts above) |
| `alloc/churn_medium_250` | 16.58 µs | 11.65 µs | 0.70× (contradicts above) |

The two harnesses agree on the JSON path (mimalloc 1.02-1.65× faster, largest on parse and
round-trip) and on `mixed_burst`. They disagree on the two pure-churn cases, and the standalone
churn values swing 108-172 ns/op within one allocator across rounds — those cases are dominated by
host noise and are not used for the decision.

### Results — peak RSS (20,000 retained events, 5 runs each, stable)

| Allocator | Idle RSS | Peak RSS | Delta |
| :--- | ---: | ---: | ---: |
| system (glibc) | 3.5-3.7 MiB | 34,352-34,372 KiB (median 34,368) | ~30.6-30.8 MiB |
| mimalloc | 8.7-8.8 MiB | 28,384-28,416 KiB (median 28,400) | ~19.6 MiB |

mimalloc pays ~5 MiB more at idle but peaks **17% lower** at load; the retained-set delta is **36%
lower**. For a server process the at-load figure is the one that matters.

### Decision summary

| Allocator | JSON/serde path | Peak RSS at load (20k events) | Build requirement | Verdict |
| :--- | :--- | :--- | :--- | :--- |
| system (glibc malloc) | baseline | 34.4 MiB | none (std) | fallback |
| **mimalloc** | **1.02-1.65× faster** | **28.4 MiB** | `cc` only | **chosen** |
| jemalloc | not measured | not measured | `make` (absent) | open comparison |

### Decision

**Use `mimalloc` as the global allocator of the Rust port.** It is faster on the JSON/serde request
path in both harnesses (median +2% to +65% depending on the case, consistently on parse and
round-trip), lowers peak RSS at load by ~17%, and needs only `cc` (already required), whereas
jemalloc needs `make`. The allocator must be declared once in the real binary crates
(`#[global_allocator]`) with the same `mimalloc` feature pattern; the `pg-types` library itself
stays allocator-agnostic.

Open items: (1) jemalloc is unmeasured until `make` is available — re-run this project on that host
and on B-lab; (2) absolute numbers here are contended-host lower bounds, so the P5-T04 ledger
target must be measured on a quiet machine; (3) worker-thread count is unchanged — `HTTP_WORKERS`
still defaults to logical cores until the physical-core probe lands (P3-T07).

## Decisions

- Allocator: **mimalloc**, measured above (P0-T09). jemalloc pending a host with `make`.
- Worker threads: `HTTP_WORKERS` defaults to logical cores until the physical-core probe lands
  (P3-T07).
- Ledger target (S1/S2) remains a Rust acceptance target; the TS baseline on this host is ~1,000
  postings/s at 8 posters and ~4.0 ms CPU per posting, so the Rust implementation must be measured
  on the same host before any target is claimed.

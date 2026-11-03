---
id: testing.benchmarks
title: Benchmarks and Performance Gates
status: partial
confidence: high
last_verified: 2026-11-03
verified_against: 5a24f6f+working-tree
code:
  - scripts/run-benchmarks.sh
  - core-back/test/storage-engine/performance/write-path-benchmark.test.ts
  - core-back/test/storage-engine/performance/storage-performance.test.ts
  - core-back/test/storage-engine/read-store.test.ts
  - core-back/test/storage-engine/uow.test.ts
  - deploy/backup-daemon/test/**
design_sources:
  - design/performance-efficiency/storage_driver_postgres18_backup_and_scaling_architecture.md#7-testing-and-benchmarks
  - design/master_exhaustive_test_plan_for_opencode.md#10-suite-09-postgresql-18-storage-engine-replicas-auditlog-databases-backups-restore-drills-900-tests
tests:
  - core-back/test/storage-engine/performance/write-path-benchmark.test.ts
  - core-back/test/storage-engine/performance/storage-performance.test.ts
  - core-back/test/storage-engine/read-store.test.ts
  - deploy/backup-daemon/test/restoreDrillRunner.test.ts
gaps:
  - No sustained TPS or throughput benchmark exists.
  - No live replica failover or LSN-lag benchmark exists.
  - No deep-search latency or trigram benchmark exists.
  - No restore-duration or backup-throughput benchmark exists.
  - No synthetic-seeder volume or runtime benchmark exists.
  - Performance tests skip without PostgreSQL/Redis and do not fail CI on skip.
---

# Benchmarks and Performance Gates

## 1. Purpose and scope

This part documents the performance measurements that actually exist, the thresholds they enforce, the runner they use, and the missing benchmarks needed to support the platform's scaling and restore claims.

It covers storage write-path, storage primitives, outbox, shard reads, audit-chain, Redis velocity and the backup/restore test surface. It does not cover correctness suites (`testing.suites`) or fixtures (`testing.fixtures`).

## 2. Design intent (extracted and synthesized from ./design)

The storage design targets:

- 50 million to 500 million+ financial records.
- 1,000+ sustained transactions per second.
- Sub-5 ms read latency.
- Horizontal scaling from one to N nodes per tier.
- LSN-aware replica reads with primary fallback.
- 16-way GL shard locking without hot-row deadlocks.
- A SHA-256 audit chain and a non-blocking log sink.
- Backup/restore drills that verify double-entry zero drift, shard parity and audit-chain integrity.

The exhaustive plan's Suite 09 asks for about 900 tests covering unit-of-work atomicity, shard concurrency, LSN routing, Redis velocity, audit/log databases, backup control and a scratch restore drill. The plan requires tests that need a replica or daemon to skip explicitly, not pass silently.

## 3. As-built architecture

### 3.1 Runner

`scripts/run-benchmarks.sh`:

- Requires `DATABASE_URL`, `POSTGRES_TEST_DATABASE_URL` or `STORAGE_TEST_DATABASE_URL`; exits 2 otherwise.
- Optionally honours `BENCHMARK_FILTER`.
- Runs `bun test test/storage-engine/performance` (or filtered).
- Runs `bun test test/storage-engine` as a full regression.
- Runs `bun test test/backup-admin`.
- Does **not** run the backup daemon, the frontend, the seeder, search or the fake rails tier.
- Does **not** accept a Redis URL argument; Redis is read from `STORAGE_TEST_REDIS_URL` (default 56379).

The script prints p50/p95 where the tests do and summarizes the result. It does not compare against a stored baseline, fail on regression beyond the hard-coded bounds, or persist a report.

### 3.2 Write-path benchmark

`core-back/test/storage-engine/performance/write-path-benchmark.test.ts` runs only with a reachable PostgreSQL:

| Test | Assertion | Reported value |
| :--- | :--- | :--- |
| 300 transactional audit writes with `audit_outbox` | Under 10 s | `[benchmark] 300 writeAudit (audit_log + audit_outbox)` |
| Shard balance reads for a 16-shard account, 120 posts, 50 samples | p95 under 25 ms | `[benchmark] shard balance read p95 (two accounts)` |

It uses real `writeAudit`, `createLedgerPoster` and `loadShardBalanceRows`. It cleans audit rows and ledger data in `finally`.

### 3.3 Storage primitive performance

`core-back/test/storage-engine/performance/storage-performance.test.ts` has a pure section that runs without a database:

| Test | Assertion | Reported value |
| :--- | :--- | :--- |
| `compareLsn` 1,000,000 operations | Median under 1,000 ms | `[perf] compareLsn 1M median` |
| `uuidv7` 100,000 ids | Median under 2,000 ms | `[perf] uuidv7 100k median` |
| `stableJson` 10,000 rows | Median under 2,000 ms | `[perf] stableJson 10k median` |
| Memory cache sliding-window evaluation 10,000 times | Median under 2,000 ms | `[perf] memory velocity 10k median` |
| Read-store routing selection 100,000 times with 3 fake replicas | Median under 1,000 ms | `[perf] read routing 100k median` |

The read-routing test uses empty client objects. It measures selection arithmetic, not a database read or replica network hop.

### 3.4 PostgreSQL storage performance

With a reachable database, the same file measures:

| Test | Assertion | Reported value |
| :--- | :--- | :--- |
| 500 sequential unit-of-work transactions with outbox and audit | Under 10 s | `[perf] UoW 500 sequential` |
| 50 concurrent unit-of-work transactions | p95 under 500 ms | `[perf] UoW 50 concurrent p95` |
| Outbox drain of 1,000 events | Under 5 s | `[perf] outbox drain 1000` |
| 16 shard rows load plus EXPLAIN | Median under 50 ms and no sequential scan | `[perf] shard 16-row query median` |
| 1,000-row audit hash-chain append plus verification | Under 5 s | `[perf] audit 1000 append+verify` |

The outbox test inserts 1,000 rows in four raw batches and runs `OutboxRelayWorker.drain()`. The shard test runs `EXPLAIN` and requires an index scan or bitmap scan. The audit test uses the dedicated audit sandbox driver.

### 3.5 Redis performance

With a reachable Redis:

| Test | Assertion | Reported value |
| :--- | :--- | :--- |
| 1,000 sliding-window evaluations via `RedisCacheAdapter` | Under 3 s | `[perf] redis velocity 1k` |

### 3.6 Replica and backup tests that are not benchmarks

`core-back/test/storage-engine/read-store.test.ts` has a broad correctness suite for:

- Primary reads.
- Healthy replica selection and lag reporting.
- Round-robin across replicas.
- Lag-threshold rejection and primary fallback.
- `{ atLeastLsn }` selection.
- Watermark waiting with a timeout.
- Mid-flight replica error, unhealthy marking and fallback.
- Empty replica pool.
- Watermark parsing and two-failure degradation.

These are fake-replica unit tests. They do not measure real replication lag or failover time.

`deploy/backup-daemon/test/restoreDrillRunner.test.ts` (10 declarations) verifies drill orchestration and report logic. It does not measure restore duration, WAL replay time or backup throughput.

### 3.7 What is not measured

The following design claims have no benchmark or load test:

- **1,000+ sustained TPS.** No multi-process or multi-connection throughput harness.
- **50M-500M row performance.** Tests use small synthetic batches (hundreds to thousands).
- **Sub-5 ms read latency.** No p50/p95 measurement of real list, dashboard or search queries at volume.
- **Replica reads.** Only `pickHealthyReplica` arithmetic and fake clients are measured; no live streaming replica.
- **Deep search.** No trigram index, plug-in fan-out, Arabic normalisation or relevance-latency benchmark.
- **Restore drills.** No timed scratch restore, no WAL replay measurement, no backup upload/download throughput.
- **Backup daemon.** No benchmark of pgBackRest/WAL-G/Barman invocation, compression, encryption or retention pruning.
- **Synthetic seeder.** No measurement of 3.5-year history generation, batch size, memory, or bulk-sync runtime.
- **Fake rails.** No throughput or webhook-delivery benchmark.
- **Frontends.** No bundle-size, first-render, search-index build or table-render benchmark beyond Playwright geometry.
- **Concurrency soak.** No long-running mixed workload, connection-pool exhaustion, lock-wait percentile or deadlock-rate test.

### 3.8 Strategy to add the missing benchmarks

Add benchmarks in this order so each one answers a real capacity question rather than inflating the suite:

1. **Throughput harness.** Create a dedicated load script (not a `bun test` file) that drives mixed checkout writes, webhook intake, list reads and ledger posts for 10-30 minutes at increasing concurrency. Record p50/p95/p99 latency, achieved TPS, error rate, connection-pool saturation and PostgreSQL CPU/WAL. Acceptance: a repeatable profile with a 1,000 TPS target and a documented hardware baseline.
2. **Volume dataset.** Seed a staging database with at least 10 million attempts and journal lines, then measure the hot list, dashboard, search and reconciliation queries. Acceptance: p95 read latency and query plans recorded at 10M and 100M rows.
3. **Replica benchmark.** Provision one or more real streaming replicas. Measure replication lag, `{ atLeastLsn }` wait time, fallback rate and failover duration under write load. Acceptance: a live-replica report; fake handles no longer count as replica evidence.
4. **Deep search.** Build the trigram indexes and all search plugins, then measure build time, index size, p50/p95 query time and top-k relevance for English and Arabic queries at 1M/10M merchants and attempts. Acceptance: a relevance fixture and latency thresholds.
5. **Restore drill.** Time a scratch restore from each backup target, including WAL replay, then run ledger invariant, shard parity and audit hash-chain verification. Acceptance: a signed report with duration, replayed LSN, row counts and pass/fail.
6. **Seeder and fake rails.** Measure seeder generation and fake-rails bulk sync at COMPACT, STANDARD and profile volumes; measure webhook queue drain and duplicate delivery. Acceptance: a per-profile runtime and memory report.
7. **Frontend budgets.** Add bundle-size, first-contentful-paint, search-index build and large-table render budgets to the UI suite. Acceptance: CI-enforced budgets, not only geometry checks.

Each benchmark must print a machine-readable report (JSON) in addition to console output, and CI must store it as an artifact. A skipped or missing database must fail a release-candidate gate, not silently pass.

## 4. Contracts and invariants

1. **A benchmark requires a real database.** The runner refuses to start without a database URL.
2. **Redis performance is optional.** It skips when Redis is absent, and the skip is printed by Bun's runner.
3. **Thresholds are generous regression guards, not capacity claims.** Passing them does not prove the design's TPS or scale targets.
4. **Reported values must be compared across runs on the same hardware.** No baseline file exists.
5. **Benchmarks must clean up.** Each DB test removes its ledger/outbox/audit rows or uses a sandbox schema.
6. **A skipped benchmark is not a passing benchmark.** CI must report it.

## 5. Data / API / config / deployment surface

| Item | Value |
| :--- | :--- |
| Runner | `scripts/run-benchmarks.sh` |
| Database URL inputs | `DATABASE_URL`, `POSTGRES_TEST_DATABASE_URL`, `STORAGE_TEST_DATABASE_URL` |
| Redis URL input | `STORAGE_TEST_REDIS_URL` |
| Filter | `BENCHMARK_FILTER` |
| Performance directory | `core-back/test/storage-engine/performance` |
| Regression directories | `core-back/test/storage-engine`, `core-back/test/backup-admin` |
| Backup daemon tests | `deploy/backup-daemon/test` (not run by the benchmark script) |

The expected local services are PostgreSQL 18 on 55432 and Redis on 56379, matching the storage helpers.

## 6. Operational usage

```bash
# Required database
export DATABASE_URL=postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test

# Optional Redis
export STORAGE_TEST_REDIS_URL=redis://127.0.0.1:56379

# All storage benchmarks and regression targets
./scripts/run-benchmarks.sh

# Only one benchmark family
BENCHMARK_FILTER=write-path ./scripts/run-benchmarks.sh

# Run the backup daemon tests separately
cd deploy/backup-daemon && bun test
```

Run on an idle machine, record the printed values, and compare with the previous run. Do not run benchmarks concurrently with the DB test suites; they contend for the same database and the same worker budget.

## 7. Status and deviations

### Implemented

- A dedicated storage benchmark runner with DB URL guards.
- Write-path audit and shard-read thresholds.
- Pure primitive microbenchmarks.
- UoW sequential/concurrent, outbox drain, shard query-plan and audit-chain measurements.
- Redis velocity measurement.
- Replica-routing correctness tests with fake replicas.
- Backup/restore drill logic tests.

### Partial

- The benchmark set covers storage only.
- Replica routing is measured only as selection arithmetic.
- Backup tests assert logic, not duration or throughput.
- The runner does not execute the backup daemon, deploy, seeder or search.
- Thresholds are absolute, not baseline-relative.

### Missing / deferred

- Sustained TPS/throughput harness with mixed read/write traffic.
- Large-volume dataset benchmark (millions of ledger rows, partitioned journals, trigram search).
- Live replica failover, LSN wait and lag percentile benchmark.
- Deep-search p50/p95 and relevance benchmark across all plugin groups.
- Timed scratch restore drill with WAL replay, invariant, shard parity and audit-chain checks.
- Backup daemon throughput, compression, encryption, retention and pruning benchmark.
- Synthetic-seeder volume/runtime benchmark.
- Fake-rails webhook throughput and queue-drain benchmark.
- Frontend bundle, first-render and search-index build benchmarks.

### Known bugs / risks

- **False capacity claim:** the design's 1,000+ TPS and sub-5 ms read targets are not tested.
- **False green:** DB/Redis benchmarks skip when services are absent; the runner still exits successfully.
- **Regression blindness:** no stored baselines or statistical comparison.
- **Environment sensitivity:** thresholds are generous enough that a 5-10x regression on a fast machine may still pass.

## 8. Verification and tests

Existing benchmark files are the verification. They are not run by this documentation task.

- `write-path-benchmark.test.ts` — 2 tests, both DB-gated.
- `storage-performance.test.ts` — 5 pure tests, 6 DB tests and 1 Redis test, with explicit skip placeholders.
- `read-store.test.ts` — correctness, not timing.
- `uow.test.ts` — correctness plus two local timing assertions without a hard threshold.
- `restoreDrillRunner.test.ts` — drill logic.

A run must state whether PostgreSQL and Redis were available. Without both, the result is a partial benchmark, not a capacity statement.

## 9. Source references

### Old design sections

- `design/performance-efficiency/storage_driver_postgres18_backup_and_scaling_architecture.md` section 7.
- `design/master_exhaustive_test_plan_for_opencode.md` Suite 09.
- `design/master_exhaustive_test_plan_for_opencode.md` Suite 11 for seeder/deploy volume.

### Code paths

- `scripts/run-benchmarks.sh`
- `core-back/test/storage-engine/performance/write-path-benchmark.test.ts`
- `core-back/test/storage-engine/performance/storage-performance.test.ts`
- `core-back/test/storage-engine/read-store.test.ts`
- `core-back/test/storage-engine/uow.test.ts`
- `core-back/test/storage-engine/helpers/db.ts`
- `deploy/backup-daemon/test/restoreDrillRunner.test.ts`

### Generated appendices

- `project-design/appendices/test-inventory.md`

## 10. Change history

- 2026-11-03: initial canonical part. Verified against `5a24f6f+working-tree`.

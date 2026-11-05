---
id: core.tests
title: Tests and Benchmarks
status: partial
confidence: high
last_verified: 2026-11-05
verified_against: 5a24f6f+working-tree
code:
  - core-back/test/**
  - core-back/test/storage-engine/performance/**
  - deploy/backup-daemon/test/**
  - deploy/test/**
  - tests/**
  - scripts/run-benchmarks.sh
  - scripts/run-exhaustive-suite.sh
tests:
  - core-back/test/**
  - deploy/backup-daemon/test/**
  - tests/**
  - core-back/test/security-regressions/c1-forged-success.test.ts
  - core-back/test/security-regressions/c2-mfa.test.ts
  - core-back/test/security-regressions/h1h2-authz.test.ts
  - core-back/test/security-regressions/h3-admin-users-and-approvals.test.ts
  - core-back/test/security-regressions/h4-cashout.test.ts
  - core-back/test/security-regressions/h7-rounding.test.ts
  - core-back/test/security-regressions/h8-webhook.test.ts
  - core-back/test/security-regressions/m4-idempotency.test.ts
  - core-back/test/security-regressions/m9-m12-upload-kyb.test.ts
  - core-back/test/security-regressions/m10-ssrf.test.ts
gaps:
  - The historical 38,500+ assertion target is not met; the working tree has about 1,964 literal test declarations.
  - `core-back/test/exhaustive/09-storage-backup/` does not exist; the runner substitutes storage-engine and backup-admin suites.
  - Database and Redis suites silently skip when the services are absent, and the exhaustive runner still reports success.
  - There is no benchmark for 1,000+ TPS, 50M-500M record scale, deep search or a live restore.
  - The backup-daemon restore drill tests use fake command runners, not real WAL-G/Barman recovery.
  - UI Playwright suites use preview servers and mocked APIs; live cross-service journeys require `E2E_LIVE=1`.
  - True concurrency tests need PostgreSQL 18; RetentionWorker fake parser (test/helpers/retentionFake.ts) cannot parse the new InvariantVerifier query (test drift, not a product bug).
---

# Tests and Benchmarks

## 1. Purpose and scope

This part documents the verification surface of the repository: what test suites exist, what they actually exercise, which suites require PostgreSQL/Redis/browsers/live hosts, which suites skip silently, and which benchmark claims are not backed by executable tests.

It covers:

- `core-back/test/**` — unit, integration, exhaustive, storage-engine, backup-admin, e2e and performance suites;
- `deploy/test/**` and `deploy/backup-daemon/test/**`;
- `admin-back/test/**`, `merchant-back/test/**`, `checkout-back/test/**`, `fake-rails-back/test/**`;
- `admin-front`, `merchant-front` and `checkout-front` unit checks;
- `tests/**` — Playwright E2E and Vitest unit suites;
- `scripts/run-benchmarks.sh` and `scripts/run-exhaustive-suite.sh`.

It does not define product behavior. It records whether the behavior described in the other parts has executable proof, and where that proof is weaker than the historical test plan.

## 2. Design intent (extracted and synthesized from ./design)

The historical master exhaustive test plan targets roughly 38,500 test cases/assertions across 11 suites:

1. schema, models, enums, FKs, triggers and indexes;
2. ledger templates, fee bearers, commission hierarchy and a 10,000-iteration money fuzzer;
3. transform pipeline, selectors, URL compiler and crypto lab;
4. 20 gateways × phases × 24 chaos scenarios;
5. API/RBAC/IDOR/Zod/mTLS matrix;
6. concurrency, slot locks and multi-worker clusters;
7. onboarding, KYB, AML, disputes, reconciliation and go-live gates;
8. 140 edge cases, 24 STRIDE threats and 15 safeguards;
9. PostgreSQL storage engine, replicas, audit/log DBs, backups and restore drills;
10. full-surface Playwright UI, filter, dialog, RTL/LTR and geometry matrix;
11. cross-service E2E journeys, synthetic seeder and deploy engine.

The actual repository is much smaller. It has meaningful suites for most of these areas, but:

- the literal declaration count is about 1,964 across the whole repository (the stale-claims register records 1,778 at its audit baseline), not 38,500;
- the plan's `core-back/test/exhaustive/09-storage-backup/` directory does not exist;
- many exhaustive files are matrix loops inside a small number of `test()` calls, not thousands of literal cases;
- database/Redis suites skip when the services are unavailable, and the exhaustive runner does not fail on those skips;
- the backup daemon restore drill is unit-tested with fake runners, not against a real restore;
- there is no load, TPS, deep-search or restore-throughput benchmark.

## 3. As-built architecture

### 3.1 Test inventory

A working-tree grep of `test(` / `it(` occurrences (excluding `node_modules`) finds about 1,964 literal declarations. The distribution is approximately:

| Workspace | Literal declarations | Test files | Notes |
| :--- | ---: | ---: | :--- |
| `core-back` | 1,193 | 101 | Largest suite; unit, integration, exhaustive, storage, backup-admin and performance |
| `admin-back` | 178 | 7 | mTLS, env isolation, core contract, admin surface, backups |
| `merchant-back` | 89 | 6 | mTLS, forwarding, core contract, KYB/external, env isolation |
| `checkout-back` | 82 | 6 | zero-trust matrix, contract, env isolation, error/logger |
| `deploy` (engine) | 139 | 11 | config, planner, PKI, provisioners, pipeline, rolling deploy, templates, Fake Rails |
| `deploy/backup-daemon` | 75 | 8 | config, cron, engine, catalog, scheduler, server, restore drill, commands |
| `fake-rails-back` | 58 | 4 | API, chaos, crypto, portal/chaos matrix |
| `admin-front`, `merchant-front`, `checkout-front` | 52 | 3 | UI abstraction/content completeness and frontend unit checks |
| `tests` | 97 | 24 | 20 Playwright specs plus 4 Vitest unit files |

The literal count is not an assertion count. A matrix loop can execute hundreds of assertions inside one `test()`, and a `test()` can contain one assertion. Do not use the declaration count as a coverage percentage.

Core-back test groups:

- `core-back/test/*.test.ts` — 39 root-level domain/API tests;
- `core-back/test/engine/**` — 19 engine, transform, crypto, guard, ledger and worker tests;
- `core-back/test/exhaustive/**` — 24 files across 01-schema, 02-ledger, 03-transforms-crypto, 04-rail-engine, 05-api-matrix, 06-concurrency, 07-workflows, 08-security-edge and 10-seeder-and-deploy;
- `core-back/test/storage-engine/**` — 12 files, including 2 performance files;
- `core-back/test/backup-admin/**` — 2 files;
- `core-back/test/e2e/postgres-payment.test.ts` — live payment lifecycle;
- `core-back/test/helpers/**` and `fixtures/**` — fakes and shared harnesses.

### 3.2 What runs and what skips

`core-back/test/setup.ts` sets `NODE_ENV=test`, a default `DATABASE_URL` and dummy KMS/mTLS paths. This makes the suite load without real secrets, but it does not make PostgreSQL or Redis reachable.

Database-dependent suites:

- `core-back/test/storage-engine/helpers/db.ts` probes the test database and Redis at module load (`databaseIsReachable`, `redisIsReachable`).
- `describeDatabase` is `describe` when reachable and `describe.skip` otherwise; `describeRedis` does the same for Redis.
- `core-back/test/exhaustive/_harness.ts` probes `EXHAUSTIVE_DATABASE_URL` / `POSTGRES_TEST_DATABASE_URL` and exports `databaseIsReachable`; several exhaustive files use `databaseIsReachable ? describe : describe.skip`.
- `core-back/test/e2e/postgres-payment.test.ts` uses `test.skipIf(!reachable)` for live payment tests and a few PostgreSQL-invariant tests.
- `core-back/test/storage-engine/*.test.ts` also registers a placeholder `test.skip(... requires the live database)` so the skip is visible.

Redis-dependent suites:

- `core-back/test/storage-engine/cache-velocity.test.ts` skips the live `RedisCacheAdapter` suite without Redis; the memory adapter tests still run.
- `core-back/test/storage-engine/performance/storage-performance.test.ts` skips the live Redis velocity benchmark without Redis.

Without PostgreSQL 18, the schema, ledger, storage-engine integration, backup-admin route and exhaustive DB suites do not prove anything; they skip. Without Redis, the live Lua/velocity path is unproven. The default `bun test` exit code can still be zero because skipped tests are not failures.

Playwright:

- `tests/playwright.config.ts` starts the admin, merchant and checkout preview servers and runs `tests/e2e/{admin,merchant,checkout}` with mocked APIs.
- `tests/playwright.exhaustive.config.ts` starts four preview servers (admin, merchant, checkout, fake-rails) and runs the exhaustive UI specs. It does not start core, the BFFs or Fake Rails; the specs rely on route mocking for API data.
- `tests/playwright.live.config.ts` targets the deployed single-node box over LAN with self-signed TLS and runs `tests/e2e-live/live.spec.ts`.
- `tests/e2e/exhaustive/full-platform-lifecycle-journeys.spec.ts` is skipped unless `E2E_LIVE=1`. The exhaustive runner prints a skip message when the variable is absent.

Deploy and daemon tests are unit-level. The backup daemon suite uses fake command runners and fake file systems; it does not require PostgreSQL, WAL-G, Barman, S3 or a real backup. The deploy suite tests planners/provisioners/config and does not deploy a real multi-host cluster.

### 3.3 Exhaustive runner

`scripts/run-exhaustive-suite.sh` is the master runner:

- forces `--parallel=1` for database suites;
- runs core exhaustive groups 01 through 08, then edge BFF tests, then deploy tests;
- runs `core-back/test/storage-engine` and `test/backup-admin` plus `deploy/backup-daemon` as `T-EX-09`;
- runs the frontend-facing Vitest unit tests in `tests/` and the exhaustive Playwright config as `T-EX-09b`;
- runs `test/exhaustive/10-seeder-and-deploy`;
- runs the cross-service journey only when `E2E_LIVE=1`;
- runs the full core regression last;
- optionally runs `scripts/deploy-localhost.sh` with `--deploy`.

The runner does not preflight PostgreSQL, Redis, browsers or the live stack. It inherits the skip behavior above. A green run therefore means "nothing that ran failed"; it does not mean every suite executed.

### 3.4 Performance suites

`scripts/run-benchmarks.sh`:

- requires `DATABASE_URL`, `POSTGRES_TEST_DATABASE_URL` or `STORAGE_TEST_DATABASE_URL`, exiting with code 2 otherwise;
- runs `bun test test/storage-engine/performance` (or a `BENCHMARK_FILTER`);
- runs the full `test/storage-engine` regression;
- runs `test/backup-admin`;
- prints p50/p95 values; it does not store results or compare against a baseline.

`core-back/test/storage-engine/performance/storage-performance.test.ts` contains:

| Test | Assertion |
| :--- | :--- |
| `compareLsn` 1,000,000 ops | median < 1,000 ms |
| `uuidv7` 100,000 ids | median < 2,000 ms |
| `stableJson` 10,000 rows | median < 2,000 ms |
| memory velocity 10,000 evaluations | median < 2,000 ms |
| read-store routing 100,000 selections | median < 1,000 ms |
| 500 sequential UoWs with outbox + audit | < 10,000 ms |
| 50 concurrent UoWs | p95 < 500 ms |
| 1,000-event outbox drain | < 5,000 ms |
| 16 shard rows load | < 50 ms and no sequential scan |
| 1,000-row audit hash chain append + verify | < 5,000 ms |
| 1,000 live Redis velocity evaluations | < 3,000 ms (skips without Redis) |

`core-back/test/storage-engine/performance/write-path-benchmark.test.ts` adds:

| Test | Assertion |
| :--- | :--- |
| 300 `writeAudit` calls (`audit_log` + `audit_outbox`) | < 10,000 ms |
| shard balance reads for a 16-shard account | p95 < 25 ms |

These are regression ceilings, not capacity benchmarks. They are generous enough for developer hardware and do not model 50M-500M records, 1,000+ sustained TPS, mixed read/write workloads, multi-node contention or p99 latency.

### 3.5 Missing benchmark classes

The design's target scale is 50M-500M financial records, 1,000+ TPS sustained writes and sub-5 ms reads. The repository has no executable proof of any of these:

- no sustained TPS benchmark, load generator or latency percentile beyond p95 in two tests;
- no test database at production scale; the performance tests use a small migrated test database;
- no deep-search benchmark (20 providers, broad query, realistic candidate set, p95, partial rate);
- no restore-drill benchmark (backup fetch + WAL replay + three checks under time);
- no replication lag/read-after-write benchmark with real replicas;
- no multi-node core/worker contention benchmark;
- no audit/log DB throughput benchmark under buffering pressure;
- no Redis outage/failover benchmark.

## 4. Contracts and invariants

- A test that requires PostgreSQL 18 or Redis must skip explicitly when the service is absent. It must not silently pass a mock that claims to prove live behavior.
- The exhaustive runner's success means only that executed tests passed. Reports of coverage must state which suites skipped.
- A live suite must be opt-in (`E2E_LIVE=1`) and must not be counted as part of the default gate.
- Performance tests must assert a finite upper bound and print the measured value so regressions are visible. They must not assert a lower bound that is machine-dependent.
- Benchmark scripts must fail when no database URL is configured rather than quietly running only pure tests.
- Backup/restore tests that use fake runners must be labelled as unit tests, not restore proofs.
- UI tests that mock APIs prove rendering/navigation behavior, not backend integration.
- The canonical verification gate is `bun scripts/project-design/build.ts --check`, plus the workspace typecheck/test/build commands in `AGENTS.md`. A green exhaustive runner is not a substitute for the full gate.
- Skipped database/live suites must be reported explicitly when claiming completion.

## 5. Data / API / config / deployment surface

### Commands

```bash
# Core unit/integration (database suites skip without PostgreSQL)
cd core-back && bun test

# Storage and backup regression
cd core-back && bun test test/storage-engine
cd core-back && bun test test/backup-admin

# Exhaustive runner
./scripts/run-exhaustive-suite.sh
./scripts/run-exhaustive-suite.sh --deploy
E2E_LIVE=1 ./scripts/run-exhaustive-suite.sh

# Storage benchmarks (requires a database URL)
DATABASE_URL=postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test \
  ./scripts/run-benchmarks.sh
BENCHMARK_FILTER=write-path ./scripts/run-benchmarks.sh

# Backup daemon
cd deploy/backup-daemon && bun test

# Deploy engine
cd deploy && bun test

# Edge BFFs
cd admin-back && bun test
cd merchant-back && bun test
cd checkout-back && bun test
cd fake-rails-back && bun test

# Frontend unit
cd admin-front && bun run test:unit
cd merchant-front && bun run test:unit
cd checkout-front && bun run build

# UI Playwright (mocked APIs; preview servers)
cd tests && bun run test:unit
cd tests && bunx playwright test -c playwright.config.ts
cd tests && bunx playwright test -c playwright.exhaustive.config.ts

# Live stack
cd tests && bunx playwright test -c playwright.live.config.ts
```

### Environment

| Key | Purpose |
| :--- | :--- |
| `DATABASE_URL` | Default core/test database; benchmark runner requires one of the database URLs |
| `POSTGRES_TEST_DATABASE_URL` | Alternative exhaustive/test database |
| `STORAGE_TEST_DATABASE_URL` | Alternative storage-engine test database |
| `EXHAUSTIVE_DATABASE_URL` | Exhaustive harness database override |
| `STORAGE_TEST_REDIS_URL` | Live Redis suite URL |
| `BENCHMARK_FILTER` | Filters the performance directory |
| `E2E_LIVE` | Enables live cross-service journeys and is checked by the exhaustive runner |
| `PLAYWRIGHT_CHROME_PATH` | Optional Chromium executable |
| `FAKE_RAILS_*` | Required by Fake Rails and synthetic-seeder tests when run live |

### Test assets

- `core-back/test/helpers/**` — fake Prisma, repositories, guards, governance, retention and background-job fakes.
- `core-back/test/exhaustive/_harness.ts` — deterministic xoshiro128** PRNG, schema parser, catalog readers, invariant verifier.
- `core-back/test/storage-engine/helpers/db.ts` — real PostgreSQL/Redis probes, sandbox schemas, cleanup.
- `tests/e2e/fixtures.ts` — Playwright API mocking and shared page fixtures.
- `tests/playwright*.config.ts` — mocked, exhaustive and live configurations.

## 6. Operational usage

- Run the smallest relevant suite first, then the full gate from `AGENTS.md`.
- For a core change, run the focused test file, then `cd core-back && bun test`. If the change touches storage, also run `test/storage-engine`; if it touches backups, run `test/backup-admin`.
- Always state whether PostgreSQL and Redis were available. A skipped suite is not a passing suite.
- Before claiming exhaustive coverage, run `./scripts/run-exhaustive-suite.sh` with a real database and Redis, and report any skipped groups.
- For benchmarks, use a dedicated test database and stable hardware. Compare the printed p50/p95 values with the previous run; do not treat the ceilings as service-level objectives.
- For UI changes, run the relevant Playwright project. The default/exhaustive configs use mocked APIs; only `E2E_LIVE=1` proves cross-service behavior.
- For backup daemon changes, run its unit tests and, separately, a real restore drill on a test host if the change touches recovery, WAL, Barman or scratch handling.
- Do not add a benchmark that asserts a minimum throughput on shared CI hardware without a recorded baseline and a tolerance policy.

## 7. Status and deviations

### Implemented

- Broad core-back unit/integration coverage across engine, ledger, governance, workers, search, storage, backups and API routes.
- Exhaustive schema, ledger, transform, rail, API, concurrency, workflow, security and seeder suites.
- Storage-engine and write-path performance suites with explicit thresholds.
- Backup control client and internal route tests.
- Backup daemon unit tests for config, cron, engine, catalog, scheduler, server and restore drill.
- Deploy engine tests for planning, PKI, provisioners, pipeline, rolling deploy, templates and Fake Rails.
- Edge BFF mTLS/contract/isolation tests.
- Frontend content/abstraction checks and Playwright UI suites.
- A master exhaustive runner and a storage benchmark runner.
- Opt-in live cross-service journeys.

### Partial

- The exhaustive suite has no `09-storage-backup` directory; the runner substitutes existing storage/backup suites.
- Database/Redis suites skip when services are absent, and the runner does not fail on skips.
- Exhaustive file names are stale in places (for example `all-15-templates-matrix.test.ts` while the ledger has 17 `LedgerScenario` values, and `all-20-gateways-24-scenarios.test.ts` while Fake Rails has 13 seeded core gateways). The filenames do not guarantee the current matrix size.
- The Playwright exhaustive matrix runs preview frontends with mocked APIs; it does not exercise the BFF/core/Fake Rails chain.
- The backup daemon restore drill test is a unit test with fake commands, not a live restore proof.
- The performance tests are regression guards, not scale benchmarks.

### Missing / deferred

- The 38,500+ assertion target. The working tree has about 1,964 literal declarations; the stale-claims baseline is 1,778.
- `core-back/test/exhaustive/09-storage-backup/` and its planned ~900 tests.
- A 1,000+ TPS sustained write benchmark.
- A 50M-500M record-scale query benchmark with realistic indexes and data distribution.
- A deep-search benchmark across 20 providers with p95/p99 and partial-rate measurement.
- A live backup/restore benchmark with WAL-G/Barman, real S3, WAL replay and drill verification.
- A multi-node concurrency benchmark for core workers, outbox relay, audit shipper and replica reads.
- An automated check that a database-backed suite actually ran (rather than skipped) in CI.
- Coverage reporting, mutation testing or a test-to-design traceability gate.
- A benchmark result archive for comparing runs over time.

### Known bugs / risks

- Silent skips can make a green run misleading. `describeDatabase`/`describeRedis` and `test.skipIf` are explicit in code, but no runner-level summary fails when a required service is absent. Process gap.
- The exhaustive runner's `T-EX-09` name suggests a dedicated suite that does not exist. Documentation/process drift.
- `test.skip("... requires the live database")` placeholders inflate the skip count and can be mistaken for executed tests. Test hygiene risk.
- Performance thresholds are generous and machine-dependent. A slow CI host can pass a regression that a fast host would have caught, and a fast host can fail a noisy run. Process risk.
- The benchmark script's full storage regression includes live tests that skip without Redis; it does not fail when only the live Redis path was skipped. Process gap.
- Playwright preview servers reuse an existing server (`reuseExistingServer: true`), so a stale local preview can serve old assets. Test hygiene risk.
- Live journeys are opt-in; a default exhaustive run never proves the deployed stack. Process gap.
- Fake Rails/backup daemon tests use fakes for external systems, so protocol/credential mismatches can survive until a live deployment. Test gap.
- Test counts in historical docs (`38,500+`) are not reproducible from the repository and must not be cited as current coverage.

## 8. Verification and tests

The verification surface is the suites listed in section 3. The canonical gate is:

```bash
bun scripts/project-design/build.ts --check
git diff --check
cd core-back && bun run typecheck && bun test
cd deploy && bun run typecheck && bun test
cd deploy/backup-daemon && bun run typecheck && bun test
cd admin-back && bun run typecheck && bun test
cd merchant-back && bun run typecheck && bun test
cd checkout-back && bun run typecheck && bun test
cd admin-front && bun run build
cd merchant-front && bun run build
cd checkout-front && bun run build
```

Database-backed suites require PostgreSQL 18; Redis-backed suites require Redis. The exhaustive runner and benchmark runner do not provision either. The live Playwright suite requires a deployed stack and `E2E_LIVE=1` for the cross-service journey. No build, test or benchmark was run for this documentation change; this part is a code/test inventory, not a verification log.

## 9. Source references

### Old design sections

- `design/05-testing/master_exhaustive_test_plan_for_opencode.md#executive-summary--testing-philosophy`
- `design/05-testing/master_exhaustive_test_plan_for_opencode.md#1-master-test-volume--coverage-matrix-38500-assertions`
- `design/05-testing/master_exhaustive_test_plan_for_opencode.md#10-suite-09-postgresql-18-storage-engine-replicas-auditlog-databases-backups--restore-drills-900-tests`
- `design/05-testing/master_exhaustive_test_plan_for_opencode.md#11-suite-10-full-surface-playwright-ui-filter-dialog-rtlltr--geometry-matrix-across-all-4-portals-2300-tests`
- `design/05-testing/master_exhaustive_test_plan_for_opencode.md#12-suite-11-full-cross-service-end-to-end-journeys-synthetic-seeder--deploy-engine-verification-1200-tests`
- `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md#7-step-by-step-opencode-execution-plan`
- `design/00-process/blueprint-management.md#5-documentation-corrections-backlog`

### Code paths

- `core-back/test/setup.ts`
- `core-back/test/helpers/**`
- `core-back/test/exhaustive/_harness.ts`
- `core-back/test/exhaustive/**`
- `core-back/test/storage-engine/**`
- `core-back/test/storage-engine/performance/storage-performance.test.ts`
- `core-back/test/storage-engine/performance/write-path-benchmark.test.ts`
- `core-back/test/backup-admin/**`
- `core-back/test/e2e/postgres-payment.test.ts`
- `deploy/test/**`
- `deploy/backup-daemon/test/**`
- `admin-back/test/**`
- `merchant-back/test/**`
- `checkout-back/test/**`
- `fake-rails-back/test/**`
- `tests/unit/**`
- `tests/e2e/**`
- `tests/e2e-live/live.spec.ts`
- `tests/playwright.config.ts`
- `tests/playwright.exhaustive.config.ts`
- `tests/playwright.live.config.ts`
- `scripts/run-benchmarks.sh`
- `scripts/run-exhaustive-suite.sh`

### Generated appendices

- `project-design/appendices/test-inventory.md` — authoritative generated test file inventory and skip conditions
- `project-design/appendices/env-and-config-matrix.md` — test/benchmark environment keys
- `project-design/appendices/api-route-matrix.md` — API surfaces exercised by the route matrices

## 10. Change history

- 2026-11-03 — Initial canonical extraction. Records the actual test inventory, database/Redis/browser/live skip behavior, the missing exhaustive storage suite, the benchmark scripts and thresholds, and the absent 1,000+ TPS, scale, deep-search and restore benchmarks. See `project-design/TRACKER.md`.

## 11. Security regression suites (2026-11-05)

New suites in `core-back/test/security-regressions/`: `c1-forged-success`, `c2-mfa`, `h1h2-authz`, `h3-admin-users-and-approvals`, `h4-cashout`, `h7-rounding`, `h8-webhook`, `m4-idempotency`, `m9-m12-upload-kyb`, `m10-ssrf`. Existing tests that asserted insecure behaviour were updated (for example the RBAC fuzz now mints well-formed tokens).

Known gaps: true concurrency needs PostgreSQL 18 and is not exercised; the RetentionWorker fake parser (`test/helpers/retentionFake.ts`) cannot parse the new InvariantVerifier query (test drift, not a product bug).

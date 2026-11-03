---
id: testing.strategy
title: Testing Strategy
status: partial
confidence: high
last_verified: 2026-11-03
verified_against: 5a24f6f+working-tree
code:
  - core-back/test/setup.ts
  - core-back/test/exhaustive/_harness.ts
  - core-back/test/exhaustive/_dbFactory.ts
  - core-back/test/storage-engine/helpers/db.ts
  - tests/e2e/fixtures.ts
design_sources:
  - design/master_exhaustive_test_plan_for_opencode.md#executive-summary-testing-philosophy
  - design/master_exhaustive_test_plan_for_opencode.md#1-master-test-volume-coverage-matrix-38500-assertions
  - design/master_exhaustive_test_plan_for_opencode.md#13-opencode-phased-execution-tracker-master-runner-script
tests:
  - core-back/test/exhaustive/**
  - core-back/test/storage-engine/**
  - tests/e2e/**
  - tests/e2e-live/**
gaps:
  - The claimed 38,500 assertions are not present; the working tree has about 1,807 literal test declarations.
  - Suite 09 has no exhaustive directory.
  - Most UI tests mock every API response and verify geometry rather than behaviour.
  - Live cross-service journeys skip unless E2E_LIVE=1 and a seeded link is supplied.
---

# Testing Strategy

## 1. Purpose and scope

This part defines how the monorepo is verified: the test philosophy, the gate progression, database and Redis expectations, the zero-tautology rule, and which suites currently skip, mock or fail to exist.

It does not list every test file or count (see `testing.suites`), the fixture and live-stack wiring (see `testing.fixtures`) or the benchmark gates (see `testing.benchmarks`). Per-workspace test evidence is repeated in each workspace part.

## 2. Design intent (extracted and synthesized from ./design)

The exhaustive test plan was written to prevent a small happy-path suite from missing intersection defects: rounding remainders, confirmation races, SSRF notations, JSX binding failures and seeded historical attempts that fail when an operator clicks Inquire or Refund.

Its non-negotiable rules are:

1. **Zero-tautology.** Every test must invoke the real production module, real Express router, real PostgreSQL constraint or rendered Vue DOM. `expect(true).toBe(true)` and mock-against-mock tests are forbidden.
2. **Combinatorial and property-based generation.** Use data-driven Cartesian products and a seeded PRNG so permutations are named and reproducible.
3. **Continuous double-entry invariant.** Every database suite runs the ledger invariant after writes and requires `drift === "0.0000"`.
4. **Fail-fast gate progression.** Implement and pass suites `T-EX-01` through `T-EX-11` in order; fix production defects before advancing.
5. **Fail loudly when the environment is absent.** A suite that needs PostgreSQL, Redis or a live host either skips with a named reason or fails; it must not silently pass against a stub.

The plan targets 38,500 or more assertions across eleven suites, plus a unified runner.

## 3. As-built architecture

### 3.1 Test roots

| Root | Runner | Primary scope |
| :--- | :--- | :--- |
| `core-back/test` | `bun test` | Unit, route, engine, ledger, storage, exhaustive |
| `admin-back/test` | `bun test` | Edge contract, mTLS, env isolation, admin surface |
| `merchant-back/test` | `bun test` | Edge contract, forwarding, KYB/external surface |
| `checkout-back/test` | `bun test` | Zero-trust checkout, mTLS, env isolation |
| `fake-rails-back/test` | `bun test` | Real Express app over SQLite |
| `deploy/test` | `bun test` | Config, host planning, PKI, firewall, pipeline |
| `deploy/backup-daemon/test` | `bun test` | Backup engine, catalog, scheduler, restore drill |
| `tests/e2e` | Playwright | Portal geometry, auth, dialogs, mocked API surface |
| `tests/e2e-live` | Playwright | Deployed-stack smoke journeys |
| `tests/unit` | Vitest | Frontend utility and authority helpers |

`tests/run-playwright.sh` is the Playwright wrapper used by local runs. `scripts/run-exhaustive-suite.sh` is the master gate runner and forces one Bun worker for database suites.

### 3.2 The zero-tautology rule in practice

The core exhaustive suites are structurally honest about production code:

- `core-back/test/exhaustive/_harness.ts` drives real Prisma clients, real schema files and real production services. It says explicitly that it only provisions fixtures and reads metadata.
- `_dbFactory.ts` builds rows from the real `schema.prisma` and live catalog; it does not replace constraints.
- Suite 01 reads `information_schema`, `pg_catalog`, `pg_indexes` and real constraint metadata.
- Suite 02 invokes `LedgerPoster.validateTemplate` and real `buildLedgerTemplate` output.
- Suite 03 invokes the real transform, canonicalisation, signing and Vault code.
- Suite 04 invokes `DynamicRailEngine` through `_engineHarness.ts`, not the live fake-rails HTTP tier.
- Suite 05 drives real authority/session helpers and the real list-query parser.
- Suite 06 uses live PostgreSQL concurrency primitives.
- Suite 07 uses real parsers, KYB sniffers, AML rules and go-live validators.
- Suite 08 uses real SSRF/URL/response-hardening helpers.

The UI and edge tests are weaker:

- `tests/e2e/fixtures.ts` `mockApi()` fulfills every `/api/v1/**` call with `{}` or a small fixture. The exhaustive surface tests only assert rendering, layout, direction and theme.
- Auth tests intercept the login endpoint and return a fixture session; they assert the shape of the posted body, not a real login.
- The fake-rails surface test mocks every `/portal-api/**` and only visits `/login`.
- `tests/unit` tests real frontend utility functions, not the full pages.

These are useful regression tests, but they do not satisfy the design's zero-tautology claim for UI behaviour.

### 3.3 Gate progression

`scripts/run-exhaustive-suite.sh` implements this sequence:

| Gate | Command target | Notes |
| :--- | :--- | :--- |
| `T-EX-01` | `core-back/test/exhaustive/01-schema` | Live PostgreSQL required for most tests |
| `T-EX-02` | `core-back/test/exhaustive/02-ledger` | Some tests are pure; checkpoints need PostgreSQL |
| `T-EX-03` | `core-back/test/exhaustive/03-transforms-crypto` | Pure |
| `T-EX-04` | `core-back/test/exhaustive/04-rail-engine` | Pure engine harness |
| `T-EX-05` | core plus all edge backends plus fake rails plus deploy | Mixed Bun suites |
| `T-EX-06` | `core-back/test/exhaustive/06-concurrency` | Live PostgreSQL |
| `T-EX-07` | `core-back/test/exhaustive/07-workflows` | Mostly pure |
| `T-EX-08` | `core-back/test/exhaustive/08-security-edge` | Pure |
| `T-EX-09` | `core-back/test/storage-engine`, `test/backup-admin`, backup daemon | There is no `09-storage-backup` directory |
| `T-EX-09b` | `tests` unit plus exhaustive Playwright | Mocked UI |
| `T-EX-10` | `10-seeder-and-deploy` plus optional cross-service journeys | Journeys skip without `E2E_LIVE=1` |
| Final | `core-back bun test` | Full regression |

The design's numbering differs from the runner: the runner calls the UI matrix `T-EX-09b` and the seeder/deploy suite `T-EX-10`, while the design calls them Suite 10 and Suite 11.

### 3.4 Database provisioning

There is no single test database configuration. The suites use these variables:

| Variable | Default | Used by |
| :--- | :--- | :--- |
| `DATABASE_URL` | `postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test` | `test/setup.ts`, storage helpers, postgres payment test |
| `POSTGRES_TEST_DATABASE_URL` | fallback | Postgres payment test, exhaustive harness fallback |
| `EXHAUSTIVE_DATABASE_URL` | fallback to `POSTGRES_TEST_DATABASE_URL` | Exhaustive harness |
| `STORAGE_TEST_DATABASE_URL` | fallback to `DATABASE_URL` | Storage-engine helpers |
| `STORAGE_TEST_REDIS_URL` | `redis://127.0.0.1:56379` | Cache/velocity and performance |
| `REDIS_URL` | `redis://127.0.0.1:56379` | Storage performance and production adapters |

The expected local server is PostgreSQL 18 on port 55432 and Redis on 56379, not the default service ports. The test database must already be migrated (`bun run migrate-deploy`) before the DB-backed suites run. `_harness.ts` uses a dedicated Prisma client so it does not share the cached application client. The storage helpers create dedicated schemas or sandboxes with `search_path` so files can run in parallel.

`bun test --parallel=1` is mandatory for the database suites in the runner because they share one database and the invariant hook.

### 3.5 Double-entry invariant

`_harness.ts` exposes `verifyInvariant()` and `assertZeroDrift()`, which wrap the production `InvariantVerifier`. Suite 02 and the storage write-path suites use it after batches. A non-zero drift throws with left/right sides and drift printed.

The invariant hook is not applied to every file that touches the database. The runner enforces one worker, but not a universal `afterEach` hook.

### 3.6 Skipping behaviour

Current named skips:

- `describeDatabase` becomes `describe.skip` when `SELECT 1` fails against the storage database.
- `describeRedis` becomes `describe.skip` when the Redis connection or `PING` fails.
- Storage files register a `test.skip("... requires the live database")` placeholder so a skipped file is still visible.
- `core-back/test/e2e/postgres-payment.test.ts` uses `test.skipIf(!reachable)` for every payment test.
- `write-path.integration.test.ts`, `uow.test.ts`, `ledger-shards.test.ts`, `audit-chain.test.ts`, `outbox-workers.test.ts`, `engine-factory.test.ts` and `performance/*.test.ts` have explicit skips.
- `tests/e2e/exhaustive/full-platform-lifecycle-journeys.spec.ts` skips unless `E2E_LIVE=1`.
- The link-journey test also skips unless `E2E_LINK_KEY` is set.
- `tests/e2e-live/live.spec.ts` has no skip guard; it fails if the deployed host is unreachable.

No suite currently sets a CI fail-on-skip policy. A run can be green with most DB or live coverage skipped.

### 3.7 Mocked surfaces

| Surface | Mocking approach | Consequence |
| :--- | :--- | :--- |
| Admin UI | `mockApi()` intercepts every `/api/v1/**` call | No real permissions, validation or data flow |
| Merchant UI | Same | Same |
| Checkout UI | Route intercepts `/api/v1/pay/**` | No real payment state machine |
| Fake-rails UI | Route intercepts `/portal-api/**` and `/hosted/**` | Only login geometry is tested |
| Login flows | Route intercept returns fixture session | Body-shape assertions only |
| Edge BFF tests | Real Express routers with fake core clients in places | Contract coverage, not live mTLS |
| Engine suite 04 | In-process harness with scripted step results | Deterministic and broad, not live fake-rails |
| Seeder safety | Fake Prisma objects and stubbed handshake | Gate logic only |

## 4. Contracts and invariants

1. **A test that asserts only on a stub is not acceptance evidence.** Behaviour claims need a real module or live service.
2. **A skipped DB suite is not a passing DB suite.** Reports must name the skip reason.
3. **The test database is disposable.** Tests must not depend on rows left by another file; use unique references and clean up.
4. **Money invariants are checked after database writes.** Any suite that posts ledger entries must verify zero drift.
5. **Seeded PRNGs must be fixed and named.** A failure must be reproducible from the printed seed.
6. **Live credentials belong in the environment, not in source.** This invariant is currently violated by `tests/e2e-live/live.spec.ts`.
7. **The runner must fail when a required gate fails.** It currently does so for command failures, but not for skips.

## 5. Data / API / config / deployment surface

- Runner: `scripts/run-exhaustive-suite.sh`.
- Playwright wrapper: `tests/run-playwright.sh`.
- Playwright configs: `tests/playwright.config.ts`, `playwright.exhaustive.config.ts`, `playwright.live.config.ts`.
- Vitest config: `tests/vitest.config.ts`.
- Core setup: `core-back/test/setup.ts`.
- Exhaustive harness: `core-back/test/exhaustive/_harness.ts`, `_dbFactory.ts`.
- Storage helpers: `core-back/test/storage-engine/helpers/db.ts`.
- E2E fixture: `tests/e2e/fixtures.ts`.

## 6. Operational usage

```bash
# Core unit and integration
cd core-back && bun run typecheck && bun test

# Exhaustive gates
./scripts/run-exhaustive-suite.sh

# Playwright mocked UI
cd tests && bun run test

# Deployed-stack live smoke
cd tests && bun run test:live

# With a local test database
export DATABASE_URL=postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test
export STORAGE_TEST_REDIS_URL=redis://127.0.0.1:56379
./scripts/run-exhaustive-suite.sh
```

Report skipped suites explicitly. A run without PostgreSQL 18 and Redis is not evidence for any DB or storage claim.

## 7. Status and deviations

### Implemented

- Core exhaustive suites 01-08 and 10 with real production modules.
- Live schema, constraint and query-plan checks.
- Deterministic PRNGs and broad combinatorial matrices.
- Storage-engine, backup-control and backup-daemon suites.
- Edge BFF contract suites.
- Mocked Playwright surface walkers for four portals.
- A single master runner.

### Partial

- Suite 09 exists only as storage-engine/backup commands, not an exhaustive directory.
- UI coverage is geometry-heavy and API-mocked.
- Live journeys are opt-in and require a seeded link.
- The invariant hook is not universal.
- The claimed assertion volume is not present.

### Missing / deferred

- A fail-on-skip CI mode.
- A real browser E2E journey through checkout, fake rails and admin without mocks.
- A restored-database drill in CI.
- A deep-search latency and relevance suite.
- A seeder volume/runtime benchmark.
- A consistency check that every suite in the design exists.

### Known bugs / risks

- **Documentation bug:** the plan claims 38,500+ assertions; the actual literal declaration count is about 1,807.
- **Coverage gap:** suite numbering in the runner differs from the plan.
- **Security risk:** live credentials are hard-coded as defaults in `tests/e2e-live/live.spec.ts`.
- **False-green risk:** database and live suites can skip while the runner still reports success.

## 8. Verification and tests

This part is verified by inspecting the runner, configs and suite files. It has no tests of its own. The relevant commands are listed in section 6.

- The master runner and configs exist and are syntactically valid.
- The suites referenced by the runner exist except `core-back/test/exhaustive/09-storage-backup`.
- The claims in this part are derived from the working tree, not from a test run.

## 9. Source references

### Old design sections

- `design/master_exhaustive_test_plan_for_opencode.md` executive summary and section 1.
- `design/master_exhaustive_test_plan_for_opencode.md` sections 2-12 for suite intent.
- `design/master_exhaustive_test_plan_for_opencode.md` section 13 for the runner.

### Code paths

- `scripts/run-exhaustive-suite.sh`
- `tests/playwright.config.ts`
- `tests/playwright.exhaustive.config.ts`
- `tests/playwright.live.config.ts`
- `tests/vitest.config.ts`
- `core-back/test/setup.ts`
- `core-back/test/exhaustive/_harness.ts`
- `core-back/test/storage-engine/helpers/db.ts`
- `tests/e2e/fixtures.ts`

### Generated appendices

- `project-design/appendices/test-inventory.md`

## 10. Change history

- 2026-11-03: initial canonical part. Verified against `5a24f6f+working-tree`.

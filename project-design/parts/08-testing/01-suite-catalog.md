---
id: testing.suites
title: Test Suite Catalog
status: partial
confidence: high
last_verified: 2026-11-03
verified_against: 5a24f6f+working-tree
code:
  - core-back/test/exhaustive/**
  - core-back/test/storage-engine/**
  - core-back/test/edge-cases/**
  - admin-back/test/**
  - merchant-back/test/**
  - checkout-back/test/**
  - fake-rails-back/test/**
  - deploy/test/**
  - deploy/backup-daemon/test/**
design_sources:
  - design/05-testing/master_exhaustive_test_plan_for_opencode.md#1-master-test-volume-coverage-matrix-38500-assertions
  - design/05-testing/master_exhaustive_test_plan_for_opencode.md#2-suite-01-database-schema-66-models-100-enums-fks-triggers-indexes-2200-tests
  - design/05-testing/master_exhaustive_test_plan_for_opencode.md#13-opencode-phased-execution-tracker-master-runner-script
tests:
  - core-back/test/exhaustive/01-schema/models-and-columns.test.ts
  - core-back/test/exhaustive/02-ledger/all-15-templates-matrix.test.ts
  - core-back/test/exhaustive/03-transforms-crypto/transform-pipeline-matrix.test.ts
  - core-back/test/exhaustive/04-rail-engine/all-20-gateways-24-scenarios.test.ts
  - core-back/test/exhaustive/05-api-matrix/list-query-filters-all-27-endpoints.test.ts
  - core-back/test/exhaustive/06-concurrency/single-and-multi-use-slot-races.test.ts
  - core-back/test/exhaustive/07-workflows/onboarding-and-aml.test.ts
  - core-back/test/exhaustive/08-security-edge/stride-24-and-15-safeguards.test.ts
  - core-back/test/exhaustive/10-seeder-and-deploy/synthetic-seeder-safety-and-audit.test.ts
  - tests/e2e/exhaustive/exhaustive-admin-surface.spec.ts
gaps:
  - No core-back/test/exhaustive/09-storage-backup directory exists.
  - No tests/e2e/exhaustive/11-e2e-seeder-deploy directory exists.
  - Suite 04 uses 21 gateway codes and 26 scenarios, not the documented 20 and 24.
  - Suite 02 has 20 template variants, not 15.
  - The UI suites mock every API and cover login/geometry more than behaviour.
  - Total literal declarations are about 1,807, not 38,500.
---

# Test Suite Catalog

## 1. Purpose and scope

This part catalogues the suites that actually exist, the files they contain, their literal test declarations, their runtime expansion where it is meaningful, and the gaps between the historical plan and the working tree.

It does not redefine the strategy (`testing.strategy`), the fixtures (`testing.fixtures`) or the benchmarks (`testing.benchmarks`).

## 2. Design intent (extracted and synthesized from ./design)

The design specifies eleven suites:

| Design suite | Intended location | Intended volume |
| :--- | :--- | ---: |
| 01 Schema | `core-back/test/exhaustive/01-schema/` | ~2,200 |
| 02 Ledger | `core-back/test/exhaustive/02-ledger/` | ~11,200 |
| 03 Transforms/crypto | `core-back/test/exhaustive/03-transforms-crypto/` | ~3,600 |
| 04 Rail engine | `core-back/test/exhaustive/04-rail-engine/` | ~4,800 |
| 05 API matrix | all backends `test/exhaustive/05-api-matrix/` | ~6,800 |
| 06 Concurrency | `core-back/test/exhaustive/06-concurrency/` | ~1,200 |
| 07 Workflows | `core-back/test/exhaustive/07-workflows/` | ~2,500 |
| 08 Security/edge | `core-back/test/exhaustive/08-security-edge/` | ~1,800 |
| 09 Storage/backup | `core-back/test/exhaustive/09-storage-backup/` | ~900 |
| 10 UI surface | `*/e2e/exhaustive/10-ui-surface/` | ~2,300 |
| 11 E2E/seeder/deploy | `e2e/exhaustive/11-e2e-seeder-deploy/` | ~1,200 |
| Total | — | ~38,500 |

The plan says every suite must be implemented and passed in order, with combinatorial matrices, a seeded PRNG, live PostgreSQL constraints and rendered UI.

## 3. As-built architecture

### 3.1 Core exhaustive suites

| Suite | Directory | Files | Literal declarations | Notable runtime expansion |
| :--- | :--- | ---: | ---: | :--- |
| 01 | `core-back/test/exhaustive/01-schema` | 4 | 59 | Every schema model × 15 structural checks (at least 73 models, so at least 1,095 checks) plus unique/FK/check/index matrices |
| 02 | `core-back/test/exhaustive/02-ledger` | 4 | 20 | 20 template variants × 3 currencies × 5 amount tiers × 4 fee configurations = 1,200; plus 10,000 fuzzer iterations |
| 03 | `core-back/test/exhaustive/03-transforms-crypto` | 3 | 70 | 6 canonicalisation modes × 4 algorithms × 3 key encodings × 3 output encodings × 4 payloads = 1,440 signatures, plus fuzz/select/vault matrices |
| 04 | `core-back/test/exhaustive/04-rail-engine` | 3 | 10 | 21 gateway codes × 26 scenarios = 546 flows, plus route-ranking and visible-rails matrices |
| 05 | `core-back/test/exhaustive/05-api-matrix` | 3 | 29 | mTLS 3 channels × 4 identities, admin role/authority matrix, 27 list endpoints × query permutations |
| 06 | `core-back/test/exhaustive/06-concurrency` | 3 | 14 | Live DB races: 50 reservation workers, 50 confirmers, 4 workers × 200 jobs |
| 07 | `core-back/test/exhaustive/07-workflows` | 2 | 44 | KYB magic bytes, four-eyes, Arabic normalisation, 7 AML rules, CSV/date parsers, 12 go-live gates |
| 08 | `core-back/test/exhaustive/08-security-edge` | 1 | 28 | SSRF address catalogue, DNS rebinding, response hardening, URL integrity |
| 09 | — | 0 | 0 | **Missing**; the runner substitutes storage-engine/backup tests |
| 10 | `core-back/test/exhaustive/10-seeder-and-deploy` | 1 | 21 | Five seeder gates, handshake variants, timeline/audit |
| 11 | — | 0 | 0 | **Missing as a directory**; lifecycle tests live in `tests/e2e/exhaustive` |

Core exhaustive total: **295 literal declarations** across 24 files in nine directories.

### 3.2 Suite 01 — schema

Files:

- `models-and-columns.test.ts` (15 checks per model, money column round-trips, bytea, text, enums).
- `unique-and-fk-constraints.test.ts` (5 checks per unique constraint, 5 per FK, live referential actions).
- `check-constraints-and-triggers.test.ts` (named CHECK constraints, journal amount positivity, slot invariant, maker-checker trigger).
- `indexes-and-query-plans.test.ts` (declared index parity, primary keys, storage index inventory, hot query plans).

Most tests are wrapped in `describeDb`, so they skip when PostgreSQL is unreachable. The matrix expectation is `models.length * 15 >= 1,095`.

### 3.3 Suite 02 — ledger

Files:

- `all-15-templates-matrix.test.ts` — despite the file name, it defines **20 template variants** (T1-T15 plus T5b, T6b, T7b, T10b, T15b) and asserts 1,200 combinations.
- `commission-hierarchy-and-bearers.test.ts` — hierarchy precedence, rail isolation, effective dating.
- `property-fuzzer-10k.test.ts` — exactly 10,000 deterministic iterations with Decimal-only money and balanced entries.
- `checkpoints-and-invariant.test.ts` — live checkpoint snapshots and a 500-entry invariant batch.

The design's "15 templates × 900 cases" is stale. The production enum has more `LedgerScenario` values than the test names, and the test deliberately covers variants.

### 3.4 Suite 03 — transforms and crypto

Files:

- `transform-pipeline-matrix.test.ts` — closed operation library, every operation in isolation, chains, amount/rounding, Libyan phone, Arabic digits, timezone, escaping, save-time validation and a deterministic scale fuzz.
- `recursive-set-and-select-fuzz.test.ts` — set/select vectors, arrays, sibling preservation, malformed paths, prototype-pollution guards.
- `crypto-profiles-and-vault.test.ts` — six canonicalisation modes, 1,440 signing combinations, official-style helpers, AES-256-GCM key rotation, tamper rejection, redaction and PAN scrubbing.

These are pure tests and run without PostgreSQL or Redis.

### 3.5 Suite 04 — rail engine

Files:

- `all-20-gateways-24-scenarios.test.ts` — despite the name, uses `ALL_GATEWAY_CODES` from `_harness.ts`, which has **21 codes** (including `google_pay`, `lypay`, `evopay`, and excluding `cbl_lypay`, `evo_pay`) and **26 scenarios** (`S01`-`S20`, `S21a`, `S21b`, `S22a`, `S22b`, `S23`, `S24`), for 546 flows.
- `routing-failover-and-circuit-breaker.test.ts` — ranking strategies, daily caps, failover, draining routes, amount limits and comparator fuzz.
- `visible-rails-formula-matrix.test.ts` — sampled formula permutations.

The flows use `_engineHarness.ts` with scripted step results. They do not call the live fake-rails HTTP tier, despite the design's "against live fake-rails-back" claim.

### 3.6 Suite 05 — API matrix

Core files:

- `mtls-channel-isolation.test.ts` — channel/CN binding and certificate refusal.
- `admin-endpoints-rbac-fuzz.test.ts` — role × authority expectations, token parsing, UI projection.
- `list-query-filters-all-27-endpoints.test.ts` — 27 endpoints × query permutations, list parser edge cases.

Edge and fake-rails suites contribute:

- `admin-back/test` — 159 declarations across 7 files (admin surface, backups, core contract, client, env isolation, mTLS, academy progress/rate limit/team gate).
- `merchant-back/test` — 84 declarations across 6 files (contracts, forwarding, KYB/external, mTLS, env isolation).
- `checkout-back/test` — 77 declarations across 6 files, including a zero-trust matrix under `test/exhaustive/05-api-matrix`.
- `fake-rails-back/test` — 53 declarations across 4 files, including the 30-test suite-05 file.

The design's merchant/checkout IDOR and Zod-fuzz files do not exist as separate exhaustive files.

### 3.7 Suite 06 — concurrency

Files:

- `single-and-multi-use-slot-races.test.ts` — 50-way single-use and multi-use reservations, release clamps.
- `confirm-webhook-return-race.test.ts` — 50 confirm claims, 10 slot commits, duplicate journal idempotency, 20 duplicate webhooks.
- `multi-node-workers-skip-locked.test.ts` — four workers × 200 due jobs, crashed lease recovery, retry/backoff.

All use live PostgreSQL and skip when the database is unreachable.

### 3.8 Suite 07 — workflows

Files:

- `onboarding-and-aml.test.ts` — KYB magic bytes, four-eyes triggers, Arabic normalisation, seven AML rule types and severity helpers.
- `recon-and-go-live-gates.test.ts` — statement CSV/date parsers and all twelve go-live gates.

The design's separate dispute/chargeback, reconciliation-engine and Smart AI importer files are not present in this directory. Smart AI importer tests live in `core-back/test/spec-importer.test.ts` and `spec-materializer.test.ts`.

### 3.9 Suite 08 — security and edge cases

Files:

- `stride-24-and-15-safeguards.test.ts` — 31 declarations covering SSRF addresses, DNS rebinding, host pinning, redirects, response size, XML entity bombs, deep JSON, CRLF, header injection, path traversal, HTTPS enforcement and encoding.

The 140-case catalog lives in `core-back/test/edge-cases/catalog-140.test.ts`, not under `08-security-edge`. That file has a large dynamic test generation loop and a `TODO_CASE_IDS` set that is currently empty.

### 3.10 Suite 09 — storage, replicas and backup

There is **no** `core-back/test/exhaustive/09-storage-backup` directory. The runner's `T-EX-09` executes:

- `core-back/test/storage-engine` — unit and live PostgreSQL storage tests, including `uow`, `read-store`, `ledger-shards`, `audit-chain`, `cache-velocity`, `outbox-workers`, `log-sink`, `engine-factory`, `write-path.integration` and `performance`.
- `core-back/test/backup-admin` — backup routes and control client.
- `deploy/backup-daemon/test` — 71 declarations across 8 files.

Some files skip without PostgreSQL or Redis. The design's dedicated fixture names (`uow-outbox-audit-atomicity.test.ts`, `gl-shards-and-lsn-routing.test.ts`, `audit-chain-and-log-backpressure.test.ts`, `backup-control-and-drills.test.ts`, `backup-restore-matrix.test.ts`) do not exist.

### 3.11 Suite 10 — UI surface

The design expects four `*/e2e/exhaustive/10-ui-surface/` folders. The actual UI suites are in `tests/e2e/exhaustive`:

| File | Generated tests | Coverage |
| :--- | ---: | :--- |
| `exhaustive-admin-surface.spec.ts` | 300 | 25 routes × 3 viewports × 2 locales × 2 themes |
| `exhaustive-merchant-surface.spec.ts` | 168 | 14 routes × 3 viewports × 2 locales × 2 themes |
| `exhaustive-checkout-surface.spec.ts` | 6 | 1 route × 3 viewports × 2 locales × 1 theme |
| `exhaustive-fake-rails-surface.spec.ts` | 12 | `/login` × 3 viewports × 2 locales × 2 themes |

Each admin/merchant test asserts a visible `.pg-page`, no `#app` transform, no horizontal overflow, app-bar/content non-overlap, document direction and dark/light class. The APIs are fully mocked. The checkout test mocks `/api/v1/pay/**`. The fake-rails test mocks `/portal-api/**` and `/hosted/**`.

Non-exhaustive UI specs add auth, accessibility, shell, dialog, finance, backup, search and operator-case coverage, but they also mock API responses.

The core/deploy parts of suite 10 are:

- `core-back/test/exhaustive/10-seeder-and-deploy/synthetic-seeder-safety-and-audit.test.ts` — 21 declarations.
- `deploy/test/*.test.ts` — 119 declarations, including the 20-test deploy topology matrix.
- `deploy/backup-daemon/test` — 71 declarations.

### 3.12 Suite 11 — cross-service E2E

There is no `tests/e2e/exhaustive/11-e2e-seeder-deploy` directory. The closest file is `tests/e2e/exhaustive/full-platform-lifecycle-journeys.spec.ts` (5 tests). The suite registers `test.skip(!LIVE, ...)` and requires `E2E_LIVE=1`; the link journey also requires `E2E_LINK_KEY`.

The seeder checks live in suite 10, and the deploy matrix lives in `deploy/test/exhaustive-deploy-matrix.test.ts`. There is no browser journey from merchant onboarding through checkout, fake rails, ledger, reconciliation and cash-out.

### 3.13 Actual declaration totals

| Root | Literal declarations |
| :--- | ---: |
| `core-back/test` | 1,147 |
| `admin-back/test` | 159 |
| `merchant-back/test` | 84 |
| `checkout-back/test` | 77 |
| `fake-rails-back/test` | 53 |
| `deploy/test` | 119 |
| `deploy/backup-daemon/test` | 71 |
| `tests/e2e` | 65 |
| `tests/e2e-live` | 6 |
| `tests/unit` | 26 |
| **Total** | **1,807** |

This count matches `\b(test|it)\s*\(`. It excludes dynamic loop iterations, so the executed test count is higher, especially in suites 01-04. It is far below the 38,500 claim. The stale-claims register records 1,778; the working tree has about 29 more declarations.

## 4. Contracts and invariants

1. **Suite numbering is not the same as directory numbering.** The runner's `T-EX-09b` and `T-EX-10` do not match the design's Suite 10 and 11.
2. **A file name is not a count.** `all-15-templates-matrix` contains 20 variants; `all-20-gateways-24-scenarios` contains 21 gateway codes and 26 scenarios.
3. **Skipped is not passed.** DB, Redis and live suites must name their skip reason.
4. **Mocked UI tests prove rendering, not behaviour.** They must not be cited as payment-flow evidence.
5. **The runner must be the source of truth for gate order.** Use `scripts/run-exhaustive-suite.sh`, not the design's checklist.

## 5. Data / API / config / deployment surface

- Core suites: `core-back/test/exhaustive/**`.
- Edge suites: `admin-back/test`, `merchant-back/test`, `checkout-back/test`.
- Fake-rails suites: `fake-rails-back/test`.
- Deploy suites: `deploy/test`, `deploy/backup-daemon/test`.
- UI suites: `tests/e2e`, `tests/e2e-live`, `tests/unit`.
- Runner: `scripts/run-exhaustive-suite.sh`.

## 6. Operational usage

```bash
# One core suite
cd core-back && bun test test/exhaustive/01-schema

# One fake-rails suite
cd fake-rails-back && bun test test/exhaustive/05-api-matrix

# One UI file
cd tests && bunx playwright test -c playwright.exhaustive.config.ts e2e/exhaustive/exhaustive-admin-surface.spec.ts

# Full gate
./scripts/run-exhaustive-suite.sh
```

`bun test --parallel=1` is required for DB suites. Playwright runs with one worker in all configs.

## 7. Status and deviations

### Implemented

- Suites 01-08 and 10 core directories.
- Storage, backup and edge-backend suites.
- Mocked UI walkers across four portals.
- Deploy topology and fake-rails configuration tests.

### Partial

- Suite 05 is split across workspaces and lacks separate merchant/checkout exhaustive files.
- Suite 09 is a command substitution, not a suite directory.
- Suite 10/11 numbering and locations differ from the design.
- Suite 11 has only opt-in health/lifecycle probes, not the full journeys.

### Missing / deferred

- `core-back/test/exhaustive/09-storage-backup`.
- `tests/e2e/exhaustive/11-e2e-seeder-deploy`.
- Real browser payment journeys without API mocks.
- A restore-drill matrix file.
- A deep-search suite.
- The claimed 38,500 assertion volume.

### Known bugs / risks

- **Documentation bug:** the design's matrix table overstates suite volume and understates current model/gateway variant counts.
- **False confidence:** UI suites can pass while every real API is broken because `mockApi()` returns `{}`.
- **False confidence:** suite 04 is named as a live fake-rails matrix but uses an in-process harness.
- **False confidence:** suite 09 can be reported as run while its files skip for missing PostgreSQL/Redis.

## 8. Verification and tests

This catalog is derived by counting literal declarations and inspecting the suite files. It is not a test run. The commands in section 6 reproduce the counts and expose the skips.

- `rg -c "\b(test|it)\s*\(" <root> --glob '*.ts'` reproduces the declaration table.
- `find core-back/test/exhaustive -maxdepth 1 -type d` shows the missing suite 09.
- `find tests/e2e/exhaustive -maxdepth 1 -type f` shows the absence of suite 11.

## 9. Source references

### Old design sections

- `design/05-testing/master_exhaustive_test_plan_for_opencode.md` section 1.
- `design/05-testing/master_exhaustive_test_plan_for_opencode.md` sections 2-12.
- `design/05-testing/master_exhaustive_test_plan_for_opencode.md` section 13.

### Code paths

- `core-back/test/exhaustive/**`
- `core-back/test/storage-engine/**`
- `core-back/test/edge-cases/catalog-140.test.ts`
- `admin-back/test/**`
- `merchant-back/test/**`
- `checkout-back/test/**`
- `fake-rails-back/test/**`
- `deploy/test/**`
- `deploy/backup-daemon/test/**`
- `tests/e2e/**`
- `tests/e2e-live/**`
- `tests/unit/**`

### Generated appendices

- `project-design/appendices/test-inventory.md`

## 10. Change history

- 2026-11-03: initial canonical part. Verified against `5a24f6f+working-tree`.

### Employee Academy suites (2026-11-04)

- `tests/unit/academy-content.test.ts` (extractor determinism, spec counts, references, blueprint pool depth, key-leak guard, corrupted-source failures), `academy-lab-scoring.test.ts` (all 18 published lab vectors + edge cases), `academy-progress-merge.test.ts`, `academy-next-step.test.ts`.
- `core-back/test/academy-exam-engine.test.ts`, `academy-progress.test.ts`, `academy-team.test.ts`: DB-free, fake store with injected clock/ids (`bun test test/academy-`).
- `admin-back/test/academy-progress.test.ts`: proxy validation, 429 and `SECURITY_ADMIN` gate (rate-limit tests use a mini app so they do not feed the shared per-IP admin limiter).
- `tests/e2e/admin/academy-{learning,lab,exam,team,a11y}.spec.ts` (+ helper `academy-live.ts`): live-stack specs, skipped unless `E2E_LIVE=1` and `PG_PASSWORD`; written and listed, not yet run (no loginable account on the local stack).

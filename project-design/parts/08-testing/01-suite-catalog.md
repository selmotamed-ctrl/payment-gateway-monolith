---
id: testing.suites
title: Test Suite Catalog
status: partial
confidence: high
last_verified: 2026-11-12
verified_against: 19d6a54+working-tree
code:
  - core-back/test/exhaustive/**
  - core-back/test/storage-engine/**
  - core-back/test/storage-engine/performance/ledger-query-pruning-and-accuracy.test.ts
  - core-back/test/edge-cases/**
  - admin-back/test/**
  - merchant-back/test/**
  - checkout-back/test/**
  - fake-rails-back/test/**
  - deploy/test/**
  - deploy/backup-daemon/test/**
  - deploy/object-storage-daemon/test/**
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
  - admin-back/test/security-regressions.test.ts
  - merchant-back/test/security-regressions.test.ts
  - checkout-back/test/security-regressions.test.ts
  - deploy/test/security-regressions.test.ts
  - deploy/test/preflight.test.ts
  - deploy/backup-daemon/test/mtlsAuthorization.test.ts
  - deploy/object-storage-daemon/test/mtls.test.ts
  - deploy/object-storage-daemon/test/sdk-mtls.test.ts
  - fake-rails-back/test/security.test.ts
  - tests/unit/frontend-security-admin.test.ts
  - tests/unit/frontend-security-checkout.test.ts
  - tests/unit/frontend-security-merchant.test.ts
  - tests/e2e/admin/commerce-governance.spec.ts
  - tests/e2e/admin/wallet-details.spec.ts
  - tests/unit/commerce-governance.test.ts
  - tests/unit/commerce-actions.test.ts
  - tests/unit/wallet-details.test.ts
  - tests/unit/commerce-owners-revalidation.test.ts
  - tests/unit/commerce-i18n.test.ts
  - tests/unit/ledger-ops-ledger.test.ts
  - tests/unit/ledger-ops-operations.test.ts
  - tests/unit/json-diff-model.test.ts
  - tests/unit/audit-summary.test.ts
  - tests/unit/commission-tiers.test.ts
  - tests/unit/dispute-evidence.test.ts
  - tests/unit/builders-route-models.test.ts
  - tests/unit/builders-settings-parser.test.ts
  - tests/unit/builders-aml-templates.test.ts
  - tests/unit/builders-api-error-i18n.test.ts
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

- `all-15-templates-matrix.test.ts` — despite the file name, it defines **21 template variants** (T1-T15 plus T5b, T6b, T6c, T7b, T10b, T15b) and asserts 1,260 combinations.
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

- `core-back/test/storage-engine` — unit and live PostgreSQL storage tests, including `uow`, `read-store`, `ledger-shards`, `audit-chain`, `cache-velocity`, `outbox-workers`, `log-sink`, `engine-factory`, `write-path.integration` and `performance`. `performance/ledger-query-pruning-and-accuracy.test.ts` is the EC-01..EC-18 gate of the ledger query/index optimisation: month-boundary rollover, multi-month pages, empty pages, EXPLAIN partition pruning, Index-Only Scans with `Heap Fetches: 0`, single-pass statement totals, the null-ceiling short-circuit, delayed netting and AML capture entries, journal_entries index plans, future-partition settings/grants, checkpoint+repair, and the restore-drill queries. `leader-election-pgbouncer.test.ts` starts a throwaway PgBouncer (skipped when PostgreSQL or the `pgbouncer` binary is unavailable) and proves that transaction pooling lets two clients hold one advisory lock, that the `pgw_session` alias enforces one leader and fails over after `pg_terminate_backend`, and that the boot probe accepts only the session alias.
- `core-back/test/hardening-gap-regressions.test.ts` covers the leader-election environment guard, backend-PID/`pg_locks` ownership checks, refused unlocks, the session-safety probe and the durable `inbound_events` claim lease.
- `core-back/test/backup-admin` — backup routes and control client.
- `deploy/backup-daemon/test` — 71 declarations across 8 files.
- `deploy/test/preflight.test.ts` — selection by `--only`/`--nodes` and aliases, dry-run no-connect behavior, and port classification (free, managed PM2 current/orphan, same-repo dev, foreign, Nginx, expected PostgreSQL data directory).
- `core-back/test/worker-runtime-health.test.ts` — `/health` advertises `APP_RELEASE`/`APP_COMMIT`.
- `deploy/test/healthVerifierScale.test.ts` — verification rejects a health payload from a different release.
- `admin-front/src/pages/system/jobs-outbox/components/__tests__/MonitorTable.test.ts` — the Jobs & Outbox table declares its `dc` props and never builds a filter query from an undefined list.
- `tests/e2e/admin/jobs-outbox.spec.ts` — all four Jobs & Outbox tabs render with mocked APIs without the previous `reduce` error.
- `tests/e2e/admin/object-storage-style.spec.ts` — `/system/object-storage` uses the shared page/table surfaces: one `ApiTable` card, the built-in filter grid with Namespace/Status/Bucket/Legal hold/Owner/SHA-256 fields, and no nested table card, against mocked storage APIs.
- `deploy/object-storage-daemon/test` — HTTP surface plus real mTLS: allowed/denied/missing/untrusted client certificates, TLS 1.3 enforcement, a PUT/GET over the TLS-to-HTTP bridge, and `RemoteMtlsBlobStore` health/put/get/stat/list over mTLS. The openssl-backed cases skip if the CLI is unavailable.

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
| `deploy/object-storage-daemon/test` | 7 literal + 9 `live` (16 executed) |
| `tests/e2e` | 65 |
| `tests/e2e-live` | 6 |
| `tests/unit` | 26 |
| **Total** | **1,814** |

This count matches `\b(test|it)\s*\(`. It excludes dynamic loop iterations and the `live` alias used by the openssl-backed object-storage mTLS cases, so the executed test count is higher, especially in suites 01-04. It is far below the 38,500 claim. The stale-claims register records 1,778; the working tree has about 36 more declarations.

### 3.14 Report engine SDK tests

`core-back/test/reportEngineSdk/**` implements the RE-T01..RE-T22 matrix from `design/12-reporting/dynamic_ai_transcript_report_engine_sdk_plan.md`: structural/bilingual validation, partition and EXPLAIN safety, forbidden secrets, merchant isolation, authority inference/override, read-only executor rejection and timeout recovery, asset bundle traversal/magic bytes, sanitizer, transforms, chrome resolution, input Zod compilation, dry run, transcript/repair prompt and SDK decoupling. `admin-front/src/lib/reportEngineSdk/__tests__/**` covers value formatting, preset defaults, Arabic/RTL rendering, chrome binding, language options, paged-media CSS and the client sanitizer. The frontend Vitest include list was extended for the report SDK tests.

### 3.15 Report engine and merchant report tests

`core-back/test/reportEngineSdk/**` now covers the original RE-T01..RE-T22 matrix plus PII masking, confidential AML denial/bypass, merchant scope (including OR-bypass), semantic AST diagnostics, asset validation, chrome resolution and SDK decoupling, and the remediation suites: AuthorityAndCatalog (referenced-column PII, relation parsing, sensitivity/AML domains), MerchantReportLine (allow-list, identity injection/row assertion, tier limits), SeedChrome (seed idempotence), ExecuteAndRedaction (bundle comparison assets, aggregate/truncation), and the A08/A09/A10/A11/A12/A14/A15/A16/A17 regression cases. `merchant-back/test/core-forwarding.test.ts` covers the merchant catalog/execute/autocomplete proxy and the merchant Studio proxies. `core-back/test/admin-slice/admin-report-engine.test.ts` (DB-gated) covers version persistence, publish supersede, archive promotion, audience tabs and the merchant mount/authority; `admin-back/test/report-engine-edge.test.ts` covers the 24 MB parser, edge execute/list permissions and the publish proxy. `tests/unit/report-engine-sdk-mirror.test.ts` asserts the admin/merchant client SDK copies are identical; `tests/unit/report-ui-styles.test.ts` pins the shared report input grid/preview CSS in both portals; `tests/unit/report-preview-print-reset.test.ts` pins the post-pagination print reset and asserts the two preview bridges are byte-identical; `tests/unit/builders-settings-parser.test.ts` covers the `merchant_reports.policy` Platform Setting editor. Core unit tests `report-engine-body-path.test.ts` and `MerchantReportPolicy.test.ts` cover the merchant body parser prefix and the staff-managed policy defaults/cache/assets gate. `admin-front/src/lib/reportEngineSdk/__tests__/**` covers the client renderer, chrome variables, enum translation, vector canvas and paged-media contract, including the theme-aware preview canvas, page separation and print reset. The Guide content test was updated for the new Reports screen/article.

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
- Deploy suites: `deploy/test`, `deploy/backup-daemon/test`, `deploy/object-storage-daemon/test`.
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

### Added 2026-11-08 (review-report remediation)

Core, against a real PostgreSQL 18 test database (skipped without one): `core-back/test/refund-merchant-direct.test.ts` (merchant-direct refund ledger lines, rail-engine refund template, receivable balance), `test/merchant-read-scope.test.ts` (merchant read authorities, `app_scope_ids`, KYB duplicate-id scoping, token/IP audit rows), `test/partition-truncate-guard.test.ts` (every `journal_lines` partition is guarded), and the added cases in `test/backup-admin/backup-admin-routes.test.ts` (checker authority, maker != checker, expiry, atomic claim under a race, claim release on daemon failure, backup audit rows). Edges: the failover/replay/framing-header cases in `*/test/core-internal-client.test.ts` (all three copies) and `admin-back/test/security-regressions.test.ts`. Deploy: `ci-workflows.test.ts` (master trigger, `core-back` job with services and the skip guard, companion secret gating), the `--fresh` probe-failure, WAL-URL-scheme and trusted-proxy cases. Companion: `tests/updates.test.ts`. Root unit: `academy-progress-user-scope.test.ts`. Fake rails: hosted-session OTP/webhook redaction in `test/api.test.ts`.

**Known order-dependent failure (pre-existing, 2026-11-08).** `admin-back/test/backups.test.ts` passes on its own but 20 of its tests return `429 RATE_LIMITED` when the whole `admin-back` suite runs in one process (a limiter shared across files; identical on the pre-change tree). Run that file alone until the limiter state is isolated per test file.

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

- `tests/unit/academy-content.test.ts` (extractor determinism, spec counts, references, blueprint pool depth, key-leak guard, corrupted-source failures), `academy-lab-scoring.test.ts` (all 18 published lab vectors + edge cases), `academy-progress-merge.test.ts`, `academy-next-step.test.ts`, `academy-lesson-body.test.ts` (the displayed lesson prose never includes the structural Read now / Check yourself sections or raw check ids).
- `core-back/test/academy-exam-engine.test.ts`, `academy-progress.test.ts`, `academy-team.test.ts`: DB-free, fake store with injected clock/ids (`bun test test/academy-`).
- `admin-back/test/academy-progress.test.ts`: proxy validation, 429 and `SECURITY_ADMIN` gate (rate-limit tests use a mini app so they do not feed the shared per-IP admin limiter).
- `tests/e2e/admin/academy-{learning,lab,exam,team,a11y}.spec.ts` (+ helper `academy-live.ts`): live-stack specs, skipped unless `E2E_LIVE=1` and `PG_PASSWORD`; written and listed, not yet run (no loginable account on the local stack).

## Security regression suites (2026-11-05)

| Suite | Covers |
| :--- | :--- |
| `core-back/test/security-regressions/c1-forged-success` | payer evidence ignored, SUBMIT with no steps |
| `.../c2-mfa` | MFA challenge rows, throttles, retired verify-identity |
| `.../h1h2-authz` | merchant authority catalogue, principal separation |
| `.../h3-admin-users-and-approvals` | admin user maker-checker, conditional approval claims |
| `.../h4-cashout` | cash-out state machine, idempotency, balance checks |
| `.../h7-rounding` | commission rounding modes |
| `.../h8-webhook` | webhook verification, timestamps, inbound dedupe |
| `.../m4-idempotency` | (linkId, idempotencyKey) scoping |
| `.../m9-m12-upload-kyb` | upload hash conflict, KYB scan modes |
| `.../m10-ssrf` | outbound URL compile |
| `admin-back/test/security-regressions.test.ts` | authorityGuard, backup validation, uploads |
| `merchant-back/test/security-regressions.test.ts` | token creation, uploads, limiter |
| `checkout-back/test/security-regressions.test.ts` | inbound limiter, body limits, error mapping |
| `deploy/test/security-regressions.test.ts` | quoting, config hardening, migration planning |
| `deploy/test/preflight.test.ts` | selection/aliases, dry-run, port ownership classes, expected PostgreSQL data dirs |
| `deploy/backup-daemon/test/mtlsAuthorization.test.ts` | CN/SAN authorization |
| `fake-rails-back/test/security.test.ts` | token compare, CIDR, lockout |
| `tests/unit/frontend-security-{admin,checkout,merchant}.test.ts` | frontend allow-lists, guards, validation |

Run with `bun test ./path`. Concurrency tests need PostgreSQL 18 and are not covered.

## Admin UI completion suites (2026-11-06)

- **Unit (`tests/unit`, vitest, 490 passing in 30 files):** pure logic of the new UI: governance action tables per state (immediate vs approval), owner/revalidation forms, journal/route-cap/lifecycle/health/jobs models, the JSON diff model, audit summaries (`formatAuditValue`, `describeAuditChange`), commission tiers, dispute evidence mapping, and the builders' round trips (cost model, scope, maintenance windows, parser config, AML params, settings schemas, template variables) including unknown-key preservation. `commerce-i18n` and `builders-api-error-i18n` assert that every message key the logic can produce has an Arabic entry. `frontend-security-admin` (default-deny route authorities, alias map) and `guide-content` (every router name has a context-map screen) caught the six new routes until they were registered properly. `guide-markdown-refs` covers the clarity renderer helpers (parenthetical reference extraction, meaningful-prose preservation, short labels, preview snippets); `guide-content` also runs the clarity `--check` gate.
- **E2E (Playwright, needs Chrome: set `PLAYWRIGHT_CHROME_PATH=/usr/bin/google-chrome-stable` when the bundled browser is not installed):** `e2e/admin/wallet-details.spec.ts` drives the wallet details page against mocked responses (Inspect and old `?open=` links land on `/wallets/:id`; the shard **Total** row has cell padding; the statement is paged by the server with totals of the whole result and a side filter sent as `direction=`; the tab survives a reload; a journal entry opens above the page and above the GL account drawer, checked with `elementFromPoint`; the GL drawer paginates its lines; a frozen wallet shows the banner and the status history). `e2e/admin/commerce-governance.spec.ts` drives the wallets page against realistic mocked responses (restricted balances render "Restricted" and never 0; a freeze needs a >=10-character reason and sends exactly `{status: "FROZEN", reason}`; restoring returns HTTP 202 and is reported as submitted for approval; a read-only role gets no freeze action). `exhaustive-admin-surface.spec.ts` now covers 31 routes (the six new ones included) across 3 viewports x 2 locales x 2 themes (372 combinations: no horizontal overflow, correct direction and theme, app bar never overlapping). `e2e/admin/backups.spec.ts` was updated for the second confirmation the page has asked for since the frontend hardening commit (its spec was stale). `e2e/admin/guide-reader.spec.ts` also holds the phone-width regression for guides: a wide article table and the edge-case catalogue must scroll inside their wrapper, keep `overflow-wrap: normal` on cells and never make the page itself overflow horizontally.
- **Component compliance (`admin-front` `bun run test:unit`):** helper components must live in `components/` subfolders so every route page keeps `PageHeader` (the test stops at the first offender).

## Backup daemon suites (2026-11-06)

`deploy/backup-daemon/test/` (220 tests): `cryptoEnvelope` (HKDF, round trip, every tamper class, signed manifests), `storage` (local/S3/vault tiers, repository fan-out and verified fallback), `wal` (WAL names and lag arithmetic, idempotent ingest and 409 conflicts, mirroring, `pg_receivewal` supervision), `jobQueue`, `catalogMirror`, `pgNativeEngine` (chain resolution, live-policy retention, delta preconditions), `mtlsRoles` (real TLS 1.3 role separation, 50 sequential + 50 concurrent keep-alive requests), plus the updated `backupEngine`, `config`, `server` and `restoreDrillRunner` suites.

`test/lab/two-host.lab.test.ts` is the TWO-HOST LAB (primary on host A, daemon alone on host B over a real LAN, as a systemd service running as `pgbackup`); it skips unless `LAB_B_HOST`, `LAB_B_USER` and `LAB_B_PASSWORD` are set and is not part of CI. `live-pg18-pitr.test.ts` is a LIVE integration test: a private throwaway PostgreSQL under `/tmp` with a Debian-style external config, the real daemon over mTLS, `curl` as `archive_command` and real `pg_receivewal`. It runs full and incremental backups, PITR to a point before an injected operator error, a full+delta chain through `pg_combinebackup`, fault injection (double-entry drift, shard drift, tampered and deleted audit rows, one-byte backup corruption with tier fallback) and asserts the production archive stays free of timeline-2 files. It skips with a message when the PostgreSQL 17+ binaries, `zstd`, `curl`, `tar` or `openssl` are missing.

## Offline companion suites (2026-11-06)

`companion-app/tests/` (Vitest, 23 tests / 4 files) covers the generated content bundle
(counts, cross-document links, lesson reading/check references, external-URL and exam-bank
leak guards), markdown rendering for every article and lesson (unresolved links, callouts,
glossary terms, widget placeholders, stable heading ids, structural lesson trimming,
parenthetical reference extraction, summary/refs callouts, section trays, short labels,
preview snippets and the focusable scrollable table wrapper), the offline MiniSearch index
(`LIMIT_EXCEEDED`, maker-checker, glossary terms), and all 18 published Academy lab-scoring
vectors.

`companion-app/scripts/check-content.ts` is the build gate: it re-runs the canonical Guide
and Academy extractors, compares their output with `admin-front/src/content/**/generated`,
rebuilds the bundle and fails on any drift. `build-apk.sh` runs it before typecheck, tests,
web build, Capacitor sync and Gradle. Web Playwright sweeps 24 routes at 360/390/768 px in
light/dark/sepia and English/Arabic chrome; the signed APK is verified with `apksigner`.
No Android device was connected, so on-device install, airplane-mode, notification reboot
and real-device performance tests remain open.

## Remediation round 2 (2026-11-08): new suites

core-back: `ledger-raw-sql-parity`, `staff-invitation`, `checkout-return-route`, `session-revocation-durability`, `partition-truncate-guard`; admin-back and merchant-back: `auth-account-limiters`; fake-rails-back: `webhook-target`; deploy: `hostProbe`, `pgAppRole`; root `tests/unit`: `admin-bundle-lazy`, `i18n-catalogue`.

## Declarative regulatory reporting suites (2026-11-10)

`core-back/test/reporting-xsd-xlsx.test.ts` (8 tests) covers the safe XSD compiler (paths, facets, enumerations, DOCTYPE/external import rejection), the deterministic XML generator and validator (sequence order, required fields, type and enumeration violations), the XLSX renderer (generated workbook, totals, narrative, required data, formula-injection guard, macro rejection), and the six provisional baseline schemas with a generated STR XML that validates against its compiled XSD. `core-back/test/reporting-rule-evaluator.test.ts` and `test/regulatory-report-lifecycle.test.ts` were updated for DRAFT evaluator reports, encrypted manual payloads, the report approval request and the format-aware submission gate. The report lifecycle suite still uses the governance fake database; the schema/output tables are optional there so the fake remains focused on the lifecycle.


## Reporting studio and automation sweep suites (2026-11-10)

`core-back/test/reporting-generation.test.ts` covers the production generation path and payload-hash binding. `reporting-xsd-xlsx.test.ts` now covers attributes, LTR date mapping, list columns and required narrative sections. `reporting-rule-evaluator.test.ts` and `regulatory-report-lifecycle.test.ts` cover DRAFT reports, encrypted payloads, stale-output filing, approval and format gates. New studio suites are specified in `design/11-automation/reporting_studio_and_automation_test_plan.md`: `reporting-schema-studio.test.ts`, `reporting-output-integration.test.ts`, `reporting-lifecycle-pg.test.ts`, `reporting-xsd-edge.test.ts`, `reporting-xlsx-edge.test.ts`, admin-back forwarding, frontend unit models and Playwright studio flows.

## Reporting Studio completion, INC, DOCX and filing adapters (2026-11-10)

- `core-back/test/reporting-template.test.ts`: named-range parsing, safe-template analysis, binding requirement, prototype style/total/narrative writes, range overflow and unbound-template rejection (4 tests).
- `core-back/test/reporting-docx.test.ts`: DOCX schema parsing, escaped narrative/tables in a valid OOXML package and required-section failure (3 tests).
- `core-back/test/incident-lifecycle.test.ts`: forward-only transitions, postmortem requirement/due date and the de-identified filing payload shape (3 tests).
- `core-back/test/filing-adapters.test.ts`: public-HTTPS endpoint rules, manual no-dispatch and HTTP auth-header/reference capture with a stubbed fetch (3 tests).
- `core-back/test/reporting-xsd-xlsx.test.ts` now expects the seventh (DOCX incident) provisional baseline binding.
- The admin-back suite covers the inbound forwarding schemas; admin-front `test:unit` covers the UI abstraction gate; the root `tests/unit` suite includes the i18n catalogue gate for every new label.

These are development/CI tests only; no production-time test job or test endpoint is created by this change.

## Final compliance regression tests (2026-11-10)

- `admin-back/test/admin-ui-completion.test.ts` now proves that incident filters are forwarded, filing-adapter writes relay 202, and both incident and adapter reads remain confidential.
- `core-back/test/reporting-template.test.ts` now proves a malformed workbook is reported rather than accepted, in addition to named-range mapping and range-overflow coverage.
- Existing core reporting, DOCX, incident, adapter and XLSX tests remain the targeted gate; the full core suite is expected to fail only the four tests that require a reachable PostgreSQL test database.
- Playwright coverage for the new pages should be added when a browser is available: incident create/filter/detail/close/report, filing-adapter approval flow, Studio template upload/reload/analyze/remove, and report adapter filing/submission history at 360/390/768/1280 px in both themes and RTL.

## Report-engine authoring evaluation (2026-11-10)

`report-spec-generator/scripts/eval/pipeline.ts` is the recursive authoring harness: it downloads the current transcript, spawns an unrelated `opencode run` agent with only the transcript and a brief, verifies/saves/executes/mock-previews the resulting spec through the real admin API, and records diagnostics, coverage and chrome artifacts under `report-spec-generator/runs/`. The brief corpus (`report-spec-generator/briefs/*.md`) covers top-N rankings, settlement, latency, failures, ledger, reconciliation, AML, cashouts, Arabic, landscape wide tables and an explicit no-chrome case. The final 12-brief sweep produced a 100% first-pass verification rate and 100% section coverage with the improved transcript.

`tests/e2e/admin/report-a4-layout.spec.ts` is the A4 regression gate. It fetches a mock preview from the live API, renders it through the real client SDK and Paged.js, and fails when any visible element crosses the page content box. Run it with `PLAYWRIGHT_CHROME_PATH=/opt/google/chrome/chrome REPORT_LAYOUT_SPEC=<spec.json> bunx playwright test e2e/admin/report-a4-layout.spec.ts --project=admin`.

## A4 report print gate (2026-11-11)

`tests/e2e/admin/report-a4-layout.spec.ts` renders a real report preview through the client SDK and Paged.js and asserts: no visible rect crosses the sheet, content never exceeds the sheet width, no page has vertical overflow, every table fragment has a `<thead>`, KPI grids have <= 3 columns and no clipped values, chart rows are centered with <= 2 charts, section titles are on the same page as their first content, and landscape/portrait page dimensions match the named page. Options: `REPORT_LAYOUT_SPEC`, `REPORT_LAYOUT_ZIP`, `REPORT_LAYOUT_MODE=MOCK|LIVE`, `REPORT_LAYOUT_PDF` (exports per-locale PDFs) and `REPORT_LAYOUT_HTML`.

## Chrome layout gate (2026-11-11)

`tests/e2e/admin/chrome-layout.spec.ts` renders the published default header/footer on an A4 frame and asserts root fill, full-height accent bars, footer fill, the 1.4 mm three-segment band, header/footer offsets, and localized period/currency/generated-at values. `tests/e2e/admin/chrome-preview.spec.ts` renders the Studio A4 chrome preview with a mocked registry and checks the header, footer and accent band in the sandboxed surface.


## Report compatibility and migration coverage (2026-11-11)

- `core-back/test/reportEngineSdk/Compatibility.test.ts` covers compatible/current specs, engine and spec version mismatches, invalid current schemas, missing metadata, safe parsing and report/chrome migration prompt content.
- `core-back/test/admin-slice/report-engine-migration.test.ts` inserts version-mismatched report/chrome rows and asserts catalog exclusion, structured 409 execution errors, migration listing/prompts, default revocation and reconciliation without 500s.
- `core-back/test/admin-slice/merchant-report-chrome.test.ts` covers merchant chrome publishing/defaulting, tenant isolation, migration listing and prompts, and incompatible-default revocation.
- Route-order suites (`core-back/test/reportEngineSdk/RouteOrder.test.ts`, `admin-back/test/report-engine-route-order.test.ts`, `merchant-back/test/report-engine-route-order.test.ts`) assert that every new static migration/transcript route is registered before a dynamic id route and that the expected endpoints exist.
- `admin-back/test/report-engine-edge.test.ts` and `merchant-back/test/core-forwarding.test.ts` cover migration list pagination/search query forwarding, prompts, Chrome detail, reconciliation, merchant branding and Studio prefill routes.
- Frontend type checks cover the new admin/merchant migration pages, branding editor and Studio query prefill; the existing i18n and SDK mirror gates cover Arabic catalogue completeness and client mirror equality.

## Object storage suites

- `core-back/test/objectStorageEngine.test.ts` — T01–T28 (DB-gated) and DB-free
  pgos1/sniff edge cases; includes no-lock activation, retention-once, GC claim,
  access-log append-only, abandoned quarantine and held discard; runs against a
  real PostgreSQL 18 + Redis.
- `core-back/test/runtime/raw-body.test.ts` — raw-body capture and per-route
  budgets for assets, dispute/AML evidence, reconciliation, KYB and checkout.
- `deploy/test/objectStorageDeploy.test.ts` — T21 topology/PKI/firewall/guard,
  per-consumer certificate placement, safe-path/KEK validation and T22
  parity/escrow/drill, plus the shared `blobStore.ts` drift guard.
- `deploy/object-storage-daemon/test/server.test.ts` — HTTP round-trip, checksum
  mismatch, path traversal, trash/purge and unknown bucket/route refusals.
- `admin-back/test/object-storage-forwarding.test.ts` — verifies page/filter/
  sort/search/access-log forwarding and the legal-hold request path.
- Route/UI coverage still needs a live Playwright pass for the four storage tabs
  and the dispute/AML/reconciliation attachment surfaces.

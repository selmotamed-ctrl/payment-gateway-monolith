---
id: future.deferred
title: Deferred and Partial Features
status: deferred
confidence: medium
last_verified: 2026-11-03
verified_against: 5a24f6f+working-tree
code:
  - core-back/lib/listQuery.ts
  - core-back/lib/storageEngine/ledgerPosterFactory.ts
  - core-back/lib/storageEngine/outboxWorkers.ts
  - core-back/engine/apiConsumer/fakeRailsAllowlist.ts
  - core-back/api/internal/merchant.ts
  - deploy/lib/pkiManager.ts
  - deploy/backup-daemon/src/**
  - fake-rails-back/engine/webhooks/WebhookDispatcher.ts
  - core-back/prisma/syntheticSeeder/**
design_sources:
  - design/00-process/blueprint-management.md#5-documentation-corrections-backlog
  - design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md
  - design/05-testing/master_exhaustive_test_plan_for_opencode.md
  - design/04-fake-rails-and-seeder/fake_payment_rails_service_architecture.md
tests:
  - core-back/test/list-query.test.ts
  - core-back/test/fake-rails-allowlist.test.ts
  - deploy/backup-daemon/test/**
  - core-back/test/storage-engine/**
gaps:
  - This register is not a commitment or a schedule; it records current implementation gaps.
  - Some items are code gaps, some are documentation gaps, and some are intentional deferrals.
  - The voucher, guide v2 and smart-AI voucher halves have dedicated future parts and are only cross-referenced here.
---

# Deferred and Partial Features

## 1. Purpose and scope

This part is the catch-all register for missing or partial features that are not large enough for their own future part. It distinguishes:

- `missing`: designed or expected but absent.
- `partial`: present but narrow or incomplete.
- `deferred`: intentionally postponed with a recorded decision.

The voucher system, guide v2 and the voucher half of the Smart AI importer have dedicated parts in this directory. They are listed here for completeness but their full design lives in those parts.

This file is not current-behaviour documentation for the missing items. Each entry states what exists today and what acceptance would require.

## 2. Design intent (extracted and synthesized from ./design)

The historical design backlog identifies several P0/P1 gaps: schema counts, attempt lifecycle, engine phases, ledger scenarios, transforms, CQRS, replica reads, pagination, audit outbox, backup scheduling, deploy prune, PM2 templates, storage mTLS, admin/merchant routes, guide v2, fake rails, voucher, exhaustive tests and stale frontend notes.

Most factual counts are now fixed in the canonical parts. The remaining items below are behavioural or architectural gaps that require code work, not a doc edit.

## 3. As-built architecture

### 3.1 Deferred feature register

| ID | Feature | Status | Current evidence | Acceptance criteria |
| :--- | :--- | :--- | :--- | :--- |
| D-01 | Voucher Provider Management System | `missing` | No voucher code, schema, API or UI | See `future.voucher`; all phases and tests delivered as a separate service |
| D-02 | Admin Guide v2 | `missing` | Current 12-book guide and 8 academy modules only | See `future.guide-v2`; 14 books/125 articles/151 terms/22 cards/29 situations/5 simulators/8 routes, generated and tested |
| D-03 | Smart AI voucher importer half | `missing` | Gateway importer only in `core-back/engine/specImporter/**` | See `future.smart-ai-voucher`; voucher schema/validator/simulator/materializer/transcript/UI/tests |
| D-04 | Merchant Google OIDC login | `deferred` | `core-back/api/internal/merchant.ts` `/auth/google` returns `501 GOOGLE_IDENTITY_NOT_CONFIGURED` | Configure issuer/client/audience, verify ID tokens, map identities, test success/failure |
| D-05 | Keyset pagination | `partial` | `core-back/lib/listQuery.ts` uses `skip/take` offset pagination with page/pageSize | Add stable cursor keys, cursor encode/decode, index coverage, API compatibility and tests at high offsets |
| D-06 | CQRS ledger read models | `partial` | `ledger.entry_posted` handler is a no-op; only `attempt.transitioned` projects into `rm_merchant_daily_stats`/`rm_route_daily_volumes` | Project ledger entries into read models, make dashboards consume them, test rebuild and idempotency |
| D-07 | Replica read routing | `partial` | Only global search and three merchant list endpoints use `readStore`; most dashboards/lists/exports read primary | Route eligible reads through `readStore`, expose `servedBy`, add lag/fallback tests |
| D-08 | Storage mTLS consumption | `partial` | `pkiManager.ts` generates storage client certs, but PostgreSQL/Redis configs do not consume them | Configure PostgreSQL/Redis TLS, mount certs, verify handshake, add deployment smoke test |
| D-09 | Backup hourly Redis / schedule breadth | `deferred` | Backup scheduler is UTC full/delta/drill only; Redis is part of a triggered backup, not hourly BGSAVE | Add hourly Redis policy if still required, with retention, metrics and tests |
| D-10 | Production restore drill | `deferred` | Restore drill logic and tests exist in `deploy/backup-daemon`, but no production/staging smoke run is recorded | Run a scratch restore on staging, record duration/LSN/row counts/invariant/audit chain, sign report |
| D-11 | Fake rails protocol fidelity | `partial` | See `fake-rails.protocol`; route mismatches, no inbound signatures, six phases missing | Fix route keys, verify auth/signatures, implement missing phases, add per-gateway HTTP tests |
| D-12 | Fake rails 20-gateway seeding | `partial` | 13 core gateway blueprints vs 20 fake descriptors; `cbl_lypay`/`evo_pay` mismatches | Seed all 20 or reduce the descriptor catalogue to the supported 13; make codes identical |
| D-13 | Fake rails webhook callback | `partial` | Default URL inserts `/webhook/`; token naming is hard-coded | Emit `CORE_INBOUND_BASE_URL/:gateway/:env/:pathToken` with the real channel token; add E2E webhook test |
| D-14 | Embedded fake widgets | `partial` | Checkout CSP `script-src 'self'`; renderer allowlists public HTTPS hosts; fake `cspAdditions` are stale | Allow the fake origin in CSP and renderer, provide SRI, exercise the lightbox/3DS flow |
| D-15 | Synthetic seeder breadth | `partial` | 55 collections/9 generators; only payment/adjustment ledger refs; profile volumes not fully enforced | Cover remaining models or document the intentional subset; enforce profile volumes; add audit tests |
| D-16 | Exhaustive suite 09 | `missing` | No `core-back/test/exhaustive/09-storage-backup` directory | Create the suite or rename the runner gate and document the substitution |
| D-17 | Claimed 38,500 assertion volume | `deferred` | About 1,807 literal declarations; matrices expand some suites but not to 38,500 | Replace the claim with measured inventory or implement the missing volume with meaningful tests |
| D-18 | Fake rails production hardening | `deferred` | Plain HTTP listener, in-process limiter, no secret redaction in wire logs | TLS or strictly loopback, shared limiter if multi-instance, redaction before persistence |
| D-19 | Merchant/checkout exhaustive IDOR and Zod fuzz | `partial` | Edge tests exist, but the design's separate merchant IDOR and checkout Zod files do not | Add cross-tenant and schema fuzz matrices to the edge BFFs |
| D-20 | Backup retention/audit retention | `deferred` | Audit outbox marks `shipped_at` and retains rows; no documented purge policy for all outboxes | Define retention windows, implement purge jobs, test dry-run and deletion |

### 3.2 Merchant Google OIDC (D-04)

Current code parses `{ idToken }` and throws `501 GOOGLE_IDENTITY_NOT_CONFIGURED`. The merchant frontend renders a Google button, so a user can reach a dead end. Acceptance requires issuer, client id, audience and JWKS configuration, ID-token signature/claim verification, identity linking or creation rules, replay/expiry checks, audit logging, bilingual errors and tests for valid, expired, wrong-audience and unverified-email tokens.

### 3.3 Pagination (D-05)

`parseListQuery()` normalizes `page`, `pageSize`, search, sort and filters, then `buildListQuery()` returns `skip: (page - 1) * pageSize` and `take`. Every list endpoint uses offset pagination. The design's keyset pagination is not implemented.

Acceptance:

- Stable sort keys with a unique tie-breaker.
- Opaque cursor encoding/decoding with validation.
- Backward-compatible page/pageSize or a documented versioned change.
- Indexes that support the cursor predicates.
- Tests for inserts/deletes between pages, duplicate sort values and high offsets.
- A measured improvement on a large dataset.

### 3.4 CQRS read models (D-06)

`lib/storageEngine/ledgerPosterFactory.ts` emits `ledger.entry_posted`, but `lib/storageEngine/outboxWorkers.ts` handles it as `async () => undefined`. Only `attempt.transitioned` updates `rm_merchant_daily_stats` and `rm_route_daily_volumes`. There is no `rm_wallet_statements`, and dashboards do not read the read models.

Acceptance:

- A ledger projection handler with idempotent upserts.
- Defined rebuild/backfill procedure.
- Dashboard/list queries that consume the read models.
- Lag/consistency monitoring.
- Tests for duplicate events, out-of-order events and rebuild parity.

### 3.5 Replica reads (D-07)

`readStore` supports primary, replica and `{ atLeastLsn }` modes, with lag thresholds, round-robin and primary fallback. The read-store tests are broad but use fake replica handles. Only global search and three merchant list endpoints use it; most reads stay on the primary.

Acceptance:

- A documented routing matrix per endpoint.
- Read-your-own-writes through a commit LSN header where needed.
- Live replica tests for lag, failure and fallback.
- Dashboard/list/export parity tests.
- Metrics for servedBy and replica lag.

### 3.6 Storage mTLS (D-08)

Certificates are generated and distributed by `pkiManager.ts`, but PostgreSQL and Redis configurations do not consume them. The stale-claims register keeps this open.

Acceptance:

- PostgreSQL `ssl=on` with the internal CA and client certificates.
- Redis TLS with the same trust chain.
- Certificate rotation procedure.
- Negative tests for missing/wrong/expired certificates.
- A deployment smoke test proving the encrypted connection.

### 3.7 Backup scheduling and restore (D-09, D-10, D-20)

The backup daemon supports full, delta and drill runs, a policy, a catalog and restore-drill verification. The design's "weekly drill at Tripoli 03:00" and "hourly Redis BGSAVE" are not current behaviour. The scheduler is UTC and Redis is part of a triggered backup.

Acceptance for D-09: a documented schedule with timezone, hourly Redis policy if retained, retention and alerting tests.

Acceptance for D-10: a staging/production drill that records restore duration, replayed LSN, row counts, zero ledger drift, shard parity and audit-chain integrity, and stores a signed report.

Acceptance for D-20: retention policy for audit outbox, inbound events, logs and backups; a purge job with dry-run, batching, metrics and tests.

### 3.8 Fake rails fidelity and seeding (D-11 to D-14, D-18)

The detailed evidence is in the fake-rails parts. The minimum acceptance path is:

1. Make route keys and seeded gateway codes identical for all supported rails.
2. Fix the webhook path and token to the real inbound channel.
3. Add inbound auth/signature verification and per-gateway route tests.
4. Either seed the seven missing gateways or remove them from the descriptor catalogue.
5. Make the embedded widget loadable under the checkout CSP with SRI.
6. Keep the backend loopback-only or add TLS; redact stored wire logs.

### 3.9 Synthetic seeder breadth (D-15)

The seeder covers a documented subset and has safety gates. Acceptance requires either full model coverage or an explicit, tested subset contract; enforcement of profile volumes; correct ledger reference coverage; and a post-seed audit that fails on any uncovered invariant.

### 3.10 Testing gaps (D-16, D-17, D-19)

The suite catalog documents the missing suite 09, the absent suite 11 directory and the large gap between the claimed and actual test volume. Acceptance requires:

- A suite directory or a renamed gate with an explicit substitution.
- A measured test inventory that replaces the 38,500 claim.
- Real merchant IDOR and checkout Zod fuzz matrices.
- Live UI journeys that do not mock every API.

## 4. Contracts and invariants

1. A feature listed as `missing` must not be described as current anywhere else.
2. A `partial` feature must name the narrow adoption and the remaining gap.
3. A `deferred` feature must state who decided to postpone it or point to the tracker/decision log.
4. Acceptance criteria must be testable, not aspirational.
5. Fixing an item requires updating this file, the dedicated part if any, and `project-design/TRACKER.md`.

## 5. Data / API / config / deployment surface

| ID | Primary surface |
| :--- | :--- |
| D-04 | `core-back/api/internal/merchant.ts`, `merchant-back/api/public/auth.ts` |
| D-05 | `core-back/lib/listQuery.ts`, list endpoints |
| D-06 | `core-back/lib/storageEngine/ledgerPosterFactory.ts`, `outboxWorkers.ts`, `rm_*` tables |
| D-07 | `core-back/lib/storageEngine/readStoreAdapter.ts`, search/merchant endpoints |
| D-08 | `deploy/lib/pkiManager.ts`, storage provisioners, PostgreSQL/Redis configs |
| D-09/D-10/D-20 | `deploy/backup-daemon/**`, scheduler, retention workers |
| D-11-D-14/D-18 | `fake-rails-back/**`, `core-back/prisma/seedFakeRails.ts`, checkout renderer/CSP |
| D-15 | `core-back/prisma/syntheticSeeder/**` |
| D-16/D-17/D-19 | `core-back/test/exhaustive/**`, `tests/e2e/**`, edge backend tests |

## 6. Operational usage

There is no runtime switch that enables these features. Track them as engineering work:

```bash
# Pagination and list behaviour
cd core-back && bun test test/list-query.test.ts

# Fake rails allowlist
cd core-back && bun test test/fake-rails-allowlist.test.ts

# Backup daemon
cd deploy/backup-daemon && bun test

# Storage engine
cd core-back && bun test test/storage-engine
```

## 7. Status and deviations

### Implemented

Nothing in this file is fully implemented except the partial foundations named in the evidence column.

### Partial

D-05, D-06, D-07, D-08, D-11, D-12, D-13, D-14, D-15, D-19.

### Missing / deferred

D-01, D-02, D-03, D-04, D-09, D-10, D-16, D-17, D-18, D-20.

### Known bugs / risks

- **Code bug:** Google login is a dead end.
- **Code bug:** ledger projection is a no-op.
- **Code bug:** fake rails route/webhook/widget mismatches prevent end-to-end payment.
- **Security risk:** storage mTLS is not enforced.
- **False claim:** the 38,500 assertion volume is not supported by the repository.

## 8. Verification and tests

Each item's acceptance criteria are the tests to add. The current partial evidence is:

- `core-back/test/list-query.test.ts` for offset pagination.
- `core-back/test/storage-engine/read-store.test.ts` and `engine-factory.test.ts` for replica routing primitives.
- `core-back/test/fake-rails-allowlist.test.ts` for SSRF scoping.
- `deploy/backup-daemon/test/**` for restore drill logic.
- `core-back/test/exhaustive/04-rail-engine/**` for engine flows, not live fake-rails.
- `core-back/test/spec-importer.test.ts` and `spec-materializer.test.ts` for the gateway AI half.

No test currently verifies D-04 success, D-06 projection, D-08 encrypted storage, D-10 production restore or D-17 volume.

## 9. Source references

### Old design sections

- `design/00-process/blueprint-management.md` section 5.
- `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md` sections 5-7.
- `design/05-testing/master_exhaustive_test_plan_for_opencode.md` sections 1-13.
- `design/04-fake-rails-and-seeder/fake_payment_rails_service_architecture.md` sections 2-7.
- `design/09-voucher-system-external/Voucher-Provider-Management-System-Technical-Design.md`.
- `design/07-guides-and-academy/guide_system_design_and_content.md`.
- `design/08-ai-onboarding/smart_ai_rail_and_voucher_onboarding_plan.md`.

### Code paths

- `core-back/lib/listQuery.ts`
- `core-back/lib/storageEngine/ledgerPosterFactory.ts`
- `core-back/lib/storageEngine/outboxWorkers.ts`
- `core-back/lib/storageEngine/readStoreAdapter.ts`
- `core-back/api/internal/merchant.ts`
- `core-back/prisma/syntheticSeeder/**`
- `deploy/lib/pkiManager.ts`
- `deploy/backup-daemon/src/**`
- `fake-rails-back/engine/webhooks/WebhookDispatcher.ts`
- `fake-rails-back/api/rails/**`
- `checkout-front/src/components/renderers/EmbeddedWidgetRenderer.tsx`

### Generated appendices

- `project-design/appendices/stale-claims-register.md`
- `project-design/appendices/test-inventory.md`
- `project-design/appendices/env-and-config-matrix.md`

## 10. Change history

- 2026-11-03: initial deferred/partial register. Status values are per item; the part-level status is `deferred`.

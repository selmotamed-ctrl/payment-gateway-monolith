---
id: core.seeder
title: Synthetic Seeder
status: partial
confidence: high
last_verified: 2026-11-03
verified_against: 5a24f6f+working-tree
code:
  - core-back/prisma/syntheticSeeder/**
  - core-back/prisma/seedFakeRails.ts
  - fake-rails-back/api/portal/seederSync.ts
  - deploy/deploy.ts
  - deploy/lib/hostPlanner.ts
  - deploy/lib/configSchema.ts
tests:
  - core-back/test/synthetic-seeder.test.ts
  - core-back/test/exhaustive/10-seeder-and-deploy/synthetic-seeder-safety-and-audit.test.ts
  - fake-rails-back/test/api.test.ts
gaps:
  - Seven profile volume fields are unused; their collections are derived from merchant count.
  - Only 49 of the 55 in-memory collections are written by the bulk writer.
  - Notification template coverage is 10 rows, and generated notifications use only four codes.
  - Several ciphertext columns are plain base64, not Vault ciphertext.
  - The seeded admin `authoritiesMap` shape does not match the auth parser; seeded staff resolve to zero authorities.
  - Deploy writes `SYNTHETIC_SEED_YEARS_SPAN` while the seeder reads `SYNTHETIC_YEARS_SPAN`.
  - The safety gate does not verify the database host.
  - `nextId` ignores the namespace and can collide across seed keys.
---

# Synthetic Seeder

## 1. Purpose and scope

The synthetic seeder builds a deterministic, multi-year operational history for a designated test/sandbox deployment that is wired to the Fake Payment Rails emulator. It exists so the portals, lists, filters, reconciliation, AML, operator cases, ledger checkpoints and dashboard-style views have realistic data without copying production records.

It owns:

- the five-layer safety gate;
- the scale profiles and environment parsing;
- the chronological simulation clock and Libyan market seasonality;
- the nine domain generators;
- the in-memory 55-collection dataset;
- the topological, chunked bulk writer;
- Fake Rails transaction/event synchronization;
- KYB document enrichment through the Vault;
- the completed-run registry in `platform_settings`;
- the in-memory and post-seed invariant audit.

It does not own the baseline seed (gateways, rails, flows, GL accounts and credential sets) or the Fake Rails emulator implementation. It depends on both. The seed is optional and must never run against a production or non-Fake-Rails environment.

## 2. Design intent (extracted and synthesized from ./design)

The historical seeder specification describes:

- a test-server-only seeder guarded by an explicit environment declaration and a live Fake Rails handshake;
- three scale profiles (COMPACT, STANDARD, STRESS) with a multi-year span;
- realistic Libyan market seasonality: weekday/weekend rhythm, Ramadan/Eid peaks, salary-day spikes and historical outages;
- coverage of the entire schema, including every attempt state, ledger templates, checkpoints, reconciliation, disputes, AML and maker-checker queues;
- a two-phase design: build an in-memory chronological graph, then bulk-write it in foreign-key order;
- Fake Rails bulk synchronization so inquiries, refunds and statement reconciliation hit the emulator coherently;
- encrypted KYB document payloads, not fake plaintext;
- a post-seed audit that proves zero ledger drift and balanced entries.

The actual implementation keeps the two-phase design, the safety gate and the audit, but its coverage is narrower than the specification:

- it writes 49 model collections out of 55 in-memory collections;
- seven profile volume fields are not used, so join requests, KYB documents, owners, users, wallets, applications and AML cases are derived rather than controlled;
- several ciphertext fields are plain base64 rather than Vault ciphertext;
- the seeded staff authority map does not match the auth parser;
- the deployed years-span key does not match the key the seeder reads;
- the safety gate checks the declared test flag and Fake Rails hosts but not the database host.

## 3. As-built architecture

### 3.1 Safety gate

`core-back/prisma/syntheticSeeder/SeederSafetyGate.ts` implements five checks before any context is created:

1. `IS_TEST_SERVER === "true"` — otherwise `SEEDER_BLOCKED_NOT_TEST_SERVER`.
2. `FAKE_RAILS_ENABLED === "true"` and `FAKE_RAILS_PUBLIC_BASE_URL` is set — otherwise `SEEDER_BLOCKED_FAKE_RAILS_DISABLED`.
3. When `NODE_ENV === "production"`, `FAKE_RAILS_ALLOW_IN_PRODUCTION === "true"` is required.
4. `FAKE_RAILS_ALLOWED_HOSTS` is non-empty and every configured `gateway_environments.baseUrls` host is in that set. Invalid URLs, empty gateway sets and external hosts fail closed.
5. A live `POST /portal-api/internal/seeder-handshake` with `x-fake-rails-seeder-token` must succeed within 10 seconds.

The gate does not inspect `DATABASE_URL`, the host name of the core database, or the presence of production data. It trusts `IS_TEST_SERVER` and the gateway host allowlist. A mis-pointed test flag against a production database is not blocked by code.

### 3.2 Configuration and profiles

`core-back/prisma/syntheticSeeder/config.ts` defines:

- `SeederProfile = "COMPACT" | "STANDARD" | "STRESS"`;
- 19 `ProfileVolumes` fields;
- `PROFILES` with the three volume sets;
- `loadSeederConfig()` reading `SYNTHETIC_SEED_PROFILE` (or `SYNTHETIC_DATA_PROFILE`), `SYNTHETIC_SEED_KEY` (or `SYNTHETIC_DATA_SEED`), `SYNTHETIC_DATA_NAMESPACE` and `SYNTHETIC_YEARS_SPAN` (or `SYNTHETIC_DATA_YEARS`).

| Profile | Merchants | Payment links | Attempts | Recon items | Operator cases | Years |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| COMPACT | 65 | 8,500 | 15,000 | 12,000 | 450 | 3.5 |
| STANDARD | 250 | 65,000 | 120,000 | 95,000 | 2,900 | 3.5 |
| STRESS | 1,200 | 280,000 | 500,000 | 400,000 | 11,500 | 4.0 |

The seven volume fields not referenced by any generator are `joinRequests`, `kybDocuments`, `beneficialOwners`, `users`, `wallets`, `applications` and `amlCases`. Their collections are produced as a function of merchants: join requests per merchant lifecycle, one or more wallets and GL accounts per merchant, 1–3 applications, 1–4 users per merchant, KYB documents per business category, owners per ownership threshold, and AML cases from a sample of non-clear screenings.

`yearsSpan` is used by the timeline. `SYNTHETIC_YEARS_SPAN` is parsed as a positive number and overrides the profile value.

### 3.3 Context and ID factory

`createContext` loads existing references (`gateways`, versions, rails, routes, credentials, GL accounts, admin users, statement sources), builds a seeded PRNG from `seedKey`, builds the timeline, creates an empty dataset, and creates `nextId`.

`nextId` ignores its `entity` argument and returns:

```text
00000000-0000-7000-8000-<counter hex padded to 12>
```

This is a UUIDv7-shaped, visually distinct synthetic id. It is stable within a run. Because the counter resets for every run and the namespace is not included, two different seed keys generate the same ids; `skipDuplicates` then drops the second dataset instead of creating a parallel history.

### 3.4 Timeline

`core-back/prisma/syntheticSeeder/timelineClock.ts`:

- `buildTimeline(now, yearsSpan)` sets `start = now - round(yearsSpan * 12) months` at 08:00 UTC and `end = now`;
- `adoptionMultiplier` grows from 1.0 to 8.0 over the span;
- `dayVolumeMultiplier` applies Friday 0.72, Saturday 1.05, salary window 1.35, Ramadan 1.8 and Eid 1.5;
- `businessHour` returns a Tripoli-style hour distribution;
- `dateAt` writes the chosen hour with `setUTCHours`.

There is no +2 offset or timezone database conversion. The simulated "Tripoli hour" is stored as a UTC hour. This is a modeling simplification, not a production behavior.

### 3.5 The nine generators

| Generator | Main outputs |
| :--- | :--- |
| `01_adminAndStaffGenerator` | 12 platform users across `GATEWAY_ADMIN`, `SECURITY_ADMIN`, `FINANCE`, `OPERATOR`, `COMPLIANCE`, `MLRO`, `SUPPORT`; maker/checker flags; user identities; 10 notification templates; velocity, AML and reporting rules |
| `02_merchantCohortGenerator` | Merchant lifecycle states; wallets and GL accounts; 1–3 applications; merchant users; join requests and status transitions; KYB documents; beneficial owners; duplicate-document showcase |
| `03_gatewayLifecycleGenerator` | Version history (`SUPERSEDED`, `LIVE`, and up to two `PENDING_APPROVAL`); environments; auth rows; settings; confirmation channels; go-live evidence; statement sources; 30 days of hourly route health samples |
| `04_linksAndAttemptsGenerator` | Payment links across states; attempt groups; attempts across all 14 statuses; masked customer fields; step logs; inbound events; OTP/failure/conflict/late-success/manual-review substatuses |
| `05_ledgerAndCheckpoints` | Balanced journal entries for succeeded/refunded/partially refunded/disputed attempts; refund, partial-refund and chargeback entries; monthly GL checkpoints except the current month |
| `06_reconAndStatements` | Reconciliation runs across the span; statement items with matched and exception results; stats JSON; exception budget derived from operator-case volume |
| `07_disputesCashoutsAdjustments` | Disputes across seven statuses; chargeback/refund adjustments; cash-out requests; negative-balance wallets after post-cashout chargebacks |
| `08_amlAndGovernanceQueues` | Screenings and matches across the seven-layer history; AML cases; regulatory reports; approvals; notifications; audit logs; detail change logs |
| `09_operatorCasesGenerator` | Operator cases for UNKNOWN, HELD, CONFLICT, MISMATCH, LATE_SUCCESS, MANUAL_REVIEW and UNMATCHED_STATEMENT; SLA/priority; evidence links; maker-checker resolutions |

### 3.6 The 55 in-memory collections

`core-back/prisma/syntheticSeeder/dataset.ts` defines 55 arrays:

- Identity and onboarding: `users`, `userIdentities`, `merchants`, `joinRequests`, `kybDocuments`, `beneficialOwners`, `wallets`, `glAccounts`, `applications`, `accessTokens`, `accessTokenIps`, `posTerminals`, `posScreens`, `commissionProfiles`.
- Catalogue and credentials: `credentialSets`, `gatewayVersions`, `gatewayVersionEvidence`, `gatewayEnvironments`, `gatewayAuths`, `gatewaySettings`, `confirmationChannels`, `statementSources`.
- Reference collections loaded from the baseline: `rails`, `railFields`, `railRoutes`, `widgets`, `redirects`, `pollPolicies`.
- Collection flow: `paymentLinks`, `attemptGroups`, `paymentAttempts`, `attemptStepLogs`, `inboundEvents`, `journalEntries`, `journalLines`, `gatewayHealthSamples`.
- Reconciliation: `reconciliationRuns`, `reconciliationItems`, `disputes`, `adjustments`, `cashoutRequests`.
- Risk and governance: `amlScreenings`, `amlScreeningMatches`, `amlCases`, `regulatoryReports`, `operatorCases`, `approvalRequests`, `notifications`, `auditLogs`, `detailChangeLogs`, `velocityRules`, `amlRules`, `reportingRules`, `platformSettings`.

### 3.7 Bulk writer

`core-back/prisma/syntheticSeeder/sync/bulkDataWriter.ts` writes **49 models** in topological FK order:

- merchants before users, because users carry `merchant_id`;
- GL accounts before wallets;
- journal entries before attempts, because attempts carry `ledger_entry_id`;
- journal lines after attempts and inbound events;
- disputes and adjustments initially strip their circular references, then link them in a second pass;
- monthly GL checkpoints are applied last with per-account `update` calls.

Each model is written in 2,500-row `createMany` chunks with `skipDuplicates: true`. The writer skips any empty collection. The six in-memory collections not written are `rails`, `railFields`, `railRoutes`, `widgets`, `redirects` and `pollPolicies`; these are expected to exist from the baseline blueprint seed and are only used as read-only references.

The writer is not a transaction. A failure partway through leaves the previous chunks committed; re-running with the same seed key is not automatic because the completed-run marker is written only at the end. A failed run can be retried, but duplicate ids are skipped and a partial dataset may remain.

### 3.8 Fake Rails synchronization

`core-back/prisma/syntheticSeeder/sync/fakeRailsBulkSyncClient.ts` maps attempts and step logs to the Fake Rails SQLite schema and posts them in batches of 5,000:

- `POST /portal-api/internal/bulk-seed` with `x-fake-rails-seeder-token`;
- transactions first, then events;
- status mapping from core statuses to Fake Rails statuses (`SUCCEEDED` → `PAID`, in-flight → `INITIATED`/`AWAITING_ACTION`, `UNKNOWN` → `UNKNOWN_SIMULATED`);
- provider references, OTP code selection, amounts, timestamps and gateway/rail codes.

Fake Rails stores the history so "Inquire now" on a seeded UNKNOWN attempt, refunds on seeded successes and statement reconciliation return coherent answers. The sync does not create refunds, disputes or cash-out records in Fake Rails; those remain core-side histories.

### 3.9 KYB enrichment

`core-back/prisma/syntheticSeeder/sync/enrichKybDocuments.ts` runs after the bulk write and adds data that the synchronous generators cannot produce:

- generates a tiny valid PDF preview per KYB document;
- encrypts it with `Vault.encryptSecret(..., "kyb-document")`;
- sets `originalFileName` and `uploadedById` where missing;
- creates missing required documents for ACTIVE merchants according to `readRequiredDocuments`;
- creates owner `OWNER_ID` documents for up to 24 active beneficial owners;
- sets `nextKybReviewAt` for ACTIVE merchants that lack one;
- creates up to 12 periodic revalidation requests and sets those merchants to `KYB PENDING`.

Unlike the base generators, this enrichment uses the real Vault.

### 3.10 Completed-run registry

`core-back/prisma/syntheticSeeder/seedRunRegistry.ts` stores a `PlatformSetting`:

- scope `SYNTHETIC_SEED`;
- key `synthetic.seed.completed:<seedKey>`;
- value includes seed key, namespace, profile, years span, completion time and optional attempt/journal/drift counts.

`runSyntheticSeeder` checks `findCompletedSeedRun` before the safety gate. A completed key is skipped with a message. A failed or interrupted run never writes the marker. `recordCompletedSeedRun` upserts version 1.

### 3.11 Post-seed audit

`verify/postSeedAudit.ts` runs an in-memory audit before writing and again after:

- computes debit and credit totals and per-entry balance;
- counts succeeded attempts without a ledger entry;
- verifies `active_locked_count` matches in-flight attempts per link;
- audits operator cases for missing/wrong evidence, maker-checker violations, invalid resolution actions, duplicate open cases, timestamp violations, item backlinks, missing cases for non-MATCHED items and inbound-event integrity;
- returns `ok`, drift, unbalanced entries, counts by collection and an operator-case summary.

The post-seed version adds database counts for attempts, journal entries and links. It does not assert that the database counts equal the in-memory dataset counts; it only reports both.

### 3.12 Execution flow

`core-back/prisma/syntheticSeeder/index.ts`:

1. load config;
2. `ensureSchemaVersion()`;
3. skip when the seed key is already complete;
4. run the safety gate and print Fake Rails health;
5. load references and reject empty gateways/rails;
6. run the nine generators in order;
7. run the in-memory audit and fail on any violation;
8. bulk-write 49 models;
9. enrich KYB documents;
10. sync transactions/events to Fake Rails;
11. run the post-seed audit and fail on any violation;
12. record the completed run.

The console summary reports profile, span, phase timings, rows written, KYB enrichment counts, Fake Rails sync counts and final attempts/journal lines/drift.

## 4. Contracts and invariants

- The seeder must never run unless `IS_TEST_SERVER=true`, Fake Rails is enabled with a public URL, the production guard is satisfied when applicable, every gateway host is allowed and the live handshake succeeds.
- The seeder requires the baseline seed (gateways, rails, routes, credential sets, GL accounts, statement sources) and Fake Rails blueprints. Empty gateways or rails abort.
- The dataset must be deterministic for a given `seedKey`, profile and current time. The PRNG and the chronological clock are seeded from the key.
- The generated ledger must satisfy `SUM(DEBIT) = SUM(CREDIT)` per entry and system-wide within 0.00005 LYD.
- Every SUCCEEDED attempt must have a journal entry; attempts in flight must match each link's `active_locked_count`.
- Every non-MATCHED reconciliation item must have a candidate operator case; the operator-case generator uses the same exception budget.
- Maker-checker seeded approvals must have `makerUserId <> checkerUserId`; resolved cases must have notes and an executed approval.
- All linked evidence (attempt, reconciliation item, confirmation channel, inbound event) must exist and be consistent.
- The completed-run marker is written only after the post-seed audit passes.
- Re-running the same seed key is a no-op. A new seed key must not assume a clean database; `skipDuplicates` can mask id collisions.

## 5. Data / API / config / deployment surface

### Collections and models

The seeder writes 49 Prisma models through `createMany`, including merchant/user/KYB/owner, wallet/application/token, gateway/version/environment/auth/setting/channel/evidence/health, statement source, link/attempt/step/inbound, journal/line, reconciliation, dispute/adjustment/cashout, AML screening/match/case/report, approval, operator case, notification/template/audit/change-log, velocity/AML/reporting rule and platform setting.

### Environment

| Key | Purpose |
| :--- | :--- |
| `IS_TEST_SERVER` | Must be `true` |
| `FAKE_RAILS_ENABLED` | Must be `true` |
| `FAKE_RAILS_PUBLIC_BASE_URL` | Public emulator base URL |
| `FAKE_RAILS_ALLOW_IN_PRODUCTION` | Required when `NODE_ENV=production` |
| `FAKE_RAILS_ALLOWED_HOSTS` | Comma-separated allowed emulator hosts |
| `FAKE_RAILS_SEEDER_TOKEN` | Shared handshake/bulk-seed token |
| `SYNTHETIC_SEED_PROFILE` | `COMPACT`, `STANDARD`, `STRESS` (default `STANDARD` in the seeder; deploy default `COMPACT`) |
| `SYNTHETIC_SEED_KEY` | Completed-run key and PRNG seed |
| `SYNTHETIC_DATA_NAMESPACE` | Namespace used in emails/references (default `synthv1`) |
| `SYNTHETIC_YEARS_SPAN` | Timeline span in years |
| `SYNTHETIC_SEED_VERBOSE` | Prints per-model written counts |

### Deploy surface

`deploy/lib/configSchema.ts` defines `RUN_SYNTHETIC_HISTORY_SEED`, `SYNTHETIC_SEED_PROFILE`, `SYNTHETIC_SEED_KEY` and `SYNTHETIC_YEARS_SPAN`, with validation that the run requires `IS_TEST_SERVER=true`, Fake Rails enabled and (in production) the production override.

`deploy/lib/hostPlanner.ts:309-313` injects the synthetic environment into the core host. It writes **`SYNTHETIC_SEED_YEARS_SPAN`**, while `core-back/prisma/syntheticSeeder/config.ts` reads **`SYNTHETIC_YEARS_SPAN`**. The configured years span is therefore ignored by the seeder, which falls back to the profile's `yearsSpan`.

`deploy/deploy.ts:797-807` runs `bun run seed-synthetic-history` on the core host when `RUN_SYNTHETIC_HISTORY_SEED` is true, with a one-hour timeout, and logs the last lines. `deploy/deploy.env` enables the seed with the STANDARD profile and seed key `libya-pg-2023-2026_2`.

### Fake Rails endpoints

- `POST /portal-api/internal/seeder-handshake`
- `POST /portal-api/internal/bulk-seed`

Both require the seeder token and are implemented in `fake-rails-back/api/portal/seederSync.ts`.

## 6. Operational usage

- Provision a test server, install Fake Rails, run `bun run db-seed` and `bun run seed-fake-rails` first.
- Set `IS_TEST_SERVER=true`, `FAKE_RAILS_ENABLED=true`, `FAKE_RAILS_PUBLIC_BASE_URL`, `FAKE_RAILS_ALLOWED_HOSTS`, a strong `FAKE_RAILS_SEEDER_TOKEN` and the `SYNTHETIC_*` controls.
- Choose `COMPACT` for a laptop, `STANDARD` for a shared test host and `STRESS` only with enough disk, memory and time. The STANDARD profile writes roughly 280k rows and syncs 120k attempts; the deploy step allows up to one hour.
- Use a new `SYNTHETIC_SEED_KEY` for every intentionally distinct history. Reusing a key is a no-op; changing the key does not clean the previous synthetic rows.
- Run `cd core-back && bun run seed-synthetic-history`.
- Watch the phase timings and the final audit line. A nonzero drift, unbalanced entries, succeeded-without-ledger count or slot violation aborts before the completion marker.
- If Fake Rails sync fails after the database write, fix the emulator and rerun with the same key. The run marker is absent, so the seeder retries; existing ids are skipped.
- To rebuild cleanly, recreate the database and rerun the baseline seed, Fake Rails bridge and synthetic seeder. Deleting only the marker is not a clean rebuild because the old synthetic rows remain.
- Do not run the seeder against a production database or a non-Fake-Rails gateway set.

## 7. Status and deviations

### Implemented

- Five-layer safety gate with live Fake Rails handshake.
- Three profiles, a deterministic PRNG and a multi-year timeline.
- Nine generators covering merchant/onboarding, gateway lifecycle, links/attempts, ledger/checkpoints, reconciliation, disputes/cash-outs/adjustments, AML/governance, operator cases and admin/staff.
- 55 in-memory collections and a 49-model topological bulk writer with 2,500-row chunks.
- Fake Rails transaction/event synchronization in 5,000-row batches.
- Vault-backed KYB document enrichment.
- Completed-run registry in `platform_settings`.
- In-memory and post-seed invariant audits.
- Deploy integration and safety validation.

### Partial

- Volume control: seven `ProfileVolumes` fields are unused; the counts of join requests, KYB documents, owners, users, wallets, applications and AML cases are derived from merchant volume and randomness.
- Collection coverage: 49 of 55 collections are written; the six reference collections are assumed to come from the baseline.
- Template coverage: 10 notification templates are seeded, and generated notifications use only `PAYMENT_SUCCEEDED`, `PAYMENT_FAILED`, `KYB_DOC_EXPIRING` and `CASHOUT_COMPLETE`. There is no complete bilingual catalogue for every event.
- Ciphertext realism: KYB content uses the Vault; merchant national ids, attempt context, AML report payloads and notification addresses use plain base64.
- Authority realism: seeded staff have a nested authority map that the auth parser does not understand.
- Temporal realism: the Tripoli hour distribution is written as UTC without an offset.
- Safety: the gate checks the declared test flag and gateway hosts, not the database host or existing data.

### Missing / deferred

- A generator that uses `joinRequests`, `kybDocuments`, `beneficialOwners`, `users`, `wallets`, `applications` and `amlCases` volumes directly.
- Writing for the six reference collections.
- A full notification template catalogue with both languages for every code.
- Vault encryption for the remaining synthetic ciphertext fields.
- A flat or boolean authority map compatible with `parseAuthorities`.
- Correct deploy propagation of the years-span key.
- Database-host and data-presence checks in the safety gate.
- Namespace-aware id generation.
- An exact database-versus-dataset count assertion in the post-seed audit.
- A transactional or resumable bulk writer.

### Known bugs / risks

- `nextId` ignores its entity argument and namespace. Two seed keys produce the same ids; `skipDuplicates` silently keeps the first history and drops the second. Code gap.
- `hostPlanner` writes `SYNTHETIC_SEED_YEARS_SPAN` while the seeder reads `SYNTHETIC_YEARS_SPAN`, so deployed years span is ignored. Code gap.
- The seeded `authoritiesMap` is `{ gateway: ["read", ...] }`; `parseAuthorities` accepts arrays or flat boolean maps, so seeded platform users resolve to no authorities. They can authenticate but fail authority checks. Code gap.
- `nationalIdCiphertext`, `contextCiphertext`, `payloadCiphertext`, `addressCiphertext` and similar fields are base64, not encrypted. Any code that tries to decrypt them with the Vault will fail or produce garbage. Code gap.
- The bulk writer is not transactional. An interrupted run leaves partial rows and the next retry skips duplicates rather than repairing missing links. Operational risk.
- The completion marker is per key only. A new key over a dirty database can duplicate semantic histories while id collisions drop rows. Operational risk.
- The seeder does not clear previously seeded rows. A rebuild requires a database reset.
- The safety gate assumes all gateway environments point at Fake Rails. A stray live gateway host blocks the seed, which is safe but can be confusing after a partial blueprint seed. Operational risk.
- `FAKE_RAILS_SEEDER_TOKEN` may be empty in the handshake if the environment is misconfigured; the Fake Rails side decides whether to reject. Code/configuration risk.
- The timeline's adoption/seasonality is applied to link/attempt generation but not to every collection, so some histories are not volume-curved. Modeling limitation.
- The post-seed audit reports database counts but does not fail on a dataset/database mismatch, so a partially skipped bulk write can pass the audit. Code gap.

## 8. Verification and tests

Relevant test files:

- `core-back/test/synthetic-seeder.test.ts` — safety gate, config, generators and audit behavior.
- `core-back/test/exhaustive/10-seeder-and-deploy/synthetic-seeder-safety-and-audit.test.ts` — exhaustive safety/audit suite.
- `fake-rails-back/test/api.test.ts` — seeder handshake and bulk-seed endpoints.
- `fake-rails-back/test/exhaustive/05-api-matrix/fake-rails-portal-and-chaos-api.test.ts` — broader Fake Rails API matrix.

Commands:

```bash
cd core-back && bun test test/synthetic-seeder.test.ts
cd core-back && bun test test/exhaustive/10-seeder-and-deploy
cd fake-rails-back && bun test
cd core-back && bun run seed-synthetic-history
```

The unit tests do not require a live database or Fake Rails; they use fakes for most behavior. The actual `seed-synthetic-history` command requires PostgreSQL 18, the baseline seed, Fake Rails and all safety variables. The deploy-time run is not part of the default test gate. No seeder run was performed for this documentation change.

## 9. Source references

### Old design sections

- `design/synthetic_operational_data_seeder_architecture.md#executive-summary--architectural-vision`
- `design/synthetic_operational_data_seeder_architecture.md#1-pre-flight-safety-gate--fake-rails-dependency-verification`
- `design/synthetic_operational_data_seeder_architecture.md#2-chronological-simulation-engine--volume-scaling-profiles`
- `design/synthetic_operational_data_seeder_architecture.md#3-comprehensive-multi-state-distribution-across-all-66-database-models`
- `design/synthetic_operational_data_seeder_architecture.md#4-two-phase-seeder-execution--fake-rails-bulk-synchronization-pipeline`
- `design/synthetic_operational_data_seeder_architecture.md#5-directory-structure-of-the-synthetic-seeder-module`
- `design/blueprint-management.md#5-documentation-corrections-backlog`

### Code paths

- `core-back/prisma/syntheticSeeder/index.ts`
- `core-back/prisma/syntheticSeeder/config.ts`
- `core-back/prisma/syntheticSeeder/SeederSafetyGate.ts`
- `core-back/prisma/syntheticSeeder/context.ts`
- `core-back/prisma/syntheticSeeder/dataset.ts`
- `core-back/prisma/syntheticSeeder/timelineClock.ts`
- `core-back/prisma/syntheticSeeder/prng.ts`
- `core-back/prisma/syntheticSeeder/builders.ts`
- `core-back/prisma/syntheticSeeder/libyanDataCatalog.ts`
- `core-back/prisma/syntheticSeeder/generators/01_adminAndStaffGenerator.ts`
- `core-back/prisma/syntheticSeeder/generators/02_merchantCohortGenerator.ts`
- `core-back/prisma/syntheticSeeder/generators/03_gatewayLifecycleGenerator.ts`
- `core-back/prisma/syntheticSeeder/generators/04_linksAndAttemptsGenerator.ts`
- `core-back/prisma/syntheticSeeder/generators/05_ledgerAndCheckpoints.ts`
- `core-back/prisma/syntheticSeeder/generators/06_reconAndStatements.ts`
- `core-back/prisma/syntheticSeeder/generators/07_disputesCashoutsAdjustments.ts`
- `core-back/prisma/syntheticSeeder/generators/08_amlAndGovernanceQueues.ts`
- `core-back/prisma/syntheticSeeder/generators/09_operatorCasesGenerator.ts`
- `core-back/prisma/syntheticSeeder/sync/bulkDataWriter.ts`
- `core-back/prisma/syntheticSeeder/sync/fakeRailsBulkSyncClient.ts`
- `core-back/prisma/syntheticSeeder/sync/enrichKybDocuments.ts`
- `core-back/prisma/syntheticSeeder/seedRunRegistry.ts`
- `core-back/prisma/syntheticSeeder/verify/postSeedAudit.ts`
- `core-back/prisma/seedFakeRails.ts`
- `fake-rails-back/api/portal/seederSync.ts`
- `deploy/deploy.ts`
- `deploy/lib/hostPlanner.ts`
- `deploy/lib/configSchema.ts`

### Generated appendices

- `project-design/appendices/schema-catalog.md` — models targeted by the seeder
- `project-design/appendices/env-and-config-matrix.md` — synthetic seeder and Fake Rails keys
- `project-design/appendices/test-inventory.md` — seeder test files and skip conditions

## 10. Change history

- 2026-11-03 — Initial canonical extraction. Records the safety gate, profiles, 9 generators, 55 collections, 49-model bulk writer, timeline, Fake Rails sync, KYB enrichment, run registry, post-seed audit, and the unused volumes, template coverage, base64 ciphertexts, authority shape and deploy env mismatch. See `project-design/TRACKER.md`.

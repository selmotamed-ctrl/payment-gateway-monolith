---
id: core.seeder
title: Synthetic Seeder
status: partial
confidence: high
last_verified: 2026-11-07
verified_against: 55a2892+working-tree
code:
  - core-back/prisma/syntheticSeeder/**
  - core-back/prisma/seedFakeRails.ts
  - fake-rails-back/api/portal/seederSync.ts
  - deploy/deploy.ts
  - deploy/lib/hostPlanner.ts
  - deploy/lib/configSchema.ts
tests:
  - core-back/test/synthetic-seeder.test.ts
  - core-back/test/synthetic-seeder-realism.test.ts
  - core-back/test/helpers/seederFixture.ts
  - core-back/test/exhaustive/10-seeder-and-deploy/synthetic-seeder-safety-and-audit.test.ts
  - fake-rails-back/test/api.test.ts
gaps:
  - 2026-11-04 (live run): the STANDARD profile was run end to end against a clean PostgreSQL 18 database and a scratch Fake Rails (1,397,209 rows in 46 tables, 119,108 attempts, 535,368 journal lines, drift 0.0000, 113,188 transactions synced to Fake Rails, 239 s). It found and fixed two bugs the DB-free suite could not (see section 7). Earlier note (superseded): the DB-backed run was not executed in the rework; FK order, check constraints and the partitioned journal are proven only by the DB-free invariant suite and the `WRITE_ORDER` test.
  - Baseline gateway versions are created at deploy time, so attempts pinned to them predate the version row (`created_at`); the baseline rows are not backdated.
  - Reference collections (`rails`, `railFields`, `railRoutes`, `widgets`, `redirects`, `pollPolicies`) are read, never written (expected from the baseline seed).
  - Not generated: `gateway_inquiry_schedules`, `background_jobs`, `kyb_revalidation_requests` (only the DB-side enrichment adds 12), `outbox_events`/`audit_outbox` (would double-project the read models), WITHDRAWN disputes, EXECUTING adjustments, the SUBTRACTED cash-out state, negative-balance showcase wallets.
  - Disputes are only generated for platform-cleared (PLATFORM_CLEARING) payments.
  - `amlCases` is a floor: rule-driven holds (payments >= 20,000 LYD) can exceed the profile volume; `reconciliationItems` is an upper bound capped by the settled attempts the history can feed.
  - The safety gate still does not verify the database host and the bulk writer is still not transactional/resumable.
  - Engine observations (not fixed here, see section 7): INTERNAL rails with a payer surcharge cannot balance; AML release books no gateway fee accrual; the ledger resolver credits the merchant's first wallet; `SYSTEM_AUTOMATION` is not a UUID; refund commission splits can exceed 4 decimals.
---

# Synthetic Seeder

## 1. Purpose and scope

The synthetic seeder builds a deterministic, multi-year operational history for a designated test/sandbox deployment that is wired to the Fake Payment Rails emulator. It exists so the portals, lists, filters, reconciliation, AML, operator cases, ledger checkpoints and dashboard-style views have realistic data without copying production records.

It owns:

- the five-layer safety gate;
- the scale profiles and environment parsing;
- the chronological simulation clock and Libyan market seasonality;
- the nine domain generators plus route health and checkpoints;
- the in-memory 56-collection dataset;
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

The implementation keeps the two-phase design, the safety gate and the audit. The 2026-11-04 rework (section 3.13) made the data faithful to real operation; what still differs from the specification:

- it writes 50 model collections out of 56 in-memory collections (the six baseline reference collections are read-only);
- the safety gate checks the declared test flag and Fake Rails hosts but not the database host;
- the bulk writer is not transactional;
- the generated volumes of AML cases and reconciliation items are derived bounds, not exact counts (section 3.2).

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

Since 2026-11-04 every volume drives generation. `joinRequests`, `wallets`, `applications`, `beneficialOwners` and `users` are allocated across merchants with `allocateVolume` (per-merchant bounds 1-3, 1-3, 1-5, 1-6 and 1-8; `users` counts staff plus merchant users), `kybDocuments` is allocated above the per-category required-document count, `paymentLinks`/`paymentAttempts` are exact up to the attempts a link window can host, `reconciliationRuns` is split across statement sources, and `disputes`, `adjustments`, `cashouts`, `amlScreenings`, `operatorCases` and `approvalRequests` act as targets. When a volume is outside the feasible per-merchant bounds the nearest feasible count is generated and the invariant `volume.mismatch` is only enforced for feasible volumes. `amlCases` is a floor (rule-driven holds can add more) and `reconciliationItems` is an upper bound.

`yearsSpan` is used by the timeline. `SYNTHETIC_SEED_YEARS_SPAN` (written by the deploy planner), `SYNTHETIC_YEARS_SPAN` and `SYNTHETIC_DATA_YEARS` are accepted in that order; the value must be a number in (0, 10].

### 3.3 Context and ID factory

`createContext` loads existing references (`gateways`, versions, rails, routes, credentials, GL accounts, admin users, statement sources), builds a seeded PRNG from `seedKey`, builds the timeline, creates an empty dataset, and creates `nextId`.

`nextId` returns `<8 hex>-<4 hex>-7<3 hex>-8<3 hex>-<12 hex counter>` where the first 64 bits come from `sha256(namespace, seedKey)`. Two different seed keys or namespaces therefore never collide (the old factory ignored both and `skipDuplicates` silently dropped the second history), while a run stays deterministic. Rows keep unique keys that matter for re-runs (`seed_key` of GL accounts and commission profiles, e-mails, references) namespaced by seed key as well.

### 3.4 Timeline

`core-back/prisma/syntheticSeeder/timelineClock.ts`:

- `buildTimeline(now, yearsSpan)` sets `start = now - round(yearsSpan * 12) months` at 08:00 UTC and `end = now`;
- `adoptionMultiplier` grows from 1.0 to 8.0 over the span;
- `dayVolumeMultiplier` applies Friday 0.72, Saturday 1.05, salary window 1.35, Ramadan 1.8 and Eid 1.5;
- `businessHour` returns a Tripoli-style hour distribution;
- `dateAt` writes the chosen hour with `setUTCHours`.

Local hours are `Africa/Tripoli` wall-clock hours (UTC+2, no DST) and are stored as `hour - 2` UTC (`tripoliDateTime`, `tripoliHour`, `tripoliDay`); the start of the timeline is 08:00 Tripoli. `dayVolumeMultiplier` additionally models the Eid holiday trough (0.55), Ramadan (1.8), the ten days before Eid al-Adha (1.5), Friday 0.72, Saturday 1.05 and the salary window 1.35 on the Tripoli calendar day, with Ramadan/Eid tables for 2021-2028. `businessHour` takes the day: Ramadan traffic moves to the hours after iftar and Friday skips the 11:30-14:30 prayer window.

### 3.5 The nine generators

| Generator | Main outputs |
| :--- | :--- |
| `01_adminAndStaffGenerator` | 13 platform staff seats and the disabled system drafter; flat authority lists and maker/checker flags from `scripts/createAdminPlan.ts`; velocity rules with operational thresholds; AML rules whose `params` keys are the ones `AmlRuleEngine` reads. Notification templates, CBL reporting rules and the environment setting belong to the baseline seed and are no longer duplicated. |
| `02_merchantCohortGenerator` | Merchants with a consistent lifecycle (request -> submission -> review -> proposal -> decision -> activation -> suspension/closure), category-driven profiles, unique phones, IBAN-shaped payout accounts; earlier REJECTED/EXPIRED/WITHDRAWN join requests linked by `resubmission_of_id`; KYB document chains (superseded copies, expiry, 30-day notice, duplicate-hash showcase); beneficial owners summing to 100 %; wallets + GL accounts; applications; users and identities; tokens; POS terminals only for counter categories; merchant-owned credentials; negotiated commission profiles (fractional rates) and the historical platform default. National ids are queued for Vault encryption. |
| `03_gatewayLifecycleGenerator` | Later versions next to the baseline LIVE version (ROLLED_BACK -> baseline, SANDBOX_VERIFIED/DRAFT, PENDING_APPROVAL for two gateways) with environments, auth, settings and evidence; webhook channels only for baseline versions without one; statement sources; route health DERIVED from the generated attempts (last 30 days). |
| `04_linksAndAttemptsGenerator` | Heavy-tailed merchant volumes, category ticket bands, rail popularity, per-rail decline/abandon pressure; links with fee bearer, reuse and expiry; attempts built from engine-valid status paths with monotonic timestamps; pricing mirrored from the checkout (`money.ts`); step logs, inbound webhooks, attempt groups; live tail of in-flight/UNKNOWN/held attempts near `T_NOW`; late successes and SUSPENSE settlements. |
| `05_ledgerAndCheckpoints` | Confirmation, AML hold/release/void and SUSPENSE postings through the engine templates; AML hold cases; then (`generateCheckpoints`, last, after every posting) the per-shard sequencing: every line is routed with the engine's `routeLine` at its account's `shardCount` (system accounts 16, wallets 1), sequenced gaplessly per (account, shard) in posting order (`created_at`, ties by generation order), shard balances/`line_seq`, and one checkpoint per shard at the end of the last complete UTC month. |
| `06_reconAndStatements` | Per-source windows fed by the settled attempts (each once); MATCHED lines carry the settled amount and fee; exceptions (mismatch, missing at gateway, missing locally, duplicate) within the operator-case budget; `SETTLEMENT_SWEEP` for platform-cleared matched lines. |
| `07_disputesCashoutsAdjustments` | Executed REFUND adjustments with `FULL_REFUND`/`INTERNAL_REFUND` journals and the REFUNDED/PARTIALLY_REFUNDED step; disputes with the reserve journal, drafted CHARGEBACK adjustments and WON/LOST outcomes; cash-outs and manual debits sized so wallets never go negative; manual credits and corrections; open refund requests. |
| `08_amlAndGovernanceQueues` | Onboarding/owner/periodic screenings with matches, screening AML cases, STR reports, approvals bound to real subjects (join requests, adjustments, AML cases, gateway versions, merchants, commission profiles) with maker != checker and role flags, notifications from the baseline catalogue, audit rows derived from real events, detail change logs. |
| `09_operatorCasesGenerator` | Operator cases from reconciliation exceptions, UNKNOWN/CONFLICT attempts, held/escalated payments, late successes and SUSPENSE settlements; only an UNKNOWN attempt can carry a proposed MARK_* action (following the emulator truth); maker-checker resolutions. |

### 3.6 The 56 in-memory collections

`core-back/prisma/syntheticSeeder/dataset.ts` defines 56 arrays (the 2026-11-02 list below plus `glAccountShards` and `notificationTemplates`):

- Identity and onboarding: `users`, `userIdentities`, `merchants`, `joinRequests`, `kybDocuments`, `beneficialOwners`, `wallets`, `glAccounts`, `applications`, `accessTokens`, `accessTokenIps`, `posTerminals`, `posScreens`, `commissionProfiles`.
- Catalogue and credentials: `credentialSets`, `gatewayVersions`, `gatewayVersionEvidence`, `gatewayEnvironments`, `gatewayAuths`, `gatewaySettings`, `confirmationChannels`, `statementSources`.
- Reference collections loaded from the baseline: `rails`, `railFields`, `railRoutes`, `widgets`, `redirects`, `pollPolicies`.
- Collection flow: `paymentLinks`, `attemptGroups`, `paymentAttempts`, `attemptStepLogs`, `inboundEvents`, `journalEntries`, `journalLines`, `gatewayHealthSamples`.
- Reconciliation: `reconciliationRuns`, `reconciliationItems`, `disputes`, `adjustments`, `cashoutRequests`.
- Risk and governance: `amlScreenings`, `amlScreeningMatches`, `amlCases`, `regulatoryReports`, `operatorCases`, `approvalRequests`, `notifications`, `auditLogs`, `detailChangeLogs`, `velocityRules`, `amlRules`, `reportingRules`, `platformSettings`.

### 3.7 Bulk writer

`core-back/prisma/syntheticSeeder/sync/bulkDataWriter.ts` writes **50 models** in topological FK order (`encryptPendingSecrets` runs first and fills every Vault-encrypted column; `writeReadModels` projects `rm_*` afterwards):

- merchants before users, because users carry `merchant_id`;
- GL accounts before wallets;
- journal entries before attempts, because attempts carry `ledger_entry_id`;
- journal lines after attempts and inbound events;
- disputes and adjustments initially strip their circular references, then link them in a second pass;
- shard rows and per-shard checkpoints: the DB trigger `gl_accounts_create_shards` already creates shard rows `0..shard_count-1` for every inserted account, so shard rows (`current_balance`, `line_seq`) and `gl_shard_checkpoints` are written last with chunked `INSERT ... ON CONFLICT DO UPDATE` over `unnest` arrays (never a plain insert, never one query per row); journal lines carry `shard_id`/`shard_seq` (>= 1; the `shard_seq > 0` check applies to new rows).

Each model is written in 2,500-row `createMany` chunks with `skipDuplicates: true`. The writer skips any empty collection. The six in-memory collections not written are `rails`, `railFields`, `railRoutes`, `widgets`, `redirects` and `pollPolicies`; these are expected to exist from the baseline blueprint seed and are only used as read-only references.

The `WRITE_ORDER` is exported and tested (parents before children; approvals right after users; disputes before adjustments; items before cases; no strip-and-relink). The writer is not a transaction. A failure partway through leaves the previous chunks committed; re-running with the same seed key is not automatic because the completed-run marker is written only at the end. A failed run can be retried, but duplicate ids are skipped and a partial dataset may remain.

### 3.8 Fake Rails synchronization

`core-back/prisma/syntheticSeeder/sync/fakeRailsBulkSyncClient.ts` maps attempts and step logs to the Fake Rails SQLite schema and posts them in batches of 5,000:

- `POST /portal-api/internal/bulk-seed` with `x-fake-rails-seeder-token`;
- transactions first, then events;
- status mapping from core statuses to Fake Rails statuses (`SUCCEEDED`/`PARTIALLY_REFUNDED`/`DISPUTED` -> `PAID`, `REFUNDED` -> `REFUNDED`, in-flight and `UNKNOWN` -> `INITIATED`/`AWAITING_ACTION`); BLOCKED and never-dispatched attempts are not synced; an `UNKNOWN` attempt gets `inquiry_override_status` = the recorded gateway truth (`PAID` or `FAILED`), so "Inquire now" resolves it;
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

`runSyntheticSeeder` checks `findCompletedSeedRun` before the safety gate. A completed key is skipped with a message. `findOtherCompletedSeedRun` (2026-11-04) also skips, with an explanatory message, when a completed run exists under a *different* key in the same namespace: generated rows carry key-independent unique values (emails), so a second history cannot be layered (`skipDuplicates` drops the colliding parents and children then fail their FKs, e.g. `user_identities_user_id_fkey`). Keep the existing key or reset the database to reseed. A failed or interrupted run never writes the marker. `recordCompletedSeedRun` upserts version 1.

### 3.11 Post-seed audit

`verify/invariants.ts#checkInvariants` runs on the in-memory graph before the write (a violation aborts) and `postSeedAudit` repeats it, then compares the database with the dataset. Exact money (BigInt scaled by 10^4) is used throughout. It asserts, per rule name:

- **relations**: every foreign key (`FK_EDGES`, 78 edges incl. baseline references) points at an existing row; wallet GL account is the merchant's `MERCHANT_WALLET`; link wallet/application/merchant coherence; unique ids, e-mails, references, idempotency keys, journal `(ref_type, ref_id)`, dispute `(gateway, ref)`;
- **ledger**: every entry balanced, every line > 0 and a 4-decimal string, system drift exactly 0, lines dated like their entry, nothing in the future; per shard (`shard.seq-gapless`) the sequence `1..line_seq` is present exactly once and `line_seq` = the line count, (`shard.sum`) the shard balance = the signed sum of ALL its lines, (`shard.checkpoint-live`) shard balance = `checkpoint_balance` + the lines after `checkpoint_seq` (and `checkpoint_balance` = the lines up to it, the checkpointed lines being exactly those at or before the cut, a prefix of the sequence, the cut not in the future);
- **settlement math**: wallet credit = `net_merchant_amount`, income credit = commission, fee accrual = gateway fee (accrual routes), MERCHANT_DIRECT never credits a wallet, the credited wallet is the link's wallet;
- **lifecycle**: each attempt's path is made of engine transitions (`lifecycle.ts`, compared with `ALLOWED_TRANSITIONS` by a test), starts at CREATED/BLOCKED, ends at its status, timestamps monotonic and <= `T_NOW`, `terminal_at` iff terminal, in-flight attempts still inside their TTL, amounts consistent with the fee-bearer breakdown, settled amount only on settled statuses, ledger entry only on settled attempts and unique;
- **links**: `confirmed_count`/`active_locked_count` equal the attempts, no slot overflow, COMPLETED exactly when full, no stale PENDING, attempt-group success counts;
- **governance**: maker != checker, maker `is_maker`, checker `is_checker`, decided approvals have a checker, pending ones none; adjustments executed iff journaled, refunds <= charge, REFUNDED iff refunds sum to the charge, dispute <-> adjustment bidirectional and consistent with the status, cash-outs linked, wallets never below `-negative_balance_ceiling` at any instant, reconciliation stats and windows;
- **time**: no `created_at` after `T_NOW`, `updated_at >= created_at` everywhere;
- **volumes**: merchants, join requests, wallets, applications, owners, users equal the profile when feasible; business-hour share, negative wallets and volume ratios are reported as metrics;
- **operator cases**: the pre-existing case audit (evidence, backlinks, maker-checker, SLA timestamps, duplicates).

After the write, `postSeedAudit` asserts that the database row counts of attempts, journal entries, journal lines, links, merchants, adjustments and disputes equal the dataset (a skipped duplicate is now a failure) and that the SQL ledger drift and unbalanced-entry count are zero.

### 3.12 Execution flow

`core-back/prisma/syntheticSeeder/index.ts`:

1. load config;
2. `ensureSchemaVersion()`;
3. skip when the seed key is already complete;
4. run the safety gate and print Fake Rails health;
5. load references and reject empty gateways/rails;
6. run the generators in order (route health, then ledger, reconciliation, refunds/disputes/cash-outs, governance, operator cases, and the checkpoints last);
7. run the in-memory audit (ledger + the full invariant suite) and fail on any violation;
8. encrypt every pending sensitive column with the Vault, then bulk-write 50 models;
9. project the `rm_*` read models and enrich KYB documents;
10. sync transactions/events to Fake Rails;
11. run the post-seed audit (invariants + database/dataset equality + SQL drift) and fail on any violation;
12. record the completed run.

The console summary reports profile, span, phase timings, rows written, KYB enrichment counts, Fake Rails sync counts and final attempts/journal lines/drift.

### 3.13 2026-11-04 realism rework

The data was re-derived from the real engine rules instead of random rows. Defects fixed:

| Area | Defect | Fix |
| :--- | :--- | :--- |
| Ledger | Hand-written account choice, float sums, per-gateway/env clearing accounts the baseline never creates; settlement-sweep and refund legs invented | `postTemplate` posts the engine's `buildPaymentConfirmationTemplate`/`buildLedgerTemplate` output, validated by `LedgerPoster.validateTemplate`, with accounts resolved like `LedgerPoster.resolveAccountId` (platform fallback); decimal.js/BigInt only |
| Checkpoints | Taken before refunds/cash-outs were posted, so lines dated before the checkpoint were missed | `generateCheckpoints` runs last; one cut instant for all shards (the 2026-11-07 sequenced model: per-shard `checkpoint_seq`/`checkpoint_balance`) |
| Fees | Random 0.2-0.9 % gateway fee and 0.5-2.5 % commission; surcharge ignored | Commission profile hierarchy, fee-bearer breakdown, route cost model and wire rounding mirrored from the checkout (`money.ts`) |
| Lifecycle | Terminal times random 1-120 min after creation, in-flight attempts years old, `EXPIRED + LATE_SUCCESS_PENDING` and `VERIFYING + AML_HOLD` statuses the engine never produces, no refund/dispute sequencing | Engine-valid paths with one timestamp per step; late successes end SUCCEEDED (or SUSPENSE); held payments are `CREATED + AML_HOLD` with a hold entry and case; live tail only near `T_NOW`; refunds/disputes append their status step |
| Links | Counters patched after the fact; random link for each attempt | Counters follow the attempts; sequential retries respect the slot rule |
| Relations | Adjustments/disputes/AML cases not tied to approvals, journal entries or holds; approvals pointed at random subjects with invalid state; join-request approval FK order | Every adjustment/AML case/report/version/profile has the approval the real flow would create (maker != checker, role flags); writer order fixed |
| Governance | Staff `authoritiesMap` nested object (zero authorities); `SUPPORT`/`MLRO` flags wrong; maker/checker ignored role flags | Flat authority lists and flags from `createAdminPlan.ts` |
| Merchants | Single join request, uniform random statuses/dates, suspension dates unrelated to activation, owners not summing to 100 %, KYB documents unrelated to required types, duplicate phones, 0.5-3.5 commission rates (50-350 %), base64 "ciphertext" | Lifecycle-ordered timestamps, resubmission chains, required-document chains, 100 % ownership, unique phones, fractional rates, Vault encryption |
| Catalogue | 15 Arabic vs 14 English surnames (misaligned, one `undefined`), uniform categories | Aligned lists; categories with ticket bands, weights and counter flags |
| Time | Tripoli hour written as UTC, Eid treated as a peak, uniform hour for reusable links | UTC+2 conversion, Eid trough, Ramadan evening shift, Friday prayer dip |
| Config | `SYNTHETIC_SEED_YEARS_SPAN` ignored; ids ignored namespace and seed key | Both fixed |
| Volumes | Seven profile fields unused | All drive generation (section 3.2) |
| Verify | Audit checked drift, succeeded-without-ledger, slot counts and operator cases only; DB counts reported not asserted | Section 3.11 |
| Fake Rails | BLOCKED attempts synced; UNKNOWN mapped to `UNKNOWN_SIMULATED` with no truth; OTP selection from the decimal tail of a hex id | Skip never-dispatched attempts, truth in `inquiry_override_status`, hex-aware OTP |
| Read models | `rm_*` empty after a seed | `writeReadModels` projects them like `projectAttemptTransition` |

`fake-rails-back/api/portal/seederSync.ts` and `core-back/prisma/seedFakeRails.ts` were reviewed and needed no change.

## 4. Contracts and invariants

- The seeder must never run unless `IS_TEST_SERVER=true`, Fake Rails is enabled with a public URL, the production guard is satisfied when applicable, every gateway host is allowed and the live handshake succeeds.
- The seeder requires the baseline seed (gateways, rails, routes, credential sets, GL accounts, statement sources) and Fake Rails blueprints. Empty gateways or rails abort.
- The dataset must be deterministic for a given `seedKey`, profile and current time. The PRNG and the chronological clock are seeded from the key.
- The generated ledger must satisfy `SUM(DEBIT) = SUM(CREDIT)` per entry and system-wide, exactly (no tolerance).
- Every SUCCEEDED attempt must have a journal entry; attempts in flight must match each link's `active_locked_count`.
- Every non-MATCHED reconciliation item must have a candidate operator case; the operator-case generator uses the same exception budget.
- Maker-checker seeded approvals must have `makerUserId <> checkerUserId`, an `is_maker` maker and an `is_checker` checker; resolved cases must have notes and an executed approval.
- The full invariant list of section 3.11 holds before any row is written and again after the write.
- All linked evidence (attempt, reconciliation item, confirmation channel, inbound event) must exist and be consistent.
- The completed-run marker is written only after the post-seed audit passes.
- Re-running the same seed key is a no-op. Ids and unique keys are namespaced by seed key, so a different key adds a parallel history (the post-seed audit compares the database with the dataset, so a collision fails loudly).

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
- 56 in-memory collections and a 50-model topological bulk writer with 2,500-row chunks.
- Fake Rails transaction/event synchronization in 5,000-row batches.
- Vault-backed KYB document enrichment.
- Completed-run registry in `platform_settings`.
- In-memory and post-seed invariant audits.
- Deploy integration and safety validation.

### Partial

- Collection coverage: 50 of 56 collections are written; the six reference collections come from the baseline.
- Notifications use the baseline catalogue codes `PAYMENT_SUCCEEDED`, `PAYMENT_FAILED`, `DISPUTE_OPENED`, `CASHOUT_REQUESTED` and `APPROVAL_REQUIRED` only where a template for the channel/language exists; the seeder creates no templates.
- Safety: the gate checks the declared test flag and gateway hosts, not the database host or existing data.
- Baseline versions are not backdated (attempts predate the version row's `created_at`).
- Several model families are not generated (see the `gaps` list).

### Known bugs / risks

- The bulk writer is not transactional. An interrupted run leaves partial rows; the retry skips duplicates and the post-seed audit (database/dataset equality) fails instead of passing silently. Operational risk.
- The seeder does not clear previously seeded rows. A rebuild requires a database reset.
- The DB-backed path (writer, Vault enrichment, SQL audit, read-model SQL) ran once, on 2026-11-04, against a clean database (see the change history). Two bugs surfaced only there: the operator-case audit rejected events that reference baseline webhook channels (the DB-free fixture had no baseline channels), and the generator let a payer succeed twice in one `attempt_groups` row, violating `attempt_groups_single_success (success_count <= 1)`. Both are fixed and covered by regression tests; the fixture now includes baseline channels.
- Seeding is not idempotent across seed keys: ids are namespaced by key but emails, phones and similar unique values derive from the index and `SYNTHETIC_DATA_NAMESPACE`. `createMany(skipDuplicates)` hides the collision, so a second key on a non-empty database (or after an interrupted run) produces `user_identities_user_id_fkey` failures and leaves partial rows. Seed into an empty database, or use a new namespace.
- Prisma's pg adapter prints `Calling client.query() when the client is already executing a query is deprecated` during the large writes (breaks in pg@9); the writer itself is sequential, so the cause is inside the adapter.
- Engine observations found while mirroring its rules (the seeder works around them; not changed because they are outside the seeder): (1) `INTERNAL_CONFIRMATION` books the requested amount only, so an INTERNAL rail with a payer surcharge cannot balance - the seeder keeps INTERNAL/MERCHANT_DIRECT rails on MERCHANT_ABSORBS; (2) `AML_HOLD_AND_RELEASE` (release) books no gateway fee accrual, so a released hold leaves the fee unaccrued; (3) `LedgerPoster` resolves the merchant wallet by `ownerId` only, i.e. the merchant's first wallet, not the link's wallet (the seeder maps the link's wallet explicitly); (4) `SYSTEM_AUTOMATION_USER_ID = "SYSTEM_AUTOMATION"` is not a UUID but is written to `users.id` (a `uuid` column); (5) the refund commission split is not rounded to 4 decimals, so the journal amounts can be re-rounded on write; (6) the guard writes BLOCKED attempts with `MERCHANT_ABSORBS` but the real bearer's amounts; (7) `postSettlementSweeps` dedupes by `batchReference`, so a batch reference shared by many items sweeps only the first.
- `SYNTHETIC_SEED_YEARS_SPAN` is now accepted; the deploy planner needs no change.

## 8. Verification and tests

Relevant test files:

- `core-back/test/synthetic-seeder-realism.test.ts` — DB-free end-to-end proof (35 tests): every generator runs against a baseline lookalike (`test/helpers/seederFixture.ts`) and the full invariant suite must report nothing for several seeds; volumes, determinism, id isolation, Tripoli time/seasonality, engine mirrors (transition table parsed from `DynamicRailEngine.ts`, pricing, ledger math), tamper tests proving the audit catches each defect class, Vault encryption, writer order, Fake Rails sync payload, read models.
- `core-back/test/synthetic-seeder.test.ts` — safety gate, config and audit behavior on sparse rows.
- `core-back/test/exhaustive/10-seeder-and-deploy/synthetic-seeder-safety-and-audit.test.ts` — exhaustive safety/audit suite.
- `fake-rails-back/test/api.test.ts` — seeder handshake and bulk-seed endpoints.
- `fake-rails-back/test/exhaustive/05-api-matrix/fake-rails-portal-and-chaos-api.test.ts` — broader Fake Rails API matrix.

Commands:

```bash
cd core-back && bun test test/synthetic-seeder-realism.test.ts test/synthetic-seeder.test.ts
cd core-back && bun test test/exhaustive/10-seeder-and-deploy
cd fake-rails-back && bun test
cd core-back && bun run seed-synthetic-history
```

The unit tests do not require a live database or Fake Rails. The actual `seed-synthetic-history` command requires PostgreSQL 18, the baseline seed, Fake Rails and all safety variables; the deploy-time run is not part of the default test gate and was NOT executed in the 2026-11-04 rework (no PostgreSQL available): the COMPACT profile was generated in memory in about 1.4 s (14.9k attempts, 8.5k links, ~60k journal lines, zero invariant violations).

## 9. Source references

### Old design sections

- `design/04-fake-rails-and-seeder/synthetic_operational_data_seeder_architecture.md#executive-summary--architectural-vision`
- `design/04-fake-rails-and-seeder/synthetic_operational_data_seeder_architecture.md#1-pre-flight-safety-gate--fake-rails-dependency-verification`
- `design/04-fake-rails-and-seeder/synthetic_operational_data_seeder_architecture.md#2-chronological-simulation-engine--volume-scaling-profiles`
- `design/04-fake-rails-and-seeder/synthetic_operational_data_seeder_architecture.md#3-comprehensive-multi-state-distribution-across-all-66-database-models`
- `design/04-fake-rails-and-seeder/synthetic_operational_data_seeder_architecture.md#4-two-phase-seeder-execution--fake-rails-bulk-synchronization-pipeline`
- `design/04-fake-rails-and-seeder/synthetic_operational_data_seeder_architecture.md#5-directory-structure-of-the-synthetic-seeder-module`
- `design/00-process/blueprint-management.md#5-documentation-corrections-backlog`

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
- 2026-11-04 — Realism rework: engine-template ledger, lifecycle-valid attempts, profile volumes drive generation, Tripoli time, Vault-encrypted columns, approvals bound to real subjects, namespaced ids, derived route health, read models, full invariant suite and DB/dataset equality in the audit, 35 new DB-free tests. See section 3.13 and `design/04-fake-rails-and-seeder/synthetic_operational_data_seeder_architecture.md` (2026-11-04 corrections).

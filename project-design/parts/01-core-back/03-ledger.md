---
id: core.ledger
title: Double-Entry Ledger
status: partial
confidence: high
last_verified: 2026-11-05
verified_against: 5a24f6f+working-tree
code:
  - core-back/engine/ledger/LedgerPoster.ts
  - core-back/engine/ledger/CheckpointService.ts
  - core-back/engine/ledger/InvariantVerifier.ts
  - core-back/lib/storageEngine/ledgerShardWriter.ts
  - core-back/lib/storageEngine/shardBalances.ts
  - core-back/lib/storageEngine/ledgerPosterFactory.ts
  - core-back/lib/storageEngine/uowAdapter.ts
  - core-back/prisma/seedGlAccounts.ts
  - core-back/prisma/schema.prisma
  - core-back/prisma/migrations/20261105090000_append_only_ledger_guards/migration.sql
  - core-back/lib/cashoutBalance.ts
design_sources:
  - design/01-platform-architecture/payment_gateway_final_design-v5.md#11
  - design/90-archive/superseded-architecture/payment-gateway-refined-design-v4.1.md#9
  - design/90-archive/superseded-architecture/Dynamic-Payment-Gateway-Management-Design-v2.md#10
  - design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md#31
tests:
  - core-back/test/engine/ledger.test.ts
  - core-back/test/phase2-ledger-and-governance.test.ts
  - core-back/test/exhaustive/02-ledger/all-15-templates-matrix.test.ts
  - core-back/test/exhaustive/02-ledger/checkpoints-and-invariant.test.ts
  - core-back/test/exhaustive/02-ledger/commission-hierarchy-and-bearers.test.ts
  - core-back/test/exhaustive/02-ledger/property-fuzzer-10k.test.ts
  - core-back/test/storage-engine/ledger-shards.test.ts
  - core-back/test/storage-engine/uow.test.ts
  - core-back/test/storage-engine/write-path.integration.test.ts
  - core-back/test/security-regressions/h7-rounding.test.ts
  - core-back/test/security-regressions/h4-cashout.test.ts
  - core-back/test/hardening-gap-regressions.test.ts
gaps:
  - "`CheckpointService` is not scheduled or wired into the production runtime; no checkpoint history table exists."
  - "Merchant balance fallbacks add every journal line to `checkpoint_balance`, so a captured checkpoint would be double counted."
  - "No database trigger enforces a balanced journal entry; balance is enforced by `LedgerPoster.validateTemplate` and checked periodically by the invariant worker."
  - "Shard rows are projected on write but are not rebuilt or reconciled; a missing shard falls back to journal-line reads."
  - "Idempotent replay returns the existing entry with an empty line list and does not compare the replay payload with the original posting."
  - "Historical design and two test titles still say 15/16 templates even though the code defines 17 scenarios and 20 matrix variants."
  - "Production must connect as the non-owner role `pgw_app`; if it connects as the owner that ran the migrations the REVOKE layer is moot (the triggers still reject UPDATE/DELETE/TRUNCATE). GAP-013 resolved 2026-11-05 with this operational caveat."
---

# Double-Entry Ledger

## 1. Purpose and scope

This part owns the chart of accounts, journal construction and posting, posting idempotency, account-shard projection, checkpoints, and the system-wide double-entry invariant. It is the only code path allowed to write `journal_entries` and `journal_lines`.

It does not own commission calculation (the engine pins the commission profile onto the attempt), payment lifecycle transitions, approval workflows, or record retention. Those callers must pass a resolved amount, commission, fee, and ownership mode into the ledger. The ledger deliberately rejects an invented fee or an unbalanced template rather than guessing.

Primary dependencies:

- `core-back/engine/ledger/LedgerPoster.ts` — templates, validation, posting, account resolution.
- `core-back/lib/storageEngine/ledgerShardWriter.ts` and `shardBalances.ts` — per-attempt shard projection and shard reads.
- `core-back/engine/ledger/CheckpointService.ts` — checkpoint snapshot and live-balance calculation.
- `core-back/engine/ledger/InvariantVerifier.ts` — system-wide drift check.
- `core-back/prisma/seedGlAccounts.ts` — seeded system accounts and shards.

## 2. Design intent (extracted and synthesized from ./design)

The design requires an append-only, double-entry ledger with a fixed chart of accounts, money as `Decimal(18,4)`, and a system-wide invariant that is checked continuously. It also requires the ledger to support three fee-bearer modes and three ownership modes without allowing the caller to determine the money arbitrarily.

### Fee-bearer modes

| Mode | Payer is charged | Merchant receives | Platform books | Checkout display |
| :--- | :--- | :--- | :--- | :--- |
| `MERCHANT_ABSORBS` | link amount | link amount minus commission | commission gross | `Total: 100.00 LYD` |
| `PAYER_SURCHARGE` | link amount plus surcharge | link amount | commission gross | `100.00 + 3.00 Service Fee = 103.00 LYD` |
| `SPLIT` | link amount plus the payer share of the fee | link amount minus the merchant share | commission gross | shows the agreed split before confirmation |

`buildPaymentConfirmationTemplate` selects the scenario from `feeBearer`, `feeAccrual`, and `ownershipMode` (`core-back/engine/ledger/LedgerPoster.ts:586`). A platform-held confirmation without accrual deducts the provider fee at source; with accrual it books `GATEWAY_FEE_EXPENSE` and `GATEWAY_FEE_ACCRUAL`. A payer surcharge adds `surchargeAmount` on top; a split uses the caller-supplied `merchantAmount`.

### Ownership modes

| Mode | Meaning | Confirmation treatment |
| :--- | :--- | :--- |
| `PLATFORM_CLEARING` | the gateway owes the platform until settlement | debit `GATEWAY_CLEARING`, book provider or gateway fees, credit wallet and income |
| `INTERNAL` | first-party rail (NeomPay); no external clearing account | `INTERNAL_CONFIRMATION`: debit `TREASURY`, credit wallet and income |
| `MERCHANT_DIRECT` | merchant owns the gateway account and receives the money directly | commission only: debit `COMMISSION_RECEIVABLE`, credit `PLATFORM_INCOME`; netting later moves wallet against receivable |

`PROVIDER_HELD` is a valid `settlementTarget` in the schema but is treated as `PLATFORM_CLEARING` by the ownership-mode projection (`core-back/engine/runtime/attemptRepository.ts:56`).

### System-wide invariant

The design states:

```text
TREASURY + SUM(GATEWAY_CLEARING) + SUM(COMMISSION_RECEIVABLE)
==
SUM(MERCHANT_WALLET) + PLATFORM_INCOME
- PROVIDER_FEE_EXPENSE - GATEWAY_FEE_EXPENSE
+ GATEWAY_FEE_ACCRUAL + AML_HOLD + CHARGEBACK_RESERVE + SUSPENSE
```

The implemented verifier applies this equation to natural balances, where debit-positive accounts are taken as-is and credit-positive accounts are negated (`core-back/engine/ledger/InvariantVerifier.ts:27`). The design also describes database triggers for the invariant; the actual database only enforces positive line amounts, while the balance equation is application-level and scheduled.

### The 17 scenarios (design said 15 worked entries)

The historical design listed 15 worked entries. The code now defines 17 `LedgerScenario` values: the original 15 plus `SPLIT_SURCHARGE_CONFIRMATION` and `SUSPENSE_SETTLEMENT`. Three scenarios have multiple stages (merchant-direct netting, AML release, chargeback lost), so the exhaustive matrix contains 20 labels rather than 17.

## 3. As-built architecture

### 3.1 Chart of accounts and scoping

There are 11 `GlAccountType` values in `core-back/prisma/schema.prisma:85`. The account resolver narrows a lookup only by the dimensions that the account type carries:

| Account type | Scope | Natural side |
| :--- | :--- | :--- |
| `TREASURY` | global | debit |
| `GATEWAY_CLEARING` | gateway + environment + credential set | debit |
| `MERCHANT_WALLET` | merchant (`ownerId`) | credit |
| `PLATFORM_INCOME` | global | credit |
| `PROVIDER_FEE_EXPENSE` | global | debit |
| `GATEWAY_FEE_EXPENSE` | global | debit |
| `GATEWAY_FEE_ACCRUAL` | global | credit |
| `COMMISSION_RECEIVABLE` | global | debit |
| `AML_HOLD` | global | credit |
| `CHARGEBACK_RESERVE` | global | credit |
| `SUSPENSE` | global | credit |

`ACCOUNT_SCOPING` and `resolveAccountId` are in `core-back/engine/ledger/LedgerPoster.ts:263` and `:764`. Resolution order is:

1. explicit `selector.accountId`;
2. the caller's `context.accounts[accountType]` override;
3. a scoped `findFirst` using account type plus owner, gateway, credential set, environment, and currency where applicable;
4. a platform-wide fallback with the same account type and currency and null scope dimensions;
5. `GL_ACCOUNT_NOT_FOUND`.

The seed creates all 11 system account types per supported currency (`LYD`, `USD`, `EUR`) with a stable `seedKey` (`core-back/prisma/seedGlAccounts.ts:1`). A new settlement currency requires either a new seeded system account or an explicit account mapping; otherwise posting fails with `GL_ACCOUNT_NOT_FOUND`.

### 3.2 Posting pipeline

`LedgerPoster.post` (`core-back/engine/ledger/LedgerPoster.ts:652`):

1. validates the template: non-empty reference, at least one line, strictly positive amounts, and debit total equal to credit total;
2. checks `journalEntry.findFirst({ refType, refId })` and returns the existing entry as idempotent;
3. creates the journal entry;
4. resolves each line's GL account;
5. creates the journal line with a `Decimal` amount;
6. invokes the optional shard writer in the same transaction;
7. invokes the optional `ledger.entry_posted` outbox writer in the same transaction. Since 2026-11-04 `createLedgerPoster` does NOT emit it by default (`emitOutbox: true` opts in) because the topic has no consumer.

Since 2026-11-04 a posting is batched: one entry insert (`createManyAndReturn` with `skipDuplicates`, so a racing duplicate reference returns the existing entry without aborting the transaction), one account lookup (`findMany` over the OR of scoped and platform-wide predicates, same precedence as before), one journal-line `createManyAndReturn`, and one shard upsert (`unnest`, folded per (account, shard) and sorted so concurrent postings lock shard rows in the same order).

If the entry insert races another transaction, a Prisma `P2002`/`UNIQUE_CONSTRAINT_VIOLATION` is caught, the existing entry is looked up, and the call becomes idempotent (`LedgerPoster.ts:674`).

The production poster is built by `createLedgerPoster` (`core-back/lib/storageEngine/ledgerPosterFactory.ts:17`), which wires the shard writer and the transactional outbox writer. Tests and narrow callers may still construct `LedgerPoster` directly, in which case no shards or outbox rows are written.

### 3.3 Templates and the exact worked entries

All examples use `amount = 100.0000`, `commission = 3.0000`, `providerFee = 1.0000`, `gatewayFee = 0.8000`, `merchantAmount = 97.0000`, unless the scenario needs a different split. The code defaults are 3% commission, 1.0000 provider fee, and 0.8000 gateway fee for the raw scenario builder, but production confirmation is strict and requires the resolved commission and fee.

| # | Scenario | Stage / ref type | Worked entry |
| :---: | :--- | :--- | :--- |
| 1 | `PLATFORM_HELD_CONFIRMATION` | confirm, `PAYMENT_ATTEMPT` | `Dr TREASURY 99.0000`; `Dr PROVIDER_FEE_EXPENSE 1.0000`; `Cr MERCHANT_WALLET 97.0000`; `Cr PLATFORM_INCOME 3.0000` |
| 2 | `PLATFORM_HELD_FEE_ACCRUAL` | confirm, `PAYMENT_ATTEMPT` | `Dr GATEWAY_CLEARING 100.0000`; `Dr GATEWAY_FEE_EXPENSE 0.8000`; `Cr MERCHANT_WALLET 97.0000`; `Cr PLATFORM_INCOME 3.0000`; `Cr GATEWAY_FEE_ACCRUAL 0.8000` |
| 3 | `SETTLEMENT_SWEEP` | sweep, `SETTLEMENT_SWEEP` | `Dr TREASURY 99.2000`; `Dr GATEWAY_FEE_ACCRUAL 0.8000`; `Cr GATEWAY_CLEARING 100.0000` |
| 4 | `FEE_VARIANCE_TRUE_UP` | variance, `FEE_VARIANCE` | `Dr GATEWAY_FEE_EXPENSE 0.1000`; `Cr GATEWAY_FEE_ACCRUAL 0.1000` |
| 5 | `PAYER_SURCHARGE_CONFIRMATION` | confirm, `PAYMENT_ATTEMPT` | `Dr GATEWAY_CLEARING 103.0000`; `Dr GATEWAY_FEE_EXPENSE 0.8000`; `Cr MERCHANT_WALLET 100.0000`; `Cr PLATFORM_INCOME 3.0000`; `Cr GATEWAY_FEE_ACCRUAL 0.8000` |
| 6 | `SPLIT_SURCHARGE_CONFIRMATION` | confirm, `PAYMENT_ATTEMPT` | `Dr GATEWAY_CLEARING 101.5000`; `Dr GATEWAY_FEE_EXPENSE 0.8000`; `Cr MERCHANT_WALLET 98.5000`; `Cr PLATFORM_INCOME 3.0000`; `Cr GATEWAY_FEE_ACCRUAL 0.8000` |
| 7 | `MERCHANT_DIRECT_CONFIRMATION` | confirm, `PAYMENT_ATTEMPT` | `Dr COMMISSION_RECEIVABLE 3.0000`; `Cr PLATFORM_INCOME 3.0000` |
| 7b | `MERCHANT_DIRECT_CONFIRMATION` | netting, `COMMISSION_NETTING` | `Dr MERCHANT_WALLET 3.0000`; `Cr COMMISSION_RECEIVABLE 3.0000` |
| 8 | `AML_HOLD_AND_RELEASE` | hold, `PAYMENT_ATTEMPT` | `Dr GATEWAY_CLEARING 100.0000`; `Cr AML_HOLD 100.0000` |
| 8b | `AML_HOLD_AND_RELEASE` | release, `AML_RELEASE` | `Dr AML_HOLD 100.0000`; `Cr MERCHANT_WALLET 97.0000`; `Cr PLATFORM_INCOME 3.0000` |
| 9 | `CASHOUT` | execution, `ADJUSTMENT` | `Dr MERCHANT_WALLET 100.0000`; `Cr TREASURY 100.0000` |
| 10 | `FULL_REFUND` | execution, `ADJUSTMENT` | `Dr MERCHANT_WALLET 97.0000`; `Dr PLATFORM_INCOME 3.0000`; `Cr TREASURY 100.0000` |
| 11 | `CHARGEBACK_RESERVE_AND_LOST` | reserve, `DISPUTE_OUTCOME` | `Dr MERCHANT_WALLET 97.0000`; `Dr PLATFORM_INCOME 3.0000`; `Cr CHARGEBACK_RESERVE 100.0000` |
| 11b | `CHARGEBACK_RESERVE_AND_LOST` | lost, `DISPUTE_OUTCOME` | `Dr CHARGEBACK_RESERVE 100.0000`; `Cr TREASURY 100.0000` |
| 12 | `AML_VOID` | void, `AML_VOID` | `Dr AML_HOLD 100.0000`; `Cr TREASURY 100.0000` |
| 13 | `CHARGEBACK_WON` | outcome, `DISPUTE_OUTCOME` | `Dr CHARGEBACK_RESERVE 100.0000`; `Cr MERCHANT_WALLET 97.0000`; `Cr PLATFORM_INCOME 3.0000` |
| 14 | `INTERNAL_CONFIRMATION` | confirm, `PAYMENT_ATTEMPT` | `Dr TREASURY 100.0000`; `Cr MERCHANT_WALLET 97.0000`; `Cr PLATFORM_INCOME 3.0000` |
| 15 | `INTERNAL_REFUND` | refund, `ADJUSTMENT` | `Dr MERCHANT_WALLET 97.0000`; `Dr PLATFORM_INCOME 3.0000`; `Cr TREASURY 100.0000` |
| 16 | `CHARGEBACK_INSUFFICIENT` | outcome, `DISPUTE_OUTCOME` | `Dr MERCHANT_WALLET 97.0000`; `Dr PLATFORM_INCOME 3.0000`; `Cr CHARGEBACK_RESERVE 100.0000` |
| 17 | `SUSPENSE_SETTLEMENT` | settlement, `PAYMENT_ATTEMPT` | `Dr TREASURY 100.0000` for `INTERNAL`, otherwise `Dr GATEWAY_CLEARING 100.0000`; `Cr SUSPENSE 100.0000` |

The exact builders are in `core-back/engine/ledger/LedgerPoster.ts:285` through `:576`. The split example deliberately uses a `1.5000` payer surcharge and `98.5000` merchant amount to demonstrate that the template balances only when the caller supplies a consistent merchant amount; the raw builder will produce an invalid template otherwise and `validateTemplate` will reject it.

### 3.4 Strict confirmation vs raw scenario builder

`buildPaymentConfirmationTemplate` (`LedgerPoster.ts:586`) is the production path from the engine (`core-back/engine/flow/DynamicRailEngine.ts:1020`). It enforces:

- `PLATFORM_CLEARING` requires `commissionAmount`;
- `PAYER_SURCHARGE` and `SPLIT` require both `gatewayFeeAmount` and `surchargeAmount`;
- `MERCHANT_ABSORBS` with `feeAccrual` requires `gatewayFeeAmount`;
- `MERCHANT_ABSORBS` without accrual requires `providerFeeAmount`;
- `INTERNAL` and `MERCHANT_DIRECT` bypass the fee checks.

The raw `buildLedgerTemplate` is still public and is used by settlement sweeps, fee variance, suspense, AML, adjustments, cash-out, and tests. Its defaults are convenience defaults, not a production authority: any new production caller should pass explicit money.

### 3.5 Shard writer and shard balances

`createLedgerShardWriter` (`core-back/lib/storageEngine/ledgerShardWriter.ts:8`) projects every journal line into `gl_account_shards`:

- default shard count is 16 (`DEFAULT_SHARD_COUNT`);
- `MERCHANT_WALLET` uses one shard, `shard_id = 0`;
- every other account type uses `fnv1aHash(refId) % shardCount`;
- a debit is a positive delta, a credit is negative;
- the insert uses `ON CONFLICT (gl_account_id, shard_id) DO UPDATE` and creates the shard row on demand;
- the write runs inside the same transaction as the journal line.

`shardIdForAttempt` receives `line.refId` for every reference type, not only payment attempts. An adjustment, dispute, settlement batch, or fee variance therefore hashes its own reference. `ensureAccountShards` exists to pre-provision all shards for an account, but production does not call it; the seed provisions shards for the seeded system accounts and merchant shards are created on first posting.

`naturalShardBalance` (`core-back/lib/storageEngine/shardBalances.ts:86`) negates credit-positive accounts so a shard sum can be displayed as a natural balance. `loadShardBalanceRows` groups by account and returns only accounts that actually have shard rows.

### 3.6 Checkpoints

`CheckpointService.captureCheckpoint` (`core-back/engine/ledger/CheckpointService.ts:44`):

1. locks the GL account with `SELECT ... FOR UPDATE` when raw SQL is available;
2. sums all journal lines up to `asOf`;
3. chooses `lastCheckpointId` from the latest journal entry, or a synthetic `checkpoint:<account>:<timestamp>` string;
4. writes `checkpointBalance`, `checkpointAt`, and `lastCheckpointId` onto `gl_accounts`.

`getLiveBalance` adds the checkpoint balance to lines strictly after `checkpointAt` (`CheckpointService.ts:94`). There is no checkpoint-history table; the checkpoint is represented only by the three fields on `gl_accounts`. `captureCheckpoint` has no production caller: only the ledger tests and the exhaustive checkpoint suite exercise it. The runtime reads `checkpointBalance`/`checkpointAt` in the verifier and in the admin fallback, but no scheduled job captures new checkpoints.

### 3.7 Invariant verifier

`InvariantVerifier.verify` accepts either a Prisma-like client or a balance provider. With a client it loads every GL account and sums the lines after that account's checkpoint (`InvariantVerifier.ts:107`). It groups natural balances by account type and computes the invariant. `assertInvariant` throws on non-zero drift.

Production uses the verifier in two places:

- `LedgerInvariantWorker` checks every 60 seconds and opens one open `MISMATCH`/`P1` operator case when drift is non-zero (`core-back/engine/workers/LedgerInvariantWorker.ts:16`);
- the admin finance/invariant endpoint computes the same snapshot on demand (`core-back/api/internal/admin.ts:15090`).

### 3.8 Balance-read reality

There is no single balance-read path. The actual sources are:

| Reader | Source | Behavior when shards are absent |
| :--- | :--- | :--- |
| Merchant `GET /wallets/:id/balance` | shard sum first | falls back to `checkpointBalance + every journal line` (`core-back/api/internal/merchant.ts:1370`) |
| `merchantWalletBalance` helper | shard sum first | falls back to `checkpointBalance + every journal line` (`core-back/lib/merchantOps.ts:176`) |
| Admin ledger balances | shard sum first | falls back to `checkpointBalance + lines since checkpointAt` (`core-back/api/internal/admin.ts:14626`) |
| Invariant verifier | checkpoint plus lines since checkpoint | always journal-based |
| Merchant `getWalletBalance` repository | sum of shard rows | returns zero when no shard rows exist (`core-back/engine/db/repositories.ts:162`) |

The merchant fallbacks start from the checkpoint balance and then add *all* journal lines. As long as no checkpoint has been captured (`checkpointBalance = 0`, `checkpointAt = null`) this is correct. If `CheckpointService` is ever activated, those fallbacks will double count the checkpoint window. This is a code gap, not an intentional design.

## 4. Contracts and invariants

1. Every journal entry must have at least one debit and one credit, debit total must equal credit total, and every line amount must be strictly positive. `validateTemplate` enforces this before insertion (`LedgerPoster.ts:740`).
2. `(refType, refId)` is unique. Posting is idempotent for that pair. A duplicate returns the existing entry with `created: false`, `idempotent: true`, and an empty `lines` array.
3. Money is `Decimal(18,4)`; no floating-point arithmetic is used in posting or validation.
4. Journal lines are append-only. The application exposes no update or delete path, and retention deliberately excludes `journal_entries` and `journal_lines`.
5. A zero optional leg is omitted rather than booked as a zero line (`optionalLine`, `LedgerPoster.ts:252`).
6. Account resolution never invents an account: a missing scoped account falls back only to the same type and currency, and then fails with `GL_ACCOUNT_NOT_FOUND`.
7. Shard projection is in the same transaction as the journal line. A shard balance is the signed sum of every line projected to that shard; the natural balance negates credit-positive accounts.
8. A checkpoint is a snapshot, not a replacement for journal lines. A live balance is checkpoint plus later lines. A checkpoint must serialize against postings to the same account.
9. The invariant equation is the authoritative system-wide check. A non-zero drift is an operational incident and opens a P1 case.
10. Adjustment, refund, chargeback, cash-out, AML release/void, and suspense postings use the same ledger and the same idempotency contract.

## 5. Data / API / config / deployment surface

### Schema

- `GlAccount`: `accountType`, `ownerId`, `gatewayId`, `credentialSetId`, `env`, `currency`, `lastCheckpointId`, `checkpointBalance`, `checkpointAt`, `seedKey`.
- `GlAccountShard`: composite primary key `(glAccountId, shardId)`, `currentBalance`, `updatedAt`.
- `JournalEntry`: unique `(refType, refId)`; `JournalRefType` values are `PAYMENT_ATTEMPT`, `ADJUSTMENT`, `AML_RELEASE`, `AML_VOID`, `SETTLEMENT_SWEEP`, `FEE_VARIANCE`, `COMMISSION_NETTING`, `DISPUTE_OUTCOME`.
- `JournalLine`: `entryId`, `glAccountId`, `direction`, `amount`; primary key `(id, createdAt)` because the table is monthly range-partitioned; indexes on `(entryId, createdAt)` and `(glAccountId, createdAt)`.
- Database checks: `journal_lines_amount_positive`; no balance trigger.

### Configuration

- `STORAGE_SHARD_COUNT` defaults to 16 and is capped at 16 (`core-back/lib/env/index.ts:63`).
- Supported currencies are seeded from `SUPPORTED_CURRENCIES = ["LYD", "USD", "EUR"]` (`core-back/prisma/seedGlAccounts.ts`).
- The production poster is constructed once in `core-back/engine/runtime/platform.ts:132`; the same instance is given to the engine, governance execution, and the background-job handlers.

### Read surfaces

- Merchant wallet balance: `GET /internal/merchant/wallets/:id/balance`.
- Admin invariant/liquidity: finance routes backed by `InvariantVerifier` and `loadLedgerBalances`.
- Worker: `LedgerInvariantWorker` every 60 seconds.
- No public ledger API exists. The ledger is internal to `core-back`; edges never receive database credentials.

## 6. Operational usage

### Posting a journal

Use `postPaymentConfirmation` for a settled payment. Supply the pinned commission and fee; do not rely on the raw builder defaults:

```text
postPaymentConfirmation(attemptId, {
  ownershipMode,
  feeBearer,
  feeAccrual,
  amount,
  surchargeAmount,
  commissionAmount,
  merchantAmount,
  gatewayFeeAmount,
  providerFeeAmount,
})
```

Use `postScenario` for settlement sweeps, fee variance, suspense, AML, and adjustments. Set a stable `refId`; the ledger dedupes on `(refType, refId)`.

### Adding an account or currency

1. Add/seed `gl_accounts` rows for every currency-scoped account type.
2. Seed or allow the shard writer to create shards. `ensureAccountShards` is available for explicit provisioning.
3. Add the currency to the seed and to any currency validation before accepting payments in it.
4. Verify a posting in that currency resolves every account type it uses; otherwise the confirmation fails with `GL_ACCOUNT_NOT_FOUND`.

### Investigating a balance

1. Read `gl_accounts.checkpoint_balance` and `checkpoint_at`.
2. Read `gl_account_shards` for the account. If rows exist, their signed sum is the intended fast balance.
3. If no shard rows exist, use the admin/journal fallback: checkpoint plus lines since `checkpointAt`.
4. Do not use the merchant fallback as the authority once checkpoints are active; it adds all lines.
5. Run the invariant verifier. Non-zero drift means the journal itself is inconsistent, not merely a stale shard.

## 7. Status and deviations

### Implemented

- 11 GL account types and currency-scoped system-account seeding.
- 17 scenario builders and strict payment-confirmation builder.
- Balanced-template validation, positive line validation, idempotent posting.
- Account resolution with scoped and platform-wide fallback.
- Transactional shard projection with 16-way hashing and one-shard merchant wallets.
- Checkpoint capture/get-live-balance service (code-complete, not scheduled).
- Scheduled invariant worker and on-demand verifier.
- Suspense routing and AML hold/release/void posting.
- Adjustment, refund, chargeback, cash-out, settlement sweep, and fee-variance postings.

### Partial

- **Checkpoint lifecycle** — the service exists but no runtime schedules it, no checkpoint history is retained, and no administrative route captures one.
- **Shard lifecycle** — writes are projected, but there is no rebuild, reconciliation, or drift detector for shards; `ensureAccountShards` is test-only.
- **Balance reads** — three different read paths exist. Admin and verifier use “since checkpoint”; merchant fallbacks use “all lines”.
- **Scenario coverage** — some scenarios are exercised mainly by template tests (`PLATFORM_HELD_*`, `PAYER_SURCHARGE`, `SPLIT`, `MERCHANT_DIRECT` netting) rather than by every runtime path. The engine and governance paths use the main confirmation, sweep, suspense, AML, refund, chargeback, and cash-out scenarios.
- **Database enforcement** — only the positive-amount check and the approval maker/checker constraint are in PostgreSQL; journal balance is application-level.

### Missing / deferred

- No database trigger or deferred constraint that rejects an unbalanced journal entry.
- No `ledger_checkpoints` table or checkpoint audit trail.
- No shard repair/rebuild command.
- No automatic shard-to-journal reconciliation alert separate from the invariant worker.
- No support for currencies beyond the seeded `LYD`, `USD`, `EUR` without manual seeding.

### Known bugs / risks

- **Code gap:** merchant wallet and `merchantWalletBalance` fallbacks double count a captured checkpoint because they add every line to `checkpointBalance`. They are currently masked because no checkpoint is captured in production.
- **Code gap:** idempotent replay of the same `(refType, refId)` with a different template silently returns the first entry; it does not compare the line set or amounts. A caller that reuses a reference for a different economic event loses the second posting.
- **Code gap:** `getWalletBalance` in the repository returns `0` when an account has no shard rows, unlike the API helper that falls back to journal lines. Callers using the repository directly must not treat zero as authoritative before shards exist.
- **Documentation gap:** `core-back/test/engine/ledger.test.ts` describes “all 16 journal entry templates”; the exhaustive matrix header says “15” and asserts 20 labels. The canonical count is 17 scenarios / 20 staged variants.
- **Risk:** the raw scenario builder defaults commission/provider/gateway fee. A production caller that forgets a fee will silently book the default rather than fail. Use `postPaymentConfirmation` or pass every amount explicitly.

## 8. Verification and tests

Run:

```bash
cd core-back && bun test test/engine/ledger.test.ts
cd core-back && bun test test/phase2-ledger-and-governance.test.ts
cd core-back && bun test test/exhaustive/02-ledger
cd core-back && bun test test/storage-engine/ledger-shards.test.ts
```

Coverage:

- `test/engine/ledger.test.ts` — template balance, scenario semantics, strict fee resolution, idempotency, unbalanced rejection, checkpoint service, invariant provider.
- `test/exhaustive/02-ledger/all-15-templates-matrix.test.ts` — 20 labels × 3 currencies × 5 amount tiers × 4 fee configurations = 1,200 template constructions.
- `test/exhaustive/02-ledger/checkpoints-and-invariant.test.ts` — checkpoint snapshot, no double count, 500-entry fuzz drift, deliberate drift detection; requires PostgreSQL and skips otherwise.
- `test/exhaustive/02-ledger/commission-hierarchy-and-bearers.test.ts` / `property-fuzzer-10k.test.ts` — commission precedence, fee-bearer matrices, 10,000 deterministic monetary iterations.
- `test/storage-engine/ledger-shards.test.ts` / `uow.test.ts` / `write-path.integration.test.ts` — 16-shard distribution, merchant one-shard rule, parity after concurrent postings, `ensureAccountShards`, atomic ledger/outbox/shard write path; live PostgreSQL required.

The unit suites run without PostgreSQL. The checkpoint, shard, UoW, and write-path integration suites require PostgreSQL 18 and report as skipped when the database is unavailable.

## 9. Source references

### Old design sections

- `design/01-platform-architecture/payment_gateway_final_design-v5.md` §11 — fee bearers, invariant, 15 worked entries; `design/90-archive/superseded-architecture/payment-gateway-refined-design-v4.1.md` §9 — original ledger model and entries.
- `design/90-archive/superseded-architecture/Dynamic-Payment-Gateway-Management-Design-v2.md` §10 — clearing account rationale and merchant-direct model; `design/02-storage-and-performance/storage_driver_postgres18_backup_and_scaling_architecture.md` §3.1 — sharded sub-accounts and read path.
- `core-back/test/exhaustive/02-ledger/all-15-templates-matrix.test.ts` — current 20-label matrix despite the historical title.

### Code paths

- `core-back/engine/ledger/LedgerPoster.ts`
- `core-back/engine/ledger/CheckpointService.ts`
- `core-back/engine/ledger/InvariantVerifier.ts`
- `core-back/lib/storageEngine/ledgerShardWriter.ts`
- `core-back/lib/storageEngine/shardBalances.ts`
- `core-back/lib/storageEngine/ledgerPosterFactory.ts`
- `core-back/lib/storageEngine/uowAdapter.ts`
- `core-back/engine/flow/DynamicRailEngine.ts`
- `core-back/engine/governance/GovernanceExecution.ts`
- `core-back/engine/runtime/slotStore.ts`
- `core-back/engine/workers/BackgroundJobHandlers.ts`
- `core-back/prisma/seedGlAccounts.ts`
- `core-back/prisma/schema.prisma`

### Generated appendices

- `project-design/appendices/schema-catalog.md` — GL, journal, and shard models.
- `project-design/appendices/migration-catalog.md` — baseline, storage-engine, and hardening migrations.
- `project-design/appendices/test-inventory.md` — ledger suite inventory.

## 10. Change history

- 2026-11-03 — Baseline verification against `5a24f6f+working-tree`: documented the 17 scenarios, 11 account types, shard writer, checkpoint and verifier behavior, balance-read differences, and the missing database balance enforcement.

## 11. Security hardening (2026-11-05)

- **Commission math.** `buildBreakdown` rounds the commission once, honouring the commission profile's `roundingMode` (`HALF_UP` default, `HALF_EVEN`, `HALF_DOWN`, `UP`, `DOWN`, `CEILING`, `FLOOR`; 4 decimal places). Net, payer share and surcharge are derived by exact subtraction so journals balance. The gateway fee and refund split are each rounded once, explicitly.
- **Cash-out ledger rules.** Approval journals use the cash-out id as `refId`. Balance is verified under a `FOR UPDATE` lock on the wallet's shards (`lib/cashoutBalance.ts`); `lockGlAccountShardsSorted` orders shards by byte order to keep lock ordering deterministic.
- **Checkpoint is transactional on the DB clock, with shard parity (GAP-011, RESOLVED 2026-11-05).** `CheckpointService.captureCheckpoint` runs the account row lock (`SELECT ... FOR UPDATE`), the snapshot sum, the parity check and the `gl_accounts` write in ONE database transaction (`$transaction`, 30 s timeout; a narrow test double without `$transaction` runs the same steps directly). When the caller passes no `asOf`, the checkpoint instant is the database clock (`clock_timestamp()` read after the lock is held), never the application clock, because journal lines carry database timestamps and a skewed node could otherwise include or skip lines at the boundary. The shard parity check compares, per account that has `gl_account_shards` rows, the shard total with `checkpoint_balance` plus the journal lines after `checkpoint_at`, in ONE SQL statement (one snapshot, so a concurrent posting cannot cause a false mismatch). `CheckpointServiceOptions.parity` is `enforce` (default: the capture throws `ShardParityError`, code `LEDGER_SHARD_PARITY_MISMATCH`), `warn` (captures and reports through `onParityMismatch`) or `off`. `CheckpointService.verifyShardParity(accountIds?)` and the exported `checkShardParity` run the read-only check and return the mismatches without throwing. The service is still not scheduled by the production runtime and there is no checkpoint history table (see the frontmatter gaps).
- **Append-only ledger and audit trail (GAP-013, RESOLVED 2026-11-05).** Migration `20261105090000_append_only_ledger_guards` installs `BEFORE UPDATE OR DELETE` row triggers and `BEFORE TRUNCATE` statement triggers on `journal_entries`, `journal_lines` (the parent and every partition; row triggers are cloned to future partitions, TRUNCATE triggers are installed on each existing partition) and `audit_log`. They raise `55000` for any caller, including the table owner. Two narrow bypasses exist: (1) maintenance, a transaction that sets `pgw.ledger_maintenance = 'on'` AND whose session user is a superuser or a member of the role `pgw_ledger_maintenance` (the application role is not a member); (2) retention, `DELETE` on `audit_log` only, in a transaction that sets `pgw.audit_retention = 'on'` (the `RetentionWorker` purge; the journal is never purged by retention). The migration also creates, best effort (a managed PostgreSQL may forbid `CREATE ROLE`; it then emits a notice and the roles must be provisioned manually), the NOLOGIN roles `pgw_ledger_maintenance` and the non-owner application role `pgw_app`, grants `pgw_app` the DML it needs and revokes `UPDATE`/`DELETE`/`TRUNCATE` on the journal tables and `UPDATE`/`TRUNCATE` on `audit_log` from it (`audit_log` keeps `DELETE` for the retention purge, still gated by the trigger). REVOKE alone does nothing against the table owner, which is why the triggers exist. **Production must connect as `pgw_app` (or another non-owner member of it), never as the owner that ran the migrations**; migrations still run as the owner. Test fixtures open the maintenance bypass through `core-back/test/helpers/ledgerMaintenance.ts`.
- **Tests.** `core-back/test/security-regressions/{h7-rounding,h4-cashout}` and `core-back/test/hardening-gap-regressions.test.ts` (checkpoint, parity, append-only guards). True concurrency needs PostgreSQL 18 and is not covered.

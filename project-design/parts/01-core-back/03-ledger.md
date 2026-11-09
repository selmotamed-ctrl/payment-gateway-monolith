---
id: core.ledger
title: Double-Entry Ledger
status: partial
confidence: high
last_verified: 2026-11-09
verified_against: working-tree
code:
  - core-back/engine/ledger/LedgerPoster.ts
  - core-back/engine/ledger/CheckpointService.ts
  - core-back/engine/ledger/InvariantVerifier.ts
  - core-back/lib/storageEngine/ledgerShardWriter.ts
  - core-back/lib/storageEngine/shardRouting.ts
  - core-back/engine/ledger/ShardScaler.ts
  - core-back/engine/ledger/shardScaling.ts
  - core-back/engine/ledger/ShardRepair.ts
  - core-back/prisma/migrations/20261107150000_shard_repairs/migration.sql
  - core-back/engine/ledger/ledgerAlerts.ts
  - core-back/engine/workers/LedgerCheckpointWorker.ts
  - core-back/engine/workers/LedgerShardScalerWorker.ts
  - core-back/prisma/migrations/20261107090000_shard_sequenced_checkpoints/migration.sql
  - core-back/lib/storageEngine/shardBalances.ts
  - core-back/lib/storageEngine/ledgerPosterFactory.ts
  - core-back/lib/storageEngine/uowAdapter.ts
  - core-back/api/internal/adminLedger.ts
  - core-back/api/internal/ledgerLines.ts
  - core-back/engine/db/repositories.ts
  - core-back/prisma/migrations/20261109210000_ledger_query_and_index_optimization/migration.sql
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
  - core-back/test/refund-merchant-direct.test.ts
  - core-back/test/exhaustive/02-ledger/checkpoints-and-invariant.test.ts
  - core-back/test/exhaustive/02-ledger/commission-hierarchy-and-bearers.test.ts
  - core-back/test/exhaustive/02-ledger/property-fuzzer-10k.test.ts
  - core-back/test/storage-engine/ledger-shards.test.ts
  - core-back/test/ledger-shard-sequence.test.ts
  - core-back/test/cashout-lock-order.test.ts
  - core-back/test/ledger-shard-repair.test.ts
  - core-back/test/ledger-shard-repair-api.test.ts
  - core-back/test/ledger-shard-auto-repair.test.ts
  - core-back/test/storage-engine/uow.test.ts
  - core-back/test/storage-engine/write-path.integration.test.ts
  - core-back/test/storage-engine/performance/ledger-query-pruning-and-accuracy.test.ts
  - core-back/test/security-regressions/h7-rounding.test.ts
  - core-back/test/security-regressions/h4-cashout.test.ts
  - core-back/test/hardening-gap-regressions.test.ts
gaps:
  - "No database trigger enforces a balanced journal entry; balance is enforced by `LedgerPoster.validateTemplate` and checked periodically by the invariant worker."
  - "Automatic shard scale-down is deferred; the shard scaler only widens (live by default) and an admin can set any width manually."
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
| `MERCHANT_DIRECT` | merchant owns the gateway account and receives the money directly | commission only: debit `COMMISSION_RECEIVABLE`, credit `PLATFORM_INCOME`; netting later moves wallet against receivable. A refund reverses only that commission (`MERCHANT_DIRECT_CONFIRMATION`, stage `REFUND`); it never touches the wallet or treasury |

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

The historical design listed 15 worked entries. The code now defines 17 `LedgerScenario` values: the original 15 plus `SPLIT_SURCHARGE_CONFIRMATION` and `SUSPENSE_SETTLEMENT`. Three scenarios have multiple stages (merchant-direct netting and refund, AML release, chargeback lost), so the exhaustive matrix contains 21 labels rather than 17.

**Refund template selection (2026-11-08).** Every refund path (the governance executor `finalizeRefundAdjustment`, `DynamicRailEngine.refund` and the synthetic seeder) picks its template through `refundScenarioFor(ownershipMode)` in `LedgerPoster.ts`, so they cannot diverge: `INTERNAL` -> `INTERNAL_REFUND`; `MERCHANT_DIRECT` -> `MERCHANT_DIRECT_CONFIRMATION` stage `REFUND` (label `MERCHANT_DIRECT_REFUND`); everything else -> `FULL_REFUND`. Before this fix a merchant-direct refund reused `FULL_REFUND`, which debits the merchant wallet for the net amount and credits treasury for the full amount although the platform never held the cash and never credited the wallet; the entry balanced, so the invariant verifier could not see it. A merchant-direct refund with nothing to reverse (`reverseCommission = false`, or a zero commission) posts no journal: the adjustment still becomes `EXECUTED` with a null `journalEntryId` (the chargeback path already behaves this way), the seeder skips such a refund because its verifier requires a journal on every executed adjustment, and the rail engine skips the posting.

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
| 7c | `MERCHANT_DIRECT_CONFIRMATION` | refund, `ADJUSTMENT` (keyed by the adjustment id) | `Dr PLATFORM_INCOME 3.0000`; `Cr COMMISSION_RECEIVABLE 3.0000` |
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

### 3.5 Shards, sequences and routing

An account's balance is the sum of its **shards** (`gl_account_shards`, debit-positive). A shard is also a **gapless sequence**: `gl_account_shards.line_seq` counts the lines posted to it, and every `journal_lines` row stores the `shard_id` it was posted to and its `shard_seq` (>= 1; 0 marks pre-genesis lines folded into the genesis checkpoint).

`createLedgerShardWriter` (`core-back/lib/storageEngine/ledgerShardWriter.ts`) runs inside the posting transaction and **before the lines are inserted**:

1. it loads each account's routing width (`gl_accounts.shard_count`, 1..256) from a 3-second process cache plus one batched query on a miss (a stale width is harmless: lines store their own shard and shard rows are never deleted);
2. `routeLine` (`lib/storageEngine/shardRouting.ts`) picks `fnv1a(refId) % width`; **balance-reducing lines of a `MERCHANT_WALLET` (debits) always go to shard 0**;
3. one statement `INSERT ... ON CONFLICT DO UPDATE` locks the touched shard rows in `(account, shard)` order, adds the signed delta to `current_balance` and the number of lines to `line_seq`, and `RETURNING`s the new `line_seq`;
4. `assignShardSeqs` gives the j-th line of a posting on a shard the number `high-water - n + j`; the poster then inserts the lines with `shard_id` and `shard_seq`.

The shard row lock is held until commit, so the sequence of a shard is serialized and **commit order equals sequence order**: any snapshot that sees a shard at `(balance B, line_seq S)` also sees every line with `shard_seq <= S`, and committed sequences are gapless (a rolled-back posting rolls back its bump too). An idempotent replay returns before any shard work and never advances a sequence. The DB guard `journal_lines_shard_seq_positive (CHECK shard_seq > 0) NOT VALID` rejects any new line that forgot its sequence; uniqueness of the sequence cannot be a unique index on the partitioned table, so it is proven by the checkpointer (below). The covering index `journal_lines_shard_seq_idx (gl_account_id, shard_id, shard_seq) INCLUDE (direction, amount)` serves the range scans.

Every account always has shard rows `0 .. shard_count-1`: the trigger `gl_accounts_create_shards` creates them with the account. System accounts start 16 wide (`STORAGE_SHARD_COUNT`, `initialShardWidth`), wallets 1 wide; the shard scaler (section 3.9) and the admin override widen an account later. `loadLiveAccountBalances` (`lib/storageEngine/shardBalances.ts`) is the single live-balance read: the shard sum converted to the account's natural sign; there is no journal fallback.

### 3.6 Checkpoints

A checkpoint is **per shard**: a `(balance, sequence)` pair in `gl_shard_checkpoints` (a shard without a row is at `(0, 0)`). The boundary is the shard's own gapless sequence, never a timestamp (`journal_lines.created_at` is stamped by the app process, so a time boundary could miss a line that commits late). The account stores no checkpoint: `checkpointBalance`/`checkpointAt` in the admin APIs are derived (sum of shard checkpoints, oldest checkpoint time).

`CheckpointService.captureShard` (`core-back/engine/ledger/CheckpointService.ts`) reads, in ONE statement (one snapshot), the shard `(B, S)`, its checkpoint `(Bc, Sc)` and `n = COUNT, delta = SUM` of the lines with `shard_seq in (Sc, S]`, and proves:

- **gapless** `n = S - Sc` (a missing, duplicate or misattributed line is detected), and
- **parity** `Bc + delta = B`.

Only then does a second, tiny monotonic upsert (`WHERE checkpoint_seq < EXCLUDED.checkpoint_seq`) move the checkpoint. It is O(lines since the last checkpoint), takes no lock on the shard or the account, and never blocks a posting; a capture that races a newer one reports NOOP. A `created_at` lower bound prunes the monthly partitions and is retried without the hint before a GAP is reported. A GAP or PARITY result does **not** move the checkpoint: the failure is recorded on the checkpoint row (`status`, `failure_kind`, `consecutive_failures`), the first failure opens a P1 `MISMATCH` operator case keyed `ledger.shard:<account>:<shard>` and writes a `LEDGER_SHARD_CHECKPOINT_FAILED` audit row.

`LedgerCheckpointWorker` (section 3.9) runs it automatically and, when a shard keeps failing, repairs it (section 3.10); `POST /finance/gl-accounts/:id/checkpoint` ("Run checkpoint rollup", `finance:write`, reason, audited) runs it for every shard of one account.

### 3.7 Invariant verifier

`InvariantVerifier.verify` accepts either a Prisma-like client or a balance provider. With `{sql: true}` it reads, in one statement, each account's live balance (the sum of its shards) and its shard checkpoints, groups natural balances by account type and computes the invariant. The 60 s check is therefore **O(shards)**, independent of how much history the journal holds. What ties the shards to the journal is the checkpointer (it proves `checkpoint + lines in the sequence range = shard balance` before every advance, in a chain from the genesis checkpoint) and the restore drill (it re-derives balances, checkpoints and sequence counts from the whole journal of a restored database). The non-SQL path used by test doubles sums every journal line.

Production uses the verifier in two places:

- `LedgerInvariantWorker` checks every 60 seconds and opens one `MISMATCH`/`P1` operator case (keyed `ledger.invariant`, so it never suppresses or is suppressed by a per-shard case) when drift is non-zero;
- the admin finance/invariant endpoint computes the same snapshot on demand.

### 3.8 Balance reads

Every live balance is the shard sum from `loadLiveAccountBalances` (merchant balance routes, `merchantWalletBalance`, the admin wallet and ledger views, the liquidity view). The cash-out and chargeback checks use `lockWalletLedgerBalance` (`core-back/lib/cashoutBalance.ts`). Wallet **debits are serialized by a transaction-scoped advisory lock on the wallet, taken FIRST**, before the transaction holds any shard row, so only other debiters ever wait for it and a waiter holds no shard row (no lock cycle is possible). A caller that knows the posting it is about to make (the cash-out) then calls `LedgerPoster.lockShardsFor(template, context, tx)`, which locks every shard row that posting will update in one statement in the global `(account, shard)` order (`lockShardsForLines`), exactly the order postings use, so a refund posting to shard 0 cannot slip in between the check and the debit and a payment confirmation can never form an opposite-order cycle with it. Only then does a final statement sum all shards (credits on other shards can only raise the balance, so the check is conservative). Regression: `test/cashout-lock-order.test.ts` (the old order deadlocks 75 times in 120 operations in the worst case; the new one never). Aging buckets of the gateway clearing view are the net signed movement of the last three days plus the balance (`admin.ts`), so they do not depend on any checkpoint.

### 3.10 Shard repair

A shard is a **projection** of the immutable journal. When it disagrees with the journal the journal is right, so a repair **recomputes the projection from the journal** (`engine/ledger/ShardRepair.ts`). It never posts a ledger entry to "fix" a shard: an adjusting entry would change the journal too and leave the shard exactly as wrong (and record a false economic event). A real money error is a business correction through the Adjustments flow, not a projection repair.

`planShardRepair` reads the shard and ALL its journal lines and decides, from whether the shard's sequence is intact (above `gl_shard_checkpoints.baseline_seq`, exactly `baseline+1 .. line_seq`, each used once):

- **RECOMPUTE** (sequence intact; only the stored balance or checkpoint disagrees): `current_balance := sum of ALL the shard's lines`, checkpoint := `(that sum, line_seq)`. Safe to automate.
- **REBASELINE** (sequence damaged: a line is missing or a number is duplicated): recomputing could drop money the shard held if the journal lost a line, so a person decides. `current_balance := journal sum`, `line_seq := max(line_seq, highest sequence found)` (a number is never reused), checkpoint := that point and `baseline_seq` := that point, so the damaged history before it is exempt from the gapless proof (the restore drill and the deploy gate honour `baseline_seq`).

`applyShardRepair` takes `FOR UPDATE` on the shard row (every line insert needs it first, so the shard's lines cannot change), RE-PLANS under the lock, refuses with `SHARD_REPAIR_PLAN_CHANGED` when the plan no longer hashes to what the caller previewed/approved, applies the change, appends a `gl_shard_repairs` row, writes the audit row `GL_SHARD_REPAIRED` and annotates the open per-shard operator case (which stays OPEN for a person to resolve). Timeouts: `lock_timeout 10s`, `statement_timeout 120s`.

Who may do what:

| | Automatic | Manual, single user | Manual, approved |
| :--- | :--- | :--- | :--- |
| PARITY, sequence intact (RECOMPUTE) | yes, guarded | yes (`finance:write`, reason, preview hash) | yes |
| GAP / damaged sequence (REBASELINE) | **never** | refused (`409 SHARD_REPAIR_NEEDS_APPROVAL`) | yes (maker-checker, subject `GL_SHARD_REPAIR`) |

The automatic repair (`LedgerCheckpointWorker`, `LEDGER_SHARD_AUTO_REPAIR_*`, on by default) only repairs a shard that failed its proof `LEDGER_SHARD_AUTO_REPAIR_MIN_FAILURES` times in a row (3: about 30 minutes at the 10-minute retry), whose failure kind is PARITY, whose sequence is intact and whose correction is at most `LEDGER_SHARD_AUTO_REPAIR_MAX_ABS_DRIFT` (100). The guard is re-evaluated under the lock; a declined shard is logged once per plan and left to a person. Manual preview/recompute/request endpoints are in the API surface; the approval is bound to the previewed `planHash`.

**Future: archived journal lines.** `planShardRepair` and the deep checks assume every line of a shard is in `journal_lines`, which is true today (nothing is archived). When old lines are moved to an archive, a repair will use archive plus live by default and the checkpoint anchor only when a deploy variable enables it; see `future.ledger-archive` (`09-future-and-unimplemented/04-ledger-archive-and-shard-repair.md`).

### 3.9 Automation workers and shard scaling

- **`LedgerCheckpointWorker`** (`engine/workers/LedgerCheckpointWorker.ts`, leader-elected, default on): every `WORKER_LEDGER_CHECKPOINT_INTERVAL_MS` it captures the shards with the most pending lines (`>= LEDGER_CHECKPOINT_MIN_LINES`, or any pending line with a checkpoint older than `LEDGER_CHECKPOINT_MAX_AGE_MS`), one shard per call, bounded by `WORKER_LEDGER_CHECKPOINT_BATCH_SIZE`. Failed shards are retried only every 10 minutes. Routine successes only update the checkpoint row; one aggregated `LEDGER_CHECKPOINT_SWEEP` audit row per hour summarises them.
- **`LedgerShardScalerWorker`** (`engine/workers/LedgerShardScalerWorker.ts`, leader-elected, **live by default**): it samples every shard's `line_seq`, turns the delta into lines per second per shard and asks the pure policy `decideShardWidth` (`engine/ledger/ShardScaler.ts`). A shard row serializes its postings, so the hottest shard's rate is the bottleneck signal; the account is widened when its EWMA stays above `LEDGER_SHARD_UP_LINES_PER_SEC` for two samples and the cooldown (`LEDGER_SHARD_COOLDOWN_MS`, persisted as `gl_accounts.shard_scaled_at`) has passed. The new width aims at half the threshold per shard, grows at most 4x per step and stops at `LEDGER_SHARD_MAX_WIDTH`. A wallet whose shard 0 is the only hot shard (debit-bound) is not widened. By default it widens the account through `applyShardWidth` and audits `GL_ACCOUNT_SHARDS_SCALED`; with `LEDGER_SHARD_SCALER_DRY_RUN=true` it only audits `GL_ACCOUNT_SHARDS_SCALE_PROPOSED` once per proposed width and changes nothing. Calibrate `LEDGER_SHARD_UP_LINES_PER_SEC` on the target hardware.
- **`applyShardWidth`** (`engine/ledger/shardScaling.ts`) is the one operation both the worker and `POST /finance/gl-accounts/:id/shards/scale` (`finance:write`, reason) use: in one transaction it takes `FOR NO KEY UPDATE` on the account row (which does not conflict with the FK `KEY SHARE` of postings), updates `shard_count`/`shard_scaled_at`, creates missing shard rows and writes the audit row `GL_ACCOUNT_SHARDS_SCALED`. Narrowing only changes where new lines go; existing shards keep their balances, sequences and checkpoints.

### 3.11 Query and indexing rules for the ledger tables

Every new query that touches the ledger must obey four rules, so its cost stays independent of the historical table size (the query/index optimisation plan `design/02-storage-and-performance/ledger_scaling_partition_pruning_and_archive_anchor_plan.md`; regression suite `test/storage-engine/performance/ledger-query-pruning-and-accuracy.test.ts`):

1. **Always bound `created_at` when querying `journal_lines` by `entry_id`.** `journal_lines` is monthly range-partitioned by `created_at`, so `WHERE entry_id = $1` alone probes every monthly partition. A line is inserted in the same transaction as its parent `JournalEntry`, so bound the lookup with the parent entry's timestamp (`createdAt: { gte: entry.createdAt - 5m, lte: entry.createdAt + 5m }`). Bound by the ENTRY, never by an older business object: a `COMMISSION_NETTING` entry or a delayed AML capture entry can be posted days after its `PaymentAttempt`.
2. **Never scan `journal_lines` for a live account balance.** Live balances are the `gl_account_shards` sum, read in O(shards) by `loadLiveAccountBalances()` or `lockWalletLedgerBalance()`. The full-history scans in `CheckpointService`, `ShardRepair` and the restore drill are deliberate proofs of the journal, not balance reads.
3. **Compute filtered statement counts and sums in one covering `groupBy`.** Use `groupBy({ by: ["direction"], where, _count: { _all: true }, _sum: { amount: true } })` over the exact `where` of the page query, so PostgreSQL satisfies the count and both side sums in one Index-Only Scan of `journal_lines_account_id_cov_idx`. Do not add a separate `count()` for the same predicate.
4. **Preserve the covering payloads and the Visibility Map autovacuum settings.** Any migration that recreates the `journal_lines` indexes must keep `INCLUDE ("gl_account_id", "direction", "amount", "id")` on `journal_lines_entry_id_created_at_idx` and `INCLUDE ("direction", "amount", "entry_id", "id")` on `journal_lines_account_id_cov_idx`. Every monthly partition must keep `autovacuum_vacuum_insert_scale_factor = 0.01` (and `autovacuum_vacuum_insert_threshold = 1000`), because an append-only table is never vacuumed by the update/delete thresholds and PostgreSQL 18 needs the insert autovacuum to set the Visibility Map bits that Index-Only Scans require. `journal_entries` carries `journal_entries_created_at_idx` (INCLUDE `id, ref_type, ref_id`) for pagination/summary and `journal_entries_trgm_search_idx` for the admin search.

## 4. Contracts and invariants

1. Every journal entry must have at least one debit and one credit, debit total must equal credit total, and every line amount must be strictly positive. `validateTemplate` enforces this before insertion (`LedgerPoster.ts:740`).
2. `(refType, refId)` is unique. Posting is idempotent for that pair. A duplicate returns the existing entry with `created: false`, `idempotent: true`, and an empty `lines` array.
3. Money is `Decimal(18,4)`; no floating-point arithmetic is used in posting or validation.
4. Journal lines are append-only. The application exposes no update or delete path, and retention deliberately excludes `journal_entries` and `journal_lines`.
5. A zero optional leg is omitted rather than booked as a zero line (`optionalLine`, `LedgerPoster.ts:252`).
6. Account resolution never invents an account: a missing scoped account falls back only to the same type and currency, and then fails with `GL_ACCOUNT_NOT_FOUND`.
7. Shard projection and sequence reservation are in the same transaction as the journal line. A shard balance is the signed sum of every line posted to that shard; the natural balance negates credit-positive accounts. The sequence numbers of a shard are gapless.
8. A checkpoint is a verified `(balance, sequence)` pair of one shard, not a replacement for journal lines: `balance = previous checkpoint + the lines in the sequence range`, proven before it moves. Checkpointing never locks a shard or an account.
9. The invariant equation is the authoritative system-wide check. A non-zero drift is an operational incident and opens a P1 case.
10. Adjustment, refund, chargeback, cash-out, AML release/void, and suspense postings use the same ledger and the same idempotency contract.

## 5. Data / API / config / deployment surface

### Schema

- `GlAccount`: `accountType`, `ownerId`, `gatewayId`, `credentialSetId`, `env`, `currency`, `shardCount`, `shardScaledAt`, `seedKey`. The account stores no checkpoint; its checkpoint fields are derived from its shard checkpoints.
- `GlAccountShard`: composite primary key `(glAccountId, shardId)`, `currentBalance`, `lineSeq` (the shard's gapless high-water), `updatedAt`.
- `JournalEntry`: unique `(refType, refId)`; `JournalRefType` values are `PAYMENT_ATTEMPT`, `ADJUSTMENT`, `AML_RELEASE`, `AML_VOID`, `SETTLEMENT_SWEEP`, `FEE_VARIANCE`, `COMMISSION_NETTING`, `DISPUTE_OUTCOME`. `journal_entries_created_at_idx` (INCLUDE `id, ref_type, ref_id`) serves the admin list/summary; `journal_entries_trgm_search_idx` (GIN on `ref_id`, `description`) serves the admin search.
- `JournalLine`: `entryId`, `glAccountId`, `direction`, `amount`, `shardId`, `shardSeq`; primary key `(id, createdAt)` because the table is monthly range-partitioned; covering indexes `(entryId, createdAt) INCLUDE (glAccountId, direction, amount, id)` and `(glAccountId, createdAt) INCLUDE (direction, amount, entryId, id)`. The physical column order is UUIDs, timestamps, NUMERIC, the enum and the shard columns, so rows carry no alignment padding.
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
2. The `gl_accounts_create_shards` trigger creates the shard rows with the account; set `shard_count` (`initialShardWidth`) when creating it.
3. Add the currency to the seed and to any currency validation before accepting payments in it.
4. Verify a posting in that currency resolves every account type it uses; otherwise the confirmation fails with `GL_ACCOUNT_NOT_FOUND`.

### Investigating a balance

1. Open the GL account drawer (Ledger Audit & Invariant, Journal Entries, Wallets): the live balance is the sum of the shard rows; each shard shows its line sequence, pending lines and checkpoint.
2. A shard marked `PARITY` or `GAP` failed its proof: `PARITY` means its balance differs from checkpoint + journal lines (drift shown); `GAP` means the lines in its sequence range are missing or duplicated. Its checkpoint did not move and a P1 operator case `ledger.shard:<account>:<shard>` is open. Do not "fix" the balance by hand; escalate to Finance and engineering with the account and shard ids.
3. Run the invariant verifier. Non-zero drift means the system-wide equation is off.
4. Use **Repair** on the failed shard (GL account drawer): it previews the correction computed from the journal. An intact sequence is recomputed immediately (or automatically after repeated failures); a damaged sequence is submitted to Approvals as a re-baseline. "Run checkpoint rollup" re-verifies the account afterwards. A money error found this way is corrected through the Adjustments flow, never by editing a shard.

## 7. Status and deviations

### Implemented

- 11 GL account types and currency-scoped system-account seeding.
- 17 scenario builders and strict payment-confirmation builder.
- Balanced-template validation, positive line validation, idempotent posting.
- Account resolution with scoped and platform-wide fallback.
- Sequenced shard writer: per-account routing width, gapless per-shard sequence, wallet debits pinned to shard 0.
- Per-shard verified checkpoints, automatic checkpoint worker, manual "checkpoint now".
- Hot-account detection and automatic widening (live by default) plus an audited manual width override.
- O(shards) invariant check every 60 s and an on-demand verifier.
- Suspense routing and AML hold/release/void posting.
- Adjustment, refund, chargeback, cash-out, settlement sweep, and fee-variance postings.

### Partial

- **Failure handling** — a failed shard is detected, alerted, held at its last good checkpoint and repaired from the journal (automatically for a persistent PARITY with an intact sequence, manually otherwise; section 3.10). A re-baselined shard keeps a documented exemption (`baseline_seq`) for its damaged history.
- **Scaler calibration** — the scaler is live by default but its thresholds are defaults chosen from a local benchmark (about 1,000 postings/s on one shard with a 1 ms transaction); real transactions hold the shard lock longer, so watch the `GL_ACCOUNT_SHARDS_SCALED` audit rows on the target hardware and tune `LEDGER_SHARD_UP_LINES_PER_SEC` (or set `LEDGER_SHARD_SCALER_DRY_RUN=true` to observe without widening).
- **Scenario coverage** — some scenarios are exercised mainly by template tests (`PLATFORM_HELD_*`, `PAYER_SURCHARGE`, `SPLIT`, `MERCHANT_DIRECT` netting) rather than by every runtime path.
- **Database enforcement** — only the positive-amount check, the shard-sequence guard and the approval maker/checker constraint are in PostgreSQL; journal balance is application-level.

### Missing / deferred

- No database trigger or deferred constraint that rejects an unbalanced journal entry.
- No automatic scale-down of shard widths.
- No checkpoint history table (the audit rows and the checkpoint row's status columns are the record).
- No support for currencies beyond the seeded `LYD`, `USD`, `EUR` without manual seeding.

### Known bugs / risks

- **Code gap:** idempotent replay of the same `(refType, refId)` with a different template silently returns the first entry; it does not compare the line set or amounts. A caller that reuses a reference for a different economic event loses the second posting.
- **Risk:** the single-hot-shard write path is about 25-30% slower than before the sequence was added (benchmark 2026-11-07: p50 1.4 ms to 1.8 ms single-threaded; about 1,000 to 750 postings/s on one shard) because the sequence is reserved under the shard lock before the lines are inserted and a fifth index exists on `journal_lines`. That is the case the shard scaler relieves.
- **Documentation gap:** `core-back/test/engine/ledger.test.ts` describes “all 16 journal entry templates”; the exhaustive matrix header says “15” and asserts 20 labels. The canonical count is 17 scenarios / 21 staged variants.
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
- `test/refund-merchant-direct.test.ts` — a merchant-direct refund reverses only commission (no wallet debit, no treasury credit), posts nothing without a commission, keeps `FULL_REFUND` for platform-cleared payments, `refundScenarioFor`, the rail-engine refund path, and the per-merchant commission-receivable balance after a reversal.
- `test/exhaustive/02-ledger/all-15-templates-matrix.test.ts` — 21 labels × 3 currencies × 5 amount tiers × 4 fee configurations = 1,260 template constructions.
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

- 2026-11-09 — Ledger query/index optimisation: `journal_entries(created_at)` and trigram search indexes, covering `journal_lines` entry/account indexes, insert-autovacuum tuning for append-only partitions, partition-pruned entry/AML lookups, single-pass statement totals, and the checkout commission-receivable short-circuit plus a `je.created_at`-bounded aggregation. See `TRACKER.md` and section 3.11.
- 2026-11-03 — Baseline verification against `5a24f6f+working-tree`: documented the 17 scenarios, 11 account types, shard writer, checkpoint and verifier behavior, balance-read differences, and the missing database balance enforcement.

## 11. Security hardening (2026-11-05)

- **Commission math.** `buildBreakdown` rounds the commission once, honouring the commission profile's `roundingMode` (`HALF_UP` default, `HALF_EVEN`, `HALF_DOWN`, `UP`, `DOWN`, `CEILING`, `FLOOR`; 4 decimal places). Net, payer share and surcharge are derived by exact subtraction so journals balance. The gateway fee and refund split are each rounded once, explicitly.
- **Cash-out ledger rules.** Approval journals use the cash-out id as `refId`. Balance is verified under a `FOR UPDATE` lock on the wallet's shards (`lib/cashoutBalance.ts`); `lockGlAccountShardsSorted` orders shards by byte order to keep lock ordering deterministic.
- **Checkpoint is transactional on the DB clock, with shard parity (GAP-011, RESOLVED 2026-11-05).** `CheckpointService.captureCheckpoint` runs the account row lock (`SELECT ... FOR UPDATE`), the snapshot sum, the parity check and the `gl_accounts` write in ONE database transaction (`$transaction`, 30 s timeout; a narrow test double without `$transaction` runs the same steps directly). When the caller passes no `asOf`, the checkpoint instant is the database clock (`clock_timestamp()` read after the lock is held), never the application clock, because journal lines carry database timestamps and a skewed node could otherwise include or skip lines at the boundary. The shard parity check compares, per account that has `gl_account_shards` rows, the shard total with `checkpoint_balance` plus the journal lines after `checkpoint_at`, in ONE SQL statement (one snapshot, so a concurrent posting cannot cause a false mismatch). `CheckpointServiceOptions.parity` is `enforce` (default: the capture throws `ShardParityError`, code `LEDGER_SHARD_PARITY_MISMATCH`), `warn` (captures and reports through `onParityMismatch`) or `off`. `CheckpointService.verifyShardParity(accountIds?)` and the exported `checkShardParity` run the read-only check and return the mismatches without throwing. The service is still not scheduled by the production runtime and there is no checkpoint history table (see the frontmatter gaps).
- **Append-only ledger and audit trail (GAP-013, RESOLVED 2026-11-05).** Migration `20261105090000_append_only_ledger_guards` installs `BEFORE UPDATE OR DELETE` row triggers and `BEFORE TRUNCATE` statement triggers on `journal_entries`, `journal_lines` (the parent and every partition; row triggers are cloned to future partitions, TRUNCATE triggers are installed on each existing partition) and `audit_log`. They raise `55000` for any caller, including the table owner. Two narrow bypasses exist: (1) maintenance, a transaction that sets `pgw.ledger_maintenance = 'on'` AND whose session user is a superuser or a member of the role `pgw_ledger_maintenance` (the application role is not a member); (2) retention, `DELETE` on `audit_log` only, in a transaction that sets `pgw.audit_retention = 'on'` (the `RetentionWorker` purge; the journal is never purged by retention). The migration also creates, best effort (a managed PostgreSQL may forbid `CREATE ROLE`; it then emits a notice and the roles must be provisioned manually), the NOLOGIN roles `pgw_ledger_maintenance` and the non-owner application role `pgw_app`, grants `pgw_app` the DML it needs and revokes `UPDATE`/`DELETE`/`TRUNCATE` on the journal tables and `UPDATE`/`TRUNCATE` on `audit_log` from it (`audit_log` keeps `DELETE` for the retention purge, still gated by the trigger). REVOKE alone does nothing against the table owner, which is why the triggers exist. **Production must connect as `pgw_app` (or another non-owner member of it), never as the owner that ran the migrations**; migrations still run as the owner. Test fixtures open the maintenance bypass through `core-back/test/helpers/ledgerMaintenance.ts`.
- **Tests.** `core-back/test/security-regressions/{h7-rounding,h4-cashout}` and `core-back/test/hardening-gap-regressions.test.ts` (checkpoint, parity, append-only guards). True concurrency needs PostgreSQL 18 and is not covered.

## Remediation round 2 (2026-11-08): raw-SQL posting path and throughput measurements

`LedgerPoster` has an opt-in raw-SQL write path (`LedgerPosterOptions.rawSql`), on in production through `createLedgerPoster` (`LEDGER_RAW_SQL=false` is the kill switch). It produces the same rows as the ORM path:

- the entry is inserted with `INSERT ... ON CONFLICT (ref_type, ref_id) DO NOTHING RETURNING` (an idempotent replay reads the existing entry back and moves nothing);
- accounts are resolved with one typed `SELECT`, and the lines are inserted with application-generated UUIDv7 ids by one `INSERT ... SELECT ... FROM unnest(...)`, together with the per-shard `shard_seq` bookkeeping from the shard writer, all inside the one transaction;
- a most-specific (scoped) account resolution is cached per poster for 60 s (max 20,000 entries): a more specific account can never appear later and ties resolve to the lowest id. A platform-wide fallback resolution is never cached, so a wallet created afterwards takes over at once; `clearAccountCache()` and `accountCacheTtlMs: 0` disable it.

Measured on the test host (single Bun process, local PostgreSQL 18, 16 shards): sequential posting 255 -> 628 posts/s (p50 3.83 -> 1.50 ms, about 4.2 statements per posting); eight concurrent workers 582-641 -> about 2,085 posts/s. Widening shards did not help: the limit is client-side ORM/CPU work in one process. **15,000 TPS is therefore not reachable on one core process; it needs horizontal scale (several core instances over the same database) and further hot-row work (treasury/income shard locks held through commit, a faster shard scaler), which remain open (GAP-063).**

Tests: `core-back/test/ledger-raw-sql-parity.test.ts` (same entries, lines, balances and gapless shard sequences as the ORM path for five templates; returned records match storage; idempotent replay in both modes; whole-posting rollback when the shard writer fails; cache semantics).

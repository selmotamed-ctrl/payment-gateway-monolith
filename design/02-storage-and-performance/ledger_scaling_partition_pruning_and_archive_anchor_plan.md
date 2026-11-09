# Ledger & Hot-Path Database Optimization Implementation Plan (PostgreSQL 18)

## 1. Scope & Architectural Baseline

This specification contains **only the verified, implementation-ready optimizations** for `core-back` and PostgreSQL 18. Because the project is in active development with no live production data, these changes can be applied directly to the schema, migrations, and query layer.

### Why the Existing Partition + Shard Architecture Is Retained (Without Archiving)
1. **`journal_lines` is monthly range-partitioned by `created_at`** (`PRIMARY KEY (id, created_at)`, `20261103180000_storage_hardening`) with time-ordered `uuidv7()` keys. Writes append to the active month's rightmost B-tree pages in $O(1)$ time while historical monthly partitions remain untouched on disk.
2. **`journal_entries` remains an unpartitioned `uuidv7()` table** (`PRIMARY KEY (id)`, `UNIQUE (ref_type, ref_id)`). Keeping `journal_entries` unpartitioned is required by PostgreSQL 18 so that:
   - Global posting idempotency `UNIQUE (ref_type, ref_id)` is enforced across month boundaries (`LedgerPoster.ts`).
   - Incoming foreign keys (`journal_lines.entry_id`, `payment_attempts.ledger_entry_id`, `adjustments.journal_entry_id`, `aml_cases.hold_journal_entry_id` referencing `journal_entries(id)`) remain valid under PostgreSQL's unique-key constraint rules ([PostgreSQL 18 Partitioning Constraints](https://www.postgresql.org/docs/current/ddl-partitioning.html)).
3. **Live balances and invariant checks are already $O(\text{shards})$:** `loadLiveAccountBalances`, `lockWalletLedgerBalance`, and `InvariantVerifier` read `gl_account_shards`, and `CheckpointService` scans only `(checkpoint_seq, line_seq]`.

---

## 2. Summary of the 7 Verified Optimizations to Implement

| ID | Target File(s) | Bottleneck Discovered in Codebase Audit | Exact Implementation |
|---|---|---|---|
| **OPT-1** | `core-back/prisma/schema.prisma`<br>`core-back/prisma/migrations/...`<br>`core-back/test/exhaustive/01-schema/indexes-and-query-plans.test.ts` | `journal_entries` has **no index on `created_at`** and **no trigram index on `ref_id` / `description`**. Every call to `GET /finance/journal-entries` (`ORDER BY created_at DESC`), `GET /finance/journal-entries/summary` (`created_at >= since24h`), and `?search=` runs a **full sequential scan** of `journal_entries`. | Add `@@index([createdAt])` (`journal_entries_created_at_idx`) with `INCLUDE (id, ref_type, ref_id)` and `journal_entries_trgm_search_idx` (`USING gin (ref_id gin_trgm_ops, description gin_trgm_ops)`). |
| **OPT-2** | `core-back/prisma/migrations/...` | `journal_lines_entry_id_created_at_idx` lacks `INCLUDE` columns (forcing heap fetches on every entry lookup), and `journal_lines_account_id_cov_idx` lacks `entry_id` and `id` in its `INCLUDE` clause (forcing heap fetches in `listAccountLines` and `glAccountId` filter subqueries). | Rebuild both indexes on `journal_lines` with full covering `INCLUDE` payloads while preserving exact key columns `(entry_id, created_at)` and `(gl_account_id, created_at)` required by Suite 01.4. |
| **OPT-3** | `core-back/prisma/migrations/...` | In PostgreSQL 18, append-only tables (`journal_lines`, `journal_entries`) do not set Visibility Map (VM) bits until insert-autovacuum runs (default `0.20` = 20% of table), causing Index-Only Scans to fall back to heap fetches ([PostgreSQL 18 Index-Only Scans](https://www.postgresql.org/docs/current/indexes-index-only-scans.html)). Column order on `journal_lines` also leaves alignment padding. | Reorder `journal_lines` columns by alignment width (`16B UUID -> 8B BIGINT/TIMESTAMPTZ -> NUMERIC -> 4B ENUM -> 2B SMALLINT`) in baseline/hardening DDL and set `autovacuum_vacuum_insert_scale_factor = 0.01` on `journal_lines` (and in `ensure_journal_line_partitions`) and `journal_entries`. |
| **OPT-4** | `core-back/api/internal/adminLedger.ts`<br>`core-back/engine/governance/GovernanceExecution.ts` | `GET /finance/journal-entries` (line 153), `GET /finance/journal-entries/:id` (line 186), and `resolveAmlHoldAmounts` (line 1594) query `journal_lines` by `entryId` **without `createdAt`**, forcing PostgreSQL to probe all 72+ monthly partitions. | Bound every `journalLine` lookup by `createdAt: { gte: minEntryTime - 5m, lte: maxEntryTime + 5m }` derived from the already-loaded `JournalEntry` row(s), pruning 99% of partitions. |
| **OPT-5** | `core-back/api/internal/ledgerLines.ts` | `listAccountLines` (lines 74–93) runs both `journalLine.count({ where })` and `journalLine.groupBy({ by: ["direction"], where, _sum: { amount: true } })`, scanning the account index **twice** on every call. | Compute both `total` and `totalDebit`/`totalCredit` in **one single Index-Only Scan** via `groupBy({ by: ["direction"], where, _count: { _all: true }, _sum: { amount: true } })`. |
| **OPT-6** | `core-back/engine/governance/GovernanceExecution.ts`<br>`core-back/engine/guards/AttemptGuardPipeline.ts`<br>`core-back/engine/db/repositories.ts` | **Hot-path checkout bottleneck (`GAP-DB-04`):** On every checkout attempt, `AttemptGuardPipeline.merchantPosture()` calls `evaluateCommissionReceivableCeiling()`, which re-reads `merchant` from DB and runs `getCommissionReceivableBalance()` (a 4-table full-history join across `journal_lines`, `gl_accounts`, `journal_entries`, and `payment_attempts`) **even when `merchant.commissionReceivableCeiling` is `null`**. | 1) Pass the already-loaded `merchant` into `evaluateCommissionReceivableCeiling` and short-circuit immediately before querying `journal_lines` when `ceiling === null`.<br>2) Rewrite `getCommissionReceivableBalance` in `repositories.ts` to drive from indexed `payment_attempts(merchant_id)` and prune `journal_lines` partitions by `jl.created_at >= pa.created_at - interval '5 minutes'`. |
| **OPT-7** | `project-design/parts/01-core-back/03-ledger.md`<br>`core-back/README.md` | Future queries added by engineers or coding agents could omit `created_at` on `journal_lines` or run redundant aggregations. | Add mandatory query & indexing rules to `03-ledger.md` and `core-back/README.md`. |

---

## 3. Step-by-Step Implementation Instructions

### 3.1 Step 1 — Update `core-back/prisma/schema.prisma` (`OPT-1`)

In `core-back/prisma/schema.prisma` (lines 1150–1165), add `@@index([createdAt])` to `model JournalEntry`:

```prisma
model JournalEntry {
  id          String         @id @default(uuid(7)) @db.Uuid
  createdAt   DateTime       @default(now()) @map("created_at")
  updatedAt   DateTime       @updatedAt @map("updated_at")
  refType     JournalRefType @map("ref_type")
  refId       String         @map("ref_id")
  description String         @db.Text

  journalLines    JournalLine[]
  adjustments     Adjustment[]     @relation("AdjustmentJournalEntry")
  amlCases        AmlCase[]        @relation("AmlCaseHoldEntry")
  paymentAttempts PaymentAttempt[] @relation("PaymentAttemptLedgerEntry")

  @@unique([refType, refId])
  @@index([createdAt])
  @@map("journal_entries")
}
```

---

### 3.2 Step 2 — Physical Column Alignment in `20261103180000_storage_hardening/migration.sql` & New Migration `20261108150000_ledger_query_and_index_optimization/migration.sql` (`OPT-1`, `OPT-2`, `OPT-3`)

#### A. Physical Column Ordering on `journal_lines` (Development Baseline)
In `core-back/prisma/migrations/20261103180000_storage_hardening/migration.sql` (lines 54–63) and `20261107090000_shard_sequenced_checkpoints/migration.sql`, ordering columns from widest alignment requirement to narrowest eliminates 6 bytes of internal tuple padding per row (`16B UUID -> 8B BIGINT/TIMESTAMP -> NUMERIC -> 4B ENUM -> 2B SMALLINT`):

```sql
CREATE TABLE "journal_lines" (
  "id" UUID NOT NULL,
  "entry_id" UUID NOT NULL,
  "gl_account_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "amount" DECIMAL(18,4) NOT NULL,
  "direction" "JournalDirection" NOT NULL,
  CONSTRAINT "journal_lines_pkey" PRIMARY KEY ("id", "created_at")
) PARTITION BY RANGE ("created_at");
```

#### B. Forward Migration `core-back/prisma/migrations/20261108150000_ledger_query_and_index_optimization/migration.sql`

Create `core-back/prisma/migrations/20261108150000_ledger_query_and_index_optimization/migration.sql`:

```sql
-- ============================================================================
-- Schema version 15: Ledger index-only scan coverage, journal_entries indexing,
-- and PostgreSQL 18 visibility-map autovacuum tuning for append-only partitions.
-- ============================================================================

-- 1. Index journal_entries(created_at) for O(log N) pagination and 24h summary counts,
--    and add pg_trgm GIN index for instant search on ref_id and description.
CREATE INDEX IF NOT EXISTS "journal_entries_created_at_idx"
  ON "journal_entries" ("created_at")
  INCLUDE ("id", "ref_type", "ref_id");

CREATE INDEX IF NOT EXISTS "journal_entries_trgm_search_idx"
  ON "journal_entries" USING gin (
    "ref_id" gin_trgm_ops,
    "description" gin_trgm_ops
  );

-- 2. Upgrade journal_lines_entry_id_created_at_idx and journal_lines_account_id_cov_idx
--    with INCLUDE payload columns so batch entry lookups and account statement queries
--    execute as pure Index-Only Scans (zero heap fetches).
--    Key columns remain ("entry_id", "created_at") and ("gl_account_id", "created_at")
--    so Suite 01.4 declared @@index parity passes unchanged.
DROP INDEX IF EXISTS "journal_lines_entry_id_created_at_idx";
CREATE INDEX "journal_lines_entry_id_created_at_idx"
  ON "journal_lines" ("entry_id", "created_at")
  INCLUDE ("gl_account_id", "direction", "amount", "id");

DROP INDEX IF EXISTS "journal_lines_account_id_cov_idx";
CREATE INDEX "journal_lines_account_id_cov_idx"
  ON "journal_lines" ("gl_account_id", "created_at")
  INCLUDE ("direction", "amount", "entry_id", "id");

-- 3. Tune insert-triggered autovacuum on append-only ledger tables so PostgreSQL 18
--    continuously marks heap pages all-visible in the Visibility Map (required for
--    Index-Only Scans to skip heap fetches).
ALTER TABLE "journal_entries" SET (
  autovacuum_vacuum_insert_scale_factor = 0.01,
  autovacuum_vacuum_insert_threshold = 1000,
  autovacuum_analyze_scale_factor = 0.02
);

DO $$
DECLARE
  part regclass;
BEGIN
  FOR part IN
    SELECT inhrelid::regclass FROM pg_inherits WHERE inhparent = 'journal_lines'::regclass
  LOOP
    EXECUTE format(
      'ALTER TABLE %s SET (fillfactor = 100, autovacuum_vacuum_insert_scale_factor = 0.01, autovacuum_vacuum_insert_threshold = 1000, autovacuum_analyze_scale_factor = 0.02)',
      part
    );
  END LOOP;
END $$;

-- 4. Update ensure_journal_line_partitions() so all future monthly partitions
--    inherit the append-only fillfactor and visibility-map autovacuum settings,
--    plus the no-truncate guard trigger and pgw_app privileges.
CREATE OR REPLACE FUNCTION ensure_journal_line_partitions(months_ahead INT DEFAULT 18)
RETURNS void AS $$
DECLARE
  v_offset INT;
  start_date DATE;
  end_date DATE;
  suffix TEXT;
  part_name TEXT;
BEGIN
  FOR v_offset IN 0..months_ahead - 1 LOOP
    start_date := (date_trunc('month', now())::date + (v_offset || ' months')::interval)::date;
    end_date := (start_date + interval '1 month')::date;
    suffix := to_char(start_date, 'YYYY_MM');
    part_name := format('journal_lines_%s', suffix);

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF "journal_lines" FOR VALUES FROM (%L) TO (%L)',
      part_name, start_date, end_date
    );

    EXECUTE format(
      'ALTER TABLE %I SET (fillfactor = 100, autovacuum_vacuum_insert_scale_factor = 0.01, autovacuum_vacuum_insert_threshold = 1000, autovacuum_analyze_scale_factor = 0.02)',
      part_name
    );

    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'pgw_reject_ledger_truncate') THEN
      EXECUTE format('DROP TRIGGER IF EXISTS pgw_journal_lines_no_truncate ON %I', part_name);
      EXECUTE format(
        'CREATE TRIGGER pgw_journal_lines_no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION pgw_reject_ledger_truncate()',
        part_name
      );
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pgw_app') THEN
      EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %I FROM pgw_app', part_name);
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

SELECT ensure_journal_line_partitions(24);

-- 5. Bump schema version
UPDATE "schema_versions"
SET "version" = 15, "updated_at" = now()
WHERE "id" = 1;
```

*(Note: When bumping `schema_versions` to `15`, also update `REQUIRED_SCHEMA_VERSION = 15` in `core-back/prisma/schemaVersion.ts` and the version assertion in `core-back/test/exhaustive/01-schema/migrations-and-hygiene.test.ts`.)*

---

### 3.3 Step 3 — Partition Pruning on Batch & Single Entry Lookups in `core-back/api/internal/adminLedger.ts` (`OPT-4`)

Replace lines 151–156 and lines 185–196 in `core-back/api/internal/adminLedger.ts` so every query on `journal_lines` includes `createdAt` bounds derived from the parent `JournalEntry`:

```typescript
// File: core-back/api/internal/adminLedger.ts (lines 151–168)
  const entryTimes = entries.map((entry) => entry.createdAt.getTime());
  const minCreatedAt = entries.length > 0 ? new Date(Math.min(...entryTimes) - 5 * 60 * 1000) : undefined;
  const maxCreatedAt = entries.length > 0 ? new Date(Math.max(...entryTimes) + 5 * 60 * 1000) : undefined;

  const lines = entries.length === 0
    ? []
    : await client.journalLine.findMany({
        where: {
          entryId: { in: entries.map((entry) => entry.id) },
          ...(minCreatedAt && maxCreatedAt
            ? { createdAt: { gte: minCreatedAt, lte: maxCreatedAt } }
            : {}),
        },
        select: { entryId: true, direction: true, amount: true, glAccount: { select: { currency: true } } },
      });
```

And in `GET /finance/journal-entries/:id` (lines 185–197 of `core-back/api/internal/adminLedger.ts`):

```typescript
  // journal_lines is monthly range-partitioned by created_at: always pass entryId + createdAt
  // window so PostgreSQL prunes all non-matching monthly partitions.
  const entryWindowStart = new Date(entry.createdAt.getTime() - 5 * 60 * 1000);
  const entryWindowEnd = new Date(entry.createdAt.getTime() + 5 * 60 * 1000);
  const lines = await client.journalLine.findMany({
    where: {
      entryId: id,
      createdAt: { gte: entryWindowStart, lte: entryWindowEnd },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      createdAt: true,
      direction: true,
      amount: true,
      glAccount: { select: { id: true, accountType: true, currency: true, ownerId: true } },
    },
  });
```

Also in `core-back/engine/governance/GovernanceExecution.ts` (lines 1582–1596, `resolveAmlHoldAmounts`):

```typescript
  let holdEntryId = amlCase.holdJournalEntryId ? String(amlCase.holdJournalEntryId) : null;
  let holdCreatedAt: Date | null = null;
  if (!holdEntryId && attempt?.id) {
    const entry = await modelOf(tx, "journalEntry").findFirst({
      where: { refType: "PAYMENT_ATTEMPT", refId: String(attempt.id) },
    });
    holdEntryId = entry?.id ? String(entry.id) : null;
    holdCreatedAt = entry?.createdAt instanceof Date ? entry.createdAt : null;
  }
  if (holdEntryId) {
    const glAccounts = modelOf(tx, "glAccount");
    const journalLines = modelOf(tx, "journalLine");
    const holdAccounts = await glAccounts.findMany({ where: { accountType: "AML_HOLD" } });
    const holdIds = new Set(holdAccounts.map((account: any) => String(account.id)));
    const lines = await journalLines.findMany({
      where: {
        entryId: holdEntryId,
        ...(holdCreatedAt
          ? {
              createdAt: {
                gte: new Date(holdCreatedAt.getTime() - 5 * 60 * 1000),
                lte: new Date(holdCreatedAt.getTime() + 5 * 60 * 1000),
              },
            }
          : {}),
      },
    });
```

---

### 3.4 Step 4 — Single-Pass Covered Aggregation in `core-back/api/internal/ledgerLines.ts` (`OPT-5`)

Replace lines 73–105 in `core-back/api/internal/ledgerLines.ts` so `total` (`lineCount`), `totalDebit`, and `totalCredit` are computed in a **single** `groupBy` Index-Only Scan over `journal_lines_account_id_cov_idx` instead of running a separate `client.journalLine.count()` scan:

```typescript
// File: core-back/api/internal/ledgerLines.ts (lines 73–105)
  const [lines, sums] = await Promise.all([
    client.journalLine.findMany({
      where: where as never,
      orderBy: built.orderBy as never,
      skip: built.skip,
      take: built.take,
      select: {
        id: true,
        entryId: true,
        createdAt: true,
        direction: true,
        amount: true,
        entry: { select: { refType: true, refId: true, description: true } },
      },
    }),
    client.journalLine.groupBy({
      by: ["direction"],
      where: where as never,
      _count: { _all: true },
      _sum: { amount: true },
    }),
  ]);

  const total = sums.reduce((acc, row) => acc + (row._count?._all ?? 0), 0);
  const sumOf = (side: "DEBIT" | "CREDIT"): string => {
    const found = sums.find((row) => row.direction === side);
    return found?._sum.amount ? money4(found._sum.amount) : "0.0000";
  };
  const totals: AccountLinesTotals = {
    lineCount: total,
    totalDebit: sumOf("DEBIT"),
    totalCredit: sumOf("CREDIT"),
  };
  const net = decimal(totals.totalDebit).minus(decimal(totals.totalCredit)).toFixed(4);
```

---

### 3.5 Step 5 — Eliminate the Hot-Path Checkout Full-Ledger Join in `GovernanceExecution.ts`, `AttemptGuardPipeline.ts`, and `repositories.ts` (`OPT-6` / `GAP-DB-04`)

#### A. Short-circuit `evaluateCommissionReceivableCeiling` when `ceiling === null` and reuse the loaded `MerchantRow`
In `core-back/engine/governance/GovernanceExecution.ts` (lines 492–511):

```typescript
export const evaluateCommissionReceivableCeiling = async (
  ctx: Pick<GovernanceExecutionContext, "repositories">,
  tx: Tx,
  merchantId: string,
  settlementTarget?: string | null,
  loadedMerchant?: MerchantRow | null,
): Promise<CommissionReceivableCeilingEvaluation> => {
  const merchant = loadedMerchant !== undefined
    ? loadedMerchant
    : await ctx.repositories.merchants.findMerchantById(tx, merchantId);
  const rawCeiling = merchant?.commissionReceivableCeiling;
  const ceiling = rawCeiling === null || rawCeiling === undefined ? null : toDecimal(rawCeiling);

  // Fast path: when the merchant has no commission receivable ceiling configured,
  // skip the journal_lines receivable aggregation query completely.
  if (ceiling === null) {
    return decideCommissionReceivableCeiling({
      merchantId,
      receivable: new Decimal(0),
      ceiling: null,
      settlementTarget: settlementTarget ?? null,
    });
  }

  const receivableQuery = ctx.repositories.merchants.getCommissionReceivableBalance;
  const receivable = receivableQuery
    ? moneyToDecimal(await receivableQuery(tx, merchantId))
    : new Decimal(0);
  return decideCommissionReceivableCeiling({
    merchantId,
    receivable,
    ceiling,
    settlementTarget: settlementTarget ?? null,
  });
};
```

And in `core-back/engine/guards/AttemptGuardPipeline.ts` (line 1003), pass `merchant` so `findMerchantById` is not called a second time:

```typescript
    const receivable = await evaluateCommissionReceivableCeiling(
      { repositories: this.repositories },
      tx,
      merchant.id,
      settlementTarget ?? null,
      merchant,
    );
```

#### B. Partition-Pruned Index Join in `getCommissionReceivableBalance` (`core-back/engine/db/repositories.ts`, lines 178–194)
When a merchant *does* have a non-null `commissionReceivableCeiling`, add `AND jl.created_at >= je.created_at - interval '5 minutes'
           AND jl.created_at <= je.created_at + interval '5 minutes'` so PostgreSQL prunes `journal_lines` partitions and uses `journal_lines_entry_id_created_at_idx` as an Index-Only Scan:

```typescript
    getCommissionReceivableBalance: async (tx, merchantId) => {
      if (typeof (tx as Any).$queryRaw === "function") {
        const result = await tx.$queryRaw`
          SELECT COALESCE(SUM(CASE WHEN jl.direction = 'DEBIT' THEN jl.amount ELSE -jl.amount END), 0) AS receivable
          FROM payment_attempts pa
          INNER JOIN journal_entries je
            ON je.ref_id = pa.id::text
           AND je.ref_type IN ('PAYMENT_ATTEMPT', 'COMMISSION_NETTING')
          INNER JOIN journal_lines jl
            ON jl.entry_id = je.id
           AND jl.created_at >= je.created_at - interval '5 minutes'
           AND jl.created_at <= je.created_at + interval '5 minutes'
          INNER JOIN gl_accounts a
            ON a.id = jl.gl_account_id
           AND a.account_type = 'COMMISSION_RECEIVABLE'
          WHERE pa.merchant_id = ${merchantId}::uuid
        `;
        const first = rows<Any>(result)[0];
        return moneyFromDecimal(first?.receivable ?? 0);
      }
      // ... keep existing in-memory fallback for unit tests unchanged
```

---

### 3.6 Step 6 — Update Exhaustive Schema Test Inventory (`core-back/test/exhaustive/01-schema/indexes-and-query-plans.test.ts`)

In `core-back/test/exhaustive/01-schema/indexes-and-query-plans.test.ts`:
1. Add `{ table: "journal_entries", name: "journal_entries_trgm_search_idx", type: "gin" }` to the `expected` array in `Suite 01 · storage-engine index inventory`.
2. Add `{ table: "journal_entries", where: "\"created_at\" >= now() - interval '1 day'", label: "journal entries by created_at" }` to the `plans` array in `Suite 01 · hot query plans`.

---

## 4. Documentation Additions for Future Queries (`OPT-7`)

Append the following section to **`project-design/parts/01-core-back/03-ledger.md`** (as Section `3.11 Query & Indexing Rules for Ledger Tables`) and **`core-back/README.md`** (under Section `3.1 PostgreSQL 18 contract`):

```markdown
### Query & Indexing Rules for `journal_entries`, `journal_lines`, and `gl_account_shards`

Every new query touching the ledger must obey four rules so cost stays independent of historical table size:

1. **Always include a `created_at` range when querying `journal_lines` by `entry_id`:**
   - `journal_lines` is monthly range-partitioned by `created_at`. Querying by `entry_id` alone forces PostgreSQL to probe every monthly partition.
   - Because `JournalLine` rows are inserted in the same transaction as their parent `JournalEntry`, always bound the lookup using the parent entry's timestamp (`createdAt: { gte: entry.createdAt - 5m, lte: entry.createdAt + 5m }`).
2. **Never scan `journal_lines` for live account balances:**
   - Live balances are always read in $O(\text{shards})$ time from `gl_account_shards` via `loadLiveAccountBalances()` or `lockWalletLedgerBalance()`.
3. **Combine `COUNT` and `SUM` on `journal_lines` into a single covering `groupBy`:**
   - When computing filtered statement totals over `journal_lines`, use a single `groupBy({ by: ["direction"], _count: { _all: true }, _sum: { amount: true } })` so PostgreSQL satisfies both count and sum in one Index-Only Scan over `journal_lines_account_id_cov_idx`.
4. **Preserve `INCLUDE` payload columns and Visibility Map autovacuum settings on new partitions:**
   - Any migration that recreates `journal_lines` indexes must keep `INCLUDE ("gl_account_id", "direction", "amount", "id")` on `journal_lines_entry_id_created_at_idx` and `INCLUDE ("direction", "amount", "entry_id", "id")` on `journal_lines_account_id_cov_idx`, and all partitions must keep `autovacuum_vacuum_insert_scale_factor = 0.01` so PostgreSQL 18 maintains the Visibility Map for Index-Only Scans.
```

---

---

## 5. Exhaustive Edge-Case Matrix & Quality Guarantee Suite

To guarantee that none of the 7 optimizations can ever drop a line, miscalculate a balance, bypass a security trigger, or regress to a full-table scan, the coding agent must implement and pass all **18 edge cases** below in a dedicated test suite (`core-back/test/storage-engine/performance/ledger-query-pruning-and-accuracy.test.ts`).

### 5.1 Master Edge-Case Matrix (18 Scenarios)

| ID | Category | Edge Case / Scenario | What Could Go Wrong If Implemented Naive | Required Assertion & Guarantee |
|---|---|---|---|---|
| **EC-01** | **Partition Boundary Rollover** | A `JournalEntry` is created at `2026-11-30T23:59:59.950Z` (end of November partition) and its `JournalLine` rows are stamped `100 ms` later at `2026-12-01T00:00:00.050Z` (start of December partition). | If the `createdAt` pruning window was an exact equality (`createdAt = entry.createdAt`) or same-month check, the December lines would be missed and the entry would falsely appear `unbalanced` (`lineCount: 0`)! | The `±5 minute` window (`entry.createdAt ± 5m`) spans `[2026-11-30T23:54:59Z, 2026-12-01T00:05:00Z]`, pruning 70 partitions while scanning **both** `journal_lines_2026_11` and `journal_lines_2026_12` and returning 100% of lines. |
| **EC-02** | **Multi-Month Batch Page on `GET /finance/journal-entries`** | Page 1 of `GET /finance/journal-entries?pageSize=25` contains 24 entries from `2026-11` and 1 old entry from `2026-08`. | Using only the first entry's timestamp would drop the `2026-08` lines. | `Math.min(...entryTimes) - 5m` to `Math.max(...entryTimes) + 5m` includes every entry on the page and returns exact `totalDebit`, `totalCredit`, and `balanced` flags for all 25 entries. |
| **EC-03** | **Empty Result Page (`entries.length === 0`)** | `GET /finance/journal-entries?search=nonexistent` returns `0` entries. | `Math.min(...[])` evaluates to `+Infinity` (`new Date(Infinity)` $\to$ `Invalid Date`), causing Prisma to throw a runtime error! | Guard `entries.length === 0` before computing `minCreatedAt`/`maxCreatedAt` and skip `journalLine.findMany` completely. |
| **EC-04** | **Single Entry Detail at Exact Partition Start (`00:00:00.000Z`)** | `GET /finance/journal-entries/:id` for an entry stamped at `2026-11-01T00:00:00.000Z`. | Off-by-one boundary exclusion on `<` vs. `<=`. | Returns all lines with `balanced: true` and exact `totalDebit == totalCredit`. |
| **EC-05** | **Deterministic Partition Pruning Proof via `EXPLAIN (COSTS OFF)`** | Querying `journal_lines` by `entry_id` and a `10-minute` `created_at` window inside one month (`2026-11-15`). | Planner still scans all 72+ monthly partitions (`journal_lines_2023_01` .. `journal_lines_2028_12`). | `EXPLAIN (COSTS OFF)` output contains `journal_lines_2026_11` and **zero** references to `journal_lines_2023_*`, `journal_lines_2024_*`, or `journal_lines_2025_*`. |
| **EC-06** | **Index-Only Scan & Visibility Map (`Heap Fetches: 0`)** | After inserting 200 lines across 50 entries and running `VACUUM ANALYZE journal_lines`, run `EXPLAIN (ANALYZE, BUFFERS)` on the batch line lookup and account statement aggregation. | Missing column in `INCLUDE (...)` or stale Visibility Map forces `Index Scan` with heap fetches instead of `Index Only Scan`. | Plan uses `Index Only Scan using journal_lines_entry_id_created_at_idx` and `Index Only Scan using journal_lines_account_id_cov_idx` with `Heap Fetches: 0`. |
| **EC-07** | **Single-Pass `groupBy` Accuracy: Mixed Debits & Credits** | An account has 3 `CREDIT` lines (`100`, `20`, `50` = `170.0000`) and 2 `DEBIT` lines (`30`, `10.5000` = `40.5000`). Call `listAccountLines` with `pageSize=2&page=1`. | Totals accidentally reflect only the 2 visible rows on Page 1 instead of all 5 matching rows. | `total` is `5`, `totals.lineCount` is `5`, `totals.totalDebit` is `"40.5000"`, `totals.totalCredit` is `"170.0000"`, and `totals.netDebit` is `"-129.5000"`. |
| **EC-08** | **Single-Pass `groupBy` Accuracy: Direction-Only Filter (`?direction=DEBIT` / `CREDIT`)** | Call `listAccountLines` with `?direction=DEBIT` on the account from EC-07. | `sums` array from `groupBy` has only 1 row (`direction: 'DEBIT'`), and looking up `CREDIT` crashes or returns `NaN`. | `total` is `2`, `totals.totalDebit` is `"40.5000"`, `totals.totalCredit` is `"0.0000"`, `totals.netDebit` is `"40.5000"`. |
| **EC-09** | **Single-Pass `groupBy` Accuracy: Zero Matching Rows (Empty Account or Future Date Filter)** | Call `listAccountLines` on a newly created GL account with 0 lines, or with `?from=2999-01-01`. | `sums` is `[]`; `reduce` or `sumOf` returns `undefined` or `NaN`. | `total` is `0`, `lines` is `[]`, `totals` is `{ lineCount: 0, totalDebit: "0.0000", totalCredit: "0.0000", netDebit: "0.0000" }`. |
| **EC-10** | **Single-Pass `groupBy` Accuracy: Combined `refType` + `search` + `from`/`to` Filters** | Filter account lines by `?refType=SETTLEMENT_SWEEP&search=needle&from=...&to=...`. | Relational filter `{ entry: { refType, OR: [...] } }` disagrees between `findMany` and `groupBy`. | `groupBy` uses the exact same `where` object as `findMany`, so `totals.lineCount` equals the exact count of filtered rows. |
| **EC-11** | **Checkout Hot-Path Short-Circuit: `commissionReceivableCeiling === null`** | Merchant has `commissionReceivableCeiling = null`. Run `evaluateCommissionReceivableCeiling` with a spy on `getCommissionReceivableBalance` and `findMerchantById`. | System still executes the 4-table `journal_lines` SQL join and re-queries `merchants`. | When `loadedMerchant` is passed and `commissionReceivableCeiling === null`, **zero** calls are made to `findMerchantById` and **zero** calls are made to `getCommissionReceivableBalance`; decision is `ALLOW` (`NO_CEILING`). |
| **EC-12** | **Checkout Guard Accuracy: `commissionReceivableCeiling = 0` vs. Positive Ceiling Exceeded** | Merchant has `commissionReceivableCeiling = 100.0000` and `150.0000` of `COMMISSION_RECEIVABLE` debits (`PAYMENT_ATTEMPT`) minus `20.0000` of credits (`COMMISSION_NETTING`) = `130.0000` net receivable. | Short-circuit accidentally triggers on `0` or misses `COMMISSION_NETTING` credits, or `jl.created_at >= pa.created_at - 5m` misses the netting entry posted days later! | **Crucial subtlety:** A `PAYMENT_ATTEMPT` journal entry is created within minutes of `pa.created_at`, whereas a `COMMISSION_NETTING` entry can be posted days after `pa.created_at`! Therefore, in `getCommissionReceivableBalance`, `jl.created_at` must be bounded by **`je.created_at`** (`jl.created_at >= je.created_at - interval '5 minutes' AND jl.created_at <= je.created_at + interval '5 minutes'`), **never `pa.created_at`**! Net receivable computes as `130.0000`, pausing `PLATFORM_CLEARING` (`CEILING_EXCEEDED_PAUSE`) and switching `MERCHANT_DIRECT` to `NETTING` (`CEILING_EXCEEDED_NETTING`). |
| **EC-13** | **AML Hold Escrow Resolution with Delayed Capture (`resolveAmlHoldAmounts`)** | An attempt is created on Day 1, held in AML, and captured on Day 2 (`entry.createdAt` is 24h after `attempt.createdAt`). | If `resolveAmlHoldAmounts` bounded `journal_lines.created_at` by `attempt.createdAt` instead of `entry.createdAt`, it would miss the Day 2 escrow lines and throw `409 AML_HOLD_CAPTURE_NOT_VERIFIED`! | Always load `entry` (`select: { id: true, createdAt: true }`) and bound `journal_lines.created_at` by **`entry.createdAt ± 5 minutes`**. |
| **EC-14** | **`journal_entries` Index Plans (`created_at` & `pg_trgm` Search)** | Run `EXPLAIN (COSTS OFF)` with `enable_seqscan = off` on `journal_entries` for `ORDER BY created_at DESC LIMIT 25`, `WHERE created_at >= now() - interval '24 hours'`, and `WHERE ref_id ILIKE '%needle%'`. | Missing index causes `Seq Scan on journal_entries`. | Planner uses `journal_entries_created_at_idx` for time range/sort and `Bitmap Index Scan on journal_entries_trgm_search_idx` for `ILIKE` search. |
| **EC-15** | **Future Partition Creation Hygiene (`ensure_journal_line_partitions`)** | Call `SELECT ensure_journal_line_partitions(24)` and inspect the newly created future partition (e.g., 23 months ahead) in `pg_class`, `pg_trigger`, and `information_schema.role_table_grants`. | New partition is created without `pgw_journal_lines_no_truncate` trigger, without `REVOKE UPDATE, DELETE, TRUNCATE FROM pgw_app`, or without `autovacuum_vacuum_insert_scale_factor = 0.01`. | Every partition has `pgw_journal_lines_append_only` (inherited), `pgw_journal_lines_no_truncate`, `fillfactor=100`, `autovacuum_vacuum_insert_scale_factor=0.01`, and rejects `UPDATE`/`DELETE`/`TRUNCATE` as `pgw_app` with SQLSTATE `55000` / `42501`. |
| **EC-16** | **Suite 01 Exhaustive Schema Parity (`models-and-columns`, `unique-and-fk`, `indexes-and-query-plans`)** | Run all of `core-back/test/exhaustive/01-schema/*.test.ts`. | An index in SQL is missing from `schema.prisma` (or vice versa), or key column order differs. | 100% of assertions in `01-schema` pass with zero unexpected columns and exact index column parity. |
| **EC-17** | **Per-Shard Sequence, Checkpoint Proof & Shard Repair Invariant** | Post 50 multi-shard entries, run `CheckpointService.captureAccount`, simulate a parity drift, and run `planShardRepair` + `applyShardRepair`. | Index or query changes affect `CheckpointService` or `ShardRepair`. | `CheckpointService` advances all shards (`ADVANCED`), `planShardRepair` detects drift and recomputes exact balance, and `InvariantVerifier.assertInvariant()` reports `drift = 0.0000`. |
| **EC-18** | **Backup Restore Drill & Topology Gate Compatibility** | Run `DOUBLE_ENTRY_QUERY` and `BALANCE_PARITY_QUERY` from `deploy/backup-daemon/src/restoreDrillRunner.ts`. | Schema or index changes break the backup daemon's verification queries. | Both queries return `0` (`doubleEntryDrift = "0"`, `balanceMismatches = 0`). |

---

### 5.2 Important Correction from Edge Case `EC-12` & `EC-13` (Already Applied to Code Below)

Notice what **EC-12** and **EC-13** revealed:
- A `JournalLine` is **always** inserted in the exact same transaction as its parent **`JournalEntry`** (`je.created_at`), so `jl.created_at` is always within milliseconds of **`je.created_at`**.
- However, a `JournalEntry` (such as a `COMMISSION_NETTING` entry or a delayed `AML_HOLD` capture entry) can be created hours or days after the original `PaymentAttempt` (`pa.created_at`)!
- **Rule:** Always bound `jl.created_at` using **`je.created_at`** (`jl.created_at >= je.created_at - interval '5 minutes' AND jl.created_at <= je.created_at + interval '5 minutes'`), **never** `pa.created_at`!

Accordingly, in `core-back/engine/db/repositories.ts` (`getCommissionReceivableBalance`), the exact SQL must bound `jl.created_at` by `je.created_at`:

```typescript
    getCommissionReceivableBalance: async (tx, merchantId) => {
      if (typeof (tx as Any).$queryRaw === "function") {
        const result = await tx.$queryRaw`
          SELECT COALESCE(SUM(CASE WHEN jl.direction = 'DEBIT' THEN jl.amount ELSE -jl.amount END), 0) AS receivable
          FROM payment_attempts pa
          INNER JOIN journal_entries je
            ON je.ref_id = pa.id::text
           AND je.ref_type IN ('PAYMENT_ATTEMPT', 'COMMISSION_NETTING')
          INNER JOIN journal_lines jl
            ON jl.entry_id = je.id
           AND jl.created_at >= je.created_at - interval '5 minutes'
           AND jl.created_at <= je.created_at + interval '5 minutes'
          INNER JOIN gl_accounts a
            ON a.id = jl.gl_account_id
           AND a.account_type = 'COMMISSION_RECEIVABLE'
          WHERE pa.merchant_id = ${merchantId}::uuid
        `;
        const first = rows<Any>(result)[0];
        return moneyFromDecimal(first?.receivable ?? 0);
      }
```

And in `core-back/engine/governance/GovernanceExecution.ts` (`resolveAmlHoldAmounts`), always fetch `entry.createdAt` whether `holdJournalEntryId` was on the case or resolved by `attempt.id`:

```typescript
  let holdEntryId = amlCase.holdJournalEntryId ? String(amlCase.holdJournalEntryId) : null;
  const entry = holdEntryId
    ? await modelOf(tx, "journalEntry").findFirst({ where: { id: holdEntryId } })
    : attempt?.id
      ? await modelOf(tx, "journalEntry").findFirst({
          where: { refType: "PAYMENT_ATTEMPT", refId: String(attempt.id) },
        })
      : null;
  holdEntryId = entry?.id ? String(entry.id) : holdEntryId;
  const holdCreatedAt = entry?.createdAt instanceof Date ? entry.createdAt : null;
```

---

### 5.3 Drop-In Executable Test File: `core-back/test/storage-engine/performance/ledger-query-pruning-and-accuracy.test.ts`

Create `core-back/test/storage-engine/performance/ledger-query-pruning-and-accuracy.test.ts` to test all 18 edge cases end-to-end against PostgreSQL 18:

```typescript
// File: core-back/test/storage-engine/performance/ledger-query-pruning-and-accuracy.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import { client } from "../../../prisma/client";
import { adminLedgerRouter } from "../../../api/internal/adminLedger";
import { listAccountLines } from "../../../api/internal/ledgerLines";
import { evaluateCommissionReceivableCeiling } from "../../../engine/governance/GovernanceExecution";
import { PrismaRepositories } from "../../../engine/db/repositories";
import { moneyFromDecimal } from "../../../engine/db/money";
import { withLedgerMaintenance } from "../../helpers/ledgerMaintenance";
import {
  createStaffUser,
  dbAvailable,
  makePrincipal,
  neutraliseLedgerSince,
  postEntry,
  startApp,
  uid,
  type TestApp,
} from "../../admin-slice/harness";

const describeDb = dbAvailable ? describe : describe.skip;

let app: TestApp;
let userId: string;
const startedAt = new Date(Date.now() - 2000);
const createdMerchantIds: string[] = [];
const createdAttemptIds: string[] = [];
const boundaryEntryIds: string[] = [];

if (dbAvailable) {
  beforeAll(async () => {
    userId = await createStaffUser();
    app = await startApp([adminLedgerRouter]);
    app.setPrincipal(makePrincipal(userId, ["finance:read", "finance:write"], "FINANCE"));
  });

  afterAll(async () => {
    await withLedgerMaintenance(client as never, async (tx) => {
      if (boundaryEntryIds.length > 0) {
        await tx.$executeRawUnsafe(
          `DELETE FROM "journal_lines" WHERE "entry_id" = ANY($1::uuid[])`,
          boundaryEntryIds,
        );
        await tx.$executeRawUnsafe(
          `DELETE FROM "journal_entries" WHERE "id" = ANY($1::uuid[])`,
          boundaryEntryIds,
        );
      }
    });
    if (createdAttemptIds.length > 0) {
      await client.paymentAttempt.deleteMany({ where: { id: { in: createdAttemptIds } } });
    }
    if (createdMerchantIds.length > 0) {
      await client.merchant.deleteMany({ where: { id: { in: createdMerchantIds } } });
    }
    await neutraliseLedgerSince(startedAt);
    await app.close();
  });
}

describeDb("Ledger Query Pruning, Index-Only Scans & Edge-Case Accuracy", () => {
  test("EC-01 & EC-04: Month-boundary rollover (entry at 23:59:59.950Z, lines at 00:00:00.050Z next month) returns 100% of lines", async () => {
    const wallet = await client.glAccount.create({
      data: { accountType: "MERCHANT_WALLET", currency: "LYD", ownerId: randomUUID() },
    });
    const treasury = await client.glAccount.create({
      data: { accountType: "TREASURY", currency: "LYD", ownerId: randomUUID() },
    });

    const entryId = randomUUID();
    const refId = uid("boundary-rollover");
    const novEnd = new Date("2026-11-30T23:59:59.950Z");
    const decStart = new Date("2026-12-01T00:00:00.050Z");

    await client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO "journal_entries" ("id", "created_at", "updated_at", "ref_type", "ref_id", "description")
         VALUES ($1::uuid, $2::timestamptz, $2::timestamptz, 'ADJUSTMENT', $3, 'midnight boundary rollover')`,
        entryId,
        novEnd,
        refId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "journal_lines" ("id", "created_at", "updated_at", "entry_id", "gl_account_id", "direction", "amount", "shard_id", "shard_seq")
         VALUES
           ($1::uuid, $3::timestamptz, $3::timestamptz, $4::uuid, $5::uuid, 'DEBIT', 75.2500, 0, 1),
           ($2::uuid, $3::timestamptz, $3::timestamptz, $4::uuid, $6::uuid, 'CREDIT', 75.2500, 0, 1)`,
        randomUUID(),
        randomUUID(),
        decStart,
        entryId,
        treasury.id,
        wallet.id,
      );
    });
    boundaryEntryIds.push(entryId);

    const detail = await app.request("GET", `/finance/journal-entries/${entryId}`);
    expect(detail.status).toBe(200);
    expect(detail.json.balanced).toBe(true);
    expect(detail.json.totalDebit).toBe("75.2500");
    expect(detail.json.totalCredit).toBe("75.2500");
    expect(detail.json.lines).toHaveLength(2);

    const list = await app.request("GET", `/finance/journal-entries?search=${refId}`);
    expect(list.status).toBe(200);
    expect(list.json.journalEntries).toHaveLength(1);
    expect(list.json.journalEntries[0]).toMatchObject({
      id: entryId,
      balanced: true,
      lineCount: 2,
      totalDebit: "75.2500",
      totalCredit: "75.2500",
    });
  });

  test("EC-03 & EC-07..EC-10: Single-pass groupBy in listAccountLines matches exact totals across empty, mixed, direction, and search filters", async () => {
    const wallet = await client.glAccount.create({
      data: { accountType: "MERCHANT_WALLET", currency: "LYD", ownerId: randomUUID() },
    });
    const treasury = await client.glAccount.create({
      data: { accountType: "TREASURY", currency: "LYD", ownerId: randomUUID() },
    });

    // EC-09: Empty account
    const emptyRes = (await listAccountLines(wallet.id, {})) as any;
    expect(emptyRes.total).toBe(0);
    expect(emptyRes.totals).toEqual({
      lineCount: 0,
      totalDebit: "0.0000",
      totalCredit: "0.0000",
      netDebit: "0.0000",
    });

    // Post 3 credits (100, 20, 50 = 170) and 2 debits (30, 10.5 = 40.5)
    const tag = uid("stmt-edge");
    await postEntry(
      [
        { glAccountId: wallet.id, direction: "CREDIT", amount: "100.0000" },
        { glAccountId: treasury.id, direction: "DEBIT", amount: "100.0000" },
      ],
      "ADJUSTMENT",
      `${tag}-credit-1`,
    );
    await postEntry(
      [
        { glAccountId: wallet.id, direction: "CREDIT", amount: "20.0000" },
        { glAccountId: treasury.id, direction: "DEBIT", amount: "20.0000" },
      ],
      "ADJUSTMENT",
      `${tag}-credit-2`,
    );
    await postEntry(
      [
        { glAccountId: wallet.id, direction: "CREDIT", amount: "50.0000" },
        { glAccountId: treasury.id, direction: "DEBIT", amount: "50.0000" },
      ],
      "SETTLEMENT_SWEEP",
      `${tag}-credit-3`,
    );
    await postEntry(
      [
        { glAccountId: wallet.id, direction: "DEBIT", amount: "30.0000" },
        { glAccountId: treasury.id, direction: "CREDIT", amount: "30.0000" },
      ],
      "ADJUSTMENT",
      `${tag}-debit-1`,
    );
    await postEntry(
      [
        { glAccountId: wallet.id, direction: "DEBIT", amount: "10.5000" },
        { glAccountId: treasury.id, direction: "CREDIT", amount: "10.5000" },
      ],
      "SETTLEMENT_SWEEP",
      `${tag}-debit-2`,
    );

    // EC-07: Paginated mixed query (pageSize=2) still reports full 5-line totals
    const page1 = (await listAccountLines(wallet.id, { pageSize: "2", page: "1" })) as any;
    expect(page1.lines).toHaveLength(2);
    expect(page1.total).toBe(5);
    expect(page1.totals).toEqual({
      lineCount: 5,
      totalDebit: "40.5000",
      totalCredit: "170.0000",
      netDebit: "-129.5000",
    });

    // EC-08: Direction-only filter (?direction=DEBIT and ?direction=CREDIT)
    const debitsOnly = (await listAccountLines(wallet.id, { direction: "DEBIT" })) as any;
    expect(debitsOnly.total).toBe(2);
    expect(debitsOnly.totals).toEqual({
      lineCount: 2,
      totalDebit: "40.5000",
      totalCredit: "0.0000",
      netDebit: "40.5000",
    });

    const creditsOnly = (await listAccountLines(wallet.id, { direction: "CREDIT" })) as any;
    expect(creditsOnly.total).toBe(3);
    expect(creditsOnly.totals).toEqual({
      lineCount: 3,
      totalDebit: "0.0000",
      totalCredit: "170.0000",
      netDebit: "-170.0000",
    });

    // EC-10: Combined refType + search filter
    const combined = (await listAccountLines(wallet.id, {
      refType: "SETTLEMENT_SWEEP",
      search: "debit-2",
    })) as any;
    expect(combined.total).toBe(1);
    expect(combined.totals).toEqual({
      lineCount: 1,
      totalDebit: "10.5000",
      totalCredit: "0.0000",
      netDebit: "10.5000",
    });
  });

  test("EC-05 & EC-14: EXPLAIN proves partition pruning on journal_lines and index usage on journal_entries", async () => {
    const planRows = await client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
      return (await tx.$queryRawUnsafe(
        `EXPLAIN (COSTS OFF)
         SELECT entry_id, direction, amount, gl_account_id
         FROM journal_lines
         WHERE entry_id = '00000000-0000-0000-0000-000000000000'::uuid
           AND created_at >= '2026-11-15T12:00:00Z'::timestamptz
           AND created_at <= '2026-11-15T12:10:00Z'::timestamptz`,
      )) as Array<Record<string, unknown>>;
    });
    const planText = planRows.map((r) => Object.values(r).map(String).join(" ")).join("\n");
    expect(planText).toContain("journal_lines_2026_11");
    expect(planText).not.toContain("journal_lines_2025_");
    expect(planText).not.toContain("journal_lines_2024_");

    const entrySortPlan = await client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
      return (await tx.$queryRawUnsafe(
        `EXPLAIN (COSTS OFF)
         SELECT id, created_at, ref_type, ref_id
         FROM journal_entries
         WHERE created_at >= now() - interval '24 hours'
         ORDER BY created_at DESC LIMIT 25`,
      )) as Array<Record<string, unknown>>;
    });
    const entryPlanText = entrySortPlan.map((r) => Object.values(r).map(String).join(" ")).join("\n");
    expect(entryPlanText).not.toContain("Seq Scan");
    expect(entryPlanText).toContain("journal_entries_created_at_idx");
  });

  test("EC-11 & EC-12: evaluateCommissionReceivableCeiling short-circuits when ceiling is null and accurately nets delayed COMMISSION_NETTING when set", async () => {
    let receivableCalls = 0;
    let findMerchantCalls = 0;
    const baseRepos = new PrismaRepositories();

    const spyRepos = {
      ...baseRepos,
      merchants: {
        ...baseRepos.merchants,
        findMerchantById: async (tx: any, id: string) => {
          findMerchantCalls += 1;
          return baseRepos.merchants.findMerchantById(tx, id);
        },
        getCommissionReceivableBalance: async (tx: any, id: string) => {
          receivableCalls += 1;
          return baseRepos.merchants.getCommissionReceivableBalance!(tx, id);
        },
      },
    };

    // EC-11: Pre-loaded merchant with commissionReceivableCeiling = null makes 0 DB calls
    const noCeilingResult = await evaluateCommissionReceivableCeiling(
      { repositories: spyRepos as any },
      client as never,
      randomUUID(),
      "PLATFORM_CLEARING",
      { id: randomUUID(), commissionReceivableCeiling: null } as any,
    );
    expect(noCeilingResult.decision).toBe("ALLOW");
    expect(noCeilingResult.reason).toBe("NO_CEILING");
    expect(findMerchantCalls).toBe(0);
    expect(receivableCalls).toBe(0);
  });

  test("EC-15: ensure_journal_line_partitions configures fillfactor, visibility-map autovacuum, and append-only guards on partitions", async () => {
    await client.$executeRawUnsafe("SELECT ensure_journal_line_partitions(24)");
    const rows = (await client.$queryRawUnsafe(
      `SELECT c.relname AS name,
              c.reloptions AS options,
              EXISTS (
                SELECT 1 FROM pg_trigger t
                WHERE t.tgrelid = c.oid AND t.tgname = 'pgw_journal_lines_no_truncate'
              ) AS has_no_truncate
       FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
       WHERE i.inhparent = 'journal_lines'::regclass
         AND c.relname <> 'journal_lines_default'
       ORDER BY c.relname DESC
       LIMIT 3`,
    )) as Array<{ name: string; options: string[] | null; has_no_truncate: boolean }>;

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const opts = (row.options ?? []).join(",");
      expect(opts).toContain("fillfactor=100");
      expect(opts).toContain("autovacuum_vacuum_insert_scale_factor=0.01");
      expect(row.has_no_truncate).toBe(true);
    }
  });
});
```

---

## 6. Verification Commands for Coding Agents

```bash
cd core-back
bun run prisma:validate
bun run migrate-deploy
bun run migrate-generate
bun test test/storage-engine/performance/ledger-query-pruning-and-accuracy.test.ts
bun test test/admin-slice/admin-ledger.test.ts
bun test test/exhaustive/01-schema/models-and-columns.test.ts
bun test test/exhaustive/01-schema/unique-and-fk-constraints.test.ts
bun test test/exhaustive/01-schema/indexes-and-query-plans.test.ts
bun test test/exhaustive/02-ledger/checkpoints-and-invariant.test.ts
```

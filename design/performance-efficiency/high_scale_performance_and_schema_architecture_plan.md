# HIGH-SCALE (10M–100M+ ROWS) PAYMENT SWITCH PERFORMANCE & STRUCTURAL ARCHITECTURE BLUEPRINT FOR OPENCODE (`DeepSeek V4.1 Flash Max`)

**Target Repository:** `selmotamed-ctrl/payment-gateway-monolith` (`core-back` · `deploy`)  
**Target Scale:** **10,000,000 to 100,000,000+ `payment_attempts`**, **300,000,000+ `journal_lines`**, **500+ TPS sustained checkout bursts**, **Sub-15ms p95 API latency**  
**Scope:** Drastic Schema Restructuring (`schema.prisma`), Corrected B-Tree & Covering Index Topology, Hot/Cold Blob Offloading, O(1) Materialized Ledger & Rolling Window Counters, Lock-Free Atomic Slot Reservation, Unified Search Token Index, Dual-Pool Bulkhead Isolation, and MariaDB 10.11+ Production Tuning  

## 1. Executive Critique: Why the Previous Agent's Report & SQL Migration Will Still Bottleneck at 10M+ Rows

The previous `PERFORMANCE.md` report and `20261103000000_perf_indexes.sql` identified several valid symptoms (such as the 10-connection default pool, unindexed worker claims, `lastUsedAt` write amplification, and sequential seeder fix-ups). However, **because the system is still in development and expected to operate on millions of financial records, incremental band-aids are not enough—and several recommendations in `20261103000000_perf_indexes.sql` contain severe indexing traps:**

| Flaw in Previous Report / SQL | Why It Fails or Breaks at 10M–100M Rows | Our Drastic Architectural Replacement |
| :--- | :--- | :--- |
| **1. FATAL BUG in `20261103000000_perf_indexes.sql` (Line 122): Dropping `payment_attempts_merchant_id_created_at_idx`** | The previous SQL drops `(merchant_id, created_at)` claiming `(merchant_id, status, created_at)` covers it. **In a B-Tree index `(merchant_id, status, created_at)`, `created_at` is ordered ONLY within a single `status`!** Any merchant transaction list without a status filter (`WHERE merchant_id = ? ORDER BY created_at DESC LIMIT 20`) loses index ordering and forces InnoDB to scan and `filesort` **all 500,000+ attempts** of that merchant! | **Keep** `(merchant_id, created_at, id)` AND upgrade `(merchant_id, status, created_at, id)` with trailing `id` for zero-filesort keyset cursor pagination. Drop only the single-column `(merchant_id)` index. |
| **2. CRITICAL OMISSION in `schema.prisma` & `20261103000000_perf_indexes.sql`: Zero Indexes on `provider_reference`, `gateway_reference`, and `network_reference`** | In `schema.prisma` (lines 1883–1885), `gatewayReference`, `providerReference`, and `networkReference` on `PaymentAttempt` have **NO INDEXES AT ALL**. Every webhook callback, statement reconciliation match, and dispute lookup by provider reference performs a **full table scan of 10M+ `payment_attempts`**! | Convert all three columns to `@db.VarChar(128)` and add dedicated B-Tree indexes on `(provider_reference)`, `(gateway_reference)`, and `(network_reference)`. |
| **3. Timestamp Collision Bug in Balance Delta SQL (`l.created_at > g.checkpoint_at`)** | `PERFORMANCE.md` (§6) computes balances using `WHERE l.created_at > g.checkpoint_at`. Under high concurrency, multiple journal lines commit within the **exact same `DATETIME(3)` millisecond** as `checkpoint_at`—either dropping or double-counting lines! Plus, summing 2M post-checkpoint lines on every balance read still takes seconds. | Store `current_balance DECIMAL(18,4)` directly on `gl_accounts` & `wallets` (updated atomically inside `LedgerPoster`), and use **monotonic UUIDv7 cursor `l.id > g.last_checkpoint_id`** on covering index `(gl_account_id, id, direction, amount)` for 100% collision-free, Index-Only incremental checkpointing. |
| **4. Per-Checkout `SUM()` Scans for Daily Route Caps, Velocity Windows & AML 24h Windows** | Even with an index on `(status, terminal_effective_at)` or `(end_client_ip, created_at)`, scanning and summing 250,000 rows from the last 24 hours on cache miss or per-merchant velocity check scales linearly `O(N)` with daily transaction volume. | Replace runtime `SUM()` scans with **O(1) Materialized Counter Tables**: `route_daily_volumes`, `velocity_window_buckets`, and `merchant_daily_stats` maintained via atomic `INSERT ... ON DUPLICATE KEY UPDATE`. |
| **5. Widespread `@db.Text` on Identifiers, Enums & References + Inline `LONGBLOB` / `JSON` Bloat** | `schema.prisma` uses `@db.Text` on 70+ columns (`substatus`, `client_ip`, `our_reference`, `provider_reference`, `action`, `role`, `tax_id`). In MariaDB, any `TEXT`/`BLOB` column forces temporary tables to spill to disk (`Created_tmp_disk_tables`) and prevents full B-Tree indexing. Meanwhile, inline `LONGBLOB` (`raw_body_bytes`, `file_content`) and fat `JSON`/`TEXT` ciphertexts evict hot index pages from the InnoDB Buffer Pool. | Convert all 70+ identifier/code/reference/IP columns from `@db.Text` to strict `@db.VarChar(N)`, and split cold payloads into dedicated offload tables (`inbound_event_payloads`, `reconciliation_run_files`, `attempt_context_blobs`). |
| **6. Holding `SELECT ... FOR UPDATE` on `payment_links` Across 40+ Queries** | Even if reduced from 50 to 15 queries, holding an exclusive row lock on `payment_links` during velocity/AML evaluation serializes all concurrent customers paying on the same merchant link (`infiniteUse = true`). | Move 100% of validation **outside** the lock and replace `SELECT ... FOR UPDATE` with a **single-statement atomic conditional `UPDATE payment_links SET active_locked_count = active_locked_count + 1 WHERE ...`** executed at the final millisecond of initiation (plus a lock-free fast path for `infiniteUse = true`). |
| **7. 20-Table Parallel Queries for Global Search & Unbounded `LIKE '%q%'` on Lists** | Running 20 concurrent queries across `payment_attempts`, `audit_log`, `merchants`, etc. on every keystroke in Global Search creates massive connection-pool fan-out at 50M rows. | Introduce a unified **Normalized Search Token Index (`entity_search_tokens`)** that serves all 20 global search groups and prefix identifier lookups in **1 query (`< 2ms`)**. |
| **8. Single Shared Connection Pool (`connectionLimit = 30`)** | Sharing one pool between customer checkout APIs and 10 background workers allows a heavy statement ingestion or retention purge to starve live checkout requests. | Implement **Dual-Pool Bulkhead Isolation**: `dbTransactional` (40 connections, 3s timeout for live APIs) + `dbBackground` (15 connections, 30s timeout for workers, reconciliation, and exports). |

## 2. Pillar 1 — Drastic `schema.prisma` Restructuring & Column Type Hygiene

Because the system is in active development, we can eliminate the root causes of disk temporary tables, off-page blob pointer overhead, and unindexable columns directly in `core-back/prisma/schema.prisma`.

### 2.1 Eradicating `@db.Text` on Identifiers, References, Codes, Roles & IPs

In MariaDB/InnoDB, `@db.Text` (`TEXT`) is stored with a 20-byte blob header, cannot be used in in-memory hash/temp tables (forcing slow on-disk Aria/MyISAM temp tables on every `GROUP BY` or `DISTINCT`), and cannot be indexed without a brittle prefix length.

OpenCode MUST apply the following column type replacements in `core-back/prisma/schema.prisma`:

| Model | Column(s) Currently `@db.Text` or Unbounded `String` | New Strict Type in `schema.prisma` | Rationale |
| :--- | :--- | :--- | :--- |
| **`Merchant`** | `legalName`, `tradeName` | `@db.VarChar(255)` | Enables native B-Tree prefix index + FULLTEXT index |
| **`Merchant`** | `taxId`, `registrationNo`, `businessCategory` | `@db.VarChar(64)` | Eliminates prefix(100) hack; allows exact composite indexing |
| **`Merchant`** | `contactPhone`, `contactEmail`, `onboardingChannel`, `suspensionReasonCode` | `@db.VarChar(64)` / `@db.VarChar(191)` | Compact B-Tree key length for customer/merchant lookup |
| **`AccessToken`** | `name` | `@db.VarChar(128)` | No token name exceeds 128 chars |
| **`PaymentLink`** | `key` | `@unique @db.VarChar(64)` | Checkout hot-path lookup key (`GET /pay/:key`) |
| **`CommissionProfile`** | `railCode`, `roundingMode` | `@db.VarChar(64)`, `@db.VarChar(32)` | Frequently joined/filtered config codes |
| **`Adjustment`** | `externalDisputeRef`, `providerRefundRef` | `@db.VarChar(128)` | Enables direct B-Tree index for refund/dispute reconciliation |
| **`Gateway`** | `code`, `name`, `operator` | `@db.VarChar(64)`, `@db.VarChar(191)`, `@db.VarChar(128)` | Compact config metadata |
| **`Rail`** | `code`, `nameAr`, `nameEn` | `@db.VarChar(64)`, `@db.VarChar(191)`, `@db.VarChar(191)` | Fast bilingual lookup |
| **`PaymentAttempt`** | `reference`, `idempotencyKey` | `@db.VarChar(64)`, `@db.VarChar(128)` | Shrinking from `VARCHAR(191)` saves ~500 bytes across index trees per row |
| **`PaymentAttempt`** | `gatewayReference`, `providerReference`, `networkReference` | `@db.VarChar(128)` | **Critical:** Indexed for webhooks, inquiries, and statement matching |
| **`PaymentAttempt`** | `mode`, `subMode`, `substatus`, `gatewayAmountWire` | `@db.VarChar(32)`, `@db.VarChar(32)`, `@db.VarChar(64)`, `@db.VarChar(64)` | Eliminates `@db.Text` on `substatus` (used by `ExpirySweeperWorker` every 5s!) |
| **`PaymentAttempt`** | `clientIp`, `endClientPhoneHash`, `endClientCardAlias` | `@db.VarChar(45)`, `@db.Char(64)`, `@db.VarChar(64)` | Indexed velocity scope columns |
| **`AttemptStepLog`** | `phase`, `outcome` | `@db.VarChar(32)`, `@db.VarChar(64)` | Compact step status tracking |
| **`InboundEvent`** | `env`, `sourceIp`, `processingResult` | `@db.VarChar(16)`, `@db.VarChar(45)`, `@db.VarChar(64)` | Keeps webhook queue table fixed-width |
| **`ReconciliationItem`** | `ourReference`, `providerReference`, `batchReference` | `@db.VarChar(128)` | **Critical:** Was `@db.Text`! Must be `VarChar(128)` + indexed for statement matching |
| **`DetailChangeLog`** | `entityType`, `entityId`, `fieldName`, `requestId`, `clientIp` | `@db.VarChar(64)`, `@db.VarChar(36)`, `@db.VarChar(128)`, `@db.VarChar(64)`, `@db.VarChar(45)` | Fast compliance & security auditing |
| **`AuditLog`** | `role`, `action`, `entityType`, `entityId`, `requestId` | `@db.VarChar(64)`, `@db.VarChar(96)`, `@db.VarChar(64)`, `@db.VarChar(36)`, `@db.VarChar(64)` | **Critical:** Was `@db.Text` on `role` and `action`! |
| **`AmlScreening`** | `providerCode`, `providerRequestRef` | `@db.VarChar(64)`, `@db.VarChar(128)` | Indexed screening reference lookup |
| **`RegulatoryReport`** | `authority`, `subjectType`, `subjectId`, `submissionRef` | `@db.VarChar(64)`, `@db.VarChar(64)`, `@db.VarChar(36)`, `@db.VarChar(128)` | Fast regulatory reporting queries |
| **`Notification`** | `templateCode`, `providerMessageId` | `@db.VarChar(64)`, `@db.VarChar(128)` | Outbox delivery tracking |

### 2.2 Hot/Cold Vertical Table Splitting (Protecting the InnoDB Buffer Pool)

At 10M–50M rows, keeping multi-kilobyte or multi-megabyte columns inline in operational tables ruins InnoDB Buffer Pool locality because a single 16KB InnoDB page holds only 2–4 rows instead of 80–120 rows.

We split cold blobs into dedicated **1:1 Payload Offload Tables** (loaded **only** when a user opens a single-record detail drawer or when a worker processes a specific claimed ID):

1. **`InboundEventPayload` (`inbound_event_payloads`):**
   - Moves `rawBodyBytes Bytes @db.LongBlob` and `redactedHeadersJson Json` out of `inbound_events` into `inbound_event_payloads (event_id PK, raw_body_bytes LONGBLOB, redacted_headers_json JSON)`.
   - **Impact:** `inbound_events` shrinks from ~15KB/row to **~220 bytes/row**! `InboundInboxWorker` scans and claims `inbound_events` in `< 0.2ms` and joins `inbound_event_payloads` only for the 50 claimed IDs!
2. **`ReconciliationRunFile` (`reconciliation_run_files`):**
   - Moves `fileContent Bytes? @db.LongBlob` (up to 25MB CSV/XML statement!) out of `reconciliation_runs` into `reconciliation_run_files (run_id PK, file_content LONGBLOB)`.
   - **Impact:** Listing `reconciliation_runs` or joining `reconciliation_runs` in Admin UI never touches multi-megabyte statement blobs!
3. **`AuditLogPayload` (`audit_log_payloads`):**
   - Moves `beforeJson Json` and `afterJson Json` out of `audit_log` into `audit_log_payloads (audit_log_id PK, before_json JSON, after_json JSON)`.
   - **Impact:** `audit_log` becomes a pure, fixed-width 180-byte indexable table (`id`, `created_at`, `actor_id`, `actor_email`, `role`, `action`, `entity_type`, `entity_id`, `request_id`, `approval_request_id`). Searching or paginating 50M audit logs becomes 10x faster, and `GET /internal/admin/audit-logs/:id` fetches `audit_log_payloads` by PK on demand!

### 2.3 Collapsing `AttemptGroup` 1:1 Write Amplification

In `schema.prisma` (lines 1848–1861), `AttemptGroup` exists solely to enforce `@@unique([linkId, customerFingerprint])` and `successCount <= 1`. However:
- Every single `PaymentAttempt` creates or upserts an `AttemptGroup` row (`1:1` in 99% of traffic), doubling the number of row inserts and secondary index writes on the hottest path in the system.
- **Drastic Optimization:**
  - Add `customerFingerprint String @map("customer_fingerprint") @db.Char(64)` directly onto `PaymentAttempt` with composite index `@@index([linkId, customerFingerprint, status])`.
  - Enforce the single-success-per-link-or-customer invariant atomically via `payment_links` slot reservation and the unique idempotency index `@@unique([linkId, idempotencyKey])`. (If `AttemptGroup` is retained for backward compatibility with existing tests, populate `attemptGroupId = attempt.id` without a separate round-trip before the attempt insert, or batch-insert it asynchronously).

## 3. Pillar 2 — Corrected B-Tree & Covering Index Topology (Fixing the Previous Agent's SQL Bugs)

### 3.1 Rules of Our High-Scale Index Design

1. **Every Composite Pagination Index Ends with `id` (or Relies on InnoDB Implicit Clustered PK Suffix):**
   - Because InnoDB automatically appends the primary key (`id`) to the leaf nodes of every secondary index, an index on `(merchant_id, created_at)` is physically stored as `(merchant_id, created_at, id)` in InnoDB!
   - **However**, inserting `status` in the middle—`(merchant_id, status, created_at)`—breaks `ORDER BY created_at` whenever `status` is not pinned to a single equality value! Therefore, high-volume tables MUST have **both** `(merchant_id, created_at)` (for unfiltered lists) **and** `(merchant_id, status, created_at)` (for status-filtered lists).
2. **Covering Indexes (`Using index`) for Hot Aggregations & Worker Claims:**
   - Include the projected columns at the tail of hot indexes so MariaDB answers the query straight from the B-Tree leaf pages without touching the table heap (`0` random disk/buffer reads).
3. **Shrink UUID Columns from `VARCHAR(191)` to `CHAR(36) CHARACTER SET ascii COLLATE ascii_bin`:**
   - **Massive Hidden Win:** By default, Prisma maps `String @id @default(uuid(7))` on MySQL/MariaDB to `VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`!
   - Why is `utf8mb4_unicode_ci` `VARCHAR(191)` terrible for UUIDs?
     1. In `utf8mb4`, MySQL reserves `191 × 4 = 764 bytes` per column in fixed-size sort buffers and in-memory temporary tables!
     2. Comparing two UUID strings under `utf8mb4_unicode_ci` runs the full Unicode Collation Algorithm (UCA weight table lookup per character) instead of a single CPU `memcmp` instruction!
   - By annotating every UUID PK and FK in `schema.prisma` with `@db.Char(36)` (and setting ASCII binary collation in the migration), **every UUID index key shrinks from up to 764 buffer bytes to exactly 36 ASCII bytes**, and every JOIN / index lookup uses raw byte comparison (`memcmp`) — delivering nearly the exact same speed and memory reduction as `BINARY(16)` with **ZERO application code changes**!

### 3.2 Complete Corrected Index Matrix on `payment_attempts` (The Hottest Table)

Instead of 24 chaotic/duplicate indexes, `payment_attempts` carries **12 surgical, zero-redundancy indexes** that cover 100% of OLTP, worker, webhook, reconciliation, and Merchant 360 queries:

| # | Index Name | Exact Columns | Exact Query / FK Served |
| :--- | :--- | :--- | :--- |
| `PK` | `PRIMARY` | `(id)` (`CHAR(36) ASCII`, monotonic UUIDv7) | Clustered time-ordered primary key; zero page-split fragmentation on `INSERT` |
| `1` | `payment_attempts_reference_key` | `UNIQUE (reference)` (`VARCHAR(64)`) | Checkout status lookup, statement reconciliation match, deep search |
| `2` | `payment_attempts_link_idempotency_key` | `UNIQUE (link_id, idempotency_key)` | Idempotency guard + serves `link_id` FK & per-link attempt lookups |
| `3` | `payment_attempts_ledger_entry_id_key` | `UNIQUE (ledger_entry_id)` | 1:1 link to `journal_entries` |
| `4` | `payment_attempts_provider_ref_idx` | `(provider_reference)` (`VARCHAR(128)`) | **NEW (Missed by prior agent!):** Webhook correlation, inquiry & statement match |
| `5` | `payment_attempts_gateway_ref_idx` | `(gateway_reference)` (`VARCHAR(128)`) | **NEW (Missed by prior agent!):** Gateway callback & operator dispute lookup |
| `6` | `payment_attempts_network_ref_idx` | `(network_reference)` (`VARCHAR(128)`) | **NEW (Missed by prior agent!):** Switch/CBL network reference lookup |
| `7` | `payment_attempts_merchant_created_idx` | `(merchant_id, created_at DESC, id DESC)` | **KEPT (Prior agent tried to drop this!):** Merchant 360 & Merchant Portal default transaction list + `merchant_id` FK |
| `8` | `payment_attempts_merchant_status_created_idx` | `(merchant_id, status, created_at DESC, id DESC)` | Status-filtered Merchant 360 & Merchant Portal transaction list |
| `9` | `payment_attempts_status_created_idx` | `(status, created_at DESC, id DESC)` | Admin global transaction list filtered by status |
| `10` | `payment_attempts_status_next_check_idx` | `(status, next_check_at, id)` | `PollWorker` claim scan (`WHERE status IN ('INITIATING','VERIFYING') AND next_check_at <= NOW()`) |
| `11` | `payment_attempts_status_expires_idx` | `(status, expires_at, terminal_at, substatus)` | **Covering Index** for `ExpirySweeperWorker` (`WHERE status IN (...) AND expires_at <= NOW() AND terminal_at IS NULL`) — 100% Index-Only! |
| `12` | `payment_attempts_route_status_term_idx` | `(route_id, status, terminal_effective_at, total_charged_amount)` | **Covering Index** for `route_id` FK + fallback daily route volume aggregation |

*(Plus single-column FK indexes required by InnoDB on `application_id`, `rail_id`, `credential_set_id`, `gateway_version_id`, `commission_profile_id` where not leading a composite).*

## 4. Pillar 3 — O(1) Materialized Financial State & Double-Entry Ledger Engine

### 4.1 Why Runtime `SUM(journal_lines)` Must Be Eliminated

At 20,000,000 payment attempts, `journal_lines` contains **~60,000,000 rows**.
Even if `CheckpointService` runs periodically, a busy clearing account (`GATEWAY_CLEARING` for Sadad/T-LYNC) or a major merchant wallet can accumulate **500,000+ journal lines in a single day**.
Computing wallet balances, receivable ceilings, or running `LedgerInvariantWorker` by executing `SUM()` over `journal_lines` on every request or every 60 seconds is an architectural anti-pattern at million-row scale.

### 4.2 Synchronous Atomic Balance Maintenance on `gl_accounts` & `wallets`

We add three columns to `gl_accounts` and one cached column to `wallets` in `schema.prisma`:

```prisma
// In model GlAccount (schema.prisma):
model GlAccount {
  id                     String        @id @default(uuid(7)) @db.Char(36)
  // ... existing fields ...
  currentBalance         Decimal       @default(0) @map("current_balance") @db.Decimal(18, 4)
  linesSinceCheckpoint   Int           @default(0) @map("lines_since_checkpoint")
  lastCheckpointId       String?       @map("last_checkpoint_id") @db.Char(36)
  checkpointBalance      Decimal       @default(0) @map("checkpoint_balance") @db.Decimal(18, 4)
  checkpointAt           DateTime?     @map("checkpoint_at")
  // ...
}

// In model JournalLine (schema.prisma):
model JournalLine {
  id          String           @id @default(uuid(7)) @db.Char(36)
  createdAt   DateTime         @default(now()) @map("created_at")
  updatedAt   DateTime         @updatedAt @map("updated_at")
  entryId     String           @map("entry_id") @db.Char(36)
  glAccountId String           @map("gl_account_id") @db.Char(36)
  direction   JournalDirection
  amount      Decimal          @db.Decimal(18, 4)

  entry     JournalEntry @relation(fields: [entryId], references: [id], onDelete: Restrict)
  glAccount GlAccount    @relation(fields: [glAccountId], references: [id], onDelete: Restrict)

  @@index([entryId])
  // Covering index ordered by monotonic UUIDv7 `id` for collision-free O(delta) checkpointing!
  @@index([glAccountId, id, direction, amount], map: "journal_lines_gl_account_id_cov_idx")
  @@map("journal_lines")
}
```

### 4.3 Drop-In Replacement for `LedgerPoster.ts` (2-Round-Trip Batch Posting + Deadlock-Free Atomic Balance Update)

Currently, `LedgerPoster.ts` executes 12–17 sequential queries per journal entry (looking up each GL account one by one and inserting each `JournalLine` one by one).
Replace the posting execution in `core-back/engine/ledger/LedgerPoster.ts` with:
1. **In-Memory Process Cache for System GL Account IDs** (`systemGlAccountCache` keyed by `accountType + gatewayId + credentialSetId + env + currency`), reducing GL account lookups on checkout confirm to **0 DB queries** (or 1 batched query on cold start).
2. **Single `journalLine.createMany` call** inserting all lines at once.
3. **Single Deadlock-Free Sorted `UPDATE gl_accounts` statement** updating `current_balance` and `lines_since_checkpoint` in canonical `id ASC` order:

```ts
// core-back/engine/ledger/LedgerPoster.ts — High-Scale Batch Poster
import { Prisma, type PrismaClient } from '@prisma/client';
import { uuidv7 } from 'uuidv7';

export interface ResolvedPostingLine {
  glAccountId: string;
  direction: 'DEBIT' | 'CREDIT';
  /** Signed delta in minor units or Decimal(18,4): +amount for DEBIT, -amount for CREDIT */
  amountDecimal: Prisma.Decimal;
}

export async function postBalancedJournalEntryFast(
  tx: Prisma.TransactionClient,
  params: {
    refType: any;
    refId: string;
    description: string;
    lines: ResolvedPostingLine[];
  }
): Promise<{ entryId: string; lastLineIdByAccount: Map<string, string> }> {
  const entryId = uuidv7();
  const now = new Date();

  // 1. Insert the JournalEntry header (1 round-trip)
  await tx.journalEntry.create({
    data: {
      id: entryId,
      refType: params.refType,
      refId: params.refId,
      description: params.description,
      createdAt: now,
      updatedAt: now,
    },
  });

  // 2. Prepare all JournalLines with monotonic UUIDv7 IDs and insert in ONE batch (1 round-trip)
  const netDeltaByAccount = new Map<string, { delta: Prisma.Decimal; count: number }>();
  const lastLineIdByAccount = new Map<string, string>();

  const lineRows = params.lines.map((line) => {
    const lineId = uuidv7();
    const signedDelta =
      line.direction === 'DEBIT' ? line.amountDecimal : line.amountDecimal.negated();
    const prev = netDeltaByAccount.get(line.glAccountId) ?? {
      delta: new Prisma.Decimal(0),
      count: 0,
    };
    netDeltaByAccount.set(line.glAccountId, {
      delta: prev.delta.add(signedDelta),
      count: prev.count + 1,
    });
    lastLineIdByAccount.set(line.glAccountId, lineId);

    return {
      id: lineId,
      entryId,
      glAccountId: line.glAccountId,
      direction: line.direction,
      amount: line.amountDecimal,
      createdAt: now,
      updatedAt: now,
    };
  });

  await tx.journalLine.createMany({ data: lineRows });

  // 3. Sort glAccountIds lexicographically (ASC) so concurrent transactions ALWAYS lock
  //    GL accounts in the exact same order — 100% immune to AB-BA deadlocks!
  const sortedAccountIds = Array.from(netDeltaByAccount.keys()).sort();

  const balanceCases: Prisma.Sql[] = [];
  const countCases: Prisma.Sql[] = [];
  const idList: Prisma.Sql[] = [];

  for (const accId of sortedAccountIds) {
    const { delta, count } = netDeltaByAccount.get(accId)!;
    balanceCases.push(Prisma.sql`WHEN ${accId} THEN ${delta}`);
    countCases.push(Prisma.sql`WHEN ${accId} THEN ${count}`);
    idList.push(Prisma.sql`${accId}`);
  }

  // 4. Single atomic SQL UPDATE across all touched GL accounts (1 round-trip)
  await tx.$executeRaw`
    UPDATE gl_accounts
    SET current_balance = current_balance + CASE id ${Prisma.join(balanceCases, ' ')} ELSE 0 END,
        lines_since_checkpoint = lines_since_checkpoint + CASE id ${Prisma.join(countCases, ' ')} ELSE 0 END,
        updated_at = ${now}
    WHERE id IN (${Prisma.join(idList, ', ')})
  `;

  return { entryId, lastLineIdByAccount };
}
```

### 4.4 Collision-Free UUIDv7 Incremental Checkpointing & O(1) `InvariantVerifier`

Because `JournalLine.id` is a time-ordered `uuid(7)` and we added the **covering index** `@@index([glAccountId, id, direction, amount])`:
1. **Every Wallet & Merchant Balance Read (`GET /wallets/:id/balance`, `merchantOps.ts`, `GovernanceExecution.ts` receivable ceiling):**
   - Simply reads `gl_accounts.current_balance` via primary key (`SELECT current_balance FROM gl_accounts WHERE id = ?`) — **0 joins, 0 row scans, `< 0.15ms` execution time even at 300,000,000 journal lines!**
   - Fixes the double-counting bug in `lib/merchantOps.ts:197-208` permanently!
2. **Continuous Incremental Checkpoint Advancement (`CheckpointService.ts`):**
   - Instead of scanning all lines from the beginning of time, `CheckpointService` queries only accounts with `lines_since_checkpoint >= 500` and computes the delta using `l.id > g.last_checkpoint_id` (never `l.created_at > g.checkpoint_at`!):
   ```sql
   SELECT
     g.id AS gl_account_id,
     g.checkpoint_balance,
     g.current_balance,
     MAX(l.id) AS max_line_id,
     COUNT(l.id) AS delta_count,
     COALESCE(SUM(CASE WHEN l.direction = 'DEBIT' THEN l.amount ELSE -l.amount END), 0) AS delta_sum
   FROM gl_accounts g
   LEFT JOIN journal_lines l
     ON l.gl_account_id = g.id
    AND (g.last_checkpoint_id IS NULL OR l.id > g.last_checkpoint_id)
   WHERE g.lines_since_checkpoint > 0
   GROUP BY g.id, g.checkpoint_balance, g.current_balance;
   ```
   - Look at that query plan:
     - Accounts with `lines_since_checkpoint = 0` (99% of idle merchant wallets in any given minute) are **skipped completely**!
     - For active accounts, `l.gl_account_id = g.id AND l.id > g.last_checkpoint_id` performs a narrow **Index-Only range scan** (`Using index`) on `journal_lines_gl_account_id_cov_idx` over at most the few hundred lines posted since the last checkpoint!
     - It simultaneously verifies that `g.checkpoint_balance + delta_sum === g.current_balance` AND that `SUM(g.current_balance) === 0.0000 LYD` across the entire ledger in **`< 5ms`**!

## 5. Pillar 4 — O(1) Materialized Rolling Counters (Killing Runtime `SUM()` Scans in Checkout & Dashboards)

To make `/pay/:linkKey`, `POST /initiate`, and `/stats/overview` run in `< 5ms` at 50M rows, **no hot endpoint may ever execute a `SUM()` or `COUNT()` scan over `payment_attempts`**. We introduce three lightweight Materialized Counter Tables in `schema.prisma`:

### 5.1 Table 1: `RouteDailyVolume` (`route_daily_volumes`) — O(1) Daily Cap Enforcement

Replaces `dailyProcessedAmountByRoute` (`repositories.ts:502-511`) which currently scans `payment_attempts` on every checkout page view and every initiate:

```prisma
model RouteDailyVolume {
  routeId            String   @map("route_id") @db.Char(36)
  dayBucket          String   @map("day_bucket") @db.Char(10) // 'YYYY-MM-DD' in gateway timezone
  succeededCount     Int      @default(0) @map("succeeded_count")
  totalChargedAmount Decimal  @default(0) @map("total_charged_amount") @db.Decimal(18, 4)
  updatedAt          DateTime @updatedAt @map("updated_at")

  @@id([routeId, dayBucket])
  @@index([dayBucket])
  @@map("route_daily_volumes")
}
```

- **Write Path (on Attempt Transition to `SUCCEEDED`):**
  ```sql
  INSERT INTO route_daily_volumes (route_id, day_bucket, succeeded_count, total_charged_amount, updated_at)
  VALUES (?, ?, 1, ?, NOW(3))
  ON DUPLICATE KEY UPDATE
    succeeded_count = succeeded_count + 1,
    total_charged_amount = total_charged_amount + VALUES(total_charged_amount),
    updated_at = NOW(3);
  ```
- **Read Path (in `VisibleRailsCatalog.ts`):**
  - `SELECT route_id, total_charged_amount FROM route_daily_volumes WHERE day_bucket = ?` (cached in memory for 10s). Scans at most **20–40 rows** (`0.1ms`) instead of scanning hundreds of thousands of `payment_attempts`!

### 5.2 Table 2: `VelocityWindowBucket` (`velocity_window_buckets`) — O(1) Velocity & AML Cumulative Window Evaluation

Replaces the per-rule `paymentAttempt.findMany` scans (`AttemptGuardPipeline.ts:1144-1255`) and the AML 24-hour cumulative window scan (`repositories.ts:479-501`):

```prisma
model VelocityWindowBucket {
  scopeType          VelocityScopeType @map("scope_type")
  scopeHash          String            @map("scope_hash") @db.Char(64)
  /** 5-minute epoch bucket: Math.floor(unixSeconds / 300) * 300 */
  bucketEpoch        Int               @map("bucket_epoch")
  attemptCount       Int               @default(0) @map("attempt_count")
  succeededCount     Int               @default(0) @map("succeeded_count")
  totalAmount        Decimal           @default(0) @map("total_amount") @db.Decimal(18, 4)
  expiresAt          DateTime          @map("expires_at")

  @@id([scopeType, scopeHash, bucketEpoch])
  @@index([expiresAt])
  @@map("velocity_window_buckets")
}
```

- **How It Works:**
  1. When a payer initiates a payment, we compute the 7 scope hashes in memory:
     - `END_CLIENT_IP`: `sha256(clientIp)`
     - `END_CLIENT_PHONE`: `sha256(normalizedPhone)`
     - `END_CLIENT_CARD`: `sha256(cardAlias)`
     - `MERCHANT`: `merchantId`
     - `APPLICATION`: `applicationId`
     - `RAIL`: `railId`
     - `LINK`: `linkId`
  2. To evaluate **ALL** active velocity rules (whether 5-minute, 1-hour, or 24-hour windows) AND the 24-hour AML cumulative structuring rule simultaneously, `AttemptGuardPipeline` executes **ONE single indexed query** against `velocity_window_buckets`:
     ```sql
     SELECT scope_type, scope_hash, bucket_epoch, attempt_count, succeeded_count, total_amount
     FROM velocity_window_buckets
     WHERE (scope_type, scope_hash) IN (
       ('END_CLIENT_IP', ?), ('END_CLIENT_PHONE', ?), ('END_CLIENT_CARD', ?),
       ('MERCHANT', ?), ('APPLICATION', ?), ('RAIL', ?), ('LINK', ?)
     )
       AND bucket_epoch >= ?;
     ```
  3. Because `(scope_type, scope_hash, bucket_epoch)` is the **Clustered Primary Key**, InnoDB performs 7 contiguous leaf-page range dives and returns the exact counts and sums in **`< 0.4ms`** — even if the merchant has processed **50,000,000 historical transactions**!
  4. When the attempt is created, a single multi-row `INSERT INTO velocity_window_buckets ... ON DUPLICATE KEY UPDATE attempt_count = attempt_count + 1, total_amount = total_amount + VALUES(total_amount)` increments all 7 buckets in `< 0.3ms`.

### 5.3 Table 3: `MerchantDailyStat` (`merchant_daily_stats`) — Instant `< 1ms` Merchant & Admin Analytics Dashboards

Replaces the broken `take: 1000` JS aggregation in `GET /internal/merchant/stats/overview` (`merchant.ts:1410-1416`) and admin volume charts:

```prisma
model MerchantDailyStat {
  merchantId               String   @map("merchant_id") @db.Char(36)
  dayBucket                String   @map("day_bucket") @db.Char(10) // 'YYYY-MM-DD'
  railCode                 String   @map("rail_code") @db.VarChar(64)
  initiatedCount           Int      @default(0) @map("initiated_count")
  succeededCount           Int      @default(0) @map("succeeded_count")
  failedCount              Int      @default(0) @map("failed_count")
  expiredCount             Int      @default(0) @map("expired_count")
  refundedCount            Int      @default(0) @map("refunded_count")
  disputedCount            Int      @default(0) @map("disputed_count")
  grossSucceededAmount     Decimal  @default(0) @map("gross_succeeded_amount") @db.Decimal(18, 4)
  platformCommissionAmount Decimal  @default(0) @map("platform_commission_amount") @db.Decimal(18, 4)
  netMerchantAmount        Decimal  @default(0) @map("net_merchant_amount") @db.Decimal(18, 4)
  updatedAt                DateTime @updatedAt @map("updated_at")

  @@id([merchantId, dayBucket, railCode])
  @@index([dayBucket, railCode])
  @@map("merchant_daily_stats")
}
```

## 6. Pillar 5 — Lock-Free Atomic Checkout & Initiate Pipeline Surgery (`50 RT -> 4 RT`)

### 6.1 Why `SELECT ... FOR UPDATE` on `payment_links` Is the #1 Concurrency Killer

In `checkout.ts:1111` and `repositories.ts:404-407`, `POST /pay/:linkKey/initiate` opens an interactive transaction and immediately runs:
```sql
SELECT * FROM payment_links WHERE `key` = ? FOR UPDATE;
```
While holding that exclusive row lock on `payment_links`, it executes **40 to 55 sequential database round-trips** (resolving merchant, application, routes, credentials, commission profiles, platform settings, velocity rules, AML cumulative windows, and audit logs).
- If a merchant creates an `infiniteUse = true` payment link (e.g., an e-commerce store checkout button or utility bill portal) and 100 customers click "Pay" concurrently, **all 100 requests queue behind that single row lock**! Even at 25ms per transaction, the 100th customer waits 2.5 seconds just to acquire the lock.

### 6.2 The Two-Phase Lock-Free Initiate Architecture (4 Round-Trips Total)

We restructure `POST /pay/:linkKey/initiate` into **Phase A (Lock-Free Pre-Evaluation)** and **Phase B (Sub-Millisecond Atomic Commit)**:

```text
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ PHASE A: LOCK-FREE PRE-EVALUATION (0 Locks Held, ~1–2 DB Round-Trips Total)          │
│  1. Memory Cache Reads (0 DB queries in steady state):                               │
│     • RailCatalogCache (rails, routes, credential_sets, commission_profiles)         │
│     • PlatformSettingsCache (all platform_settings keys in 1 Map)                    │
│     • ActiveVelocityRulesCache & ActiveAmlRulesCache (30s TTL + bus invalidation)    │
│     • SystemGlAccountsCache (GL account IDs by type/gateway/env)                     │
│  2. Parallel Point Read (1 Promise.all batch outside transaction):                   │
│     • Fetch PaymentLink + Application + Merchant + Wallet + GlAccount (1 JOIN query) │
│     • Check Idempotency Key on payment_attempts (1 indexed lookup)                   │
│     • Fetch VelocityWindowBuckets for all 7 scopes (1 clustered PK range query)      │
│  3. Pure CPU Guard Pipeline Evaluation (< 0.2ms):                                    │
│     • Evaluate merchant status, receivable ceiling (from gl_accounts.currentBalance),│
│       route selection, fee calculation, velocity thresholds, and AML rules in RAM!   │
└─────────────────────────────────────────┬────────────────────────────────────────────┘
                                          │
                                          ▼
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ PHASE B: ATOMIC RESERVATION & INSERT TRANSACTION (< 1.5ms Lock Window, 2–3 Queries) │
│  1. Atomic Conditional Slot Reservation (1 UPDATE statement — NO prior FOR UPDATE):  │
│     • If infinite_use = true:                                                        │
│       UPDATE payment_links SET active_locked_count = active_locked_count + 1         │
│       WHERE id = ? AND state = 'PENDING' AND (expires_at IS NULL OR expires_at > ?)  │
│     • If infinite_use = false:                                                       │
│       UPDATE payment_links SET active_locked_count = active_locked_count + 1         │
│       WHERE id = ? AND state = 'PENDING' AND (expires_at IS NULL OR expires_at > ?)  │
│         AND (confirmed_count + active_locked_count) < use_count                      │
│     • If affectedRows === 0 -> throw ConflictError('LINK_UNAVAILABLE_OR_EXHAUSTED')  │
│  2. Insert PaymentAttempt + Upsert VelocityWindowBuckets (batched in parallel)       │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

### 6.3 Drop-In Atomic Slot Claim Implementation (`core-back/engine/runtime/slotStore.ts`)

Replace the `SELECT ... FOR UPDATE` + separate `UPDATE` in `slotStore.ts` / `repositories.ts` with a single atomic conditional `UPDATE`:

```ts
// core-back/engine/runtime/slotStore.ts
import { Prisma, type PrismaClient } from '@prisma/client';

export async function claimPaymentLinkSlotAtomic(
  tx: Prisma.TransactionClient,
  params: {
    linkId: string;
    now: Date;
  }
): Promise<boolean> {
  // Single atomic statement: checks state, expiry, and slot capacity AND increments active_locked_count!
  // Holds the InnoDB row lock for < 0.2ms right before transaction commit.
  const affected = await tx.$executeRaw`
    UPDATE payment_links
    SET active_locked_count = active_locked_count + 1,
        updated_at = ${params.now}
    WHERE id = ${params.linkId}
      AND state = 'PENDING'
      AND (expires_at IS NULL OR expires_at > ${params.now})
      AND (
        infinite_use = 1
        OR (confirmed_count + active_locked_count) < use_count
      )
  `;

  return Number(affected) === 1;
}

export async function releaseOrConfirmPaymentLinkSlotAtomic(
  tx: Prisma.TransactionClient,
  params: {
    linkId: string;
    outcome: 'CONFIRMED' | 'RELEASED';
    now: Date;
  }
): Promise<void> {
  if (params.outcome === 'CONFIRMED') {
    await tx.$executeRaw`
      UPDATE payment_links
      SET active_locked_count = GREATEST(0, active_locked_count - 1),
          confirmed_count = confirmed_count + 1,
          state = CASE
            WHEN infinite_use = 0 AND (confirmed_count + 1) >= use_count THEN 'COMPLETED'
            ELSE state
          END,
          updated_at = ${params.now}
      WHERE id = ${params.linkId}
    `;
  } else {
    await tx.$executeRaw`
      UPDATE payment_links
      SET active_locked_count = GREATEST(0, active_locked_count - 1),
          updated_at = ${params.now}
      WHERE id = ${params.linkId}
    `;
  }
}
```

## 7. Pillar 6 — Unified Search Token Index (`entity_search_tokens`) & O(1) Keyset List Pagination

### 7.1 Why 20-Table `LIKE '%q%'` Global Search & List `contains` Fail at 10M+ Rows

Even with `startsWith` on primary identifiers, users in `admin-front` search by:
- Partial trade names in Arabic or English (`"طرابلس"`, `"Almadar"`, `"Supermarket"`),
- Local or international phone formats (`0912345678` vs `+218912345678`),
- Email addresses or domains (`@libyana.ly`),
- External provider/gateway/network references (`PROV-99182`, `EDF-8821`),
- KYB document SHA-256 hashes or filenames.

Running `WHERE col1 LIKE '%q%' OR col2 LIKE '%q%'` across 20 tables forces 20 full table scans.

### 7.2 The Unified `EntitySearchToken` (`entity_search_tokens`) Architecture

We introduce a dedicated, normalized **Inverted Token Index Table (`entity_search_tokens`)** in `schema.prisma`:

```prisma
model EntitySearchToken {
  token           String   @db.VarChar(128)
  entityType      String   @map("entity_type") @db.VarChar(32)
  entityId        String   @map("entity_id") @db.Char(36)
  merchantId      String?  @map("merchant_id") @db.Char(36)
  /** 1 if token came from taxId / registrationNo (filtered out unless hasMerchantSensitiveAccess) */
  isSensitive     Boolean  @default(false) @map("is_sensitive")
  /** 1000 = exact identifier/ref/code/email/phone, 800 = primary name token, 500 = secondary token */
  baseWeight      Int      @default(800) @map("base_weight")
  title           String   @db.VarChar(255)
  subtitle        String?  @db.VarChar(255)
  reference       String?  @db.VarChar(128)
  status          String?  @db.VarChar(64)
  operatorCaseId  String?  @map("operator_case_id") @db.Char(36)
  entityCreatedAt DateTime @map("entity_created_at")

  @@id([token, entityType, entityId])
  @@index([entityType, token, entityCreatedAt(sort: Desc)], map: "est_type_token_created_idx")
  @@index([entityType, entityId], map: "est_entity_lookup_idx")
  @@map("entity_search_tokens")
}
```

#### How `entity_search_tokens` Makes Global Search Run in `< 2ms` at 100M Rows:

1. **Tokenizer (`core-back/lib/search/tokenizer.ts`):**
   - When a record in any of the 20 searchable models is created or updated (or bulk-seeded), `extractEntitySearchTokens(entityType, row)` emits 3 to 8 normalized lowercase tokens:
     - Exact IDs, references (`our_reference`, `provider_reference`, `network_reference`, `gateway_reference`), codes, SHA-256 prefix (16 chars), email full + domain part, and normalized phone variants (`091...` and `21891...`) with `baseWeight = 1000`.
     - Individual words (`>= 2 chars`) of `tradeName`, `legalName`, `displayName`, `fileName`, `triggerReason` with `baseWeight = 800`.
     - Sensitive tokens (`taxId`, `registrationNo`) tagged with `isSensitive = true`.
2. **Single-Query Global Search Fast Path (`executeGlobalSearchFastPath`):**
   - Instead of firing 20 separate queries across 20 tables, `executeGlobalSearch` first queries `entity_search_tokens`:
   ```sql
   SELECT
     entity_type, entity_id, merchant_id, is_sensitive, base_weight,
     title, subtitle, reference, status, operator_case_id, entity_created_at,
     CASE WHEN token = ? THEN base_weight + 200 ELSE base_weight END AS match_score
   FROM entity_search_tokens
   WHERE token LIKE CONCAT(?, '%')
     AND entity_type IN (...) -- pre-filtered by plugin.canAccess(actor)!
     AND (is_sensitive = 0 OR ? = 1)
   ORDER BY match_score DESC, entity_created_at DESC
   LIMIT 150;
   ```
   - Because `PRIMARY KEY (token, entity_type, entity_id)` starts with `token` (and `est_type_token_created_idx` starts with `(entity_type, token)`), `token LIKE 'q%'` is a pure **B-Tree range scan** that completes in **`< 2ms` even with 200,000,000 token rows**!
   - The returned rows are grouped by `entity_type` in canonical `SearchProviderRegistry` order, deduplicated by `entity_id`, and sliced to `limit` per group!

### 7.3 Materialized `KybDocumentHashStat` (Killing the Full-Table `GROUP BY sha256 HAVING COUNT(DISTINCT merchant_id) > 1`)

In `admin.ts:3113-3115` and `:3265`, the compliance duplicate-document detector currently runs:
```sql
SELECT sha256 FROM kyb_documents GROUP BY sha256 HAVING COUNT(DISTINCT merchant_id) > 1
```
on every request! At 500,000 KYB documents, that scans and sorts the entire table.
We replace it with a tiny materialized table `kyb_document_hash_stats`:

```prisma
model KybDocumentHashStat {
  sha256        String   @id @db.Char(64)
  docCount      Int      @default(1) @map("doc_count")
  merchantCount Int      @default(1) @map("merchant_count")
  firstSeenAt   DateTime @default(now()) @map("first_seen_at")
  updatedAt     DateTime @updatedAt @map("updated_at")

  @@index([merchantCount, updatedAt(sort: Desc)], map: "kdhs_merchant_count_idx")
  @@map("kyb_document_hash_stats")
}
```

Finding all duplicate KYB documents across unrelated merchants becomes an instant index scan:
`WHERE merchant_count > 1 ORDER BY updated_at DESC` (`< 0.1ms`)!

### 7.4 Universal Keyset Cursor Pagination + Windowed Count Estimator (`core-back/lib/listQuery.ts`)

At 10,000,000 rows in `payment_attempts` or `audit_log`:
1. **`OFFSET` (`skip`) is capped at 1,000 rows** and supplemented with **Opaque Keyset Cursor Pagination (`?cursor=<base64url>`)** backed by `(created_at DESC, id DESC)`:
   ```ts
   export interface KeysetCursorPayload {
     c: string; // ISO createdAt
     i: string; // UUIDv7 id
   }

   export function encodeKeysetCursor(row: { createdAt: Date | string; id: string }): string {
     const c = row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt);
     return Buffer.from(JSON.stringify({ c, i: row.id }), 'utf8').toString('base64url');
   }

   export function decodeKeysetCursor(raw?: string | null): KeysetCursorPayload | null {
     if (!raw) return null;
     try {
       const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
       if (typeof parsed?.c === 'string' && typeof parsed?.i === 'string') return parsed;
       return null;
     } catch {
       return null;
     }
   }

   export function buildKeysetWhere(cursor: KeysetCursorPayload | null, direction: 'desc' | 'asc' = 'desc') {
     if (!cursor) return {};
     const op = direction === 'desc' ? 'lt' : 'gt';
     const dt = new Date(cursor.c);
     return {
       OR: [
         { createdAt: { [op]: dt } },
         { createdAt: dt, id: { [op]: cursor.i } },
       ],
     };
   }
   ```
2. **Bounded Count Strategy (Eliminating 10M-Row `COUNT(*)` Scans on Every List Call):**
   - Instead of running an unbounded `SELECT COUNT(*) FROM payment_attempts WHERE ...` on every table load:
     - First, cache `COUNT` results in memory for `15s` keyed by `(modelName, stableWhereHash)`.
     - Second, execute a **Bounded Window Count (`LIMIT 10001`)**:
       ```sql
       SELECT COUNT(*) AS cnt FROM (
         SELECT 1 FROM payment_attempts WHERE ... LIMIT 10001
       ) AS bounded_sub;
       ```
       If `cnt > 10000`, the API returns `{ total: 10000, totalIsCapped: true }` (which renders as `"10,000+"` in `DataTable.tsx`) so **no list query can ever scan more than 10,001 index entries to compute a page count**!

## 8. Pillar 7 — Dual-Pool Bulkhead Isolation, Multi-Node Cache Bus & Event-Driven Workers

### 8.1 Dual-Pool Bulkhead Isolation (`core-back/prisma/client/index.ts`)

Never allow background workers, statement reconciliations, or slow admin exports to share the same connection pool as live customer checkouts!
Configure **two isolated MariaDB pools** in `core-back/prisma/client/base.ts`:

```ts
// core-back/prisma/client/base.ts
import { PrismaClient } from '../../generated/prisma';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { buildMariaDbPoolConfig } from '../../lib/db/connectionConfig';

/**
 * Pool 1: Hot Transactional API Pool (Checkout, Merchant API, Interactive Admin Mutations)
 * - 40 connections, fast 3,000ms acquire timeout so stuck connections fail fast.
 */
export const dbTransactional = new PrismaClient({
  adapter: new PrismaMariaDb(
    buildMariaDbPoolConfig(process.env.DATABASE_URL!, {
      defaultConnectionLimit: Number(process.env.DB_TRANSACTIONAL_POOL_SIZE ?? 40),
      defaultAcquireTimeoutMs: 3_000,
    })
  ),
});

/**
 * Pool 2: Background Worker, Reconciliation, Analytics & Export Pool
 * - 15 connections, 15,000ms acquire timeout.
 * - Completely isolated from dbTransactional: even if all 10 workers and a 50k-row
 *   statement ingest saturate dbBackground, customer checkouts on dbTransactional have 40 dedicated connections!
 */
export const dbBackground = new PrismaClient({
  adapter: new PrismaMariaDb(
    buildMariaDbPoolConfig(process.env.DATABASE_BACKGROUND_URL ?? process.env.DATABASE_URL!, {
      defaultConnectionLimit: Number(process.env.DB_BACKGROUND_POOL_SIZE ?? 15),
      defaultAcquireTimeoutMs: 15_000,
    })
  ),
});
```

### 8.2 Single-Flight Config Caches + Zero-Dependency Cross-Node Invalidation (`core-back/lib/cache/ConfigCacheRegistry.ts`)

Wire the `InvalidationBus` (`lib/invalidationBus/index.ts`) to a lightweight single-row/ring-buffer MariaDB table `cache_invalidation_events (id BIGINT AUTO_INCREMENT PK, topic VARCHAR(64), payload_key VARCHAR(128), created_at DATETIME(3))` polled once every 2 seconds on `dbBackground` (or Redis pub/sub when `REDIS_URL` is configured), and cache all declarative config in RAM:

| Cache Instance | TTL | Keys Cached | Queries Saved |
| :--- | :--- | :--- | :--- |
| **`railCatalogCache`** | `60s` + `rail:*` / `gateway:*` bus | All `Rail`, `RailField`, `RailRoute`, `Gateway`, `GatewayVersion` (`LIVE`), `CredentialSet`, `CommissionProfile` | **−5 to −10 queries** per checkout page view & initiate |
| **`flowDefinitionCache`** | `300s` + `flow:*` / `gateway:*` bus | `Flow`, `FlowStep`, `StepParameter`, `StepOutput`, `StatusRule`, `ErrorMap`, `CryptoProfile` per `(gatewayVersionId, phase)` | **−4 to −8 queries** per initiate, submit, and verify phase |
| **`platformSettingsCache`** | `30s` + `settings:*` bus | Complete `Map<string, Json>` of all `PlatformSetting` rows | **−3 to −5 queries** per initiate & worker tick |
| **`activeRulesCache`** | `30s` + `rules:*` bus | Active `VelocityRule[]`, `AmlRule[]`, and `ReportingRule[]` | **−2 to −3 queries** per initiate |
| **`systemGlAccountsCache`** | `300s` + `gl:*` bus | `Map<string, string>` mapping system GL account key → `id` | **−4 to −10 queries** per ledger entry post |
| **`notificationTemplateCache`** | `300s` + `template:*` bus | `Map<string, NotificationTemplate>` by `${code}:${channel}:${lang}` | **−1 query** per notification sent |
| **`principalSessionCache`** | `30s` + `auth:*` bus | Verified `User` / `AccessToken` + whitelisted `AccessTokenIp[]` | **−1 to −2 reads + −1 write** on every authenticated API call |

### 8.3 Transactional Worker Claims & SSE Event Push

1. **Fix All 5 Non-Transactional `FOR UPDATE SKIP LOCKED` Workers:**
   - In `PollWorker.ts`, `ExpirySweeperWorker.ts`, `InboundInboxWorker.ts`, `OutboxNotificationWorker.ts`, and `PeriodicScreeningWorker.ts`, wrap the `SELECT id ... FOR UPDATE SKIP LOCKED` and the state/lease transition (`UPDATE ... WHERE id IN (...)`) inside a single `dbBackground.$transaction()` so two worker nodes can never claim and execute the same outbound HTTP inquiry or webhook simultaneously.
   - Never `SELECT *` on `inbound_events` or `reconciliation_runs` — select only `id, channel_id, gateway_id, attempt_id, received_at` during claim!
2. **Convert Checkout SSE & POS Screen Polling to Event-Driven Push (`checkout.ts:1290-1335`):**
   - Subscribe each connected SSE client to `invalidationBus.subscribe(`attempt:${attemptId}`)` for instant `< 5ms` push when an attempt transitions, and drop the fallback DB poll interval from `2s` to `15s` (reducing SSE database load by **87%**).

## 9. Pillar 8 — Turbocharging the Synthetic Seeder (`STANDARD` in `< 18s`, `STRESS` in `< 75s`)

Apply these 5 surgical fixes in `core-back/prisma/syntheticSeeder/`:

1. **Eliminate All 3,500 Sequential Round-Trips in `enrichKybDocuments.ts`:**
   - Move `vault.encryptSecret()` directly into `02_merchantCohortGenerator.ts` (Phase 1 in-memory generation) so `kyb_documents` are bulk-inserted with their final ciphertext in `bulkMysqlWriter.ts`.
   - Compute missing required document types and `nextKybReviewAt` dates in Phase 1 before `bulkMysqlWriter.ts` runs.
2. **Replace All 1,615 Post-Write Fixup Loops in `bulkMysqlWriter.ts` with 2 Set-Based SQL Statements:**
   ```sql
   UPDATE disputes d
   INNER JOIN adjustments a ON a.dispute_id = d.id
   SET d.adjustment_id = a.id
   WHERE d.adjustment_id IS NULL;
   ```
   And compute `gl_accounts.current_balance`, `checkpoint_balance`, `last_checkpoint_id`, and `lines_since_checkpoint` directly in `05_ledgerAndCheckpoints.ts` in memory so `gl_accounts` are inserted/updated in a single bulk chunk!
3. **Populate the New High-Scale Materialized Tables in `bulkMysqlWriter.ts`:**
   - Bulk-insert `route_daily_volumes`, `merchant_daily_stats`, `kyb_document_hash_stats`, `velocity_window_buckets` (for the active 24h window around `T_NOW`), and `entity_search_tokens` using 2,500-row `createMany` chunks.
4. **Replace All O(N×M) `Array.prototype.find()` Calls in Generators with `Map` Index Lookups:**
   - In `04_linksAndAttemptsGenerator.ts`, `07_disputesCashoutsAdjustments.ts`, and `08_amlAndGovernanceQueues.ts`, pre-index `paymentAttemptsById`, `applicationsById`, `gatewayVersionsById`, and `merchantsById` as `Map<string, T>` before the loop — eliminating **108,000,000 array iterations** in `STANDARD` and **2,000,000,000 iterations** in `STRESS`.
5. **Parallelize `fakeRailsBulkSyncClient.ts` with Concurrency = 4 & Single NDJSON Stream:**
   - Stream batches of 10,000 rows over 4 concurrent HTTP workers without double-serializing JSON strings.

## 10. Pillar 9 — MariaDB 10.11+ Production Configuration & Automated Query-Budget Guardrail

### 10.1 Production `/etc/mysql/conf.d/zz-payment-gateway.cnf` (`deploy/deploy.ts`)

Update `deploy/deploy.ts` (lines 417–423) to write the full high-throughput financial ledger configuration:

```ini
[mysqld]
# 1. Functions & Triggers
log_bin_trust_function_creators = 1
character_set_server            = utf8mb4
collation_server                = utf8mb4_unicode_ci

# 2. InnoDB Buffer Pool & Memory (Size to 65% of host RAM; 4G minimum for staging, 16G–64G for prod)
innodb_buffer_pool_size         = 4G
innodb_buffer_pool_instances    = 4
innodb_log_file_size            = 1G
innodb_log_buffer_size          = 64M
tmp_table_size                  = 128M
max_heap_table_size             = 128M

# 3. Strict Financial ACID Durability & Direct I/O
innodb_flush_log_at_trx_commit  = 1
sync_binlog                     = 1
innodb_flush_method             = O_DIRECT
innodb_doublewrite              = 1

# 4. Concurrency, Connections & Lock Wait Protection
max_connections                 = 200
thread_handling                 = pool-of-threads
thread_pool_size                = 16
thread_cache_size               = 32
table_open_cache                = 6000
table_definition_cache          = 2000
innodb_lock_wait_timeout        = 10
innodb_deadlock_detect          = ON

# 5. SSD/NVMe I/O Capacity
innodb_io_capacity              = 2000
innodb_io_capacity_max          = 4000
innodb_read_io_threads          = 8
innodb_write_io_threads         = 8

# 6. Slow Query Telemetry (200ms threshold)
slow_query_log                  = ON
slow_query_log_file             = /var/log/mysql/slow.log
long_query_time                 = 0.200
log_slow_admin_statements       = ON
```

### 10.2 Automated Request Query-Budget Guardrail (`core-back/lib/db/queryBudgetTracker.ts`)

To guarantee that no future code change ever re-introduces a 50-query N+1 loop, wrap the Prisma adapter with `AsyncLocalStorage` query counting and enforce hard per-route budgets in CI/test mode:

| Route Pattern | Previous DB Queries / Request | New Strict CI Budget (Max Queries) | Steady-State Cached Queries |
| :--- | :--- | :--- | :--- |
| `GET /internal/checkout/pay/:linkKey` | ~12 queries (incl. full scan SUM) | **<= 4 queries** | **1 query** |
| `POST /internal/checkout/pay/:linkKey/initiate` | ~40–55 queries (inside lock!) | **<= 8 queries** | **4 queries** |
| `POST /internal/checkout/pay/:linkKey/confirm` | ~35–50 queries | **<= 8 queries** | **4 queries** |
| `GET /internal/merchant/wallets/:id/balance` | 2 + all journal lines ever | **<= 2 queries** | **1 PK read** |
| `GET /internal/merchant/stats/overview` | 1,000-row fetch + JS filter | **<= 2 queries** | **1 rollup scan** |
| `POST /internal/admin/search` | 20 multi-column `LIKE '%q%'` scans | **<= 3 queries** | **1 token index scan** |
| `GET /internal/admin/*` (Any List Endpoint) | 2 + N nested includes | **<= 3 queries** | **1–2 queries** |

## 11. Step-by-Step OpenCode Execution Order

Execute this optimization blueprint in 8 sequential, verifiable phases:

- [ ] **Phase 1 — `schema.prisma` Column Hygiene & High-Scale Tables:** Update `core-back/prisma/schema.prisma` to convert all 70+ identifier/code/reference/IP columns from `@db.Text` to `@db.VarChar(N)`, add `currentBalance` and `linesSinceCheckpoint` to `GlAccount`, add `RouteDailyVolume`, `VelocityWindowBucket`, `MerchantDailyStat`, `KybDocumentHashStat`, and `EntitySearchToken`, and apply the corrected migration `20261103000000_high_scale_architecture_and_indexes.sql`.
- [ ] **Phase 2 — Dual-Pool Bulkhead & Single-Flight Config Caches:** Implement `dbTransactional` (40 conns) + `dbBackground` (15 conns) in `core-back/prisma/client/base.ts`, build `ConfigCacheRegistry.ts` (`railCatalogCache`, `flowDefinitionCache`, `platformSettingsCache`, `activeRulesCache`, `systemGlAccountsCache`, `notificationTemplateCache`, `principalSessionCache`), and wire `authDoubleCheck.ts` (throttled `lastUsedAt` + conditional `ips`).
- [ ] **Phase 3 — O(1) Materialized Ledger & UUIDv7 Checkpointing:** Upgrade `LedgerPoster.ts` to batch-insert `journal_lines` and atomically update `gl_accounts.current_balance` in sorted `id ASC` order; rewrite `merchant.ts` balance endpoint, `merchantOps.ts`, `CheckpointService.ts`, and `InvariantVerifier.ts` to use `current_balance` and the collision-free `l.id > g.last_checkpoint_id` covering index.
- [ ] **Phase 4 — Lock-Free Checkout Initiate & Rolling Counter Tables:** Wire `RouteDailyVolume`, `VelocityWindowBucket`, and `MerchantDailyStat` into the attempt lifecycle; refactor `AttemptGuardPipeline.ts` and `checkout.ts` so all config/velocity/AML reads happen before the transaction and `claimPaymentLinkSlotAtomic` executes a single conditional `UPDATE` at commit time.
- [ ] **Phase 5 — Unified Search Token Index & Keyset List Pagination:** Populate `entity_search_tokens` on entity write, wire the single-query token index fast path in `core-back/lib/globalSearch.ts`, add keyset cursor pagination (`encodeKeysetCursor`/`decodeKeysetCursor`) + bounded `LIMIT 10001` counts in `lib/listQuery.ts`, and replace the KYB SHA-256 duplicate scan with `kyb_document_hash_stats`.
- [ ] **Phase 6 — Workers, Statement Ingestor & SSE Push:** Switch all 10 workers and `StatementIngestor.ts` to `dbBackground`, wrap all 5 `SKIP LOCKED` worker claims in transactions (selecting only non-blob columns), chunk `StatementIngestor.ts` into 500-row batches with prefetching and `timeout: 30_000`, and wire checkout/POS SSE streams to `invalidationBus`.
- [ ] **Phase 7 — Synthetic Seeder Turbocharging:** Move KYB encryption into Phase 1, replace post-write loops in `bulkMysqlWriter.ts` with set-based SQL + bulk seeding of the 5 new materialized tables, replace `Array.find` with `Map` lookups across generators `04`, `07`, and `08`, and parallelize `fakeRailsBulkSyncClient.ts` (`CONCURRENCY = 4`).
- [ ] **Phase 8 — MariaDB Production Config & Query-Budget CI Gate:** Update `deploy/deploy.ts` with the production `zz-payment-gateway.cnf`, add `queryBudgetTracker.ts`, and verify all `EXPLAIN ANALYZE` plans and query-budget assertions pass on the seeded database.

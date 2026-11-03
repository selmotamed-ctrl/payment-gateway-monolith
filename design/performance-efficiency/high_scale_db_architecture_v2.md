# DATABASE & HIGH-SCALE ARCHITECTURE PLAN v2 — REVIEW OF v1 + A SAFE REPLACEMENT

**Repository:** `selmotamed-ctrl/payment-gateway-monolith` (`core-back`, `deploy`)
**Replaces:** `high_scale_performance_and_schema_architecture_plan.md` and `20261103000000_high_scale_architecture_and_indexes.sql`
**Based on:** those two files and the attached `schema.prisma` (77 models). I have **not** seen the TypeScript code, the MariaDB version, the hardware or the real query shapes. Every place where that matters is marked **VERIFY** or **DECISION**.

---

## PART 0 — RULES FOR THE IMPLEMENTING AGENT

1. **No claim without a measurement.** Every phase starts and ends with the benchmark and `EXPLAIN ANALYZE` gates of Part 5. A number in a comment such as "< 2 ms" is a hypothesis until the harness prints it.
2. **Money correctness beats speed.** If an optimisation cannot be proven to keep the ledger equation at exactly `0.0000` under concurrent load and after `kill -9`, it is not done.
3. **Schema and SQL must agree.** `schema.prisma` is the single source of truth. After every migration, `prisma migrate diff --from-migrations … --to-schema-datamodel …` must print "No difference". Hand-added SQL (collations, partitions, generated columns) is allowed only where Prisma cannot express it, and each such statement is listed in `design/db_manual_sql.md` and checked by the lint test of §5.4.
4. **One concern per migration, idempotent, reversible by reset.** Use `IF [NOT] EXISTS` (MariaDB supports it on `ADD INDEX`, `DROP INDEX`, `ADD COLUMN`). MariaDB DDL is **not transactional**: a migration that fails halfway leaves a half-changed database.
5. **No agent decides a DECISION item.** Stop and write the question to `design/db_decisions_needed.md`; continue with the default stated.
6. **Do not touch** business behaviour: status machines, ledger entry shapes, maker-checker, AML logic. Only *how* they read and write data changes.

---

## PART 1 — VERDICT ON v1

### 1.1 What is good and is kept

| Keep | Why |
| :--- | :--- |
| Keep `(merchant_id, created_at)` on `payment_attempts` and **add** `(merchant_id, status, created_at)` | Correct: an index with `status` in the middle cannot serve `ORDER BY created_at` when `status` is not pinned. |
| Indexes on `provider_reference`, `gateway_reference`, `network_reference` | Real omissions. Webhook correlation and statement matching are full scans without them. |
| `@db.Text` → `VARCHAR(N)` on identifiers, references, codes | Correct. 93 `@db.Text` columns exist; most identifier-like ones should go. |
| Offloading `LONGBLOB` / large JSON (raw webhook bodies, statement files, audit before/after) | Correct, but **incompletely done** (see B1). |
| Dual connection pools (transactional vs background) | Correct and cheap. |
| Single atomic conditional `UPDATE` for the link slot | Correct, with the two fixes in §2.7. |
| Config caches for *declarative* configuration | Correct for the classes in §2.9, dangerous for others. |
| Keyset pagination, bounded counts, `FOR UPDATE SKIP LOCKED` inside a transaction | Correct. |
| Per-route query budget in CI | Correct and the best long-term guard in the whole plan. |

### 1.2 Blocking problems (v1 must not be implemented as written)

**B1. The SQL and `schema.prisma` disagree with each other and with the plan.** Found by comparing the two files:

| Item | SQL says | `schema.prisma` says |
| :--- | :--- | :--- |
| ID type | not changed | still 68 `VARCHAR(191)` ids, **0** `Char(36)` — the plan's "biggest hidden win" is not implemented anywhere |
| `inbound_event_payloads.event_id`, `audit_log_payloads.audit_log_id`, `reconciliation_run_files.run_id` | `CHAR(36)`, no foreign key | `VARCHAR(191)` with `onDelete: Cascade` foreign key to a `VARCHAR(191)` id |
| `entity_search_tokens.entity_id`, `route_daily_volumes.route_id` | `CHAR(36)` | `VARCHAR(191)` |
| `cache_invalidation_events` key column | `id` | `event_seq` |
| `payment_attempts.sub_mode` / `substatus` | `VARCHAR(32)` / `VARCHAR(64)` | `VARCHAR(64)` / `VARCHAR(96)` |
| `inbound_events.processing_result` | `VARCHAR(64)` | `VARCHAR(191)` |
| `detail_change_logs.request_id`, `field_name` | `VARCHAR(64)`, `VARCHAR(128)` | `VARCHAR(191)` |
| `terminal_effective_at` generated column and its covering index | created | **not in the schema**; the schema's index uses `terminal_at` instead |
| FULLTEXT index on `merchants` | created | absent |
| `audit_log (entity_type, entity_id, created_at)`, `aml_screenings (result, requested_at)`, `regulatory_reports (status, created_at)` | **dropped the old index, never created the replacement** | present |
| `inbound_events.raw_body_bytes`, `audit_log.before_json/after_json`, `reconciliation_runs.file_content` | still inline | **still inline *and* duplicated** in the new payload tables |

Consequences: `prisma migrate` will see drift and try to "fix" it; the payload foreign keys cannot be created (different type); and narrowing `MODIFY COLUMN` on a table with existing data either fails ("Data too long") or, when `sql_mode` is not strict, **silently truncates**.

**B2. UUIDv7 as a "collision-free" checkpoint cursor (`l.id > last_checkpoint_id`) is not safe.**
`journal_lines.id` is generated by the application before the insert. Transaction A can generate an id, transaction B can generate a *later* id and commit first, and the checkpoint job then advances past B's id. When A commits afterwards, its line has a **smaller** id than the checkpoint and is **never counted**. This is the same out-of-order-commit bug as the `created_at` cursor it claims to fix, with extra risk from clock skew between nodes. A checkpoint that can silently skip money lines is worse than no checkpoint, because the invariant check will then report a false discrepancy or hide a real one. (Safe designs: §2.3.)

**B3. Updating `gl_accounts.current_balance` on every posting creates global hot rows.**
`TREASURY`, `PLATFORM_INCOME`, `GATEWAY_CLEARING` (per gateway) and the fee accounts are touched by **every** payment. Each checkout transaction takes an exclusive row lock on them and holds it until commit. Throughput on those rows is bounded by one commit at a time (roughly `1 / commit-latency`, a few hundred per second on cloud disks with `innodb_flush_log_at_trx_commit=1`). This is the same problem v1 correctly criticises on `payment_links`, but worse because it is one row for the whole platform. `lines_since_checkpoint` makes it worse still: it is another counter on the same hot rows. The "sorted update order prevents deadlocks" claim only holds if **every** code path that locks these rows uses the same order, which v1 does not enforce.

**B4. The velocity bucket design has five defects.**
1. **Hot rows:** `MERCHANT`, `APPLICATION`, `RAIL` and `LINK` scopes update the same row for every payment in a 5-minute window, inside the checkout transaction → the same serialisation as B3.
2. **Check-then-act race:** reading counts, evaluating in memory, then incrementing lets a burst of concurrent requests all pass the check. The increment must come first and be read back.
3. **Fixed 5-minute buckets** make 1-hour and 24-hour sliding windows approximate by up to 5 minutes; the plan also uses them for AML cumulative windows, where approximation is a compliance question.
4. **`sha256(phone)` is not protection.** Libyan mobile numbers have about 10⁸ possibilities; the hashes can be reversed in minutes. Use a keyed hash (HMAC with a vault-held key).
5. `expires_at` has no purge job described; the table grows forever.

**B5. `entity_search_tokens` is a hand-built search engine with the wrong trade-offs.**
Every searchable write adds 3–8 rows; for `payment_attempts` that roughly **doubles** the write cost of the hottest path. `title`/`subtitle` are copied onto every token row. Updates and deletes (a renamed merchant, a changed phone) leave stale tokens unless every writer is perfect. Sensitive values (`tax_id`) are duplicated in plaintext into a second table. At 100 M attempts it is ~300–800 M extra rows to keep in sync. Exact-reference lookups do not need it at all (a normal index already gives `LIKE 'abc%'`), and free-text search over *payments* is not a product requirement anyone has stated.

**B6. Removing `AttemptGroup` removes a money invariant.**
`attempt_groups.success_count ≤ 1` is what prevents a customer who switches payment method mid-way from being **charged twice** for one link. v1 replaces it with a non-unique index `(link_id, customer_fingerprint, status)`, which enforces nothing, and then claims the slot counter covers it. It does not for multi-use links. The table costs one extra insert per attempt; that is small next to the risk. (Cheaper correct versions: §2.7.)

**B7. `payment_attempts` carries 18 secondary index definitions** (15 `@@index` + 3 unique) and v1 adds more. `status` appears in 6 of them. A normal attempt changes `status` four or five times; each change deletes and re-inserts entries in every index that contains `status`, at random positions in 100 M-row B-trees. That is the real cost on the hottest table, and v1's two "covering" indexes make it larger. The sweeper and poller should scan a **tiny work table of open deadlines**, not a status range over the big table (§2.4).

**B8. The migration script is not safe to run.**
- Not idempotent (`ADD INDEX` / `DROP INDEX` without `IF [NOT] EXISTS`); one wrong index name (for example `merchants_kybStatus_idx` — the Prisma default name depends on the `@map`) aborts mid-way and leaves a half-applied database.
- Dropping a column index that backs a foreign key fails unless another index starts with the same column. This was checked per table for the drops listed and holds for most, **but** the replacements for `aml_screenings`, `regulatory_reports` and `audit_log` are missing (B1).
- `ADD COLUMN … GENERATED … STORED` on a 100 M-row table rebuilds the whole table.
- The ID-shrinking pillar cannot be done with `ALTER`: columns used in foreign keys cannot be retyped one by one. Because you are in development, the correct tool is a **fresh baseline migration** (§4.1), not 60 `ALTER`s.

**B9. Caching security-critical state with a TTL.** `principalSessionCache` (30 s) means a **revoked API token keeps working for 30 s**; a suspended merchant or an opened circuit breaker is acted on late. Invalidation by polling every 2 s still leaves a window. Kill-switch data needs a different rule (§2.9).

**B10. Unverified server settings.** Several variables in the proposed `.cnf` are MySQL-8-only or obsolete in MariaDB (`innodb_buffer_pool_instances` was removed in 10.5; `innodb_deadlock_detect` should be checked against your exact version). An unknown variable in the `[mysqld]` section **stops the server from starting**. `innodb_log_file_size = 1G` is small for a write-heavy ledger.

**B11. Missing entirely:** a retention and archival design (financial and AML records must be kept for years while the hot tables must stay small), isolation level choice (`READ COMMITTED` avoids gap-lock deadlocks), automatic deadlock retry, statement time limits, ledger immutability enforced by the database, a read replica for admin/reporting load, and an actual load test.

---

## PART 2 — TARGET ARCHITECTURE

### 2.1 Principles
1. **The ledger is the only source of truth for money.** Everything else (balances, daily totals, stats) is derived, rebuildable by a command, and verified against the ledger.
2. **No single row may be written by every payment.** Where a counter must be exact, it is per merchant or per wallet (low contention). Where it is global, it is sharded or updated after commit.
3. **Append-only tables are fixed and narrow.** Large or rarely read data lives in 1:1 child tables or cold storage.
4. **Indexes are a budget.** Each index on a hot table must name the query it serves; the lint test of §5.4 rejects unnamed or redundant indexes.
5. **Hot and cold are separated physically**: open work (small) vs history (huge).
6. **Every transaction is short, ordered and retried.** Fixed lock order, `READ COMMITTED`, statement timeouts, automatic retry on deadlock (§2.6).

### 2.2 Identifiers and column types (DECISION D1)

- **Default (recommended):** keep UUIDv7 as application ids for entities exposed through APIs, but store them as `CHAR(36) CHARACTER SET ascii COLLATE ascii_bin` (36 bytes, binary comparison). `VARCHAR(191)` in `utf8mb4_unicode_ci` reserves up to 764 bytes in sort and temporary buffers and runs collation weights on every comparison.
- **For the four largest append-only tables** — `journal_lines`, `audit_log`, `attempt_step_logs`, `inbound_events` — use `BIGINT UNSIGNED AUTO_INCREMENT` as the primary key. Every secondary index on a table repeats the primary key; with ~3 indexes on 300 M ledger lines, 8 bytes instead of 36 saves roughly 25 GB of index. They are internal tables, so they need no UUID. (An auto-increment id is **not** used as a cursor for correctness anywhere in this plan — see B2.)
- Do **not** use `BINARY(16)`: Prisma cannot generate or read it as a string without custom code in every query.
- Prisma cannot declare a column collation. The baseline migration (§4.1) is hand-edited to add `CHARACTER SET ascii COLLATE ascii_bin` on every `CHAR(36)` id and foreign-key column, listed in `design/db_manual_sql.md`, and verified by the lint test.
- Replace `@db.Text` by `VARCHAR(N)` for: identifiers, references, codes, roles, actions, IPs, names with a known maximum. Leave `Text` only for free-form long text (notes, reasons, templates, step response text). Use `@db.Char(3)` for currency (already done).
- `@updatedAt` writes a column on every update. Remove `updatedAt` from **append-only** tables (`journal_lines`, `journal_entries`, `audit_log`, `attempt_step_logs`, `inbound_events` after processing aside, payload tables) and from **counter tables** (every counter increment would otherwise also rewrite `updated_at`).

### 2.3 Ledger v2 (replaces §4 of v1)

**Tables**

```prisma
model GlAccount {
  id              String        @id @default(uuid(7)) @db.Char(36)
  createdAt       DateTime      @default(now()) @map("created_at")
  accountType     GlAccountType @map("account_type")
  balanceMode     GlBalanceMode @map("balance_mode")      // SYNC | SHARDED
  ownerId         String?       @map("owner_id") @db.Char(36)
  gatewayId       String?       @map("gateway_id") @db.Char(36)
  credentialSetId String?       @map("credential_set_id") @db.Char(36)
  env             String?       @db.VarChar(16)
  currency        String        @db.Char(3)
  /// Exact balance for SYNC accounts (merchant wallets, per-merchant receivables). 0 and unused for SHARDED.
  currentBalance  Decimal       @default(0) @map("current_balance") @db.Decimal(18, 4)
  /// Optional per-account floor for conditional debits (negative-balance ceiling). NULL = no floor.
  balanceFloor    Decimal?      @map("balance_floor") @db.Decimal(18, 4)
  seedKey         String?       @unique @map("seed_key") @db.VarChar(191)
  // (no updated_at, no checkpoint columns, no lines_since_checkpoint)
  shards          GlBalanceShard[]
  periodTotals    GlPeriodTotal[]
  @@unique([gatewayId, env, credentialSetId])
  @@index([accountType]) @@index([ownerId]) @@index([gatewayId])
  @@map("gl_accounts")
}

enum GlBalanceMode { SYNC SHARDED }

/// Balance of a global account is the SUM of its shards (at most 32 rows).
model GlBalanceShard {
  glAccountId String  @map("gl_account_id") @db.Char(36)
  shardNo     Int     @map("shard_no") @db.TinyInt
  balance     Decimal @default(0) @db.Decimal(18, 4)
  lineCount   BigInt  @default(0) @map("line_count")
  account     GlAccount @relation(fields: [glAccountId], references: [id], onDelete: Restrict)
  @@id([glAccountId, shardNo])
  @@map("gl_balance_shards")
}

/// Closed, immutable per-day totals used by the verifier (see below).
model GlPeriodTotal {
  glAccountId String  @map("gl_account_id") @db.Char(36)
  day         DateTime @db.Date
  debitTotal  Decimal @map("debit_total") @db.Decimal(20, 4)
  creditTotal Decimal @map("credit_total") @db.Decimal(20, 4)
  lineCount   BigInt  @map("line_count")
  account     GlAccount @relation(fields: [glAccountId], references: [id], onDelete: Restrict)
  @@id([glAccountId, day])
  @@map("gl_period_totals")
}

model JournalLine {
  id          BigInt           @id @default(autoincrement()) @db.UnsignedBigInt
  createdAt   DateTime         @default(now()) @map("created_at") @db.DateTime(3)
  entryId     String           @map("entry_id") @db.Char(36)
  glAccountId String           @map("gl_account_id") @db.Char(36)
  direction   JournalDirection
  amount      Decimal          @db.Decimal(18, 4)
  entry       JournalEntry     @relation(fields: [entryId], references: [id], onDelete: Restrict)
  glAccount   GlAccount        @relation(fields: [glAccountId], references: [id], onDelete: Restrict)
  @@index([entryId], map: "journal_lines_entry_idx")
  /// Serves balance verification and period rollups as an index-only scan.
  @@index([glAccountId, createdAt, direction, amount], map: "journal_lines_acct_time_cov_idx")
  @@map("journal_lines")
}
```

**Which accounts are SYNC and which SHARDED**
- `MERCHANT_WALLET`, `COMMISSION_RECEIVABLE` (one per merchant): **SYNC**. They need an exact, transactional balance for refunds, chargebacks and cash-outs, and are contended only by that merchant's own traffic.
- `TREASURY`, `GATEWAY_CLEARING`, `PLATFORM_INCOME`, `PROVIDER_FEE_EXPENSE`, `GATEWAY_FEE_EXPENSE`, `GATEWAY_FEE_ACCRUAL`, `AML_HOLD`, `CHARGEBACK_RESERVE`, `SUSPENSE`: **SHARDED** (32 shards). The poster picks `shard_no = crc32(entry_id) % 32`, so concurrent payments land on different rows.

**Posting (one transaction, fixed order)**
1. Insert the `journal_entries` row.
2. Insert all `journal_lines` in **one** multi-row `INSERT`.
3. SYNC accounts, sorted by account id: one conditional statement per account that must respect a floor:
   `UPDATE gl_accounts SET current_balance = current_balance + :delta WHERE id = :id AND (:delta >= 0 OR balance_floor IS NULL OR current_balance + :delta >= balance_floor)` — if `affectedRows = 0` the posting fails with `INSUFFICIENT_BALANCE_OR_CEILING` and the **whole transaction rolls back**. There is no read-then-write gap.
4. SHARDED accounts, sorted by account id: `INSERT INTO gl_balance_shards (gl_account_id, shard_no, balance, line_count) VALUES (…) ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance), line_count = line_count + VALUES(line_count)`.

Database-side guarantees (added in the baseline migration):
- `CHECK (amount > 0)` on `journal_lines`.
- `BEFORE UPDATE` and `BEFORE DELETE` triggers on `journal_lines` and `journal_entries` that `SIGNAL SQLSTATE '45000'` — the ledger is **immutable at the database level**.
- The application database user has `INSERT, SELECT` only on those two tables (no `UPDATE`, `DELETE`). The migration user is a different account.

**Verification (replaces the id/time cursor)**
Safe because it needs no ordering assumption:
- **Closed periods:** a nightly worker fills `gl_period_totals` for each fully **closed** day (`day < today − 1`), using lines with `created_at` in that day. This is safe because every ledger transaction is bounded by `max_statement_time` and an application transaction timeout of 30 s, so no line can commit later than 10 minutes after its `created_at`; the worker only closes days older than 24 h. Closed days never change; the worker stores them once.
- **Account check (per account, one `REPEATABLE READ` read-only transaction, preferably on the replica):**
  `balance_now` (`current_balance`, or `SUM(shards)`) **must equal** `Σ closed day totals (debit − credit, by normal side) + Σ lines with created_at ≥ first open day`. Both sides are read in the same snapshot, so concurrent postings cannot cause a false alarm. The open part is at most about one day of lines for one account, an index-only range scan.
- **Global equation:** the ledger equation of the Guide (`b08-05`) is computed from the account balances (`SUM` over `gl_accounts` and shards; a few hundred thousand rows at most) and must be exactly `0.0000`. Run every minute; it is cheap.
- **Full recompute:** weekly, on the replica, per account, from lines; it must equal the stored balance. Any difference raises the P1 "drift" alert and stops automatic payouts (existing behaviour).
- Remove `last_checkpoint_id`, `checkpoint_balance`, `checkpoint_at`, `lines_since_checkpoint` from `GlAccount` and delete the `CheckpointService` id cursor.

### 2.4 `payment_attempts`: fewer indexes, and a work table for open deadlines

Keep (each with the query it serves; names are documented in `design/db_index_catalog.md`):

| Index | Serves |
| :--- | :--- |
| `UNIQUE (reference)` | status lookup, statement match |
| `UNIQUE (link_id, idempotency_key)` | idempotency guard; also the `link_id` FK |
| `UNIQUE (ledger_entry_id)` | 1:1 ledger link |
| `(merchant_id, created_at)` | default merchant list; the `merchant_id` FK |
| `(merchant_id, status, created_at)` | status-filtered merchant list |
| `(provider_reference)`, `(gateway_reference)` | webhook correlation, inquiry, statement match |
| `(network_reference)` | **DECISION D2:** keep only if a query uses it (card disputes). Measure first. |
| `(status, created_at)` | admin global list by status — **keep only if the admin screen has that filter; measure the write cost (§5.3)** |
| FK indexes: `route_id`, `rail_id`, `application_id`, `credential_set_id`, `gateway_version_id`, `commission_profile_id`, `attempt_group_id` | required by InnoDB for the foreign keys; use the cheapest leading-column index that already exists |

**Remove from v1 and from the current schema:** `(status, next_check_at)`, the covering `(status, expires_at, terminal_at, substatus)`, the covering `(route_id, status, terminal_at, total_charged_amount)`, and the three `end_client_*` indexes. Their jobs move to the structures below. Do **not** add the STORED `terminal_effective_at` column.

**Open-work table** (small: only attempts that are not yet final):

```prisma
model AttemptDeadline {
  attemptId    String   @map("attempt_id") @db.Char(36)
  kind         AttemptDeadlineKind                // EXPIRE | POLL | GRACE_END
  dueAt        DateTime @map("due_at") @db.DateTime(3)
  claimedUntil DateTime? @map("claimed_until") @db.DateTime(3)
  claimedBy    String?  @map("claimed_by") @db.VarChar(64)
  @@id([attemptId, kind])
  @@index([dueAt], map: "attempt_deadlines_due_idx")
  @@map("attempt_deadlines")
}
```

- Rows are inserted when the attempt is created, updated when `next_check_at`/`expires_at` change, and **deleted** when the attempt reaches a final state (`SUCCEEDED`, `FAILED`, `EXPIRED`, `CANCELLED`, `BLOCKED`) — in the same transaction as the status change.
- `ExpirySweeperWorker` and `PollWorker` claim with `SELECT attempt_id FROM attempt_deadlines WHERE due_at <= NOW(3) AND (claimed_until IS NULL OR claimed_until < NOW(3)) ORDER BY due_at LIMIT 50 FOR UPDATE SKIP LOCKED` **and** set `claimed_until` inside the same transaction (a lease). The table holds thousands of rows, not 100 M, whatever the history size.
- `GatewayInquirySchedule` (operator-driven inquiries) stays as is; it is a different concern.
- This is a **hot/cold split**: the big table is only written by the lifecycle, the sweepers never scan it. **VERIFY** the existing `next_check_at` / `expires_at` usages in `PollWorker`, `ExpirySweeperWorker` and the SSE code before removing the columns' indexes.

### 2.5 Cold data and the duplicated payload columns

- Choose **one** representation. For `inbound_events`, `audit_log` and `reconciliation_runs`, **remove** the inline columns (`raw_body_bytes`, `redacted_headers_json`; `before_json`, `after_json`; `file_content`) from the parent tables and keep them only in the 1:1 child tables. v1's schema and SQL keep both.
- Child tables use the same id type and collation as the parent and a real foreign key (`ON DELETE CASCADE`) — **unless** the parent is partitioned (§2.10), in which case there is no foreign key.
- Writers insert parent then child in the same transaction; readers join the child only for the detail view and for the 50 rows a worker has claimed. Workers must name their columns; `SELECT *` on these tables is forbidden by a lint rule.
- Statement files up to 25 MB: keep `LONGBLOB` in the child table with `ROW_FORMAT=COMPRESSED` **VERIFY** (compressed row format can slow writes; alternatively store the file in object storage and keep only its path and SHA-256 — **DECISION D3**, default: child table).

### 2.6 Transaction discipline (new; v1 had none of this)

1. **Isolation:** `READ COMMITTED` for both OLTP pools (`transaction_isolation` in the pool's connection options). `REPEATABLE READ` takes gap locks on range scans and produces deadlocks that do not occur under `READ COMMITTED`. The verifier of §2.3 explicitly opens a `REPEATABLE READ` read-only transaction.
2. **Fixed lock order** for any transaction that writes more than one hot row: `payment_links` → `payment_attempts` → `gl_accounts` (SYNC, by id) → `gl_balance_shards` (by id, shard) → counters. Written in `design/db_lock_order.md`; a unit test fails if a writer module imports rows in another order (grep-based) — **VERIFY** feasibility.
3. **Automatic retry** wrapper `withTxRetry()` for MariaDB errors 1213 (deadlock) and 1205 (lock wait timeout): up to 3 attempts, 5–40 ms jittered back-off, only when the operation is **idempotent by construction** (idempotency key or unique constraint). Every retry is counted in a metric.
4. **Timeouts:** `innodb_lock_wait_timeout = 5` for the transactional pool, `max_statement_time = 15` for it and `120` for the background pool (set per connection), application transaction timeout 15 s (transactional) / 60 s (background).
5. **No network call to a payment partner inside a database transaction**, ever. (If the code has any, that is the first thing to fix; **VERIFY**.)

### 2.7 Checkout hot path

- **Slot reservation:** keep v1's single conditional `UPDATE payment_links …` for finite links. For `infinite_use = 1` links **do not touch the row at all** (no counter) — there is nothing to protect and it is the most contended row in the system. The release/confirm path skips infinite links the same way.
- **`AttemptGroup`: keep.** Create-or-get in one statement, no prior select: `INSERT INTO attempt_groups (id, link_id, customer_fingerprint) VALUES (…) ON DUPLICATE KEY UPDATE id = id`, then read the id. (Optional later, **DECISION D4**: enforce "one success per link and customer" with a unique index on a generated column on `payment_attempts` — `succeeded_marker = IF(succeeded_at IS NOT NULL, 1, NULL)` unique with `(link_id, customer_fingerprint, succeeded_marker)` — and only then drop the group table. Do not do this without a concurrent double-payment test.)
- **Velocity (transaction-time) counters** — `VelocityCounter`, replacing `VelocityWindowBucket`:

```prisma
model VelocityCounter {
  scopeType VelocityScopeType @map("scope_type")
  scopeKey  String   @map("scope_key") @db.Char(64)     // HMAC-SHA256(secret, value) for payer scopes; entity id for merchant scopes
  bucket    Int      @map("bucket")                      // 60-second epoch (floor(unix/60)) for windows <= 1 h; hour epoch for windows > 1 h
  granularity Int    @db.TinyInt                         // 1 = minute, 2 = hour
  attempts  Int      @default(0)
  succeeded Int      @default(0)
  amount    Decimal  @default(0) @db.Decimal(18, 4)
  @@id([scopeType, scopeKey, granularity, bucket])
  @@map("velocity_counters")
}
```
  - Payer scopes (IP, phone, card alias) are low-contention: do the **increment first** (`INSERT … ON DUPLICATE KEY UPDATE attempts = attempts + 1`), read back the sums over the window in the same transaction, then decide. No check-then-act race.
  - Merchant-level scopes (`MERCHANT`, `APPLICATION`, `RAIL`, `LINK`) are *not* written in the checkout transaction. An in-process buffer flushes them every second (`INSERT … ON DUPLICATE KEY UPDATE`), and their rules are evaluated with a documented tolerance (**DECISION D5**: default = rules on those scopes are "soft": overshoot ≤ 1 s of traffic).
  - Windows: ≤ 1 hour uses minute buckets (≤ 60 rows); 1–24 hours uses minute buckets for the last hour plus hour buckets (≤ 84 rows). Precision ±1 minute / ±1 hour at the edge.
  - A purge worker deletes buckets older than 25 hours in small batches (`DELETE … LIMIT 5000`).
  - **AML cumulative windows are not evaluated in the checkout transaction.** They belong to the deferred layer (Guide `b09-02` L4): a worker computes them from `merchant_daily_stats` (day granularity) and, when a rule needs exactness, from `payment_attempts` through `(merchant_id, created_at)`. Remove `end_client_*` columns from `payment_attempts` unless another feature reads them.
  - **DECISION D6:** if sustained load will exceed ~500 TPS or you want exact sliding windows, put these counters in **Redis** behind the same `VelocityStore` interface. Build the interface now; ship the MariaDB implementation first.
- **`route_daily_volumes`:** keep, but shard by `shard_no` (16) exactly like balances, because a popular route is a global hot row. The daily-cap read sums ≤ 16 rows and is cached 5 s. State clearly (**DECISION D7**) that the cap is a soft cap with overshoot bounded by the cache TTL, unless a route is flagged `hard_cap`; a hard cap uses a conditional `UPDATE … WHERE total + :amt <= :cap` on a single row for that route only.
- **`merchant_daily_stats`:** **do not update it inside the checkout or confirm transaction.** A worker builds it from final-state attempts in small time windows (watermark of 10 minutes, as in §2.3), idempotently (`INSERT … ON DUPLICATE KEY UPDATE col = VALUES(col)` per recomputed day/merchant/rail), and a command rebuilds any day from `payment_attempts`. Analytics may lag by minutes.
- **KYB duplicate documents:** no stats table. On upload: `SELECT merchant_id FROM kyb_documents WHERE sha256 = ? AND merchant_id <> ? LIMIT 1` (index `(sha256)` exists), and store `duplicate_of_merchant_id` (indexed, nullable) on the new row. The compliance list is `WHERE duplicate_of_merchant_id IS NOT NULL`.

### 2.8 Search and lists (replaces §7 of v1)

1. **Identifiers and references** (`payment_attempts.reference`, provider/gateway/network references, `reconciliation_items.*_reference`, merchant tax id/registration/email/phone): ordinary B-tree indexes; the API does exact match or prefix `LIKE 'x%'`. No token table.
2. **Names** (merchants, applications, users, gateways, rails — master data, at most about 1 M rows): InnoDB `FULLTEXT` on `(legal_name, trade_name)` and similar, declared with `@@fulltext` in `schema.prisma`, with `innodb_ft_min_token_size = 2` **VERIFY** Arabic behaviour (no stemming; test with the Arabic fixtures of the Guide's Academy labs). Fall back to `LIKE 'x%'` for prefix.
3. **Payments, audit log, inbound events:** no global free-text search. Search *inside* one merchant and date range through `(merchant_id, created_at)`, or by exact reference. (**DECISION D8:** if free-text search over transactions is a real requirement, feed a search engine such as OpenSearch/Typesense from an outbox; do not build it in MariaDB.)
4. **Global search** therefore runs at most one query per *entity group that is actually searchable* (about 6, not 20), in parallel on `dbBackground`/replica, each with a hard `LIMIT` and `max_statement_time`.
5. **Lists:** keyset cursors on `(created_at, id)`; `OFFSET` capped at 1 000; counts via bounded `SELECT COUNT(*) FROM (SELECT 1 … LIMIT 10001)` with a 15 s cache. **Ordering ties:** the cursor must use the tie-breaker `id` and the index must end with it (InnoDB appends the primary key automatically to every secondary index, so `(merchant_id, created_at)` already orders by `id` last).

### 2.9 Caching rules (three classes)

| Class | Examples | Rule |
| :--- | :--- | :--- |
| **A — immutable or versioned** | gateway versions, flows, steps, crypto profiles, status rules, error maps, notification templates by version | cache by id/version with a long TTL; no invalidation needed (new versions are new rows) |
| **B — tunable configuration** | platform settings, active velocity and AML rules, commission profiles, rails, routes (without health) | TTL ≤ 30 s **plus** invalidation through the bus; cache stores the row `version`; the money transaction re-reads the **single version row it depends on** by primary key and aborts if it changed |
| **C — security and kill-switch state** | token revocation, merchant status, wallet status, route health / circuit breaker, credential-set status, maintenance windows | **never cached longer than 2 s**; for operations that move money, re-validate merchant status and token status by primary key **inside** the transaction. A `principalSessionCache` may cache the *verification of a token hash* for ≤ 2 s only, and revocation publishes to the bus **and** writes `revoked_at` first. |

Invalidation bus table: keep `cache_invalidation_events` (`event_seq BIGINT` as in the schema), poll every 1 s with `WHERE event_seq > :last`, purge rows older than 1 hour. Redis pub/sub is an optional later replacement behind the same interface.

### 2.10 Retention, partitioning and archive (DECISION D9 on retention years)

- **Tables that are logs** — `audit_log` (+ payload), `attempt_step_logs`, `inbound_events` (+ payload), `gateway_health_samples`, `cache_invalidation_events`, `notifications`: partition by **month** on `created_at`, with `created_at` added to the primary key (`PRIMARY KEY (id, created_at)`), and **no foreign keys** to or from them (a MariaDB limitation for partitioned InnoDB tables; integrity is kept by application and by the nightly lint query that counts orphans). Retention then costs `ALTER TABLE … DROP PARTITION`, not a multi-hour `DELETE`.
- **`payment_attempts`, `journal_entries`, `journal_lines`, `payment_links`:** *not* partitioned (they have many foreign keys). Instead: keep them lean (§2.2–2.4), size the buffer pool for the hot index set (§5.5), and plan an **archive job** for terminal attempts older than N months into a `payment_attempts_archive` table without foreign keys (**DECISION D9**, default: no archiving for the first 2 years; reassess when `information_schema` shows the hot indexes exceeding 60 % of the buffer pool).
- Before any partition is dropped: export it (compressed CSV/Parquet) to cold storage, record the file SHA-256 and row count in `archive_manifest`, and verify the count. **VERIFY** the regulatory retention period for AML records (the Guide's default is 5 years after the relationship ends) — **do not drop** audit or AML data before that.
- Prisma Client works against partitioned tables, but `prisma migrate` does not understand partitions. Partition DDL lives in the hand-added SQL file; the drift check of Part 0 rule 3 must be run with that file applied. **VERIFY** on your Prisma version before committing to this phase.

### 2.11 Connection pools, replicas, workers

- Pools: `dbTransactional` (checkout, merchant API, admin writes) and `dbBackground` (all workers, reconciliation, rollups, verifier, exports). Sizes are per **node**; total across nodes must stay below `max_connections − 20`. Keep v1's numbers as defaults (40 / 15) and tune from `Threads_connected` and the pool-wait metric.
- **Read replica (phase P8):** point admin lists, exports, statement reads and the verifier at a replica through one `dbReadOnly` client. Reads that must see the user's own write (right after an approval) go to the primary. Show replica lag on the dashboard; refuse replica reads above a lag threshold.
- Workers: all `FOR UPDATE SKIP LOCKED` claims inside a transaction that also sets the lease (as in §2.4); worker SELECTs name columns; no blob columns.

### 2.12 MariaDB configuration (to be adapted, then validated)

**VERIFY every line with `SHOW VARIABLES LIKE '…'` on the target version before use**; an unknown variable stops the server. Starting point:

```ini
[mysqld]
character_set_server        = utf8mb4
collation_server            = utf8mb4_unicode_ci        # pin it; MariaDB 11.x default differs
transaction_isolation       = READ-COMMITTED

innodb_buffer_pool_size     = 70% of host RAM (dedicated DB host)
innodb_log_file_size        = 4G                        # 8G for sustained 500 TPS; check "Innodb_os_log_written" per hour
innodb_log_buffer_size      = 64M
innodb_flush_log_at_trx_commit = 1
sync_binlog                 = 1                         # only if binlog is on (replication/PITR)
innodb_flush_method         = O_DIRECT
innodb_io_capacity          = 2000
innodb_io_capacity_max      = 4000
innodb_lock_wait_timeout    = 5

max_connections             = 300
thread_handling             = pool-of-threads
thread_pool_size            = number of CPU cores
table_open_cache            = 6000
tmp_table_size              = 128M
max_heap_table_size         = 128M

performance_schema          = ON
slow_query_log              = ON
long_query_time             = 0.2
log_slow_admin_statements   = ON
# In TEST/CI only: log_queries_not_using_indexes = ON, innodb_print_all_deadlocks = ON
```
Removed from v1: `innodb_buffer_pool_instances` (obsolete), `innodb_deadlock_detect` (verify), the fixed 4 G buffer pool.

---

## PART 3 — WHAT TO DELETE FROM v1

| Delete | Replaced by |
| :--- | :--- |
| `gl_accounts.last_checkpoint_id`, `checkpoint_*`, `lines_since_checkpoint`, `CheckpointService` id cursor | §2.3 period totals + snapshot verification |
| `entity_search_tokens` | §2.8 |
| `kyb_document_hash_stats` | `duplicate_of_merchant_id` (§2.7) |
| `velocity_window_buckets` | `velocity_counters` (§2.7) |
| `payment_attempts.terminal_effective_at` (generated) and the three covering indexes | §2.4 |
| `end_client_ip/phone_hash/card_alias` indexes | counters (§2.7) |
| Dropping `AttemptGroup` | kept (§2.7) |
| `merchant_daily_stats` update in the checkout transaction | worker (§2.7) |
| Inline blob/JSON columns that also have an offload table | one representation (§2.5) |
| The "ALTER everything" migration | fresh baseline (§4.1) |

---

## PART 4 — EXECUTION

### 4.1 Migration strategy (you may reset the database)

Because you are in development, **do not layer 100 `ALTER`s on the old migration history**:

1. Edit `schema.prisma` to the final target (all of Part 2).
2. Delete the old migration folders and the dev database; generate one baseline: `prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > migrations/0001_baseline/migration.sql`.
3. Hand-edit that file **only** for what Prisma cannot express: `CHARACTER SET ascii COLLATE ascii_bin` on id columns, `CHECK` constraints, the immutability triggers, partition clauses, `ROW_FORMAT`. Every hand edit is listed in `design/db_manual_sql.md`.
4. Add the database users and grants (`app_rw` without `UPDATE/DELETE` on ledger tables; `migrator` with DDL) as a separate, documented script.
5. From now on: every change is a new small migration, idempotent, with a matching `schema.prisma` edit; for a populated production database use an online schema-change tool (`gh-ost` / `pt-online-schema-change`) and never `ALTER` a 100 M-row table in a maintenance window without measuring it on a copy first.

### 4.2 Phases (tick only after the gate)

- [ ] **P0 — Measure first.** Build the harness of Part 5 against the *current* schema with the STRESS seeder. Record baseline numbers in `design/db_baseline_results.md`. *Gate:* the 25-query catalogue (§5.2) and the three concurrency tests (§5.3) all run and print results.
- [ ] **P1 — Baseline schema.** §2.2, §2.4 (indexes), §2.5 (single representation), §4.1. *Gate:* drift check clean; lint test (§5.4) green; the seeder loads; collation check passes; `EXPLAIN` catalogue shows no new full scans.
- [ ] **P2 — Pools, isolation, retry, timeouts, cache classes.** §2.6, §2.9, §2.11 (pools only). *Gate:* concurrency tests show zero unretried deadlocks; a revoked token stops working within 2 s in an e2e test.
- [ ] **P3 — Ledger v2.** §2.3. *Gate:* **ledger soak test** (§5.3 T3) with 64 concurrent writers for 10 minutes plus a `kill -9` of the core in the middle: global equation exactly `0.0000`, every account check passes, no orphan lines; immutability triggers reject an `UPDATE` and a `DELETE` in a test.
- [ ] **P4 — Checkout hot path.** §2.4 (`attempt_deadlines`), §2.7 (slot, attempt group, velocity counters, route volume shards). *Gate:* T1 and T2 of §5.3; double-payment race test (§5.3 T4) shows exactly one success per link/customer; query budget per route (§5.6).
- [ ] **P5 — Rollup workers and KYB duplicate flag.** §2.7 last bullets. *Gate:* a command rebuilds any day of `merchant_daily_stats` and equals the incremental values on the seeded data.
- [ ] **P6 — Search and lists.** §2.8. *Gate:* the admin search endpoint ≤ 6 queries; Arabic search fixtures pass; keyset pagination test returns each row exactly once under concurrent inserts.
- [ ] **P7 — Workers and SSE push.** §2.11 workers; leases; push on the bus. *Gate:* two worker nodes never process the same attempt (test with 4 nodes).
- [ ] **P8 — Retention, partitions, replica.** §2.10, §2.11 replica. *Gate:* partition drop on a copy preserves referential checks; replica lag guard test.
- [ ] **P9 — Configuration and soak.** §2.12; 4-hour soak at target load with the verifier running; query-budget CI gate. *Gate:* no growth of undo history length (`trx_rseg_history_len` stable), no growing queue tables, ledger drift `0.0000`.

---

## PART 5 — VERIFICATION HARNESS

### 5.1 Environment
State the hardware and MariaDB version used in every result file. The "p95 < 15 ms API latency" of v1 is not a valid goal without hardware and network assumptions; use the SLOs of §5.6.

### 5.2 Query catalogue (`design/db_hot_queries.md`)
List the hot queries (at least: checkout page, initiate, confirm, webhook correlation by provider reference, statement match, merchant list default and by status, admin global list, sweeper claim, poll claim, inbox claim, wallet balance, balance verification, route daily volume, velocity read/write, KYB duplicate, global search groups, reconciliation item list). For each: the SQL, the index it must use, and the pass criteria from `EXPLAIN ANALYZE`: **no `Using filesort` or `Using temporary` on hot paths, rows examined within 2× of rows returned, and index-only where stated**.

### 5.3 Concurrency and failure tests
- **T1:** 200 concurrent payments on one infinite-use link → no lock-wait timeouts; throughput recorded.
- **T2:** 1 000 concurrent confirmations across 10 merchants posting to the same clearing/treasury/income accounts → zero deadlocks after retry; throughput recorded for 1, 8, 32 shards (to justify the shard count).
- **T3:** ledger soak (see P3 gate).
- **T4:** same link, same customer fingerprint, two rails started within 5 ms of each other, both confirm → exactly one `SUCCEEDED`.
- **T5:** write amplification: run T2 with and without each removable index (`(status, created_at)`, `(network_reference)`); record TPS and `Innodb_rows_inserted/updated`. Remove the index if the cost is not justified by a real query.

### 5.4 Schema lint test (CI)
Fails the build when: an index has no entry in `design/db_index_catalog.md`; two indexes on one table share a leading prefix and one is a strict prefix of the other (redundant, except FK-required); an id or FK column is not `CHAR(36) ascii_bin` or `BIGINT`; a `TEXT/BLOB` column is used in an index or in a worker claim; an append-only table has `updated_at`; `schema.prisma` and the database differ in column type or length; a foreign key column has no index; the triggers or grants of §2.3 are missing.

### 5.5 Sizing report
A script prints, per table, data size and per-index size from `information_schema.TABLES` and `INNODB_SYS_*`, and compares the sum of **hot** index sizes (the ones used by the catalogue) with the buffer pool. Trigger for action: hot indexes above 60 % of the buffer pool.

### 5.6 SLOs and query budget
| Route | Max queries | Target (state hardware) |
| :--- | :--- | :--- |
| `GET /pay/:key` | 4 (cached steady state 1) | p95 recorded |
| `POST …/initiate` | 8 | p95 recorded; no lock held for any network or CPU-heavy work |
| `POST …/confirm` | 8 | p95 recorded |
| `GET /wallets/:id/balance` | 2 | PK read (SYNC) or ≤ 32 rows (SHARDED) |
| Any admin list | 3 | keyset; no unbounded count |
| Global search | 6 | each query with `LIMIT` and `max_statement_time` |

---

## PART 6 — OPEN DECISIONS (defaults in brackets)

| # | Question | Default |
| :--- | :--- | :--- |
| D1 | Id strategy | `CHAR(36) ascii_bin` for entities; `BIGINT` for the four mega-tables |
| D2 | Keep `(network_reference)` index | measure, remove if unused |
| D3 | Statement file storage | child table, `LONGBLOB` |
| D4 | Replace `attempt_groups` with a unique generated column | keep the table |
| D5 | Tolerance of merchant-level velocity rules | soft, ≤ 1 s of traffic |
| D6 | Redis for velocity counters | interface now, MariaDB first |
| D7 | Daily route cap soft or hard | soft; hard only for routes flagged `hard_cap` |
| D8 | Free-text search over transactions | not offered; external engine if required |
| D9 | Retention years and archive of attempts | 5 years for AML/audit; no attempt archive before 2 years |

---

## PART 7 — WHAT I COULD NOT CHECK

- The TypeScript code (all file and line references in v1 are taken on trust).
- The MariaDB version and which variables it supports.
- Real query shapes, data volume, hardware, and the Prisma version's behaviour with partitions and collations.
- Whether any code calls a payment partner inside a database transaction.
- Arabic full-text behaviour.

Each of these has a **VERIFY** marker above and a test in Part 5 that will expose a wrong assumption.

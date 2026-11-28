# pg-ledger — ledger persistence (P5-T04)

Rust port of the money-path persistence layer: the posting pipeline, GL-account resolution and its
cache, the per-shard projection and sequence, the cash-out lock helpers, the read helpers used by
checkpoints/invariants/statements, and shard repair.

The pure rules live in `pg-domain-ledger` (template validation, FNV-1a routing, folding, gapless
sequence arithmetic, the reduced repair decision). This crate owns every SQL statement, transaction
boundary and lock order.

Sources: `design/14-rust-port/02_contracts_reference.md` §12/§14/§17,
`project-design/parts/01-core-back/03-ledger.md` §3.3-§3.10 and the real TypeScript
`core-back/engine/ledger/{LedgerPoster,CheckpointService,InvariantVerifier,ShardRepair}.ts`,
`core-back/lib/storageEngine/{ledgerShardWriter,shardRouting,shardBalances}.ts`,
`core-back/lib/cashoutBalance.ts`.

## 1. Implemented

| Module | TypeScript source | What it does |
| :--- | :--- | :--- |
| `poster` | `LedgerPoster.ts:790-972`, `ledgerShardWriter.ts`, `cashoutBalance.ts` | `post_entry`: entry insert with `ON CONFLICT (ref_type, ref_id) DO NOTHING`, replay read-back, account resolution, shard routing, folded shard upsert, gapless `shard_seq`, one `unnest` line insert, optional `ledger.entry_posted`. Advisory wallet lock, shard pre-lock for cash-outs, wallet balance read. |
| `accounts` | `LedgerPoster.ts:1086-1299` | Resolution order explicit id → context override → scoped lookup → platform fallback → `GL_ACCOUNT_NOT_FOUND`; one batched candidate `SELECT`; bounded 60 s cache of **scoped** hits only (fallbacks are never cached); `MISSING_LEDGER_CURRENCY`. |
| `reads` | `ledgerLines.ts`, `shardBalances.ts:116-152`, `InvariantVerifier.ts`, `CheckpointService.ts:116-170` | Paged account lines with `created_at` window + filtered totals, entry lines bounded by the parent entry, live natural-sign balances from shards, the system equation, read-only per-shard verification (GAP/PARITY/NOOP/ADVANCED). |
| `repair` | `ShardRepair.ts:135-304`, `:452-615` | Deep journal read, RECOMPUTE vs REBASELINE plan with the checkpoint/status and per-baseline counts, SHA-256 `planHash`, compare-and-set apply, checkpoint move, `gl_shard_repairs` history row. |
| `template` / `error` | `LedgerPoster.ts:130-193`, `:204-222`, `:277-295` | Selector/line/template/context/options vocabulary, `LEDGER_RAW_SQL` refusal, `toFixed(4)` money rounding, the TypeScript error codes on `LedgerError::code()`. |

Posting pipeline (parity, in the caller's transaction):

1. `pg_domain_ledger::validate_template`: at least one line, amounts > 0, Σdebit = Σcredit exactly.
2. `INSERT journal_entries (id, updated_at, ref_type, ref_id, description) … ON CONFLICT
   (ref_type, ref_id) DO NOTHING RETURNING`. A replay reads the existing entry and returns it with
   **empty lines** and no payload comparison.
3. Resolve accounts with one candidate `SELECT` over the `OR` of every scoped and fallback predicate,
   ordered by `id`, matched in memory with the same precedence. Only scoped hits enter the cache.
4. Route: `fnv1a32_utf16(ref_id) % shard_count` (UTF-16 code units), wallet debits to shard 0.
5. Fold per `(account, shard)`, sorted, one `INSERT INTO gl_account_shards … SELECT … FROM
   unnest(...) ORDER BY … ON CONFLICT DO UPDATE SET current_balance += delta, line_seq += n
   RETURNING line_seq`.
6. Insert every line in one `unnest` statement with `shard_seq = high_water - n + j` and v7 ids.
7. Optionally insert the `ledger.entry_posted` outbox row (off by default, like
   `createLedgerPoster`).

Lock rules (chapter 2 §17):

- Wallet debits take `pg_advisory_xact_lock(hashtextextended('wallet-balance:'||id, 0))` **first**,
  before the transaction holds a shard row (`acquire_wallet_advisory_lock`).
- A caller that is about to post (a cash-out) then calls `lock_shards_for` /
  `lock_shards_for_many`, which locks every shard row the posting will touch in one statement in the
  global `(account, shard)` order, and only then reads `wallet_ledger_balance`.
- `post_entry` never begins or commits a transaction; the money movement and the authorising state
  change commit together.

## 2. Public surface

```rust
post_entry(&mut PgConnection, &JournalTemplate, &PostOptions) -> Result<PostResult, LedgerError>
account_lines(...), entry_lines(...), live_balances(...), system_equation(...), verify_shard(...)
plan_shard_repair(...), apply_shard_repair(...)
acquire_wallet_advisory_lock(...), wallet_ledger_balance(...), lock_wallet_ledger_balance(...)
lock_shards_for(...), lock_shards_for_many(...)
AccountCache::{new, with_limits, get, insert, clear, len, is_empty}
check_ledger_raw_sql(Option<&str>) -> Result<(), LedgerError>
```

`LedgerError::code()` returns the TypeScript code (`UNBALANCED_JOURNAL_ENTRY`,
`INVALID_LEDGER_AMOUNT`, `GL_ACCOUNT_NOT_FOUND`, `JOURNAL_ENTRY_CONFLICT`,
`MISSING_LEDGER_CURRENCY`, `GL_SHARD_NOT_FOUND`, `SHARD_REPAIR_PLAN_CHANGED`,
`SHARD_REPAIR_NEEDS_APPROVAL`, …) for a future HTTP adapter.

## 3. Deliberate deviations from the TypeScript

Recorded here for `DEVIATIONS.md` (the coordinator owns that file; do not edit it from this crate):

1. **Raw path only.** `LEDGER_RAW_SQL=false` selects the Prisma/ORM path in TS. This port refuses it
   (`LEDGER_RAW_SQL_REQUIRES_RAW_PATH`) instead of silently running the raw path. `PostOptions::from_env`
   and `post_entry` both enforce it; the process caches the answer once.
2. **Currency is always scoped.** The Rust `JournalTemplate` carries `currency` and
   `pg_domain_ledger::validate_template` requires it, so every account lookup filters by currency.
   TS only filters when the posting context supplied one (an unset context could match any
   currency). This is the strict-context behaviour and the intended target; context/selector currency
   still wins over the template currency.
3. **Selectors stay in the template.** `pg_ledger::JournalTemplate` holds account selectors and is
   resolved inside `post_entry` (TS step 3). The resolved form passed to the domain validator/router
   is `pg_domain_ledger::JournalTemplate`.
4. **Ids.** Entry/line/repair ids are generated in Rust with `Uuid::now_v7()`; the TS raw path asks
   PostgreSQL 18 for `uuidv7()` and repair history uses `gen_random_uuid()`. Shape and ordering are
   equivalent; no contract exposes the generation site.
5. **Repair apply uses compare-and-set.** TS takes `FOR UPDATE` on the shard and reuses a
   frozen-part/tail read under the lock. Here the deep read happens first and the apply is
   `UPDATE … WHERE current_balance = $before AND line_seq = $before_line_seq`; a lost CAS returns
   `stale: true` and writes nothing. This is the AUTO-10 goal (never hold the shard lock over a deep
   read) and the same deviation `pg-workers` already uses. The `maxTailLines` / frozen-part
   machinery is therefore absent.
6. **`planHash` is SHA-256 over the exact TS canonical JSON**, computed in the SQL adapter. The
   reduced planner in `pg-domain-ledger` keeps an FNV-1a change token (it does not have the
   checkpoint/status/count inputs); this crate does not use that token for the stored history.
7. **Money is rounded to 4 dp in Rust** (`MidpointAwayFromZero`) before binding, like the TS
   `toFixed(4)`; a template with more than four decimals is accepted and rounded, exactly as the TS
   raw path does.
8. **No `audit_log` row and no operator-case annotation on repair.** `gl_shard_repairs` is written in
   full, but `GL_SHARD_REPAIRED` audit shipping and the `MISMATCH` case note belong to
   `pg-db::audit` / the operator-case library and are not duplicated here.
9. **No 3 s shard-width process cache.** Widths are read once per posting (`SELECT id, shard_count …
   WHERE id = ANY(...)`). The TS cache is a 3 s stale-while-revalidate optimisation; adding it is a
   follow-up if profiling asks for it.
10. **`require_currency` is checked before the entry insert.** TS checks it during account
    resolution, after the entry insert, and relies on the caller rolling back. The Rust check is pure
    and runs first; successful paths are unchanged. `LEDGER_STRICT_CONTEXT` is effectively always
    satisfied because the template always carries a currency.
11. **Defensive reads.** `verify_shard` is read-only (no checkpoint advance); the moving capture,
   failure counters and case raising stay in `pg_workers::checkpoint`.
12. **`SET LOCAL statement_timeout`/`lock_timeout` are not issued by `apply_shard_repair`.** The
    function runs on the caller's connection; a transaction runner that wants the TS budgets must set
    them itself (the `pg-db` unit-of-work already does).

## 4. Not ported (remaining work)

- **Checkpoint worker wiring (P6-T06).** `pg-workers` already owns the moving
  `CheckpointService`/`LedgerCheckpointWorker`, including its own CAS auto-repair. `pg-ledger`
  provides the read-only `verify_shard`, `system_equation`, `live_balances` and the full manual
  `plan_shard_repair`/`apply_shard_repair`. P6-T06 should decide whether the worker calls these
  helpers or keeps its reduced planner; the two must not diverge on the repair gate.
- **Replica routing.** Every query takes the connection/pool it is given. `pg-db::replica` exists but
  is not wired here; the balance/statement reads are always served by the primary today (parity with
  the TS storage engine, GAP-006).
- **Outbox relay consumer.** The optional `ledger.entry_posted` row is written but nothing consumes
  the topic (same as TS since 2026-11-04).
- **Audit log + operator cases** for a repair (see deviation 8).
- **HTTP routes / error envelope mapping** (P5-T06) — `LedgerError::code()` is ready for it.
- **Criterion benchmark (≤ 50 µs) and BL-1 measurement.** The task's DoD mentions them; this crate
  has no benchmark harness yet and no `criterion` dependency in the workspace.
- **Journal partition maintenance** (`ensure_journal_line_partitions`, default-partition guard) —
  P6-T06 / core-shell territory.
- **Multi-currency nuance** of the TS lookup when no context currency is set (deviation 2).
- **`account_lines` filter surface** is the window/direction/page the ledger tests and statements
  need; the full admin filter set (`refType`, `search`, sort) stays in the HTTP/read-route layer.

## 5. Tests

```bash
cd backend-rs
cargo test -p pg-ledger                      # 36 unit + 15 live tests
cargo clippy -p pg-ledger --all-targets --no-deps -- -D warnings
cargo fmt -p pg-ledger
```

The live suite (`tests/live_pg.rs`) runs against `PG_TEST_DATABASE_URL` (default
`postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test`, schema 46) and prints
`skip: PostgreSQL not reachable …` when the database is down. Every test:

- seeds its GL accounts in its own transaction (the `gl_accounts_create_shards` trigger creates the
  shard rows), posts, asserts, and **rolls back**, so the append-only `journal_entries`,
  `journal_lines`, `gl_shard_repairs` and the audit trail are never modified;
- uses the dedicated currency `XTS`, so the seeded `LYD`/`USD`/`EUR` accounts of a populated stack
  can never satisfy or shadow a lookup (uncommitted rows of concurrent tests are invisible).

Coverage: balanced posting and natural-sign balances, global imbalance rejection (entry not
written), replay idempotency (no shard move, no duplicate lines), per-shard gapless sequences,
shard-vs-journal parity, multi-line folding and multi-shard targets, wallet debit shard 0 and
wallet credit spreading, `GL_ACCOUNT_NOT_FOUND`, explicit/context account overrides, scoped-hit
caching vs uncached fallbacks, cash-out advisory/shard locks and balance reads, account/entry line
windows and totals, read-only shard verification (ADVANCED/PARITY/GAP), the system equation, repair
(RECOMPUTE, CAS history, plan-change refusal, approval gate) and the optional outbox row.

Last run against PostgreSQL 18.6 (schema 46): **36 unit + 15 live tests pass**.

## 6. Schema requirements

The statements need schema 14 or newer (per-shard sequenced checkpoints, `gl_shard_checkpoints`,
`gl_shard_repairs`); the project is at 46. Relevant objects:

- `gl_accounts` (`shard_count`, trigger `gl_accounts_create_shards`),
- `gl_account_shards` (`current_balance`, `line_seq`, PK `(gl_account_id, shard_id)`),
- `journal_entries` (unique `(ref_type, ref_id)`), `journal_lines` (partitioned, append-only,
  `shard_id`/`shard_seq`, `journal_lines_shard_seq_positive`),
- `gl_shard_checkpoints` (`checkpoint_balance/seq`, `baseline_seq`, status/failure fields),
- `gl_shard_repairs` (append-only history), `outbox_events`.

The journal and repair tables are append-only through triggers (`SQLSTATE 55000`); tests must roll
back instead of deleting, and any maintenance path needs the `pgw.ledger_maintenance` transaction
setting plus the maintenance role, exactly as in production.

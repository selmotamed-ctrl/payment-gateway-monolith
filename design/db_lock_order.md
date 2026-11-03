# Transaction lock order

Design `high_scale_db_architecture_v2.md` §2.6. Every transaction that writes
more than one hot row follows this order. The order is global: it is not a
suggestion for one module, and a writer may not acquire a later resource first
and then an earlier one.

## Global order

1. `payment_links` — the slot reservation / release row.
2. `payment_attempts` — the attempt lifecycle row.
3. `gl_accounts` — SYNC accounts only, **sorted by account id**.
4. `gl_balance_shards` — **sorted by `(gl_account_id, shard_no)`**.
5. Counters and derived rows:
   - `attempt_groups` (`success_count`),
   - `velocity_counters` (payer scopes inside the transaction; merchant scopes
     are flushed outside it),
   - `route_daily_volumes` shards,
   - `attempt_deadlines` (delete with the terminal status),
   - `merchant_daily_stats` (worker only, never in checkout/confirm).

`journal_entries` and `journal_lines` are inserted between steps 2 and 3 as an
append-only unit (entry first, then one multi-row line insert). They are not
updated or deleted, so they do not participate in the lock cycle.

## Rules

- **READ COMMITTED** on both application pools. The verifier explicitly opens
  a `REPEATABLE READ` read-only transaction; that transaction takes no write
  locks and is not part of this order.
- **No network call** to a payment partner inside a transaction. A partner
  call happens before the transaction starts and its result is passed in.
- The slot `UPDATE` for finite links is the first write. Infinite-use links are
  not updated at all; there is no counter to protect.
- `gl_accounts` are locked one conditional statement per account, in ascending
  `id` order. The SHARDED accounts are not read-modify-written; their balance
  rows are upserted after the SYNC accounts, in ascending `(gl_account_id,
  shard_no)` order.
- `attempt_deadlines` and the terminal status change are one transaction; the
  deadline row is deleted after the attempt row is written.
- A counter that is not required for the money invariant is updated after the
  money transaction commits (worker/outbox), never by adding another lock to
  the checkout path.
- Any retry goes through `core-back/lib/db/withTxRetry.ts`: MariaDB 1213/1205,
  at most three attempts, 5–40 ms jitter, and only when the operation is
  idempotent by construction (idempotency key or unique constraint). The
  wrapper counts every retry.
- Lock-wait timeouts: transactional pool `innodb_lock_wait_timeout = 5`,
  `max_statement_time = 15` (application statement timeout 15 s); background
  pool statement timeout 120 s and transaction timeout 60 s.

## Canonical examples

### Checkout confirm

```
BEGIN (READ COMMITTED)
  payment_links        UPDATE slot / release       -- step 1 (finite links only)
  payment_attempts     SELECT ... FOR UPDATE       -- step 2, by reference
  attempt_groups       UPDATE success_count        -- step 5, after the attempt
  journal_entries      INSERT                      -- append-only unit
  journal_lines        INSERT (single multi-row)
  gl_accounts          UPDATE ... WHERE id = ?     -- step 3, ascending id
  gl_balance_shards    INSERT ... ON DUPLICATE KEY -- step 4, ascending shard
  attempt_deadlines    DELETE WHERE attempt_id = ? -- step 5
COMMIT
```

### Refund / adjustment

```
BEGIN (READ COMMITTED)
  payment_attempts     SELECT ... FOR UPDATE       -- step 2
  journal_entries      INSERT                      -- append-only unit
  journal_lines        INSERT
  gl_accounts          UPDATE ... WHERE id = ?     -- step 3, ascending id
  gl_balance_shards    INSERT ... ON DUPLICATE KEY -- step 4
COMMIT
```

### Worker claim

```
BEGIN (READ COMMITTED)
  attempt_deadlines    SELECT ... FOR UPDATE SKIP LOCKED
  attempt_deadlines    UPDATE claimed_until/claimed_by
  payment_attempts     UPDATE status (only after the lease is held)
COMMIT
```

The worker claims a lease in the same transaction. It does not hold an
`attempt_deadlines` lock while making a partner network call; the call happens
after commit, and the next pass re-reads the attempt.

## Forbidden patterns

- `payment_attempts` before `payment_links` in a slot-writing transaction.
- Updating `gl_accounts` in hash order or in parallel connections (the order
  is only useful when it is ascending id).
- Reading a balance, checking it in application code, then updating it. Use
  the conditional `UPDATE ... WHERE id = ? AND (...)` and inspect
  `affectedRows`.
- Holding a transaction open across an HTTP client call, a vault call that
  may block on a network KMS, or a large export.
- Retrying a transaction whose callback is not idempotent by construction.
- Using `SELECT ... FOR UPDATE` on `payment_attempts` to find due work; due
  work is claimed from the small `attempt_deadlines` table.

## Verification

A grep-based unit test may fail when a writer module imports the repository
rows in another order. The design marks this as **VERIFY** feasibility; until
that test exists, code review and the concurrency tests T1/T2/T4 of Part 5 are
the gate. No performance claim is made here.

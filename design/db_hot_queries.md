# Hot query catalogue

This is the catalogue required by `high_scale_db_architecture_v2.md` §5.2.
It names the SQL shape, the index that must serve it, and the `EXPLAIN
ANALYZE` pass criteria. **No measurement is recorded here**; the harness in
Part 5 writes its output to `design/db_baseline_results.md`.

Pass criteria used for every hot query:

- no `Using filesort` and no `Using temporary` on a hot path;
- rows examined within 2× of rows returned;
- index-only where the table says “covering/index-only”;
- no `SELECT *` in a worker claim, and no `TEXT`/`BLOB` column in a claim or
  an index (schema lint §5.4).

Bind parameters are written as `?`.

## Checkout and payment lifecycle

### 1. Checkout page by link key
```sql
SELECT l.id, l.key, l.application_id, l.wallet_id, l.amount, l.currency,
       l.fee_bearer, l.infinite_use, l.use_count, l.confirmed_count,
       l.active_locked_count, l.state, l.expires_at
FROM payment_links l
WHERE l.key = ?;
```
Index: `payment_links_key_key` (unique).
Pass: primary/unique lookup, 1 row examined.

### 2. Initiate: finite-link slot reservation
```sql
UPDATE payment_links
SET active_locked_count = active_locked_count + 1, updated_at = NOW(3)
WHERE id = ? AND infinite_use = 0
  AND confirmed_count + active_locked_count < use_count;
```
Index: primary key `id`.
Pass: single-row conditional update; `affectedRows` is the slot decision. Infinite-use links must not run this statement.

### 3. Initiate: attempt-group create-or-get
```sql
INSERT INTO attempt_groups (id, link_id, customer_fingerprint, success_count)
VALUES (?, ?, ?, 0)
ON DUPLICATE KEY UPDATE id = id;
```
Index: `attempt_groups_link_id_customer_fingerprint_key` (unique).
Pass: unique lookup/insert, at most 1 row.

### 4. Initiate: insert the attempt
```sql
INSERT INTO payment_attempts
  (id, reference, idempotency_key, link_id, attempt_group_id, application_id,
   merchant_id, rail_id, route_id, credential_set_id, gateway_version_id,
   commission_profile_id, env, mode, status, requested_amount,
   total_charged_amount, fee_bearer, currency, customer_fields_masked,
   context_ciphertext, expires_at, grace_expires_at, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CREATED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
```
Index: primary key insert; uniqueness from `payment_attempts_reference_key` and `payment_attempts_link_id_idempotency_key_key`.
Pass: 1 row inserted; a duplicate idempotency key must be rejected by the unique index, not by a prior select.

### 5. Initiate: create the open deadline
```sql
INSERT INTO attempt_deadlines (attempt_id, kind, due_at, claimed_until, claimed_by)
VALUES (?, 'EXPIRE', ?, NULL, NULL)
ON DUPLICATE KEY UPDATE due_at = VALUES(due_at);
```
Index: primary key `(attempt_id, kind)`.
Pass: 1 row written to the small open-work table; never scans `payment_attempts`.

### 6. Confirm: lock the attempt
```sql
SELECT id, status, link_id, attempt_group_id, merchant_id, rail_id, route_id,
       credential_set_id, gateway_version_id, commission_profile_id,
       total_charged_amount, currency, expires_at, grace_expires_at,
       point_of_no_return
FROM payment_attempts
WHERE reference = ?
FOR UPDATE;
```
Index: `payment_attempts_reference_key`.
Pass: unique lookup, 1 row locked; no deadlock without retry.

### 7. Confirm: one success per attempt group
```sql
UPDATE attempt_groups
SET success_count = success_count + 1
WHERE id = ? AND success_count = 0;
```
Index: primary key.
Pass: 1 affected row means the money path may continue; 0 means another rail already won and the transaction rolls back.

### 8. Confirm: delete the open deadlines
```sql
DELETE FROM attempt_deadlines
WHERE attempt_id = ?;
```
Index: primary key prefix `attempt_id`.
Pass: removes at most 3 rows (`EXPIRE`, `POLL`, `GRACE_END`) in the same transaction as the terminal status.

## Webhooks, reconciliation and inbox

### 9. Webhook correlation by provider reference
```sql
SELECT id, merchant_id, status, total_charged_amount, currency
FROM payment_attempts
WHERE provider_reference = ?
ORDER BY created_at DESC
LIMIT 5;
```
Index: `payment_attempts_provider_ref_idx`.
Pass: no full scan; rows examined within 2× returned; if the reference is not unique, the `created_at` order is a small local sort and must stay under the hot-path limit.

### 10. Webhook correlation by gateway reference
```sql
SELECT id, merchant_id, status, total_charged_amount
FROM payment_attempts
WHERE gateway_reference = ?
LIMIT 5;
```
Index: `payment_attempts_gateway_ref_idx`.
Pass: index range, no temporary table.

### 11. Statement match by provider reference
```sql
SELECT id, status, total_charged_amount, gateway_fee_amount, currency
FROM payment_attempts
WHERE provider_reference = ?
LIMIT 1;
```
Index: `payment_attempts_provider_ref_idx`.
Pass: index lookup; statement ingestion does not scan by date.

### 12. Statement match by network reference
```sql
SELECT id, status, total_charged_amount
FROM payment_attempts
WHERE network_reference = ?
LIMIT 1;
```
Index: `payment_attempts_network_ref_idx` (DECISION D2: keep only if a real
card-dispute/statement query uses it).
Pass: index lookup; the P0/T5 write-amplification test decides whether the index stays.

### 13. Inbox claim
```sql
SELECT id, channel_id, gateway_id, env, source_ip, verified, dedupe_key,
       received_at, processed_at
FROM inbound_events
WHERE processed_at IS NULL
ORDER BY received_at ASC
LIMIT 50
FOR UPDATE SKIP LOCKED;
```
Index: `inbound_events_processed_at_received_at_idx`.
Pass: bounded claim, no blob column in the claim projection, lease updated in the same transaction.

### 14. Reconciliation item list
```sql
SELECT id, run_id, attempt_id, our_reference, provider_reference,
       statement_amount, statement_fee, result
FROM reconciliation_items
WHERE run_id = ?
ORDER BY id
LIMIT 100;
```
Index: `reconciliation_items_run_id_idx` (PK gives the `id` order within the run).
Pass: bounded keyset list; no count of the whole table.

### 15. Background job claim
```sql
SELECT id, job_type, reference_type, reference_id, payload_json, attempts
FROM background_jobs
WHERE state = 'QUEUED' AND available_at <= ?
ORDER BY available_at ASC
LIMIT 10
FOR UPDATE SKIP LOCKED;
```
Index: `background_jobs_state_available_at_idx`.
Pass: bounded claim; lease columns set inside the same transaction.

## Lists and search

### 16. Merchant list, default order
```sql
SELECT id, reference, status, total_charged_amount, currency, created_at
FROM payment_attempts
WHERE merchant_id = ?
ORDER BY created_at DESC, id DESC
LIMIT 50;
```
Index: `payment_attempts_merchant_id_created_at_idx` (InnoDB appends the PK).
Pass: keyset pagination, no `OFFSET`, no filesort.

### 17. Merchant list by status
```sql
SELECT id, reference, status, total_charged_amount, currency, created_at
FROM payment_attempts
WHERE merchant_id = ? AND status = ?
ORDER BY created_at DESC, id DESC
LIMIT 50;
```
Index: `payment_attempts_merchant_id_status_created_at_idx`.
Pass: no filesort; keyset cursor on `(created_at, id)`.

### 18. Admin global list by status
```sql
SELECT id, reference, merchant_id, status, total_charged_amount, created_at
FROM payment_attempts
WHERE status = ?
ORDER BY created_at DESC, id DESC
LIMIT 50;
```
Index: `payment_attempts_status_created_at_idx` (T5 decides whether this index
costs more than the admin filter is worth).
Pass: index range, no filesort; bounded count uses `LIMIT 10001` and a 15 s cache.

### 19. Admin merchant list by status
```sql
SELECT id, legalName, tradeName, status, kybStatus, created_at
FROM merchants
WHERE status = ?
ORDER BY created_at DESC, id DESC
LIMIT 50;
```
Index: `merchants_status_created_at_idx`.
Pass: keyset, no temporary sort.

### 20. Global search: merchant names
```sql
SELECT id, legalName, tradeName, status
FROM merchants
WHERE MATCH(legalName, tradeName) AGAINST (? IN BOOLEAN MODE)
LIMIT 20;
```
Index: `merchants_names_ft_idx`.
Pass: full-text index used; server `innodb_ft_min_token_size = 2`; Arabic
fixtures are a correctness gate, not a measured latency claim.

### 21. Global search: merchant identifiers
```sql
SELECT id, legalName, taxId, registrationNo
FROM merchants
WHERE taxId = ? OR registrationNo = ? OR contactEmail = ? OR contactPhone = ?
LIMIT 20;
```
Indexes: `merchants_taxId_idx`, `merchants_registrationNo_idx`,
`merchants_contactEmail_idx`, `merchants_contactPhone_idx`.
Pass: at most one query per searchable entity group; each branch uses an index.

### 22. Global search: exact payment reference
```sql
SELECT id, reference, merchant_id, status, total_charged_amount
FROM payment_attempts
WHERE reference = ?
LIMIT 20;
```
Index: `payment_attempts_reference_key`.
Pass: unique lookup; no free-text search over transactions (DECISION D8).

## Workers and counters

### 23. Sweeper claim
```sql
SELECT attempt_id, kind, due_at
FROM attempt_deadlines
WHERE due_at <= ? AND kind = 'EXPIRE'
  AND (claimed_until IS NULL OR claimed_until < ?)
ORDER BY due_at
LIMIT 50
FOR UPDATE SKIP LOCKED;
```
Index: `attempt_deadlines_due_idx`.
Pass: scans the small open-work table only; `claimed_until`/`claimed_by` are set in the same transaction.

### 24. Poll claim
```sql
SELECT attempt_id, kind, due_at
FROM attempt_deadlines
WHERE due_at <= ? AND kind = 'POLL'
  AND (claimed_until IS NULL OR claimed_until < ?)
ORDER BY due_at
LIMIT 50
FOR UPDATE SKIP LOCKED;
```
Index: `attempt_deadlines_due_idx` + PK prefix for `kind`.
Pass: bounded claim; never scans `payment_attempts` by status.

### 25. Wallet balance — SYNC account
```sql
SELECT current_balance, balance_floor
FROM gl_accounts
WHERE id = ?
  AND balance_mode = 'SYNC';
```
Index: primary key.
Pass: 1 row; no aggregate over the ledger.

### 26. Wallet balance — SHARDED account
```sql
SELECT shard_no, balance, line_count
FROM gl_balance_shards
WHERE gl_account_id = ?;
```
Index: primary key `(gl_account_id, shard_no)`.
Pass: at most 32 rows; no filesort.

### 27. Balance verification (open window)
```sql
SELECT created_at, direction, amount
FROM journal_lines
WHERE gl_account_id = ? AND created_at >= ?
ORDER BY created_at;
```
Index: `journal_lines_acct_time_cov_idx` (covering).
Pass: index-only; run inside the verifier's `REPEATABLE READ` read-only transaction.

### 28. Route daily volume read
```sql
SELECT shard_no, succeeded_count, total_charged_amount
FROM route_daily_volumes
WHERE route_id = ? AND day_bucket = ?;
```
Index: primary key `(route_id, day_bucket, shard_no)`.
Pass: at most 16 rows; the cap read is cached for 5 s (DECISION D7: soft cap by default).

### 29. Route daily volume write
```sql
INSERT INTO route_daily_volumes
  (route_id, day_bucket, shard_no, succeeded_count, total_charged_amount)
VALUES (?, ?, ?, 1, ?)
ON DUPLICATE KEY UPDATE
  succeeded_count = succeeded_count + 1,
  total_charged_amount = total_charged_amount + VALUES(total_charged_amount);
```
Index: primary key.
Pass: one shard row per write; no global route hot row.

### 30. Velocity counter increment
```sql
INSERT INTO velocity_counters
  (scope_type, scope_key, granularity, bucket, attempts, succeeded, amount)
VALUES (?, ?, ?, ?, 1, 0, ?)
ON DUPLICATE KEY UPDATE
  attempts = attempts + 1,
  amount = amount + VALUES(amount);
```
Index: primary key `(scope_type, scope_key, granularity, bucket)`.
Pass: one row per window bucket; payer scopes increment before reading back.

### 31. Velocity window read
```sql
SELECT bucket, attempts, succeeded, amount
FROM velocity_counters
WHERE scope_type = ? AND scope_key = ? AND granularity = ?
  AND bucket BETWEEN ? AND ?;
```
Index: primary key prefix.
Pass: ≤ 60 rows for a 1 h window; ≤ 84 rows for the mixed 24 h window.

### 32. KYB duplicate document
```sql
SELECT merchant_id
FROM kyb_documents
WHERE sha256 = ? AND merchant_id <> ?
LIMIT 1;
```
Index: `kyb_documents_sha256_idx`.
Pass: index lookup; stores `duplicate_of_merchant_id`, never a separate stats table.

### 33. Cache invalidation poll and purge
```sql
SELECT event_seq, topic, payload_key, created_at
FROM cache_invalidation_events
WHERE event_seq > ?
ORDER BY event_seq
LIMIT 500;

DELETE FROM cache_invalidation_events
WHERE created_at < ?
LIMIT 5000;
```
Indexes: primary key for the poll, `cie_created_at_idx` for the purge.
Pass: poll every 1 s, purge rows older than 1 h in bounded batches.

## SLO budget mapping

| Route | Maximum queries | Catalogue queries |
| :--- | ---: | :--- |
| `GET /pay/:key` | 4 (cached steady state 1) | 1 |
| `POST …/initiate` | 8 | 2–5 |
| `POST …/confirm` | 8 | 6–8 |
| `GET /wallets/:id/balance` | 2 | 25 or 26 |
| Any admin list | 3 | 18/19 + bounded count |
| Global search | 6 | 20–22, one per entity group |

The per-route counter lives in `core-back/lib/db/queryBudgetTracker.ts`.

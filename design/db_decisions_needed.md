# Database decisions needed

Per Part 0 rule 5 of `high_scale_db_architecture_v2.md`, no implementing agent
may decide an open item. The items below are still **open**; the default in
brackets is the behaviour currently assumed by the code and by the design
until an owner records a different answer.

Status: open — default in effect.

| # | Question | Default currently assumed | Where it appears |
| :--- | :--- | :--- | :--- |
| D1 | Identifier strategy | `CHAR(36) CHARACTER SET ascii COLLATE ascii_bin` for entity ids; `BIGINT UNSIGNED AUTO_INCREMENT` for `journal_lines`, `audit_log`, `attempt_step_logs`, `inbound_events` | schema/migrations (main), `design/db_manual_sql.md` |
| D2 | Keep `payment_attempts.network_reference` index | Keep for now; measure with T5 (§5.3) and remove if no real card-dispute/statement query uses it | `payment_attempts_network_ref_idx` |
| D3 | Statement file storage | 1:1 child table with `LONGBLOB`; `ROW_FORMAT=COMPRESSED` is optional and must be measured before it is relied on | `design/db_manual_sql.md` §5 |
| D4 | Replace `attempt_groups` with a unique generated column | Keep `attempt_groups` with `success_count`; do not drop it without the concurrent double-payment test (T4) | ledger/checkout schema |
| D5 | Tolerance of merchant-level velocity rules | Soft: overshoot bounded by the ≤ 1 s in-process flush buffer; payer scopes remain exact increment-then-read | velocity counters |
| D6 | Redis for velocity counters | Build the `VelocityStore` interface now; ship the MariaDB implementation first | velocity counters |
| D7 | Daily route cap soft or hard | Soft cap with overshoot bounded by the 5 s cache; only routes flagged `hard_cap` use the single-row conditional update | `route_daily_volumes` |
| D8 | Free-text search over transactions | Not offered inside MariaDB; if it becomes a requirement, feed an external search engine from an outbox | search |
| D9 | Retention years and archive of attempts | 5 years for AML/audit records; no `payment_attempts` archive before 2 years, reassess when hot indexes exceed 60 % of the buffer pool | retention/partition phase |

## Items that need a named owner before the related phase is closed

These are not new architecture choices; they are the VERIFY items from the
design that the code cannot answer by itself:

- **MariaDB version and supported variables.** `deploy/deploy.ts` detects the
  flavour and filters variables through `information_schema.SYSTEM_VARIABLES`
  before writing `/etc/mysql/conf.d/zz-payment-gateway.cnf`. Record the exact
  version used by the target host in `design/db_baseline_results.md`.
- **Hardware and network assumptions.** Every benchmark result must state the
  host CPU/RAM/disk, MariaDB version and connection latency; no p95 number is
  meaningful without them.
- **Arabic full-text behaviour.** The token size is set to 2. Verify the
  Arabic fixtures before relying on `MATCH … AGAINST` for names.
- **Partner calls inside database transactions.** The design forbids them.
  If any remain, they must be moved before the transaction; this is a code
  audit item, not a database decision.
- **Partition support on the exact Prisma version.** `prisma migrate` does not
  understand partitions; the drift check must be run with the manual SQL file
  applied before P8 is marked complete.

## Defaults that are *not* open

The following are fixed requirements, not decisions: `READ COMMITTED` for
both OLTP pools, automatic retry only for idempotent transactions, the lock
order in `design/db_lock_order.md`, and the three cache classes in §2.9.

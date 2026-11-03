# Baseline results — v2 implementation

Status: **measured** against the v2 baseline. This file records only numbers produced by `core-back/scripts/db-benchmark.ts`; no figure is copied from another environment.

Reproduce the measured run with:

```bash
cd core-back
DATABASE_URL="mysql://.../payment_gateway_benchmark" \
BENCHMARK_SOAK_SECONDS=600 BENCHMARK_SOAK_WRITERS=64 \
BENCHMARK_T2_CONCURRENCY=1000 BENCHMARK_OUTPUT=/tmp/pg-db-benchmark.json \
bun run db-benchmark
```

## Environment

| Item | Value |
| :--- | :--- |
| Date/time of run | 2026-11-03T00:21:43.732Z UTC |
| Git commit | `7a15842` + 95 changed/untracked files (working tree dirty) |
| Host CPU | Intel(R) Core(TM) i5-14400F (16 threads) |
| Host RAM | 31.1 GiB |
| Disk / filesystem | `/dev/sda2`, btrfs, 204 GiB capacity, 133 GiB used, 70 GiB free |
| MariaDB version | 13.0.2-MariaDB |
| MariaDB configuration file | Local server defaults; generated deploy config (`zz-payment-gateway.cnf`) was not applied to this host |
| Buffer pool size | 128 MiB |
| Dataset size / seeder profile | COMPACT: 15,000 attempts, 43,796 journal lines, 8,500 links |
| Client and database network | localhost TCP, same host |
| App session isolation | `READ COMMITTED` on both pools (pool init SQL) |

Notes: the local server has `innodb_ft_min_token_size=3` and a 128 MiB buffer pool. The deploy-generated config raises the token setting to 2 and the buffer pool to the configured host-RAM percentage; those values were not applied on this workstation. This is a small development-size dataset, not a production-size sizing claim.

## P0 gates

| Gate | Status | Evidence |
| :--- | :--- | :--- |
| 33-query catalogue runs and prints results | PASS | 33/33 ran; 0 errors; one documented local filesort (query 9) |
| T1 — 200 concurrent slot reservations on one infinite-use link | PASS | 200/200 fulfilled, 0 rejected, p95 51.422 ms, total 53.506 ms |
| T2 — 1 000 concurrent confirmations across 10 merchants | PASS | 1000/1000 fulfilled, 0 deadlocks, 0 exhausted retries, 593.1 TPS |
| T3 — ledger soak, 64 writers, 10 minutes, kill -9 writer | PASS | 144,473 postings, 240.8 TPS, invariant 0.0000, killed-child rows 0 |
| T4 — same link/customer, two rails within 5 ms | PASS | two concurrent guarded updates: [1, 0], affected=1, success_count=1 |
| T5 — write amplification with/without removable indexes | NOT RUN | Deferred; no index was dropped or restored on the measured database |

T2 and T3 used `withTxRetry`; after the ledger posting order was changed to lock SYNC `gl_accounts` rows before inserting journal lines, the run recorded zero deadlocks and zero exhausted retries. The killed-child test killed a separate writer process during an open transaction; the committed database contained zero rows for that reference and the invariant stayed at `0.0000`.

## Query catalogue results

`rows examined` is the MariaDB `ANALYZE FORMAT=JSON` actual `r_rows` where available, otherwise the optimizer estimate. Write statements are shown from `EXPLAIN FORMAT=JSON` (MariaDB does not expose row estimates for them). Returned rows are bounded by the SQL `LIMIT`; point lookups return 0 or 1 row.

| # | Query | Index / access | Rows examined | Filesort/temporary | Pass/fail |
| ---: | :--- | :--- | ---: | :--- | :--- |
| 1 | Checkout page by link key | `payment_links_key_key` / const | 0 | none | PASS |
| 2 | Finite-link slot reservation | `PRIMARY` / range | 1 | none | PASS |
| 3 | Attempt-group create-or-get | PK insert (write) | — | none | PASS |
| 5 | Deadline create-or-update | PK insert (write) | — | none | PASS |
| 6 | Confirm lock by reference | `payment_attempts_reference_key` / const | 1 | none | PASS |
| 7 | Attempt-group success guard | `PRIMARY` / range | 1 | none | PASS |
| 8 | Deadline delete | `PRIMARY` / range | 1 | none | PASS |
| 9 | Webhook by provider reference | `payment_attempts_provider_ref_idx` / ref | 1 | filesort | PASS (documented ≤5-row local sort) |
| 10 | Webhook by gateway reference | `payment_attempts_gateway_ref_idx` / ref | 1 | none | PASS |
| 11 | Statement match by provider reference | `payment_attempts_provider_ref_idx` / ref | 1 | none | PASS |
| 12 | Statement match by network reference | `payment_attempts_network_ref_idx` / ref | 1 | none | PASS |
| 13 | Inbox claim | `inbound_events_processed_at_received_at_idx` / ref | 1 | none | PASS |
| 14 | Reconciliation item list | `reconciliation_items_run_id_idx` / ref | 1 | none | PASS |
| 15 | Background job claim | `background_jobs_state_available_at_idx` / range | 1 | none | PASS |
| 16 | Merchant list default | `payment_attempts_merchant_id_created_at_idx` / ref | 50 | none | PASS |
| 17 | Merchant list by status | `payment_attempts_merchant_id_status_created_at_idx` / ref | 50 | none | PASS |
| 18 | Admin global list by status | `payment_attempts_status_created_at_idx` / range | 50 | none | PASS |
| 19 | Admin merchant list by status | `merchants_status_created_at_idx` / range | 47 | none | PASS |
| 20 | Merchant name full-text search | `merchants_names_ft_idx` / fulltext | 0 | none | PASS |
| 21 | Merchant identifier search | index_merge (no single key) | 0 | none | PASS |
| 22 | Exact payment reference search | `payment_attempts_reference_key` / const | 0 | none | PASS |
| 23 | Sweeper claim | `attempt_deadlines_due_idx` / range | 1 | none | PASS |
| 24 | Poll claim | `attempt_deadlines_due_idx` / range | 1 | none | PASS |
| 25 | Wallet balance (SYNC) | `PRIMARY` / const | 0 | none | PASS |
| 26 | Wallet balance (SHARDED) | `PRIMARY` / ref | 1 | none | PASS |
| 27 | Balance verification open window | `journal_lines_acct_time_cov_idx` / range | 12 | none | PASS |
| 28 | Route daily volume read | `PRIMARY` / ref | 0 | none | PASS |
| 29 | Route daily volume write | PK insert (write) | — | none | PASS |
| 30 | Velocity counter increment | PK insert (write) | — | none | PASS |
| 31 | Velocity window read | `PRIMARY` / range | 0 | none | PASS |
| 32 | KYB duplicate document | `kyb_documents_sha256_idx` / ref | 1 | none | PASS |
| 33 | Cache invalidation poll | `PRIMARY` / range | 0 | none | PASS |
| 34 | Cache invalidation purge | `cie_created_at_idx` / range | 1 | none | PASS |

The only filesort is query 9 (webhook correlation by provider reference ordered by `created_at`, `LIMIT 5`). The catalogue explicitly allows that bounded local sort when a reference is not unique. Query 15 now uses `ORDER BY available_at ASC` and the `background_jobs_state_available_at_idx` index, eliminating the previous filesort.

## Query budget results

Not collected in this run. The `queryBudgetTracker` exists, but route-level budget instrumentation was not part of the benchmark harness; these rows must stay unmeasured until the runtime counters are wired and read.

| Route | Budget | Queries observed | Pass |
| :--- | ---: | ---: | :--- |
| `GET /pay/:key` | 4 | not collected | TBD |
| `POST …/initiate` | 8 | not collected | TBD |
| `POST …/confirm` | 8 | not collected | TBD |
| `GET /wallets/:id/balance` | 2 | not collected | TBD |
| Any admin list | 3 | not collected | TBD |
| Global search | 6 | not collected | TBD |

## Soak / stability (P9)

| Observation | Start | End | Stable? |
| :--- | ---: | ---: | :--- |
| `trx_rseg_history_len` | not captured | not captured | NOT MEASURED |
| Growing queue tables | 0 deadlines, queue tables not measured | post-run not captured | NOT MEASURED |
| Ledger drift | 0.0000 | 0.0000 | PASS |
| Replica lag (P8) | — | — | NOT AVAILABLE (no replica configured) |

The soak ran for 10 minutes at 240.8 postings/s with 64 writers. A 4-hour P9 soak and the replica-lag guard were not run because this workstation has no replica and the run window was limited to the measured 10-minute gate.


## Deployment smoke (post-benchmark)

After the benchmark, the dev database `pgp` was reset to the v2 baseline and the
single-host deploy was run from the dirty working tree (`7a15842` + changes).

| Check | Result |
| :--- | :--- |
| Schema version | `7` |
| Dataset after deploy | 112,732 attempts, 394,284 journal lines (STANDARD synthetic history) |
| Ledger drift after deploy | `0.0000` |
| Core `/health` (mTLS) | PASS |
| Admin/merchant/checkout back `/health` | PASS |
| Admin/merchant/checkout/fake-rails vhosts | PASS |
| mTLS admin/merchant/checkout -> core health | PASS |

The deploy also wrote `/etc/mysql/conf.d/zz-payment-gateway.cnf`. The buffer
pool value was skipped because the host RAM was not resolved on this local
all-in-one target; the server was not restarted, so those settings are not
active until an operator restarts MariaDB.

## Remaining implementation gaps

- P8 monthly partitions for log tables are not applied in the baseline; the partition DDL remains a documented manual step because the current log tables still carry foreign keys. The replica read path is also not configured in this environment.
- T5 index write-amplification comparison was not run.
- Route-level query budgets and the 4-hour P9 soak remain to be measured.

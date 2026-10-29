# core-back · Core Engine Service

The only service in the platform that touches the database, holds encryption keys, and executes
outbound gateway calls. It is reachable exclusively over Mutual TLS on the private network.

## Boundaries

- Owns `prisma/`, `@prisma/client`, `DATABASE_URL` and `KMS_MASTER_KEY`.
- Owns the dynamic rail engine, the double-entry ledger, the webhook inbox and the durable workers.
- Serves `/internal/admin`, `/internal/merchant` and `/internal/checkout`; each namespace is bound
  to exactly one client certificate common name (`admin-back`, `merchant-back`, `checkout-back`).
- Never listens on a public interface and is never published by a reverse proxy.

## Database

- **Engine:** MySQL 8.0+ / MariaDB 10.6+. The Prisma datasource is `provider = "mysql"`.
- **Adapter & driver:** `@prisma/adapter-mariadb` on top of the `mariadb` driver package.
- **Schema:** `prisma/schema.prisma`; the initial migration
  `prisma/migrations/20261029203000_init/migration.sql` is plain MySQL / MariaDB DDL.
- **Type mapping:** `String` → `VARCHAR(191)` (free-form content is declared `@db.Text`),
  `Bytes` → `BLOB` (the webhook body is `@db.LongBlob`), `Json` → `JSON`, money →
  `DECIMAL(18,4)`, Prisma enums → native `ENUM` columns.
- **Row locks:** `SELECT ... FOR UPDATE SKIP LOCKED` requires MySQL 8.0+ / MariaDB 10.6+.
- **Durable job queue:** `background_jobs` is the queue of the heavy request-path work. The
  request stores the work (`reconciliation_runs.file_content`, the dispute intake payload, the
  approval of an adjustment) and answers `202 Accepted`; the stateless `BackgroundJobWorker`
  claims the due jobs with `FOR UPDATE SKIP LOCKED`, retries them with a backoff
  (`available_at`) and recovers the jobs of a crashed node (`locked_at` lease).

## Runtime

```bash
./scripts/prepare-databases.sh # create the application and test databases on the MySQL server
bun run generate-mtls-certs   # internal CA, server certificate, three client certificates
bun run migrate-deploy         # apply the 64 table migration
bun run db-seed                # GL accounts, OD-1..OD-11 settings, roles, blueprints
bun run start                  # TLS 1.3 mTLS server on $PORT (default 4000)
bun run typecheck
bun test
```

`test/e2e/mariadb-payment.test.ts` drives a complete payment against the live
database. It skips itself when MariaDB is not reachable, so `bun test` stays
green on a machine without a database.

## Environment

| Variable | Purpose |
| :--- | :--- |
| `PORT` / `HOST` | Listener binding, defaults `4000` / `127.0.0.1` |
| `DATABASE_URL` | MySQL / MariaDB connection string (`mysql://user:password@host:3306/payment_gateway_monolith`) |
| `MTLS_CA_CERT_PATH` | Internal CA used to verify client certificates |
| `MTLS_SERVER_CERT_PATH` / `MTLS_SERVER_KEY_PATH` | Server certificate and key |
| `KMS_MASTER_KEY` | Root key for the AES-256-GCM vault and session signing |
| `WORKER_ENABLED` | Starts the expiry, poll, inbox and notification workers |
| `WORKER_POLL_INTERVAL_MS` / `WORKER_BATCH_SIZE` | Worker cadence and batch size |
| `WORKER_BACKGROUND_JOBS_ENABLED` | Starts the durable job queue worker (the statement reconciliation and the dispute / adjustment execution) |
| `WORKER_BACKGROUND_JOBS_INTERVAL_MS` / `WORKER_BACKGROUND_JOBS_BATCH_SIZE` | Queue drain cadence and batch size, defaults `2000` / `10` |
| `WORKER_BACKGROUND_JOBS_LEASE_SECONDS` | Lease of a claimed job: a job that is still `RUNNING` when its lease expired belonged to a crashed node and is re-queued, defaults `300` |
| `WORKER_RETENTION_ENABLED` | Starts the record retention worker (OD-4), the only place where regulatory evidence is removed |
| `WORKER_RETENTION_INTERVAL_MS` / `WORKER_RETENTION_BATCH_SIZE` | Retention cadence and batch size, defaults `3600000` / `500` |
| `RETENTION_DRY_RUN` | The retention worker reports what it would purge without deleting anything |
| `NOTIFICATION_WEBHOOK_URL` | Endpoint of the SMS / email aggregator. Optional: without it the platform uses the log transport, which reports `SENT` instead of `DELIVERED` |
| `NOTIFICATION_WEBHOOK_TIMEOUT_MS` | Strict timeout of a single delivery attempt against the aggregator, defaults `5000` |

## Design references

- `design/payment_gateway_final_design-v5.md` — master architecture v5.0
- `design/opencode_technical_delivery_design.md` — phased delivery tracker and verification record

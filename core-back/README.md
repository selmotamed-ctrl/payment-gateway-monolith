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

- **Engine:** PostgreSQL 18. The Prisma datasource is `provider = "postgresql"`.
- **Adapter & driver:** `@prisma/adapter-pg` (`PrismaPg`) on top of the `pg` driver package.
- **Schema:** `prisma/schema.prisma`; the PostgreSQL baseline is
  `prisma/migrations/20261103000000_postgres18_init/migration.sql`, followed by the storage
  engine (`partial`, covering, BRIN and GIN/trigram indexes) and CQRS read-model migrations.
- **Legacy history:** the old MySQL / MariaDB migrations are preserved under
  `prisma/migrations-mysql-legacy/`; the runtime still accepts `mysql://` / `mariadb://` URLs for
  the legacy adapter, but PostgreSQL 18 is the supported production engine.
- **Type mapping:** UUID primary keys (`@db.Uuid`), `String` → `TEXT` (fixed-size values use
  `@db.Char(n)` / `@db.VarChar(n)`), `Bytes` → `BYTEA`, `Json` → `JSONB`, money →
  `NUMERIC(18,4)`, timestamps → `TIMESTAMP(3)` (`TIMESTAMPTZ(3)` for `@db.Timestamptz`), and
  Prisma enums → native PostgreSQL enum types.
- **Row locks:** `SELECT ... FOR UPDATE SKIP LOCKED` is native PostgreSQL.
- **Storage engine:** the transactional outbox / audit outbox, `gl_account_shards`, backup
  catalog / restore-drill tables and the `rm_*` read models are part of the baseline. Worker
  queues use partial indexes and the hot append-only tables use BRIN and covering indexes.
- **Durable job queue:** `background_jobs` is the queue of the heavy request-path work. The
  request stores the work (`reconciliation_runs.file_content`, the dispute intake payload, the
  approval of an adjustment) and answers `202 Accepted`; the stateless `BackgroundJobWorker`
  claims the due jobs with `FOR UPDATE SKIP LOCKED`, retries them with a backoff
  (`available_at`) and recovers the jobs of a crashed node (`locked_at` lease).

## Runtime

```bash
# The repository's local PostgreSQL 18 server listens on 127.0.0.1:55432.
POSTGRES_PORT=55432 POSTGRES_ADMIN_USER=postgres ./scripts/prepare-databases.sh
bun run generate-mtls-certs   # internal CA, server certificate, three client certificates
bun run migrate-deploy         # apply the PostgreSQL baseline + storage/CQRS migrations
bun run db-seed                # GL accounts, OD-1..OD-11 settings, roles, blueprints
bun run start                  # TLS 1.3 mTLS server on $PORT (default 4000)
bun run typecheck
bun test
```

The tests use the dedicated PostgreSQL test database. Export either
`POSTGRES_TEST_DATABASE_URL` or `DATABASE_URL`; without either the harness
falls back to the local server:

```bash
export DATABASE_URL=postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test
bun test
```

`test/e2e/postgres-payment.test.ts` drives a complete payment against the live
PostgreSQL database. It skips itself when PostgreSQL is not reachable, so
`bun test` stays green on a machine without a database.

## Environment

| Variable | Purpose |
| :--- | :--- |
| `PORT` / `HOST` | Listener binding, defaults `4000` / `127.0.0.1` |
| `DATABASE_URL` | PostgreSQL connection string (`postgresql://user:password@host:5432/payment_gateway_monolith`) |
| `MTLS_CA_CERT_PATH` | Internal CA used to verify client certificates |
| `MTLS_SERVER_CERT_PATH` / `MTLS_SERVER_KEY_PATH` | Server certificate and key |
| `KMS_MASTER_KEY` | Root key for the AES-256-GCM vault and session signing |
| `WORKER_ENABLED` | Starts the expiry, poll, inbox and notification workers |
| `WORKER_POLL_INTERVAL_MS` / `WORKER_BATCH_SIZE` | Worker cadence and batch size |
| `WORKER_BACKGROUND_JOBS_ENABLED` | Starts the durable job queue worker (the statement reconciliation and the dispute / adjustment execution) |
| `WORKER_BACKGROUND_JOBS_INTERVAL_MS` / `WORKER_BACKGROUND_JOBS_BATCH_SIZE` | Queue drain cadence and batch size, defaults `2000` / `10` |
| `WORKER_BACKGROUND_JOBS_LEASE_SECONDS` | Lease of a claimed job: a job that is still `RUNNING` when its lease expired belonged to a crashed node and is re-queued, defaults `300` |
| `WORKER_KYB_EXPIRY_INTERVAL_MS` / `WORKER_KYB_EXPIRY_BATCH_SIZE` | KYB expiry, notice, suspension and periodic re-verification cadence and batch size, defaults `21600000` / `200` |
| `WORKER_RETENTION_ENABLED` | Starts the record retention worker (OD-4), the only place where regulatory evidence is removed |
| `WORKER_RETENTION_INTERVAL_MS` / `WORKER_RETENTION_BATCH_SIZE` | Retention cadence and batch size, defaults `3600000` / `500` |
| `RETENTION_DRY_RUN` | The retention worker reports what it would purge without deleting anything |
| `NOTIFICATION_WEBHOOK_URL` | Endpoint of the SMS / email aggregator. Optional: without it the platform uses the log transport, which reports `SENT` instead of `DELIVERED` |
| `NOTIFICATION_WEBHOOK_TIMEOUT_MS` | Strict timeout of a single delivery attempt against the aggregator, defaults `5000` |

## Design references

- `design/payment_gateway_final_design-v5.md` — master architecture v5.0
- `design/opencode_technical_delivery_design.md` — phased delivery tracker and verification record

# core-back · Core Engine Service

The only service in the platform that touches the database, holds encryption keys, and executes
outbound gateway calls. It is reachable exclusively over Mutual TLS on the private network.

## Boundaries

- Owns `prisma/`, `@prisma/client`, `DATABASE_URL` and `KMS_MASTER_KEY`.
- Owns the dynamic rail engine, the double-entry ledger, the webhook inbox and the durable workers.
- Serves `/internal/admin`, `/internal/merchant` and `/internal/checkout`; each namespace is bound
  to exactly one client certificate common name (`admin-back`, `merchant-back`, `checkout-back`).
- Never listens on a public interface and is never published by a reverse proxy.

## Runtime

```bash
bun run generate-mtls-certs   # internal CA, server certificate, three client certificates
bun run migrate-deploy         # apply the 64 table migration
bun run db-seed                # GL accounts, OD-1..OD-11 settings, roles, blueprints
bun run start                  # TLS 1.3 mTLS server on $PORT (default 4000)
bun run typecheck
bun test
```

## Environment

| Variable | Purpose |
| :--- | :--- |
| `PORT` / `HOST` | Listener binding, defaults `4000` / `127.0.0.1` |
| `DATABASE_URL` | PostgreSQL connection string |
| `MTLS_CA_CERT_PATH` | Internal CA used to verify client certificates |
| `MTLS_SERVER_CERT_PATH` / `MTLS_SERVER_KEY_PATH` | Server certificate and key |
| `KMS_MASTER_KEY` | Root key for the AES-256-GCM vault and session signing |
| `WORKER_ENABLED` | Starts the expiry, poll, inbox and notification workers |
| `WORKER_POLL_INTERVAL_MS` / `WORKER_BATCH_SIZE` | Worker cadence and batch size |
| `NOTIFICATION_WEBHOOK_URL` | Endpoint of the SMS / email aggregator. Optional: without it the platform uses the log transport, which reports `SENT` instead of `DELIVERED` |
| `NOTIFICATION_WEBHOOK_TIMEOUT_MS` | Strict timeout of a single delivery attempt against the aggregator, defaults `5000` |

## Design references

- `design/payment_gateway_final_design-v5.md` — master architecture v5.0
- `design/opencode_technical_delivery_design.md` — phased delivery tracker and verification record

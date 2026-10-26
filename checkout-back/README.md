# checkout-back

Public SSL checkout and inbound webhook edge API for the payment gateway platform.

- Runtime: Bun + Express 5 + Zod 4.
- No database access: the service owns no Prisma client, no `DATABASE_*` variable and no migration script.
- Every business operation is forwarded over mutual TLS to `core-back` through `lib/mtlsClient/index.ts` using the client certificate identified by `CN=checkout-back`.
- Hard zero-trust rule: no request schema accepts `amount` or `currency`; `core-back` resolves the money from `payment_links` by `linkKey`. Requests carrying monetary fields are rejected with `400 AMOUNT_NOT_ACCEPTED`.
- Edge vocabularies are translated to the canonical `core-back` contract: client events use `completeCallback|errorCallback|widgetEvent|returnHint` (legacy `COMPLETE_CALLBACK` style aliases are translated), and inbound environments use `SANDBOX|LIVE` (`sandbox|test|uat` become `SANDBOX`, `live|production` become `LIVE`).
- Inbound webhook headers are allowlisted: only `content-type`, `user-agent`, `content-length`, `x-signature`, `x-gateway-signature`, `x-hub-signature-256`, `x-moomalat-signature`, `x-timestamp` and `x-nonce` reach `core-back`; `authorization`, `cookie` and every other `x-` header are dropped.

## Routes

| Method | Path | Core path |
| :--- | :--- | :--- |
| GET | `/api/v1/pay/:linkKey` | `GET /internal/checkout/pay/:linkKey` |
| POST | `/api/v1/pay/:linkKey/initiate` | `POST /internal/checkout/pay/:linkKey/initiate` |
| GET | `/api/v1/pay/:linkKey/logs/:attemptId` | `GET /internal/checkout/pay/:linkKey/logs/:attemptId` |
| GET | `/api/v1/pay/:linkKey/logs/:attemptId/status` | SSE proxy of the core stream |
| POST | `/api/v1/pay/:linkKey/logs/:attemptId/confirm` | `POST /internal/checkout/pay/:linkKey/logs/:attemptId/confirm` |
| POST | `/api/v1/pay/:linkKey/logs/:attemptId/resend` | `POST /internal/checkout/pay/:linkKey/logs/:attemptId/resend` |
| POST | `/api/v1/pay/:linkKey/logs/:attemptId/cancel` | `POST /internal/checkout/pay/:linkKey/logs/:attemptId/cancel` |
| POST | `/api/v1/pay/:linkKey/logs/:attemptId/client-event` | `POST /internal/checkout/pay/:linkKey/logs/:attemptId/client-event` |
| ANY | `/api/v1/inbound/:gateway/:env/:pathToken` | `ANY /internal/checkout/inbound/:gateway/:env/:pathToken` (raw bytes, `env` translated to `SANDBOX`/`LIVE`) |
| GET, POST | `/api/v1/return/:attemptToken` | `GET, POST /internal/checkout/return/:attemptToken` |

## Environment

`PORT` (default `4103`), `CORE_BACK_URL` (https, required), `MTLS_CLIENT_CERT_PATH`, `MTLS_CLIENT_KEY_PATH`, `MTLS_CA_CERT_PATH` (all required), `CORE_REQUEST_TIMEOUT_MS`, `TRUSTED_PROXY_CIDRS`, `MAX_JSON_BODY_BYTES`, `MAX_INBOUND_BODY_BYTES`, `CHECKOUT_FRONT_BASE_URL`, `CHECKOUT_FRONT_STATUS_PATH`, `PAY_RATE_LIMIT_MAX`, `PAY_RATE_LIMIT_WINDOW_MS`, `INBOUND_RATE_LIMIT_MAX`, `INBOUND_RATE_LIMIT_WINDOW_MS`.

## Commands

```bash
bun install
bun run start
bun run dev
bun test
bun run typecheck
```

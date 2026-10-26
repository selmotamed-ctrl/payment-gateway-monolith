# merchant-back

Public SSL merchant portal and merchant server API for the payment gateway platform.

- Runtime: Bun + Express 5 + Zod 4.
- No database access: no Prisma client, no `DATABASE_*` variable, no migration script.
- Every operation is forwarded over mutual TLS to `core-back` through `lib/mtlsClient/index.ts` using the client certificate identified by `CN=merchant-back`.
- Authorization headers are forwarded verbatim; `core-back` re-validates the token, the session, the MFA state, the IP allowlist and the authorities map on every call.

## Routes

Portal API, mounted under `/api/v1/merchant`:

| Method | Path |
| :--- | :--- |
| POST | `/auth/register`, `/auth/verify-identity`, `/auth/login`, `/auth/google`, `/auth/mfa/verify` |
| GET, PUT | `/onboarding/join-request` |
| POST | `/onboarding/kyb-documents` (multipart), `/onboarding/beneficial-owners`, `/onboarding/submit` |
| DELETE | `/onboarding/beneficial-owners/:id` |
| GET, POST | `/wallets`, `/applications`, `/links`, `/pos/terminals`, `/cashouts` |
| GET | `/wallets/:id`, `/wallets/:id/balance`, `/wallets/:id/statements`, `/wallets/:id/statements/:month/export` |
| PATCH | `/applications/:id`, `/pos/terminals/:id` |
| GET | `/links/:id`, `/links/:id/attempts`, `/payments`, `/disputes`, `/disputes/:id`, `/pos/terminals/:id`, `/stats/overview` |
| POST | `/links/:id/cancel`, `/pos/terminals/:id/screens`, `/disputes/:id/evidence` (multipart) |
| GET | `/pos/screens/:screenCode/stream` (SSE proxy) |
| GET, POST, DELETE | `/tokens` |
| PUT | `/tokens/:id/ips` |
| GET, POST, PUT | `/credential-sets` |

External merchant server API, mounted under `/api/v1/external` and restricted to `pg_live_` bearer tokens:

| Method | Path |
| :--- | :--- |
| POST | `/links`, `/links/:key/cancel` |
| GET | `/links/:key`, `/payments/:reference` |

## KYB and evidence uploads

The edge validates the multipart upload before any core call: declared MIME type, magic bytes (PNG `89 50 4E 47 0D 0A 1A 0A`, JPEG `FF D8 FF`, PDF `25 50 44 46 2D`) and the size cap. The validated file is forwarded to `core-back` as raw bytes with `x-upload-filename`, `x-upload-content-type`, `x-upload-sha256`, `x-upload-size` and base64url `x-upload-metadata` headers.

## Money rules

Link creation is a merchant portal capability, so `POST /links` and `POST /external/links` accept a decimal string `amount` and an ISO 4217 `currency`. The edge never performs arithmetic on money and always forwards the client supplied values unchanged; `core-back` re-validates the amount, the currency and the fee model before the link is persisted.

## Environment

`PORT` (default `4102`), `CORE_BACK_URL` (https, required), `MTLS_CLIENT_CERT_PATH`, `MTLS_CLIENT_KEY_PATH`, `MTLS_CA_CERT_PATH` (all required), `CORE_REQUEST_TIMEOUT_MS`, `TRUSTED_PROXY_CIDRS`, `MAX_JSON_BODY_BYTES`, `MAX_UPLOAD_BYTES`, `UPLOAD_ALLOWED_MIME`, `PG_LIVE_TOKEN_PREFIX`, `AUTH_RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_WINDOW_MS`, `API_RATE_LIMIT_MAX`, `API_RATE_LIMIT_WINDOW_MS`, `EXTERNAL_RATE_LIMIT_MAX`, `EXTERNAL_RATE_LIMIT_WINDOW_MS`, `POS_STREAM_TIMEOUT_MS`.

## Commands

```bash
bun install
bun run start
bun run dev
bun test
bun run typecheck
```

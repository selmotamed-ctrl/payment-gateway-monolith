# admin-back

LAN-only admin edge API for the payment gateway platform.

- Runtime: Bun + Express 5 + Zod 4.
- No database access: no Prisma client, no `DATABASE_*` variable, no migration script.
- Every operation is forwarded over mutual TLS to `core-back` through `lib/mtlsClient/index.ts` using the client certificate identified by `CN=admin-back`.
- The server binds to `ADMIN_BIND_HOST` (default `127.0.0.1`) and every `/api/v1/admin/*` call is restricted to `ADMIN_LAN_CIDRS`.
- Role and authority hints are read from the bearer token for coarse grained gating only; `core-back` remains the authoritative authority, re-verifying the signature, revocation, MFA state, IP allowlist and the `authorities_map` on every call.

## Routes

Mounted under `/api/v1/admin`:

| Area | Routes |
| :--- | :--- |
| Auth | `POST /auth/login`, `POST /auth/mfa` |
| Users | `GET, POST, PATCH /users`, `PATCH /users/:id` |
| Join requests and KYB | `GET /join-requests`, `GET /join-requests/:id`, `POST /join-requests/:id/assign`, `POST /join-requests/:id/request-info`, `POST /join-requests/:id/decide`, `POST /kyb-documents/:id/review` |
| Merchants | `GET /merchants`, `GET /merchants/:id`, `POST /merchants/:id/suspend`, `POST /merchants/:id/reinstate`, `POST /merchants/:id/propose-edit`, `GET /merchants/:id/detail-changes` |
| Four eyes | `GET /approvals`, `GET /approvals/:id`, `POST /approvals/:id/approve`, `POST /approvals/:id/reject` |
| AML (confidential) | `GET /aml/screenings`, `POST /aml/matches/:id/disposition`, `GET /aml/cases`, `POST /aml/cases/:id/propose`, `GET, POST /aml/rules`, `GET, POST /aml/reporting-rules`, `GET, POST /aml/reports` |
| Gateways and wizard | `GET, POST, PATCH /gateways`, `GET, POST /gateways/:id/versions`, `POST /gateways/:id/rollback`, `PUT /gateway-versions/:vid/environments`, `/auth`, `/settings`, `/crypto-profiles`, `/flows`, `/channels`, `/status-rules`, `/error-maps`, `POST /gateway-versions/:vid/dry-run`, `/run-suite`, `/submit-approval` |
| Rails and routes | `GET, POST, PATCH /rails`, `PUT /rails/:id/fields`, `GET, POST, PATCH /routes`, `POST /routes/:id/state` |
| Assets | `GET, POST /assets` |
| Operations | `GET /operator-cases`, `POST /operator-cases/:id/resolve`, `POST /attempts/:id/inquire` |
| Reconciliation | `GET, POST /reconciliation/sources`, `POST /reconciliation/upload`, `GET /reconciliation/runs` |
| Finance | `GET, POST /disputes`, `GET, POST /adjustments`, `GET /cashouts`, `POST /cashouts/:id/process`, `GET, POST /commission-profiles`, `GET, POST /velocity-rules`, `GET /finance/profitability`, `GET /finance/liquidity`, `GET /finance/invariant-check` |
| Settings | `GET, PUT /settings` |

## Environment

`PORT` (default `4101`), `ADMIN_BIND_HOST` (default `127.0.0.1`), `CORE_BACK_URL` (https, required), `MTLS_CLIENT_CERT_PATH`, `MTLS_CLIENT_KEY_PATH`, `MTLS_CA_CERT_PATH` (all required), `CORE_REQUEST_TIMEOUT_MS`, `TRUSTED_PROXY_CIDRS`, `ADMIN_LAN_CIDRS`, `ADMIN_AUTHORITY_HINTS`, `MAX_JSON_BODY_BYTES`, `MAX_UPLOAD_BYTES`, `UPLOAD_ALLOWED_MIME`, `ADMIN_RATE_LIMIT_MAX`, `ADMIN_RATE_LIMIT_WINDOW_MS`, `AUTH_RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_WINDOW_MS`, `RECONCILIATION_TIMEOUT_MS`.

## Commands

```bash
bun install
bun run start
bun run dev
bun test
bun run typecheck
```

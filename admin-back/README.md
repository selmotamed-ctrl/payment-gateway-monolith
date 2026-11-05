# admin-back

`admin-back` is the private-LAN edge/BFF for the admin portal. It accepts browser requests from `admin-front`, enforces the LAN boundary and coarse authority hints, validates and translates the public admin vocabulary, and forwards every operation over mutual TLS (mTLS) to `core-back` under `/internal/admin/*`.

- Runtime: Bun + Express 5 + Zod 4.
- Status: `partial` (see the canonical design part for the authoritative status).
- Generated blueprint: [`blueprint.md`](./blueprint.md)
- Canonical parts: [`Admin Edge BFF`](../project-design/parts/02-edge-services/01-admin-back.md), [`Shared Core Upstream Client`](../project-design/parts/02-edge-services/00-shared-core-upstream-client.md)
- Generated references: [`API route matrix`](../project-design/appendices/api-route-matrix.md), [`environment matrix`](../project-design/appendices/env-and-config-matrix.md)

## 1. Purpose and boundaries

`admin-back` owns:

- the admin LAN ingress, including the `ADMIN_LAN_CIDRS` check;
- request logging, rate limiting and CORS behavior;
- public-to-core schema validation and body mapping;
- multipart buffering and forwarding for reconciliation and KYB uploads;
- the mTLS pool and request context sent to `core-back`;
- advisory edge authority hints for AML and backup screens.

`admin-back` does not own:

- database access, Prisma, migrations or `DATABASE_URL`;
- `KMS_MASTER_KEY` or any other host's certificate/key;
- JWT signature verification, session revocation, MFA state or per-user IP allowlists;
- authority decisions, maker-checker enforcement, ledger writes, money arithmetic or audit writes.

Trust model: the edge is untrusted from core's point of view. The edge authenticates to core with a client certificate whose common name is exactly `admin-back`. Core verifies the certificate against the internal CA, binds it to the `/internal/admin` namespace, and independently re-validates the bearer token, user state, authorities and business invariants. Edge validation is for UX and contract stability; it is not the authority.

## 2. Architecture and request flow

`index.ts` creates a stateless Express app:

1. Disables `x-powered-by`.
2. Sets Express `trust proxy` to `false`; the LAN guard resolves forwarded IPs itself.
3. Emits no CORS headers unless `CORS_ALLOWED_ORIGINS` is set (no credentials), plus hand-written security headers.
4. Installs request logging with request-id resolution and secret redaction.
5. Serves unauthenticated `GET /health`.
6. Parses JSON and URL-encoded bodies with `MAX_JSON_BODY_BYTES`.
7. Mounts `/api/v1/admin` behind `enforceLanAccess`.
8. Adds the shared JSON 404 and error handlers.

The listener binds to `ADMIN_BIND_HOST` (default `127.0.0.1`). Deployment writes `127.0.0.1`, so only the co-located admin Nginx vhost reaches the process. The admin vhost is the LAN-facing listener.

Request flow for a protected call:

1. `enforceLanAccess` resolves the client IP from `x-real-ip` first, then `x-real-client-ip`, but only when the immediate peer is loopback or inside `TRUSTED_PROXY_CIDRS`. The result must be inside `ADMIN_LAN_CIDRS`.
2. `adminLimiter` applies the protected-router rate limit.
3. `requireSession` rejects a missing `Authorization` header with `401 AUTH_REQUIRED`. It does not parse or verify the header.
4. The route validates params, query and body with Zod and maps the public payload into the canonical core payload.
5. The shared client selects a core node, adds request context (`x-request-id`, `x-real-client-ip`, `x-client-user-agent`, `x-edge-service: admin-back`, bearer token, optional `x-pg-min-lsn`) and sends the request over mTLS.
6. The edge returns the declared status, or relays the core status for asynchronous routes, with the core JSON body. Core error envelopes (`code`, `message`, `details`, `reference`) are preserved.

Uploads use Multer memory storage. `forwardUpload()` sends the raw bytes with `x-upload-filename`, `x-upload-content-type`, `x-upload-sha256`, `x-upload-size` and base64url `x-upload-metadata`. Reconciliation uploads use a longer `RECONCILIATION_TIMEOUT_MS`.

## 3. Routes

All routes below are under `/api/v1/admin` unless noted. `GET /health` is at the process root and is not behind the LAN guard or `requireSession`.

| Area | Methods and paths |
| :--- | :--- |
| Health | `GET /health` (process root) |
| Auth | `POST /auth/login`, `GET /auth/me`, `POST /auth/mfa` |
| Search | `POST /search` |
| Academy | `GET /academy/progress`, `PUT /academy/progress`, `GET /academy/progress/overview`, `GET /academy/progress/overview/export`, `GET /academy/progress/overview/summary`, `GET /academy/progress/overview/summary/export` |
| Users | `GET /users`, `GET /users/export`, `GET /users/summary`, `GET /users/summary/export`, `GET /users/:id`, `POST /users`, `PATCH /users` (bulk), `PATCH /users/:id` |
| Join requests | `GET /join-requests`, `GET /join-requests/export`, `GET /join-requests/summary`, `GET /join-requests/summary/export`, `GET /join-requests/:id`, `POST /join-requests/admin-assisted`, `PATCH /join-requests/:id/profile`, `POST /join-requests/:id/beneficial-owners`, `PATCH /join-requests/:id/beneficial-owners/:ownerId`, `DELETE /join-requests/:id/beneficial-owners/:ownerId`, `POST /join-requests/:id/kyb-documents` (multipart), `DELETE /join-requests/:id/kyb-documents/:docId`, `POST /join-requests/:id/submit`, `POST /join-requests/:id/withdraw`, `PATCH /join-requests/:id/checklist`, `POST /join-requests/:id/screening/retry`, `POST /join-requests/:id/assign`, `POST /join-requests/:id/request-info`, `POST /join-requests/:id/decide` |
| KYB documents | `GET /kyb-documents`, `GET /kyb-documents/export`, `GET /kyb-documents/summary`, `GET /kyb-documents/summary/export`, `GET /kyb-documents/:id`, `GET /kyb-documents/:id/content`, `POST /kyb-documents/:id/review`, `POST /kyb-documents/:id/request-replacement`, `POST /kyb-documents/:id/request-revalidation` |
| Merchants | `GET /merchants`, `GET /merchants/export`, `GET /merchants/summary`, `GET /merchants/summary/export`, `GET /merchants/:id`, `GET /merchants/:id/summary/export`, `GET /merchants/:id/stats`, `GET /merchants/:id/transactions`, `GET /merchants/:id/applications`, `GET /merchants/:id/wallets`, `GET /merchants/:id/cashouts`, `GET /merchants/:id/disputes`, `GET /merchants/:id/adjustments`, `GET /merchants/:id/notifications`, `GET /merchants/:id/audit-events`, `PATCH /merchants/:id/descriptive`, `POST /merchants/:id/suspend`, `POST /merchants/:id/reinstate`, `POST /merchants/:id/close`, `GET /merchants/:id/pending-changes`, `POST /merchants/:id/pending-changes/:approvalId/withdraw`, `POST /merchants/:id/propose-edit`, `GET /merchants/:id/detail-changes` |
| Approvals | `GET /approvals`, `GET /approvals/export`, `GET /approvals/summary`, `GET /approvals/summary/export`, `GET /approvals/:id`, `POST /approvals/bulk-reject`, `POST /approvals/:id/approve`, `POST /approvals/:id/reject` |
| AML (confidential) | `GET /aml/screenings`, `GET /aml/screenings/export`, `GET /aml/screenings/summary`, `GET /aml/screenings/summary/export`, `GET /aml/screenings/:id`, `POST /aml/matches/:id/disposition`, `GET /aml/cases`, `GET /aml/cases/export`, `GET /aml/cases/summary`, `GET /aml/cases/summary/export`, `GET /aml/cases/:id`, `POST /aml/cases/:id/propose`, `GET /aml/rules`, `GET /aml/rules/export`, `GET /aml/rules/summary`, `GET /aml/rules/summary/export`, `GET /aml/rules/:id`, `POST /aml/rules`, `GET /aml/reporting-rules`, `POST /aml/reporting-rules`, `GET /aml/reports`, `GET /aml/reports/export`, `GET /aml/reports/summary`, `GET /aml/reports/summary/export`, `GET /aml/reports/:id`, `POST /aml/reports`, `POST /aml/reports/:id/submit`, `POST /aml/reports/:id/acknowledge` |
| Gateways | `GET /gateways/ai-transcript`, `POST /gateways/spec-verify`, `POST /gateways/spec-import`, `GET /gateways`, `GET /gateways/export`, `GET /gateways/summary`, `GET /gateways/summary/export`, `POST /gateways`, `GET /gateways/:id`, `PATCH /gateways/:id`, `POST /gateways/:id/rollback`, `GET /gateways/:id/versions`, `POST /gateways/:id/versions` |
| Gateway versions | `POST /gateway-versions/:vid/clone`, `GET /gateway-versions/:vid`, `PUT /gateway-versions/:vid/environments`, `PUT /gateway-versions/:vid/auth`, `PUT /gateway-versions/:vid/settings`, `PUT /gateway-versions/:vid/crypto-profiles`, `PUT /gateway-versions/:vid/flows`, `PUT /gateway-versions/:vid/channels`, `PUT /gateway-versions/:vid/status-rules`, `PUT /gateway-versions/:vid/error-maps`, `POST /gateway-versions/:vid/dry-run`, `POST /gateway-versions/:vid/run-suite`, `POST /gateway-versions/:vid/submit-approval` |
| Credential sets | `GET /credential-sets`, `GET /credential-sets/:id`, `POST /credential-sets`, `PUT /credential-sets/:id`, `POST /credential-sets/:id/verify`, `POST /credential-sets/:id/revoke` |
| Rails | `GET /rails`, `GET /rails/export`, `GET /rails/summary`, `GET /rails/summary/export`, `GET /rails/:id`, `POST /rails`, `PATCH /rails/:id`, `PUT /rails/:id/fields` |
| Routes | `GET /routes`, `GET /routes/export`, `GET /routes/summary`, `GET /routes/summary/export`, `GET /routes/:id`, `POST /routes`, `PATCH /routes/:id`, `POST /routes/:id/state` |
| Assets | `GET /assets`, `GET /assets/:id`, `POST /assets` |
| Operations | `GET /gateway-inquiries`, `GET /gateway-inquiries/summary`, `GET /gateway-inquiries/:id`, `POST /gateway-inquiries/:id/cancel`, `POST /gateway-inquiries/:id/run-now`, `POST /gateway-inquiries/:id/retry`, `GET /operator-cases`, `GET /operator-cases/export`, `GET /operator-cases/summary`, `GET /operator-cases/summary/export`, `GET /operator-cases/:id`, `PATCH /operator-cases/:id`, `POST /operator-cases/:id/resolve`, `POST /operator-cases/bulk-inquire`, `POST /operator-cases/bulk-assign`, `POST /operator-cases/bulk-state`, `GET /attempts/:id`, `POST /attempts/:id/inquire` |
| Reconciliation | `GET /reconciliation/sources`, `POST /reconciliation/sources`, `PATCH /reconciliation/sources/:id`, `POST /reconciliation/upload` (multipart), `GET /reconciliation/runs`, `GET /reconciliation/runs/summary`, `GET /reconciliation/runs/summary/export`, `GET /reconciliation/runs/:id`, `GET /reconciliation/runs/:id/export` |
| Finance | `GET /disputes`, `GET /disputes/export`, `GET /disputes/summary`, `GET /disputes/summary/export`, `GET /disputes/:id`, `POST /disputes`, `POST /disputes/:id/evidence`, `GET /adjustments`, `GET /adjustments/export`, `GET /adjustments/summary`, `GET /adjustments/summary/export`, `GET /adjustments/:id`, `POST /adjustments`, `GET /cashouts`, `GET /cashouts/export`, `GET /cashouts/summary`, `GET /cashouts/summary/export`, `GET /cashouts/:id`, `POST /cashouts/:id/process`, `GET /commission-profiles`, `GET /commission-profiles/summary`, `GET /commission-profiles/:id/history`, `POST /commission-profiles`, `POST /commission-profiles/:id/expire`, `GET /velocity-rules`, `GET /velocity-rules/summary`, `GET /velocity-rules/:id/history`, `POST /velocity-rules`, `POST /velocity-rules/:id/deactivate`, `GET /finance/profitability`, `GET /finance/profitability/export`, `GET /finance/liquidity`, `GET /finance/liquidity/export`, `GET /finance/invariant-check`, `GET /finance/invariant-check/export` |
| Settings | `GET /settings`, `PUT /settings`, `POST /settings/restore-preview`, `POST /settings/restore-apply`, `GET /settings/export`, `GET /settings/summary`, `GET /settings/summary/export`, `GET /settings/checkout-support`, `PUT /settings/checkout-support`, `GET /settings/checkout-support/history`, `GET /settings/checkout-support/summary`, `GET /settings/checkout-support/summary/export` |
| Options | `GET /options/:kind` (`merchants`, `rails`, `gateways`, `users`, `applications`, `wallets`, `credential-sets`, `gl-accounts`) |
| Stats | `GET /stats/overview`, `GET /stats/export`, `GET /stats/recent-activity`, `GET /stats/recent-activity/export`, `POST /stats/export-audit` |
| Audit logs | `GET /audit-logs`, `GET /audit-logs/export`, `GET /audit-logs/summary`, `GET /audit-logs/summary/export`, `GET /audit-logs/:id` |
| System backups | `GET /system/backups/overview`, `POST /system/backups/trigger`, `POST /system/backups/drill`, `PUT /system/backups/policy` |

Route notes:

- `/auth/login`, `/auth/me` and `/auth/mfa` are inside the LAN guard but outside `requireSession`.
- `POST /search` has its own 120-request-per-minute limiter keyed by a SHA-256 hash of the bearer token or IP and returns `SEARCH_RATE_LIMITED`.
- AML routes apply the edge `requireAuthorities("COMPLIANCE", "MLRO", "aml:read", "aml:write")` check to the whole AML router.
- Backup routes apply `security:read` or `gateway:read` to the overview and `security:write` to trigger, drill and policy.
- `POST /merchants/:id/suspend|reinstate|close|propose-edit`, approvals, join-request decisions, gateway submit-approval, AML proposals, backup actions, reconciliation and operator actions relay core statuses such as `202 Accepted`.
- `GET /kyb-documents/:id/content` relays the buffered core response body and preserves `Content-Type`, `Content-Disposition` and `Cache-Control`.

## 4. `CORE_BACK_URLS` pool and failover

The shared client is implemented in `lib/coreInternalClient.ts`. Each edge has a near-identical copy that differs only in `CORE_SERVICE_NAME` and `CORE_CHANNEL_PREFIX`; this service uses `admin-back` and `/internal/admin`.

Configuration:

- `CORE_BACK_URL` is required and must be an absolute `https:` URL. It is the first URL and the fallback when `CORE_BACK_URLS` is unset.
- `CORE_BACK_URLS` is an optional comma-separated list of absolute `https:` URLs.
- Empty entries are rejected, URLs are de-duplicated by normalized `URL.toString()`, and the original trimmed strings are used for requests.
- One keep-alive `https.Agent` is created per node with the client certificate, client key and internal CA. TLS 1.3 is fixed; `rejectUnauthorized` is true; `maxSockets` is 64; the agent timeout is `CORE_REQUEST_TIMEOUT_MS`.
- Certificate and key files are read when the pool is created. Replacing files on disk does not affect a running process; restart or rebuild the pool.
- A missing certificate/key/CA file produces `500 MTLS_MATERIAL_UNAVAILABLE`.

Selection and failover:

1. The pool selects the node with the fewest in-flight requests. A round-robin cursor breaks ties.
2. Connection errors, TLS errors and HTTP `502`/`503` mark the node unhealthy and start a 5-second cooldown.
3. After the cooldown, a zero-in-flight unhealthy node is selected as a half-open probe before healthy nodes are considered again.
4. A call never retries against the same node URL.
5. `GET`, `HEAD`, `PUT`, `DELETE` and `OPTIONS` retry by default. `POST` and `PATCH` do not retry unless a caller opts in. `maxAttempts` defaults to 2.
6. Other statuses, including `4xx` and `5xx` other than `502`/`503`, mark the node healthy and are returned to the caller.
7. If all attempts end in `502`/`503`, the last response is returned. If no eligible node remains, the edge returns `503 CORE_UNAVAILABLE`.
8. `x-pg-min-lsn` is propagated when the caller supplies an LSN. The client does not generate one.

Transport mapping:

| Transport condition | Edge error |
| :--- | :--- |
| `ETIMEDOUT`, `ESOCKETTIMEDOUT` | `504 CORE_TIMEOUT` |
| `ECONNREFUSED`, `ECONNRESET`, `EPIPE`, `EHOSTUNREACH` | `502 CORE_UNREACHABLE` |
| `ENOTFOUND`, `EAI_AGAIN` | `502 CORE_DNS_FAILURE` |
| TLS error codes | `502 CORE_TLS_ERROR` |
| Other failures | `502 CORE_CONNECTION_ERROR` |

The edge has no pool metrics, pool status endpoint or circuit-breaker dashboard. Use `x-request-id`, the edge logs and the core health endpoint to correlate failures.

## 5. Authentication, authorities and trust

| Control | `admin-back` behavior | `core-back` behavior |
| :--- | :--- | :--- |
| LAN boundary | Enforces `ADMIN_LAN_CIDRS` on `/api/v1/admin` using trusted forwarded IP headers. | No admin IP allowlist. |
| Bearer presence | `requireSession` requires any `Authorization` header. | Verifies signature, issuer, audience, expiry, user existence and `ACTIVE` status. |
| Authorities | Advisory only. AML and backup routes decode JWT claims without verifying the signature or expiry and fail closed if the claim is missing. All other protected routes rely on core. | Most business routes call `requireAuthorities` against database-backed authorities. Some routes require only a valid session. |
| MFA | Not checked. | Login/MFA issue a `mfa` claim, but `resolveSessionPrincipal` does not enforce MFA on later calls. MFA is a login gate, not a per-call assertion. |
| Session revocation | Not checked. | Stateless 12-hour JWTs; no per-session revocation table. Disabling the user blocks the next request. |
| Maker-checker | Never decided at the edge. | Database constraint/trigger, middleware and execution checks enforce maker != checker. |
| API tokens | Not applicable to the admin portal. | Admin session authentication is not `pg_live_` API-token authentication. |

Important consequences:

- Edge authority claims are forgeable. A crafted token with an acceptable `typ`, `iss` and `aud` can pass the edge AML or backup hint, but core still rejects the token. Never treat the edge decision as authentication.
- `ADMIN_AUTHORITY_HINTS` filters which requested authority strings the edge checks. If the configured list is empty, the edge skips the check. If all requested authorities are filtered out, the route passes without an edge hint check.
- `COMPLIANCE` and `MLRO` are treated as aliases for `aml:read`/`aml:write` at the edge.
- `GET /auth/me` is not behind `requireSession`; core's admin `/auth/me` returns static platform/version information and is registered before core's authentication middleware.
- Core's `pg_live_` IP allowlist does not apply to the admin portal. Admin IP enforcement is an edge control only; a direct mTLS call that bypasses `admin-back` is not IP-restricted by core.

## 6. Environment

| Key | Required | Default | Purpose |
| :--- | :--- | :--- | :--- |
| `NODE_ENV` | no | `development` | Runtime mode (`development`, `test`, `production`). |
| `PORT` | no | `4101` | Backend listener port. |
| `ADMIN_BIND_HOST` | no | `127.0.0.1` | Backend bind address. Deployment keeps this at loopback. |
| `CORE_BACK_URL` | yes | none | First core node; absolute `https:` URL. |
| `CORE_BACK_URLS` | no | none | Comma-separated core pool; absolute `https:` URLs. |
| `MTLS_CLIENT_CERT_PATH` | yes | none | Client certificate for core. |
| `MTLS_CLIENT_KEY_PATH` | yes | none | Client private key. |
| `MTLS_CA_CERT_PATH` | yes | none | Internal CA certificate. |
| `CORE_REQUEST_TIMEOUT_MS` | no | `60000` | Per-request and agent timeout. |
| `TRUSTED_PROXY_CIDRS` | no | loopback only (`127.0.0.0/8,::1/128`) | Peers whose forwarded IP headers are trusted. |
| `ADMIN_LAN_CIDRS` | no | loopback plus RFC1918 ranges | Allowed admin client networks. |
| `ADMIN_AUTHORITY_HINTS` | no | `GATEWAY_ADMIN,SECURITY_ADMIN,FINANCE,OPERATOR,COMPLIANCE,MLRO,SUPPORT,aml:read,aml:write,security:read,security:write` | Authority vocabulary the edge may check. |
| `MAX_JSON_BODY_BYTES` | no | `4194304` | JSON and URL-encoded body limit. |
| `MAX_UPLOAD_BYTES` | no | `20971520` | Multipart upload limit. |
| `UPLOAD_ALLOWED_MIME` | no | `text/csv,application/vnd.ms-excel,application/json` | Reconciliation upload MIME list. |
| `ADMIN_RATE_LIMIT_MAX` | no | `600` | Protected-router requests per 60 seconds. |
| `ADMIN_RATE_LIMIT_WINDOW_MS` | no | `60000` | Defined but not read by the current limiter; the window is fixed at 60 seconds. |
| `AUTH_RATE_LIMIT_MAX` | no | `10` | Login/MFA attempts per fixed 15-minute window. |
| `AUTH_RATE_LIMIT_WINDOW_MS` | no | `900000` | Defined but not read by the auth limiter; the window is fixed at 15 minutes. |
| `RECONCILIATION_TIMEOUT_MS` | no | `120000` | Reconciliation upload forwarding timeout. |

The service never reads `DATABASE_URL`, `KMS_MASTER_KEY` or another service's certificate. Deploy writes `PORT`, `ADMIN_BIND_HOST=127.0.0.1`, `ADMIN_LAN_CIDRS`, the core URL list and the edge mTLS paths into the generated `.env`.

## 7. Commands

```bash
cd admin-back
bun install
bun run start      # bun run index.ts
bun run dev        # bun --watch index.ts
bun test
bun run typecheck  # bunx tsc --noEmit
```

Open the portal through the LAN vhost, not directly against the backend port.

## 8. Testing and troubleshooting

```bash
cd admin-back && bun run typecheck && bun test
```

Key suites:

- `test/admin-surface.test.ts`: route surface and forwarding behavior.
- `test/core-contract.test.ts`: public-to-core mappers and strict core schemas.
- `test/core-internal-client.test.ts`: pool, retry, headers and LSN behavior.
- `test/mtls-client.test.ts`: channel confinement and transport error mapping.
- `test/backups.test.ts`: backup proxy schema and authority behavior.
- `test/academy-progress.test.ts`: academy route forwarding.
- `test/env-isolation.test.ts`: no database/KMS secrets in the edge environment.

These suites use local stubs and do not require PostgreSQL or Redis. A live mTLS check requires the deployed core and certificates.

Common failures:

| Symptom | Likely cause / check |
| :--- | :--- |
| `403 ADMIN_LAN_ONLY` | Client IP is outside `ADMIN_LAN_CIDRS`, or the reverse proxy did not overwrite `X-Real-IP` as expected. Check `ADMIN_LAN_CIDRS`, `TRUSTED_PROXY_CIDRS` and the proxy headers. |
| `401 AUTH_REQUIRED` | No Authorization header reached the edge. |
| `403 EDGE_AUTHORITY_DENIED` | The token payload did not expose a configured AML/backup role or authority. The check fails closed; core may still accept the token. |
| `502 CORE_TLS_ERROR` | Certificate/CA mismatch, expired certificate, or wrong client certificate. Restart the edge after rotating files. |
| `502 CORE_UNREACHABLE` / `504 CORE_TIMEOUT` | Core node is down, unreachable, or slower than `CORE_REQUEST_TIMEOUT_MS`. |
| `503 CORE_UNAVAILABLE` | No eligible core node remains or `CORE_BACK_URLS` is empty. |
| `429 RATE_LIMITED` | Protected-router or login/MFA limit exceeded. |
| `413 UPLOAD_TOO_LARGE` | Upload exceeds `MAX_UPLOAD_BYTES`. |
| `415 UNSUPPORTED_UPLOAD_TYPE` / `UPLOAD_SIGNATURE_MISMATCH` | Reconciliation upload MIME or magic bytes do not match the allowed list. |
| `404 NOT_FOUND` | The route is not part of the edge surface; check the table above. |

## 9. Security notes

- No database, KMS or migration material is present at the edge. Environment-isolation tests assert this boundary.
- The client certificate CN must be exactly `admin-back`; core's mTLS guard rejects a valid certificate on the wrong namespace with `403 FORBIDDEN_SERVICE_IDENTITY`.
- TLS 1.3 is fixed in both directions; core verifies the internal CA and the edge verifies the core server certificate.
- CORS is off unless `CORS_ALLOWED_ORIGINS` is set (cross-origin dev frontends need it). The LAN guard and reverse proxy are the compensating controls. Do not expose the admin vhost outside the LAN.
- The admin LAN check uses `x-real-ip` first and `x-real-client-ip` only as a fallback, and only from trusted proxy peers. `app.set("trust proxy", false)` means Express `req.ip` is the socket peer; the guard implements its own trust logic.
- Raw body handling: reconciliation uploads are validated for declared MIME, magic bytes and size before raw forwarding. Join-request KYB uploads are forwarded with the client-declared MIME and SHA-256 but do not use the shared MIME/magic-byte validator; core must treat those files as untrusted.
- Upload limits: JSON bodies 4 MiB, multipart 20 MiB, reconciliation forwarding timeout 120 seconds. Core's raw-body limit is higher than the edge limit.
- Logs redact sensitive keys and truncate long strings, but bearer tokens, signatures and document contents must still never be logged by application code.
- Credential values are write-only in core. The edge does not persist or return secrets.
- All authority, maker-checker, ledger, audit and money decisions happen in core. Edge checks are advisory.

## 10. References

- [`blueprint.md`](./blueprint.md) (generated from the canonical parts)
- [`project-design/parts/02-edge-services/01-admin-back.md`](../project-design/parts/02-edge-services/01-admin-back.md)
- [`project-design/parts/02-edge-services/00-shared-core-upstream-client.md`](../project-design/parts/02-edge-services/00-shared-core-upstream-client.md)
- [`project-design/parts/00-platform/02-security-and-mtls.md`](../project-design/parts/00-platform/02-security-and-mtls.md)
- [`project-design/appendices/api-route-matrix.md`](../project-design/appendices/api-route-matrix.md)
- [`project-design/appendices/env-and-config-matrix.md`](../project-design/appendices/env-and-config-matrix.md)

## Security hardening (2026-11-05)

`authorityGuard` rejects `alg: none`/non-HS256 tokens and requires `typ`, `iss`, `aud` and `exp`; authority lists are deny-by-default per route group (`ADMIN_AUTHORITY_HINTS` can only restrict). `requireSession` returns `401 AUTH_INVALID` for non-session tokens. Backup trigger/drill require an `Idempotency-Key` header (8-128 URL-safe chars) and are limited by `BACKUP_JOB_RATE_LIMIT_MAX`; policy cron, minimum gaps and retention floors are validated; KYB uploads are restricted to png/jpeg/pdf and served as attachments with a CSP sandbox. Admin logout is still client-only (no revoke endpoint).

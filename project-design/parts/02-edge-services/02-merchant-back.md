---
id: edge.merchant
title: Merchant Edge BFF
status: partial
confidence: high
last_verified: 2026-11-03
verified_against: 5a24f6f+working-tree
code:
  - core-back/lib/realtimeBus.ts
  - merchant-back/index.ts
  - merchant-back/api/**
  - merchant-back/lib/env/index.ts
  - merchant-back/lib/coreInternalClient.ts
  - merchant-back/lib/net/index.ts
  - merchant-back/lib/error/index.ts
  - merchant-back/lib/requestLogger/index.ts
design_sources:
  - design/01-platform-architecture/payment_gateway_final_design-v5.md#21-service-roles-boundaries-and-security-constraints
  - design/01-platform-architecture/payment_gateway_final_design-v5.md#162-merchant-back-public-api-apiv1merchant--apiv1external---forwards-to-core-back-internalmerchant
  - design/03-deployment/payment_gateway_deployment_and_guides_architecture.md#5-host-aware-ufw-firewall--network-isolation-provisioning
tests:
  - core-back/test/storage-engine/telemetry-and-realtime.test.ts
  - merchant-back/test/core-forwarding.test.ts
  - merchant-back/test/core-contract.test.ts
  - merchant-back/test/core-internal-client.test.ts
  - merchant-back/test/mtls-client.test.ts
  - merchant-back/test/merchant-kyb-and-external.test.ts
  - merchant-back/test/env-isolation.test.ts
gaps:
  - The portal protected router checks only that an Authorization header exists; core-back verifies the signature, expiry, user status and authorities, but per-call MFA state and session revocation are not enforced.
  - The external merchant API checks only the pg_live_ prefix at the edge; the access-token hash, revocation and IP allowlist are enforced by core-back.
  - POST /merchant/auth/google always returns 501 because core has no configured OIDC provider.
  - The options router is implemented but not mounted anywhere.
  - The POS SSE stream has a fixed configured timeout and no resume, replay or polling fallback at the edge.
---

# Merchant Edge BFF

## 1. Purpose and scope

`merchant-back` is the public merchant edge. One Bun/Express process serves two audiences:

- the authenticated merchant portal under `/api/v1/merchant/*`;
- the merchant server API under `/api/v1/external/*`, authenticated by a `pg_live_` bearer token and a core-side IP allowlist.

It owns request validation, edge translation to the canonical core contract, upload verification, rate limiting, the public merchant API shape and mTLS forwarding to `/internal/merchant/*`. It owns no database connection, no Prisma client, no `DATABASE_URL`, no `KMS_MASTER_KEY` and no authority decisions.

The merchant vhost serves the SPA through Nginx. The backend itself binds to loopback in deployment.

## 2. Design intent (extracted and synthesized from ./design)

The design splits the merchant experience into a portal API and a server-to-server API. The portal covers registration, identity verification, login/MFA, KYB onboarding, wallets, applications, links, POS terminals and cashier screens, payments, disputes, cash-outs, API tokens, credential sets, team users and overview statistics. The external API covers link creation/inspection/cancellation and payment lookup using a long-lived merchant token.

All operations are forwarded over mTLS 1.3 with `CN=merchant-back`. The edge validates multipart KYB documents for MIME type, magic bytes and size before forwarding raw bytes to core. The portal may accept amounts and currencies when the merchant owns link creation; the edge never performs money arithmetic and core re-validates every monetary field. The external API is meant to enforce a `pg_live_` bearer token and an IP allowlist, with core as the authority.

## 3. As-built architecture

### 3.1 Process, listener and middleware

`merchant-back/index.ts`:

- disables `x-powered-by`;
- sets `trust proxy` to false;
- enables CORS with any origin and no credentials;
- installs request logging;
- serves unauthenticated `GET /health`;
- parses JSON and URL-encoded bodies with `MAX_JSON_BODY_BYTES`;
- mounts `/api/v1`;
- adds the shared 404 and error handlers.

The listener binds to `BIND_HOST` (default `0.0.0.0` in the service schema). The deploy engine overrides this to `127.0.0.1`; direct exposure of port 4102 is a configuration error.

Middleware layers:

| Layer | Behavior |
| :--- | :--- |
| `authLimiter` | Fixed 15-minute window, `AUTH_RATE_LIMIT_MAX` (default 20), on `/api/v1/merchant/auth`. |
| `onboardingLimiter` | 60-second window, `API_RATE_LIMIT_MAX` (default 300), on `/api/v1/merchant/onboarding`. |
| `apiLimiter` | 60-second window, `API_RATE_LIMIT_MAX` (default 300), on the protected merchant router. |
| `externalLimiter` | 60-second window, `EXTERNAL_RATE_LIMIT_MAX` (default 120), on `/api/v1/external`. |
| `requirePgLiveToken` | Requires `Authorization: Bearer pg_live_...` by prefix only. Applied to the whole external router. |
| `coreForward` `requireAuth` | Rejects a missing `Authorization` header for protected portal routes. Defaults to required; auth/onboarding routes opt out with `requireAuth: false`. |
| `requireBearer` | Helper used by dispute evidence and merchant user routes to require a header before multipart work. |
| `requireAuthHeader` | Exported from `api/public/auth.ts` but a no-op; it is not a security control. |

There is no edge session parser, role guard or token verifier in `merchant-back`. An arbitrary non-empty bearer token reaches core for every protected portal route.

### 3.2 Forwarding behavior

`merchant-back/api/forward.ts` implements a stricter forwarder than admin's:

1. Requires `Authorization` unless `requireAuth === false`.
2. Validates route params and query with Zod.
3. Validates the public body with `schema`.
4. Applies `bodyMapper()` to translate product vocabulary into the core body.
5. Applies `bodyFrom()` when the route replaces the body entirely.
6. Re-validates the translated body with `coreSchema` when configured, so a request that core would reject is stopped at the edge.
7. Calls `callCoreResponse()` with request id, resolved client IP, user agent and the bearer token.
8. Returns the core body with the declared status, or the core status when `relayStatus: true`.

The external router also has its own PG-live prefix check. It does not hash or validate the token; core does the authoritative token lookup and IP check.

### 3.3 Uploads

`merchant-back/api/upload.ts` uses Multer memory storage with `MAX_UPLOAD_BYTES`, one file and at most 32 fields. `forwardUpload()` and the dispute route call `assertAllowedUpload()`:

- checks the declared MIME type against `UPLOAD_ALLOWED_MIME`;
- checks magic bytes for PNG (`89 50 4E 47 0D 0A 1A 0A`), JPEG (`FF D8 FF`) and PDF (`25 50 44 46 2D`);
- enforces the size cap;
- computes SHA-256;
- forwards raw bytes with `x-upload-filename`, `x-upload-content-type`, `x-upload-sha256`, `x-upload-size` and base64url `x-upload-metadata`.

Dispute evidence is converted into a canonical JSON body (`toCoreDisputeEvidence`) rather than raw bytes. The max evidence size is defined in `merchant-back/api/contract.ts`.

### 3.4 Route map

Portal auth is mounted under `/api/v1/merchant/auth`:

| Method | Path |
| :--- | :--- |
| POST | `/register`, `/verify-identity`, `/accept-invitation`, `/login`, `/google`, `/mfa/verify` |
| GET | `/me` |

Onboarding is mounted under `/api/v1/merchant/onboarding`:

| Method | Path |
| :--- | :--- |
| GET, PUT | `/join-request` |
| GET | `/kyb-revalidations`, `/beneficial-owners` |
| POST | `/kyb-documents` (multipart), `/beneficial-owners`, `/submit` |
| DELETE | `/beneficial-owners/:id` |

The protected portal API is mounted under `/api/v1/merchant`:

| Area | Routes |
| :--- | :--- |
| Wallets | `GET, POST /wallets`, `GET /wallets/:id`, `GET /wallets/:id/balance`, `GET /wallets/:id/statements`, `GET /wallets/:id/statements/:month/export` |
| Applications | `GET, POST /applications`, `GET, PATCH /applications/:id` |
| Links | `GET, POST /links`, `GET /links/:id`, `POST /links/:id/cancel`, `GET /links/:id/attempts` |
| POS | `GET, POST /pos/terminals`, `GET, PATCH /pos/terminals/:id`, `POST /pos/terminals/:id/screens`, `GET /pos/screens/:screenCode/stream` (SSE) |
| Payments | `GET /payments` |
| Disputes | `GET /disputes`, `GET /disputes/:id`, `POST /disputes/:id/evidence` (multipart) |
| Cash-outs | `GET, POST /cashouts` |
| Tokens | `GET, POST /tokens`, `PUT /tokens/:id/ips`, `DELETE /tokens/:id` |
| Credential sets | `GET, POST /credential-sets`, `GET, PUT /credential-sets/:id` |
| Team | `GET, POST, PATCH /users`, `PATCH /users/:id` |
| Stats | `GET /stats/overview` |

`merchant-back/api/protected/options.ts` exports `optionsRouter` for `GET /options/:kind`, but the router is not imported by `api/protected/index.ts` and has no live mount.

The external merchant server API is mounted under `/api/v1/external`:

| Method | Path |
| :--- | :--- |
| POST | `/links`, `/links/:key/cancel` |
| GET | `/links/:key`, `/payments/:reference` |

### 3.5 Authentication behavior and the Google gap

Portal auth routes are public at the edge (`requireAuth: false`) and forward to `/internal/merchant/auth/*`:

- `POST /register` validates phone/email, password, name and optional identity fields, then creates a registration.
- `POST /verify-identity` validates an identity type, number, phone and OTP code.
- `POST /accept-invitation` validates an invitation token and password.
- `POST /login` validates an identifier and password.
- `POST /google` validates a Google `idToken` shape and forwards it, but `core-back` answers `501 NOT_IMPLEMENTED` with `Google sign-in requires a configured OIDC provider` (`core-back/api/internal/merchant.ts:853`). The capability is not implemented at the core.
- `GET /me` and `POST /mfa/verify` forward the supplied bearer/challenge state to core.

The merchant portal session is a core-issued token. The edge never verifies its signature, expiry, revocation, MFA state or merchant status. Core verifies the signature, expiry, user status and authorities; it does not re-check MFA or a session revocation list on every call.

## 4. Contracts and invariants

- All portal business routes require an `Authorization` header at the edge; its validity is decided by core.
- The external API requires a `pg_live_` prefix at the edge; access-token validity, revocation and source-IP allowlist are decided by core.
- Every forwarded path stays under `/internal/merchant`; the shared client enforces this and core re-checks `CN=merchant-back`.
- The edge never accepts arbitrary core paths.
- Link creation accepts decimal-string amounts and ISO 4217 currencies; the edge does not do arithmetic and core re-validates amount, currency and fee model.
- Checkout money semantics do not apply here: merchant link creation is an owning operation.
- Uploaded KYB and dispute files are validated for MIME, magic bytes and size before the core call.
- Team/user and credential-set operations are forwarded with the caller's bearer token; the core enforces merchant roles and maker-checker where applicable.
- The POS SSE route requires a bearer header, then proxies the core stream.

## 5. Data / API / config / deployment surface

### Environment

| Key | Default | Meaning |
| :--- | :--- | :--- |
| `NODE_ENV` | `development` | Runtime mode. |
| `PORT` | `4102` | Backend listener port. |
| `BIND_HOST` | `0.0.0.0` | Bind address; deploy overrides to `127.0.0.1`. |
| `CORE_BACK_URL` | required | First core node, absolute HTTPS. |
| `CORE_BACK_URLS` | optional | Core pool. |
| `MTLS_CLIENT_CERT_PATH`, `MTLS_CLIENT_KEY_PATH`, `MTLS_CA_CERT_PATH` | required | Edge mTLS material. |
| `CORE_REQUEST_TIMEOUT_MS` | `30000` | Core request timeout. |
| `TRUSTED_PROXY_CIDRS` | loopback plus RFC1918 ranges | Trusted forwarded-IP peers. |
| `MAX_JSON_BODY_BYTES` | `2097152` | JSON limit. |
| `MAX_UPLOAD_BYTES` | `10485760` | Multipart limit. |
| `UPLOAD_ALLOWED_MIME` | `image/png,image/jpeg,application/pdf` | Allowed upload MIME types. |
| `PG_LIVE_TOKEN_PREFIX` | `pg_live_` | External API bearer prefix. |
| `AUTH_RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_WINDOW_MS` | `20`, `900000` | Auth limiter maximum and configured window (window is not used; 15 minutes is fixed). |
| `API_RATE_LIMIT_MAX`, `API_RATE_LIMIT_WINDOW_MS` | `300`, `60000` | Portal/onboarding limiter. |
| `EXTERNAL_RATE_LIMIT_MAX`, `EXTERNAL_RATE_LIMIT_WINDOW_MS` | `120`, `60000` | External API limiter. |
| `POS_STREAM_TIMEOUT_MS` | `900000` | POS SSE proxy timeout. |

### Deployment surface

`deploy/lib/hostPlanner.ts` writes `BIND_HOST=127.0.0.1`, `PG_LIVE_TOKEN_PREFIX=pg_live_`, the core URL list and mTLS paths. The public merchant vhost proxies `/api/` to `127.0.0.1:4102` with `client_max_body_size` sized for KYB uploads and buffering disabled for the POS stream. The edge `.env` has no database or KMS secret.

## 6. Operational usage

```bash
cd merchant-back
bun install
bun run start
bun run dev
bun test
bun run typecheck
```

- Public reachability is through `https://merchant.<domain>/api`; the backend port must stay loopback-only.
- For POS issues, verify the Nginx stream route disables buffering and the proxy read timeout exceeds the cashier idle window.
- For upload failures, check `UPLOAD_ALLOWED_MIME`, magic bytes, `MAX_UPLOAD_BYTES` and the core-side upload limits.
- For external API `401 INVALID_API_TOKEN`, the edge did not see a `pg_live_` bearer; for a core rejection, inspect the core token/IP state.
- Google login currently returns 501 by design of the core; use password or invitation flows.

## 7. Status and deviations

### Implemented

- Two-audience routing with separate rate limits and external token prefix gate.
- Full portal and external route surface, including multipart KYB and evidence uploads.
- Public-to-core schema validation and canonical body mapping.
- MIME/magic-byte/size validation and hashed raw upload forwarding.
- mTLS pool, retries, LSN header propagation and channel confinement.
- POS SSE proxy with buffering disabled.

### Partial

- Portal authentication is only a presence check at the edge; all session and authority enforcement is in core.
- External token validation is prefix-only at the edge.
- Google sign-in is exposed but not implemented by core.

### Missing / deferred

- Google OIDC provider integration in core.
- Edge session revocation/MFA cache.
- Route-level merchant role guards at the edge.
- A live `GET /options/:kind` mount for the merchant portal.
- SSE resume/replay or polling fallback at the edge.

### Known bugs / risks

- `requireAuthHeader` is a no-op and should not be mistaken for a guard.
- The auth limiter uses a hard-coded 15-minute window; `AUTH_RATE_LIMIT_WINDOW_MS` has no effect.
- `x-real-client-ip` is preferred over `x-real-ip` in `merchant-back/lib/net/index.ts`. When the backend is loopback-bound this is safe; if it is ever exposed and a direct peer is inside `TRUSTED_PROXY_CIDRS`, the peer can spoof its client IP.
- The options router is dead code; a frontend calling `/api/v1/merchant/options/:kind` receives a 404.
- The external prefix check is not a credential check; do not log or expose token values.

## 8. Verification and tests

```bash
cd merchant-back && bun run typecheck && bun test
```

Key suites:

- `merchant-back/test/core-forwarding.test.ts`: forwarding, status relay and body handling.
- `merchant-back/test/core-contract.test.ts`: public-to-core mappers and canonical schemas.
- `merchant-back/test/core-internal-client.test.ts`: pool and consistency behavior.
- `merchant-back/test/mtls-client.test.ts`: channel confinement and error mapping.
- `merchant-back/test/merchant-kyb-and-external.test.ts`: upload validation and external API behavior.
- `merchant-back/test/env-isolation.test.ts`: no database/KMS material at the edge.

These suites do not require PostgreSQL or Redis. The Google route is expected to forward and surface core's 501; a successful Google login has no implementation to test.

## 9. Source references

### Old design sections

- `design/01-platform-architecture/payment_gateway_final_design-v5.md` section 2.1, service boundaries.
- `design/01-platform-architecture/payment_gateway_final_design-v5.md` section 16.2, merchant API surface.
- `design/03-deployment/payment_gateway_deployment_and_guides_architecture.md` section 5, firewall policy.

### Code paths

- `merchant-back/index.ts`: app composition.
- `merchant-back/api/index.ts`: auth, onboarding, protected and external mounts.
- `merchant-back/api/forward.ts`: forwarding contract and stream proxy.
- `merchant-back/api/upload.ts`: multipart validation and forwarding.
- `merchant-back/api/protected/**`: portal routes.
- `merchant-back/api/external/index.ts`: external token gate and routes.
- `merchant-back/lib/coreInternalClient.ts`: shared mTLS pool.
- `merchant-back/lib/env/index.ts`: environment contract.
- `core-back/api/internal/merchant.ts:853`: Google 501.

### Generated appendices

- `project-design/appendices/api-route-matrix.md`
- `project-design/appendices/env-and-config-matrix.md`

## 10. Change history

- 2026-11-03: initial canonical part at `5a24f6f+working-tree`.

## 11. Cross-node POS updates (2026-11-03)

The core POS SSE stream now subscribes to the Redis-backed `realtime:attempt` and `realtime:pos` topics. A cashier request processed by a merchant-back/core pair on one host reaches a paired screen whose stream is held by a merchant-back node on the other host. The existing 3-second database poll remains as a fallback.

---
id: fake-rails.backend
title: Fake Rails Backend Architecture
status: partial
confidence: high
last_verified: 2026-11-05
verified_against: 5a24f6f+working-tree
code:
  - fake-rails-back/index.ts
  - fake-rails-back/api/**
  - fake-rails-back/engine/**
  - fake-rails-back/lib/**
design_sources:
  - design/04-fake-rails-and-seeder/fake_payment_rails_service_architecture.md#1-service-topology-isolation-boundary-workspace-layout
  - design/04-fake-rails-and-seeder/fake_payment_rails_service_architecture.md#2-deployment-engine-integration-production-guardrails
  - design/04-fake-rails-and-seeder/fake_payment_rails_service_architecture.md#3-single-user-authentication-architecture
tests:
  - fake-rails-back/test/security.test.ts
  - fake-rails-back/test/api.test.ts
  - fake-rails-back/test/crypto.test.ts
  - fake-rails-back/test/exhaustive/05-api-matrix/fake-rails-portal-and-chaos-api.test.ts
  - fake-rails-back/test/security.test.ts
gaps:
  - Inbound rail requests are not authenticated or signature-verified.
  - Default outbound webhook URL includes an extra /webhook path segment.
  - The service has no direct TLS listener; deployment relies on Nginx.
  - Portal rate limiting is in-process and resets on restart.
  - Stored step events contain raw headers and bodies without redaction.
  - "Residual (GAP-019): the tester portal session token is still kept in browser localStorage by `fake-rails-front`."
---

# Fake Rails Backend Architecture

## 1. Purpose and scope

`fake-rails-back` is a standalone, out-of-process payment-rails emulator. It exposes twenty gateway-shaped HTTP APIs, SDK scripts, a single-user tester portal API, a chaos engine, an outbound webhook queue and a settlement-statement generator. It is used by the synthetic seeder, the exhaustive rail suites and local/staging end-to-end journeys.

This part owns the process, configuration, isolated storage, HTTP composition and portal authentication of that service. It does not own the protocol matrix (see `fake-rails.protocol`), the chaos/portal behaviour (see `fake-rails.chaos`), or the `core-back` seeding and deployment wiring (see `fake-rails.integration`).

The service is optional. `FAKE_RAILS_ENABLED` defaults to `false` in `core-back` and in `deploy/deploy.env.example`.

## 2. Design intent (extracted and synthesized from ./design)

The historical design requires a tier that is indistinguishable from real external switches from `core-back`'s point of view while remaining completely isolated from the gateway database:

1. **100 percent out-of-process isolation.** `fake-rails-back` has no PostgreSQL client, no `DATABASE_URL`, no `KMS_MASTER_KEY` and no shared memory with `core-back`. It persists its own transactions, step events, webhook deliveries, statements and portal audit rows in an embedded SQLite WAL database.
2. **All collection modes and phases.** The design promises all nine collection modes (`OTP_PULL`, `REDIRECT`, `EMBEDDED`, `PUSH_APPROVAL`, `QR_DISPLAY`, `PAY_CODE`, `DEEP_LINK`, `MANUAL`, `HYBRID`) and all ten declarative phases (`CREDENTIAL_CHECK`, `PRE_INITIATE`, `INITIATE`, `SUBMIT`, `VERIFY`, `CANCEL`, `REFUND`, `VOID`, `CAPTURE`, `SETTLEMENT_FETCH`).
3. **Zero-install operation.** Bun, Express 5, Zod 4 and `bun:sqlite`; no external queue, no Redis and no database service.
4. **Single tester identity.** One username/password pair from the environment, a signed JWT and a constant-time login comparison.
5. **Production deployability with hard guards.** The process refuses production mode unless `FAKE_RAILS_ALLOW_IN_PRODUCTION=true`, refuses default or weak tester credentials, and binds narrowly by default.
6. **Raw wire visibility.** Every rail request and response is recorded and exposed to the tester portal, including injected faults, latency and correlation identifiers.
7. **Seeder synchronisation.** The synthetic seeder can handshake and bulk-load historical transactions and events through a shared seeder token.

The design describes Nginx in front of the service. The service itself is plain HTTP; TLS termination, static SPA serving and the public port are deployment concerns.

## 3. As-built architecture

### 3.1 Process entry point

`fake-rails-back/index.ts` exports `createApp()` and `start()`.

- `createApp()` creates Express, disables `x-powered-by`, enables `trust proxy`, installs the request logger and mounts `createApiRouter()`.
- `start()` opens the SQLite store with `getDb()` and seeds default scenarios with `listScenarios()` before listening.
- The webhook dispatcher is wired to the portal SSE hub: `webhookDispatcher.setSink((event) => broadcast(event.type, event))`.
- The server listens on `env.HOST:env.PORT` (default `127.0.0.1:4104`) and logs the environment and production opt-in flag.
- `SIGTERM` and `SIGINT` close the server and exit.

### 3.2 Environment and guardrails

`fake-rails-back/lib/env/index.ts` defines the Zod schema and a lazy proxy so importing the module does not parse the environment. Required values have no defaults: `FAKE_RAILS_ADMIN_USER` (4-128 chars), `FAKE_RAILS_ADMIN_PASSWORD` (12-512), `FAKE_RAILS_JWT_SECRET` (32-512) and `FAKE_RAILS_SEEDER_TOKEN` (32-512).

| Key | Default | Purpose |
| :--- | :--- | :--- |
| `NODE_ENV` | `development` | `development`, `test`, `production` |
| `HOST` / `PORT` | `127.0.0.1` / `4104` | Listener binding |
| `LOG_LEVEL` | `info` | Request logger level contract |
| `FAKE_RAILS_ENABLED` | `true` | Must be true to start |
| `FAKE_RAILS_ALLOW_IN_PRODUCTION` | `false` | Explicit production opt-in |
| `FAKE_RAILS_PUBLIC_BASE_URL` | `http://127.0.0.1:8444` | Hosted and SDK URLs |
| `FAKE_RAILS_DATA_DIR` | `shared/data` | SQLite parent directory |
| `CORE_INBOUND_BASE_URL` | `http://127.0.0.1:4103/api/v1/inbound` | Default webhook destination |
| `FAKE_RAILS_ALLOWED_CIDRS` | loopback plus RFC1918 | Deployment allowlist contract |
| `FAKE_RAILS_WEBHOOK_TIMEOUT_MS` | `10000` | Outbound webhook timeout |
| `FAKE_RAILS_MAX_BODY_BYTES` | `10485760` | Body parser limit |
| `FAKE_RAILS_PORTAL_RATE_LIMIT` | `10` | Failed logins per window |
| `FAKE_RAILS_PORTAL_RATE_WINDOW_MS` | `900000` | Login window |

The parse function exits with code 1 on schema failure and emits named guard errors:

- `FAKE_RAILS_PRODUCTION_GUARD_BLOCKED` when production mode lacks the opt-in.
- `FAKE_RAILS_DISABLED` when `FAKE_RAILS_ENABLED` is false.
- `FAKE_RAILS_WEAK_CREDENTIALS` for a listed default password, or when username and password are identical.

`FAKE_RAILS_DB_PATH` is an undocumented escape hatch read directly from `process.env` in `engine/db/index.ts`; tests use it for throw-away databases.

### 3.3 Isolated SQLite store

`fake-rails-back/engine/db/index.ts` opens a single `bun:sqlite` `Database` singleton, creates the parent directory, applies `PRAGMA journal_mode = WAL`, `synchronous = NORMAL` and `foreign_keys = ON`, then executes `schema.sql`. `closeDb()` clears the singleton. `nowIso()` returns UTC ISO timestamps and `uuidv7()` produces time-ordered RFC 9562 identifiers.

`schema.sql` creates:

- `fake_rail_scenarios` keyed by `rail_code`, storing the chaos configuration JSON.
- `fake_transactions` with unique `provider_reference`, our/provider/network references, wire and normalized amounts as text, collection mode, masked customer, expected OTP, status, pinned failure phase/mode, inquiry override, redirect/webhook URLs and a seeded-history flag.
- `fake_step_events` with raw headers, raw request body, response status/body, injected fault and duration.
- `fake_webhook_deliveries` with URL, headers, body, signature-valid flag, attempt/max attempts, state, schedule and response.
- `fake_statements` with gateway, format, window, anomaly JSON and row count.
- `fake_portal_audit` with actor, action, target and payload.

Indexes cover reference lookup, creation time, rail/status, provider reference, event timeline, webhook state and transaction history. Amounts and prices are stored as decimal strings, never SQLite floating-point columns.

### 3.4 HTTP composition

`fake-rails-back/api/index.ts` mounts:

- JSON (`application/json`, `application/*+json`), URL-encoded, text/XML and raw/multipart body parsers with `captureRawBody` as the verify hook.
- A multipart normaliser that converts the raw buffer into key/value text fields.
- `/rails/:gatewayCode` through `createRailsRouter()`.
- `/sdk` through `createSdkRouter()`.
- `/portal-api` through `createPortalRouter()`.
- `/health` and `/hosted/health`.
- A 404 fallback and a central error envelope (`{ code, message, details? }`). Zod body errors become `400 INVALID_BODY`; unknown errors become `500 SERVER_ERROR` and never leak stack traces.

`lib/rawBody/index.ts` preserves exact bytes for signature recipes and the wire inspector. Its multipart parser is a deliberately small RFC-7578 reader for text parts only.

`lib/error/index.ts` defines `ApiError`, an `apiErrorSymbol`, `toErrorEnvelope()` and `parseOrThrow()`.

`lib/requestLogger/index.ts` attaches a request id, `x-request-id` response header and a buffered logger. Only request-level metadata is printed; bodies and headers are not written to stdout by this middleware.

`lib/zReady/index.ts` contains Libyan phone normalisation and mask helpers. It is used by the rail common layer, not as a full protocol validator.

### 3.5 Portal authentication

`api/portal/auth.ts` implements `POST /portal-api/auth/login` and `GET /portal-api/auth/me`.

- Login validates `{ username, password }` with Zod.
- Username and password are SHA-256 digested and compared with `timingSafeEqual`.
- A per-IP in-memory sliding window records failures; the default is 10 failures in 15 minutes. Successful login clears the window.
- On success it signs an HS256 JWT with `sub`, `role=FAKE_RAILS_TESTER`, `allowInProduction`, `iat` and `exp` (12 hours).
- The response includes the username, production flag and a display environment (`SANDBOX` or `PRODUCTION TEST SERVER`).

`api/middleware/portalAuthGuard.ts` protects `/portal-api/*`:

- `/auth/login` and everything under `/hosted/` are public.
- `/internal/*` requires `x-fake-rails-seeder-token` equal to `FAKE_RAILS_SEEDER_TOKEN`.
- Everything else requires a Bearer token with `role=FAKE_RAILS_TESTER`; the SSE stream alone also accepts a 30-second single-use `?ticket=` (see the gap resolutions below).

`lib/jwt.ts` is a small HS256 implementation using HMAC-SHA256, base64url, expiry checking and `timingSafeEqual`. There is no issuer, audience, revocation or refresh-token mechanism (the secret must now be at least 32 characters and pass the weak-secret checks).

### 3.6 Portal routers and event hub

`api/portal/index.ts` mounts `hosted`, `auth`, `transactions`, `scenarios`, `webhooks`, `statements` and `internal`.

`api/portal/eventHub.ts` is a process-local SSE hub:

- `GET /portal-api/transactions/stream` calls `subscribe(response)`.
- Headers are `text/event-stream`, `no-cache, no-transform`, `keep-alive` and `X-Accel-Buffering: no`.
- A `ready` event is written immediately and a comment heartbeat every 15 seconds keeps proxies open.
- `broadcast(type, payload)` fans out frames to all connected clients. There is no backpressure handling beyond catching write errors and dropping the client.

### 3.7 SDK surface

`api/sdk/index.ts` serves two generated scripts:

- `/sdk/moamalat-lightbox.js` exposes `window.Lightbox.Checkout.configure()` and `open()`.
- `/sdk/mpgs-session.js` exposes `window.PaymentSession.configure()` and `showLightbox()`.

Both scripts build an iframe against `FAKE_RAILS_PUBLIC_BASE_URL/hosted/widget-frame`, pass configuration as query parameters, and bridge `fake-rails:complete`, `fake-rails:error` and `fake-rails:cancel` messages. `sriHash()` computes SHA-384, but `seedFakeRails.ts` writes an empty SRI array, so the browser cannot verify the script by integrity.

## 4. Contracts and invariants

1. **No gateway database access.** No PostgreSQL, Prisma, `pg` or `DATABASE_URL` import exists in `fake-rails-back`.
2. **One writable SQLite file.** The default is `FAKE_RAILS_DATA_DIR/fake-rails.sqlite`; WAL mode allows readers while a write is active, but the process assumes a single writer.
3. **Reference identity.** A transaction is resolved by gateway code plus our/provider/network reference, or by internal id. Provider references are unique by schema.
4. **Money is text.** Wire amounts and LYD normalised amounts are decimal strings; arithmetic on them happens outside the database.
5. **Status vocabulary.** Rail rows use `INITIATED`, `AWAITING_ACTION`, `PAID`, `FAILED`, `CANCELLED`, `REFUNDED` and are queried by the portal and statement code. The core engine's fourteen-state attempt machine is not mirrored.
6. **Deterministic OTP derivation.** `deriveOtp(seederToken, railCode, reference, length)` gives the same OTP for the same transaction, so a tester can retrieve it later.
7. **Deterministic webhook secrets.** `deriveSecret(seederToken, gatewayCode, purpose)` is shared with `core-back/prisma/seedFakeRails.ts`.
8. **No implicit authentication of rails.** The design requires realistic auth, but the implementation currently accepts any request that matches a route.

## 5. Data / API / config / deployment surface

### 5.1 Route groups

| Group | Base path | Notes |
| :--- | :--- | :--- |
| Rail emulation | `/rails/:gatewayCode/*` | Dispatcher resolves aliases and exact paths |
| SDK | `/sdk/:script` | `moamalat-lightbox.js`, `mpgs-session.js` |
| Portal API | `/portal-api/*` | Tester JWT or seeder token |
| Hosted health | `/hosted/health` | Public |
| Health | `/health` | Public |

### 5.2 SQLite tables

| Table | Purpose |
| :--- | :--- |
| `fake_rail_scenarios` | Persisted per-rail chaos configuration |
| `fake_transactions` | Emulated payment records |
| `fake_step_events` | Wire request/response journal |
| `fake_webhook_deliveries` | Durable outbound webhook queue |
| `fake_statements` | Generated statement metadata |
| `fake_portal_audit` | Tester action audit |

### 5.3 Environment surface

The deployment-facing keys are in `deploy/deploy.env.example` section 7 and mapped by `deploy/lib/hostPlanner.ts` into the `pg-fake-rails-back` service environment. The service-level schema is authoritative for defaults and validation.

## 6. Operational usage

```bash
cd fake-rails-back
bun install
FAKE_RAILS_ADMIN_USER=tester_admin \
FAKE_RAILS_ADMIN_PASSWORD='Strong-Tester-Pass-2026!' \
FAKE_RAILS_JWT_SECRET='0123456789abcdef0123456789abcdef' \
FAKE_RAILS_SEEDER_TOKEN='0123456789abcdef0123456789abcdef' \
bun run start
```

- Health: `curl http://127.0.0.1:4104/health`.
- Login: `POST /portal-api/auth/login`.
- The portal SPA is served by `fake-rails-front` on port 5104 in development or by the Nginx vhost in deployment.
- Delete the SQLite file (and its `-wal`/`-shm` siblings) to reset state. The schema is applied idempotently.
- If the process is behind Nginx, forward `/portal-api`, `/rails`, `/sdk` and `/hosted` to the backend port and keep the backend bound to loopback.

## 7. Status and deviations

### Implemented

- Standalone Express service with no gateway-database dependency.
- SQLite WAL schema, transactions, step events, webhook deliveries, statements and portal audit.
- Zod environment validation with three startup guards.
- Single-user login, rate limiting, HS256 JWT and portal guard.
- Seeder handshake and transactional bulk seed endpoint.
- SSE event hub with heartbeat.
- Request logging, error envelope and raw-body capture.
- Generated Moamalat and MPGS SDK scripts.

### Partial

- The service records requests and responses but does not authenticate inbound rail calls, despite the design's protocol-fidelity claim.
- Portal rate limiting and JWT revocation are process-local and restart-scoped.
- SQLite is a single-process writer; horizontal scaling is not supported.
- TLS is terminated by Nginx; the Bun listener has no certificate configuration.
- The SSE hub has no replay, resume cursor or client limit.

### Missing / deferred

- Direct HTTPS listener in `fake-rails-back`.
- Persistent tester session/revocation store.
- Structured request redaction before storing wire logs.
- A formal migration mechanism for the SQLite schema beyond idempotent `CREATE TABLE IF NOT EXISTS`.
- Multi-instance/shared state.

### Known bugs / risks

- **Code gap:** raw request headers and bodies, including tester credentials and generated OTPs, are stored in `fake_step_events` without redaction. This is acceptable only because the service is a test emulator and must remain isolated.
- **Code gap:** the login limiter trusts `request.ip` with `trust proxy` enabled; a misconfigured proxy chain can collapse or spoof client addresses.
- **Documentation gap:** the historical design says all nine modes and ten phases are emulated; the actual protocol coverage is narrower and is documented in `fake-rails.protocol`.
- **Design gap:** there is no state-machine enforcement beyond direct status updates; a rail handler can move a row from any status to any status.

## 8. Verification and tests

- `fake-rails-back/test/api.test.ts` (11 tests) starts the real Express app on an ephemeral port with a throw-away SQLite file and covers health, seeder handshake, login, protected routes, OTP initiate/confirm/inquiry, wrong OTP, chaos persistence, bulk seed, statement anomaly injection, SDK serving and hosted approval.
- `fake-rails-back/test/crypto.test.ts` (5 tests) covers canonicalisation, HMAC sign/verify, timestamp-dot-raw-body and deterministic secret/OTP derivation.
- `fake-rails-back/test/exhaustive/05-api-matrix/fake-rails-portal-and-chaos-api.test.ts` (30 tests) covers auth, the 20-rail scenario matrix, transaction actions, webhooks and statement formats.
- These tests use in-memory or `/tmp` SQLite and do not need PostgreSQL or Redis.
- No test starts the service behind Nginx, over TLS, or with a second process sharing the database file.

## 9. Source references

### Old design sections

- `design/04-fake-rails-and-seeder/fake_payment_rails_service_architecture.md` sections 1, 2 and 3.
- `design/04-fake-rails-and-seeder/fake_payment_rails_service_architecture.md` section 5.3 for the SQLite schema intent.
- `design/04-fake-rails-and-seeder/fake_payment_rails_service_architecture.md` section 8 for the implementation checklist.

### Code paths

- `fake-rails-back/index.ts`
- `fake-rails-back/lib/env/index.ts`
- `fake-rails-back/engine/db/index.ts`
- `fake-rails-back/engine/db/schema.sql`
- `fake-rails-back/api/index.ts`
- `fake-rails-back/api/middleware/portalAuthGuard.ts`
- `fake-rails-back/api/portal/auth.ts`
- `fake-rails-back/api/portal/eventHub.ts`
- `fake-rails-back/api/sdk/index.ts`
- `fake-rails-back/lib/jwt.ts`
- `fake-rails-back/lib/rawBody/index.ts`
- `fake-rails-back/lib/error/index.ts`
- `fake-rails-back/lib/requestLogger/index.ts`

### Generated appendices

- `project-design/appendices/api-route-matrix.md`
- `project-design/appendices/env-and-config-matrix.md`
- `project-design/appendices/test-inventory.md`

## 10. Change history

- 2026-11-03: initial canonical part. Verified against `5a24f6f+working-tree`.

## Security hardening (2026-11-05)

- The JWT secret and seeder token must be at least 32 characters and pass the same weak-secret checks as deploy. The seeder token compare is constant-time. The session token is never accepted from the query string; `/transactions/stream` takes a single-use `?ticket=` instead (GAP-024).
- `FAKE_RAILS_ALLOWED_CIDRS` is enforced against `socket.remoteAddress` (not `X-Forwarded-For`); behind nginx the real allowlist is the nginx `allow`/`deny` block. `FAKE_RAILS_TRUST_PROXY` defaults to loopback. `FAKE_RAILS_PORTAL_ACCOUNT_LOCKOUT` (default 5 per username) locks repeated failed portal logins.
- **Hosted action token and stream ticket (GAP-024, RESOLVED 2026-11-05).** `GET /hosted/session/:reference` now returns `action_token`, a JWT bound to that transaction id with the purpose role `FAKE_RAILS_HOSTED_ACTION` (15 minutes); the approve/decline action POST must send it in `X-Hosted-Action-Token` or gets `401 HOSTED_ACTION_TOKEN_REQUIRED`. `POST /portal-api/transactions/stream-ticket` (tester session required) issues a `FAKE_RAILS_SSE_TICKET` JWT (30 seconds, unique `jti`); `portalAuthGuard` accepts it only on `/transactions/stream` and consumes it once (`consumeSseTicket`; replay is `401`). Both tokens are signed with the portal JWT secret but carry their own `role` (helpers in `fake-rails-back/lib/tickets.ts`), so neither works as a tester session and a tester session works as neither. The used-ticket map is in-process and pruned on use. `/hosted/*` session reads remain public.
- **Residual.** `fake-rails-front` still keeps the tester token in localStorage (GAP-019 does not cover this portal).

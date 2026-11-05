<!-- GENERATED FILE. Edit project-design/parts/** instead. Do not hand-edit this file. -->

# fake-rails-back blueprint

Generated from: `fake-rails.backend`, `fake-rails.protocol`, `fake-rails.chaos`, `fake-rails.integration`.

## Fake Rails Backend Architecture

> Status: `partial` · Last verified: 2026-11-05

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

`fake-rails-back/lib/env/index.ts` defines the Zod schema and a lazy proxy so importing the module does not parse the environment. Required values have no defaults: `FAKE_RAILS_ADMIN_USER` (4-128 chars), `FAKE_RAILS_ADMIN_PASSWORD` (12-512), `FAKE_RAILS_JWT_SECRET` (16-512) and `FAKE_RAILS_SEEDER_TOKEN` (16-512).

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
- Everything else requires a Bearer token or `?token=` query token with `role=FAKE_RAILS_TESTER`.

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

- The JWT secret and seeder token must be at least 32 characters and pass the same weak-secret checks as deploy. The seeder token compare is constant-time. A `?token=` JWT is accepted only on `/transactions/stream`.
- `FAKE_RAILS_ALLOWED_CIDRS` is enforced against `socket.remoteAddress` (not `X-Forwarded-For`); behind nginx the real allowlist is the nginx `allow`/`deny` block. `FAKE_RAILS_TRUST_PROXY` defaults to loopback. `FAKE_RAILS_PORTAL_ACCOUNT_LOCKOUT` (default 5 per username) locks repeated failed portal logins.
- Still open: `/hosted/*` remains public with no token on the action POST (GAP-024).

## Fake Rails Protocol Matrix

> Status: `partial` · Last verified: 2026-11-03

## 1. Purpose and scope

This part defines what the emulator actually speaks: the twenty rail descriptors, their aliases, collection modes, wire routes, amount handling, OTP generation, phase coverage and the places where the emulated protocol diverges from the gateway blueprints seeded into `core-back`.

It does not repeat the backend process model (`fake-rails.backend`), the tester UI (`fake-rails.chaos`) or the seeding/SSRF wiring (`fake-rails.integration`).

## 2. Design intent (extracted and synthesized from ./design)

The historical design requires protocol-accurate emulation of all twenty gateways and all nine collection modes. The emulator should honour:

- The exact endpoint paths used by the seeded flow steps.
- Content types: JSON, form-urlencoded, multipart/form-data and XML/SOAP.
- Amount scales: integer dirhams for Moamalat, three-decimal strings for LYPay/NeomPay, two-decimal strings for most other rails.
- Authentication shapes: Bearer, API key, Basic, OAuth token endpoint, mutual TLS and request signatures.
- Inbound signature verification using the same canonicalisation recipes as the gateway.
- Idempotency and duplicate-reference behaviour.
- Hosted redirect and embedded widget flows, including success, decline, cancel, tampered return and dropped-webhook variants.
- Settlement statement endpoints for every gateway.

The intent is not merely to return success. It is to make `core-back` exercise its real URL compiler, transform pipeline, crypto profiles, status rules and reconciliation paths.

## 3. As-built architecture

### 3.1 Descriptor catalogue

`fake-rails-back/engine/chaos/DefaultRailScenarios.ts` defines `RAIL_DESCRIPTORS`, with twenty entries. `resolveRail(code)` matches the rail code, gateway code and every alias case-insensitively. `canonicalRailCode(code)` returns the rail code.

| Rail code | Gateway code | Name | Collection modes | Aliases | OTP length |
| :--- | :--- | :--- | :--- | :--- | ---: |
| `edfali` | `edfali` | Edfali | `OTP_PULL` | `edfali` | 4 |
| `sadad` | `sadad` | Sadad | `OTP_PULL` | `sadad` | 6 |
| `mobicash` | `mobicash` | MobiCash | `OTP_PULL`, `QR_DISPLAY` | `mobicash` | 6 |
| `moamalat` | `moamalat` | Moamalat NPG | `EMBEDDED`, `REDIRECT` | `moamalat`, `moamalat_card` | 6 |
| `ly_pay` | `cbl_lypay` | CBL LYPay | `QR_DISPLAY`, `PUSH_APPROVAL` | `ly_pay`, `lypay`, `cbl_lypay` | 6 |
| `onepay` | `onepay` | OnePay | `QR_DISPLAY`, `PAY_CODE`, `OTP_PULL` | `onepay` | 6 |
| `tlync` | `tlync` | Tadawul T-LYNC | `REDIRECT` | `tlync` | 6 |
| `mypay` | `mypay` | MyPay | `REDIRECT` | `mypay` | 6 |
| `dpay` | `dpay` | DPay | `REDIRECT`, `OTP_PULL`, `EMBEDDED` | `dpay` | 6 |
| `plutu` | `plutu` | Plutu | `OTP_PULL`, `REDIRECT` | `plutu` | 6 |
| `yussor_pay` | `yussor` | Yussor Pay | `HYBRID`, `OTP_PULL`, `QR_DISPLAY`, `PAY_CODE` | `yussor_pay`, `yussor` | 6 |
| `sahara_pay` | `sahara` | Sahara Pay | `HYBRID`, `OTP_PULL`, `QR_DISPLAY`, `PAY_CODE` | `sahara_pay`, `sahara` | 6 |
| `masrefy_pay` | `masrefy` | Masrefy Pay | `HYBRID`, `OTP_PULL`, `QR_DISPLAY`, `PAY_CODE` | `masrefy_pay`, `masrefy` | 6 |
| `hawelli` | `hawelli` | Hawelli | `PUSH_APPROVAL`, `QR_DISPLAY`, `OTP_PULL`, `DEEP_LINK` | `hawelli` | 6 |
| `gpay_libya` | `gpay_libya` | GPay Libya | `PUSH_APPROVAL`, `QR_DISPLAY`, `OTP_PULL`, `DEEP_LINK` | `gpay_libya`, `gpay` | 6 |
| `numo_pay` | `numo_pay` | Numo Pay | `PUSH_APPROVAL`, `QR_DISPLAY`, `OTP_PULL`, `DEEP_LINK` | `numo_pay`, `numo` | 6 |
| `libyana` | `libyana` | Libyana | `PUSH_APPROVAL`, `QR_DISPLAY`, `OTP_PULL`, `DEEP_LINK` | `libyana` | 6 |
| `mpgs` | `mpgs` | MPGS (Visa/Mastercard) | `EMBEDDED`, `REDIRECT` | `mpgs` | 6 |
| `evopay` | `evo_pay` | Evo Pay | `QR_DISPLAY`, `PUSH_APPROVAL` | `evopay`, `evo_pay` | 6 |
| `neompay` | `neompay` | NeomPay | `HYBRID` | `neompay`, `neompay_wallet` | 6 |

### 3.2 Route definition model

`api/rails/types.ts` defines `RailRouteDefinition` with `gatewayCodes`, `method` (`GET` or `POST`), `path`, `phase` and `handler`. Router files export arrays:

- `otpPullRouter.ts` for Edfali, Sadad and MobiCash.
- `embeddedRouter.ts` for Moamalat and MPGS.
- `qrAndPushRouter.ts` for LYPay, OnePay, hybrid wallets, push wallets and Evo Pay.
- `redirectRouter.ts` for T-LYNC, MyPay, DPay and Plutu.
- `internalNeomPayRouter.ts` for NeomPay.
- `statementRouter.ts` for the per-gateway statement route.

`api/rails/index.ts` concatenates them into `RAIL_ROUTES`. `createRailsRouter()` resolves `:gatewayCode`, matches method and path segment by segment (`:param` and `*` accepted), creates or finds a transaction, evaluates chaos, records the event and sends the handler response.

### 3.3 Mode coverage

| Collection mode | Emulated? | Actual evidence |
| :--- | :--- | :--- |
| `OTP_PULL` | Yes, partial | Edfali, Sadad, MobiCash, OnePay, DPay, Plutu, hybrid/push rails |
| `REDIRECT` | Yes, partial | T-LYNC, MyPay, DPay, Plutu, Moamalat, MPGS hosted redirect |
| `EMBEDDED` | Yes, partial | Moamalat and MPGS SDK plus `/hosted/widget-frame` |
| `PUSH_APPROVAL` | Yes, generic | Push rails expose `/request`, `/confirm`, `/cancel`, `/status/:ref` |
| `QR_DISPLAY` | Yes, generic | `asyncInitiate` returns `qr_code`/`qr_payload` |
| `PAY_CODE` | Yes, generic | OnePay `/paycode`; `pay_code` uses the derived OTP |
| `DEEP_LINK` | Yes, generic | Push rails return `deep_link` to the hosted redirect page |
| `HYBRID` | Label only | Mode is advertised; routing is still a fixed set of generic routes |
| `MANUAL` | No | No descriptor uses it and no route implements it |

The descriptor catalogue contains eight of the nine modes. `MANUAL` exists in the core vocabulary but is not represented.

### 3.4 Phase coverage

The core design names ten declarative phases. The fake backend uses the five-value `FailPhase` union `INITIATE`, `SUBMIT`, `VERIFY`, `WEBHOOK`, `REFUND` for chaos decisions, while routes carry the first four plus `REFUND`.

| Declarative phase | Fake coverage | Notes |
| :--- | :--- | :--- |
| `CREDENTIAL_CHECK` | Missing | No credential probe endpoint |
| `PRE_INITIATE` | Missing | No pre-initiate route or validation |
| `INITIATE` | Implemented | OTP, QR, push, redirect, token and payment creation |
| `SUBMIT` | Implemented | OTP confirm, async confirm, wallet confirm |
| `VERIFY` | Implemented | Inquiry, status, enquiry, receipt and ledger export |
| `CANCEL` | Partial | Push wallets have `/cancel`; hosted UI has a cancel action; no generic engine cancel route |
| `REFUND` | Partial | Moamalat, MPGS, T-LYNC, DPay and NeomPay only |
| `VOID` | Missing | No void endpoint |
| `CAPTURE` | Missing | No separate capture endpoint |
| `SETTLEMENT_FETCH` | Missing | Statement GET exists but is not a core flow |

### 3.5 Per-gateway route map

| Gateway code | Routes implemented in the emulator |
| :--- | :--- |
| `edfali` | `POST /verify`, `POST /confirm`, `GET /status/:ref`, `GET /statement` |
| `sadad` | `POST /verify`, `POST /confirm`, `GET /status/:ref`, `GET /statement` |
| `mobicash` | `POST /open`, `POST /confirm`, `POST /qr`, `GET /status/:ref`, `GET /statement` |
| `moamalat` | `POST /FilterTransactions`, `POST /refund`, `POST /confirm`, `GET /statement` |
| `ly_pay` | `POST /api/v1/auth/token`, `POST /api/v1/payments/funds-transfers`, `POST /api/v1/payments/funds-transfers/:uuid/confirm`, `GET /api/v1/payments/funds-transfers/enquiry`, `GET /statement` |
| `onepay` | `POST /qr`, `POST /paycode`, `POST /verify`, `POST /confirm`, `GET /status/:ref`, `GET /statement` |
| `tlync` | `POST /payment/create`, `POST /receipt/transaction`, `POST /refund`, `GET /statement` |
| `mypay` | `POST /auth/token`, `POST /payment/create`, `GET /statement` |
| `dpay` | `POST /sessions/open`, `POST /sessions/:id/verify`, `GET /sessions/:id`, `POST /refund`, `GET /statement` |
| `plutu` | `POST /edfali/verify`, `POST /edfali/confirm`, `POST /sadad/verify`, `POST /sadad/confirm`, `POST /tlync/create`, `GET /statement` |
| `yussor` | `POST /initiate`, `POST /confirm`, `GET /status/:ref`, `GET /statement` |
| `sahara` | `POST /initiate`, `POST /confirm`, `GET /status/:ref`, `GET /statement` |
| `masrefy` | `POST /initiate`, `POST /confirm`, `GET /status/:ref`, `GET /statement` |
| `hawelli` | `POST /request`, `POST /confirm`, `POST /cancel`, `GET /status/:ref`, `GET /statement` |
| `gpay_libya` | `POST /request`, `POST /confirm`, `POST /cancel`, `GET /status/:ref`, `GET /statement` |
| `numo_pay` | `POST /request`, `POST /confirm`, `POST /cancel`, `GET /status/:ref`, `GET /statement` |
| `libyana` | `POST /request`, `POST /confirm`, `POST /cancel`, `GET /status/:ref`, `GET /statement` |
| `mpgs` | `POST /session`, `GET /order/:id`, `POST /order/:id/refund`, `POST /order/:id/confirm`, `GET /statement` |
| `evopay` | `POST /Payment`, `GET /Payment/:id`, `GET /statement` |
| `neompay` | `POST /payments/requests`, `POST /payments/:id/confirm`, `GET /payments/by-reference/:ref`, `POST /payments/:id/refund`, `GET /ledger-export`, `GET /statement` |

### 3.6 Amount and customer handling

`api/rails/common.ts` extracts references from a large recursive key list (`reference`, `merchant_reference`, `order_id`, `idempotency_key`, `ref`, and others), then from `idempotency-key` or `x-request-id`, then generates `FK-<timestamp>-<random>`. The descriptor `defaultOtp` field is never read; the expected OTP always comes from `deriveOtp()`.

`normalizeAmount()` implements:

- `moamalat`: integer dirhams, `LYD * 1000`, wire string integer.
- `ly_pay` and `neompay`: string decimal with four-decimal normalisation and scale `1000`.
- Everything else: string decimal with four-decimal normalisation and scale `100`.

`maskCustomer()` masks cards for Moamalat/MPGS, wallets for NeomPay and phones otherwise. `extractOtp()` accepts common OTP key names. `deriveOtp()` hashes the seeder token, rail code and reference and truncates to the descriptor length.

`phaseForPath()` exists but the dispatcher uses the route's declared phase rather than inferring from the path.

### 3.7 Wire shapes

`successBase()` returns our reference, provider reference, transaction id, network reference, amount, currency and process id. `successResponse()` adds `status`, `success` and `ActionCode`. `failureBody()` adds a stable error code and action code.

Handlers return protocol-shaped payloads:

- `otpInitiate`: `AWAITING_CUSTOMER`, `process_id`, OTP, expiry.
- `otpConfirm`: `PAID` or retryable wrong OTP.
- `asyncInitiate`: QR payload, deep link, push reference, pay code and expiry.
- `redirectInitiate`: hosted `redirect_url`, return/cancel URLs and expiry.
- `inquiry`: `PAID`, `FAILED` or `PENDING` with a nested `payment.status`.
- `refund`: `REFUNDED` or `NOT_REFUNDABLE`.
- `cancel`: `CANCELLED`.
- `tokenEndpoint`: fake Bearer token with gateway-dependent expiry.

### 3.8 Actual route mismatches

Two gateway codes are seeded into `core-back` but are not the codes used by the route definitions:

1. **`cbl_lypay`.** The blueprint seeds the gateway as `cbl_lypay` and the flow URL template as `{api}/api/v1/payments/funds-transfers`, where `{api}` becomes `FAKE_RAILS_PUBLIC_BASE_URL/rails/cbl_lypay`. The descriptor resolves `cbl_lypay` to gateway code `cbl_lypay`, but `qrAndPushRouter.ts` registers those paths under `gatewayCodes: ["ly_pay"]`. `matchRailRoute()` therefore returns no route and the request gets `404 UNKNOWN_RAIL_ENDPOINT`. Calling `/rails/ly_pay/...` works, but the seeded gateway never uses that URL.
2. **`evo_pay`.** The blueprint seeds `evo_pay` with `POST /Payment` and `GET /Payment/:id`. The descriptor's gateway code is `evo_pay`, but the routes are registered under `gatewayCodes: ["evopay"]`. The seeded URL `/rails/evo_pay/Payment` therefore returns `404 UNKNOWN_RAIL_ENDPOINT`.

The clean fix is to make route definitions use descriptor `gatewayCode` values, or make the dispatcher match `descriptor.railCode` as well as `descriptor.gatewayCode`. Until then, the four affected core flows cannot run against the emulator.

A related mismatch exists in `statementRouter.ts`: `STATEMENT_GATEWAYS` lists `ly_pay` and `evopay`, not `cbl_lypay` and `evo_pay`, so those two seeded gateways also lack a statement route.

### 3.9 Default webhook path bug

`WebhookDispatcher.defaultUrlFor()` builds:

```text
${CORE_INBOUND_BASE_URL}/webhook/${gateway_code}/${env.toLowerCase()}/${gateway_code}-webhook
```

With the default base `http://127.0.0.1:4103/api/v1/inbound`, this becomes `/api/v1/inbound/webhook/...`. The actual checkout route is `POST /api/v1/inbound/:gateway/:env/:pathToken`. The literal `webhook` segment is interpreted as `:gateway`, so every default webhook is routed to the wrong handler/404 path.

The third segment is also hard-coded as `${gateway_code}-webhook`. Blueprint channel tokens are not uniformly that string: examples include `cbl-lypay-webhook` and `evo-pay-webhook`. `seedFakeRails.ts` rewrites the first webhook channel per gateway code to `${code}-webhook`, which masks the token problem only when that pass has run; it does not fix the extra path segment.

### 3.10 Missing inbound signature verification

The design says the emulator verifies the gateway auth and crypto recipes. The implementation does not:

- No route checks `Authorization`, `X-API-KEY`, `Basic`, `Secret-Key`, `X-Store-Token` or `X-Store-Id`.
- No route verifies HMAC, RSA, `SecureHash`, timestamp tolerance or canonical string.
- No idempotency conflict is refused; an existing reference is silently reused.
- No source-IP allowlist is applied to rail routes.
- No `422` duplicate-reference response exists.

Only the outbound webhook path computes signatures (`FakeCryptoSigner` plus six gateway profiles). Inbound verification is therefore a protocol-fidelity gap, not just a missing test.

### 3.11 Dead auto-approve

`RailChaosScenarioConfig.autoApproveAsyncAfterSec` is defined, persisted, merged by `PUT /portal-api/scenarios/:railCode`, and returned to the UI. Nothing reads it. No timer, worker or request path schedules an automatic approval after the configured number of seconds. Async rails only settle when a caller hits `/confirm`, the hosted page approves, or the tester approves a transaction.

### 3.12 Statement route mismatch

`GET /rails/:gateway/statement` is implemented for every descriptor code. It filters the last 1,000 transactions by gateway and date window and returns CSV or JSON. There is no auth and no XLSX on this route.

`core-back` has no `SETTLEMENT_FETCH` engine flow. The seeded statement channels are inbound channel records with `pathToken = <code>-statement`; reconciliation is driven by uploaded files through the admin reconciliation route, not by fetching `/statement`. The emulator's statement endpoint is therefore a tester convenience, not part of the automated core lifecycle.

## 4. Contracts and invariants

1. **Alias resolution is case-insensitive.** `cbl_lypay`, `ly_pay` and `lypay` all resolve to the same descriptor.
2. **Route matching is exact after alias resolution.** Path segment count must match; `:param` matches one segment.
3. **A transaction reference is created once and reused.** Subsequent requests with the same reference do not create a second row.
4. **Amount normalisation is gateway-specific and text-only.** No floating-point arithmetic is used to store money.
5. **OTP generation is deterministic per transaction.** The portal exposes the current expected OTP.
6. **Successful confirmation generates a webhook.** Confirmation handlers call `dispatchSuccessWebhook`, except where a fault suppresses or delays it.
7. **Webhook signatures are derived from the seeder token.** The signature profile depends on the gateway code, with a generic fallback.

## 5. Data / API / config / deployment surface

- Descriptors: `RAIL_DESCRIPTORS` and `resolveRail()` in `DefaultRailScenarios.ts`.
- Route arrays: `RAIL_ROUTES` in `api/rails/index.ts`.
- Dispatcher: `createRailsRouter()`.
- Amount, reference, OTP and masking helpers: `api/rails/common.ts`.
- Handlers: `api/rails/handlers.ts`.
- Statement route: `api/rails/statementRouter.ts`.
- Core URL source: `core-back/prisma/seedBlueprints.ts` `urlTemplate` values.
- Core base URL rewrite: `core-back/prisma/seedFakeRails.ts` `gatewayBaseUrl()`.

## 6. Operational usage

- Test one rail directly: `curl -X POST http://127.0.0.1:4104/rails/edfali/verify -H 'content-type: application/json' -d '{"reference":"R-1","amount":"10.00","phone":"0911234567"}'`.
- Complete OTP: use the returned `otp` against `/rails/edfali/confirm`.
- List transactions: `GET /portal-api/transactions` with a tester JWT.
- Inspect wire calls: `GET /portal-api/transactions/:id`.
- Generate a statement: `POST /portal-api/statements/generate` with `{ gatewayCode, format }`.
- For seeded gateways, verify the actual base URL in `gateway_environments.base_urls`; do not assume the descriptor code is the URL code.

## 7. Status and deviations

### Implemented

- Twenty descriptors with aliases and collection-mode labels.
- Generic route implementations for OTP, QR/push, redirect, embedded and internal wallet patterns.
- Moamalat and MPGS SDK scripts.
- Per-rail statement endpoint.
- Amount-scale handling for Moamalat, LYPay/NeomPay and the default rails.
- Deterministic OTP and provider references.

### Partial

- Mode coverage: eight of nine labels; `HYBRID` is a label rather than a distinct protocol.
- Phase coverage: four phases plus refund; cancel/void/capture/settlement fetch absent.
- Protocol shape: handlers return a generic envelope rather than gateway-specific XML/SOAP or exact partner payloads.
- Auth: outbound signing exists; inbound verification does not.
- Statements: route exists, but no core fetch flow uses it.

### Missing / deferred

- Inbound signature verification and idempotency conflict handling.
- `CREDENTIAL_CHECK`, `PRE_INITIATE`, `VOID`, `CAPTURE` and `SETTLEMENT_FETCH` routes.
- Real XML/SOAP envelopes for any gateway that requires them.
- Per-gateway error catalogues and status-rule parity.
- Automatic async approval.
- Route definitions using canonical descriptor gateway codes.

### Known bugs / risks

- **Code bug:** `cbl_lypay` and `evo_pay` seeded URLs do not match route keys.
- **Code bug:** default webhook URL has an extra `/webhook` segment.
- **Code gap:** inbound requests can claim any amount, reference or provider state without authentication.
- **Code gap:** statement routes are not keyed to the canonical gateway codes for the two mismatched rails.
- **Documentation gap:** historical claims of "all 20 gateways, all modes, all phases" are false.

## 8. Verification and tests

- `fake-rails-back/test/chaos.test.ts` asserts twenty descriptors and alias resolution, including `cbl_lypay -> ly_pay` and `evo_pay -> evopay`, but does not request their seeded URLs.
- `fake-rails-back/test/api.test.ts` drives Edfali OTP, T-LYNC redirect/hosted approval and the Moamalat SDK script.
- The suite-05 fake-rails test drives the scenario API for all twenty rail codes, not the rail protocol routes.
- There is no HTTP matrix test that calls every route with the gateway code used by `core-back`.
- No test asserts the webhook URL shape, inbound auth, duplicate-reference refusal or statement parity.

## 9. Source references

### Old design sections

- `design/04-fake-rails-and-seeder/fake_payment_rails_service_architecture.md` section 4 and 4.1.
- `design/04-fake-rails-and-seeder/fake_payment_rails_service_architecture.md` section 4.2.
- `design/04-fake-rails-and-seeder/fake_payment_rails_service_architecture.md` section 5 for chaos phase intent.

### Code paths

- `fake-rails-back/engine/chaos/DefaultRailScenarios.ts`
- `fake-rails-back/api/rails/index.ts`
- `fake-rails-back/api/rails/common.ts`
- `fake-rails-back/api/rails/handlers.ts`
- `fake-rails-back/api/rails/otpPullRouter.ts`
- `fake-rails-back/api/rails/embeddedRouter.ts`
- `fake-rails-back/api/rails/qrAndPushRouter.ts`
- `fake-rails-back/api/rails/redirectRouter.ts`
- `fake-rails-back/api/rails/internalNeomPayRouter.ts`
- `fake-rails-back/api/rails/statementRouter.ts`
- `core-back/prisma/seedBlueprints.ts`
- `core-back/prisma/seedFakeRails.ts`

### Generated appendices

- `project-design/appendices/api-route-matrix.md`
- `project-design/appendices/test-inventory.md`

## 10. Change history

- 2026-11-03: initial canonical part. Verified against `5a24f6f+working-tree`.

## Fake Rails Chaos Engine and Tester Portal

> Status: `partial` · Last verified: 2026-11-05

## 1. Purpose and scope

This part covers the deterministic and probabilistic failure engine, the SQLite state it owns, outbound webhook anomalies, settlement-statement generation, the tester portal API and the `fake-rails-front` SPA.

It does not cover the backend process model (`fake-rails.backend`), the route matrix (`fake-rails.protocol`) or the core seeding/deploy wiring (`fake-rails.integration`).

## 2. Design intent (extracted and synthesized from ./design)

The design requires a tester to answer four questions at any moment:

1. What did the gateway receive and return?
2. Is this rail healthy, flaky, delayed or completely down?
3. If it fails, how and in which phase does it fail?
4. Can the tester force a specific outcome, replay a webhook, forge a signature or generate an anomalous statement?

The intended failure controls are:

- A per-rail `overallFailureChancePercent` from 0 to 100.
- Weighted phase choice across `INITIATE`, `SUBMIT`, `VERIFY`, `WEBHOOK` and `REFUND`.
- Weighted failure modes: insufficient funds, customer ceiling, wrong OTP, HTTP 500, timeout/hang, socket reset, malformed 200 body, HTTP 429, amount mismatch and conflicting webhook versus inquiry.
- Latency range.
- Async auto-approval after N seconds.
- Webhook delay, duplicate count, out-of-order PENDING-after-PAID and corrupt-signature chance.

The intended portal has a live SSE feed, an OTP/action banner, a pending-action queue, a transaction/wire inspector, a chaos matrix, a statement generator and hosted redirect/widget pages.

## 3. As-built architecture

### 3.1 Scenario model

`engine/chaos/DefaultRailScenarios.ts` defines:

```ts
interface RailChaosScenarioConfig {
  railCode: string;
  gatewayCode: string;
  enabled: boolean;
  overallFailureChancePercent: number;
  phaseBreakdown: {
    initiateFailWeight: number;
    submitFailWeight: number;
    verifyFailWeight: number;
    webhookFailWeight: number;
    refundFailWeight: number;
  };
  failureModeWeights: Record<FailureMode, number>;
  latencyMs: { min: number; max: number };
  autoApproveAsyncAfterSec: number | null;
  webhookBehavior: {
    delaySeconds: number;
    duplicateCount: number;
    outOfOrderPendingAfterPaid: boolean;
    corruptSignatureChancePercent: number;
  };
}
```

The healthy baseline is `enabled=true`, `overallFailureChancePercent=0`, latency 40-250 ms, one webhook copy and no corruption. `defaultScenario()` gives one configuration per descriptor. Defaults are inserted into `fake_rail_scenarios` on first access.

`FailureMode` has ten values exactly matching the design. `FailPhase` has five values (`INITIATE`, `SUBMIT`, `VERIFY`, `WEBHOOK`, `REFUND`). The core's ten declarative phases are not the same type.

### 3.2 Deterministic PRNG

`engine/chaos/prng.ts` implements mulberry32 plus FNV-1a string hashing, `int`, `pick`, `chance(percent)` and `weighted(record)`. A scenario seed is `${railCode}:${reference}` for transaction fate and `${transactionId}:${phase}` for latency, so repeated runs with the same reference are reproducible.

### 3.3 Evaluation priority

`ChaosEvaluator.evaluate()` applies this order:

1. **Magic input** in the current phase. It wins over everything.
2. **Disabled rail.** `enabled=false` produces `HTTP_500_GATEWAY_FAULT` with source `OUTAGE`; `applyFault` maps that source to HTTP 503.
3. **Pinned transaction fate.** When the transaction row has `assigned_failure_mode` and `assigned_fail_phase` equal to the current phase.
4. **No failure.**

`assignFate()` runs once when a new transaction row is created. It rolls `overallFailureChancePercent`; if it fails, it samples a phase from `phaseBreakdown` and a mode from `failureModeWeights`, then persists both on `fake_transactions`.

### 3.4 Magic inputs

`detectMagicTrigger()` flattens body values and the raw body text, then checks:

| Trigger | Failure mode | Phase |
| :--- | :--- | :--- |
| OTP `000000` or `0000` | `WRONG_OTP_RETRYABLE` | `SUBMIT` |
| OTP `999999` | `TERMINAL_DECLINE_INSUFFICIENT_FUNDS` | `SUBMIT` |
| OTP `500500` | `HTTP_500_GATEWAY_FAULT` | `SUBMIT` |
| OTP `408408` | `TIMEOUT_HANG_ABOVE_STEP_TTL` | `SUBMIT` |
| Phone ending `9901` | `TERMINAL_DECLINE_INSUFFICIENT_FUNDS` | `SUBMIT` |
| Phone ending `9902` | `LIMIT_EXCEEDED_CUSTOMER_CEILING` | `SUBMIT` |
| Phone ending `9905` | `HTTP_500_GATEWAY_FAULT` | `SUBMIT` |
| Phone ending `9906` | `TIMEOUT_HANG_ABOVE_STEP_TTL` | `SUBMIT` |
| Phone ending `9907` | `MALFORMED_OR_UNMAPPED_200_BODY` | `SUBMIT` |

OTP detection is exact per flattened value and also regex-scans the joined text. Phone detection strips non-digits and checks the suffix.

### 3.5 Fault application

`api/rails/common.ts` splits faults into hard transport faults and business faults.

Hard faults (`applyFault`):

- `TIMEOUT_HANG_ABOVE_STEP_TTL`: sleeps `FAKE_RAILS_TIMEOUT_HANG_MS` (default 20,000 ms) then returns 504.
- `SOCKET_RESET_MID_STREAM`: destroys the socket and returns a 499 sentinel without recording a response.
- `HTTP_500_GATEWAY_FAULT`: 503 for outage, 500 otherwise.
- `RATE_LIMIT_HTTP_429`: 429.
- `MALFORMED_OR_UNMAPPED_200_BODY`: 200 with `{ unexpected_schema: true, data: null, code: "??" }`.

Business faults (`finalizeFault`):

- `TERMINAL_DECLINE_INSUFFICIENT_FUNDS`: row `FAILED`, failure body.
- `LIMIT_EXCEEDED_CUSTOMER_CEILING`: row `FAILED`, limit body.
- `WRONG_OTP_RETRYABLE`: row `AWAITING_ACTION`, retryable response.
- `AMOUNT_ROUNDING_MISMATCH`: row `PAID`, settled amount +0.05.
- `CONFLICTING_WEBHOOK_VS_INQUIRY`: row `PAID`, inquiry override `FAILED`, success webhook fired.

Latency is drawn from the scenario range using `latencyFor()` and awaited before the handler.

### 3.6 Scenario persistence and API

`engine/chaos/scenarioStore.ts` stores the full config as JSON in `fake_rail_scenarios`, keyed by canonical rail code. `listScenarios()`, `getScenario()`, `saveScenario()` and `resetAllScenarios()` keep the config in sync with the descriptor list.

Portal endpoints in `api/portal/scenarios.ts`:

| Method | Path | Behaviour |
| :--- | :--- | :--- |
| `GET` | `/portal-api/scenarios` | Returns descriptors and all scenarios |
| `GET` | `/portal-api/scenarios/:railCode` | One scenario |
| `PUT` | `/portal-api/scenarios/:railCode` | Merge a partial patch and persist |
| `POST` | `/portal-api/scenarios/preset/:railCode/:preset` | Apply one preset |
| `POST` | `/portal-api/scenarios/global/:preset` | Apply to all rails |
| `POST` | `/portal-api/scenarios/reset` | Restore defaults |
| `GET` | `/portal-api/scenarios/:railCode/audit` | Read portal audit rows for the rail |

Presets are `healthy`, `flaky` (25 percent), `timeout_on_confirm` (100 percent submit timeout) and `outage` (`enabled=false`). Global preset application iterates every descriptor.

### 3.7 Outbound webhook anomalies

`engine/webhooks/WebhookDispatcher.ts` persists every delivery in `fake_webhook_deliveries` before scheduling it. It supports:

- `delaySeconds` before the first attempt.
- `duplicateCount` 1-5 copies.
- `outOfOrderPendingAfterPaid`: after a paid/success/captured event, queue a `transaction.pending` copy two seconds later.
- `corruptSignatureChancePercent`: use a tampered secret for the signature.

Signature profiles exist for `dpay` (timestamp dot raw body, hex lower), `mypay` (raw body, hex lower), `ly_pay` (sorted key/value, hex upper), `plutu` (sorted values, hex upper), `moamalat` (sorted key/value with hex-decoded secret) and `mpgs` (raw body). Every other gateway uses a generic sorted-key/value HMAC-SHA256 profile.

Delivery semantics:

- Timeout is `FAKE_RAILS_WEBHOOK_TIMEOUT_MS`.
- `ok` responses move to `SENT`.
- Failures retry with exponential backoff `1s, 2s, 4s` up to three attempts, then `FAILED`.
- Queued deliveries are resumed on process start.
- `replay(deliveryId, tamper)` resets state and optionally forges every signature-like header.
- The dispatcher emits `webhook.queued`, `webhook.sent` and `webhook.failed` to the SSE sink.

The default URL construction has a path bug documented in `fake-rails.protocol`.

### 3.8 Statement generation

`api/portal/statements.ts` and `engine/statements/xlsx.ts` implement the tester statement generator.

Inputs: `gatewayCode`, optional `from`/`to`, `format` (`csv`, `json`, `xlsx`) and anomalies:

- `feeVariancePercent` 0-100 with `feeVarianceAmount` added to matching rows.
- `omitOne`: drop the last line.
- `addUnrecorded`: append a synthetic `UNRECORDED-<timestamp>` line.

The generator filters `PAID`, `SUCCEEDED`, `REFUNDED` and `PARTIALLY_REFUNDED` rows, writes a `fake_statements` metadata row, broadcasts `statement.generated` and returns CSV, JSON or a dependency-free XLSX built from store-only ZIP parts and OOXML.

This is a download generator. It does not push the file to `core-back`, and the core reconciliation path remains an admin upload.

### 3.9 Tester portal API

| Router | Endpoints | Notes |
| :--- | :--- | :--- |
| `transactions.ts` | list, stream, summary, detail, action, events | Actions: `APPROVE`, `REJECT`, `APPROVE_MISMATCH`, `APPROVE_LATE`, `FORCE_OUTCOME`, `CANCEL` |
| `scenarios.ts` | list/get/put/presets/reset/audit | Full config persisted |
| `webhooks.ts` | list, fire, replay, send-now, dispute | Fire accepts delay/duplicates/out-of-order/corruption |
| `statements.ts` | list, generate | CSV/JSON/XLSX |
| `seederSync.ts` | handshake, bulk seed | Shared seeder token |
| `hosted.ts` | session read, session action | Public hosted flow |

`transactions.ts` writes `fake_portal_audit` for actions and broadcasts `transaction.action`. `summary` returns grouped status counts, per-rail counts and up to fifty pending actions. The `sseClients` field is currently `undefined`.

Hosted actions are `APPROVE`, `APPROVE_TAMPERED`, `DROP_WEBHOOK`, `ABANDON`, `DECLINE` and `CANCEL`:

- `APPROVE` sets `PAID` and fires a webhook.
- `APPROVE_TAMPERED` sets `PAID`, fires a webhook, then appends `status=failed&amount=0.01` to the redirect.
- `DROP_WEBHOOK` leaves the row awaiting action and fires nothing.
- `ABANDON` fires a paid webhook after 30 seconds while leaving the row awaiting action.
- `DECLINE` sets `FAILED`, fires a failure webhook and redirects to `cancel_url`.
- `CANCEL` sets `CANCELLED` and redirects to `cancel_url`.

The hosted router is public by design because the payer is not a tester.

### 3.10 SSE

The only stream is `GET /portal-api/transactions/stream`, authenticated by a query-string JWT because `EventSource` cannot set headers. It emits `ready`, `rail.request`, `webhook.queued`, `webhook.sent`, `webhook.failed`, `transaction.action`, `scenario.updated`, `scenario.reset`, `statement.generated`, `hosted.action`, `seeder.bulk` and `webhook.replayed`.

There is no per-replay cursor. A reconnecting client loses events that occurred while disconnected.

### 3.11 Tester SPA

`fake-rails-front/src/router/index.ts` defines seven routes:

| Route | Page | Purpose |
| :--- | :--- | :--- |
| `/login` | `pages/login/index.tsx` | Single tester login |
| `/dashboard` | `pages/dashboard/index.tsx` | KPIs, live feed, pending actions |
| `/transactions` | `pages/transactions/index.tsx` | Filter, inspect, compose webhooks |
| `/chaos-matrix` | `pages/chaos-matrix/index.tsx` | Per-rail cards and global presets |
| `/statements` | `pages/statements/index.tsx` | Generate CSV/XLSX/JSON with anomalies |
| `/hosted/redirect/:sessionId` | `pages/hosted/redirect/[sessionId].tsx` | Interactive hosted checkout |
| `/hosted/widget-frame` | `pages/hosted/widget-frame.tsx` | Moamalat/MPGS iframe content |

The router guard redirects unauthenticated non-hosted routes to `/login` and keeps the attempted path in `?redirect=`. Tokens live in `localStorage` under `fake-rails-token` and user info under `fake-rails-user`.

The portal layout has four navigation links and an environment badge. `LiveTransactionFeed` opens the SSE stream with the query token and listens for a subset of event names. `WireInspectorDrawer` shows transaction fields, step events and webhook deliveries. `WebhookComposerModal` fires or disputes a webhook. `RailChaosCard` edits failure chance, latency, primary failure mode, duplicates, out-of-order and corruption.

The SPA is fixed to the portal shell's language and theme; it does not have the admin/merchant i18n catalogue. `tests/e2e/exhaustive/exhaustive-fake-rails-surface.spec.ts` only visits `/login` across three viewports, two locales and two themes while mocking every portal API; it asserts shell geometry, no `#app` transform and no horizontal overflow.

## 4. Contracts and invariants

1. **Scenario state is durable.** Every scenario update survives a restart because it is written to SQLite.
2. **Failure fate is pinned per transaction.** A transaction that is assigned a `SUBMIT` timeout will not fail at `INITIATE`.
3. **Magic inputs are phase-scoped.** The trigger is ignored when its phase differs from the current route phase.
4. **Disabled means outage.** `enabled=false` always yields the 503 outage path.
5. **Webhook delivery is at-least-once with bounded retries.** Duplicates and tampering are deliberate test features.
6. **Hosted approval is a tester action, not a trusted payment signal.** The core must still verify any resulting webhook or inquiry.
7. **Statement anomalies are deterministic for a given window.** `feeVariancePercent` uses a PRNG seeded by gateway and window.
8. **The portal never claims to be a real switch.** It is a test surface and must remain isolated.

## 5. Data / API / config / deployment surface

- Scenario fields and failure modes: `DefaultRailScenarios.ts`.
- Magic triggers, fate assignment, latency: `ChaosEvaluator.ts`.
- Persistent config: `scenarioStore.ts` plus `fake_rail_scenarios`.
- Webhook queue and signature profiles: `WebhookDispatcher.ts`.
- Statement generator: `api/portal/statements.ts`, `engine/statements/xlsx.ts`.
- Portal routes: `api/portal/**`.
- SPA routes and components: `fake-rails-front/src/**`.

## 6. Operational usage

```bash
# Global healthy reset
curl -X POST http://127.0.0.1:4104/portal-api/scenarios/global/healthy \
  -H "authorization: Bearer $TOKEN"

# Make Edfali time out on confirm
curl -X POST http://127.0.0.1:4104/portal-api/scenarios/preset/edfali/timeout_on_confirm \
  -H "authorization: Bearer $TOKEN"

# Fire three copies of a paid webhook
curl -X POST http://127.0.0.1:4104/portal-api/webhooks/$TX_ID/fire \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"event":"payment.paid","duplicateCount":3}'
```

- Use the transaction detail endpoint before replaying a webhook so the target URL and signature profile are known.
- Reset all scenarios after a chaos test. The default row persists otherwise.
- The hosted page is intentionally public; do not expose the portal port outside the test network.

## 7. Status and deviations

### Implemented

- Ten failure modes, probability assignment, pinned fate, magic triggers and latency.
- SQLite-backed scenario store and four presets.
- Webhook delay, duplicates, out-of-order PENDING and corrupt signatures.
- Webhook replay, tamper, send-now and dispute.
- CSV/JSON/XLSX statement generation with fee variance, omission and unrecorded-line anomalies.
- Seven-route tester SPA with SSE feed, pending actions, wire inspector and hosted pages.
- Portal audit rows for transaction actions.

### Partial

- `autoApproveAsyncAfterSec` is dead.
- The UI exposes failure chance and a single primary failure mode; the full `phaseBreakdown` and all mode weights can only be changed through the raw API.
- The webhook dispatcher does not consult `assignedFailPhase=WEBHOOK` or mode weights; webhook anomalies are controlled separately.
- The dashboard's `sseClients` field is `undefined`; there is no connection count.
- Statement generation is download-only and not linked to core reconciliation.

### Missing / deferred

- Timer-driven async auto-approval.
- Per-phase UI weight controls.
- SSE replay/resume and multi-instance event fan-out.
- Server-side statement push to `core-back`.
- A real protocol-level chaos matrix (the portal edits scenario config rather than individual gateway wire failures).

### Known bugs / risks

- **Code gap:** the tester can approve a transaction with no server-side payment, which is intentional for spoof testing but must never be reachable from an untrusted network.
- **Code gap:** `ABANDON` leaves the row in `AWAITING_ACTION` while a paid webhook is sent after 30 seconds, producing a deliberate state conflict.
- **Code gap:** the query-string JWT is visible to access logs and browser history.
- **Documentation gap:** the design describes a 20-rail phase-perfect chaos matrix; the implementation is a smaller generic chaos layer.

## 8. Verification and tests

- `fake-rails-back/test/chaos.test.ts` (7 tests) covers descriptor count, aliases, magic OTP/phone triggers, reproducible fate, zero-percent health, magic-over-pinned priority, outage and PRNG determinism.
- `fake-rails-back/test/api.test.ts` (11 tests) covers persisted scenarios driving the next confirm, hosted approval and statement anomalies.
- `fake-rails-back/test/exhaustive/05-api-matrix/fake-rails-portal-and-chaos-api.test.ts` (30 tests) covers scenario CRUD for all twenty rails, global presets, reset, audit, actions, webhooks and statement formats.
- `tests/e2e/exhaustive/exhaustive-fake-rails-surface.spec.ts` (12 generated tests) only covers `/login` geometry with every API mocked. It does not exercise the dashboard, chaos matrix, transactions, statements or hosted pages.
- No test opens an SSE stream and asserts event delivery.

## 9. Source references

### Old design sections

- `design/04-fake-rails-and-seeder/fake_payment_rails_service_architecture.md` section 5.
- `design/04-fake-rails-and-seeder/fake_payment_rails_service_architecture.md` section 5.1, 5.2 and 5.3.
- `design/04-fake-rails-and-seeder/fake_payment_rails_service_architecture.md` section 6 and 6.1.

### Code paths

- `fake-rails-back/engine/chaos/DefaultRailScenarios.ts`
- `fake-rails-back/engine/chaos/ChaosEvaluator.ts`
- `fake-rails-back/engine/chaos/scenarioStore.ts`
- `fake-rails-back/engine/chaos/prng.ts`
- `fake-rails-back/engine/webhooks/WebhookDispatcher.ts`
- `fake-rails-back/engine/statements/xlsx.ts`
- `fake-rails-back/api/portal/**`
- `fake-rails-front/src/router/index.ts`
- `fake-rails-front/src/pages/**`
- `fake-rails-front/src/components/LiveTransactionFeed.tsx`
- `fake-rails-front/src/components/WireInspectorDrawer.tsx`

### Generated appendices

- `project-design/appendices/api-route-matrix.md`
- `project-design/appendices/test-inventory.md`

## 10. Change history

- 2026-11-03: initial canonical part. Verified against `5a24f6f+working-tree`.

## Security hardening (2026-11-05)

fake-rails-front: the postMessage target is `VITE_CHECKOUT_ORIGIN`, otherwise the embedding parent's origin, never `*`; `redirect_url` is validated as http(s) without credentials. The SSE token is still passed in the query string, and `/hosted/*` is still public with no token on the action POST (GAP-024). New env: `VITE_CHECKOUT_ORIGIN`.

## Core Integration and Deployment

> Status: `partial` · Last verified: 2026-11-05

## 1. Purpose and scope

This part describes how `core-back`, the synthetic seeder and `deploy/` connect to the fake rails tier:

- `seedFakeRails.ts` rewrites gateway environments, widget definitions, webhook channel tokens and credential secrets.
- The scoped SSRF allowlist permits a private fake rails host without opening private-address SSRF generally.
- The synthetic seeder requires fake rails and performs a handshake plus bulk sync.
- The deploy engine plans a sixth `fake-rails` role, generates a certificate, opens the portal port, renders an Nginx vhost and optionally seeds the blueprints.
- The checkout frontend must be able to load the fake widget scripts and message origins.

It does not document the emulator internals (`fake-rails.backend`), the rail protocol (`fake-rails.protocol`) or the tester portal (`fake-rails.chaos`).

## 2. Design intent (extracted and synthesized from ./design)

The integration is designed to make the platform work out of the box with the emulator:

1. Every seeded gateway environment gets a base URL of `${FAKE_RAILS_PUBLIC_BASE_URL}/rails/<gateway_code>` and an `allowed_hosts` entry for the fake host.
2. Moamalat and MPGS widget definitions load the emulator's SDK scripts.
3. Inbound-verify crypto secrets are derived from a shared seeder token, so signatures produced by the emulator verify with real cryptography and no bypassed checks.
4. `ALLOW_FAKE_RAILS_HOSTS` relaxes the private-IP guard only when the target host is in both `FAKE_RAILS_ALLOWED_HOSTS` and the gateway version's own `allowed_hosts`.
5. The deployment engine adds an optional `fake-rails` host role with its own backend port, Nginx port, TLS mode, certificate SAN, firewall scope and PM2 process.
6. The synthetic seeder refuses to run unless it is a declared test server, fake rails is enabled, production is explicitly opted in, every gateway host is fake, and the handshake succeeds.
7. The synthetic seeder bulk-syncs its historical transactions and step events into the emulator so the tester portal shows the same history as the gateway.

## 3. As-built architecture

### 3.1 `seedFakeRails.ts`

`core-back/prisma/seedFakeRails.ts` requires `FAKE_RAILS_SEEDER_TOKEN`. It then runs four update passes and one setting upsert.

**Environments.** `updateEnvironments()` loads every `gatewayVersion` with its gateway and environments. For each environment:

- It reads existing `baseUrls` and preserves the keys (or uses `api`).
- It sets every key to `${FAKE_RAILS_PUBLIC_BASE_URL}/rails/${gateway.code}`.
- It unions the environment's existing `allowedHosts` with the fake base host, optional `FAKE_RAILS_ALLOWED_HOSTS`, `127.0.0.1` and `localhost`.
- It sets `enabled=true`.

**Widgets.** `updateWidgets()` loads widget definitions through their route and gateway. For `moamalat` and `mpgs` it sets:

- `scriptUrls = [<base>/sdk/moamalat-lightbox.js]` or `[<base>/sdk/mpgs-session.js]`.
- `scriptSriHashes = []`.
- `allowedOrigins = [<base>]`.

No other widget is changed.

**Webhook channels.** `updateWebhookChannels()` scans `confirmationChannel` rows of type `WEBHOOK`. The first channel per gateway code receives `pathToken = ${code}-webhook`; later versions keep the existing token. It does not change the channel's verification method, signature header, IP allowlist or crypto-profile reference.

**Credential secrets.** `updateCredentialSecrets()` returns zero if the seeder token is empty. Otherwise, for every `PLATFORM` credential set, it walks existing entries. When an entry key matches a crypto profile `secretKeyRef`, it derives:

```text
HMAC-SHA256(seederToken, "fake-rails:<gatewayCode>:<purpose>")
```

where purpose is `webhook` if any matching profile is `INBOUND_VERIFY`, otherwise `sign`. The derived secret is encrypted through `Vault.encryptSecret(secret, "credential-set")`, the entry is marked secret and its `secretVersion` is incremented. Entries with no matching profile are left untouched. The credential set is marked `VERIFIED`.

**Environment mode.** `ensureEnvironmentSetting()` upserts `server.environment_mode = { mode: "TEST_SANDBOX" }`.

The script prints environment, widget, channel and credential counts and exits non-zero if the token is missing.

### 3.2 Seeded gateway count

`core-back/prisma/seedBlueprints.ts` creates thirteen distinct gateway codes:

`edfali`, `sadad`, `moamalat`, `cbl_lypay`, `mypay`, `tlync`, `mobicash`, `onepay`, `yussor`, `sahara`, `mpgs`, `evo_pay`, `neompay`.

The fake descriptor catalogue has twenty rail codes. Seven fake descriptors have no core gateway blueprint:

- `dpay`
- `plutu`
- `masrefy`
- `hawelli`
- `gpay_libya`
- `numo_pay`
- `libyana`

Conversely, the core uses `cbl_lypay` and `evo_pay`, while the fake routes use `ly_pay` and `evopay`. The counts therefore agree only in spirit: 13 core gateways versus 20 fake descriptors, with two code mismatches inside the overlap.

### 3.3 Scoped SSRF allowlist

`core-back/engine/apiConsumer/fakeRailsAllowlist.ts` implements `isFakeRailsHostAllowed(hostname, gatewayAllowedHosts)`:

1. `env.ALLOW_FAKE_RAILS_HOSTS` must be `true`.
2. The normalized hostname must appear in `FAKE_RAILS_ALLOWED_HOSTS`.
3. The same hostname must appear in the caller's `gatewayAllowedHosts`.
4. Trailing dots are stripped; comparison is lowercase.

`ApiConsumer.ts` and `StepExecutor.ts` call this check before URL validation. When true, `requireHttps` is set to false, allowing the private/loopback fake host over plain HTTP. The general SSRF guard still rejects `169.254.169.254`, unrelated private addresses, redirects, userinfo, fragments, CRLF and path traversal.

The allowlist test proves:

- Closed unless explicitly enabled.
- Both environment and gateway list must match.
- An empty gateway list never matches.
- A metadata address is refused even if listed.

### 3.4 Synthetic seeder integration

`core-back/prisma/syntheticSeeder/SeederSafetyGate.ts` enforces five gates:

1. `IS_TEST_SERVER=true`.
2. `FAKE_RAILS_ENABLED=true` and a public base URL.
3. Production requires `FAKE_RAILS_ALLOW_IN_PRODUCTION=true`.
4. At least one allowed host; every configured gateway environment URL must point at an allowed fake host, not an external host or metadata address.
5. The `POST /portal-api/internal/seeder-handshake` call must succeed with the seeder token.

`sync/fakeRailsBulkSyncClient.ts` posts transactions and step events to `/portal-api/internal/bulk-seed` with `x-fake-rails-seeder-token`. The emulator inserts both batches in one `BEGIN IMMEDIATE` transaction and broadcasts `seeder.bulk`.

### 3.5 Deployment configuration

`deploy/lib/configSchema.ts` defines the fake rails keys and validates:

- Host, key path and private IP when enabled.
- Tester username/password/JWT/seeder token.
- Production opt-in.
- Password length and non-collision of backend/Nginx ports with every other role and public port.
- `RUN_SYNTHETIC_HISTORY_SEED` requires an enabled test server and fake rails.

`deploy/lib/hostPlanner.ts` maps the role to:

- Service `pg-fake-rails-back`, source `fake-rails-back`, port `FAKE_RAILS_BACK_PORT`.
- Environment with `NODE_ENV`, `HOST`, `PORT`, `FAKE_RAILS_ENABLED`, `FAKE_RAILS_ALLOW_IN_PRODUCTION`, public base URL, data directory, admin credentials, secrets, CIDRs and `CORE_INBOUND_BASE_URL`.
- Nginx site `fake-rails` on `FAKE_RAILS_NGINX_PORT` with `FAKE_RAILS_SSL`, domain, certificate paths and static root `current/fake-rails-front/dist`.
- Certificate bundle `fake-rails-server`.
- Firewall rules for SSH and the portal port restricted to `FAKE_RAILS_ALLOWED_CIDRS` plus core/checkout private IPs.

`deploy/lib/pkiManager.ts` includes `fakeRails` in the PKI bundle with SAN `DNS:<domain>`, `IP:<private-ip>` and `IP:127.0.0.1`. `deploy/deploy.ts` builds the SPA, deploys backend plus `dist`, renders the vhost and optionally runs `bun run seed-fake-rails` on the core host.

`deploy/templates/nginx.fakerails.conf.tpl` proxies `/rails`, `/sdk`, `/portal-api` and `/hosted` to the backend and serves the SPA. Its CSP allows `script-src 'self' 'unsafe-inline'` and `frame-ancestors 'self' *`.

### 3.6 Embedded widget and CSP block

The embedded flow cannot currently load the emulator widget end to end:

1. `checkout-front/src/components/renderers/EmbeddedWidgetRenderer.tsx` hard-codes `SCRIPT_ALLOWLIST_HOSTS` to public HTTPS partners (`payments.moamalat.ly`, `secure.moamalat.ly`, `test.mpgmerchant.test`, `pay.evowallet.net`, `js.numo-pay.com`). A fake URL such as `http://127.0.0.1:8444/sdk/moamalat-lightbox.js` fails `isAllowlistedScript()` for both protocol and host.
2. Even if the renderer allowed it, the checkout Nginx templates set `script-src 'self'` with no fake origin.
3. The seeded widget `cspAdditions` remain `frame-src https://*.moamalat.example.ly` and `frame-src https://*.mpgs.example.ly`; `seedFakeRails.ts` does not rewrite them.
4. `seedFakeRails.ts` writes an empty SRI array, so `EmbeddedWidgetRenderer` cannot apply an integrity hash.

The redirect flow is unaffected because it uses a browser navigation to the hosted URL, subject to the checkout redirect allowlist.

### 3.7 Webhook and callback gaps

- **Wrong path.** `WebhookDispatcher.defaultUrlFor()` inserts `/webhook/` between the inbound base and `:gateway`, while the checkout route is `/api/v1/inbound/:gateway/:env/:pathToken`.
- **Token mismatch.** The default token is `${gateway_code}-webhook`. Blueprint tokens are not uniformly that string (for example `cbl-lypay-webhook`); `seedFakeRails.ts` rewrites the first webhook channel per code to `${code}-webhook`, so the default works only after that pass and only for the rewritten channel.
- **No fake-side verification.** The emulator signs outbound webhooks but never verifies core-originated requests.
- **Credential coverage.** `updateCredentialSecrets()` only updates existing credential entries whose key matches a crypto profile. A gateway with no secret entry or a different key shape remains unconfigured.
- **Crypto-profile mismatch.** The emulator has six explicit webhook signature profiles plus a generic fallback. `evo_pay`'s blueprint declares RSA-SHA256 with a private key, but the fake profile for `evo_pay` is not defined, so it falls back to HMAC.
- **Statement channels.** The core seeds statement channel rows with `<code>-statement` tokens but has no `SETTLEMENT_FETCH` flow and no fetch URL. The fake `/statement` endpoint is not consumed automatically.

### 3.8 Deploy environment keys

| Key | Meaning |
| :--- | :--- |
| `FAKE_RAILS_ENABLED` | Build and deploy the tier |
| `FAKE_RAILS_ALLOW_IN_PRODUCTION` | Explicit production opt-in |
| `IS_TEST_SERVER` | Enables fake rails and synthetic seeding |
| `FAKE_RAILS_SSH_HOST` / `_PORT` / `_USER` / `_KEY_PATH` / `_SUDO_PASSWORD` | Host access |
| `FAKE_RAILS_PRIVATE_IP` | Internal address and SAN |
| `FAKE_RAILS_BACK_PORT` | Express port, default 4104 |
| `FAKE_RAILS_NGINX_PORT` | Public portal/API port, default 8444 |
| `FAKE_RAILS_SSL` / `_SSL_MODE` / `_DOMAIN` | TLS and vhost identity |
| `FAKE_RAILS_PUBLIC_BASE_URL` | Rewritten into gateway base URLs |
| `FAKE_RAILS_REMOTE_DIR` | Release and data root |
| `FAKE_RAILS_ALLOWED_CIDRS` | Firewall and service CIDR contract |
| `FAKE_RAILS_ALLOWED_HOSTS` | Scoped SSRF allowlist |
| `FAKE_RAILS_ADMIN_USER` / `_PASSWORD` | Tester login |
| `FAKE_RAILS_JWT_SECRET` / `_SEEDER_TOKEN` | Signing and seeder auth |
| `SEED_FAKE_RAILS_BLUEPRINTS` | Run `seed-fake-rails` after deploy |

`deploy/deploy.env.example` keeps `FAKE_RAILS_ENABLED="false"` by default. The example sets `FAKE_RAILS_SSL="false"` and an HTTP public base URL; enabling TLS requires staging verification.

### 3.9 Local all-in-one path

`scripts/deploy-localhost.sh` reads `deploy/deploy.env` when present, otherwise uses local defaults. It starts:

- `pg-fake-rails-back` on port 4104 with `FAKE_RAILS_ALLOW_IN_PRODUCTION=true`.
- `CORE_INBOUND_BASE_URL=http://127.0.0.1:4103/api/v1/inbound`.
- `FAKE_RAILS_DATA_DIR` under `.local/fake-rails-data` unless a deployed data directory exists.
- `pg-fake-rails-front` preview on 5104.

It then runs `seedFakeRails.ts` with `FAKE_RAILS_ALLOWED_HOSTS=127.0.0.1,localhost`.

## 4. Contracts and invariants

1. **The SSRF relaxation is triple-gated.** Environment flag, environment host list and gateway host list must all agree.
2. **The fake host never becomes a general private-address exception.** Metadata and unrelated private ranges remain blocked.
3. **Derived secrets must match on both sides.** Both implementations hash `fake-rails:<gatewayCode>:<purpose>` with the seeder token.
4. **Seeded environments are enabled and point only at the fake base URL.** The pass overwrites every existing base-url key.
5. **The synthetic seeder cannot run against real gateways.** Gate 4 rejects any non-fake host.
6. **Deployment production mode requires an explicit opt-in at both config and process level.**
7. **The fake rails host exposes only its portal/Nginx port.** Backend port stays loopback.

## 5. Data / API / config / deployment surface

- Core seeding: `seedFakeRails.ts`, `seedBlueprints.ts`.
- Core URL validation: `fakeRailsAllowlist.ts`, `ApiConsumer.ts`, `StepExecutor.ts`.
- Core seeder gate: `SeederSafetyGate.ts`, `fakeRailsBulkSyncClient.ts`.
- Deploy schema/planner: `configSchema.ts`, `hostPlanner.ts`.
- Deploy PKI/firewall: `pkiManager.ts`, `firewallConfigurator.ts`.
- Deploy pipeline/template: `deploy.ts`, `templates/nginx.fakerails.conf.tpl`.
- Checkout renderer: `EmbeddedWidgetRenderer.tsx`.
- Local stack: `scripts/deploy-localhost.sh`.

## 6. Operational usage

```bash
# Seed the fake gateway catalog in core-back
cd core-back
FAKE_RAILS_PUBLIC_BASE_URL=http://127.0.0.1:8444 \
FAKE_RAILS_SEEDER_TOKEN='0123456789abcdef0123456789abcdef' \
FAKE_RAILS_ALLOWED_HOSTS=127.0.0.1,localhost \
bun run seed-fake-rails

# Check the scoped allowlist test
bun test test/fake-rails-allowlist.test.ts

# Deploy only the fake rails role
cd deploy
bun run deploy.ts --only=fake-rails
```

- If the seeded base URL is wrong, rerun `seed-fake-rails`; it overwrites existing keys.
- If core cannot reach fake rails, check `ALLOW_FAKE_RAILS_HOSTS`, both host lists and the gateway environment's `allowed_hosts`.
- If the embedded widget does not load, inspect the checkout CSP, the renderer allowlist and `cspAdditions` before debugging the emulator.
- If the seeder blocks, read the gate name in the error; each gate has a stable prefix.

## 7. Status and deviations

### Implemented

- `seedFakeRails.ts` updates environments, widget URLs, webhook tokens and existing credential secrets.
- Deterministic HMAC secret derivation shared by both sides.
- Triple-gated SSRF allowlist with tests.
- Five synthetic-seeder safety gates.
- Deploy schema, host planning, certificate SAN, firewall rules, Nginx template and optional seeding.
- Local all-in-one script that starts and seeds the emulator.

### Partial

- Thirteen seeded core gateways versus twenty fake descriptors.
- `cbl_lypay` and `evo_pay` URL mismatches.
- Webhook token/path mismatch.
- Embedded widget blocked by CSP and renderer allowlist.
- Credential coverage only updates existing entries.
- Fake inbound requests are not verified.
- Statement channels not connected to a fetch flow.

### Missing / deferred

- Core blueprints for the seven unseeded fake rails.
- Automatic reconciliation pull from `/rails/:gateway/statement`.
- SRI generation and propagation for fake SDK scripts.
- A deployment smoke test that performs a full initiate/confirm/webhook flow through a seeded gateway.
- TLS verification of the fake rails certificate from core in the local script.

### Known bugs / risks

- **Code bug:** `cbl_lypay` and `evo_pay` cannot call their fake URLs.
- **Code bug:** default webhook URL path is invalid.
- **Code bug:** embedded widget loads are filtered out before CSP is even evaluated.
- **Security risk:** `ALLOW_FAKE_RAILS_HOSTS=true` plus a broad `FAKE_RAILS_ALLOWED_HOSTS` value weakens SSRF protection for every gateway that also lists the host. Keep the list to the fake host only.
- **Deployment risk:** the example uses HTTP; enabling HTTPS requires certificate trust in core.

## 8. Verification and tests

- `core-back/test/fake-rails-allowlist.test.ts` covers the triple gate, metadata refusal and empty-list refusal.
- `core-back/test/exhaustive/10-seeder-and-deploy/synthetic-seeder-safety-and-audit.test.ts` covers all five seeder gates, handshake failure and the 3.5-year timeline audit.
- `deploy/test/fakeRails.test.ts` covers host planning, production guard, credential requirement, port collision, synthetic-seed requirement, Arch/localhost support.
- `deploy/test/exhaustive-deploy-matrix.test.ts` covers one-, two-, five- and six-host topologies, firewall unions, PKI SANs and Nginx rendering.
- There is no test for `seedFakeRails.ts` itself, no full-flow test through a seeded core gateway, and no test that the embedded widget scripts load under the checkout CSP.

## 9. Source references

### Old design sections

- `design/04-fake-rails-and-seeder/fake_payment_rails_service_architecture.md` section 2.
- `design/04-fake-rails-and-seeder/fake_payment_rails_service_architecture.md` section 2.3 and 2.4.
- `design/04-fake-rails-and-seeder/fake_payment_rails_service_architecture.md` section 7.

### Code paths

- `core-back/prisma/seedFakeRails.ts`
- `core-back/prisma/seedBlueprints.ts`
- `core-back/engine/apiConsumer/fakeRailsAllowlist.ts`
- `core-back/engine/apiConsumer/ApiConsumer.ts`
- `core-back/engine/flow/StepExecutor.ts`
- `core-back/prisma/syntheticSeeder/SeederSafetyGate.ts`
- `core-back/prisma/syntheticSeeder/sync/fakeRailsBulkSyncClient.ts`
- `deploy/lib/configSchema.ts`
- `deploy/lib/hostPlanner.ts`
- `deploy/lib/pkiManager.ts`
- `deploy/deploy.ts`
- `deploy/templates/nginx.fakerails.conf.tpl`
- `checkout-front/src/components/renderers/EmbeddedWidgetRenderer.tsx`
- `scripts/deploy-localhost.sh`

### Generated appendices

- `project-design/appendices/env-and-config-matrix.md`
- `project-design/appendices/api-route-matrix.md`
- `project-design/appendices/test-inventory.md`

## 10. Change history

- 2026-11-03: initial canonical part. Verified against `5a24f6f+working-tree`.

## Security hardening (2026-11-05)

Core's outbound URL compile now fails closed on an empty `allowed_hosts` (`HOST_ALLOWLIST_EMPTY`) unless `ALLOW_EMPTY_OUTBOUND_HOST_ALLOWLIST=true`, and blocks private/loopback/link-local literals unless `allowPrivateHosts`; the Fake Rails exception (three-part allowlist) is unchanged. Seed blueprints for generic `input.code`, `mpgs` and `mypay` set `timestampToleranceSec = 0` because they carry no timestamp field. In production deploys `FAKE_RAILS_ENABLED`, `IS_TEST_SERVER`, `FAKE_RAILS_ALLOW_IN_PRODUCTION=true` and the synthetic seeder are refused.
